# Ops Navigation and Value Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move operation selection into the math keypad, then add substitute, `ans`, series, units and physical constants without growing the interface.

**Architecture:** Nabla is a static phone-first PWA with no build step. The UI is one IIFE in `src/app.js`; the maths kernel is `src/math.py`, run by SymPy inside Pyodide in a web worker, with `compute()` as the single entry point that always returns JSON and never raises. Operations move from the `.chips` scroll strip onto a new first keypad page, with the chips kept as the fallback for when the keypad is hidden. Every new operation is a new `op_*` function in `math.py` plus an entry in the `OPS` table in `app.js`.

**Tech Stack:** Vanilla ES2020, no framework, no bundler, no npm dependencies. SymPy + NumPy via Pyodide 0.26.4. KaTeX for typesetting, Chart.js for plots. Tests drive headless Chrome over the DevTools protocol using only Node built-ins.

**Spec:** `docs/superpowers/specs/2026-09-10-ops-navigation-and-value-binding-design.md`

## Global Constraints

- **Zero dependencies.** No `package.json`, no npm installs, no build step. Node built-ins and Chrome only.
- **`math.py` never raises.** Every failure path goes through `MathError`, whose constructor is `MathError(template, *values)` — the template stays unformatted so it can be translated.
- **Every user-visible string is translated.** New keys go in both `en` and `pt` blocks of `src/i18n.js`. No literal English in `app.js` or in a `math.py` return value.
- **Units never enter the main expression parser.** They are parsed only on the right-hand side of a substitute binding.
- **`e` remains Euler's number.** The elementary charge is `q_e`.
- **Phone wins.** Where phone and desktop conflict, the phone gets the better layout.
- **Bump `VERSION` in `service-worker.js` once before shipping**, not per task. `VENDOR_VERSION` stays `v5` — it moves only when a pinned vendor URL moves.
- **Work on a branch.** `git switch -c ops-navigation` before Task 1; `main` is the default branch and stays clean.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tools/smoke.mjs` | Dependency-free browser test harness and all assertions | Create (Task 1) |
| `src/app.js` | `KEYPAD` op page, `pressKey` op verb, op label, chips visibility, `OPS` entries, `ans` plumbing | Modify (Tasks 2–7) |
| `src/math.py` | `_bindings`, `op_substitute`, `op_series`, `ans` binding, unit namespace, constants | Modify (Tasks 3–7) |
| `src/style.css` | Op page grid, `.oplabel`, `.kgap`, nav visibility | Modify (Tasks 2, 7) |
| `src/i18n.js` | New strings, `en` and `pt` | Modify (Tasks 2–7) |
| `README.md` | Conventions: `ans`, `q_e`, units in bindings | Modify (Tasks 4, 6, 7) |

`math.py` ends this plan around 1,300 lines. It is deliberately not split: `src/worker.js` fetches it as a single source and runs it with `pyodide.runPython`, so splitting it would mean multiple fetches, extra service-worker precache entries and a boot-order dependency — real cost for no benefit at this size. Revisit if it passes ~2,000 lines.

---

## Task 1: Smoke test harness

Nothing in this repo is testable today: there is no framework, and the parts most worth testing — the service worker, the Pyodide worker, the keypad — only exist in a browser. Every later task's test cycle depends on this one, so it comes first.

**Files:**
- Create: `tools/smoke.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `node tools/smoke.mjs [group]`. Exit code 0 all passed, 1 any failed. Later tasks add a named group to the `GROUPS` object. Inside a group, `s` is the CDP session with `s.eval(expr)` and `s.poll(expr, label, ms)`; `app` holds page helpers `app.boot()`, `app.tapTab(id)`, `app.tapKey(label)`, `app.tapChip(label)`, `app.currentOp()`, `app.enter(source)`, `app.lastCard()`, `app.setField(name, value)`; `check(name, ok, detail)` records one assertion.

- [ ] **Step 1: Create the branch**

```bash
git switch -c ops-navigation
```

- [ ] **Step 2: Write the harness**

Create `tools/smoke.mjs`:

```js
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
    const seconds = await app.boot();
    check('engine reaches ready', true, `${seconds.toFixed(1)}s`);
    await app.enter('sin(x)^2');
    const card = await app.lastCard();
    check('derivative computes', card && !card.failed, card && card.text);
    check('result is 2sin(x)cos(x)', /2\s*sin\(x\)\s*cos\(x\)|sin\(2x\)/.test(card?.text || ''),
      card?.text);
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
    server.close();
    await rm(profile, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Expose the current op for assertions, and label the tabs**

`state` is closed over inside the IIFE, so tests cannot read it. In `src/app.js`, at the end of `setOp`, add one line:

```js
  function setOp(name) {
    state.op = name;
    el.input.placeholder = OPS[name].placeholder;
    renderChips();
    renderParams();
    schedulePreview();
    window.__nablaOp = name;          // read by tools/smoke.mjs
  }
