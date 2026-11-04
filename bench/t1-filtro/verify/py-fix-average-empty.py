import pytest
from calc import average


def test_average_non_empty():
    assert average([10]) == 10
    assert average([2, 4, 6]) == 4.0


def test_average_empty_raises_value_error():
    with pytest.raises(ValueError, match="^cannot compute average of empty list$"):
        average([])
