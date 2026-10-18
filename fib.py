"""Fibonacci sequence generator with a small CLI wrapper."""

from __future__ import annotations

import argparse


def fibonacci(n: int) -> list[int]:
    """Return the first n Fibonacci numbers, starting 0, 1, 1, 2, ..."""
    if n < 0:
        raise ValueError("N must be a non-negative integer")
    seq = []
    a, b = 0, 1
    for _ in range(n):
        seq.append(a)
        a, b = b, a + b
    return seq


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Print Fibonacci numbers.")
    parser.add_argument("n", type=int, help="how many numbers to print")
    parser.add_argument(
        "--nth",
        action="store_true",
        help="print only the Nth number",
    )
    args = parser.parse_args(argv)

    if args.n < 0 or args.n > 10000:
        parser.error("N must be a non-negative integer (max 10000)")

    seq = fibonacci(args.n)

    if args.nth:
        if args.n == 0:
            parser.error("--nth requires N >= 1")
        print(seq[-1])
    elif seq:
        print(" ".join(map(str, seq)))


if __name__ == "__main__":
    main()
