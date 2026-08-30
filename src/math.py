"""Nabla — symbolic math kernel.

Runs inside Pyodide, driven by src/worker.js. Every public operation returns a
JSON-serialisable dict; `compute()` is the single entry point and never raises,
never leaks a Python traceback.
"""

import json
import re

import numpy as np
import sympy as sp
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)
from sympy.printing.str import StrPrinter

TRANSFORMS = standard_transformations + (
    implicit_multiplication_application,
    convert_xor,
)

# Multi-letter names must live in the namespace or `split_symbols` will shred
# them into products of single letters (theta -> t*h*e*t*a).
_SYMBOL_NAMES = (
    "x y z t u v w s r n m k a b c d p q "
    "alpha beta theta phi psi omega lamda mu nu rho sigma tau delta epsilon"
).split()

_SYMBOLS = {name: sp.Symbol(name) for name in _SYMBOL_NAMES}

_CONSTANTS = {
    "pi": sp.pi,
    "PI": sp.pi,
    "e": sp.E,
    "E": sp.E,
    "oo": sp.oo,
    "inf": sp.oo,
    "infty": sp.oo,
    "infinity": sp.oo,
    "I": sp.I,
    "nan": sp.nan,
}

def _log_base10(value, base=None):
    """`log` means base 10 here; `ln` is the natural log.

    An explicit second argument still wins, so log(x, 2) is base 2.
    """
    return sp.log(value, 10 if base is None else base)


_FUNCTIONS = {
    "sin": sp.sin, "cos": sp.cos, "tan": sp.tan,
    "cot": sp.cot, "sec": sp.sec, "csc": sp.csc,
    "asin": sp.asin, "acos": sp.acos, "atan": sp.atan, "atan2": sp.atan2,
    "arcsin": sp.asin, "arccos": sp.acos, "arctan": sp.atan,
    "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh,
    "asinh": sp.asinh, "acosh": sp.acosh, "atanh": sp.atanh,
    "exp": sp.exp, "ln": sp.log, "log": _log_base10,
    "log10": lambda a: sp.log(a, 10), "log2": lambda a: sp.log(a, 2),
    "sqrt": sp.sqrt, "cbrt": sp.cbrt, "root": sp.root,
    "abs": sp.Abs, "Abs": sp.Abs, "sign": sp.sign,
    "floor": sp.floor, "ceil": sp.ceiling, "ceiling": sp.ceiling,
    "factorial": sp.factorial, "gamma": sp.gamma, "erf": sp.erf,
    "min": sp.Min, "max": sp.Max, "Min": sp.Min, "Max": sp.Max,
    "conjugate": sp.conjugate, "re": sp.re, "im": sp.im, "arg": sp.arg,
}

# Order matters: constants shadow bare symbols, functions shadow both.
LOCALS = {}
LOCALS.update(_SYMBOLS)
LOCALS.update(_CONSTANTS)
LOCALS.update(_FUNCTIONS)

_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*\Z")
_OPENERS = "([{"
_CLOSERS = ")]}"


class MathError(Exception):
    """An error whose message is already safe to show the user."""


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------

def _parse(src):
    text = (src or "").strip()
    if not text:
        raise MathError("Type an expression first.")
    expr = parse_expr(text, local_dict=LOCALS, transformations=TRANSFORMS)
    return sp.sympify(expr)


def _split_top(text, sep=","):
    """Split on `sep` only at bracket depth zero."""
    parts, depth, current = [], 0, []
    for ch in text:
        if ch in _OPENERS:
            depth += 1
        elif ch in _CLOSERS:
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def _split_equation(text):
    """Find a top-level `=` that isn't part of ==, <=, >= or !=."""
    depth = 0
    for i, ch in enumerate(text):
        if ch in _OPENERS:
            depth += 1
        elif ch in _CLOSERS:
            depth -= 1
        elif ch == "=" and depth == 0:
            before = text[i - 1] if i else ""
            after = text[i + 1] if i + 1 < len(text) else ""
            if before in "<>!=" or after == "=":
                continue
            return text[:i], text[i + 1:]
    return None


def _parse_equation(src):
    """Parse into an Eq when the user typed one, otherwise a bare expression."""
    halves = _split_equation((src or "").strip())
    if halves:
        left, right = halves
        if not left.strip() or not right.strip():
            raise MathError("An equation needs an expression on both sides of `=`.")
        return sp.Eq(_parse(left), _parse(right))
    return _parse(src)


def _sym(name):
    name = (name or "x").strip() or "x"
    if not _NAME_RE.match(name):
        raise MathError("“%s” isn’t a valid variable name." % name)
    known = LOCALS.get(name)
    if known is not None and not isinstance(known, sp.Symbol):
        raise MathError(
            "“%s” is a built-in constant or function — pick another variable." % name
        )
    return known if known is not None else sp.Symbol(name)


