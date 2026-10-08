"""Calculations inside ``${…}`` variables.

``${sensor.battery * 2}`` or ``${round(sensor.battery / 10) * 10}``: numbers,
variables, ``+ - * / %``, brackets and ``round``/``min``/``max``/``abs``. Pure -- no Home Assistant
imports -- so ``const`` can import it without a cycle; the panel asks for its
answers (``lizaip_config/resolve_variables``) rather than mirroring it. States are read through *lookup*, ``hass.states.get``.
"""
from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Final

#: ``${sensor.x * 2 + 1}``, ``${(sensor.a + sensor.b) / 2}``,
#: ``${round(sensor.x / 10) * 10}`` -- a calculation: numbers, variables, the
#: operators ``+ - * / %`` (``%`` is the remainder), brackets, and ``round``,
#: ``min``, ``max`` and ``abs``.
#: A token is one when it holds an operator or
#: a bracket; ``${sensor.x}`` and ``${_state}`` hold neither. Group 1 is the
#: expression, which `function_token_value` evaluates. Matched before
#: ``ENTITY_TOKEN_RE``, which cannot match such a token anyway.
FUNCTION_TOKEN_RE = re.compile(r"\$\{\s*([^{}$]*[-+*/%(][^{}$]*?)\s*\}")

#: Every variable named inside a function expression.
_EXPR_ENTITY_RE = re.compile(
    r"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?"
)
_EXPR_TOKEN_RE = re.compile(
    r"\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+){1,2})"
    r"|([A-Za-z_]\w*)(?=\s*\()|([-+*/%(),]))"
)

#: Per remote: whether its ``${…}`` variables are read at all. Off, every
#: entity variable and calculation reads as nothing, so it drops out of a
#: tooltip and an image with one falls back to its derived icon.
CONF_VARIABLES_ENABLED: Final = "variables_enabled"
DEFAULT_VARIABLES_ENABLED: Final = True

#: Per remote: the shortest gap, in milliseconds, between two pushes of a
#: value that keeps changing. The first change after a quiet spell always goes
#: out at once; this only paces a burst, such as a lamp being dimmed.
CONF_VARIABLES_INTERVAL: Final = "variables_interval_ms"
DEFAULT_VARIABLES_INTERVAL: Final = 500
VARIABLES_INTERVAL_MIN: Final = 100
VARIABLES_INTERVAL_MAX: Final = 5000
VARIABLES_INTERVAL_STEP: Final = 100

#: The remote being worked for has variables switched on. The substitution
#: helpers are called from deep inside page building and live pushes, where
#: the config entry is long out of reach; the few places that start that work
#: for one remote set this with `variables_scope` instead.
_VARIABLES_ENABLED: ContextVar[bool] = ContextVar("lizaip_variables_enabled", default=True)


def read_variables_enabled(options: object) -> bool:
    """Whether an entry's ``options`` keep variables on. Only a real False turns them off."""
    get = getattr(options, "get", None)
    if get is None:
        return DEFAULT_VARIABLES_ENABLED
    return get(CONF_VARIABLES_ENABLED) is not False


def read_variables_interval(options: object) -> int:
    """An entry's variable update interval in ms; a damaged value reads as the default."""
    get = getattr(options, "get", None)
    value = get(CONF_VARIABLES_INTERVAL) if get is not None else None
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULT_VARIABLES_INTERVAL
    return min(max(value, VARIABLES_INTERVAL_MIN), VARIABLES_INTERVAL_MAX)


def variables_enabled() -> bool:
    """Whether the remote this code is working for reads its variables."""
    return _VARIABLES_ENABLED.get()


@contextmanager
def variables_scope(options: Mapping | object | None) -> Iterator[None]:
    """Read variables as the entry with *options* has them set, inside the block."""
    token = _VARIABLES_ENABLED.set(read_variables_enabled(options))
    try:
        yield
    finally:
        _VARIABLES_ENABLED.reset(token)


def _format_number(value: float) -> str:
    if not math.isfinite(value):
        return ""
    if value.is_integer():
        return str(int(value))
    return f"{value:.6f}".rstrip("0").rstrip(".")


#: Name -> (fewest, most) arguments.
_FUNCTION_ARITY: Final = {
    "round": (1, 2), "min": (2, 20), "max": (2, 20), "abs": (1, 1),
}
#: ``round(X, N)`` keeps at most this many decimals, as many as a result prints.
_MAX_DECIMALS: Final = 6


