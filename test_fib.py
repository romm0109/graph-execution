import contextlib
import io
import unittest

from fib import fibonacci, main


class TestFib(unittest.TestCase):
    def run_main(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            main(argv)
        return buf.getvalue().strip()

    def test_fibonacci(self):
        self.assertEqual(fibonacci(0), [])
        self.assertEqual(fibonacci(1), [0])
        self.assertEqual(fibonacci(2), [0, 1])
        self.assertEqual(fibonacci(10), [0, 1, 1, 2, 3, 5, 8, 13, 21, 34])

    def test_negative(self):
        with self.assertRaises(ValueError):
            fibonacci(-1)

    def test_cli(self):
        self.assertEqual(self.run_main(["5"]), "0 1 1 2 3")
        self.assertEqual(self.run_main(["5", "--nth"]), "3")

    def test_cli_negative(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                main(["-1"])
        self.assertEqual(cm.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