def _parse_point(src):
    """Parse a bound / limit point, allowing oo and symbolic values."""
    return _parse(src)


def _parse_float(src, label):
    value = _parse(src)
    try:
        out = float(sp.N(value))
    except (TypeError, ValueError):
        raise MathError("%s must be a plain number." % label)
    if not np.isfinite(out):
        raise MathError("%s must be finite." % label)
    return out


# --------------------------------------------------------------------------
# formatting helpers
# --------------------------------------------------------------------------

class _NablaStrPrinter(StrPrinter):
    """SymPy's internal natural log is `log`; here `log` means base 10.

    Left alone, an antiderivative of 1/x would print as `log(x)` and read as a
    base-10 log to anyone using this app. Both printers must say `ln`.
    """

    def _print_log(self, expr):
        return "ln(%s)" % self.stringify(expr.args, ", ")

    def _print_Exp1(self, expr):
        # Copied text should paste back into this app's own input syntax.
        return "e"


_STR_PRINTER = _NablaStrPrinter()


def _latex(expr):
    return sp.latex(expr, ln_notation=True)


def _text(expr):
    return _STR_PRINTER.doprint(expr)


def _fmt(expr):
    return {"latex": _latex(expr), "text": _text(expr)}


def _try_simplify(expr):
    try:
        if sp.count_ops(expr) > 250:
            return expr
        return sp.simplify(expr)
    except Exception:
        return expr


def _trim_zeros(text):
    """1.00000000000 -> 1, 0.500000000000 -> 0.5, 1.20000000000e-5 -> 1.2e-5."""
    text = re.sub(r"(\d\.\d*?)0+(?![0-9])", r"\1", text)
    return re.sub(r"(\d)\.(?![0-9])", r"\1", text)


def _approx(expr, digits=12):
    """Decimal approximation, or None when the value isn't a finite number."""
    try:
        if getattr(expr, "free_symbols", set()):
            return None
        value = sp.N(expr, digits)
        if value.has(sp.oo, sp.zoo, sp.nan) or not value.is_number:
            return None
        return _trim_zeros(_text(value))
    except Exception:
        return None


def _alternate(label, expr, *against):
    """An alternate form, dropped when it matches something already shown."""
    try:
        for other in against:
            if expr == other or sp.srepr(expr) == sp.srepr(other):
                return None
    except Exception:
        return None
    return {"label": label, **_fmt(expr)}


def _symbol_names(expr):
    return sorted(s.name for s in getattr(expr, "free_symbols", set()))


def _finite_list(values):
    out = []
    for value in values:
        number = float(value)
        out.append(None if not np.isfinite(number) else round(number, 10))
    return out


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------

def op_preview(source="", mode=""):
    # A comma-separated plot list is several expressions, not a tuple.
    if mode == "plot":
        parts = _split_top(source)
        if len(parts) > 1:
            exprs = [_parse(p) for p in parts]
            names = sorted({s.name for e in exprs for s in e.free_symbols})
            return {
                "latex": r",\quad ".join(_latex(e) for e in exprs),
                "symbols": names,
            }

    expr = _parse_equation(source)
    return {"latex": _latex(expr), "symbols": _symbol_names(expr)}


def op_derivative(source="", variable="x", order=1):
    expr = _parse(source)
    var = _sym(variable)
    try:
        order = int(order)
    except (TypeError, ValueError):
        raise MathError("Order must be a whole number.")
    if not 1 <= order <= 10:
        raise MathError("Order must be between 1 and 10.")

    result = sp.diff(expr, var, order)
    simplified = _try_simplify(result)

    alternates = []
    entry = _alternate("simplified", simplified, result)
    if entry:
        alternates.append(entry)
    try:
        factored = sp.factor(simplified)
        entry = _alternate("factored", factored, result, simplified)
        if entry:
            alternates.append(entry)
    except Exception:
        pass

    return {
        "statement": _latex(sp.Derivative(expr, (var, order))),
        "alternates": alternates,
        **_fmt(result),
    }


def op_integral(source="", variable="x", lower=None, upper=None):
    expr = _parse(source)
    var = _sym(variable)
    definite = bool((lower or "").strip()) and bool((upper or "").strip())

    if not definite:
        result = sp.integrate(expr, var)
        if result.has(sp.Integral):
            raise MathError("No closed-form antiderivative for that one.")
        constant = sp.Symbol("C")
        return {
            "statement": _latex(sp.Integral(expr, var)),
            "latex": _latex(result + constant),
            "text": _text(result) + " + C",
            "alternates": [],
        }

    low, high = _parse_point(lower), _parse_point(upper)
    result = sp.integrate(expr, (var, low, high))
    statement = _latex(sp.Integral(expr, (var, low, high)))

    if result.has(sp.Integral):
        try:
            numeric = sp.N(sp.Integral(expr, (var, low, high)), 12)
        except Exception:
            raise MathError("No closed form, and numeric integration failed.")
        return {
            "statement": statement,
            "latex": _latex(numeric),
            "text": _text(numeric),
            "note": "No closed form — evaluated numerically.",
            "alternates": [],
        }

    simplified = _try_simplify(result)
    alternates = []
    entry = _alternate("simplified", simplified, result)
    if entry:
        alternates.append(entry)
    decimal = _approx(simplified)
    if decimal and decimal != _text(simplified):
        alternates.append({"label": "decimal", "latex": decimal, "text": decimal})

    return {"statement": statement, "alternates": alternates, **_fmt(result)}


