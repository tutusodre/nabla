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
from sympy.printing.latex import LatexPrinter
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

# Physical constants: the name this app reads, SymPy's own attribute, and how
# the value prints. They are not in _CONSTANTS because they are not constants
# to the parser — each one reads as an ordinary Symbol, and only a substitute
# turns it into a value (see op_substitute). That is what keeps `c` usable as
# a constant of integration and `g` as a plain variable.
#
# The elementary charge is `q_e`, not `e`: `e` is Euler's number, and taking
# that name would silently change the meaning of every `e^x` already sitting
# in someone's stored history.
#
# The LaTeX column is not decoration. SymPy renders a Quantity as its
# abbreviation inside \text{}, and four of these abbreviate to their own
# snake_case name — `\text{boltzmann_constant}` is a KaTeX parse error, not a
# symbol — while the rest abbreviate to something this app does not call them
# (`me`, and `e` for the elementary charge).
_PHYSICAL = {
    "c": ("speed_of_light", "c"),
    "h": ("planck", "h"),
    "hbar": ("hbar", r"\hbar"),
    "k_B": ("boltzmann_constant", "k_{B}"),
    "G": ("gravitational_constant", "G"),
    "mu_0": ("magnetic_constant", r"\mu_{0}"),
    "epsilon_0": ("vacuum_permittivity", r"\varepsilon_{0}"),
    "N_A": ("avogadro_constant", "N_{A}"),
    "m_e": ("electron_rest_mass", "m_{e}"),
    "q_e": ("elementary_charge", "q_{e}"),
    "g": ("acceleration_due_to_gravity", "g"),
}

# Keyed by SymPy's spelling, which is how a Quantity names itself when asked.
_PHYSICAL_BY_SYMPY = {
    attr: (name, latex) for name, (attr, latex) in _PHYSICAL.items()
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

    # Brazilian notation, accepted in either language. Aliases only — `sin`
    # and `tan` keep working, and results still print in SymPy's spelling.
    # `tg` is deliberately absent: it would capture `t*g`, and t and g are
    # both ordinary variables here. Write `tan`.
    "sen": sp.sin, "senh": sp.sinh, "arcsen": sp.asin,
    "tgh": sp.tanh, "arctg": sp.atan,
    "cotg": sp.cot, "cossec": sp.csc,
}

# Order matters: constants shadow bare symbols, functions shadow both. The
# physical names sit with the bare symbols because that is what they are here —
# `hbar` needs the entry or split_symbols shreds it into h*b*a*r, and the rest
# are ordinary variables until a substitute resolves them.
LOCALS = {}
LOCALS.update(_SYMBOLS)
LOCALS.update({name: sp.Symbol(name) for name in _PHYSICAL})
LOCALS.update(_CONSTANTS)
LOCALS.update(_FUNCTIONS)

_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]*\Z")
_OPENERS = "([{"
_CLOSERS = ")]}"


class MathError(Exception):
    """An error whose message is already safe to show the user.

    The template is kept unformatted so it can be looked up for translation;
    interpolation happens after, in whichever language was picked.
    """

    def __init__(self, template, *values):
        super().__init__(template % values if values else template)
        self.template = template
        self.values = values


# Translations keyed by the English source string, so untranslated messages
# simply fall through to English instead of showing a missing-key marker.
LANGUAGE = "en"

# The last single-expression result, set at the top of compute() from the
# incoming args. Can't live in LOCALS — that dict is built once at import.
LAST_ANS = None

