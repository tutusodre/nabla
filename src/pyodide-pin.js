/* The Pyodide pin, in one place.
 *
 * The compute worker requests this build; the service worker warms the cache
 * for it. Two copies of the version string would drift silently — the cache
 * would hold a build nothing asks for and offline boots would stop working —
 * so both importScripts() this instead. Both are classic workers, so they can.
 *
 * Moving this version invalidates the warmed copy: bump VENDOR_VERSION in
 * service-worker.js in the same commit.
 */

self.PYODIDE_VERSION = 'v0.26.4';
self.PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${self.PYODIDE_VERSION}/full/`;
