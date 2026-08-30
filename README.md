# Nabla ∇

Symbolic math and plots in a phone-first PWA. Derivatives, integrals, limits,
simplification, solving, plotting and value tables — all typeset with KaTeX, all
computed on-device. No backend, no accounts, no network calls after first load.

## Running it

Any static file server works; a service worker and web workers are involved, so
`file://` will not do.

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

Deploy by copying the directory to any static host (GitHub Pages, Netlify,
Cloudflare Pages). HTTPS is required for the service worker and for
"Add to Home Screen" to behave like a real app.

## The name

The del operator — gradient, divergence, curl. For an electronic engineering
student it is the symbol Maxwell's equations are written in, so it belongs to
the subject rather than decorating it. It also happens to make a good icon: a
mitered outline triangle that still reads at 32px.

## Design notes

**Typeface.** KaTeX ships Computer Modern, Knuth's typeface and the face of
typeset mathematics. Rather than confine it to results, the wordmark, plate
captions, operation chips and field labels are all set in it. It costs nothing
extra — the fonts are already loading for the math — and it means the interface
is set in the same voice as its output. UI body copy uses a system grotesque;
tables and raw input use a monospace so digits align.

**Colour.** Two themes drawn from the same referent rather than one skin and its
inversion. Light is warm paper and ink. Dark is observatory night — a deep
indigo, never black, with starlight-warm off-white text. Both carry a Prussian
blue accent, the ink of blueprints and cyanotype astronomical plates, with a
sodium-lamp amber as the second colour. Because the hue family is shared, the
toggle reads as the same object under a different light.

**Layout.** The composer sits at the top of the page: preview, operation chips,
contextual fields, then the input itself. The input is the composer's last row,
so it sits directly against the newest result — you read straight down from what
you typed to what it produced. Keeping the input away from the bottom edge also
means the on-screen keyboard never covers it.

**History is the scrollback.** Results stack downward from the composer, newest
first, and persist across sessions — so scrolling down *is* browsing history.
That removed an entire navigation concept: no history screen, no tab bar, no
empty-state for a list you have not filled yet. Storage stays chronological, so
the Markdown export still reads oldest to newest.

**Plates.** Results sit on raised stock with crop marks at opposing corners, and
sections are divided by full-bleed hairline rules rather than boxes and shadows.
The reference is a printed plate in a textbook, not a card in a dashboard.

## Architecture

```
index.html            shell, CDN pins, pre-paint theme script
manifest.json         PWA metadata, icons, shortcuts
service-worker.js     network-first shell, cache-first vendor payload
icons/                generated — see tools/make-icons.mjs
src/math.py           SymPy kernel; every op returns JSON, never raises
src/worker.js         Pyodide host
src/app.js            UI, state, history, charts
src/style.css         design tokens and layout
tools/make-icons.mjs  dependency-free PNG icon generator
```

**SymPy runs in a web worker.** A hard `integrate()` can block for seconds; on
the main thread that would freeze scrolling and every control on the page — the
exact clunkiness this replaces. A compute that runs past 2.5 s turns the submit
button into a stop control, which terminates and restarts the worker.

**`math.py` never raises.** `compute()` is the single entry point and always
returns `{ok, data}` or `{ok, error}` with a short human-readable message.
Python tracebacks never reach the interface.

**Parsing is deliberately loose.** `parse_expr` with
`implicit_multiplication_application` and `convert_xor`, so `2x`, `x^2` and
`sin x` all work. Multi-letter names (`theta`, `omega`, …) are predefined so the
symbol splitter does not shred them into products of single letters.

**Plot discontinuities.** Functions are sampled through `lambdify` + NumPy, then
the line is broken wherever a step is far larger than the typical step, so
asymptotes are gaps rather than vertical strokes. The y-range comes from the 1st
and 99th percentiles, so one near-asymptote value cannot flatten the whole
curve.

**Worked steps** are available for derivatives and integrals, collapsed behind
a `steps` toggle on the card, and included in the Markdown export.

Integrals use SymPy's own `integral_steps`, which returns a rule tree mirroring
how a person would integrate — substitution, parts, rewrites, partial fractions
— including the chosen `u` and `dv`. Two things the raw tree gets wrong on the
page and this code fixes: a sub-integral after a substitution is in `u`, so its
differential must be rendered `du` and not `dx`; and SymPy reuses one dummy
symbol at every nesting level, so a nested substitution reads `u = u` unless
each depth is given its own letter.

Derivatives have no equivalent in SymPy, so `_walk_derivative` recurses over the
expression tree emitting the power, product, quotient, chain and constant-
multiple rules. Limits and `simplify` deliberately have no steps: SymPy's limit
algorithm (Gruntz) has no human-readable form, and `simplify` is a heuristic
search rather than a derivation. Inventing plausible-looking steps for either
would be worse than showing none.

**Storage.** History lives in `localStorage`, capped at 60 entries. Plot data is
downsampled to 220 points before writing; on a quota error the oldest quarter is
shed and the write retried.

## Conventions worth knowing

- `ln` is the natural log; `log` is base 10. An explicit second argument still
  wins, so `log(x, 2)` is base 2. Because SymPy's internal natural log is named
  `log`, both printers are overridden to emit `ln` — otherwise an
  antiderivative of `1/x` would display as `log(x)` and read as base 10.
- Constants: `pi`, `e`, `oo` (and `-oo`). Imaginary unit is `I`, not `i` —
  lowercase `i` and `j` stay free as ordinary variables, which matters when
  `i` is a current and `j` is an index.
- Brazilian notation is accepted in either language as aliases: `sen`, `senh`,
  `arcsen`, `arctg`, `cotg`, `cossec`, `tgh`. `tg` is deliberately *not* one of
  them — it would swallow `t*g`, and both are ordinary variables here. Use
  `tan`.
- Equations accept an `=`: `x^2 = 4` and `x^2 - 4` both solve.
- Leave both integral bounds empty for an indefinite integral.
- Plot takes up to four comma-separated functions; commas inside a call like
  `log(x, 2)` are handled.

## Regenerating icons

```sh
node tools/make-icons.mjs
```

Writes `icons/*.png` and `icons/nabla.svg`. No dependencies — it rasterises the
mark by supersampling and writes the PNGs through `zlib`.

## Not in v1

No backend, accounts or cloud sync. No multi-line CAS notebook — this is a
single-question tool. No ads.