MESSAGES = {
    "pt": {
        "Type an expression first.": "Digite uma expressão primeiro.",
        "Nothing to reuse yet — compute something first.":
            "Nada para reutilizar ainda — calcule algo primeiro.",
        "An equation needs an expression on both sides of `=`.":
            "Uma equação precisa de expressões dos dois lados do `=`.",
        "“%s” isn’t a valid variable name.":
            "“%s” não é um nome de variável válido.",
        "“%s” is a built-in constant or function — pick another variable.":
            "“%s” é uma constante ou função interna — escolha outra variável.",
        "%s must be a plain number.": "%s precisa ser um número.",
        "%s must be finite.": "%s precisa ser finito.",
        "Order must be a whole number.": "A ordem precisa ser um número inteiro.",
        "Order must be between 1 and 10.": "A ordem precisa estar entre 1 e 10.",
        "No closed-form antiderivative for that one.":
            "Essa não tem primitiva em forma fechada.",
        "No closed form, and numeric integration failed.":
            "Sem forma fechada, e a integração numérica falhou.",
        "No closed form — evaluated numerically.":
            "Sem forma fechada — calculada numericamente.",
        "SymPy couldn’t determine that limit.":
            "O SymPy não conseguiu determinar esse limite.",
        "Terms": "Termos",
        "Terms has to be between 1 and 20.": "Termos tem que ser entre 1 e 20.",
        "SymPy couldn’t expand that here — try another point.":
            "O SymPy não conseguiu expandir aqui — tente outro ponto.",
        "without the O term": "sem o termo O",
        "SymPy couldn’t solve that symbolically.":
            "O SymPy não conseguiu resolver isso simbolicamente.",
        "No real solutions — turn on “complex” to see the %d complex root(s).":
            "Sem soluções reais — ative “complexo” para ver %d raiz(es) complexa(s).",
        "No solutions found.": "Nenhuma solução encontrada.",
        "Type at least one function to plot.":
            "Digite pelo menos uma função para traçar.",
        "Four functions at a time is the limit.":
            "O limite é quatro funções por vez.",
        "x-max has to be greater than x-min.":
            "x-máx precisa ser maior que x-mín.",
        "“%s” has more than one variable — plot needs exactly one.":
            "“%s” tem mais de uma variável — o gráfico precisa de exatamente uma.",
        "Couldn’t evaluate “%s” numerically.":
            "Não consegui avaliar “%s” numericamente.",
        "Couldn’t evaluate that function numerically.":
            "Não consegui avaliar essa função numericamente.",
        "Step can’t be zero.": "O passo não pode ser zero.",
        "That step points away from the stop value.":
            "Esse passo se afasta do valor final.",
        "Can’t parse that — check your parentheses and operators.":
            "Não consegui interpretar — confira os parênteses e operadores.",
        "That divides by zero.": "Isso divide por zero.",
        "That expression nests too deeply.":
            "A expressão tem aninhamento demais.",
        "SymPy couldn’t finish that one.":
            "O SymPy não conseguiu terminar essa.",
        "SymPy couldn’t treat that as a polynomial.":
            "O SymPy não conseguiu tratar isso como polinômio.",
        "That needs a concrete value somewhere — try fewer free variables.":
            "Falta um valor concreto em algum lugar — tente com menos variáveis livres.",
        "Couldn’t compute that — %s": "Não consegui calcular — %s",
        "Unknown operation “%s”.": "Operação desconhecida “%s”.",
        "x-min": "x-mín",
        "x-max": "x-máx",
        "Start": "Início",
        "Stop": "Fim",
        "Step": "Passo",
        "simplified": "simplificado",
        "factored": "fatorado",
        "expanded": "expandido",
        "trig form": "forma trig.",
        "combined fraction": "fração única",
        "decimal": "decimal",
        "solve for": "resolver para",
        "Give at least one value, like “x = 2”.": "Dê ao menos um valor, como “x = 2”.",
        "Each value needs an “=”, like “x = 2”.": "Cada valor precisa de um “=”, como “x = 2”.",
        "The left side of “=” has to be a variable name.":
            "O lado esquerdo do “=” tem que ser um nome de variável.",
        "“%s” has no value after the “=”.": "“%s” não tem valor depois do “=”.",
        "“%s” is given a value twice.": "“%s” recebeu valor duas vezes.",
        "Those units don’t match up — %s": "Essas unidades não batem — %s",
        "Those units don’t match up — the terms being added aren’t "
        "the same kind of quantity.":
            "Essas unidades não batem — os termos somados não são o mesmo "
            "tipo de grandeza.",
        "as written": "como escrito",
        # worked-step labels
        "Constant": "Constante",
        "Constant multiple": "Múltiplo constante",
        "Power rule": "Regra da potência",
        "Sum rule": "Regra da soma",
        "Product rule": "Regra do produto",
        "Quotient rule": "Regra do quociente",
        "Chain rule": "Regra da cadeia",
        "Exponential rule": "Regra da exponencial",
        "Standard derivative": "Derivada imediata",
        "The variable itself": "A própria variável",
        "Differentiate": "Derivar",
        "Derivative number %d": "Derivada número %d",
        "Substitution": "Substituição",
        "Integration by parts": "Integração por partes",
        "Integration by parts (cyclic)": "Integração por partes (cíclica)",
        "Exponential": "Exponencial",
        "Reciprocal": "Recíproca",
        "Arctangent form": "Forma arco-tangente",
        "Arcsine form": "Forma arco-seno",
        "Inverse hyperbolic form": "Forma hiperbólica inversa",
        "Rewrite": "Reescrever",
        "Split into cases": "Separar em casos",
        "Trigonometric integral": "Integral trigonométrica",
        "Integral of sine": "Integral do seno",
        "Integral of cosine": "Integral do cosseno",
        "Partial fractions": "Frações parciais",
        "Trigonometric substitution": "Substituição trigonométrica",
        "Quadratic under a root": "Quadrática sob a raiz",
        "Nested power": "Potência aninhada",
        "Heaviside step": "Degrau de Heaviside",
        "find v": "achar v",
        "remaining integral": "integral restante",
    },
}


def _t(text):
    return MESSAGES.get(LANGUAGE, {}).get(text, text)


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------

