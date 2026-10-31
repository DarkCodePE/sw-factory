import pytest

from calc import add, average, divide


def test_add():
    assert add(2, 3) == 5


def test_add_negative():
    assert add(-2, 3) == 1


def test_add_is_commutative():
    assert add(3, 2) == add(2, 3)


def test_divide():
    assert divide(10, 4) == 2.5


def test_divide_by_zero_raises_value_error():
    with pytest.raises(ValueError):
        divide(1, 0)


def test_divide_by_float_zero_raises_value_error():
    with pytest.raises(ValueError):
        divide(1, 0.0)


def test_average_single():
    assert average([4]) == 4
