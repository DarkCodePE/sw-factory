import pytest
from calc import subtract


def test_subtract_basic():
    assert subtract(10, 4) == 6
    assert subtract(3, 7) == -4


def test_subtract_floats():
    assert subtract(2.5, 0.5) == 2.0
    assert subtract(-5.0, -5.0) == 0.0


def test_subtract_has_docstring():
    assert subtract.__doc__ is not None
    assert len(subtract.__doc__.strip()) > 0
