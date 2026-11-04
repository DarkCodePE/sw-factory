import pytest
import calc
from calc import divide, safe_divide


def test_error_constant_exported_and_correct():
    assert hasattr(calc, "ERROR_DIVIDE_BY_ZERO"), "ERROR_DIVIDE_BY_ZERO must be exported"
    assert calc.ERROR_DIVIDE_BY_ZERO == "cannot divide by zero"


def test_divide_uses_constant():
    with pytest.raises(ValueError) as excinfo:
        divide(5, 0)
    assert str(excinfo.value) == calc.ERROR_DIVIDE_BY_ZERO


def test_safe_divide_normal():
    assert safe_divide(10, 2) == 5.0
    assert safe_divide(9, 3) == 3.0


def test_safe_divide_on_zero():
    assert safe_divide(10, 0) is None
    assert safe_divide(10, 0.0) is None
    assert safe_divide(10, 0, default=0.0) == 0.0
    assert safe_divide(10, 0, default="error") == "error"


def test_safe_divide_docstring():
    assert safe_divide.__doc__ is not None and len(safe_divide.__doc__.strip()) > 0
