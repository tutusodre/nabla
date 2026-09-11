# Ops navigation and value binding

Date: 2026-09-10
Status: approved design, not yet implemented

## Why

Nabla is adding five things: substitute, `ans`, series, units and physical
constants. Four of them are physics-facing; the fifth (`ans`) is ergonomics.

The obstacle is not any one feature — it is that the operation picker is
already over budget. `.chips` is a horizontal scroll strip with no scrollbar
and no edge affordance (`style.css`, `.chips`). Seven chips measure roughly
455px, so on a 390px phone `table` is already off-screen with nothing on screen
to say so. Two more ops would bury `plot` as well.

So the navigation is restructured first, and each feature is then placed where
it costs the least.

## Decisions taken

- **Phone wins.** Where phone and desktop layouts conflict, the phone gets the
  better one and desktop gets the fallback.
- **Ops move into the keypad.** Chips remain as the fallback for when the
  keypad is not on screen.
- **Elementary charge is `q_e`.** `e` stays Euler's number. Silently
  reassigning `e` would break every `e^x` already in someone's history, and
  the collision is the same shape as the documented `tg` decision.
- **Units before constants.** Constants carry units, so they are only fully
  meaningful once units exist.

## Non-goals

- No Laplace transforms and no ODEs. Explicitly deferred.
- No units in the main expression — only on the right-hand side of a binding.
  This is what keeps `m`, `s` and `N` usable as ordinary variables.
- No backend, accounts or sync. Unchanged from v1.
- No redesign of the plates, the stream or the colour system.

---

## 1. Operation navigation

### The op keypad page

A new keypad page, `op`, placed **first** in `KEYPAD` so the tab strip reads
op → 123 → ƒ(x) → names. (The existing `abc` page becomes the names page in
section 6, where it takes on the physical constants alongside its Greek
letters; its tab label changes accordingly.) The default page for a new
install stays the numeric one — the op page is reached through the op label or
its tab, not by opening on top of typing.

Four columns, nine keys in three semantic rows, empty cells left empty rather
than backfilled so the grid teaches the grouping:

```
┌────────┬────────┬────────┬────────┐
│  d/dx  │   ∫    │  lim   │ series │   calculus
├────────┼────────┼────────┼────────┤
│simplify│ solve  │  x = a │        │   algebra
├────────┼────────┼────────┼────────┤
│  plot  │ table  │        │        │   numeric
└────────┴────────┴────────┴────────┘
```

`x = a` is the substitute key: it shows the operation rather than naming it.

The existing key machinery carries this unchanged. Keys already support an
`act` verb (`app.js`, `pressKey`), so an op key is `{ act: 'op', op:
'derivative' }` and `pressKey` gains one `case` that calls the existing
`setOp`. `setOp` already re-renders chips and params and reschedules the
preview, so nothing downstream changes.

### The op label

`.params` gains a leading control showing the current operation. It is a
button: tapping it opens the keypad on the `op` page.

This does two jobs with one element — it says what mode you are in, and it is
the way to change it — so discovering the ops never depends on noticing a tab.
It also gives the params row a constant left-hand anchor instead of the row
appearing and vanishing as ops with no fields are selected.

### The chips fallback

Chips are **not** removed. `renderChips` stays as it is; only its visibility
changes.

The condition is not a width query. `keypadWanted()` is `(max-width: 619px),
(pointer: coarse)`, but `applyKeyboard` also hides the keypad when someone
switches to the phone's own keyboard via `kswitch` — so a phone user can end
up with no keypad, and would then have no ops at all. The rule is:

> chips are visible exactly when the math keypad is hidden

which covers desktop and the native-keyboard path in one condition. It belongs
in `applyKeyboard`, the single function that already knows.

### Result

On a phone the composer loses a permanent row, and all nine ops are visible at
once instead of two being off-screen behind an unmarked swipe.

---

## 2. Substitute

New op. `op_substitute(source="", at="")`.

`at` is one free-text field, placeholder `x = 2, y = 3`. The parsing already
exists: `_split_top(at, ",")` splits top-level commas without breaking
`log(x, 2)`, and `_split_equation` splits each part on `=`.

- Left-hand side must be a bare name — `_NAME_RE` is already there for this.
- Right-hand side is parsed with `_parse`, so bindings may be expressions.
- Applied with `expr.subs(pairs, simultaneous=True)`, so `x = y, y = x` swaps
  rather than cascading.
- Returns the same shape as the other ops: `statement`, `latex`, `text`,
  `approx`, `alternates`.

Errors, all through `MathError` so they arrive as readable text:

| Case | Message |
|---|---|
| `at` empty | Give at least one value, like `x = 2`. |
| No `=` in a part | Each value needs an `=`, like `x = 2`. |
| LHS not a name | The left side of `=` has to be a variable name. |
| Duplicate LHS | `x` is given a value twice. |

A binding for a symbol that does not appear in the expression is allowed and
ignored — it is what happens naturally when you edit an expression and leave a
stale binding behind, and erroring on it would be hostile.

---

## 3. `ans`

`ans` refers to the last successful expression result.

