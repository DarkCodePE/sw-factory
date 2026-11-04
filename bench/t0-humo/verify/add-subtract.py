import pytest
from calc import subtract


def test_subtract_positive():
    assert subtract(10, 4) == 6


def test_subtract_negative():
    assert subtract(4, 10) == -6


def test_subtract_zeros():
    assert subtract(0, 0) == 0


def test_subtract_negative_operands():
    assert subtract(-5, -3) == -2


def test_subtract_docstring():
    assert subtract.__doc__ is not None and len(subtract.__doc__.strip()) > 0
