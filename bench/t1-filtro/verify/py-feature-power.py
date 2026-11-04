import pytest
from calc import power


def test_power_positive():
    assert power(2, 3) == 8
    assert power(5, 0) == 1
    assert power(4, 0.5) == 2.0


def test_power_negative_raises():
    with pytest.raises(ValueError, match="^negative exponent not supported$"):
        power(3, -1)


def test_power_has_docstring():
    assert power.__doc__ is not None
    assert len(power.__doc__.strip()) > 0
