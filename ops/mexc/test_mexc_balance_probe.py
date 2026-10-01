#!/usr/bin/env python3
"""Offline tests only; no network, registry, vault or real credentials."""
import ast
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import ssl
import subprocess
import sys
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request

PATH = Path(__file__).with_name("mexc-balance-probe.py")
SPEC = importlib.util.spec_from_file_location("mexc_probe", PATH)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
KEY, SECRET = "fake_access_key_123456", "fake_secret_key_654321"
PAIR = {"apiKey": KEY, "apiSecret": SECRET}
BUNDLE = {"schema": 1, "venue": "mexc", "environment": "mainnet", "region": "global", **PAIR}


def account(rows=None):
    return {"accountType": "SPOT", "canTrade": True, "canWithdraw": True,
            "balances": rows if rows is not None else [
                {"asset": "USDT", "free": "12.123456789012345678901234567890", "locked": "0.000000000000000000000000000001"},
                {"asset": "BTC", "free": "0.00000000", "locked": "0"},
                {"asset": "ETH", "free": "0", "locked": "0", "available": "0.100"},
            ]}


class Response:
    def __init__(self, payload=None, raw=None, headers=None, status=200):
        self.body = io.BytesIO(raw if raw is not None else json.dumps(payload).encode())
        self.headers = headers or {}
        self.status = status
        self.closed = False
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.closed = True
    def read(self, size):
        return self.body.read(size)