```

Also set it once in `init()` immediately after `renderParams();` so it is populated before the first `setOp`:

```js
    window.__nablaOp = state.op;
```

`tapTab` finds a tab by `dataset.page`, which no tab carries yet. In
`renderKeypad`, immediately after the tab button is created:

```js
      tab.dataset.page = page.id;
```

- [ ] **Step 4: Run the harness — it must pass**

Run: `node tools/smoke.mjs`
Expected: `boot` group prints four `ok` lines and `4 passed, 0 failed`. First run downloads ~25 MB of Pyodide and takes around 15 seconds; later runs reuse the temp profile only within a run, so every run is a cold one.

- [ ] **Step 5: Prove the harness can fail**

Temporarily change the `result is 2sin(x)cos(x)` assertion's regex to `/definitely-not-in-the-output/`.

Run: `node tools/smoke.mjs`
Expected: `FAIL result is 2sin(x)cos(x)` and `3 passed, 1 failed`, exit code 1. A harness that cannot fail proves nothing. Revert the regex.

- [ ] **Step 6: Commit**

```bash
git add tools/smoke.mjs src/app.js
git commit -m "test: add dependency-free browser smoke harness"
```

---

## Task 2: Operations move onto the keypad

**Files:**
- Modify: `src/app.js` — `KEYPAD`, `renderKeypad`, `pressKey`, `renderParams`, `applyKeyboard`, `el`
- Modify: `src/style.css` — `.kgap`, `.oplabel`, nav visibility
- Modify: `src/i18n.js` — `keypad.ops`, `nav.change`
- Modify: `tools/smoke.mjs` — `nav` group

**Interfaces:**
- Consumes: `check`, `app.tapTab`, `app.tapKey`, `app.tapChip`, `app.currentOp` from Task 1.
- Produces: keypad page id `'op'`; key spec `{ act: 'op', op: <name> }`; a `null` key spec renders a `.kgap` spacer; `el.composer.dataset.nav` is `'keypad'` or `'chips'`; CSS class `.oplabel` on the op button inside `.params`.

- [ ] **Step 1: Write the failing test**

Add to `GROUPS` in `tools/smoke.mjs`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tools/smoke.mjs nav`
Expected: FAIL on `op page exists` — there is no `op` page yet.

- [ ] **Step 3: Add the op keypad page**

In `src/app.js`, insert as the **first** entry of the `KEYPAD` array, before the `num` page. Substitute and series do not exist yet, so their cells are gaps that Tasks 3 and 5 fill:

```js
    {
      id: 'op',
      tab: 'keypad.ops',
      tabI18n: true,
      cols: 4,
      keys: [
        ['d/dx', { act: 'op', op: 'derivative' }],
        ['∫', { act: 'op', op: 'integral' }],
        ['lim', { act: 'op', op: 'limit' }],
        [null, null],
        ['simplify', { act: 'op', op: 'simplify' }],
        ['solve', { act: 'op', op: 'solve' }],
        [null, null],
        [null, null],
        ['plot', { act: 'op', op: 'plot' }],
        ['table', { act: 'op', op: 'table' }],
      ],
    },
```

- [ ] **Step 4: Render gaps and translated tab labels**

In `renderKeypad`, the tab label currently uses `page.tab` directly. Replace that line with one that honours `tabI18n`:

```js
      const tab = node('button', 'ktab', page.tabI18n ? t(page.tab) : page.tab);
```

and inside the key loop, handle a `null` spec before anything else:

```js
      for (const [label, spec] of page.keys) {
        if (spec === null) {
          grid.appendChild(node('div', 'kgap'));
          continue;
        }
        const config = typeof spec === 'string' ? { text: spec } : spec;
```

Add the op keys a word class so long labels shrink, alongside the existing `key--word` rule:

```js
        if (config.fn || config.act === 'native' || config.act === 'op') key.classList.add('key--word');
```

- [ ] **Step 5: Teach `pressKey` the op verb**

In the `switch (config.act)` block in `pressKey`, add before `default`:

```js
      case 'op':
        setOp(config.op);
        break;
```

- [ ] **Step 6: Add the op label to the params row**

At the top of `renderParams`, immediately after `el.params.innerHTML = '';` and the `spec`/`values` lookups:

```js
    /* Shows the current op and is also the way to change it, so finding the
     * operations never depends on noticing a keypad tab. */
    const opButton = node('button', 'oplabel', t(spec.labelKey));
    opButton.type = 'button';
    opButton.setAttribute('aria-label', t('nav.change'));
    opButton.addEventListener('pointerdown', (event) => event.preventDefault());
    opButton.addEventListener('click', () => {
      setKeypadPage('op');
      setKeypadOpen(true);
    });
    el.params.appendChild(opButton);
```

- [ ] **Step 7: Switch nav mode in one place**

Add `composer: $('composer'),` to the `el` map. Then in `applyKeyboard`, after `el.keypad.hidden = !math;`:

