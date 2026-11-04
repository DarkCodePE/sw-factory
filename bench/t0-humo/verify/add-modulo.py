import pytest
from calc import modulo


def test_modulo_positive():
    assert modulo(10, 3) == 1
    assert modulo(14, 7) == 0


def test_modulo_negative():
    assert modulo(-7, 3) == 2


def test_modulo_by_zero_raises():
    with pytest.raises(ValueError, match="cannot divide by zero"):
        modulo(10, 0)


def test_modulo_by_float_zero_raises():
    with pytest.raises(ValueError, match="cannot divide by zero"):
        modulo(10, 0.0)


def test_modulo_docstring():
    assert modulo.__doc__ is not None and len(modulo.__doc__.strip()) > 0
