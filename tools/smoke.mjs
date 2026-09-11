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
  const refused = [];
  for (const bin of CHROMES) {
    /* A candidate that died after writing the file would leave its port
     * behind for the next one to read, and reading a port nobody is listening
     * on is how this suite ends up driving a stranger's browser. Clearing it
     * keeps the invariant the comment above states: whatever is in that file
     * was written by the process spawned on the line below it. */
    await rm(join(profile, 'DevToolsActivePort'), { force: true });
    const child = spawn(bin, [
      '--headless=new', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
      '--window-size=430,900', 'about:blank',
    ], { stdio: 'ignore' });
    const started = await new Promise((done) => {
      child.once('error', () => done(false));
      setTimeout(() => done(true), 300);
    });
    if (!started) continue;
    /* Spawning is not the same as working: a binary can exist, start, and
     * never open a debugging port — a broken install, a Chrome too old for
     * `--headless=new`, a profile it will not read. That is one candidate
     * failing, not the search failing, so the loop moves on to the next name
     * instead of the throw ending the run. The candidate that failed is
     * killed on the way past — nothing downstream knows it exists. */
    try {
      return { child, endpoint: await readEndpoint(profile, child) };
    } catch (err) {
      refused.push(`${bin}: ${err.message}`);
      child.kill();
      await waitExit(child);
    }
  }
  const why = refused.length ? ` (${refused.join('; ')})` : '';
  throw new Error(`no Chrome found — tried ${CHROMES.join(', ')}${why}`);
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
     * caret never leaves the input. Only the visible page is tappable. The
     * pointerup matters as much: a repeatable key (the caret arrows, the
     * backspace) starts an auto-repeat 380 ms after the press, so a tap left
     * hanging goes on typing for as long as the next assertion takes. */
    tapKey: (label) => s.eval(`(() => {
      const page = [...document.querySelectorAll('.kgrid')].find((g) => !g.hidden);
      if (!page) return false;
      const key = [...page.querySelectorAll('.key')]
        .find((k) => k.textContent.trim() === ${json(label)});
      if (!key) return false;
      key.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      key.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    })()`),

    /* The backspace sits on the keypad's bar rather than in a page, so no
     * amount of tapKey reaches it. */
    tapBack: () => s.eval(`(() => {
      const key = document.getElementById('kpBack');
      if (!key) return false;
      key.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      key.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    })()`),

    /* A tap on a field is a focus and a caret. The caret lands where the
     * finger did, and a finger reaching for a value it means to extend lands
     * at the end of what is already there. */
    focusField: (name) => s.eval(`(() => {
      const field = document.getElementById('f-' + ${json(name)});
      if (!field) return false;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      return document.activeElement === field;
    })()`),

    focusMain: () => s.eval(`(() => {
      const input = document.getElementById('input');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return document.activeElement === input;
    })()`),

    fieldValue: (name) => s.eval(`(() => {
      const field = document.getElementById('f-' + ${json(name)});
      return field ? field.value : null;
    })()`),

    inputValue: () => s.eval('document.getElementById("input").value'),

    /* Half of what the caret keys must not do is leave the field they were
     * pressed for, so a field that no longer has focus answers null rather
     * than a number. */
    caretIn: (name) => s.eval(`(() => {
      const field = document.getElementById('f-' + ${json(name)});
      if (!field || document.activeElement !== field) return null;
      return field.selectionStart;
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

    /* The app renders a plot into a canvas, so the numbers are only readable
     * through the chart it built — and that is the right place to read them:
     * it is the live entry, before `slim()` thins the stored copy. */
    plotData: () => s.eval(`(() => {
      const canvas = document.querySelector('.card .chart canvas');
      if (!canvas || !window.Chart) return null;
      const chart = Chart.getChart(canvas);
      if (!chart) return null;
      const first = chart.data.datasets[0].data;
      const drawn = first.filter((p) => p.y !== null && p.y !== undefined);
      return {
        series: chart.data.datasets.length,
        points: first.length,
        gaps: first.length - drawn.length,
        top: drawn.reduce((best, p) => Math.max(best, p.y), -Infinity),
        yMin: chart.options.scales.y.min,
        yMax: chart.options.scales.y.max,
      };
    })()`),

    /* The header, which only `buildTable` writes: the variable's own name and
     * `f(` that name `)`. A plot answers the same op with a canvas and no
     * table in the card at all, so this is the half of "a table rendered"
     * that a card merely not failing cannot show. */
    tableHead: () => s.eval(`(() => {
      const card = document.querySelector('.card');
      if (!card) return null;
      return [...card.querySelectorAll('.vt thead th')]
        .map((cell) => cell.textContent.trim());
    })()`),

    tableRows: () => s.eval(`(() => {
      const rows = [...document.querySelectorAll('.card .vt tbody tr')];
      return rows.map((row) => [...row.querySelectorAll('td')]
        .map((cell) => cell.textContent.trim()));
    })()`),

    /* Clicks the real button, so the language really is the app's own. */
    setLang: (lang) => s.eval(`(() => {
      if (window.NablaI18n.lang !== ${json(lang)}) {
        document.getElementById('langBtn').click();
      }
      return window.NablaI18n.lang;
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

    /* The answer on its own. A card also echoes the source and the statement
     * it was computed from, so `d/dy of x*y` and `d/dx of x*y` produce cards
     * that both have an x and a y in them; only the result plate tells them
     * apart. */
    lastResult: () => s.eval(`(() => {
      const plate = document.querySelector('.card .card__result');
      return plate ? plate.innerText.replace(/\\s+/g, ' ').trim() : null;
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

  /* The keypad is the only keyboard on a phone, so every field the composer
   * shows has to be reachable from it — not just the expression. The whole
   * group is written against the field the user is in, because the bug it
   * covers was the keypad ignoring that and typing into the expression. */
  keypad: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    check('substitute key selects it',
      await app.tapKey('x = a') && await app.currentOp() === 'substitute');
    await app.tapTab('num');

    /* Where the keypad has always typed, and what everything below is only
     * worth anything against: the expression field has to keep working
     * exactly as it did. */
    check('the expression field takes focus', await app.focusMain());
    for (const label of ['x', '^', '3', '+', '1']) await app.tapKey(label);
    check('the keypad types into the expression field',
      await app.inputValue() === 'x^3+1', await app.inputValue());
    check('and the parameter field stays empty',
      await app.fieldValue('at') === '', await app.fieldValue('at'));

    /* The bug in one line: with `at` focused, every tap landed in the
     * expression above it — and took the caret with it. `at` is the whole
     * point of substitute, and `=` and `,` are both keypad keys, so this is
     * the field that cannot be typed any other way. */
    check('the at field takes focus', await app.focusField('at'));
    for (const label of ['x', '=', '2', ',']) await app.tapKey(label);
    await app.tapTab('var');
    await app.tapKey('y');
    await app.tapTab('num');
    for (const label of ['=', '3', '4']) await app.tapKey(label);
    check('the keypad types into the focused parameter field',
      await app.fieldValue('at') === 'x=2,y=34', await app.fieldValue('at'));
    check('and leaves the expression field alone',
      await app.inputValue() === 'x^3+1', await app.inputValue());

    await app.tapBack();
    check('backspace deletes from the focused field',
      await app.fieldValue('at') === 'x=2,y=3', await app.fieldValue('at'));
    check('and not from the expression field',
      await app.inputValue() === 'x^3+1', await app.inputValue());

    await app.tapKey('◀');
    await app.tapKey('◀');
    check('the caret keys move the caret inside the focused field',
      await app.caretIn('at') === 5, JSON.stringify(await app.caretIn('at')));
    await app.tapKey('▶');
    await app.tapKey('▶');

    /* The DOM value is only half of it. What gets computed is state.params,
     * which the field's own `input` listener writes — so the keypad has to
     * announce the edit rather than keep a second copy of that bookkeeping.
     * x = 2 and y = 3 make this 6, and nothing else in the card carries a
     * bare 6: the meta line echoes the binding text and the times are
     * two-digit either side of a colon. */
    await app.enter('x*y');
    let card = await app.lastCard();
    check('the tapped binding reaches the computation',
      card && !card.failed && /\b6\b/.test(card.text), card?.text);

    /* An op change rebuilds every parameter field, so what the keypad
     * remembers has to be resolved fresh on each press — a held node would
     * be typing into an input that is no longer in the page. Nothing is
     * focused after the rebuild, so the expression is where this lands. */
    await app.tapTab('op');
    check('the derivative key selects it',
      await app.tapKey('d/dx') && await app.currentOp() === 'derivative');
    await app.tapTab('num');
    await app.tapKey('7');
    check('a rebuilt composer puts the keypad back on the expression',
      await app.inputValue() === 'x*y7', await app.inputValue());

    // Clearing it is also what gives the preview below an edge to be seen on.
    for (let i = 0; i < 4; i += 1) await app.tapBack();
    check('the expression field is empty', await app.inputValue() === '',
      await app.inputValue());
    await s.poll('document.getElementById("preview").textContent.trim() === ""',
      'the preview to clear');

    /* A `var` field holds a name, so the implicit `*` has no business in it:
     * the same two taps that mean x·y in an expression mean the two-letter
     * name here. */
    check('the variable field takes focus', await app.focusField('variable'));
    await app.tapTab('var');
    await app.tapKey('y');
    check('a name field gets no implicit multiplication',
      await app.fieldValue('variable') === 'xy', await app.fieldValue('variable'));

    await app.tapBack();
    await app.tapBack();
    check('backspace empties the name field',
      await app.fieldValue('variable') === '', await app.fieldValue('variable'));
    await app.tapKey('y');
    check('the variable field holds the tapped name',
      await app.fieldValue('variable') === 'y', await app.fieldValue('variable'));

    check('the expression field takes focus back', await app.focusMain());
    await app.tapTab('num');
    await app.tapKey('x');
    await app.tapTab('var');
    await app.tapKey('y');
    check('the expression field still gets the implicit multiplication',
      await app.inputValue() === 'x*y', await app.inputValue());

    /* Every op with a variable gets one suggested from the preview, and only
     * `varTouched` stops it — which is set by the field's own `input`
     * listener and by nothing else. Without the keypad dispatching that
     * event, the next preview quietly puts `x` back. */
    await s.poll('!document.getElementById("preview").classList.contains("preview--stale")'
      + ' && document.getElementById("preview").textContent.trim() !== ""',
      'the preview to render');
    check('the tapped variable survives the preview’s suggestion',
      await app.fieldValue('variable') === 'y', await app.fieldValue('variable'));

    const before = await s.eval('document.querySelectorAll(".card").length');
    await app.tapTab('num');
    await app.tapKey('⏎');
    await s.poll(`document.querySelectorAll(".card").length > ${before}`, 'a new card', 60000);
    card = await app.lastCard();
    check('the enter key still submits', card && !card.failed, card?.text);
    check('the derivative is taken in the tapped variable',
      await app.lastResult() === 'x', await app.lastResult());

    /* Our keypad only replaces the phone's keyboard if that keyboard stays
     * down, which is inputmode="none" and nothing else. renderParams() has
     * rebuilt this field several times since the page loaded, so the field
     * asking for it once at startup would not be enough. */
    const inputmode = (id) => s.eval(`document.getElementById('${id}').getAttribute('inputmode')`);
    check('a rebuilt parameter field still refuses the system keyboard',
      await inputmode('f-variable') === 'none', await inputmode('f-variable'));

    await app.tapTab('var');
    check('the phone-keyboard key is there', await app.tapKey('abc — phone keyboard'));
    check('the parameter field hands the system keyboard back',
      await inputmode('f-variable') === 'text', await inputmode('f-variable'));
    check('and so does the expression field',
      await inputmode('input') === 'text', await inputmode('input'));

    await s.eval('document.getElementById("kswitchBtn").click()');
    check('switching back takes it away again',
      await inputmode('f-variable') === 'none', await inputmode('f-variable'));

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

    /* Four inputs `parse_expr` answers with the same TypeError, and four
     * different mistakes. The first is the parser's own doing: `2 sin` puts a
     * function name where a value belongs and fails on the implicit
     * multiplication, whose complaint — "unsupported operand type(s) for *" —
     * is about nothing the user typed. The rest are the user's own, and each
     * needs its own sentence. The card echoes the source it was given, so the
     * assertion for each is as much the messages it must not get. */
    await app.enter('2 sin');
    card = await app.lastCard();
    check('a bare function name is not an expression',
      card && card.failed && /isn.t an expression|não é uma expressão/.test(card.text),
      card?.text);

    /* `1 < x < 3` fails while the text is being read — Python evaluates the
     * chain with `and`, which asks a Relational for a truth value — so it
     * fails before any binding is applied. The binding above supplies the
     * concrete value the old message asked for, which is the point: advice
     * the user has already taken is advice about the wrong problem. */
    await app.enter('1 < x < 3');
    card = await app.lastCard();
    check('a chained comparison says it is a chained comparison',
      card && card.failed && /chained comparison|comparação encadeada/i.test(card.text)
        && !/concrete value|valor concreto/i.test(card.text)
        && !/isn.t an expression|não é uma expressão/.test(card.text), card?.text);

    /* SymPy's own arity wording names the function the user typed and counts
     * its arguments. It stays. */
    await app.enter('atan2(1)');
    card = await app.lastCard();
    check('an arity slip names the arity',
      card && card.failed && /exactly 2 arguments/i.test(card.text)
        && !/isn.t an expression|não é uma expressão/.test(card.text)
        && !/wrong number of arguments/i.test(card.text), card?.text);

    /* CPython phrases an arity slip in terms of the object it called, and for
     * these three that object is this app's own: `log` is a private helper
     * called `_log_base10`, `log10` is a lambda — `<lambda>` is not even a
     * name — and `root` is SymPy's implementation of a key on the keypad.
     * None of that wording is translated either. Both halves are the
     * assertion: the app's own sentence present, the module's internals
     * absent. */
    for (const source of ['log(2, 8, 3)', 'log10(1, 2)', 'root(1)']) {
      await app.enter(source);
      card = await app.lastCard();
      check(`${source} is refused without naming a Python internal`,
        card && card.failed && /wrong number of arguments/i.test(card.text)
          && !/_log_base10|lambda|positional argument/i.test(card.text), card?.text);
    }

    /* CPython phrases the same complaint a fourth way when the mismatch is a
     * keyword rather than a position — "_log_base10() got an unexpected
     * keyword argument 'foo'" — and it is reachable: SymPy's `auto_symbol`
     * passes keyword arguments through unconverted, so a plain `foo=8` in the
     * text reaches the call. Same two-part assertion as above. */
    await app.enter('log(2, foo=8)');
    card = await app.lastCard();
    check('log(2, foo=8) is refused without naming a Python internal',
      card && card.failed && /wrong number of arguments/i.test(card.text)
        && !/_log_base10|lambda|positional argument/i.test(card.text), card?.text);

    /* And in Portuguese, where the leaked English sentence was all the user
     * got. */
    check('the app switches to Portuguese', await app.setLang('pt') === 'pt');
    await app.enter('log(2, 8, 3)');
    card = await app.lastCard();
    check('an arity slip is refused in Portuguese too',
      card && card.failed && /número errado de argumentos/i.test(card.text)
        && !/_log_base10|lambda|positional argument/i.test(card.text), card?.text);

    await app.enter('1 < x < 3');
    card = await app.lastCard();
    check('and a chained comparison too',
      card && card.failed && /comparação encadeada/i.test(card.text)
        && !/concrete value|valor concreto/i.test(card.text), card?.text);

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

  solve: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    check('solve key selects it',
      await app.tapKey('solve') && await app.currentOp() === 'solve');

    await app.enter('x^2 = 4');
    let card = await app.lastCard();
    // The roots are ±2 and the minus is the assertion: the statement echoes
    // "x^2 = 4", which has a 2 in it either way, but nothing there is negative.
    check('an equation solves', card && !card.failed && /[-−]\s*2/.test(card.text),
      card?.text);

    /* `complex_roots` is the app's only checkbox, and until setField knew what
     * one was it could not be driven from here at all. x^2 + 1 makes the
     * setting observable in both directions: no real roots, exactly two
     * complex ones, so the same input has to fail with the box clear and
     * answer with it ticked. */
    await app.enter('x^2 + 1');
    card = await app.lastCard();
    check('complex roots stay hidden while the box is clear',
      card && card.failed && /complex|complexa/i.test(card.text), card?.text);

    check('the complex box takes a value', await app.setField('complex_roots', true));
    check('the app read the tick',
      await s.eval('document.getElementById("f-complex_roots").checked === true'));

    await app.enter('x^2 + 1');
    card = await app.lastCard();
    // "x = i" and "x = −i" can only come from the roots: the statement is
    // "x^2 + 1 = 0, solve for x", which puts no i after any "=".
    check('ticking complex changes the result',
      card && !card.failed && /x\s*=\s*[-−]?\s*i(?![a-z])/.test(card.text), card?.text);

    /* `[1, 2]` is a Python list, not an expression, and `sp.Eq` sympifies what
     * it is handed — so an equation with a list on either side used to come
     * back as "SympifyError: [1, 2]", a Python class name standing in the
     * interface. Both sides get asserted because both sides reach Eq. */
    await app.enter('[1, 2] = x');
    card = await app.lastCard();
    check('a list on the left of = is refused in words',
      card && card.failed && /isn.t an expression|não é uma expressão/.test(card.text)
        && !/SympifyError/i.test(card.text), card?.text);

    await app.enter('x = [1, 2]');
    card = await app.lastCard();
    check('a list on the right of = is refused in words',
      card && card.failed && /isn.t an expression|não é uma expressão/.test(card.text)
        && !/SympifyError/i.test(card.text), card?.text);

    /* An equation's sides are checked one at a time on the way in, and
     * `ans = 1` passes that twice over: 29.43 m/s is a fine expression and so
     * is 1. Only the equation itself disagrees, so only checking the equation
     * catches it — and until it was checked, solve answered "No solutions
     * found.", which reads as a fact about the maths rather than a mistake in
     * it. Both halves are the assertion for that reason. */
    await app.tapKey('x = a');
    // 3000 ms rather than 3 s, for the reason the units group gives: read as
    // ordinary symbols this is 29430*m^2/s, with no decimal point anywhere, so
    // the answer can only be 29.43 m/s if the binding really read units.
    await app.setField('at', 'a = 9.81 m/s^2, t = 3000 ms');
    await app.enter('a*t');
    card = await app.lastCard();
    check('a unit answer is computed for reuse',
      card && !card.failed && /29\.43/.test(card.text), card?.text);

    await app.tapKey('solve');
    await app.enter('ans = 1');
    card = await app.lastCard();
    check('an equation is dimension-checked, not only its sides',
      card && card.failed && /units/i.test(card.text) && !/No solutions/i.test(card.text),
      card?.text);

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  plot: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    check('plot key selects it',
      await app.tapKey('plot') && await app.currentOp() === 'plot');

    await app.enter('sin(x), cos(x)');
    let card = await app.lastCard();
    let plot = await app.plotData();
    check('an ordinary plot renders', card && !card.failed && plot !== null, card?.text);
    // Two functions, the full sample count, and a curve that really is a sine:
    // its top is 1, and the y-range sits just outside it.
    check('both functions are drawn over the whole sample',
      plot && plot.series === 2 && plot.points === 700 && plot.gaps === 0
        && plot.top > 0.99 && plot.top <= 1, JSON.stringify(plot));
    check('the y-range brackets the curve',
      plot && plot.yMax > 1 && plot.yMax < 1.5 && plot.yMin < -1 && plot.yMin > -1.5,
      JSON.stringify(plot));

    /* 1/x^2 over the default range is the discontinuity case twice over. The
     * asymptote has to break the line rather than draw a vertical stroke, so
     * the samples around it come back as gaps. And the peak beside the gap is
     * nearly 5000, while the 1st/99th percentiles are under half a unit — so
     * a y-range taken from the extremes would flatten the whole plot into a
     * line along zero, and one taken from the percentiles cannot. */
    await app.enter('1/x^2');
    card = await app.lastCard();
    plot = await app.plotData();
    check('the second plot renders', card && !card.failed && plot !== null, card?.text);
    check('an asymptote becomes a gap, not a stroke',
      plot && plot.gaps > 0, JSON.stringify(plot));
    check('the y-range comes from the percentiles, not the extremes',
      plot && plot.top > 1000 && plot.yMax < 10, JSON.stringify(plot));

    /* A unit-bearing `ans` lambdifies fine and only fails on the cast to
     * float, which is SymPy's own "Cannot convert expression to float" unless
     * the cast sits inside op_plot's try. Both halves are the assertion: a
     * card that failed, and a card that failed in this app's words. */
    await app.tapKey('x = a');
    // 3000 ms rather than 3 s, for the reason the units group gives: read as
    // ordinary symbols this is 29430*m^2/s, with no decimal point anywhere, so
    // the answer can only be 29.43 m/s if the binding really read units.
    await app.setField('at', 'a = 9.81 m/s^2, t = 3000 ms');
    await app.enter('a*t');
    card = await app.lastCard();
    check('a unit answer is computed for reuse',
      card && !card.failed && /29\.43/.test(card.text), card?.text);

    await app.tapKey('plot');
    await app.enter('ans');
    card = await app.lastCard();
    check('a unit answer is refused in words',
      card && card.failed && /numerically/i.test(card.text)
        && !/Cannot convert|float/i.test(card.text), card?.text);

    check('the app switches to Portuguese', await app.setLang('pt') === 'pt');
    await app.enter('ans');
    card = await app.lastCard();
    check('and refused in Portuguese too',
      card && card.failed && /numericamente/i.test(card.text)
        && !/Cannot convert|float/i.test(card.text), card?.text);

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },

  table: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    check('table key selects it',
      await app.tapKey('table') && await app.currentOp() === 'table');

    await app.setField('start', '-2');
    await app.setField('stop', '2');
    await app.setField('step', '1');
    await app.enter('x^2');
    let card = await app.lastCard();
    const head = JSON.stringify(await app.tableHead());
    check('a table over a range renders',
      card && !card.failed && head === '["x","f(x)"]',
      `${head} — ${card?.text}`);

    // Every row, both columns: the range is walked by the step, and each x is
    // squared. A wrong step or an off-by-one row shows up as a shorter list.
    const rows = JSON.stringify(await app.tableRows());
    check('the rows walk the range and hold the values',
      rows === '[["-2","4"],["-1","1"],["0","0"],["1","1"],["2","4"]]', rows);

    /* op_table's cast to float sits inside its try for the same reason
     * op_plot's does, and needs the same evidence. */
    await app.tapKey('x = a');
    // 3000 ms rather than 3 s, for the reason the units group gives: read as
    // ordinary symbols this is 29430*m^2/s, with no decimal point anywhere, so
    // the answer can only be 29.43 m/s if the binding really read units.
    await app.setField('at', 'a = 9.81 m/s^2, t = 3000 ms');
    await app.enter('a*t');
    card = await app.lastCard();
    check('a unit answer is computed for reuse',
      card && !card.failed && /29\.43/.test(card.text), card?.text);

    await app.tapKey('table');
    await app.enter('ans');
    card = await app.lastCard();
    check('a unit answer is refused in words',
      card && card.failed && /numerically/i.test(card.text)
        && !/Cannot convert|float/i.test(card.text), card?.text);

    check('the app switches to Portuguese', await app.setLang('pt') === 'pt');
    await app.enter('ans');
    card = await app.lastCard();
    check('and refused in Portuguese too',
      card && card.failed && /numericamente/i.test(card.text)
        && !/Cannot convert|float/i.test(card.text), card?.text);

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
  /* Everything the run owns is torn down by the one `finally` below, so
   * everything the run owns is acquired inside the `try` that leads to it —
   * including the browser. `connect()` sitting outside it is how a refused
   * WrongBrowser used to leave a live headless Chrome, its profile directory
   * and this server behind: the throw skipped the teardown entirely. The
   * handles start null because the failure can happen before any of them
   * exists. */
  let chrome = null;
  let s = null;

  try {
    const launched = await launchChrome(profile);
    chrome = launched.child;
    s = await connect(launched.endpoint);
    await s.ready;
    await s.send('Runtime.enable');
    await s.send('Log.enable');
    await s.send('Page.enable');
    /* A headless page is never the window the OS considers focused, and Chrome
     * withholds focus events from a document that isn't: `.focus()` still moves
     * activeElement, but no focus, focusin or blur is ever delivered. Anything
     * the app hangs off focus — the keypad following the caret from field to
     * field, most of all — would then be untestable from here, and worse,
     * would look like it worked while never running at all. This is the same
     * switch Puppeteer throws for page.focus(). */
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const app = makeApp(s);

    for (const [name, run] of Object.entries(groups)) {
      console.log(`\n${name}`);
      await clearStorage(s);
      await run(s, app);
    }
  } finally {
    if (s) s.ws.close();
    if (chrome) {
      chrome.kill();
      await waitExit(chrome);
    }
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