```js
    // Ops live on the keypad when it's showing and on the chips when it isn't;
    // the native-keyboard switch hides the keypad on a phone too, not just on
    // desktop, so this keys off the keypad rather than the viewport width.
    el.composer.dataset.nav = math ? 'keypad' : 'chips';
```

- [ ] **Step 8: Add the CSS**

In `src/style.css`, after the `.chip` rules:

```css
.composer[data-nav="keypad"] .chips { display: none; }
.composer[data-nav="chips"] .oplabel { display: none; }

.kgap { visibility: hidden; }

.oplabel {
  appearance: none;
  flex: 0 0 auto;
  background: none;
  border: var(--rule-w) solid var(--rule);
  border-radius: 999px;
  padding: 5px 12px;
  color: var(--accent);
  font-family: var(--serif);
  font-size: 12px;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.oplabel::after { content: " \25BE"; color: var(--ink-faint); }
.oplabel:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 9: Add the strings**

In `src/i18n.js`, `en`:

```js
      'keypad.ops': 'ops',
      'nav.change': 'Change operation',
```

`pt`:

```js
      'keypad.ops': 'oper',
      'nav.change': 'Trocar operação',
```

- [ ] **Step 10: Run the tests**

Run: `node tools/smoke.mjs nav`
Expected: PASS, seven `ok` lines.

Run: `node tools/smoke.mjs`
Expected: both groups pass — the `boot` group must still be green.

- [ ] **Step 11: Commit**

```bash
git add src/app.js src/style.css src/i18n.js tools/smoke.mjs
git commit -m "feat: move operation picker onto the keypad, chips as fallback"
```

---

## Task 3: Substitute

**Files:**
- Modify: `src/math.py` — `_bindings`, `op_substitute`, `OPERATIONS`
- Modify: `src/app.js` — `OPS.substitute`, `OP_ORDER`, op page key
- Modify: `src/i18n.js` — `op.substitute`, `field.at`, error strings
- Modify: `tools/smoke.mjs` — `substitute` group

**Interfaces:**
- Consumes: the op page from Task 2.
- Produces: `_bindings(text, parse_value=None) -> list[tuple[Symbol, Expr]]` in `math.py`, reused by Task 6 for units; `op_substitute(source="", at="")` returning `{statement, latex, text, alternates}`; op name `'substitute'`; field id `f-at`.

- [ ] **Step 1: Write the failing test**

Add to `GROUPS`:

```js
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
    check('bindings apply simultaneously', card && !card.failed && /y\s*-\s*x/.test(card.text),
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tools/smoke.mjs substitute`
Expected: FAIL on `substitute key selects it` — the key is still a gap.

- [ ] **Step 3: Add `_bindings` to `math.py`**

Place it directly after `_parse_equation`, next to the other parsing helpers:

```python
def _bindings(text, parse_value=None):
    """`x = 2, y = 3` -> [(Symbol('x'), expr), ...].

    `parse_value` overrides how the right-hand side is read, which is how
    units get in without touching the main expression parser.
    """
    read = parse_value or _parse
    parts = _split_top(text or "")
    if not parts:
        raise MathError("Give at least one value, like “x = 2”.")

    pairs, seen = [], set()
    for part in parts:
        halves = _split_equation(part)
        if not halves:
            raise MathError("Each value needs an “=”, like “x = 2”.")
        name, raw = halves[0].strip(), halves[1].strip()
        if not _NAME_RE.match(name):
            raise MathError("The left side of “=” has to be a variable name.")
        if not raw:
            raise MathError("“%s” has no value after the “=”.", name)
        if name in seen:
            raise MathError("“%s” is given a value twice.", name)
        seen.add(name)
        pairs.append((_sym(name), read(raw)))
    return pairs
```

- [ ] **Step 4: Add `op_substitute`**

Place it after `op_simplify`, before `op_solve`:

```python
def op_substitute(source="", at=""):
    expr = _parse(source)
    pairs = _bindings(at)

    # simultaneous keeps `x = y, y = x` a swap rather than a cascade.
    result = expr.subs(pairs, simultaneous=True)
    simplified = _try_simplify(result)

    alternates = []
    decimal = _approx(simplified)
    if decimal and decimal != _text(simplified):
        alternates.append({"label": _t("decimal"), "latex": decimal, "text": decimal})

    given = r",\; ".join("%s = %s" % (_latex(sym), _latex(val)) for sym, val in pairs)
    return {
        "statement": r"%s,\quad %s" % (_latex(expr), given),
        "alternates": alternates,
        **_fmt(simplified),
    }
```

- [ ] **Step 5: Register the operation**

In `OPERATIONS`, after `"simplify": op_simplify,`:

```python
    "substitute": op_substitute,
```

- [ ] **Step 6: Add the translated error strings**

`math.py` translates by English source string, so add each new message to the `MESSAGES` `pt` block:

```python
    "Give at least one value, like “x = 2”.": "Dê ao menos um valor, como “x = 2”.",
    "Each value needs an “=”, like “x = 2”.": "Cada valor precisa de um “=”, como “x = 2”.",
    "The left side of “=” has to be a variable name.":
        "O lado esquerdo do “=” tem que ser um nome de variável.",
    "“%s” has no value after the “=”.": "“%s” não tem valor depois do “=”.",
    "“%s” is given a value twice.": "“%s” recebeu valor duas vezes.",
    "decimal": "decimal",
```

(`decimal` may already be present — do not add it twice.)

- [ ] **Step 7: Add the op to `app.js`**

In `OPS`, after the `simplify` entry:

```js
    substitute: {
      labelKey: 'op.substitute',
      chip: 'x = a',
      placeholder: 'x^3 + 1',
      fields: [
        { name: 'at', labelKey: 'field.at', kind: 'text', value: '', placeholder: 'x = 2, y = 3' },
      ],
      meta: (params) => params.at || '',
    },
```

Add `'substitute'` to `OP_ORDER` after `'simplify'`, and replace the **first** `[null, null]` gap on the op page (the fourth cell of row two) with:

```js
        ['x = a', { act: 'op', op: 'substitute' }],
```

so row two reads `simplify`, `solve`, `x = a`, gap.

- [ ] **Step 8: Add the UI strings**

`en`:

```js
      'op.substitute': 'substitute',
      'field.at': 'at',
```

`pt`:

```js
      'op.substitute': 'substituir',
      'field.at': 'em',
```

- [ ] **Step 9: Run the tests**

Run: `node tools/smoke.mjs substitute`
Expected: PASS, nine `ok` lines.

Run: `node tools/smoke.mjs`
Expected: all three groups pass.

- [ ] **Step 10: Commit**

```bash
git add src/math.py src/app.js src/i18n.js tools/smoke.mjs
git commit -m "feat: add substitute operation"
```

---

## Task 4: `ans`

**Files:**
- Modify: `src/math.py` — `LAST_ANS`, `_parse`, `compute`
- Modify: `src/app.js` — `call`, `ANS_OPS`, `state.ans`, keypad key
- Modify: `src/i18n.js` — no new UI strings; `math.py` message only
- Modify: `README.md` — conventions
- Modify: `tools/smoke.mjs` — `ans` group

**Interfaces:**
- Consumes: `op_substitute` from Task 3 (used in the chaining assertion).
- Produces: `ans` accepted anywhere an expression is parsed; `compute(op, args_json, lang)` unchanged in signature — `ans` arrives inside `args_json`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tools/smoke.mjs ans`
Expected: FAIL on `ans chains from the last result` — `ans` parses as a product of three symbols today.

- [ ] **Step 3: Thread `ans` through `math.py`**

Beside the existing `LANGUAGE` global, add:

```python
LAST_ANS = None
```

Extend `_parse` so it can layer extra names over `LOCALS` and bind `ans`:

```python
def _parse(src, extra=None):
    text = (src or "").strip()
    if not text:
        raise MathError("Type an expression first.")
    names = LOCALS if extra is None else {**LOCALS, **extra}
    if _NAME_RE.match("ans") and "ans" in text:
        if LAST_ANS is None:
            raise MathError("Nothing to reuse yet — compute something first.")
        names = {**names, "ans": LAST_ANS}
    expr = parse_expr(text, local_dict=names, transformations=TRANSFORMS)
    return sp.sympify(expr)
```

The `"ans" in text` guard is a substring test on purpose: it is cheap, and a false positive (a variable named `answer`) only means the binding is present but unused.

In `compute`, set it from the incoming args before dispatching:

```python
def compute(op, args_json, lang="en"):
    """Single entry point. Always returns a JSON string, never raises."""
    global LAST_ANS
    set_language(lang)
    try:
        handler = OPERATIONS[op]
    except KeyError:
        return json.dumps({"ok": False, "error": _t("Unknown operation “%s”.") % op})

    try:
        args = json.loads(args_json) if args_json else {}
        previous = args.pop("ans", None)
        LAST_ANS = _parse(previous) if previous else None
        return json.dumps({"ok": True, "data": handler(**args)})
    except Exception as exc:  # noqa: BLE001 — every failure must reach the user
        return json.dumps({"ok": False, "error": _friendly(exc)})
```

Parsing `previous` inside the `try` means a malformed stored answer surfaces as an ordinary error rather than a crash.

- [ ] **Step 4: Add the Portuguese message**

```python
    "Nothing to reuse yet — compute something first.":
        "Nada para reutilizar ainda — calcule algo primeiro.",
```

- [ ] **Step 5: Send `ans` from `app.js`**

Next to the other constants at the top of the IIFE:

```js
  /* Ops whose result is a single expression, so it can be reused as `ans`.
   * solve is out because "the answer" is ambiguous with several roots;
   * plot and table are out because they aren't scalars. */
  const ANS_OPS = new Set(['derivative', 'integral', 'limit', 'simplify', 'substitute']);
```

Add a helper beside `call`:

```js
  function lastAnswer() {
    const entry = state.entries.find((item) => item.ok && ANS_OPS.has(item.op));
    return entry && entry.data ? entry.data.text : null;
  }
```

`state.entries` is newest-first, so `find` returns the most recent. Include it in every call:

```js
  function call(op, args) {
    return new Promise((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      worker.postMessage({ id, op, args: { ...args, ans: lastAnswer() }, lang: window.NablaI18n.lang });
    });
  }
```

- [ ] **Step 6: Add the keypad key**

On the `num` page, replace `['π', 'pi']` with:

```js
        ['ans', 'ans'],
```

π moves to the names page in Task 7. Until then it stays reachable by typing `pi`.

- [ ] **Step 7: Document it**

In `README.md`, under "Conventions worth knowing":

```markdown
- `ans` is the last single-expression result — derivative, integral, limit,
  simplify or substitute. Solve is excluded because "the answer" is ambiguous
  with several roots, and plots and tables are not single values.
```

- [ ] **Step 8: Run the tests**

Run: `node tools/smoke.mjs ans`
Expected: PASS, four `ok` lines.

Run: `node tools/smoke.mjs`
Expected: all four groups pass.

- [ ] **Step 9: Commit**

```bash
git add src/math.py src/app.js README.md tools/smoke.mjs
git commit -m "feat: add ans for chaining from the last result"
```

---

## Task 5: Series

**Files:**
- Modify: `src/math.py` — `op_series`, `OPERATIONS`
- Modify: `src/app.js` — `OPS.series`, `OP_ORDER`, op page key
- Modify: `src/i18n.js` — `op.series`, `field.about`, `field.terms`
- Modify: `tools/smoke.mjs` — `series` group

**Interfaces:**
- Consumes: the op page from Task 2.
- Produces: `op_series(source="", variable="x", about="0", order="6")`; op name `'series'`; field ids `f-about`, `f-order`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tools/smoke.mjs series`
Expected: FAIL on `series key selects it`.

- [ ] **Step 3: Add `op_series`**

After `op_limit`:

```python
def op_series(source="", variable="x", about="0", order="6"):
    expr = _parse(source)
    var = _sym(variable)
    point = _parse_point(about)

    count = int(_parse_float(order, "Terms"))
    if count < 1 or count > 20:
        raise MathError("Terms has to be between 1 and 20.")

    try:
        expansion = sp.series(expr, var, point, count)
    except (NotImplementedError, sp.PoleError):
        raise MathError("SymPy couldn’t expand that here — try another point.")

    truncated = expansion.removeO()
    alternates = []
    entry = _alternate("without the O term", truncated, expansion)
    if entry:
        alternates.append(entry)

    return {
        "statement": r"%s,\quad %s \to %s" % (_latex(expr), _latex(var), _latex(point)),
        "alternates": alternates,
        **_fmt(expansion),
    }
```

The `O(...)` term stays in the primary rendering; dropping it silently would misrepresent the result.

- [ ] **Step 4: Register it**

In `OPERATIONS`, after `"limit": op_limit,`:

```python
    "series": op_series,
```

- [ ] **Step 5: Add the Portuguese messages**

```python
    "Terms": "Termos",
    "Terms has to be between 1 and 20.": "Termos tem que ser entre 1 e 20.",
    "SymPy couldn’t expand that here — try another point.":
        "O SymPy não conseguiu expandir aqui — tente outro ponto.",
    "without the O term": "sem o termo O",
```

- [ ] **Step 6: Add the op to `app.js`**

In `OPS`, after the `limit` entry:

```js
    series: {
      labelKey: 'op.series',
      chip: 'series',
      chipKey: 'op.series',
      placeholder: 'sin(x)',
      fields: [
        { name: 'variable', labelKey: 'field.wrt', kind: 'var', value: 'x' },
        { name: 'about', labelKey: 'field.about', kind: 'text', value: '0' },
        { name: 'order', labelKey: 'field.terms', kind: 'int', value: '6' },
      ],
      meta: (params) => `${params.variable} → ${params.about}`,
    },
```

Add `'series'` to `OP_ORDER` after `'limit'`, and replace the remaining `[null, null]` in row one of the op page with:

```js
        ['series', { act: 'op', op: 'series' }],
```

- [ ] **Step 7: Add the UI strings**

`en`:

```js
      'op.series': 'series',
      'field.about': 'about',
      'field.terms': 'terms',
```

`pt`:

```js
      'op.series': 'série',
      'field.about': 'em torno de',
      'field.terms': 'termos',
```

- [ ] **Step 8: Run the tests**

Run: `node tools/smoke.mjs series` then `node tools/smoke.mjs`
Expected: all five groups pass.

- [ ] **Step 9: Commit**

```bash
git add src/math.py src/app.js src/i18n.js tools/smoke.mjs
git commit -m "feat: add series expansion"
```

---

## Task 6: Units inside substitute

**Files:**
- Modify: `src/math.py` — `_unit_names`, `_parse_quantity`, `op_substitute`
- Modify: `README.md` — conventions
- Modify: `tools/smoke.mjs` — `units` group

**Interfaces:**
- Consumes: `_bindings(text, parse_value)` from Task 3 — this is the hook it was built for.
- Produces: `_unit_names() -> dict[str, Quantity]`, memoised; `_parse_quantity(text) -> Expr`. `op_substitute` gains no new parameters.

- [ ] **Step 1: Write the failing test**

```js
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

    await app.setField('at', 'v = 3 m/s, a = 2 m/s^2');
    await app.enter('v + a');
    card = await app.lastCard();
    check('a dimension mismatch is caught', card && card.failed, card?.text);

    await app.setField('at', 'R = 4.7 kohm, I = 2 mA');
    await app.enter('R*I');
    card = await app.lastCard();
    check('prefixes and ohm work', card && !card.failed && /9\.4/.test(card.text), card?.text);

    await app.setField('at', 'm = 2, s = 3');
    await app.enter('m + s');
    card = await app.lastCard();
    check('bare names still mean variables, not units',
      card && !card.failed && /\b5\b/.test(card.text), card?.text);

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },
```

The last assertion is the important one: it is what proves units did not leak into the ordinary parser.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tools/smoke.mjs units`
Expected: FAIL on `units multiply through` — `m` and `s` currently parse as plain symbols, giving `9.81*m*3*s/s^2`.

