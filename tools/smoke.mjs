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
const CDP_PORT = 9334;
const APP = `http://127.0.0.1:${PORT}/index.html`;
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

async function launchChrome(profile) {
  for (const bin of CHROMES) {
    const child = spawn(bin, [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
      '--window-size=430,900', 'about:blank',
    ], { stdio: 'ignore' });
    const ok = await new Promise((done) => {
      child.once('error', () => done(false));
      setTimeout(() => done(true), 300);
    });
    if (ok) return child;
  }
  throw new Error(`no Chrome found — tried ${CHROMES.join(', ')}`);
}

function waitExit(child, ms = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return new Session(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
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

    setField: (name, value) => s.eval(`(() => {
      const field = document.getElementById('f-' + ${json(name)});
      if (!field) return false;
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
      /integral|integral/i.test(await s.eval('document.querySelector(".oplabel")?.textContent || ""')));

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

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  units: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    await app.tapKey('x = a');

    await app.setField('at', 'a = 9.81 m/s^2, t = 3 s');
    await app.enter('a*t');
    let card = await app.lastCard();
    check('units multiply through',
      card && !card.failed && /29\.4/.test(card.text) && /m\/s|meter/.test(card.text), card?.text);

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
};

async function main() {
  const only = process.argv[2];
  const groups = only ? { [only]: GROUPS[only] } : GROUPS;
  if (only && !GROUPS[only]) throw new Error(`no such group: ${only}`);

  const server = await serve();
  const profile = await mkdtemp(join(tmpdir(), 'nabla-smoke-'));
  const chrome = await launchChrome(profile);
  const s = await connect();
  await s.ready;
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  await s.send('Page.enable');
  const app = makeApp(s);

  try {
    for (const [name, run] of Object.entries(groups)) {
      console.log(`\n${name}`);
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