def _parse(src, extra=None):
    text = (src or "").strip()
    if not text:
        raise MathError("Type an expression first.")
    names = LOCALS if extra is None else {**LOCALS, **extra}
    # Substring test on purpose: it's cheap, and a false positive (a variable
    # named `answer`) only means the binding is present but unused.
    if "ans" in text:
        if LAST_ANS is None:
            raise MathError("Nothing to reuse yet — compute something first.")
        names = {**names, "ans": LAST_ANS}
    expr = sp.sympify(parse_expr(text, local_dict=names, transformations=TRANSFORMS))
    # Units reach every other operation through `ans`, and "mismatched
    # dimensions are an error, not a silent number" is not substitute's promise
    # alone: `ans + 1` on 29.43 m/s has to fail here too.
    #
    # Nothing has built a Quantity until a binding value held a letter or a
    # substitute resolved a constant, so `_quantities_possible()` rules units
    # out cheaply. It rules nothing in — `a = 2c` arms it.
    #
    # The `sp.Expr` guard is not about atoms: a Boolean has those too. It is
    # what keeps Relationals out of the dimension check — `x > 1` is not a
    # quantity and has no factor and dimension to collect — and it also skips
    # the list parse_expr hands back for `[1, 2]`.
    if _quantities_possible() and isinstance(expr, sp.Expr) and _has_units(expr):
        _check_dimensions(expr)
    return expr


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