class ProbeTests(unittest.TestCase):
    def assert_error(self, code, fn, *args):
        with self.assertRaises(probe.ProbeError) as raised:
            fn(*args)
        self.assertEqual(str(raised.exception), code)
        self.assertNotIn(KEY, str(raised.exception))
        self.assertNotIn(SECRET, str(raised.exception))

    def test_probe_python36_syntax(self):
        ast.parse(PATH.read_text(), feature_version=(3, 6))
        self.assertNotIn("from __future__ import annotations", PATH.read_text())
        self.assertNotIn("time_ns", PATH.read_text())

    def test_input_complete_and_minimal_json(self):
        for value in [PAIR, BUNDLE]:
            self.assertEqual(probe.parse_credentials(json.dumps(value).encode()), (KEY, SECRET))

    def test_labelled_input(self):
        for heading in ["", "MEXC API\n", "mexc api:\n"]:
            for order in [("Access Key", KEY, "Secret Key", SECRET), ("Secret Key", SECRET, "Access Key", KEY)]:
                value = heading + f"{order[0]}: {order[1]}\n{order[2]}: {order[3]}"
                self.assertEqual(probe.parse_credentials(value.encode()), (KEY, SECRET))

    def test_common_key_vault_pair_labels_without_reentering_values(self):
        for raw in [
            f"mexc api/ Access Key: {KEY} Secret Key: {SECRET}",
            f"access key: {KEY}\nsecret key: {SECRET}",
            f"API Secret: {SECRET}\nAPI Key: {KEY}",
            json.dumps({"Access Key": KEY, "Secret Key": SECRET}),
            json.dumps({"accessKey": KEY, "secretKey": SECRET})
        ]:
            self.assertEqual(probe.parse_credentials(raw.encode()), (KEY, SECRET))
        self.assert_error("credential-pair-missing", probe.parse_credentials, SECRET.encode())

    def test_credential_rejections(self):
        fixtures = [b"", b"x" * (probe.MAX_INPUT + 1), b"\xff", b"[]", b"null",
                    f'{{"apiKey":"{KEY}","apiKey":"other","apiSecret":"{SECRET}"}}'.encode(),
                    f"Access Key: {KEY}".encode(),
                    f"Access Key: {KEY}\nAccess Key: {SECRET}".encode(),
                    f"Access Key: {KEY}\nSecret Key: {SECRET}\nextra".encode(),
                    f"arbitrary {KEY} {SECRET}".encode()]
        fixtures += [json.dumps(value).encode() for value in [
            {"apiKey": KEY}, {**PAIR, "unknown": True}, {**PAIR, "apiKey": "bad\nkey"},
            {**PAIR, "apiSecret": "bad secret"}, {**PAIR, "apiKey": 123},
            {**PAIR, "apiKey": "x" * 257}, {**PAIR, "apiSecret": "x" * 1025},
            {**BUNDLE, "venue": "bybit"}, {**BUNDLE, "schema": True},
            {**BUNDLE, "environment": "testnet"}, {**BUNDLE, "region": "us"},
            {**BUNDLE, "passphrase": "extra"},
        ]]
        for raw in fixtures:
            self.assert_error("invalid-credentials", probe.parse_credentials, raw)

    def test_signature_exact_endpoint_get_and_headers(self):
        opener = mock.Mock()
        response = Response(account())
        opener.open.return_value = response
        with mock.patch.object(probe.time, "time", return_value=1720000000.0):
            payload = probe.read_payload(opener, KEY, SECRET)
        self.assertEqual(payload["accountType"], "SPOT")
        opener.open.assert_called_once()
        req = opener.open.call_args.args[0]
        self.assertEqual(req.get_method(), "GET")
        self.assertIsNone(req.data)
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 20})
        url = urllib.parse.urlsplit(req.full_url)
        self.assertEqual((url.scheme, url.netloc, url.path), ("https", "api.mexc.com", "/api/v3/account"))
        unsigned = "recvWindow=5000&timestamp=1720000000000"
        signature = hmac.new(SECRET.encode(), unsigned.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(url.query, unsigned + "&signature=" + signature)
        self.assertEqual(dict(req.header_items()), {"X-mexc-apikey": KEY, "Accept": "application/json", "Accept-encoding": "identity"})
        self.assertTrue(response.closed)

    def test_opener_disables_environment_proxies_and_cookies_verifies_tls(self):
        with mock.patch.dict("os.environ", {"HTTPS_PROXY": "http://never.example:123", "https_proxy": "http://never.example:123"}):
            opener = probe.make_opener()
        self.assertFalse(any(isinstance(h, urllib.request.HTTPCookieProcessor) for h in opener.handlers))
        self.assertFalse(any(isinstance(h, urllib.request.ProxyHandler) and h.proxies for h in opener.handlers))
        https = next(h for h in opener.handlers if isinstance(h, urllib.request.HTTPSHandler))
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(https._context.check_hostname)

    def test_redirect_rejected(self):
        self.assert_error("redirect-refused", probe.RefuseRedirects().redirect_request,
                          None, None, 302, SECRET, {}, "https://other.invalid/" + KEY)

    def test_balance_precision_zero_count_and_capability_exclusion(self):
        result = probe.balance_report(account())
        self.assertEqual(result["totalAssets"], 3)
        self.assertEqual(result["zeroAssets"], 1)
        self.assertEqual(result["balances"], [
            {"currency": "USDT", "free": "12.123456789012345678901234567890", "locked": "0.000000000000000000000000000001", "available": None},
            {"currency": "ETH", "free": "0", "locked": "0", "available": "0.100"},
        ])
        self.assertEqual(set(result), {"schema", "venue", "scope", "checkedAt", "authenticatedRead", "totalAssets", "zeroAssets", "balances"})
        self.assertTrue(result["authenticatedRead"])
        self.assertRegex(result["checkedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_balance_rejections(self):
        base = {"asset": "USDT", "free": "1", "locked": "0"}
        bad_rows = [[base, base], [None], [{**base, "asset": "bad currency"}],
                    [{**base, "free": 1}], [{**base, "locked": "-1"}],
                    [{**base, "free": "1e-8"}], [{**base, "free": "01"}],
                    [{**base, "free": "1.0000000000000000000000000000001"}],
                    [{**base, "available": None}], [{"asset": "USDT", "free": "1"}]]
        for rows in bad_rows:
            self.assert_error("invalid-response", probe.balance_report, account(rows))
        for value in [{}, {**account(), "accountType": "MARGIN"}, {**account(), "balances": {}}, account([base] * 5001)]:
            self.assert_error("invalid-response", probe.balance_report, value)

    def test_response_size_limits_and_bad_json(self):
        fixtures = [
            (Response(raw=b"x", headers={"Content-Length": str(probe.MAX_BODY + 1)}), "response-too-large"),
            (Response(raw=b"x", headers={"Content-Length": "-1"}), "invalid-response"),
            (Response(raw=b"x" * (probe.MAX_BODY + 1)), "response-too-large"),
            (Response(raw=b"{" + KEY.encode()), "invalid-response"),
            (Response(raw=b'{"balances":[],"balances":[]}'), "invalid-response"),
            (Response(raw=b'{"private":NaN}'), "invalid-response"),
            (Response(raw=b"\xff"), "invalid-response"),
            (Response(raw=b"[]"), "invalid-response"),
            (Response(payload={"code": True}), "invalid-response"),
        ]
        for response, code in fixtures:
            opener = mock.Mock()
            opener.open.return_value = response
            self.assert_error(code, probe.read_payload, opener, KEY, SECRET)
            self.assertTrue(response.closed)

    def test_http_failure_no_retries_no_body_or_url_exposure(self):
        for status, code in [(401, "authentication-failed"), (403, "access-denied"), (418, "rate-limited"), (429, "rate-limited"), (500, "api-rejected"), (302, "redirect-refused")]:
            opener = mock.Mock()
            body = io.BytesIO(SECRET.encode())
            opener.open.side_effect = urllib.error.HTTPError("https://invalid/" + KEY, status, SECRET, {}, body)
            self.assert_error(code, probe.read_payload, opener, KEY, SECRET)
            opener.open.assert_called_once()
            self.assertTrue(body.closed)

    def test_api_failure_fixed_codes(self):
        for number, code in [(700003, "clock-skew"), (10073, "clock-skew"), (700002, "authentication-failed"), (429, "rate-limited"), (403, "access-denied"), (-999, "api-rejected")]:
            opener = mock.Mock()
            opener.open.return_value = Response({"code": number, "msg": SECRET, "url": KEY})
            self.assert_error(code, probe.read_payload, opener, KEY, SECRET)
            opener.open.assert_called_once()

    def test_network_failure_fixed_codes(self):
        for error, code in [(TimeoutError(SECRET), "timeout"), (urllib.error.URLError(SECRET), "connection-failed"), (ssl.SSLError(SECRET), "connection-failed")]:
            opener = mock.Mock()
            opener.open.side_effect = error
            self.assert_error(code, probe.read_payload, opener, KEY, SECRET)

    def test_output_redaction_including_escaped_values(self):
        for value in [KEY, SECRET, 'a"b\\c']:
            self.assert_error("output-rejected", probe.serialize_report, {"some": value}, (KEY, SECRET, value))
        result = probe.serialize_report(probe.balance_report(account()), (KEY, SECRET))
        self.assertNotIn(KEY, result)
        self.assertNotIn(SECRET, result)

    def test_process_deadline_handler(self):
        self.assert_error("timeout", probe.expired, None, None)

    def test_main_mocked_success_no_extra_private_fields(self):
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(PAIR).encode()))
        output = io.StringIO()
        opener = mock.Mock()
        opener.open.return_value = Response(account())
        with mock.patch.object(probe.sys, "stdin", stdin), mock.patch.object(probe.sys, "argv", ["-c"]), mock.patch.object(probe, "make_opener", return_value=opener), mock.patch.object(probe.signal, "signal"), mock.patch.object(probe.signal, "alarm") as alarm, contextlib.redirect_stdout(output):
            code = probe.main()
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result["authenticatedRead"])
        self.assertNotIn(KEY, output.getvalue())
        self.assertNotIn(SECRET, output.getvalue())
        self.assertEqual(alarm.call_args_list, [mock.call(20), mock.call(0)])

    def test_cli_rejects_args_and_invalid_stdin_without_network(self):
        for args in [[], ["forbidden"]]:
            result = subprocess.run([sys.executable, "-I", str(PATH), *args], input=b"invalid", capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, b"")
            expected = "invalid-invocation" if args else "invalid-credentials"
            self.assertEqual(json.loads(result.stdout)["error"], expected)


if __name__ == "__main__":
    unittest.main()