- [ ] **Step 3: Build the unit namespace**

Add to `math.py` beside the other parsing helpers:

```python
_UNIT_CACHE = {}

# An explicit allowlist, not a star-import: these names shadow ordinary
# variables inside a binding's right-hand side, so the set stays reviewable.
_UNIT_NAMES = (
    "meter second kilogram gram ampere kelvin mole candela "
    "newton joule watt volt coulomb farad henry ohm siemens tesla weber "
    "pascal hertz radian degree liter minute hour day"
).split()

_UNIT_ALIASES = {
    "m": "meter", "s": "second", "kg": "kilogram", "g": "gram", "A": "ampere",
    "K": "kelvin", "mol": "mole", "cd": "candela", "N": "newton", "J": "joule",
    "W": "watt", "V": "volt", "C": "coulomb", "F": "farad", "H": "henry",
    "S": "siemens", "T": "tesla", "Wb": "weber", "Pa": "pascal", "Hz": "hertz",
    "rad": "radian", "L": "liter", "min": "minute", "h": "hour",
    "Ω": "ohm", "Ohm": "ohm",
}

_PREFIXES = {
    "T": 1e12, "G": 1e9, "M": 1e6, "k": 1e3, "d": 1e-1, "c": 1e-2,
    "m": 1e-3, "u": 1e-6, "µ": 1e-6, "μ": 1e-6, "n": 1e-9, "p": 1e-12,
}


def _unit_names():
    """Unit names, aliases and prefixed forms. Built once, on first use."""
    if _UNIT_CACHE:
        return _UNIT_CACHE

    from sympy.physics import units as u

    base = {}
    for name in _UNIT_NAMES:
        unit = getattr(u, name, None)
        if unit is not None:
            base[name] = unit
    for alias, name in _UNIT_ALIASES.items():
        if name in base:
            base[alias] = base[name]

    # Prefixed spellings: kohm, mA, kV, ms. Only over the short aliases, so
    # "mmeter" never appears and the namespace stays small.
    prefixed = {}
    for alias, name in _UNIT_ALIASES.items():
        if name not in base:
            continue
        for prefix, factor in _PREFIXES.items():
            prefixed.setdefault(prefix + alias, factor * base[name])

    _UNIT_CACHE.update(prefixed)
    _UNIT_CACHE.update(base)   # unprefixed wins on any collision
    return _UNIT_CACHE
```