def op_limit(source="", variable="x", point="0", direction="+-"):
    expr = _parse(source)
    var = _sym(variable)
    target = _parse_point(point)
    if direction not in ("+", "-", "+-"):
        direction = "+-"

    result = sp.limit(expr, var, target, dir=direction)
    if result.has(sp.Limit):
        raise MathError("SymPy couldn’t determine that limit.")

    arrow = {"+": "^+", "-": "^-", "+-": ""}[direction]
    statement = r"\lim_{%s \to %s%s} %s" % (
        _latex(var), _latex(target), arrow, _latex(expr),
    )

    alternates = []
    decimal = _approx(result)
    if decimal and decimal != _text(result):
        alternates.append({"label": "decimal", "latex": decimal, "text": decimal})

    return {"statement": statement, "alternates": alternates, **_fmt(result)}


def op_simplify(source=""):
    expr = _parse_equation(source)
    simplified = _try_simplify(expr)

    alternates = []
    for label, fn in (
        ("expanded", sp.expand),
        ("factored", sp.factor),
        ("trig form", sp.trigsimp),
        ("combined fraction", sp.together),
    ):
        try:
            candidate = fn(simplified)
        except Exception:
            continue
        entry = _alternate(label, candidate, expr, simplified)
        if entry:
            alternates.append(entry)

    decimal = _approx(simplified)
    if decimal and decimal != _text(simplified):
        alternates.insert(0, {"label": "decimal", "latex": decimal, "text": decimal})

    return {
        "statement": _latex(expr),
        "alternates": alternates[:4],
        **_fmt(simplified),
    }


def op_solve(source="", variable="x", complex_roots=False):
    parsed = _parse_equation(source)
    var = _sym(variable)
    equation = parsed if isinstance(parsed, sp.Eq) else sp.Eq(parsed, 0)

    try:
        roots = sp.solve(equation, var, dict=False)
    except NotImplementedError:
        raise MathError("SymPy couldn’t solve that symbolically.")

    if isinstance(roots, dict):
        roots = [roots.get(var)]
    if not isinstance(roots, (list, tuple)):
        roots = [roots]
    roots = [r for r in roots if r is not None]

    real, complex_ = [], []
    for root in roots:
        root = _try_simplify(root)
        entry = {**_fmt(root), "approx": _approx(root)}
        if root.is_real is False:
            complex_.append(entry)
        else:
            real.append(entry)

    shown = real + (complex_ if complex_roots else [])
    if not shown:
        if complex_ and not complex_roots:
            raise MathError(
                "No real solutions — turn on “complex” to see the %d complex root(s)."
                % len(complex_)
            )
        raise MathError("No solutions found.")

    return {
        "statement": r"%s,\quad \text{solve for } %s" % (
            _latex(equation), _latex(var),
        ),
        "roots": shown,
        "hidden_complex": len(complex_) if not complex_roots else 0,
        "latex": r",\; ".join(
            "%s = %s" % (_latex(var), r["latex"]) for r in shown
        ),
        "text": ", ".join("%s = %s" % (var.name, r["text"]) for r in shown),
        "alternates": [],
    }


