/* Nabla smoke tests — Node built-ins and Chrome, nothing else.
 *
 *   node tools/smoke.mjs          run every group
 *   node tools/smoke.mjs nav      run one group
 *
 * Serves the repo, drives headless Chrome over the DevTools protocol and
 * asserts against the real app: the service worker, the Pyodide worker and
 * the keypad only exist in a browser, so that is where they get tested.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8791;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const APP = `${ORIGIN}/index.html`;
const CHROMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.py': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/* ---------------------------------------------------------------- server -- */

function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => server.listen(PORT, '127.0.0.1', () => done(server)));
}

/* ---------------------------------------------------------------- chrome -- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Chrome picks the port, we do not. A fixed one is a hijack waiting to happen:
 * `connect()` drives whatever answers there, and a headless survivor from an
 * earlier run answers with its own localStorage attached — which is how this
 * suite once produced a red/green transcript that had nothing to do with the
 * code under test. With `--remote-debugging-port=0` Chrome binds a free port
 * and writes it, with the path of the browser target it is serving, into
 * DevToolsActivePort inside the profile directory. That directory was made by
 * mkdtemp moments earlier, so the file can only have been written by the
 * process we just spawned. */
async function launchChrome(profile) {
  for (const bin of CHROMES) {
    const child = spawn(bin, [
      '--headless=new', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
      '--window-size=430,900', 'about:blank',
    ], { stdio: 'ignore' });
    const started = await new Promise((done) => {
      child.once('error', () => done(false));
      setTimeout(() => done(true), 300);
    });
    if (started) return { child, endpoint: await readEndpoint(profile, child) };
  }
  throw new Error(`no Chrome found — tried ${CHROMES.join(', ')}`);
}

async function readEndpoint(profile, child) {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Chrome exited before it opened a debugging port');
    }
    try {
      const [port, path] = (await readFile(file, 'utf8')).trim().split('\n');
      if (port && path) return { port: Number(port), path: path.trim() };
    } catch { /* not written yet */ }
    await sleep(100);
  }
  throw new Error('Chrome never wrote DevToolsActivePort');
}

/* A port answering is not the same as our browser answering. */
class WrongBrowser extends Error {}