The import is inside the function so boot time does not pay for it.

- [ ] **Step 4: Parse binding values with units**

```python
def _parse_quantity(text):
    """Parse a binding's right-hand side, where unit names are in scope."""
    return _parse(text, extra=_unit_names())
```

- [ ] **Step 5: Use it in `op_substitute`**

Replace the `pairs` line and the result handling:

```python
def op_substitute(source="", at=""):
    from sympy.physics.units import Quantity, convert_to
    from sympy.physics.units.systems.si import SI

    expr = _parse(source)
    pairs = _bindings(at, parse_value=_parse_quantity)

    result = expr.subs(pairs, simultaneous=True)
    has_units = bool(result.atoms(Quantity))

    if has_units:
        try:
            SI._collect_factor_and_dimension(result)
        except ValueError as exc:
            raise MathError("Those units don’t match up — %s", str(exc).rstrip("."))
        base = convert_to(result, SI.get_units_non_prefixed())
        simplified = sp.nsimplify(base, rational=False)
    else:
        simplified = _try_simplify(result)

    alternates = []
    decimal = _approx(simplified)
    if decimal and decimal != _text(simplified):
        alternates.append({"label": _t("decimal"), "latex": decimal, "text": decimal})
    if has_units:
        entry = _alternate("as written", result, simplified)
        if entry:
            alternates.append(entry)

    given = r",\; ".join("%s = %s" % (_latex(sym), _latex(val)) for sym, val in pairs)
    return {
        "statement": r"%s,\quad %s" % (_latex(expr), given),
        "alternates": alternates,
        **_fmt(simplified),
    }
```