def _sym(name):
    name = (name or "x").strip() or "x"
    if not _NAME_RE.match(name):
        raise MathError("“%s” isn’t a valid variable name.", name)
    known = LOCALS.get(name)
    if known is not None and not isinstance(known, sp.Symbol):
        raise MathError(
            "“%s” is a built-in constant or function — pick another variable.", name
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
        raise MathError("%s must be a plain number.", _t(label))
    if not np.isfinite(out):
        raise MathError("%s must be finite.", _t(label))
    return out


# --------------------------------------------------------------------------
# units
# --------------------------------------------------------------------------
#
# The expression parser multiplies implicitly and treats m, s, N, K, c and k as
# ordinary variables, which is what makes `2m` and `kx` work at all. Unit names
# would collide with every one of them, so they are layered over LOCALS only
# when a binding's value is read — never when the expression itself is parsed.
#
# Two things below reach past a binding, and deliberately. `_parse_answer`
# layers the long spellings over LOCALS to re-read a stored result, because a
# printed Quantity says "meter" and `ans` has to round-trip. `_check_dimensions`
# runs from `_parse` for every op, because units arriving through `ans` have to
# be checked wherever they land, not only where they were written.

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

# `min` is the one alias that shadows a function rather than a variable, and
# only inside a binding: `t = 90 min` is worth far more there than min(a, b),
# which is still spelled Min(a, b) — and still min() everywhere else.

# Powers of ten, not floats: `1 km` has to stay 1000*meter rather than
# 1000.0*meter and drag a decimal point through every exact result.
_PREFIXES = {
    "T": 12, "G": 9, "M": 6, "k": 3, "d": -1, "c": -2,
    "m": -3, "u": -6, "µ": -6, "μ": -6, "n": -9, "p": -12,
}

# Prefixed spellings are built over the short aliases — "mmeter" is not a word —
# plus the long names people really do prefix. `kohm` is the whole of that
# second list: kHz, mA and km are all written with the alias.
_PREFIXED_LONG = ("ohm",)

# kg already carries its prefix, and nobody writes kmin or mh.
_NO_PREFIX = {"kg", "min", "h"}


def _unit_names():
    """Unit names, aliases and prefixed spellings. Built once, on first use."""
    if _UNIT_CACHE:
        return _UNIT_CACHE

    # Imported here rather than at module scope: boot time is a headline
    # property of this app and most sessions never bind a unit.
    from sympy.physics import units as u

    # No default on the getattr, deliberately. A name SymPy has moved has to
    # fail loudly: a unit that quietly went missing would leave `4.7 kohm` to
    # be shredded into stray symbols and answered with a plausible number.
    base = {name: getattr(u, name) for name in _UNIT_NAMES}
    for alias, name in _UNIT_ALIASES.items():
        base[alias] = base[name]

    prefixed = {}
    for spelling in list(_UNIT_ALIASES) + list(_PREFIXED_LONG):
        if spelling in _NO_PREFIX:
            continue
        for prefix, power in _PREFIXES.items():
            prefixed.setdefault(
                prefix + spelling, sp.Integer(10) ** power * base[spelling]
            )

    _UNIT_CACHE.update(prefixed)
    _UNIT_CACHE.update(base)  # unprefixed wins on any collision
    return _UNIT_CACHE


_PHYSICAL_CACHE = {}


def _physical_names():
    """The physical constants as Quantity objects. Built once, on first use.

    Deliberately a separate table from the unit namespace rather than folded
    into it. `h` is an hour and `g` a gram on the right of a binding — that is
    what `v = 90 km/h` and `m = 500 g` mean — and merging the two dicts would
    quietly redefine both. These names are resolved after parsing instead, on
    the symbols a substitute leaves standing — whether they came from the
    expression or rode in on a binding's value, since `a = 2c` is 2c too.
    """
    if _PHYSICAL_CACHE:
        return _PHYSICAL_CACHE

    # Imported here, not at module scope, for the reason _unit_names gives:
    # boot time is a headline property and most sessions never touch this.
    from sympy.physics import units as u

    # No default on the getattr, deliberately, and the same reason as there: a
    # constant SymPy had moved would otherwise vanish silently, and `m_e*c^2`
    # would come back as a symbolic product that looks like an answer.
    _PHYSICAL_CACHE.update(
        {name: getattr(u, attr) for name, (attr, _) in _PHYSICAL.items()}
    )
    return _PHYSICAL_CACHE


def _quantities_possible():
    """True once anything in this session could have put a Quantity in play.

    Only these two tables ever build one, and neither has run while both are
    empty — so two empty dicts rule units out without importing anything or
    scanning an expression. Non-empty rules nothing in: `a = 2c` fills the unit
    cache with no unit in sight, and the caches stay filled afterwards.
    """
    return bool(_UNIT_CACHE) or bool(_PHYSICAL_CACHE)


# A value with no letter in it cannot name a unit, so `x = 2` skips the unit
# namespace — and the import behind it — entirely.
_HAS_LETTER_RE = re.compile(r"[^\W\d_]")


def _parse_quantity(text):
    """Parse a binding's right-hand side, where unit names are in scope."""
    if not _HAS_LETTER_RE.search(text or ""):
        return _parse(text)
    return _parse(text, extra=_unit_names())


_LONG_UNIT_RE = re.compile(r"\b(?:%s)\b" % "|".join(_UNIT_NAMES))


def _parse_answer(text):
    """Re-read a stored result, which may have carried units out of substitute.

    Only the long spellings are in scope: a printed Quantity always says
    "meter", never "m", so `ans` round-trips without `m` meaning a metre
    anywhere. Left to the ordinary parser, "29.43*meter/second" would be
    shredded into m*e*t*e*r over s*e*c*o*n*d — visible nonsense, but nonsense
    the user never asked for.
    """
    if not _LONG_UNIT_RE.search(text or ""):
        return _parse(text)
    names = _unit_names()
    return _parse(text, extra={name: names[name] for name in _UNIT_NAMES})


# `Dimension(action, A)` carries the dimension's own abbreviation as a second
# argument; only the first is a word the sentence can use, so the rest goes.
_DIMENSION_RE = re.compile(r"Dimension\(([^(),]*)[^()]*\)")

# SymPy names the offending quantity in quotes, in its own spelling.
_QUOTED_NAME_RE = re.compile(r'"([A-Za-z_][A-Za-z0-9_]*)"')


def _unit_mismatch(exc):
    """SymPy's dimension complaint, in this app's spelling.

    Two rewritings. The Dimension(...) wrapping goes, along with the symbol
    SymPy packs beside the dimension's name. And the quantity is renamed:
    SymPy calls it `speed_of_light` and `planck`, but `c` and `h` are what the
    user typed and the only names this app has ever shown them.
    """
    text = _DIMENSION_RE.sub(r"\1", str(exc)).strip().rstrip(".")
    return _QUOTED_NAME_RE.sub(
        lambda m: '"%s"' % _PHYSICAL_BY_SYMPY.get(m.group(1), (m.group(1),))[0],
        text,
    )


def _has_units(expr):
    from sympy.physics.units import Quantity

    return bool(expr.atoms(Quantity))


def _check_dimensions(expr):
    """Raise a MathError when the units in `expr` disagree.

    Catching this is the whole point of the feature: adding a velocity to an
    acceleration has to be an error, not a number that looks plausible.
    """
    from sympy.physics.units.systems.si import SI
    from sympy.physics.units.util import check_dimensions

    if expr.free_symbols:
        # An unbound symbol could carry any dimension, so the strict check
        # below would call `x + 2 m` a mismatch. This one is the lenient
        # version: it only objects when the unit-bearing terms already
        # disagree among themselves. Its message is a dump of Dimension
        # objects, so none of it is worth passing on.
        try:
            check_dimensions(expr)
        except ValueError:
            raise MathError(
                "Those units don’t match up — the terms being added aren’t "
                "the same kind of quantity."
            )
        return

    # Private, and the only API that both checks and explains itself: it names
    # the offending term and both dimensions.
    try:
        SI._collect_factor_and_dimension(expr)
    except ValueError as exc:
        raise MathError("Those units don’t match up — %s", _unit_mismatch(exc))


def _to_si(expr):
    """Fold units together: ohm*ampere -> volt, meter/hour -> meter/second."""
    from sympy.physics.units.systems.si import SI
    from sympy.physics.units.util import quantity_simplify

    try:
        folded = quantity_simplify(expr, across_dimensions=True, unit_system=SI)
    except Exception:
        # Normalising is a courtesy — the substitution already answered the
        # question, and its dimensions were checked before we got here.
        return expr
    return _expand_constants(folded)


# The seven SI base units, which every constant can be written in terms of.
_SI_BASE = ("kilogram", "meter", "second", "ampere", "kelvin", "mole", "candela")


def _expand_constants(expr):
    """Give a constant folding could not name its number, in base units.

    `_to_si` folds a dimension SymPy has an SI unit for — h*f is a joule, and
    that is the form worth showing. It has no unit for what `h` alone measures,
    though, so `h` survives folding untouched and the answer to `h` would be
    `h`. Rewriting the leftovers in kg, m, s, A, K, mol and cd is what turns
    those back into numbers — `N_A * 2 mol` into a count rather than a symbol.
    """
    if not _PHYSICAL_CACHE or not isinstance(expr, sp.Expr):
        return expr

    from sympy.physics.units import Quantity

    left = {q for q in expr.atoms(Quantity) if str(q.name) in _PHYSICAL_BY_SYMPY}
    if not left:
        return expr

    from sympy.physics.units.systems.si import SI
    from sympy.physics.units.util import convert_to

    units = _unit_names()
    try:
        expanded = convert_to(expr, [units[name] for name in _SI_BASE], unit_system=SI)
    except Exception:
        return expr
    # convert_to returns the input unchanged when it cannot do the conversion,
    # and a half-expanded answer is worse than the folded one.
    if not isinstance(expanded, sp.Expr) or expanded.atoms(Quantity) & left:
        return expr
    return expanded


# --------------------------------------------------------------------------
# formatting helpers
# --------------------------------------------------------------------------

def _is_quantity(expr):
    """True for a Quantity, without importing the units module to ask.

    The class name alone is not the test: SymPy's physical constants are a
    Quantity subclass called PhysicalConstant. This sits in front of every node
    the LaTeX printer visits, so it stays a walk over a short tuple of names
    rather than an import at module scope.
    """
    return any(base.__name__ == "Quantity" for base in type(expr).__mro__)


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

    def _print_Quantity(self, expr):
        # Same rule: an answer holding Planck's constant has to copy — and come
        # back through `ans` — as `h`, which this app reads. SymPy calls it
        # `planck`, which is a name in none of these namespaces and would be
        # shredded into a product of six letters on the way back in.
        known = _PHYSICAL_BY_SYMPY.get(str(expr.name))
        return known[0] if known else super()._print_Quantity(expr)


_STR_PRINTER = _NablaStrPrinter()


class _NablaLatexPrinter(LatexPrinter):
    """Prints the physical constants the way this app spells them.

    Quantity carries its own `_latex` method, and the base printer reaches that
    before any `_print_Quantity` a subclass could define — so the intercept has
    to happen in `_print` itself. What it replaces is worth replacing: SymPy
    renders a Quantity as its abbreviation inside \\text{}, so the Boltzmann
    constant comes out as `\\text{boltzmann_constant}`, and an underscore in
    text mode is a KaTeX parse error rather than a subscript.
    """

    def _print(self, expr, **kwargs):
        if _is_quantity(expr):
            known = _PHYSICAL_BY_SYMPY.get(str(expr.name))
            if known:
                return known[1]
        return super()._print(expr, **kwargs)


_LATEX_PRINTER = _NablaLatexPrinter({"ln_notation": True})


def _latex(expr):
    return _LATEX_PRINTER.doprint(expr)


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


def _decimal_alternate(expr):
    """The `decimal` alternate for a result, units included.

    `_approx` refuses anything holding a Quantity — a unit expression is never
    `is_number` — so without this the answers most in need of a decimal are the
    only ones that never get one: `3*kilogram/1000` and `200*meter/(9*second)`
    are exact and unreadable, and the same sums without units offer a decimal.
    The number is rounded and the units put back on.
    """
    plain = _approx(expr)
    if plain is not None:
        if plain == _text(expr):
            return None
        return {"label": _t("decimal"), "latex": plain, "text": plain}

    # Not every result is an ordinary expression: `x > 1` substitutes to a
    # Boolean and a list stays a list, and neither has a coefficient to split
    # off. A Quantity being possible says only that: `a = 2c` arms it with no
    # unit in sight, so it cannot stand in for that test.
    if not _quantities_possible() or not isinstance(expr, sp.Expr) or expr.free_symbols:
        return None

    try:
        coeff, units = expr.as_coeff_Mul()
        # A coefficient of 1 means there was no number out front to round — an
        # unfolded sum of unit terms, say — and an integer one is already exact.
        if coeff == 1 or coeff.is_Integer or not _has_units(units):
            return None
        decimal = _approx(coeff)
        if decimal is None:
            return None
        shown = sp.Float(decimal) * units
        if _text(shown) == _text(expr):
            return None
        return {"label": _t("decimal"), **_fmt(shown)}
    except Exception:
        # An alternate is a courtesy; it never costs the answer itself.
        return None


def _alternate(label, expr, *against):
    """An alternate form, dropped when it matches something already shown."""
    try:
        for other in against:
            if expr == other or sp.srepr(expr) == sp.srepr(other):
                return None
    except Exception:
        return None
    return {"label": _t(label), **_fmt(expr)}


def _symbol_names(expr):
    return sorted(s.name for s in getattr(expr, "free_symbols", set()))


def _finite_list(values):
    out = []
    for value in values:
        number = float(value)
        out.append(None if not np.isfinite(number) else round(number, 10))
    return out


# --------------------------------------------------------------------------
# worked steps
# --------------------------------------------------------------------------

MAX_STEPS = 40

# SymPy names its integration rules by class; these read better than the
# auto-prettified class name. Anything missing falls back to that.
_RULE_LABELS = {
    "ConstantRule": "Constant",
    "ConstantTimesRule": "Constant multiple",
    "PowerRule": "Power rule",
    "AddRule": "Sum rule",
    "URule": "Substitution",
    "USubstitutionRule": "Substitution",
    "PartsRule": "Integration by parts",
    "CyclicPartsRule": "Integration by parts (cyclic)",
    "ExpRule": "Exponential",
    "ReciprocalRule": "Reciprocal",
    "ArctanRule": "Arctangent form",
    "ArcsinRule": "Arcsine form",
    "ArccoshRule": "Inverse hyperbolic form",
    "RewriteRule": "Rewrite",
    "PiecewiseRule": "Split into cases",
    "TrigRule": "Trigonometric integral",
    "SinRule": "Integral of sine",
    "CosRule": "Integral of cosine",
    "SecTanRule": "Trigonometric integral",
    "CscCotRule": "Trigonometric integral",
    "PartialFractionRule": "Partial fractions",
    "HeavisideRule": "Heaviside step",
    "TrigSubstitutionRule": "Trigonometric substitution",
    "SqrtQuadraticRule": "Quadratic under a root",
    "NestedPowRule": "Nested power",
}

_CAMEL_RE = re.compile(r"(?<!^)(?=[A-Z])")


def _rule_label(name):
    known = _RULE_LABELS.get(name)
    if known:
        return known
    stem = name[:-4] if name.endswith("Rule") else name
    return _CAMEL_RE.sub(" ", stem).lower().capitalize()


def _step(out, depth, rule, latex, detail=None):
    out.append({
        "rule": _t(rule),
        "latex": latex,
        "detail": detail,
        "depth": min(depth, 4),
    })


def _child_rules(rule):
    """Any field holding a rule, or a list of them, in field order."""
    import dataclasses

    found = []
    if not dataclasses.is_dataclass(rule):
        return found
    for field in dataclasses.fields(rule):
        value = getattr(rule, field.name, None)
        candidates = value if isinstance(value, (list, tuple)) else [value]
        for item in candidates:
            if dataclasses.is_dataclass(item) and type(item).__name__.endswith("Rule"):
                found.append(item)
    return found


# SymPy reuses one dummy for every substitution, so a nested one reads
# "u = u". Give each depth its own letter instead.
_SUB_NAMES = ("u", "w", "p", "q", "r")


def _walk_integral(rule, var, depth, out, note=None, renames=None, subs_depth=0):
    if rule is None or len(out) >= MAX_STEPS:
        return
    renames = renames or {}

    def shown(expr):
        return expr.subs(renames) if (renames and expr is not None) else expr

    name = type(rule).__name__

    if name == "DontKnowRule":
        return
    if name == "AlternativeRule":
        # SymPy orders alternatives best-first; showing every branch would
        # read as indecision rather than as a method.
        alternatives = getattr(rule, "alternatives", None) or []
        if alternatives:
            _walk_integral(alternatives[0], var, depth, out, note, renames, subs_depth)
        return

    integrand = getattr(rule, "integrand", None)
    latex = (
        _latex(sp.Integral(shown(integrand), shown(var)))
        if integrand is not None else ""
    )

    detail = None
    child_renames = renames
    inner_var = var

    if name in ("URule", "USubstitutionRule"):
        u_func = getattr(rule, "u_func", None)
        u_var = getattr(rule, "u_var", None)
        letter = _SUB_NAMES[min(subs_depth, len(_SUB_NAMES) - 1)]
        if u_func is not None:
            detail = "%s = %s" % (letter, _latex(shown(u_func)))
        if u_var is not None:
            child_renames = dict(renames)
            child_renames[u_var] = sp.Symbol(letter)
            inner_var = u_var
    elif name in ("PartsRule", "CyclicPartsRule"):
        u, dv = getattr(rule, "u", None), getattr(rule, "dv", None)
        if u is not None and dv is not None:
            detail = r"u = %s,\quad dv = %s\,d%s" % (
                _latex(shown(u)), _latex(shown(dv)), _latex(shown(var)),
            )
    elif name == "RewriteRule":
        rewritten = getattr(rule, "rewritten", None)
        if rewritten is not None:
            detail = r"\to %s" % _latex(shown(rewritten))

    _step(out, depth, _rule_label(name), latex, detail or note)

    # After a substitution the sub-integral is in u, so its differential must
    # be du — rendering it as dx would be plainly wrong on the page.
    if name in ("URule", "USubstitutionRule"):
        for child in _child_rules(rule):
            _walk_integral(child, inner_var, depth + 1, out,
                           None, child_renames, subs_depth + 1)
        return

    # Parts produces two sub-integrals with quite different jobs; unlabelled
    # they look like the same step done twice.
    if name in ("PartsRule", "CyclicPartsRule"):
        pairs = (
            (getattr(rule, "v_step", None), r"\text{%s}" % _t("find v")),
            (getattr(rule, "second_step", None), r"\text{%s}" % _t("remaining integral")),
        )
        for child, label in pairs:
            if child is not None:
                _walk_integral(child, var, depth + 1, out, label, renames, subs_depth)
        return

    for child in _child_rules(rule):
        _walk_integral(child, var, depth + 1, out, None, renames, subs_depth)


def _integral_steps(expr, var):
    try:
        from sympy.integrals.manualintegrate import integral_steps
    except Exception:
        return []
    try:
        tree = integral_steps(expr, var)
    except Exception:
        return []
    out = []
    _walk_integral(tree, var, 0, out)
    return out[:MAX_STEPS]


def _diff_step(out, depth, rule, expr, var, detail=None):
    _step(
        out,
        depth,
        rule,
        r"%s = %s" % (
            _latex(sp.Derivative(expr, var)),
            _latex(sp.diff(expr, var)),
        ),
        detail,
    )


def _walk_derivative(expr, var, depth, out):
    """SymPy has no step machinery for diff, but the rules are mechanical."""
    if len(out) >= MAX_STEPS or depth > 4:
        return

    if not expr.has(var):
        _diff_step(out, depth, "Constant", expr, var)
        return
    if expr == var:
        _diff_step(out, depth, "The variable itself", expr, var)
        return

    if isinstance(expr, sp.Add):
        _diff_step(out, depth, "Sum rule", expr, var,
                   r"\text{differentiate each term}")
        for term in expr.args:
            if term.has(var):
                _walk_derivative(term, var, depth + 1, out)
        return

    if isinstance(expr, sp.Mul):
        coeff, rest = expr.as_coeff_Mul()
        if coeff != 1 and rest.has(var):
            _diff_step(out, depth, "Constant multiple", expr, var,
                       r"\text{pull out } %s" % _latex(coeff))
            _walk_derivative(rest, var, depth + 1, out)
            return

        numer, denom = expr.as_numer_denom()
        if denom != 1 and denom.has(var):
            _diff_step(out, depth, "Quotient rule", expr, var,
                       r"\left(\frac{f}{g}\right)' = \frac{f'g - fg'}{g^{2}}")
            for part in (numer, denom):
                if part.has(var):
                    _walk_derivative(part, var, depth + 1, out)
            return

        factors = [f for f in expr.args if f.has(var)]
        if len(factors) > 1:
            _diff_step(out, depth, "Product rule", expr, var,
                       r"(fg)' = f'g + fg'")
            for factor in factors:
                _walk_derivative(factor, var, depth + 1, out)
            return
        if factors:
            _walk_derivative(factors[0], var, depth + 1, out)
            return

    if isinstance(expr, sp.Pow):
        base, exponent = expr.args
        if not exponent.has(var):
            _diff_step(out, depth, "Power rule", expr, var,
                       r"\frac{d}{dx}u^{n} = n\,u^{n-1}u'")
            if base != var:
                _walk_derivative(base, var, depth + 1, out)
            return
        _diff_step(out, depth, "Exponential rule", expr, var,
                   r"\frac{d}{dx}a^{u} = a^{u}\ln a \cdot u'")
        return

    if isinstance(expr, sp.Function) and len(expr.args) == 1:
        inner = expr.args[0]
        label = "Chain rule" if inner != var else "Standard derivative"
        detail = r"\frac{d}{dx}f(u) = f'(u)\,u'" if inner != var else None
        _diff_step(out, depth, label, expr, var, detail)
        if inner != var:
            _walk_derivative(inner, var, depth + 1, out)
        return

    _diff_step(out, depth, "Differentiate", expr, var)


def _derivative_steps(expr, var, order):
    out = []
    try:
        current = expr
        for level in range(order):
            if len(out) >= MAX_STEPS:
                break
            if order > 1:
                _step(
                    out, 0,
                    # Translated first, then interpolated — _t on the result
                    # is a harmless no-op.
                    _t("Derivative number %d") % (level + 1),
                    r"%s = %s" % (
                        _latex(sp.Derivative(current, var)),
                        _latex(sp.diff(current, var)),
                    ),
                    None,
                )
                _walk_derivative(current, var, 1, out)
            else:
                _walk_derivative(current, var, 0, out)
            current = sp.diff(current, var)
    except Exception:
        return out[:MAX_STEPS]
    return out[:MAX_STEPS]


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
        "steps": _derivative_steps(expr, var, order),
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
            "steps": _integral_steps(expr, var),
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
            "note": _t("No closed form — evaluated numerically."),
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

    return {
        "statement": statement,
        "alternates": alternates,
        "steps": _integral_steps(expr, var),
        **_fmt(result),
    }


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


def op_substitute(source="", at=""):
    expr = _parse(source)
    pairs = _bindings(at, parse_value=_parse_quantity)

    # simultaneous keeps `x = y, y = x` a swap rather than a cascade.
    result = expr.subs(pairs, simultaneous=True)

    # A name you bind yourself is yours: `c = 3` means three, not the speed of
    # light. Running after the bindings is what enforces that — a bound name is
    # already gone from the result — and `bound` covers the leftovers, so that
    # `c = 2c` keeps the c the user meant. The statement still shows what was
    # typed, because it is `expr` that is echoed there, not this.
    #
    # The test is a string comparison against names already in hand: an
    # expression with no constant in it never builds the table, let alone
    # imports it.
    bound = {sym.name for sym, _ in pairs}
    if isinstance(result, sp.Basic):
        wanted = {
            sym for sym in result.free_symbols
            if sym.name in _PHYSICAL and sym.name not in bound
        }
        if wanted:
            values = _physical_names()
            result = result.subs({sym: values[sym.name] for sym in wanted})

    # Only these two tables ever build a Quantity, and neither has run while
    # both are empty — so empty rules units out. Full rules nothing in: any
    # binding value holding a letter fills the unit one, units or not.
    has_units = _quantities_possible() and _has_units(result)

    if has_units:
        _check_dimensions(result)
        simplified = _to_si(result)
    else:
        simplified = _try_simplify(result)

    alternates = []
    decimal = _decimal_alternate(simplified)
    if decimal:
        alternates.append(decimal)
    if has_units:
        # The raw substitution, when normalising moved it: 9.4*ampere*ohm
        # beside 9.4*volt says more than either does alone.
        entry = _alternate("as written", result, simplified)
        if entry:
            alternates.append(entry)

    given = r",\; ".join("%s = %s" % (_latex(sym), _latex(val)) for sym, val in pairs)
    return {
        "statement": r"%s,\quad %s" % (_latex(expr), given),
        "alternates": alternates,
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
                "No real solutions — turn on “complex” to see the %d complex root(s).",
                len(complex_),
            )
        raise MathError("No solutions found.")

    return {
        "statement": r"%s,\quad \text{%s } %s" % (
            _latex(equation), _t("solve for"), _latex(var),
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
                "“%s” has more than one variable — plot needs exactly one.", part
            )
        var = free[0] if free else sp.Symbol("x")

        # The cast to float is inside the try, not after it: a unit-bearing
        # `ans` lambdifies fine and only fails here, and outside it that
        # failure escapes as SymPy's own untranslated "Cannot convert
        # expression to float" instead of the message below.
        try:
            fn = sp.lambdify(var, expr, modules=["numpy"])
            with np.errstate(all="ignore"):
                raw = np.asarray(fn(xs))
            if np.iscomplexobj(raw):
                raw = np.where(np.abs(raw.imag) < 1e-9, raw.real, np.nan)
            ys = np.asarray(raw, dtype=float) + np.zeros_like(xs)
        except Exception:
            raise MathError("Couldn’t evaluate “%s” numerically.", part)

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
    # Inside the try for the reason op_plot gives: a unit-bearing `ans` gets
    # this far and fails on the cast, and only here is the message translated.
    try:
        fn = sp.lambdify(var, expr, modules=["numpy"])
        with np.errstate(all="ignore"):
            raw = np.asarray(fn(xs))
        if np.iscomplexobj(raw):
            raw = np.where(np.abs(raw.imag) < 1e-9, raw.real, np.nan)
        ys = np.asarray(raw, dtype=float) + np.zeros_like(xs)
    except Exception:
        raise MathError("Couldn’t evaluate that function numerically.")

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
    "series": op_series,
    "simplify": op_simplify,
    "substitute": op_substitute,
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
        template = _t(exc.template)
        return template % exc.values if exc.values else template
    if isinstance(exc, (SyntaxError, TokenError)):
        return _t("Can’t parse that — check your parentheses and operators.")
    if isinstance(exc, ZeroDivisionError):
        return _t("That divides by zero.")
    if isinstance(exc, RecursionError):
        return _t("That expression nests too deeply.")
    if isinstance(exc, (NotImplementedError, KeyboardInterrupt)):
        return _t("SymPy couldn’t finish that one.")
    if type(exc).__name__ == "PolynomialError":
        return _t("SymPy couldn’t treat that as a polynomial.")
    if isinstance(exc, TypeError) and "cannot determine truth value" in str(exc):
        return _t("That needs a concrete value somewhere — try fewer free variables.")

    detail = (str(exc) or "").strip().splitlines()
    head = detail[0][:140] if detail else type(exc).__name__
    return _t("Couldn’t compute that — %s") % head


def set_language(lang):
    global LANGUAGE
    LANGUAGE = lang if lang in MESSAGES else "en"
    return LANGUAGE


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
        # Parsed inside this try on purpose: a malformed stored answer becomes
        # an ordinary translated error instead of crashing the worker.
        LAST_ANS = _parse_answer(previous) if previous else None
        return json.dumps({"ok": True, "data": handler(**args)})
    except Exception as exc:  # noqa: BLE001 — every failure must reach the user
        return json.dumps({"ok": False, "error": _friendly(exc)})