It cannot live in `LOCALS`, which is built once at import. It follows the
pattern `LANGUAGE` already uses: a module-level value set at the top of
`compute()` and consulted by `_parse`.

- `app.js` passes `ans` in the args of every call — the text form
  (`entry.data.text`) of the most recent qualifying entry.
- Qualifying ops: derivative, integral, limit, simplify, substitute, series.
  `solve` is excluded because "the answer" is ambiguous when there are several
  roots; `plot` and `table` are excluded because they are not scalars.
- Using `ans` with nothing available raises `MathError`: "Nothing to reuse
  yet."

Keypad: `ans` takes π's slot on the `123` page, and π moves to the names page
(section 6) alongside the other named constants — where it now belongs
anyway.

---

## 4. Series

New op. `op_series(source="", variable="x", about="0", order="6")`.

`sp.series(expr, var, x0, n)`. The `O(...)` term is kept in the primary
rendering — dropping it silently would misrepresent the result — with the
truncated `removeO()` form offered through the existing `_alternate`
mechanism, the same way simplified forms are already offered elsewhere.

---

## 5. Units

Units are parsed **only** on the right-hand side of a substitute binding. The
main expression parser is untouched, which is what keeps `m`, `s`, `N` and `K`
working as ordinary variables everywhere else.

- `sympy.physics.units`, imported lazily inside the op so boot time does not
  regress. It ships inside SymPy, so no new package is loaded.
- The unit namespace is an explicit allowlist layered over `LOCALS` for the
  duration of parsing one right-hand side — not a star-import — so the names
  in play stay controlled and reviewable.
- Covered: SI base units, common derived units (N, J, W, V, A, Ω, F, H, C, Pa,
  Hz, T), the SI prefixes, and the spellings people actually type (`ohm` and
  `Ω`, `u` and `µ` for micro).
- Output is converted to base SI, with the as-written form offered as an
  alternate.
- A dimension mismatch raises `MathError` like any other failure — the point
  of the feature is that adding a velocity to an acceleration gets caught.

Note that inside a binding the prefix `k` shadows the variable `k` from
`_SYMBOL_NAMES`. That is intended and is confined to binding right-hand sides.

---

## 6. Constants

The existing `abc` page becomes the **names page**: its Greek letters stay,
and the physical constants are appended below them, starting on a fresh row so
the two groups read as separate. At six columns this brings the page to five
rows, matching the height of the numeric page, and it keeps the tab bar at
four tabs.

Named physical quantities, carrying units, added to that page and to the
parser namespace:

`c`, `h`, `hbar`, `k_B`, `G`, `mu_0`, `epsilon_0`, `N_A`, `m_e`, `q_e`, `g`

They are `Quantity` objects, so they stay symbolic — `c` prints as `c` — until
a substitute or units evaluation resolves them. This is consistent with the
rule that the main expression never carries units: a constant in an expression
is just a named symbol until something asks for its value.

`q_e` is the elementary charge. `e` remains Euler's number. Both go in the
README conventions list next to the existing `I` and `tg` notes.

---

## 7. Card actions — pending

Thin each card's action row to `steps` and `reuse`, folding copy, latex and
delete behind the card. The buttons are already deliberately quiet (10px,
`--ink-faint`, transparent border until hover), so this is about repetition
across sixty cards rather than loudness. Delete already has undo, so it loses
nothing by being one level down.

**Not yet approved.** Separable from everything above; do it last or not at
all.

---

## Build order

1. Op navigation — keypad page, op label, chips fallback
2. Substitute, without units
3. `ans`
4. Series
5. Units, inside substitute
6. Constants
7. Card actions (only if approved)

Each step is shippable on its own. The navigation goes first because it is
what makes room for steps 2 and 4; units go before constants because
constants carry units.

## Testing

The repo has no test framework and no dependencies, and should keep both
properties. Verification is a dependency-free smoke runner in `tools/`, in the
same spirit as `tools/make-icons.mjs`: it drives headless Chrome over the
DevTools protocol using only Node built-ins, loads the real app, and asserts
against it. A prototype of this already ran successfully against the service
worker changes, so the approach is known to work.

Each step above adds its assertions to that runner:

- boot reaches ready; no console errors
- every op reachable from the keypad page, and from the chips with the keypad
  hidden
- substitute: a binding, a multi-variable binding, each error case
- `ans`: chains from a previous result; errors when there is none
- series: expansion with the O-term present
- units: a correct conversion, and a dimension mismatch that is caught
- constants: a constant resolves to a value with the right dimension

`math.py` is not unit-tested directly: SymPy is only present inside Pyodide,
so testing it standalone would mean a local Python environment the project
otherwise does not need.

## Risks

| Risk | Mitigation |
|---|---|
| `sympy.physics.units` import cost inside Pyodide | Lazy import inside the op; measure before and after, and report the delta |
| Units interact badly with implicit multiplication | Confined to binding right-hand sides, where a unit namespace shadowing variables is the intent |
| Five keypad tabs would crowd the tab bar | Avoided: constants join the names page rather than taking a tab of their own |
| A stored history entry from a new op fails to re-render on an older build | `load()` already filters entries to known ops, so unknown ops are dropped rather than throwing |
