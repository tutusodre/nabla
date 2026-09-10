/* Nabla — Pyodide host.
 *
 * SymPy runs here, never on the main thread: a hard integrate() can block for
 * seconds and would otherwise freeze scrolling, the theme toggle, everything.
 */

/* Sets self.PYODIDE_BASE — shared with the service worker so the URL fetched
 * here and the URL warmed there cannot drift apart. */
importScripts('./pyodide-pin.js');
importScripts(`${self.PYODIDE_BASE}pyodide.js`);

let compute = null;
let language = 'en';

function post(message) {
  self.postMessage(message);
}

async function boot() {
  post({ type: 'status', progress: 0.05, key: 'boot.runtime' });
  const pyodide = await loadPyodide({ indexURL: self.PYODIDE_BASE });

  post({ type: 'status', progress: 0.35, key: 'boot.packages' });
  await pyodide.loadPackage(['sympy', 'numpy']);

  post({ type: 'status', progress: 0.85, key: 'boot.kernel' });
  const source = await (await fetch('./math.py')).text();
  pyodide.runPython(source);
  compute = pyodide.globals.get('compute');

  post({ type: 'status', progress: 1, key: 'boot.ready' });
  post({ type: 'ready' });
}

boot().catch((err) => {
  post({
    type: 'fatal',
    key: 'boot.failed',
    detail: err && err.message ? err.message : String(err),
  });
});

self.onmessage = (event) => {
  const { id, op, args, lang } = event.data || {};
  if (lang) language = lang;
  if (!compute) {
    post({ id, type: 'result', ok: false, errorKey: 'boot.starting' });
    return;
  }
  try {
    // The kernel formats its own messages, so it needs the language too.
    const raw = compute(op, JSON.stringify(args || {}), language);
    const payload = JSON.parse(raw);
    post({ id, type: 'result', ok: payload.ok, data: payload.data, error: payload.error });
  } catch (err) {
    post({ id, type: 'result', ok: false, errorKey: 'boot.crashed' });
  }
};
