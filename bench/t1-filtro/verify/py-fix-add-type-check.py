import pytest
from calc import add


def test_add_valid_numbers():
    assert add(5, 3) == 8
    assert add(2.5, 1.5) == 4.0
    assert add(-1, 10) == 9


def test_add_rejects_bools():
    with pytest.raises(TypeError, match="^operands must be int or float$"):
        add(True, 1)
    with pytest.raises(TypeError, match="^operands must be int or float$"):
        add(0, False)


def test_add_rejects_strings_and_none():
    with pytest.raises(TypeError, match="^operands must be int or float$"):
        add("5", 3)
    with pytest.raises(TypeError, match="^operands must be int or float$"):
        add(1, "2")
    with pytest.raises(TypeError, match="^operands must be int or float$"):
        add(None, 1)
