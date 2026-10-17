from __future__ import annotations

import argparse
import json

MAX_N = 10000


def fibonacci(n: int) -> list[int]:
    if n < 0:
        raise ValueError("N must be a non-negative integer")
    result = []
    a, b = 0, 1
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Print the first N Fibonacci numbers.")
    parser.add_argument("n", type=int, help="how many Fibonacci numbers to print")
    parser.add_argument("--nth", action="store_true", help="print only the last number")
    parser.add_argument("--json", action="store_true", help="print output as JSON")
    args = parser.parse_args(argv)

    if args.n < 0 or args.n > MAX_N:
        parser.error("N must be a non-negative integer (max 10000)")
    if args.nth and args.n == 0:
        parser.error("--nth requires N >= 1")

    seq = fibonacci(args.n)
    if args.json:
        print(json.dumps(seq[-1] if args.nth else seq))
    elif args.nth:
        print(seq[-1])
    else:
        print(" ".join(map(str, seq)))


if __name__ == "__main__":
    main()
