import pytest
from calc import power


def test_power_positive():
    assert power(2, 3) == 8
    assert power(3, 2) == 9


def test_power_zero_exponent():
    assert power(5, 0) == 1
    assert power(0, 5) == 0


def test_power_negative_exponent_raises():
    with pytest.raises(ValueError, match="negative exponent not supported"):
        power(2, -1)


def test_power_docstring():
    assert power.__doc__ is not None and len(power.__doc__.strip()) > 0
