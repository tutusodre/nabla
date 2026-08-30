/* Nabla — Pyodide host.
 *
 * SymPy runs here, never on the main thread: a hard integrate() can block for
 * seconds and would otherwise freeze scrolling, the theme toggle, everything.
 */

const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

importScripts(`${PYODIDE_BASE}pyodide.js`);

let compute = null;

function post(message) {
  self.postMessage(message);
}

async function boot() {
  post({ type: 'status', progress: 0.05, text: 'Fetching Python runtime' });
  const pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });

  post({ type: 'status', progress: 0.35, text: 'Loading SymPy and NumPy' });
  await pyodide.loadPackage(['sympy', 'numpy']);

  post({ type: 'status', progress: 0.85, text: 'Starting math kernel' });
  const source = await (await fetch('./math.py')).text();
  pyodide.runPython(source);
  compute = pyodide.globals.get('compute');

  post({ type: 'status', progress: 1, text: 'Ready' });
  post({ type: 'ready' });
}

boot().catch((err) => {
  post({
    type: 'fatal',
    error: `Couldn't start the math engine — ${err && err.message ? err.message : err}`,
  });
});

self.onmessage = (event) => {
  const { id, op, args } = event.data || {};
  if (!compute) {
    post({ id, type: 'result', ok: false, error: 'The math engine is still starting.' });
    return;
  }
  try {
    const raw = compute(op, JSON.stringify(args || {}));
    const payload = JSON.parse(raw);
    post({ id, type: 'result', ok: payload.ok, data: payload.data, error: payload.error });
  } catch (err) {
    post({ id, type: 'result', ok: false, error: 'The math engine hit an unexpected problem.' });
  }
};
