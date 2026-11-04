import pytest
from calc import average


def test_average_generator():
    gen = (x * 2 for x in [1, 2, 3])
    assert average(gen) == 4.0


def test_average_tuple_and_iterator():
    assert average((10, 20, 30)) == 20.0
    assert average(iter([5, 15])) == 10.0


def test_average_empty_generator():
    with pytest.raises(ValueError, match="^cannot compute average of empty list$"):
        average(x for x in [])
