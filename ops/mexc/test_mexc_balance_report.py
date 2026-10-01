#!/usr/bin/env python3
"""Offline report boundary tests; fake data only, no runtime/network access."""
import ast
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest

PATH = Path(__file__).with_name("mexc-balance-report.py")
SPEC = importlib.util.spec_from_file_location("mexc_report", PATH)
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)
SECRET_MARKER = "FAKE_PRIVATE_API_KEY_DO_NOT_PRINT"


def success():
    return {"schema": 1, "venue": "mexc", "scope": "spot", "authenticatedRead": True,
            "checkedAt": "2026-09-21T12:34:56Z", "totalAssets": 3, "zeroAssets": 1,
            "balances": [
                {"currency": "USDT", "free": "12.123456789012345678901234567890",
                 "locked": "0.000000000000000000000000000001", "available": None},
                {"currency": "ETH", "free": "0", "locked": "0", "available": "0.100"},
            ]}


def failure(code="authentication-failed"):
    return {"schema": 1, "venue": "mexc", "scope": "spot", "authenticatedRead": False, "error": code}


class ReportTests(unittest.TestCase):
    def rejects(self, value, decoder=False):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(report.ReportError) as caught:
                (report.decode_report if decoder else report.validate_report)(value)
        self.assertEqual(str(caught.exception), "report-rejected")
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn(SECRET_MARKER, str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)

    def test_python36_syntax_and_no_runtime_imports(self):
        tree = ast.parse(PATH.read_text(), feature_version=(3, 6))
        imports = {node.names[0].name for node in ast.walk(tree) if isinstance(node, ast.Import)}
        self.assertEqual(imports, {"datetime", "json", "re"})

    def test_success_preserves_decimal_strings_and_detaches_projection(self):
        original = success()
        result = report.validate_report(original)
        self.assertEqual(result, original)
        self.assertIsNot(result, original)
        self.assertIsNot(result["balances"], original["balances"])
        self.assertIsNot(result["balances"][0], original["balances"][0])
        result["balances"][0]["free"] = "0"
        self.assertEqual(original["balances"][0]["free"], "12.123456789012345678901234567890")
        self.assertEqual(report.decode_report(json.dumps(original).encode()), original)

    def test_all_probe_fixed_error_codes_and_exact_vocabulary(self):
        probe_tree = ast.parse(PATH.with_name("mexc-balance-probe.py").read_text())
        assignment = next(node for node in probe_tree.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == "ERRORS" for target in node.targets))
        self.assertEqual(report.ERRORS, frozenset(ast.literal_eval(assignment.value.args[0])))
        for code in report.ERRORS:
            self.assertEqual(report.decode_report(json.dumps(failure(code)).encode()), failure(code))
        for code in [SECRET_MARKER, "unknown", None, 1, [], "operation-failed", "bridge-failed"]:
            self.rejects(failure(code))

    def test_unknown_fields_rejected_at_every_boundary(self):
        for value in [success(), failure()]:
            for name in ["apiKey", "secret", "message", "url", "headers", "broker", "temporaryBindingRemoved"]:
                self.rejects({**value, name: SECRET_MARKER})
        value = success()
        value["balances"][0]["private"] = SECRET_MARKER
        self.rejects(value)
        self.rejects({**failure(), "balances": []})
        self.rejects({**success(), "error": "probe-failed"})

    def test_exact_status_flags_and_schema_types(self):
        for field, values in {"schema": [True, 1.0, "1", 2, None], "venue": ["MEXC", "okx", None],
                              "scope": ["funding", None], "authenticatedRead": [1, 0, "true", None]}.items():
            for value in values:
                self.rejects({**success(), field: value})
        for value in [None, [], "object", 1, {}]:
            self.rejects(value)
        for field in success():
            value = success()
            del value[field]
            self.rejects(value)

    def test_valid_utc_calendar_time_only(self):
        for value in ["2026-02-30T12:34:56Z", "2026-09-21T25:34:56Z", "2026-09-21T12:34:60Z",
                      "2026-09-21T12:34:56+00:00", "2026-09-21T12:34:56.000Z",
                      "2026-9-21T12:34:56Z", "2026-09-21T12:34:56Z\n", SECRET_MARKER, None]:
            self.rejects({**success(), "checkedAt": value})

    def test_counts_and_filtered_nonzero_rows_consistent(self):
        for field in ["totalAssets", "zeroAssets"]:
            for value in [True, 1.0, "1", -1, 5001, None]:
                self.rejects({**success(), field: value})
        for total, zero in [(0, 0), (3, 0), (3, 4), (3, 3), (2, 1)]:
            self.rejects({**success(), "totalAssets": total, "zeroAssets": zero})
        self.assertEqual(report.validate_report({**success(), "totalAssets": 0, "zeroAssets": 0, "balances": []})["balances"], [])
        self.assertEqual(report.validate_report({**success(), "totalAssets": 5000, "zeroAssets": 5000, "balances": []})["zeroAssets"], 5000)
        self.rejects({**success(), "balances": {}})
        value = success()
        value["balances"][0] = {"currency": "USDT", "free": "0.000", "locked": "0", "available": None}
        self.rejects(value)

    def test_currency_and_amounts_guard(self):
        for currency in ["", "usdt", "US DT", "A" * 33, "USDT\n", None, SECRET_MARKER + "!"]:
            value = success()
            value["balances"][0]["currency"] = currency
            self.rejects(value)
        value = success()
        value["balances"][1]["currency"] = "USDT"
        self.rejects(value)
        for field in ["free", "locked", "available"]:
            for amount in [True, 1, 0.5, "1e-8", "-1", "+1", "01", "0.", "1\n", "9" * 31, "0." + "1" * 31, SECRET_MARKER]:
                value = success()
                value["balances"][0][field] = amount
                self.rejects(value)
            value = success()
            del value["balances"][0][field]
            self.rejects(value)
        for field in ["free", "locked"]:
            value = success()
            value["balances"][0][field] = None
            self.rejects(value)

    def test_json_parser_limits_duplicates_and_nonfinite(self):
        payload = json.dumps(success()).encode()
        fixtures = [b"", b"x" * (report.MAX_REPORT_BYTES + 1), b"\xff", b"[]", b"null",
                    b"{", payload.decode(), bytearray(payload),
                    b'{"schema":1,"schema":1}', b'{"private":NaN}',
                    b'{"private":Infinity}', b'{"private":-Infinity}',
                    payload + b"{}", payload.replace(b'"free":', b'"free":"0","free":', 1)]
        for value in fixtures:
            self.rejects(value, decoder=True)

    def test_projection_handles_max_assets_without_numeric_conversion(self):
        rows = [{"currency": "A" + str(index), "free": "1", "locked": "0", "available": None}
                for index in range(5000)]
        value = {**success(), "totalAssets": 5000, "zeroAssets": 0, "balances": rows}
        self.assertEqual(len(report.validate_report(value)["balances"]), 5000)


if __name__ == "__main__":
    unittest.main()