- [ ] **Step 6: Add the Portuguese messages**

```python
    "Those units don’t match up — %s": "Essas unidades não batem — %s",
    "as written": "como escrito",
```

- [ ] **Step 7: Measure the boot cost**

Run: `node tools/smoke.mjs boot` before and after this task and compare the `engine reaches ready` timings. The lazy import means the delta should be near zero until a binding with units is actually used. If boot regresses by more than half a second, the import has leaked to module scope — find it and move it back inside.

- [ ] **Step 8: Document it**

In `README.md`, under "Conventions worth knowing":

```markdown
- Units are understood on the right-hand side of a substitute binding —
  `a = 9.81 m/s^2` — and nowhere else. That is deliberate: it keeps `m`, `s`
  and `N` usable as ordinary variables in the expression itself. Mismatched
  dimensions are an error rather than a silent number.
```

- [ ] **Step 9: Run the tests**

Run: `node tools/smoke.mjs units` then `node tools/smoke.mjs`
Expected: all six groups pass.

- [ ] **Step 10: Commit**

```bash
git add src/math.py README.md tools/smoke.mjs
git commit -m "feat: understand units in substitute bindings"
```

---

## Task 7: Constants and the names page

**Files:**
- Modify: `src/math.py` — `_PHYSICAL`, `LOCALS`
- Modify: `src/app.js` — names page keys, tab label
- Modify: `src/i18n.js` — `keypad.names`
- Modify: `README.md` — conventions
- Modify: `tools/smoke.mjs` — `constants` group

