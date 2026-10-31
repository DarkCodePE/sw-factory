"""Tiny calculator and statistics helpers."""


def add(a, b):
    return a + b


def divide(a, b):
    """Divide a by b. Raises ValueError when b is zero."""
    if b == 0:
        raise ValueError("cannot divide by zero")
    return a / b


def average(values):
    """Arithmetic mean of a non-empty list."""
    return sum(values) / len(values)
