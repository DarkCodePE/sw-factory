import math
import pytest
from calc import divide


def test_divide_zero_by_negative():
    result = divide(0, -5)
    assert result == 0.0
    assert math.copysign(1.0, result) == 1.0, f"Expected +0.0, got {result} with sign {math.copysign(1.0, result)}"


def test_divide_zero_by_negative_one():
    result = divide(0, -1)
    assert result == 0.0
    assert math.copysign(1.0, result) == 1.0


def test_divide_zero_by_positive():
    result = divide(0, 5)
    assert result == 0.0
    assert math.copysign(1.0, result) == 1.0


def test_divide_still_validates_zero():
    with pytest.raises(ValueError, match="cannot divide by zero"):
        divide(1, 0)
    with pytest.raises(ValueError, match="cannot divide by zero"):
        divide(0, 0)
