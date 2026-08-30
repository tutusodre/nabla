/* Nabla — UI, state, history.
 *
 * The stream IS the history: results stack upward from the composer and
 * persist, so scrolling back is browsing the past. No separate history screen.
 */

(() => {
  'use strict';

  const HISTORY_KEY = 'nabla.history.v1';
  const THEME_KEY = 'nabla.theme.v1';
  const MAX_ENTRIES = 60;
  const MAX_STORED_POINTS = 220;
  const PREVIEW_DELAY = 180;
  const ABORT_AFTER = 2500;

  // ---------------------------------------------------------- operations --

  const t = (...args) => window.NablaI18n.t(...args);

  /* Strings are held as keys and resolved through t() at render time, so
   * switching language re-renders correctly without rebuilding this table. */
  const OPS = {
    derivative: {
      labelKey: 'op.derivative',
      chip: 'd/dx',
      placeholder: 'sin(x)^2',
      fields: [
        { name: 'variable', labelKey: 'field.wrt', kind: 'var', value: 'x' },
        { name: 'order', labelKey: 'field.order', kind: 'int', value: '1' },
      ],
      meta: (p) => t('meta.order', p.order, p.variable),
    },
    integral: {
      labelKey: 'op.integral',
      chip: '∫',
      placeholder: 'x^2',
      fields: [
        { name: 'variable', labelKey: 'field.d', kind: 'var', value: 'x' },
        { name: 'lower', labelKey: 'field.from', kind: 'text', value: '', placeholder: '—' },
        { name: 'upper', labelKey: 'field.to', kind: 'text', value: '', placeholder: '—' },
      ],
      meta: (p) => (p.lower && p.upper
        ? t('meta.definite', p.lower, p.upper, p.variable)
        : t('meta.indefinite', p.variable)),
    },
    limit: {
      labelKey: 'op.limit',
      chip: 'lim',
      placeholder: 'sin(x)/x',
      fields: [
        { name: 'variable', labelKey: 'field.var', kind: 'var', value: 'x' },
        { name: 'point', labelKey: 'field.to', kind: 'text', value: '0' },
        {
          name: 'direction',
          labelKey: 'field.side',
          kind: 'toggle',
          value: '+-',
          options: [['+-', 'field.both'], ['+', '+'], ['-', '−']],
        },
      ],
      meta: (p) => t('meta.limit', p.variable, p.point) +
        (p.direction === '+-' ? '' : t(p.direction === '+' ? 'meta.fromRight' : 'meta.fromLeft')),
    },
    simplify: {
      labelKey: 'op.simplify',
      chipKey: 'chip.simplify',
      placeholder: 'sin(x)^2 + cos(x)^2',
      fields: [],
      meta: () => t('meta.simplify'),
    },
    solve: {
      labelKey: 'op.solve',
      chipKey: 'chip.solve',
      placeholder: 'x^2 = 4',
      fields: [
        { name: 'variable', labelKey: 'field.for', kind: 'var', value: 'x' },
        { name: 'complex_roots', labelKey: 'field.complex', kind: 'check', value: false },
      ],
      meta: (p) => t('meta.for', p.variable) + (p.complex_roots ? t('meta.complex') : ''),
    },
    plot: {
      labelKey: 'op.plot',
      chipKey: 'chip.plot',
      placeholder: 'sin(x), cos(x)',
      fields: [
        { name: 'x_min', labelKey: 'field.xFrom', kind: 'text', value: '-10' },
        { name: 'x_max', labelKey: 'field.to', kind: 'text', value: '10' },
      ],
      meta: (p) => t('meta.range', p.x_min, p.x_max),
    },
    table: {
      labelKey: 'op.table',
      chipKey: 'chip.table',
      placeholder: 'x^2',
      fields: [
        { name: 'variable', labelKey: 'field.var', kind: 'var', value: 'x' },
        { name: 'start', labelKey: 'field.from', kind: 'text', value: '-5' },
        { name: 'stop', labelKey: 'field.to', kind: 'text', value: '5' },
        { name: 'step', labelKey: 'field.step', kind: 'text', value: '1' },
      ],
      meta: (p) => t('meta.table', p.start, p.stop, p.step),
    },
  };

  const OP_ORDER = ['derivative', 'integral', 'limit', 'simplify', 'solve', 'plot', 'table'];

  /* Keypad pages. A key is [label, spec]: a plain string inserts literally,
   * {fn} inserts `name()` with the caret inside, {act} runs an action. */
  const KEYPAD = [
    {
      id: 'num',
      tab: '123',
      cols: 5,
      keys: [
        ['7', '7'], ['8', '8'], ['9', '9'], ['(', { act: 'open' }], [')', { act: 'close' }],
        ['4', '4'], ['5', '5'], ['6', '6'], ['^', '^'], ['÷', '/'],
        ['1', '1'], ['2', '2'], ['3', '3'], ['×', '*'], ['−', '-'],
        ['0', '0'], ['.', '.'], ['x', 'x'], [',', ','], ['+', '+'],
        ['◀', { act: 'left', repeat: true }], ['▶', { act: 'right', repeat: true }],
        ['π', 'pi'], ['=', '='], ['⏎', { act: 'enter', wide: true }],
      ],
    },
    {
      id: 'fn',
      tab: 'ƒ(x)',
      cols: 5,
      keys: [
        ['sin', { fn: 'sin' }], ['cos', { fn: 'cos' }], ['tan', { fn: 'tan' }],
        ['ln', { fn: 'ln' }], ['log', { fn: 'log' }],
        ['√', { fn: 'sqrt' }], ['exp', { fn: 'exp' }], ['|x|', { fn: 'abs' }],
        ['∞', 'oo'], ['!', '!'],
        ['asin', { fn: 'asin' }], ['acos', { fn: 'acos' }], ['atan', { fn: 'atan' }],
        ['x²', '^2'], ['x⁻¹', '^-1'],
      ],
    },
    {
      id: 'var',
      tab: 'abc',
      cols: 6,
      keys: [
        ['x', 'x'], ['y', 'y'], ['z', 'z'], ['t', 't'], ['n', 'n'], ['k', 'k'],
        ['θ', 'theta'], ['ω', 'omega'], ['φ', 'phi'], ['τ', 'tau'],
        ['α', 'alpha'], ['β', 'beta'],
        ['λ', 'lamda'], ['μ', 'mu'], ['σ', 'sigma'], ['ε', 'epsilon'],
        ['ρ', 'rho'], ['δ', 'delta'],
        ['keypad.native', { act: 'native', full: true, i18n: true }],
      ],
    },
  ];

  const KEYPAD_PAGE_KEY = 'nabla.keypad.page.v1';
  const KEYBOARD_KEY = 'nabla.keyboard.v1';

  // --------------------------------------------------------------- state --

  const state = {
    op: 'derivative',
    params: {},
    entries: [],
    ready: false,
    busy: false,
    varTouched: {},
    keypadPage: 'num',
    keypadOpen: true,
    keyboard: 'math',
  };

  for (const [name, spec] of Object.entries(OPS)) {
    state.params[name] = {};
    for (const field of spec.fields) state.params[name][field.name] = field.value;
  }

  const $ = (id) => document.getElementById(id);
  const el = {
    boot: $('boot'), bootStatus: $('bootStatus'), bootBar: $('bootBar'),
    stream: $('stream'), intro: $('intro'), preview: $('preview'),
    chips: $('chips'), params: $('params'),
    form: $('form'), input: $('input'), go: $('go'), toast: $('toast'),
    themeBtn: $('themeBtn'), exportBtn: $('exportBtn'), clearBtn: $('clearBtn'),
    themeColor: $('themeColor'),
    keypad: $('keypad'), keypadTabs: $('keypadTabs'), keypadPages: $('keypadPages'),
    kpBack: $('kpBack'), kpToggle: $('kpToggle'),
    kswitch: $('kswitch'), kswitchBtn: $('kswitchBtn'),
    langBtn: $('langBtn'),
  };

  const charts = new Map();

  // -------------------------------------------------------------- worker --

  let worker = null;
  let sequence = 0;
  const pending = new Map();

  function startWorker() {
    worker = new Worker('./src/worker.js');
    worker.onmessage = (event) => handleWorkerMessage(event.data || {});
    worker.onerror = () => bootFailed(t('boot.failed'));
  }

  function handleWorkerMessage(msg) {
    if (msg.type === 'status') {
      el.bootStatus.textContent = t(msg.key);
      el.bootBar.style.width = `${Math.round((msg.progress || 0) * 100)}%`;
      return;
    }
    if (msg.type === 'ready') {
      state.ready = true;
      hideBoot();
      updateGo();
      if (el.input.value.trim()) schedulePreview();
      return;
    }
    if (msg.type === 'fatal') {
      bootFailed(msg.detail ? `${t(msg.key)} (${msg.detail})` : t(msg.key));
      return;
    }
    if (msg.type === 'result') {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        // errorKey is the worker's own failure; error comes from the kernel,
        // already in the requested language.
        resolve({ ok: msg.ok, data: msg.data, error: msg.errorKey ? t(msg.errorKey) : msg.error });
      }
    }
  }

  function call(op, args) {
    return new Promise((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      worker.postMessage({ id, op, args, lang: window.NablaI18n.lang });
    });
  }

  function restartWorker(reason) {
    for (const resolve of pending.values()) {
      resolve({ ok: false, error: reason });
    }
    pending.clear();
    if (worker) worker.terminate();
    state.ready = false;
    el.bootStatus.textContent = t('boot.restarting');
    el.bootBar.style.width = '10%';
    startWorker();
  }

  function hideBoot() {
    el.boot.hidden = true;
  }

  function bootFailed(message) {
    el.boot.hidden = false;
    el.boot.classList.add('boot--failed');
    el.bootStatus.textContent = message;
    el.bootBar.style.width = '100%';
  }

  // ----------------------------------------------------------- rendering --

  function tex(target, latex, display) {
    target.innerHTML = '';
    if (!latex) return;
    try {
      katex.render(latex, target, {
        displayMode: !!display,
        throwOnError: false,
        strict: false,
        output: 'html',
      });
    } catch (err) {
      target.textContent = latex;
    }
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function renderChips() {
    el.chips.innerHTML = '';
    for (const name of OP_ORDER) {
      const spec = OPS[name];
      const button = node('button', 'chip', spec.chipKey ? t(spec.chipKey) : spec.chip);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(name === state.op));
      button.addEventListener('click', () => setOp(name));
      el.chips.appendChild(button);
    }
  }

  function renderParams() {
    el.params.innerHTML = '';
    const spec = OPS[state.op];
    const values = state.params[state.op];

    for (const field of spec.fields) {
      const wrap = node('div', 'field');
      const label = node('label', 'field__label', t(field.labelKey));
      wrap.appendChild(label);

      if (field.kind === 'toggle') {
        const group = node('div', 'field__toggle');
        for (const [value, text] of field.options) {
          const button = node('button', null, text.includes('.') ? t(text) : text);
          button.type = 'button';
          button.setAttribute('aria-pressed', String(values[field.name] === value));
          button.addEventListener('click', () => {
            values[field.name] = value;
            renderParams();
          });
          group.appendChild(button);
        }
        wrap.appendChild(group);
      } else if (field.kind === 'check') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!values[field.name];
        box.id = `f-${field.name}`;
        label.setAttribute('for', box.id);
        box.addEventListener('change', () => { values[field.name] = box.checked; });
        wrap.insertBefore(box, label);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        // Variables are no longer just single letters now that the keypad
        // makes `omega` and `theta` a single tap.
        input.className = 'field__input' +
          (field.kind === 'int' ? ' field__input--narrow' : '') +
          (field.kind === 'var' ? ' field__input--var' : '');
        input.value = values[field.name];
        input.id = `f-${field.name}`;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('autocapitalize', 'off');
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.kind === 'int') input.inputMode = 'numeric';
        label.setAttribute('for', input.id);
        input.addEventListener('input', () => {
          values[field.name] = input.value;
          if (field.kind === 'var') state.varTouched[state.op] = true;
        });
        wrap.appendChild(input);
      }
      el.params.appendChild(wrap);
    }
  }

  // ---------------------------------------------------------- math keypad --

  /* Only worth replacing the system keyboard where there is one to replace. */
  function keypadWanted() {
    return matchMedia('(max-width: 619px), (pointer: coarse)').matches;
  }

  function renderKeypad() {
    el.keypadTabs.innerHTML = '';
    el.keypadPages.innerHTML = '';

    for (const page of KEYPAD) {
      const tab = node('button', 'ktab', page.tab);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(page.id === state.keypadPage));
      tab.addEventListener('pointerdown', (event) => event.preventDefault());
      tab.addEventListener('click', () => setKeypadPage(page.id));
      el.keypadTabs.appendChild(tab);

      const grid = node('div', 'kgrid');
      grid.dataset.page = page.id;
      grid.style.setProperty('--cols', String(page.cols));
      grid.hidden = page.id !== state.keypadPage;

      for (const [label, spec] of page.keys) {
        const config = typeof spec === 'string' ? { text: spec } : spec;
        const key = node('button', 'key', config.i18n ? t(label) : label);
        key.type = 'button';
        key.tabIndex = -1;
        if (config.full) key.classList.add('key--full');
        if (config.wide) key.classList.add('key--wide');
        if (config.act === 'enter') key.classList.add('key--go');
        if (config.fn || config.act === 'native') key.classList.add('key--word');

        bindKey(key, () => pressKey(config), config.repeat);
        grid.appendChild(key);
      }
      el.keypadPages.appendChild(grid);
    }
  }

  /* preventDefault on pointerdown keeps focus (and the caret) in the input;
   * without it every tap would blur the field and collapse the keypad. */
  function bindKey(button, run, repeatable) {
    let timer = null;
    let interval = null;

    const stop = () => {
      clearTimeout(timer);
      clearInterval(interval);
      timer = null;
      interval = null;
    };

    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      run();
      if (!repeatable) return;
      timer = setTimeout(() => {
        interval = setInterval(run, 55);
      }, 380);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      button.addEventListener(type, stop);
    }
  }

  /* Letter followed by letter is the ambiguous case: `omega` then `t` gives
   * `omegat`, which split_symbols shreds into six single letters, and `x`
   * then `pi` gives `xpi` rather than x·π. An implicit `*` makes the tap
   * sequence mean what it looks like. A digit before is fine — `2pi` and
   * `2x` already parse as products and read better without the star. */
  function insertName(name) {
    const caret = el.input.selectionStart ?? el.input.value.length;
    const before = el.input.value[caret - 1] || '';
    insertAtCursor((/[A-Za-z]/.test(before) ? '*' : '') + name);
  }

  function pressKey(config) {
    if (config.text != null) {
      if (/^[A-Za-z]/.test(config.text)) insertName(config.text);
      else insertAtCursor(config.text);
      return;
    }
    if (config.fn) {
      insertAtCursor(`${config.fn}()`, config.fn.length + 1);
      return;
    }
    switch (config.act) {
      case 'open':
        insertAtCursor('()', 1);
        break;
      case 'close': {
        // Step over the auto-inserted bracket rather than doubling it.
        const caret = el.input.selectionStart ?? 0;
        if (el.input.value[caret] === ')') moveCaret(1);
        else insertAtCursor(')');
        break;
      }
      case 'left': moveCaret(-1); break;
      case 'right': moveCaret(1); break;
      case 'enter': submit(); break;
      case 'native': setKeyboard('native'); break;
      default: break;
    }
  }

  function moveCaret(delta) {
    const input = el.input;
    const caret = Math.max(0, Math.min(input.value.length, (input.selectionStart ?? 0) + delta));
    input.focus();
    input.setSelectionRange(caret, caret);
  }

  function backspace() {
    const input = el.input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    if (start !== end) input.setRangeText('', start, end, 'end');
    else if (start > 0) input.setRangeText('', start - 1, start, 'end');
    else return;
    input.focus();
    schedulePreview();
  }

  function setKeypadPage(id) {
    state.keypadPage = id;
    try { localStorage.setItem(KEYPAD_PAGE_KEY, id); } catch (err) { /* private mode */ }
    el.keypadTabs.querySelectorAll('.ktab').forEach((tab, index) => {
      tab.setAttribute('aria-selected', String(KEYPAD[index].id === id));
    });
    el.keypadPages.querySelectorAll('.kgrid').forEach((grid) => {
      grid.hidden = grid.dataset.page !== id;
    });
  }

  function setKeypadOpen(open) {
    state.keypadOpen = open;
    el.keypad.classList.toggle('keypad--closed', !open);
    el.kpToggle.innerHTML = open ? '&#9662;' : '&#9652;';
    el.kpToggle.setAttribute('aria-label', t(open ? 'keypad.hide' : 'keypad.show'));
    syncDockHeight();
  }

  /* Whatever is docked at the bottom sets the floor the toast must clear. */
  function syncDockHeight() {
    let height = 0;
    if (!el.keypad.hidden) height = el.keypad.getBoundingClientRect().height;
    else if (!el.kswitch.hidden) height = el.kswitch.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--dock-h', `${Math.round(height)}px`);
  }

  /* 'math' swaps the system keyboard for ours via inputmode="none", which
   * still leaves a real caret and text selection in the field. */
  function setKeyboard(mode) {
    state.keyboard = mode;
    try { localStorage.setItem(KEYBOARD_KEY, mode); } catch (err) { /* private mode */ }
    applyKeyboard();
    el.input.focus();
  }

  function applyKeyboard() {
    const wanted = keypadWanted();
    const math = wanted && state.keyboard === 'math';
    el.input.setAttribute('inputmode', math ? 'none' : 'text');
    el.keypad.hidden = !math;
    el.kswitch.hidden = !(wanted && state.keyboard === 'native');
    syncDockHeight();
  }

  function setOp(name) {
    state.op = name;
    el.input.placeholder = OPS[name].placeholder;
    renderChips();
    renderParams();
    schedulePreview();
  }

  /* caretOffset lands the cursor inside what was inserted — `sin()` wants it
   * between the brackets, not after them. Defaults to the end. */
  function insertAtCursor(text, caretOffset) {
    const input = el.input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + (caretOffset == null ? text.length : caretOffset);
    input.focus();
    input.setSelectionRange(caret, caret);
    schedulePreview();
  }

  // ------------------------------------------------------------- preview --

  let previewTimer = null;
  let previewSeq = 0;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, PREVIEW_DELAY);
  }

  async function runPreview() {
    const source = el.input.value.trim();
    updateGo();
    if (!source) {
      el.preview.innerHTML = '';
      el.preview.classList.remove('preview--stale');
      return;
    }
    if (!state.ready) return;

    const mine = ++previewSeq;
    const result = await call('preview', { source, mode: state.op === 'plot' ? 'plot' : '' });
    if (mine !== previewSeq) return;

    if (result.ok) {
      tex(el.preview, result.data.latex, true);
      el.preview.classList.remove('preview--stale');
      suggestVariable(result.data.symbols);
    } else {
      // Half-typed input is expected — keep the last good render, dimmed.
      el.preview.classList.add('preview--stale');
    }
  }

  function suggestVariable(symbols) {
    if (!symbols || !symbols.length) return;
    if (state.varTouched[state.op]) return;
    const spec = OPS[state.op];
    if (!spec.fields.some((f) => f.kind === 'var')) return;
    const pick = symbols.includes('x') ? 'x' : symbols[0];
    if (state.params[state.op].variable === pick) return;
    state.params[state.op].variable = pick;
    renderParams();
  }

  // ------------------------------------------------------------- compute --

  function coerce(op, params) {
    const out = { ...params };
    if (op === 'derivative') out.order = Number(params.order) || 1;
    if (op === 'solve') out.complex_roots = !!params.complex_roots;
    if (op === 'integral') {
      out.lower = (params.lower || '').trim();
      out.upper = (params.upper || '').trim();
    }
    return out;
  }

  let abortTimer = null;

  function setBusy(on) {
    state.busy = on;
    clearTimeout(abortTimer);
    el.go.dataset.busy = on ? 'true' : 'false';
    if (on) {
      el.go.innerHTML = '&middot;&middot;&middot;';
      el.go.setAttribute('aria-label', t('entry.computing'));
      el.go.disabled = true;
      abortTimer = setTimeout(() => {
        el.go.disabled = false;
        el.go.innerHTML = '&#9632;';
        el.go.setAttribute('aria-label', t('entry.stop'));
        el.go.dataset.abort = 'true';
      }, ABORT_AFTER);
    } else {
      el.go.innerHTML = '&#8594;';
      el.go.setAttribute('aria-label', t('entry.compute'));
      delete el.go.dataset.abort;
      updateGo();
    }
  }

  function updateGo() {
    if (state.busy) return;
    el.go.disabled = !state.ready || !el.input.value.trim();
  }

  async function submit() {
    if (el.go.dataset.abort === 'true') {
      restartWorker(t('toast.stoppedShort'));
      setBusy(false);
      toast(t('toast.stopped'));
      return;
    }
    const source = el.input.value.trim();
    if (!source || !state.ready || state.busy) return;

    const op = state.op;
    const params = { ...state.params[op] };
    setBusy(true);
    const result = await call(op, { source, ...coerce(op, params) });
    setBusy(false);

    addEntry({
      id: `${Date.now().toString(36)}-${(sequence).toString(36)}`,
      op,
      source,
      params,
      at: Date.now(),
      ok: result.ok,
      data: result.data,
      error: result.error,
    });

    // Give the result the screen; tapping the input brings the keypad back.
    setKeypadOpen(false);
  }

  // --------------------------------------------------------------- cards --

  function buildCard(entry) {
    const spec = OPS[entry.op] || { labelKey: entry.op, meta: () => '' };
    const card = node('article', `card${entry.ok ? '' : ' card--error'}`);
    card.dataset.id = entry.id;

    const head = node('div', 'card__head');
    const opName = t(spec.labelKey);
    head.appendChild(node('span', 'card__op', entry.ok ? opName : t('card.failed', opName)));
    head.appendChild(node('span', 'card__meta', safeMeta(spec, entry.params)));
    head.appendChild(node('span', 'card__time', formatTime(entry.at)));
    card.appendChild(head);

    card.appendChild(node('div', 'card__source', entry.source));

    if (!entry.ok) {
      card.appendChild(node('div', 'card__error', entry.error || t('card.genericError')));
      card.appendChild(buildActions(entry, ['edit']));
      return card;
    }

    const data = entry.data;

    if (data.statement && entry.op !== 'plot') {
      const statement = node('div', 'card__statement');
      tex(statement, data.statement, true);
      card.appendChild(statement);
    }

    if (entry.op === 'plot') {
      card.appendChild(buildPlot(entry));
      card.appendChild(buildActions(entry, ['reset', 'edit', 'latex']));
      return card;
    }

    if (entry.op === 'table') {
      card.appendChild(buildTable(entry));
      if (data.truncated) {
        card.appendChild(node('p', 'card__note', t('card.truncated')));
      }
      card.appendChild(buildActions(entry, ['copy', 'edit']));
      return card;
    }

    const plate = node('div', 'card__result');
    if (entry.op === 'solve') {
      const roots = node('div', 'roots');
      for (const root of data.roots) {
        const row = node('div', 'root');
        const math = node('span');
        tex(math, `${texVar(entry.params.variable)} = ${root.latex}`, false);
        row.appendChild(math);
        if (root.approx) row.appendChild(node('span', 'root__approx', `≈ ${root.approx}`));
        roots.appendChild(row);
      }
      plate.appendChild(roots);
    } else {
      tex(plate, data.latex, true);
    }
    card.appendChild(plate);

    if (data.note) card.appendChild(node('p', 'card__note', data.note));
    if (data.hidden_complex) {
      card.appendChild(node('p', 'card__note', t('card.hiddenComplex', data.hidden_complex)));
    }

    if (data.alternates && data.alternates.length) {
      const alts = node('div', 'alts');
      for (const alternate of data.alternates) {
        const row = node('div', 'alt');
        row.appendChild(node('span', 'alt__label', alternate.label));
        const body = node('span', 'alt__body');
        tex(body, alternate.latex, false);
        row.appendChild(body);
        alts.appendChild(row);
      }
      card.appendChild(alts);
    }

    card.appendChild(buildActions(entry, ['copy', 'latex', 'edit']));
    return card;
  }

  function texVar(name) {
    return (name || 'x').length > 1 ? `\\mathrm{${name}}` : (name || 'x');
  }

  function safeMeta(spec, params) {
    try {
      return spec.meta(params || {}) || '';
    } catch (err) {
      return '';
    }
  }

  function buildActions(entry, kinds) {
    const wrap = node('div', 'card__actions');
    const make = (label, handler, className) => {
      const button = node('button', className || 'act', label);
      button.type = 'button';
      button.addEventListener('click', handler);
      wrap.appendChild(button);
    };

    if (kinds.includes('copy')) {
      make(t('act.copy'), () => copy(plainTextOf(entry), t('toast.copied')));
    }
    if (kinds.includes('latex')) {
      make(t('act.latex'), () => copy(entry.data.latex || '', t('toast.latexCopied')));
    }
    if (kinds.includes('reset')) {
      make(t('act.resetView'), () => {
        const chart = charts.get(entry.id);
        if (chart && chart.resetZoom) chart.resetZoom();
      });
    }
    if (kinds.includes('edit')) {
      make(t('act.reuse'), () => {
        state.params[entry.op] = { ...state.params[entry.op], ...entry.params };
        state.varTouched[entry.op] = true;
        setOp(entry.op);
        el.input.value = entry.source;
        el.input.focus();
        runPreview();
      });
    }
    make(t('act.delete'), () => removeEntry(entry.id), 'act act--danger');
    return wrap;
  }

  function plainTextOf(entry) {
    if (!entry.ok) return entry.error || '';
    if (entry.op === 'table') {
      const rows = entry.data.x.map((x, i) => `${fmtNum(x)}\t${fmtNum(entry.data.y[i])}`);
      return [`${entry.data.variable}\tf(${entry.data.variable})`, ...rows].join('\n');
    }
    return entry.data.text || entry.data.latex || '';
  }

  // --------------------------------------------------------------- plots --

  function themeColors() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name) => styles.getPropertyValue(name).trim();
    return {
      series: [read('--s1'), read('--s2'), read('--s3'), read('--s4')],
      grid: read('--grid'),
      faint: read('--ink-faint'),
      rule: read('--rule'),
      ink: read('--ink'),
      paper: read('--raised'),
    };
  }

  function buildPlot(entry) {
    const wrap = node('div');
    const holder = node('div', 'chart');
    const canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    wrap.appendChild(holder);

    const legend = node('div', 'legend');
    const colors = themeColors();
    entry.data.series.forEach((series, index) => {
      const item = node('div', 'legend__item');
      const swatch = node('span', 'legend__swatch');
      swatch.style.background = colors.series[index % colors.series.length];
      item.appendChild(swatch);
      const math = node('span');
      tex(math, series.latex, false);
      item.appendChild(math);
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
    return wrap;
  }

  /* Chart.js measures the canvas's container, so it can only run once the card
   * is actually in the document — hence a separate step after insertion. */
  function mountCard(entry, card) {
    if (!entry.ok || entry.op !== 'plot') return;
    const canvas = card.querySelector('.chart canvas');
    if (!canvas) return;
    try {
      const chart = makeChart(canvas, entry);
      if (chart) charts.set(entry.id, chart);
    } catch (err) {
      const holder = canvas.closest('.chart');
      if (holder) {
        holder.replaceChildren(node('p', 'card__note', t('card.plotFailed')));
      }
    }
  }

  function makeChart(canvas, entry) {
    if (!window.Chart) return null;
    const colors = themeColors();
    const data = entry.data;

    const datasets = data.series.map((series, index) => ({
      label: series.label,
      data: data.x.map((x, i) => ({ x, y: series.y[i] })),
      borderColor: colors.series[index % colors.series.length],
      backgroundColor: colors.series[index % colors.series.length],
      borderWidth: 1.75,
      pointRadius: 0,
      pointHitRadius: 14,
      tension: 0,
      spanGaps: false,
    }));

    const axis = {
      grid: { color: colors.grid, drawTicks: false },
      border: { color: colors.rule },
      ticks: {
        color: colors.faint,
        maxTicksLimit: 7,
        font: { family: 'ui-monospace, Menlo, monospace', size: 10 },
        padding: 6,
      },
    };

    return new Chart(canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'linear', ...axis },
          y: {
            type: 'linear',
            ...axis,
            min: data.y_range ? data.y_range[0] : undefined,
            max: data.y_range ? data.y_range[1] : undefined,
          },
        },
        plugins: {
          legend: { display: false },
          decimation: { enabled: false },
          tooltip: {
            backgroundColor: colors.ink,
            titleColor: colors.paper,
            bodyColor: colors.paper,
            cornerRadius: 3,
            displayColors: true,
            bodyFont: { family: 'ui-monospace, Menlo, monospace', size: 11 },
            titleFont: { family: 'ui-monospace, Menlo, monospace', size: 11 },
            callbacks: {
              title: (items) => `x = ${fmtNum(items[0].parsed.x)}`,
              label: (item) => `${item.dataset.label} = ${fmtNum(item.parsed.y)}`,
            },
          },
          zoom: {
            pan: { enabled: true, mode: 'xy' },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              // Chart.js replaces plugins.zoom.zoom wholesale instead of
              // deep-merging it, so `drag` must be spelled out or the plugin
              // throws reading drag.enabled during start().
              drag: { enabled: false },
              mode: 'xy',
            },
          },
        },
      },
    });
  }

  function restyleCharts() {
    const colors = themeColors();
    for (const chart of charts.values()) {
      chart.data.datasets.forEach((dataset, index) => {
        dataset.borderColor = colors.series[index % colors.series.length];
        dataset.backgroundColor = colors.series[index % colors.series.length];
      });
      for (const key of ['x', 'y']) {
        const scale = chart.options.scales[key];
        scale.grid.color = colors.grid;
        scale.border.color = colors.rule;
        scale.ticks.color = colors.faint;
      }
      const tooltip = chart.options.plugins.tooltip;
      tooltip.backgroundColor = colors.ink;
      tooltip.titleColor = colors.paper;
      tooltip.bodyColor = colors.paper;
      chart.update('none');
    }
    // Swatch index must reset per legend, not run across every card.
    document.querySelectorAll('.legend').forEach((legend) => {
      legend.querySelectorAll('.legend__swatch').forEach((swatch, index) => {
        swatch.style.background = colors.series[index % colors.series.length];
      });
    });
  }

  // --------------------------------------------------------------- table --

  function buildTable(entry) {
    const wrap = node('div', 'vt__wrap');
    const table = node('table', 'vt');
    const head = node('thead');
    const headRow = node('tr');
    headRow.appendChild(node('th', null, entry.data.variable));
    headRow.appendChild(node('th', null, `f(${entry.data.variable})`));
    head.appendChild(headRow);
    table.appendChild(head);

    const body = node('tbody');
    entry.data.x.forEach((x, index) => {
      const row = node('tr');
      row.appendChild(node('td', null, fmtNum(x)));
      const value = entry.data.y[index];
      const cell = node('td', value == null ? 'undef' : null, fmtNum(value));
      row.appendChild(cell);
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  function fmtNum(value) {
    if (value == null || Number.isNaN(value)) return '—';
    if (Object.is(value, -0)) value = 0;
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
    const size = Math.abs(value);
    if (size !== 0 && (size < 1e-4 || size >= 1e7)) return value.toExponential(4);
    return String(Number(value.toPrecision(7)));
  }

  /* Follow the app's language, not the browser's — someone reading the
   * interface in Portuguese expects 30/08/2026, not 8/30/2026. */
  function locale() {
    return window.NablaI18n.lang === 'pt' ? 'pt-BR' : 'en-GB';
  }

  function formatTime(stamp) {
    try {
      return new Date(stamp).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      return '';
    }
  }

  // ------------------------------------------------------------- history --

  function addEntry(entry) {
    state.entries.push(entry);
    if (state.entries.length > MAX_ENTRIES) {
      const dropped = state.entries.shift();
      const card = el.stream.querySelector(`[data-id="${dropped.id}"]`);
      if (card) card.remove();
      disposeChart(dropped.id);
    }
    el.intro.hidden = true;
    const card = buildCard(entry);
    // Newest first: the composer is at the top, so results grow downward
    // away from it. state.entries stays chronological for export.
    el.stream.prepend(card);
    mountCard(entry, card);
    save();
    scrollToNewest();
  }

  function scrollToNewest() {
    el.stream.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* Rebuild the whole stream from state. Cheap at 60 entries, and it keeps
   * deletion and undo from having to reason about insertion positions in a
   * list that is displayed in reverse. */
  function renderAll() {
    for (const id of [...charts.keys()]) disposeChart(id);
    el.stream.querySelectorAll('.card').forEach((card) => card.remove());
    el.intro.hidden = state.entries.length > 0;
    for (const entry of [...state.entries].reverse()) {
      const card = buildCard(entry);
      el.stream.appendChild(card);
      mountCard(entry, card);
    }
  }

  function removeEntry(id) {
    const index = state.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;

    const [removed] = state.entries.splice(index, 1);
    const card = el.stream.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (card) card.remove();
    disposeChart(id);
    if (!state.entries.length) el.intro.hidden = false;
    save();

    toast(t('toast.deleted'), {
      label: t('toast.undo'),
      run: () => {
        state.entries.splice(Math.min(index, state.entries.length), 0, removed);
        save();
        renderAll();
      },
    });
  }

  function disposeChart(id) {
    const chart = charts.get(id);
    if (chart) {
      chart.destroy();
      charts.delete(id);
    }
  }

  function slim(entry) {
    if (!entry.ok || entry.op !== 'plot' || !entry.data || !entry.data.x) return entry;
    const total = entry.data.x.length;
    if (total <= MAX_STORED_POINTS) return entry;
    const stride = Math.ceil(total / MAX_STORED_POINTS);
    const pick = (list) => list.filter((_, index) => index % stride === 0);
    return {
      ...entry,
      data: {
        ...entry.data,
        x: pick(entry.data.x),
        series: entry.data.series.map((series) => ({ ...series, y: pick(series.y) })),
      },
    };
  }

  function save() {
    let payload = state.entries.map(slim);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(payload));
        return;
      } catch (err) {
        // Quota: shed the oldest quarter and try again.
        payload = payload.slice(Math.max(1, Math.floor(payload.length / 4)));
        if (!payload.length) {
          try { localStorage.removeItem(HISTORY_KEY); } catch (ignored) { /* nothing left to do */ }
          return;
        }
      }
    }
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(HISTORY_KEY);
    } catch (err) {
      return;
    }
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!Array.isArray(parsed)) return;

    state.entries = parsed.filter((entry) => entry && entry.id && OPS[entry.op]);
    if (!state.entries.length) return;
    renderAll();
    el.stream.scrollTop = 0;
  }

  function clearHistory() {
    const snapshot = state.entries.slice();
    state.entries = [];
    renderAll();
    try { localStorage.removeItem(HISTORY_KEY); } catch (err) { /* already gone */ }

    toast(t('toast.cleared'), {
      label: t('toast.undo'),
      run: () => {
        state.entries = snapshot;
        save();
        renderAll();
      },
    });
  }

  // -------------------------------------------------------------- export --

  function exportMarkdown() {
    if (!state.entries.length) {
      toast(t('toast.nothingToExport'));
      return;
    }
    const lines = [
      t('export.title'),
      '',
      t('export.exportedAt', new Date().toLocaleString(locale())),
      '',
    ];

    for (const entry of state.entries) {
      const spec = OPS[entry.op];
      lines.push(`## ${t(spec.labelKey)} · ${new Date(entry.at).toLocaleString(locale())}`, '');
      lines.push(`${t('export.input')} \`${entry.source}\`  `);
      const meta = safeMeta(spec, entry.params);
      if (meta) lines.push(`${t('export.settings')} ${meta}  `);
      lines.push('');

      if (!entry.ok) {
        lines.push(`> ${entry.error}`, '');
        continue;
      }
      if (entry.data.statement) lines.push('$$', entry.data.statement, '$$', '');
      if (entry.op === 'table') {
        lines.push(`| ${entry.data.variable} | f(${entry.data.variable}) |`, '| ---: | ---: |');
        entry.data.x.forEach((x, index) => {
          lines.push(`| ${fmtNum(x)} | ${fmtNum(entry.data.y[index])} |`);
        });
        lines.push('');
      } else if (entry.op === 'plot') {
        lines.push(t('export.plotted', entry.params.x_min, entry.params.x_max), '');
      } else {
        lines.push('$$', entry.data.latex, '$$', '');
        if (entry.data.text) lines.push('```', entry.data.text, '```', '');
      }
      for (const alternate of entry.data.alternates || []) {
        lines.push(`- _${alternate.label}_: $${alternate.latex}$`);
      }
      if ((entry.data.alternates || []).length) lines.push('');
    }

    const filename = t('export.filename');
    download(filename, lines.join('\n'));
    toast(t('toast.exported', filename));
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy(text, message) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
      return;
    } catch (err) {
      // Fall through to the legacy path (older iOS, non-secure contexts).
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast(message);
    } catch (err) {
      toast(t('toast.copyFailed'));
    }
    area.remove();
  }

  let toastTimer = null;

  function hideToast() {
    el.toast.classList.remove('toast--on', 'toast--interactive');
  }

  /* `action` turns the toast into an undo affordance; it stays up longer and
   * accepts pointer events, which the plain notice form must not. */
  function toast(message, action) {
    el.toast.replaceChildren(document.createTextNode(message));
    if (action) {
      const button = node('button', 'toast__action', action.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        clearTimeout(toastTimer);
        hideToast();
        action.run();
      });
      el.toast.appendChild(button);
    }
    el.toast.classList.toggle('toast--interactive', !!action);
    el.toast.classList.add('toast--on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6000 : 1900);
  }

  // ------------------------------------------------------------ language --

  /* Fills every element carrying a data-i18n* attribute. The -html variant
   * exists for the few strings with inline <code> markup; they are our own
   * literals from i18n.js, never user input. */
  function applyStaticStrings() {
    document.querySelectorAll('[data-i18n]').forEach((node_) => {
      node_.textContent = t(node_.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((node_) => {
      node_.innerHTML = t(node_.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((node_) => {
      const text = t(node_.dataset.i18nTitle);
      node_.title = text;
      node_.setAttribute('aria-label', text);
    });
    el.input.setAttribute('aria-label', t('entry.placeholder'));
    el.langBtn.textContent = window.NablaI18n.lang === 'pt' ? 'EN' : 'PT';
    el.langBtn.title = t('topbar.lang');
    document.title = 'Nabla';
  }

  function setLanguage(lang) {
    window.NablaI18n.set(lang);
    applyStaticStrings();
    renderChips();
    renderParams();
    renderKeypad();
    setKeypadOpen(state.keypadOpen);
    applyTheme(document.documentElement.dataset.theme);
    el.input.placeholder = OPS[state.op].placeholder;
    // Past results keep the wording they were computed with; only new ones
    // pick up the change. Re-render anyway so captions and buttons update.
    renderAll();
    if (el.input.value.trim()) schedulePreview();
  }

  // --------------------------------------------------------------- theme --

  function readTheme() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (err) { /* private mode */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    el.themeColor.setAttribute('content', theme === 'dark' ? '#0e1420' : '#f4f1ea');
    el.themeBtn.innerHTML = theme === 'dark' ? '&#9681;' : '&#9680;';
    el.themeBtn.title = t(theme === 'dark' ? 'topbar.theme.toLight' : 'topbar.theme.toDark');
    restyleCharts();
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* private mode */ }
    applyTheme(next);
  }

  // ------------------------------------------------------------ viewport --

  function syncViewport() {
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    syncDockHeight();
  }

  // ---------------------------------------------------------------- init --

  function init() {
    if (window.Chart && window.ChartZoom) {
      try { Chart.register(window.ChartZoom); } catch (err) { /* already registered */ }
    }

    applyTheme(readTheme());

    // Manifest shortcuts land on ./index.html?op=plot etc.
    const requested = new URLSearchParams(location.search).get('op');
    if (requested && OPS[requested]) state.op = requested;

    try {
      const savedPage = localStorage.getItem(KEYPAD_PAGE_KEY);
      if (KEYPAD.some((page) => page.id === savedPage)) state.keypadPage = savedPage;
      if (localStorage.getItem(KEYBOARD_KEY) === 'native') state.keyboard = 'native';
    } catch (err) { /* private mode */ }

    applyStaticStrings();
    renderChips();
    renderParams();
    renderKeypad();
    applyKeyboard();
    setKeypadOpen(true);
    el.input.placeholder = OPS[state.op].placeholder;
    load();

    el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    el.input.addEventListener('input', schedulePreview);
    // Both: the keys preventDefault so focus never leaves the field, which
    // means re-tapping it fires no focus event — only a click.
    el.input.addEventListener('focus', () => setKeypadOpen(true));
    el.input.addEventListener('click', () => setKeypadOpen(true));

    bindKey(el.kpBack, backspace, true);
    el.kpToggle.addEventListener('pointerdown', (event) => event.preventDefault());
    el.kpToggle.addEventListener('click', () => setKeypadOpen(!state.keypadOpen));
    el.kswitchBtn.addEventListener('click', () => setKeyboard('math'));
    matchMedia('(max-width: 619px)').addEventListener('change', applyKeyboard);

    el.themeBtn.addEventListener('click', toggleTheme);
    el.langBtn.addEventListener('click', () => {
      setLanguage(window.NablaI18n.lang === 'pt' ? 'en' : 'pt');
    });
    el.exportBtn.addEventListener('click', exportMarkdown);

    el.clearBtn.addEventListener('click', () => {
      if (!state.entries.length) {
        toast(t('toast.alreadyEmpty'));
        return;
      }
      // No longer needs a confirm tap — clearHistory offers undo instead.
      clearHistory();
    });

    syncViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewport);
      window.visualViewport.addEventListener('scroll', syncViewport);
    }
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));

    if (location.protocol === 'file:') {
      bootFailed(t('boot.fileProtocol'));
      return;
    }

    updateGo();
    startWorker();

    const secure = location.protocol === 'https:' ||
      ['localhost', '127.0.0.1'].includes(location.hostname);
    if (secure && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' })
        .catch(() => { /* caching is a bonus, not a requirement */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
