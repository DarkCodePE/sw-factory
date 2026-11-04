import math
import pytest
from calc import divide


def test_divide_negative_zero_normalized():
    res = divide(0, -5)
    assert res == 0.0
    assert math.copysign(1.0, res) == 1.0
    assert str(res) != "-0.0"


def test_divide_float_zero_numerator():
    res = divide(0.0, -10.0)
    assert res == 0.0
    assert math.copysign(1.0, res) == 1.0


def test_divide_normal_and_by_zero():
    assert divide(10, 2) == 5.0
    with pytest.raises(ValueError, match="cannot divide by zero"):
        divide(5, 0)