**Interfaces:**
- Consumes: `_unit_names()` from Task 6 — constants carry units, which is why they come after.
- Produces: names `c`, `h`, `hbar`, `k_B`, `G`, `mu_0`, `epsilon_0`, `N_A`, `m_e`, `q_e`, `g` in `LOCALS`.

- [ ] **Step 1: Write the failing test**

```js
  constants: async (s, app) => {
    await s.open(APP);
    await app.boot();
    await app.tapTab('op');
    await app.tapKey('x = a');

    await app.setField('at', 'f = 5e14 Hz');
    await app.enter('h*f');
    let card = await app.lastCard();
    check('a constant resolves with units',
      card && !card.failed && /e-19|E-19/.test(card.text), card?.text);

    await app.setField('at', 'm = 1 kg');
    await app.enter('m*c^2');
    card = await app.lastCard();
    check('c is the speed of light',
      card && !card.failed && /e\+?16|E\+?16/.test(card.text), card?.text);

    check('e is still Euler’s number', await s.eval(`(async () => {
      const input = document.getElementById('input');
      input.value = 'e';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      return document.getElementById('preview').textContent.includes('e');
    })()`));

    await app.tapTab('names');
    check('names page has the constants', await app.tapKey('ℏ'));
    check('names page still has the Greek letters', await app.tapKey('θ'));

    check('no console errors', s.errors.length === 0, s.errors.join(' | '));
  },
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node tools/smoke.mjs constants`
Expected: FAIL on `a constant resolves with units` — `h` is a plain symbol today.

- [ ] **Step 3: Add the constants to `math.py`**

Beside `_CONSTANTS`, add a lazily-built table. They are `Quantity` objects, so they print as `c` and `h` and stay symbolic until a substitute resolves them:

```python
_PHYSICAL_NAMES = {
    "c": "speed_of_light",
    "h": "planck",
    "hbar": "hbar",
    "k_B": "boltzmann_constant",
    "G": "gravitational_constant",
    "mu_0": "magnetic_constant",
    "epsilon_0": "vacuum_permittivity",
    "N_A": "avogadro_constant",
    "m_e": "electron_rest_mass",
    "q_e": "elementary_charge",
    "g": "acceleration_due_to_gravity",
}
```

`q_e` is the elementary charge: `e` stays Euler's number, because reassigning it would break every `e^x` already sitting in someone's history.

Add a resolver next to `_unit_names`:

```python
def _physical_names():
    """Physical constants as Quantity objects, folded into the unit namespace."""
    from sympy.physics import units as u

    out = {}
    for name, attr in _PHYSICAL_NAMES.items():
        value = getattr(u, attr, None)
        if value is not None:
            out[name] = value
    return out
```

Fold them into both namespaces. In `_unit_names`, before the final `return`:

```python
    _UNIT_CACHE.update(_physical_names())
```

And so a constant is also recognised in the main expression, extend `LOCALS` at import time with symbols of the same names — they resolve to real values only when a binding is evaluated:

```python
# Physical constants read as named symbols in an expression and become real
# quantities inside a substitute. They stay plain Symbols here, so `c` is still
# an ordinary variable everywhere except a substitute — and a binding for it
# still wins there (see op_substitute).
LOCALS.update({name: sp.Symbol(name) for name in _PHYSICAL_NAMES})
```

