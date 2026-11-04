import pytest
from calc import median


def test_median_odd():
    assert median([5]) == 5
    assert median([3, 1, 2]) == 2
    assert median([9, 1, 8, 2, 7]) == 7


def test_median_even():
    assert median([1, 2, 3, 4]) == 2.5
    assert median([7, 1, 9, 3]) == 5.0


def test_median_empty_raises():
    with pytest.raises(ValueError, match="^cannot compute median of empty list$"):
        median([])


def test_median_has_docstring():
    assert median.__doc__ is not None
    assert len(median.__doc__.strip()) > 0