def _apply_function(func: str, args: list[float]) -> float:
    low, high = _FUNCTION_ARITY[func]
    if not low <= len(args) <= high:
        raise ValueError(func)
    if func == "min":
        return min(args)
    if func == "max":
        return max(args)
    if func == "abs":
        return abs(args[0])
    # round(): half away from zero, as people round (2.5 -> 3, -2.5 -> -3),
    # not Python's half-to-even; through Decimal so 2.675 is not read as
    # 2.67499999.
    digits = args[1] if len(args) == 2 else 0
    if not float(digits).is_integer() or not 0 <= digits <= _MAX_DECIMALS:
        raise ValueError(func)
    step = Decimal(1).scaleb(-int(digits))
    return float(Decimal(repr(args[0])).quantize(step, rounding=ROUND_HALF_UP))


class _Calculation:
    """Evaluates ``a + b * (c - 1)``, variables and function calls included.

    Precedence is the usual one: ``* / %`` bind tighter than ``+ -``, and a
    leading ``-`` negates. Anything that is not a number -- a missing or
    non-numeric variable, a division by zero, bad syntax -- raises ValueError.
    """

    def __init__(self, lookup: Callable[[str], Any] | None, text: str) -> None:
        self._lookup = lookup
        self._tokens = []
        pos = 0
        text = text.rstrip()
        while pos < len(text):
            m = _EXPR_TOKEN_RE.match(text, pos)
            if not m:
                raise ValueError(text)
            number, entity, func, punct = m.groups()
            if number is not None:
                self._tokens.append(("num", float(number)))
            elif entity:
                self._tokens.append(("var", entity))
            elif func:
                self._tokens.append(("fn", func.lower()))
            else:
                self._tokens.append(("op", punct))
            pos = m.end()
        self._at = 0

    def _peek(self):
        return self._tokens[self._at] if self._at < len(self._tokens) else (None, None)

    def _take(self, op: str | None = None):
        kind, value = self._peek()
        if kind is None or (op is not None and (kind != "op" or value != op)):
            raise ValueError(op)
        self._at += 1
        return kind, value

    def value(self) -> float:
        result = self._sum()
        if self._at != len(self._tokens):
            raise ValueError("trailing")
        return result

    def _sum(self) -> float:
        total = self._product()
        while self._peek() in (("op", "+"), ("op", "-")):
            op = self._take()[1]
            rhs = self._product()
            total = total + rhs if op == "+" else total - rhs
        return total

    def _product(self) -> float:
        total = self._unary()
        while self._peek() in (("op", "*"), ("op", "/"), ("op", "%")):
            op = self._take()[1]
            rhs = self._unary()
            if op == "*":
                total *= rhs
            elif op == "/":
                total /= rhs
            else:
                total %= rhs
        return total

    def _unary(self) -> float:
        if self._peek() == ("op", "-"):
            self._take()
            return -self._unary()
        if self._peek() == ("op", "+"):
            self._take()
            return self._unary()
        return self._primary()

    def _primary(self) -> float:
        kind, value = self._take()
        if kind == "num":
            return value
        if kind == "var":
            return self._variable(value)
        if kind == "op" and value == "(":
            inner = self._sum()
            self._take(")")
            return inner
        if kind == "fn":
            if value not in _FUNCTION_ARITY:
                raise ValueError(value)
            self._take("(")
            args = [self._sum()]
            while self._peek() == ("op", ","):
                self._take()
                args.append(self._sum())
            self._take(")")
            return _apply_function(value, args)
        raise ValueError(value)

    def _variable(self, name: str) -> float:
        parts = name.lower().split(".")
        entity, attribute = ".".join(parts[:2]), (parts[2] if len(parts) == 3 else None)
        state = self._lookup(entity) if self._lookup is not None else None
        if state is None:
            raise ValueError(entity)
        raw = (state.attributes or {}).get(attribute) if attribute else state.state
        if isinstance(raw, bool):
            raise TypeError(entity)
        return float(raw)


def function_token_value(lookup: Callable[[str], Any] | None, expression: str) -> str:
    """What ``${expression}`` reads right now, e.g. ``sensor.x * 2`` or ``round(sensor.x)``.

    The numbers are taken without their unit and the result is a bare number.
    A value that is not a number, a wrong number of arguments, or a division by
    zero reads as nothing, so the token collapses away like any other.
    """
    try:
        value = _Calculation(lookup, expression).value()
    except (ValueError, TypeError, ZeroDivisionError, OverflowError, RecursionError):
        return ""
    return _format_number(value)
