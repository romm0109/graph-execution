import contextlib
import io
import unittest

from fib import fibonacci, main


class FibonacciFunctionTests(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(fibonacci(0), [])

    def test_one(self):
        self.assertEqual(fibonacci(1), [0])

    def test_two(self):
        self.assertEqual(fibonacci(2), [0, 1])

    def test_ten(self):
        self.assertEqual(fibonacci(10), [0, 1, 1, 2, 3, 5, 8, 13, 21, 34])

    def test_negative_raises(self):
        with self.assertRaises(ValueError):
            fibonacci(-1)


class CliTests(unittest.TestCase):
    def run_main(self, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            main(argv)
        return out.getvalue()

    def test_prints_sequence(self):
        self.assertEqual(self.run_main(["5"]), "0 1 1 2 3\n")

    def test_zero_prints_nothing(self):
        self.assertEqual(self.run_main(["0"]), "")

    def test_nth_prints_last(self):
        self.assertEqual(self.run_main(["5", "--nth"]), "3\n")

    def assert_exits_with_code_2(self, argv):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as ctx:
                self.run_main(argv)
        self.assertEqual(ctx.exception.code, 2)

    def test_negative_exits(self):
        self.assert_exits_with_code_2(["-1"])

    def test_non_integer_exits(self):
        self.assert_exits_with_code_2(["abc"])

    def test_above_cap_exits(self):
        self.assert_exits_with_code_2(["10001"])

    def test_nth_zero_exits(self):
        self.assert_exits_with_code_2(["0", "--nth"])


if __name__ == "__main__":
    unittest.main()