function waitExit(child, ms = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function connect(endpoint) {
  const base = `http://127.0.0.1:${endpoint.port}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      // Belt to the port's braces: the endpoint has to be serving the browser
      // target our own Chrome named in DevToolsActivePort. Anything else — a
      // survivor of a killed run, a browser somebody else left open, a proxy —
      // is refused rather than driven, and refused loudly: silently testing a
      // stranger's browser is what this whole check exists to stop.
      const version = await (await fetch(`${base}/json/version`)).json();
      const path = new URL(version.webSocketDebuggerUrl).pathname;
      if (path !== endpoint.path) {
        throw new WrongBrowser(
          `port ${endpoint.port} is serving ${path}, not the browser this run `
          + `launched (${endpoint.path}) — refusing to drive it`,
        );
      }
      const list = await (await fetch(`${base}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return new Session(page.webSocketDebuggerUrl);
    } catch (err) {
      if (err instanceof WrongBrowser) throw err;
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome never exposed a page target');
}

class Session {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.errors = [];
    this.ready = new Promise((r) => this.ws.addEventListener('open', r, { once: true }));
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.waiting.has(msg.id)) {
        this.waiting.get(msg.id)(msg);
        this.waiting.delete(msg.id);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(msg.params.entry.text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails.text);
      }
      // Log.entryAdded is the browser's own log — network, security, deprecated
      // APIs — and carries nothing the page wrote. A console.error() from the
      // app arrives here instead, so without this the "no console errors"
      // assertion in every group below only ever saw uncaught exceptions.
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push((msg.params.args || [])
          .map((a) => a.description || a.value || a.type).join(' '));
      }
    });
  }

  send(method, params = {}) {
    return new Promise((done) => {
      const id = ++this.id;
      this.waiting.set(id, done);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    return res.result?.result?.value;
  }

  async poll(expression, label, ms = 60000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await this.eval(expression)) return (Date.now() - started) / 1000;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async open(url) {
    this.errors.length = 0;
    await this.send('Page.navigate', { url });
  }
}

/* ------------------------------------------------------------ page helpers */

function makeApp(s) {
  const json = JSON.stringify;
  return {
    boot: () => s.poll('document.getElementById("boot").hidden === true', 'engine ready', 180000),

    tapTab: (id) => s.eval(`(() => {
      const found = [...document.querySelectorAll('#keypadTabs button')]
        .find((b) => b.dataset.page === ${json(id)});
      if (!found) return false;
      found.click();
      return true;
    })()`),

    /* Keys respond to pointerdown, not click — bindKey preventDefaults so the
     * caret never leaves the input. Only the visible page is tappable. */
    tapKey: (label) => s.eval(`(() => {
      const page = [...document.querySelectorAll('.kgrid')].find((g) => !g.hidden);
      if (!page) return false;
      const key = [...page.querySelectorAll('.key')]
        .find((k) => k.textContent.trim() === ${json(label)});
      if (!key) return false;
      key.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return true;
    })()`),

    tapChip: (label) => s.eval(`(() => {
      const chip = [...document.querySelectorAll('.chip')]
        .find((c) => c.textContent.trim() === ${json(label)});
      if (!chip) return false;
      chip.click();
      return true;
    })()`),

    currentOp: () => s.eval('window.__nablaOp || null'),

    /* Two field shapes, because the app has two. A text field carries its
     * value on `.value` and the app listens for `input`; a `check` field
     * carries it on `.checked` and the app listens for `change`. Setting
     * `.value` on a checkbox changes the string it would submit and nothing
     * else — the box stays unticked and no handler runs — which is why
     * solve's `complex_roots` went untested for as long as this only knew the
     * one shape. */
    setField: (name, value) => s.eval(`(() => {
      const field = document.getElementById('f-' + ${json(name)});
      if (!field) return false;
      if (field.type === 'checkbox') {
        field.checked = Boolean(${json(value)});
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      field.value = ${json(value)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`),

    enter: async (source) => {
      const before = await s.eval('document.querySelectorAll(".card").length');
      await s.eval(`(() => {
        const input = document.getElementById('input');
        input.value = ${json(source)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      await s.poll(`document.querySelectorAll(".card").length > ${before}`, 'a new card', 60000);
    },

    lastCard: () => s.eval(`(() => {
      const card = document.querySelector('.card');
      if (!card) return null;
      return {
        failed: card.classList.contains('card--error'),
        text: card.innerText.replace(/\\s+/g, ' ').trim(),
      };
    })()`),
  };
}

/* ----------------------------------------------------------------- runner -- */

/* Every group starts on an empty store. History, language and the remembered
 * op all live in localStorage, so without this a group inherits whatever the
 * one before it left — `ans` most of all, which is a stored answer by
 * definition. Done through the browser rather than the page: Storage works on
 * an origin, so it needs no document open on it and cannot race a navigation
 * the way `localStorage.clear()` in a just-navigated page can. */
async function clearStorage(s) {
  const res = await s.send('Storage.clearDataForOrigin', {
    origin: ORIGIN, storageTypes: 'local_storage',
  });
  if (res.error) throw new Error(`could not clear localStorage: ${res.error.message}`);
}

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const GROUPS = {
  boot: async (s, app) => {
    await s.open(APP);
    let seconds;
    try {
      seconds = await app.boot();
    } catch (err) {
      check('engine reaches ready', false, err.message);
      return;
    }
    check('engine reaches ready', true, `${seconds.toFixed(1)}s`);
    await app.enter('sin(x)^2');
    const card = await app.lastCard();
    check('derivative computes', card && !card.failed, card && card.text);
    check('result is 2sin(x)cos(x)', /2\s*sin\(x\)\s*cos\(x\)|sin\(2x\)/.test(card?.text || ''),
      card?.text);
    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  nav: async (s, app) => {
    await s.open(APP);
    await app.boot();

    check('op page exists', await app.tapTab('op'));
    check('integral key selects the integral op',
      await app.tapKey('∫') && await app.currentOp() === 'integral');
    check('op label shows the current op',
      /integral/i.test(await s.eval('document.querySelector(".oplabel")?.textContent || ""')));

    // A coarse pointer means the keypad is showing, so chips must be hidden.
    check('chips hidden while the keypad shows',
      await s.eval('getComputedStyle(document.querySelector(".chips")).display === "none"'));

    // Switching to the phone keyboard hides the keypad — ops must not vanish.
    await s.eval('document.getElementById("kswitchBtn") && 0');
    await s.eval(`(() => {
      const keypad = document.getElementById('keypad');
      keypad.hidden = true;
      document.getElementById('composer').dataset.nav = 'chips';
    })()`);
    check('chips return when the keypad is hidden',
      await s.eval('getComputedStyle(document.querySelector(".chips")).display !== "none"'));
    check('a chip still switches op',
      await app.tapChip('lim') && await app.currentOp() === 'limit');

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  substitute: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    check('substitute key selects it',
      await app.tapKey('x = a') && await app.currentOp() === 'substitute');

    await app.setField('at', 'x = 2');
    await app.enter('x^3 + 1');
    let card = await app.lastCard();
    check('single binding evaluates', card && !card.failed && /\b9\b/.test(card.text), card?.text);

    await app.setField('at', 'x = 2, y = 3');
    await app.enter('x*y');
    card = await app.lastCard();
    check('two bindings evaluate', card && !card.failed && /\b6\b/.test(card.text), card?.text);

    await app.setField('at', 'x = y, y = x');
    await app.enter('x - y');
    card = await app.lastCard();
    // A cascaded (wrong) substitution collapses this to 0; a simultaneous one
    // gives y - x, which SymPy's canonical term order prints as "-x + y"
    // (MathJax renders the sign as U+2212, not ASCII "-").
    check('bindings apply simultaneously',
      card && !card.failed && /[-−]\s*x\s*\+\s*y|y\s*[-−]\s*x/.test(card.text),
      card?.text);

    await app.setField('at', '');
    await app.enter('x + 1');
    card = await app.lastCard();
    check('empty bindings explain themselves', card && card.failed && /x = 2/.test(card.text),
      card?.text);

    await app.setField('at', 'x 2');
    await app.enter('x + 1');
    card = await app.lastCard();
    check('a missing = is caught', card && card.failed, card?.text);

    await app.setField('at', '2 = x');
    await app.enter('x + 1');
    card = await app.lastCard();
    check('a non-name left side is caught', card && card.failed, card?.text);

    await app.setField('at', 'x = 1, x = 2');
    await app.enter('x + 1');
    card = await app.lastCard();
    check('a duplicate binding is caught', card && card.failed && /twice|duas/.test(card.text),
      card?.text);

    /* parse_expr returns whatever the text describes, and `[1, 2]` is a plain
     * Python list — substitute reaching for `.subs` on one used to answer with
     * "'list' object has no attribute 'subs'". The absence of that vocabulary
     * is as much the assertion as the failure: an error naming a Python type
     * the user never typed is the module docstring's promise being broken, so
     * the card has to fail, and fail in a sentence. */
    await app.setField('at', 'x = 1');
    await app.enter('[1, 2]');
    card = await app.lastCard();
    check('a non-expression source is refused in words',
      card && card.failed && /isn.t an expression|não é uma expressão/.test(card.text)
        && !/attribute|object/i.test(card.text), card?.text);

    /* Three inputs `parse_expr` answers with the same TypeError, and three
     * different mistakes. Only the first is the parser's own doing: `2 sin`
     * puts a function name where a value belongs and fails on the implicit
     * multiplication, whose complaint — "unsupported operand type(s) for *" —
     * is about nothing the user typed. The other two are the user's own, and
     * each already had a better sentence: a chained comparison is an
     * expression, it just needs a concrete value, and an arity slip names its
     * arity. The card echoes the source it was given, so the assertion for
     * each of those two is the message the other two must not get. */
    await app.enter('2 sin');
    card = await app.lastCard();
    check('a bare function name is not an expression',
      card && card.failed && /isn.t an expression|não é uma expressão/.test(card.text),
      card?.text);

    await app.enter('1 < x < 3');
    card = await app.lastCard();
    check('a chained comparison asks for a concrete value',
      card && card.failed && /concrete value|valor concreto/i.test(card.text)
        && !/isn.t an expression|não é uma expressão/.test(card.text), card?.text);

    await app.enter('atan2(1)');
    card = await app.lastCard();
    check('an arity slip names the arity',
      card && card.failed && /exactly 2 arguments/i.test(card.text)
        && !/isn.t an expression|não é uma expressão/.test(card.text), card?.text);

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  units: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    await app.tapKey('x = a');

    /* 3000 ms rather than 3 s, so the number is something only a real unit can
     * produce: read as ordinary symbols this is 9.81*m/s^2 times 3000*m*s —
     * 29430*m^2/s, with no decimal point anywhere. The metre has to sit on the
     * value for the same reason; looking for a loose "m/s" would be answered
     * by the card's own echo of the binding text, which has one either way. */
    await app.setField('at', 'a = 9.81 m/s^2, t = 3000 ms');
    await app.enter('a*t');
    let card = await app.lastCard();
    check('units multiply through',
      card && !card.failed && /29\.43\s*m(?![a-z])/.test(card.text), card?.text);

    /* The stored answer reads "29.43*meter/second". Reused, it has to come
     * back as that — the ordinary parser would shred the long spellings into
     * m*e*t*e*r over s*e*c*o*n*d and answer with a different number. */
    await app.enter('ans*2');
    card = await app.lastCard();
    check('a unit answer survives ans',
      card && !card.failed && /58\.86/.test(card.text), card?.text);

    /* 90 km/h can only come out as 25 m/s if km and h were read as units — as
     * ordinary symbols this stays 90*k*m/h and nothing folds. The card echoes
     * the binding text verbatim, so an assertion that only looks for "m/s"
     * would pass without any of this working. */
    await app.setField('at', 'v = 90 km/h');
    await app.enter('v');
    card = await app.lastCard();
    check('mixed units normalise to SI',
      card && !card.failed && /25\s*m/.test(card.text), card?.text);

    await app.setField('at', 'v = 3 m/s, a = 2 m/s^2');
    await app.enter('v + a');
    card = await app.lastCard();
    check('a dimension mismatch is caught', card && card.failed, card?.text);

    /* `i`, not `I`: the imaginary unit is reserved, which is exactly why the
     * app keeps lowercase i free for a current. Ohm times ampere has to come
     * back as a volt — a stray-symbol product could not. */
    await app.setField('at', 'R = 4.7 kohm, i = 2 mA');
    await app.enter('R*i');
    card = await app.lastCard();
    check('prefixes and ohm work',
      card && !card.failed && /9\.4/.test(card.text) && /V/.test(card.text), card?.text);

    /* An exact answer with units is often the unreadable one — this is
     * 100*meter/(3*second) — so it has to offer a decimal like every other
     * result does. Without units the same sum already did. */
    await app.setField('at', 'd = 100 m, t = 3 s');
    await app.enter('d/t');
    card = await app.lastCard();
    check('a unit result still offers a decimal',
      card && !card.failed && /decimal/i.test(card.text) && /33\.33/.test(card.text),
      card?.text);

    await app.setField('at', 'm = 2, s = 3');
    await app.enter('m + s');
    card = await app.lastCard();
    check('bare names still mean variables, not units',
      card && !card.failed && /\b5\b/.test(card.text), card?.text);

    /* `min` is the minute on the right of a binding. 5400 is the assertion:
     * read as ordinary symbols this stays 90*m*i*n, and only a real unit folds
     * ninety minutes into seconds. The card echoes the binding text verbatim,
     * so the four digits have to come from the answer — "90 min" has none of
     * them, and `formatTime` renders two digits either side of a colon, so no
     * clock can hand over four adjacent ones either. */
    await app.setField('at', 't = 90 min');
    await app.enter('t');
    card = await app.lastCard();
    check('min is a minute in a binding',
      card && !card.failed && /5400/.test(card.text), card?.text);

    /* The other side of that trade, and the reason it is affordable. Unit
     * aliases are in scope on the right of a binding, so `min(3, 5)` there now
     * reaches a Quantity where a call was meant — and it has to fail in a
     * sentence. The absence of "Quantity" and "sequence" is as much the
     * assertion as the failure: "can't multiply sequence by non-int of type
     * 'Quantity'" is exactly what this used to answer. */
    await app.setField('at', 'x = min(3, 5)');
    await app.enter('x^5');
    card = await app.lastCard();
    check('min(3, 5) in a binding fails in a sentence',
      card && card.failed && !/Quantity|sequence/i.test(card.text), card?.text);

    /* `Min` is untouched by the alias, which is what keeps the trade a trade.
     * Three to the fifth is 243, and the digit count is the point twice over:
     * the binding is echoed in the card's own meta line, so a one-digit answer
     * would be answered by the echo of `Min(3, 5)` itself, and no clock can
     * hand over three adjacent digits. 3125 would mean Min picked the larger. */
    await app.setField('at', 'x = Min(3, 5)');
    await app.enter('x^5');
    card = await app.lastCard();
    check('Min still picks the smaller',
      card && !card.failed && /\b243\b/.test(card.text), card?.text);

    /* Adding units must not take the decimal away. This coefficient is 4*pi,
     * and `as_coeff_Mul()` split that into the integer 4 — which the guard
     * against a spurious "2.0 kg" then swallowed, leaving 4*pi*meter**2 with
     * no decimal beside it while unit-free `r = 2` offered 12.5663706144. The
     * exact form has to survive too: a decimal that replaced the answer rather
     * than joining it would be a different bug. */
    await app.setField('at', 'r = 2 m');
    await app.enter('pi*r^2');
    card = await app.lastCard();
    check('an irrational coefficient keeps its decimal once units are on it',
      card && !card.failed && /decimal/i.test(card.text) && /12\.56637/.test(card.text)
        && /pi|π/.test(card.text), card?.text);

    /* Everything below runs with the unit namespace already built, which is
     * the state that used to break these: a result that is not an ordinary
     * expression has no coefficient to split and no atoms to scan. Order
     * matters — the earlier checks are what arm it. */
    await app.setField('at', 'x = 2');
    await app.enter('x > 1');
    card = await app.lastCard();
    check('a boolean result survives the unit paths',
      card && !card.failed && /True/i.test(card.text), card?.text);

    /* Dimensions are not substitute's promise alone: a unit answer reused in
     * another op has to be checked there too, or `ans + 1` on 29.43 m/s comes
     * back as a metre added to a number. */
    await app.setField('at', 'a = 9.81 m/s^2, t = 3 s');
    await app.enter('a*t');
    await app.tapKey('simplify');
    await app.enter('ans + 1');
    card = await app.lastCard();
    check('units carried by ans are checked in other ops',
      card && card.failed, card?.text);

    /* A comparison has no factor and dimension of its own, and SymPy does not
     * go looking: `_collect_factor_and_dimension` hands back Dimension(1) for
     * any Relational without reading it, so comparing a velocity to a bare
     * number came back as a plain True. A failed card is only half of it —
     * `!/True/` is the other half, because True is exactly what the bug
     * produced. The previous card failed, and a failed card never becomes
     * `ans`, so this still sees 29.43 m/s. */
    await app.enter('ans > 1');
    card = await app.lastCard();
    check('a comparison against a unit answer is dimension-checked',
      card && card.failed && !/True/i.test(card.text), card?.text);

    await app.enter('[1, 2]');
    card = await app.lastCard();
    check('a list result survives the unit gate',
      card && !card.failed && /1/.test(card.text) && /2/.test(card.text)
        && !/attribute/i.test(card.text), card?.text);

    /* The dimension check has to refuse comparisons whose sides disagree, not
     * comparisons with units in them. Three metres really is more than two
     * centimetres, and the app has to say so end to end. */
    await app.tapKey('x = a');
    await app.setField('at', 'a = 3 m, b = 2 cm');
    await app.enter('a > b');
    card = await app.lastCard();
    check('a legitimate unit comparison still answers',
      card && !card.failed && /True/i.test(card.text), card?.text);

    /* That one never reaches the dimension check, though — SymPy settles a
     * comparison between two same-dimension quantities itself, and hands back
     * a plain True before anything can look at it. So it cannot notice a
     * Relational branch replaced by a blanket refusal, any more than `x > 1`
     * at `x = 2` can. Leave a free symbol in and the comparison survives:
     * `a*x > b` is still a Relational, still carries units, and is still
     * dimensionally sound, so the branch has to take it apart and pass it.
     * This is the one that comes back red when it refuses instead. */
    await app.enter('a*x > b');
    card = await app.lastCard();
    check('a unit comparison the check really reads is not refused',
      card && !card.failed && !/match up|batem/i.test(card.text), card?.text);

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  ans: async (s, app) => {
    await s.open(APP);
    await app.boot();

    await app.tapTab('op');
    await app.tapKey('d/dx');
    await app.enter('x^3');
    let card = await app.lastCard();
    check('seed result computed', card && !card.failed, card?.text);

    await app.enter('ans + 1');
    card = await app.lastCard();
    check('ans chains from the last result',
      card && !card.failed && /3x/.test(card.text), card?.text);

    /* Two hops, because one hop cannot tell .find() from .findLast(): with a
     * single result in the history both pick it. Here the oldest qualifying
     * answer is 3x^2 and the newest is 7x^6, and only the newest
     * differentiates to 42x^5. */
    await app.enter('x^7');
    await app.enter('ans');
    card = await app.lastCard();
    check('ans is the newest answer, not the first',
      card && !card.failed && /42\s*x/.test(card.text), card?.text);

    /* A series qualifies too — the O(...) term re-parses, so an expansion is
     * a reusable answer and `ans` must not reach past it to an older one. The
     * O term is the assertion: reaching past would land on 42x^5, which has
     * none. */
    await app.tapKey('series');
    await app.enter('sin(x)');
    await app.tapKey('simplify');
    await app.enter('ans');
    card = await app.lastCard();
    check('a series expansion is a reusable answer',
      card && !card.failed && /O\(/.test(card.text), card?.text);

    await s.eval('localStorage.clear()');
    await s.open(APP);
    await app.boot();
    await app.enter('ans + 1');
    card = await app.lastCard();
    check('ans with no history explains itself',
      card && card.failed && /reuse|reutilizar/i.test(card.text), card?.text);

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  series: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    check('series key selects it',
      await app.tapKey('series') && await app.currentOp() === 'series');

    await app.enter('sin(x)');
    let card = await app.lastCard();
    check('expansion has the leading terms',
      card && !card.failed && /x/.test(card.text) && /6/.test(card.text), card?.text);
    check('the O term is shown', card && /O\(/.test(card.text), card?.text);

    await app.setField('about', '1');
    await app.enter('log(x)');
    card = await app.lastCard();
    check('expansion about a point works', card && !card.failed, card?.text);

    await app.setField('about', '0');
    await app.setField('order', 'x');
    await app.enter('sin(x)');
    card = await app.lastCard();
    check('a non-numeric order is caught', card && card.failed, card?.text);

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  constants: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    await app.tapKey('x = a');

    /* Planck's constant times a frequency is an energy. The number is the
     * assertion: `h` read as an ordinary symbol leaves h*5e14*Hz, which is
     * not 3.313035075e-19 J and not anything else recognisable. */
    await app.setField('at', 'f = 5e14 Hz');
    await app.enter('h*f');
    let card = await app.lastCard();
    check('a constant resolves with units',
      card && !card.failed && /3\.313035075/.test(card.text) && /J/.test(card.text),
      card?.text);

    await app.setField('at', 'm = 1 kg');
    await app.enter('m*c^2');
    card = await app.lastCard();
    check('c is the speed of light',
      card && !card.failed && /89875517873681764/.test(card.text), card?.text);

    /* The rule that keeps `c` usable as a constant of integration: a name you
     * bind yourself is yours. Two times three to the fourth is 162, and the
     * digit count is the point: `formatTime` renders 2-digit hours and
     * 2-digit minutes around a colon, so no clock can hand over three
     * adjacent digits. Both 18 and 54 could, and did — 03:18 and 03:54 each
     * passed this assertion with the rule broken. */
    await app.setField('at', 'm = 2, c = 3');
    await app.enter('m*c^4');
    card = await app.lastCard();
    check('a binding beats the physical value',
      card && !card.failed && /\b162\b/.test(card.text), card?.text);

    /* SymPy has no named SI unit for what k_B measures, so folding leaves it
     * alone — the answer still has to be a number rather than "k_B". */
    await app.setField('at', 'T = 300 K');
    await app.enter('k_B*T');
    card = await app.lastCard();
    check('a constant with no SI unit still gives a number',
      card && !card.failed && /4\.141947/.test(card.text), card?.text);

    /* N_A times an amount is a pure count: nothing folds and nothing is left
     * over. The unfolded form is also shown, so its printing is on trial. */
    await app.setField('at', 'n = 2 mol');
    await app.enter('N_A*n');
    card = await app.lastCard();
    check('N_A counts a mole',
      card && !card.failed && /1\.20442815/.test(card.text), card?.text);

    await app.setField('at', 'U = 1 V');
    await app.enter('q_e*U');
    card = await app.lastCard();
    check('q_e is the elementary charge',
      card && !card.failed && /1\.602176634/.test(card.text), card?.text);

    /* `e` stays Euler's number: the elementary charge is spelled q_e because
     * reassigning e would change every e^x already in someone's history. */
    await app.setField('at', 'x = 1');
    await app.enter('e^x');
    card = await app.lastCard();
    check('e is still Euler’s number',
      card && !card.failed && /2\.718/.test(card.text), card?.text);

    /* One expression, both meanings of g: a gram on the right of a binding,
     * gravity in the expression. 0.5 kg * 9.80665 m/s^2 = 4.903325 N. The N
     * has to sit on the value: alternate labels are uppercased in CSS, so a
     * bare /N/ is answered by the card's own "AS WRITTEN". */
    await app.setField('at', 'm = 500 g');
    await app.enter('m*g');
    card = await app.lastCard();
    check('g is a gram in a binding and gravity in an expression',
      card && !card.failed && /4\.903325\s*N/.test(card.text), card?.text);

    /* `h` is an hour on the right of a binding for the same reason. */
    await app.setField('at', 't = 2 h');
    await app.enter('t');
    card = await app.lastCard();
    check('h still means an hour in a binding',
      card && !card.failed && /7200/.test(card.text), card?.text);

    /* Adding a number to a gravitational constant is a mismatch, and the
     * complaint has to read as a sentence. The dimension of G is
     * length**3/(mass*time**2), whose own parentheses used to close the strip
     * early and leave `Dimension(...)` standing in the message — SymPy's class
     * name, in the interface. Both halves are the assertion: the wrapper gone,
     * and the dimension itself still there to read rather than stripped away
     * with it. */
    await app.setField('at', 'x = 1');
    await app.enter('G + 1');
    card = await app.lastCard();
    check('a dimension complaint keeps SymPy’s wrapper out of it',
      card && card.failed && /length\*\*3/.test(card.text) && !/Dimension\(/.test(card.text),
      card?.text);

    /* The page keeps its id — renaming it would orphan the saved keypad page
     * in every install — and only its tab label changes. */
    check('the names tab is labelled', /names|nomes/.test(await s.eval(`(() => {
      const tab = [...document.querySelectorAll('#keypadTabs button')]
        .find((b) => b.dataset.page === 'var');
      return tab ? tab.textContent.trim() : '';
    })()`)));
    await app.tapTab('var');
    check('names page has the constants', await app.tapKey('ℏ'));
    check('names page has π back', await app.tapKey('π'));
    check('names page still has the Greek letters', await app.tapKey('θ'));

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },
};

async function main() {
  const only = process.argv[2];
  const groups = only ? { [only]: GROUPS[only] } : GROUPS;
  if (only && !GROUPS[only]) throw new Error(`no such group: ${only}`);

  const server = await serve();
  const profile = await mkdtemp(join(tmpdir(), 'nabla-smoke-'));
  const { child: chrome, endpoint } = await launchChrome(profile);
  const s = await connect(endpoint);
  await s.ready;
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  await s.send('Page.enable');
  const app = makeApp(s);

  try {
    for (const [name, run] of Object.entries(groups)) {
      console.log(`\n${name}`);
      await clearStorage(s);
      await run(s, app);
    }
  } finally {
    s.ws.close();
    chrome.kill();
    await waitExit(chrome);
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
