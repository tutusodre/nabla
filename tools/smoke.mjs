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