Place this immediately after the existing `LOCALS.update(_FUNCTIONS)` line, and check the ordering comment above it still reads true — functions must still shadow both.

Note that `c` is already in `_SYMBOL_NAMES` as an ordinary variable, and it is
also the most common name for a constant of integration. That collision is
handled in the next step, not here: re-adding it as a `Symbol` changes nothing
about how it parses.

- [ ] **Step 4: Resolve constant symbols during substitution — but let a binding win**

`c` is both the speed of light and the commonest name for a constant of
integration, and `g`, `h` and `G` are all plausible variable names too. The
rule that resolves this: **a name you bind yourself is yours.** `c = 3` means
three; `c` left unbound in a substitute means the speed of light.

In `op_substitute`, directly after the `pairs = _bindings(...)` line:

```python
    # A constant the user bound themselves stays theirs — `c = 3` means three,
    # not the speed of light. Only unbound names resolve to physical values.
    bound = {sym.name for sym, _ in pairs}
    physical = {
        sp.Symbol(name): value
        for name, value in _physical_names().items()
        if name not in bound
    }
    if physical and expr.free_symbols & set(physical):
        expr = expr.subs(physical)
```

This must come after `pairs` is built, since it depends on what was bound.

- [ ] **Step 5: Rebuild the names page**

In `src/app.js`, change the `var` page's tab to a translated label and append the constants after the Greek letters, starting on a fresh row. The page keeps `cols: 6`:

```js
    {
      id: 'var',
      tab: 'keypad.names',
      tabI18n: true,
      cols: 6,
      keys: [
        ['x', 'x'], ['y', 'y'], ['z', 'z'], ['t', 't'], ['n', 'n'], ['k', 'k'],
        ['θ', 'theta'], ['ω', 'omega'], ['φ', 'phi'], ['τ', 'tau'],
        ['α', 'alpha'], ['β', 'beta'],
        ['λ', 'lamda'], ['μ', 'mu'], ['σ', 'sigma'], ['ε', 'epsilon'],
        ['ρ', 'rho'], ['δ', 'delta'],
        ['π', 'pi'], ['c', 'c'], ['h', 'h'], ['ℏ', 'hbar'], ['G', 'G'], ['g', 'g'],
        ['k_B', 'k_B'], ['N_A', 'N_A'], ['q_e', 'q_e'], ['m_e', 'm_e'],
        ['μ₀', 'mu_0'], ['ε₀', 'epsilon_0'],
        ['keypad.native', { act: 'native', full: true, i18n: true }],
      ],
    },
```

That is 30 keys at six columns — five rows, the same height as the numeric page, so the keypad does not change size.

- [ ] **Step 6: Add the strings**

`en`: `'keypad.names': 'names',` — `pt`: `'keypad.names': 'nomes',`

- [ ] **Step 7: Document it**

In `README.md`, under "Conventions worth knowing":

```markdown
- Physical constants — `c`, `h`, `hbar`, `k_B`, `G`, `g`, `mu_0`, `epsilon_0`,
  `N_A`, `m_e`, `q_e` — read as named symbols in an expression and resolve to
  values with units inside a substitute. The elementary charge is `q_e`, not
  `e`: `e` is Euler's number, and reassigning it would change the meaning of
  every `e^x` already written.
```

- [ ] **Step 8: Run the tests**

Run: `node tools/smoke.mjs constants` then `node tools/smoke.mjs`
Expected: all seven groups pass.

- [ ] **Step 9: Bump the deploy version and commit**

In `service-worker.js`, change `const VERSION = 'v6';` to `'v7'`. Leave `VENDOR_VERSION` at `'v5'` — no pinned vendor URL moved, so the ~25 MB Pyodide cache must survive.

```bash
git add src/math.py src/app.js src/i18n.js service-worker.js README.md tools/smoke.mjs
git commit -m "feat: add physical constants on the names page"
```

---

## Task 8: Thin the card actions — NOT APPROVED

Spec §7 is explicitly pending. **Do not implement without asking.** Recorded here so the plan is complete:

fold `copy`, `latex` and `delete` behind a single `⋯` control on each card, leaving `steps` and `reuse` inline. The buttons are already quiet (10px, `--ink-faint`, transparent border until hover), so this is about repetition across sixty cards rather than loudness. Delete already has undo, so it loses nothing by moving one level down.

---

## Verification before merge

- [ ] `node tools/smoke.mjs` — all seven groups pass, zero console errors
- [ ] Cold-boot timing has not regressed by more than 0.5s versus the `boot` timing recorded in Task 1
- [ ] Existing history from before the change still renders — `load()` filters unknown ops, so entries survive, but check by hand with a populated `localStorage`
- [ ] Both languages: switch to PT and confirm no key renders as a raw `op.*` or `field.*` string
- [ ] Desktop at >619px with a mouse: chips visible, op label hidden, every op reachable
- [ ] Phone width with the native keyboard selected: chips visible, ops still reachable