def op_plot(source="", x_min="-10", x_max="10", samples=700):
    parts = _split_top(source)
    if not parts:
        raise MathError("Type at least one function to plot.")
    if len(parts) > 4:
        raise MathError("Four functions at a time is the limit.")

    low = _parse_float(x_min, "x-min")
    high = _parse_float(x_max, "x-max")
    if high <= low:
        raise MathError("x-max has to be greater than x-min.")

    count = int(samples)
    xs = np.linspace(low, high, count)
    series, pool = [], []

    for part in parts:
        expr = _parse(part)
        free = sorted(expr.free_symbols, key=lambda s: s.name)
        if len(free) > 1:
            raise MathError(
                "“%s” has more than one variable — plot needs exactly one." % part
            )
        var = free[0] if free else sp.Symbol("x")

        try:
            fn = sp.lambdify(var, expr, modules=["numpy"])
            with np.errstate(all="ignore"):
                raw = np.asarray(fn(xs))
        except Exception:
            raise MathError("Couldn’t evaluate “%s” numerically." % part)

        if np.iscomplexobj(raw):
            raw = np.where(np.abs(raw.imag) < 1e-9, raw.real, np.nan)
        ys = np.asarray(raw, dtype=float) + np.zeros_like(xs)

        # Break the line at jump discontinuities so asymptotes aren't drawn as
        # vertical strokes. A jump is a step far larger than the typical step.
        steps = np.abs(np.diff(ys))
        finite_steps = steps[np.isfinite(steps)]
        if finite_steps.size:
            typical = np.median(finite_steps)
            if typical > 0:
                ys[1:][steps > typical * 40] = np.nan

        finite = ys[np.isfinite(ys)]
        if finite.size:
            pool.append(finite)

        series.append({
            "label": part,
            "latex": _latex(expr),
            "y": _finite_list(ys),
        })

    if pool:
        stacked = np.concatenate(pool)
        low_y, high_y = np.percentile(stacked, [1.0, 99.0])
        if high_y <= low_y:
            low_y, high_y = float(stacked.min()), float(stacked.max())
        if high_y <= low_y:
            low_y, high_y = low_y - 1.0, high_y + 1.0
        pad = (high_y - low_y) * 0.12
        y_range = [round(low_y - pad, 6), round(high_y + pad, 6)]
    else:
        y_range = None

    return {
        "statement": r",\quad ".join(s["latex"] for s in series),
        "x": _finite_list(xs),
        "series": series,
        "y_range": y_range,
        "latex": r",\quad ".join(s["latex"] for s in series),
        "text": source,
        "alternates": [],
    }


def op_table(source="", variable="x", start="-5", stop="5", step="1"):
    expr = _parse(source)
    var = _sym(variable)
    begin = _parse_float(start, "Start")
    end = _parse_float(stop, "Stop")
    increment = _parse_float(step, "Step")

    if increment == 0:
        raise MathError("Step can’t be zero.")
    if (end - begin) / increment < 0:
        raise MathError("That step points away from the stop value.")

    total = int(np.floor(abs((end - begin) / increment) + 1e-9)) + 1
    truncated = total > 400
    total = min(total, 400)

    xs = begin + increment * np.arange(total)
    try:
        fn = sp.lambdify(var, expr, modules=["numpy"])
        with np.errstate(all="ignore"):
            raw = np.asarray(fn(xs))
    except Exception:
        raise MathError("Couldn’t evaluate that function numerically.")

    if np.iscomplexobj(raw):
        raw = np.where(np.abs(raw.imag) < 1e-9, raw.real, np.nan)
    ys = np.asarray(raw, dtype=float) + np.zeros_like(xs)

    return {
        "statement": r"%s(%s) = %s" % ("f", _latex(var), _latex(expr)),
        "variable": var.name,
        "x": _finite_list(xs),
        "y": _finite_list(ys),
        "truncated": truncated,
        "latex": _latex(expr),
        "text": _text(expr),
        "alternates": [],
    }


OPERATIONS = {
    "preview": op_preview,
    "derivative": op_derivative,
    "integral": op_integral,
    "limit": op_limit,
    "simplify": op_simplify,
    "solve": op_solve,
    "plot": op_plot,
    "table": op_table,
}


# --------------------------------------------------------------------------
# error translation + entry point
# --------------------------------------------------------------------------

def _friendly(exc):
    from tokenize import TokenError

    if isinstance(exc, MathError):
        return str(exc)
    if isinstance(exc, (SyntaxError, TokenError)):
        return "Can’t parse that — check your parentheses and operators."
    if isinstance(exc, ZeroDivisionError):
        return "That divides by zero."
    if isinstance(exc, RecursionError):
        return "That expression nests too deeply."
    if isinstance(exc, (NotImplementedError, KeyboardInterrupt)):
        return "SymPy couldn’t finish that one."
    if type(exc).__name__ == "PolynomialError":
        return "SymPy couldn’t treat that as a polynomial."
    if isinstance(exc, TypeError) and "cannot determine truth value" in str(exc):
        return "That needs a concrete value somewhere — try fewer free variables."

    detail = (str(exc) or "").strip().splitlines()
    head = detail[0][:140] if detail else type(exc).__name__
    return "Couldn’t compute that — %s" % head


def compute(op, args_json):
    """Single entry point. Always returns a JSON string, never raises."""
    try:
        handler = OPERATIONS[op]
    except KeyError:
        return json.dumps({"ok": False, "error": "Unknown operation “%s”." % op})

    try:
        args = json.loads(args_json) if args_json else {}
        return json.dumps({"ok": True, "data": handler(**args)})
    except Exception as exc:  # noqa: BLE001 — every failure must reach the user
        return json.dumps({"ok": False, "error": _friendly(exc)})
