import pytest
from calc import multiply


def test_multiply_basic():
    assert multiply(3, 4) == 12
    assert multiply(-2, 5) == -10


def test_multiply_zero_and_floats():
    assert multiply(0, 100) == 0
    assert multiply(1.5, 2.0) == 3.0


def test_multiply_has_docstring():
    assert multiply.__doc__ is not None
    assert len(multiply.__doc__.strip()) > 0
