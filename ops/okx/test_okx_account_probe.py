#!/usr/bin/env python3
"""Offline verification only; every credential and HTTP response is synthetic."""
import ast
import contextlib
import hashlib
import hmac
import base64
import importlib.util
import io
import itertools
import json
from pathlib import Path
import signal
import socket
import ssl
import struct
import sys
import unittest
from unittest import mock
import urllib.error
import urllib.request

PATH = Path(__file__).with_name("okx-account-probe.py")
SPEC = importlib.util.spec_from_file_location("okx_probe", PATH)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
KEY, SECRET, PASSPHRASE = "fixture_key_123456", "fixture_secret_789012", "fixture_passphrase_345678"
CREDENTIALS = (KEY, SECRET, PASSPHRASE)
SIMPLE = dict(zip(("apiKey", "apiSecret", "passphrase"), CREDENTIALS))
BUNDLE = dict(SIMPLE, schema=1, venue="okx", environment="mainnet", region="global")
NOW = "1800000000000"


def config():
    return [{"perm": "read_only,trade,withdraw", "acctLv": "1", "uid": "private-uid", "label": SECRET}]


def trading():
    return [{"uTime": NOW, "totalEq": "938.000000000000000001", "details": [
        {"ccy": "BTC", "cashBal": "0.000000000000000001", "eq": "-0.000000000000000001",
         "availBal": "", "availEq": "-0.000000000000000002", "frozenBal": "0", "uTime": NOW}]}]


def funding():
    return [{"ccy": "USDT", "bal": "128.000000000000000001", "availBal": "120.3", "frozenBal": "7.7"}]


def fees():
    return [{"instType": "SPOT", "ts": NOW, "maker": "-9", "taker": "-8",
             "feeGroup": [{"groupId": "12", "maker": "-0.0008", "taker": "-0.001"}]}]


def envelope(data):
    return {"code": "0", "data": data, "msg": ""}


class Response:
    def __init__(self, payload=None, raw=None, status=200, headers=None):
        self.body = io.BytesIO(raw if raw is not None else json.dumps(payload).encode())
        self.status = status
        self.headers = headers or {}
        self.closed = False
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        self.closed = True
    def read(self, length):
        return self.body.read(length)


def opener_for(*data):
    opener = mock.Mock()
    opener.open.side_effect = [Response(envelope(item)) for item in data]
    return opener


class ProbeTests(unittest.TestCase):
    def assert_error(self, code, function, *args):
        with self.assertRaises(probe.ProbeError) as error:
            function(*args)
        self.assertEqual(str(error.exception), code)
        for value in CREDENTIALS:
            self.assertNotIn(value, str(error.exception))

    def test_python36_syntax(self):
        ast.parse(PATH.read_text(), feature_version=(3, 6))
        self.assertNotIn("from __future__ import annotations", PATH.read_text())

    def test_strict_complete_json_formats(self):
        for value in [SIMPLE, BUNDLE, {"API key": KEY, "Secret key": SECRET, "Passphrase": PASSPHRASE},
                      {"API KEY": KEY, "SECRET KEY": SECRET, "PASSPHRASE": PASSPHRASE}]:
            self.assertEqual(probe.parse_credentials(json.dumps(value).encode()), CREDENTIALS)

    def test_precise_labels_any_order_single_line_or_multiline(self):
        for fields in itertools.permutations(("API key: " + KEY, "Secret key: " + SECRET, "Passphrase: " + PASSPHRASE)):
            for separator in (" ", "\n", "\r\n"):
                self.assertEqual(probe.parse_credentials(separator.join(fields).encode()), CREDENTIALS)

    def test_missing_credentials_fixed_diagnostic(self):
        for value in [{"apiKey": KEY, "apiSecret": SECRET},
                      dict(BUNDLE, **{})]:
            value.pop("passphrase", None)
            self.assert_error("missing-passphrase", probe.parse_credentials, json.dumps(value).encode())
        self.assert_error("missing-passphrase", probe.parse_credentials, ("API key: " + KEY + "\nSecret key: " + SECRET).encode())
        self.assert_error("credential-set-missing", probe.parse_credentials, KEY.encode())

    def test_input_bounds_duplicates_controls_and_unknown_fields(self):
        inputs = [b"", b"[]", b"null", b"\xff", b"x" * (probe.MAX_INPUT + 1),
                  ('{"apiKey":"' + KEY + '","apiKey":"duplicate","apiSecret":"' + SECRET + '","passphrase":"' + PASSPHRASE + '"}').encode(),
                  ("comment API key: " + KEY + " Secret key: " + SECRET + " Passphrase: " + PASSPHRASE).encode(),
                  ("API key: " + KEY + " Secret key: " + SECRET + " Passphrase: " + PASSPHRASE + " extra").encode(),
                  ("API key: " + KEY + " API key: " + SECRET + " Passphrase: " + PASSPHRASE).encode()]
        for change in [{"unknown": True}, {"apiKey": None}, {"apiKey": 12}, {"apiKey": "bad\nkey"},
                       {"apiKey": "x" * 257}, {"apiSecret": "x" * 1025}, {"apiSecret": "bad secret"},
                       {"passphrase": "secret\r\nHeader:value"}, {"passphrase": ""}, {"apiSecret": "é"},
                       {"API key": KEY}]:
            inputs.append(json.dumps(dict(SIMPLE, **change)).encode())
        for change in [{"schema": True}, {"schema": 2}, {"venue": "mexc"}, {"environment": "testnet"},
                       {"region": "eea"}, {"origin": "https://other.invalid"}]:
            inputs.append(json.dumps(dict(BUNDLE, **change)).encode())
        inputs.append(json.dumps(dict(SIMPLE, venue="okx")).encode())
        for raw in inputs:
            self.assert_error("invalid-credentials", probe.parse_credentials, raw)

    def test_exact_iso_timestamp_get_signature_path_and_headers(self):
        timestamp = "2026-09-25T10:27:25.123Z"
        for path in probe.PATHS:
            request = probe.signed_request(path, CREDENTIALS, timestamp)
            headers = dict(request.header_items())
            expected = base64.b64encode(hmac.new(SECRET.encode(), (timestamp + "GET" + path).encode(), hashlib.sha256).digest()).decode()
            self.assertEqual(request.full_url, "https://www.okx.com" + path)
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            self.assertEqual(headers["Ok-access-key"], KEY)
            self.assertEqual(headers["Ok-access-passphrase"], PASSPHRASE)
            self.assertEqual(headers["Ok-access-timestamp"], timestamp)
            self.assertEqual(headers["Ok-access-sign"], expected)
            self.assertNotIn("X-simulated-trading", headers)
            self.assertNotIn(KEY, request.full_url)
        self.assertRegex(probe.request_timestamp(), r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")

    def test_non_allowlisted_path_refused(self):
        for path in ["/api/v5/trade/order", "/api/v5/asset/transfer", "/api/v5/asset/withdrawal",
                     "https://other.invalid", probe.PATHS[0] + "?ccy=BTC"]:
            self.assert_error("invalid-invocation", probe.signed_request, path, CREDENTIALS)

    def test_tls_public_ca_hostname_proxy_cookie_and_redirect_guards(self):
        with mock.patch.dict("os.environ", {"HTTPS_PROXY": "http://bad.invalid", "https_proxy": "http://bad.invalid"}):
            opener = probe.make_opener()
        self.assertFalse(any(isinstance(item, urllib.request.ProxyHandler) and item.proxies for item in opener.handlers))
        self.assertFalse(any(isinstance(item, urllib.request.HTTPCookieProcessor) for item in opener.handlers))
        https = next(item for item in opener.handlers if isinstance(item, urllib.request.HTTPSHandler))
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(https._context.check_hostname)
        self.assert_error("redirect-refused", probe.RefuseRedirects().redirect_request,
                          None, None, 302, SECRET, {}, "https://bad.invalid/" + KEY)

    def test_success_four_fixed_requests_metadata_only(self):
        opener = opener_for(config(), trading(), funding(), fees())
        result = probe.account_report(opener, CREDENTIALS)
        self.assertEqual(set(result), {"schema", "venue", "scope", "authenticatedRead", "checkedAt",
                                     "tradingAssets", "fundingAssets", "permissions", "feeReadVerified"})
        self.assertEqual(result["permissions"], {"read": True, "trade": True, "withdraw": True, "unknownPermissionsPresent": False})
        self.assertEqual((result["tradingAssets"], result["fundingAssets"]), (1, 1))
        self.assertTrue(result["authenticatedRead"])
        self.assertTrue(result["feeReadVerified"])
        encoded = probe.serialize_report(result, CREDENTIALS)
        for private in ["private-uid", "938.000000000000000001", "128.000000000000000001", "BTC", "USDT"]:
            self.assertNotIn(private, encoded)
        self.assertEqual([call[0][0].full_url for call in opener.open.call_args_list], [probe.ORIGIN + path for path in probe.PATHS])
        self.assertTrue(all(call[1] == {"timeout": 5} for call in opener.open.call_args_list))

    def test_empty_accounts_and_missing_read_permission_not_inferred(self):
        opener = opener_for([{"perm": "trade", "acctLv": "2"}], [{"uTime": NOW, "totalEq": "0", "details": []}], [], fees())
        result = probe.account_report(opener, CREDENTIALS)
        self.assertFalse(result["permissions"]["read"])
        self.assertEqual((result["tradingAssets"], result["fundingAssets"]), (0, 0))
        self.assertTrue(result["authenticatedRead"])

    def test_unknown_permission_name_not_output(self):
        result = probe.permissions_report([{"perm": "read_only,private_future_permission", "acctLv": "4"}])
        self.assertTrue(result["unknownPermissionsPresent"])
        self.assertNotIn("private_future_permission", json.dumps(result))

    def test_stop_first_failure_preserves_partial_success(self):
        data = [config(), trading(), funding(), fees()]
        for position in range(4):
            opener = opener_for(*data[:position])
            opener.open.side_effect = [Response(envelope(item)) for item in data[:position]] + [Response({"code": "50105", "msg": SECRET})]
            result = probe.account_report(opener, CREDENTIALS)
            self.assertEqual(result, {"schema": 1, "venue": "okx", "scope": "account-check",
                "authenticatedRead": position > 0, "errorCode": "authentication-failed",
                "failedStage": probe.STAGES[position], "completedReads": position})
            self.assertEqual(opener.open.call_count, position + 1)

    def test_successful_auth_malformed_first_schema_distinguished(self):
        opener = opener_for([{"perm": "read_only", "acctLv": "99"}])
        result = probe.account_report(opener, CREDENTIALS)
        self.assertEqual(result["errorCode"], "invalid-response")
        self.assertTrue(result["authenticatedRead"])
        self.assertEqual(result["completedReads"], 0)
        self.assertEqual(opener.open.call_count, 1)

    def test_permissions_strict_schema(self):
        for value in [[], [{"perm": "", "acctLv": "1"}], [{"perm": "read_only,read_only", "acctLv": "1"}],
                      [{"perm": "read_only, TRADE", "acctLv": "1"}], [{"perm": True, "acctLv": "1"}],
                      [{"perm": "read_only", "acctLv": 1}], [{"perm": "read_only", "acctLv": "5"}], [None]]:
            self.assert_error("invalid-response", probe.permissions_report, value)

    def test_balance_schema_bad_decimals_duplicates_missing_fields(self):
        for field, value in [("cashBal", 3), ("eq", "NaN"), ("cashBal", "1e-3"), ("cashBal", "01"),
                             ("frozenBal", "-1"), ("ccy", "bad currency"), ("availEq", None), ("uTime", "0")]:
            data = trading()
            data[0]["details"][0][field] = value
            self.assert_error("invalid-response", probe.trading_assets, data)
        data = trading()
        data[0]["details"] *= 2
        self.assert_error("invalid-response", probe.trading_assets, data)
        for value in [[None], [{}], funding() * 2, [{"ccy": "BTC", "bal": "-1", "availBal": "0", "frozenBal": "0"}]]:
            self.assert_error("invalid-response", probe.funding_assets, value)

    def test_fee_group_single_target_required_no_legacy_fallback(self):
        for change in [{"feeGroup": []}, {"feeGroup": fees()[0]["feeGroup"] * 2}, {"instType": "SWAP"},
                       {"instId": "ETH-USDT"}, {"feeGroup": [{"groupId": "x", "maker": "0", "taker": "0"}]},
                       {"feeGroup": [{"groupId": "1", "maker": None, "taker": "0"}]}, {"ts": "0"}]:
            self.assert_error("invalid-response", probe.verify_fees, [dict(fees()[0], **change)])

    def test_error_codes_never_expose_upstream_message(self):
        cases = [("50102", "clock-skew"), ("50112", "clock-skew"), ("50101", "environment-mismatch"),
                 ("50110", "ip-not-allowed"), ("50119", "region-or-key-mismatch"), ("50105", "authentication-failed"),
                 ("50011", "rate-limited"), ("50013", "rate-limited"), ("50040", "rate-limited"), ("unknown", "api-rejected")]
        for code, expected in cases:
            opener = mock.Mock()
            opener.open.return_value = Response({"code": code, "msg": SECRET, "data": KEY})
            self.assert_error(expected, probe.read_payload, opener, probe.PATHS[0], CREDENTIALS)
            self.assertEqual(opener.open.call_count, 1)

    def test_http_errors_bounded_body_classified_without_echo(self):
        for status, body, expected in [
            (401, json.dumps({"code": "50119", "msg": SECRET}).encode(), "region-or-key-mismatch"),
            (401, SECRET.encode(), "authentication-failed"), (403, SECRET.encode(), "access-denied"),
            (429, SECRET.encode(), "rate-limited"), (500, SECRET.encode(), "api-rejected"),
            (302, SECRET.encode(), "redirect-refused"),
        ]:
            opener, stream = mock.Mock(), io.BytesIO(body)
            opener.open.side_effect = urllib.error.HTTPError("https://bad.invalid/" + KEY, status, SECRET, {}, stream)
            self.assert_error(expected, probe.read_payload, opener, probe.PATHS[0], CREDENTIALS)
            self.assertTrue(stream.closed)
            self.assertEqual(opener.open.call_count, 1)

    def test_body_limits_encoding_and_envelope_rejected(self):
        for response, expected in [
            (Response(raw=b"x" * (probe.MAX_BODY + 1)), "response-too-large"),
            (Response(raw=b"x", headers={"Content-Length": str(probe.MAX_BODY + 1)}), "response-too-large"),
            (Response(raw=b"x", headers={"Content-Length": "bad"}), "invalid-response"),
            (Response(raw=b"x", headers={"Content-Encoding": "gzip"}), "invalid-response"),
            (Response(raw=b'{"code":"0","data":[],"data":[]}'), "invalid-response"),
            (Response(raw=b'{"code":"0","data":[],"extra":NaN}'), "invalid-response"),
            (Response(raw=b"\xff"), "invalid-response"), (Response(payload={"code": 0, "data": []}), "invalid-response"),
            (Response(payload=envelope([{}] * 2001)), "invalid-response"),
        ]:
            opener = mock.Mock()
            opener.open.return_value = response
            self.assert_error(expected, probe.read_payload, opener, probe.PATHS[0], CREDENTIALS)
            self.assertTrue(response.closed)

    def test_timeouts_and_network_errors_fixed_no_retries(self):
        for error, expected in [(TimeoutError(SECRET), "timeout"), (socket.timeout(SECRET), "timeout"),
                                (urllib.error.URLError(socket.timeout(SECRET)), "timeout"),
                                (urllib.error.URLError(SECRET), "connection-failed"), (ssl.SSLError(SECRET), "connection-failed")]:
            opener = mock.Mock()
            opener.open.side_effect = error
            self.assert_error(expected, probe.read_payload, opener, probe.PATHS[0], CREDENTIALS)
            self.assertEqual(opener.open.call_count, 1)

    def test_alarm_bounds_whole_response_and_restores_handler(self):
        old = signal.getsignal(signal.SIGALRM)
        with mock.patch.object(probe.signal, "setitimer") as alarm:
            with probe.deadline():
                self.assertEqual(signal.getsignal(signal.SIGALRM), probe.expired)
            self.assertEqual(alarm.call_args_list, [mock.call(signal.ITIMER_REAL, 5), mock.call(signal.ITIMER_REAL, 0)])
        self.assertEqual(signal.getsignal(signal.SIGALRM), old)
        self.assert_error("timeout", probe.expired, None, None)

    def test_secret_output_guard(self):
        for value in CREDENTIALS:
            self.assert_error("output-rejected", probe.serialize_report, {"private": value}, CREDENTIALS)

    def run_main(self, raw, opener=None, args=None):
        output = io.StringIO()
        stream = mock.Mock()
        stream.buffer = io.BytesIO(raw)
        stream.isatty.return_value = False
        with mock.patch.object(probe.sys, "stdin", stream), mock.patch.object(probe.sys, "argv", args or [str(PATH)]), \
                mock.patch.object(probe, "make_opener", return_value=opener) as create, contextlib.redirect_stdout(output):
            result = probe.main()
        return result, output.getvalue(), create

    def test_main_fail_before_network_and_stdout_fixed_json(self):
        code, output, create = self.run_main(json.dumps({"apiKey": KEY, "apiSecret": SECRET}).encode())
        self.assertEqual(code, 1)
        create.assert_not_called()
        self.assertEqual(json.loads(output), {"schema": 1, "venue": "okx", "scope": "account-check", "authenticatedRead": False,
                                             "errorCode": "missing-passphrase", "failedStage": "credentials", "completedReads": 0,
                                             "credentialShape": {"format": "json-object", "apiKeyPresent": True,
                                                 "apiSecretPresent": True, "passphrasePresent": False,
                                                 "unknownFields": 0, "duplicateFields": False}})
        for value in CREDENTIALS:
            self.assertNotIn(value, output)

    def test_main_success_or_partial_failure_exit_code_matches_report(self):
        for opener, expected in [(opener_for(config(), trading(), funding(), fees()), 0),
                                 (opener_for(config(), [{}]), 1)]:
            code, output, _create = self.run_main(json.dumps(SIMPLE).encode(), opener)
            self.assertEqual(code, expected)
            report = json.loads(output)
            self.assertTrue(report["authenticatedRead"])
            self.assertEqual(output.count("\n"), 1)
            for value in CREDENTIALS:
                self.assertNotIn(value, output)

    def test_extra_arguments_no_network(self):
        code, output, create = self.run_main(json.dumps(SIMPLE).encode(), args=[str(PATH), "--unsupported"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output)["errorCode"], "invalid-invocation")
        create.assert_not_called()


    def test_explicit_aliases_and_equals_delimiter(self):
        aliases = [("api_key", "api_secret", "pass_phrase"),
                   ("API Key", "API Secret", "API Passphrase"),
                   ("apiKey", "secretKey", "passphrase"),
                   ("apiKey", "secret_key", "passphrase")]
        for labels in aliases:
            value = dict(zip(labels, CREDENTIALS))
            self.assertEqual(probe.parse_credentials(json.dumps(value).encode()), CREDENTIALS)
            for separator in ("=", ":", " = "):
                raw = "\n".join(name + separator + item for name, item in zip(labels, CREDENTIALS)).encode()
                self.assertEqual(probe.parse_credentials(raw), CREDENTIALS)
                self.assertEqual(probe.credential_shape(raw), {"format": "labelled-text", "apiKeyPresent": True,
                    "apiSecretPresent": True, "passphrasePresent": True, "unknownFields": 0, "duplicateFields": False})
        bad = dict(BUNDLE)
        bad["api_key"] = bad.pop("apiKey")
        self.assert_error("invalid-credentials", probe.parse_credentials, json.dumps(bad).encode())

    def test_shape_json_top_level_only_exact_keys_and_no_private_content(self):
        raw = json.dumps({"api_key": KEY, "api_secret": SECRET, "private_label_987": {"passphrase": PASSPHRASE}}).encode()
        result = probe.credential_shape(raw)
        self.assertEqual(result, {"format": "json-object", "apiKeyPresent": True, "apiSecretPresent": True,
            "passphrasePresent": False, "unknownFields": 1, "duplicateFields": False})
        for value in CREDENTIALS + ("private_label_987",):
            self.assertNotIn(value, json.dumps(result))
        private_key_shape = probe.credential_shape(json.dumps({SECRET: PASSPHRASE}).encode())
        self.assertEqual(private_key_shape["unknownFields"], 1)
        self.assertNotIn(SECRET, json.dumps(private_key_shape))
        self.assertNotIn(PASSPHRASE, json.dumps(private_key_shape))
        self.assertEqual(probe.credential_shape(json.dumps(BUNDLE).encode())["unknownFields"], 0)
        self.assertEqual(probe.credential_shape(json.dumps({str(index): SECRET for index in range(200)}).encode())["unknownFields"], 100)

    def test_shape_duplicate_fields_semantic_aliases_and_unknown_names(self):
        fixtures = [('{' + '"apiKey":"' + KEY + '","api_key":"' + SECRET + '","Passphrase":"' + PASSPHRASE + '"}').encode(),
                    ('{"apiKey":"' + KEY + '","apiKey":"' + SECRET + '"}').encode(),
                    ('API key=' + KEY + '\nAPI_KEY=' + SECRET + '\nPassphrase=' + PASSPHRASE).encode(),
                    b'{"unknown-private-label":1,"unknown-private-label":2}']
        for raw in fixtures:
            result = probe.credential_shape(raw)
            self.assertTrue(result["duplicateFields"])
            self.assert_error("invalid-credentials", probe.parse_credentials, raw)
            self.assertNotIn("unknown-private-label", json.dumps(result))

    def test_shape_json_other_and_malformed_or_arbitrary_text(self):
        for value in [[], [SIMPLE], SECRET, 1, True, None]:
            self.assertEqual(probe.credential_shape(json.dumps(value).encode()), {"format": "json-other",
                "apiKeyPresent": False, "apiSecretPresent": False, "passphrasePresent": False,
                "unknownFields": 0, "duplicateFields": False})
        for raw in [b'', b'\xff', b'x' * (probe.MAX_INPUT + 1), b'{"apiKey":NaN}', b'{"apiKey":"unterminated',
                    ('Here is API Key: ' + KEY + ' Secret Key: ' + SECRET).encode(),
                    ('API Key: ' + KEY + '\nUnknown private label: ' + SECRET).encode()]:
            self.assertEqual(probe.credential_shape(raw), {"format": "unrecognised-text", "apiKeyPresent": False,
                "apiSecretPresent": False, "passphrasePresent": False, "unknownFields": 0, "duplicateFields": False})

    def test_shape_presence_does_not_certify_value_validity(self):
        for raw in [json.dumps(dict(SIMPLE, passphrase="")).encode(),
                    ('API key=' + KEY + '\nSecret key=' + SECRET + '\nPassphrase=').encode()]:
            self.assertTrue(probe.credential_shape(raw)["passphrasePresent"])
            self.assert_error("invalid-credentials", probe.parse_credentials, raw)

    def test_shape_never_added_after_credential_stage_or_before_input(self):
        for opener in [opener_for(config(), trading(), funding(), fees()), opener_for(config(), [{}])]:
            _code, output, _create = self.run_main(json.dumps(SIMPLE).encode(), opener)
            self.assertNotIn("credentialShape", json.loads(output))
        _code, output, _create = self.run_main(json.dumps(SIMPLE).encode(), args=[str(PATH), "--unsupported"])
        self.assertNotIn("credentialShape", json.loads(output))

    def test_unknown_fields_not_ignored_by_parser(self):
        raw = json.dumps(dict(SIMPLE, private_unknown=SECRET)).encode()
        code, output, create = self.run_main(raw)
        create.assert_not_called()
        self.assertEqual(code, 1)
        report = json.loads(output)
        self.assertEqual(report["credentialShape"]["unknownFields"], 1)
        self.assertEqual(report["errorCode"], "invalid-credentials")
        for value in CREDENTIALS + ("private_unknown",):
            self.assertNotIn(value, output)


    def split_frame(self, keypair, passphrase):
        return probe.SPLIT_MAGIC + struct.pack("!I", len(keypair)) + keypair + struct.pack("!I", len(passphrase)) + passphrase

    def test_split_frame_two_records_without_reentering_keypair(self):
        records = [{"apiKey": KEY, "apiSecret": SECRET},
                   {"API key": KEY, "Secret key": SECRET},
                   {key: value for key, value in BUNDLE.items() if key != "passphrase"}]
        for keypair in records:
            for passphrase in [PASSPHRASE.encode(), (PASSPHRASE + "\n").encode(), (PASSPHRASE + "\r\n").encode(),
                               json.dumps({"passphrase": PASSPHRASE}).encode(), ("Passphrase: " + PASSPHRASE).encode()]:
                raw = self.split_frame(json.dumps(keypair).encode(), passphrase)
                self.assertEqual(probe.parse_probe_input(raw), CREDENTIALS)
        raw = self.split_frame(("API Key=" + KEY + "\nSecret Key=" + SECRET).encode(), PASSPHRASE.encode())
        self.assertEqual(probe.parse_probe_input(raw), CREDENTIALS)

    def test_split_frame_lengths_bounds_order_and_trailing_data(self):
        keypair = json.dumps({"apiKey": KEY, "apiSecret": SECRET}).encode()
        valid = self.split_frame(keypair, PASSPHRASE.encode())
        cases = [valid + b'x', self.split_frame(PASSPHRASE.encode(), keypair),
                 self.split_frame(b'', PASSPHRASE.encode()), self.split_frame(keypair, b''),
                 self.split_frame(b'x' * (probe.MAX_INPUT + 1), PASSPHRASE.encode()),
                 self.split_frame(keypair, b'x' * (probe.MAX_INPUT + 1)),
                 probe.SPLIT_MAGIC + struct.pack("!I", 0xffffffff), b'x' * (probe.MAX_PROBE_INPUT + 1)]
        cases += [valid[:index] for index in range(len(probe.SPLIT_MAGIC), len(valid))]
        for raw in cases:
            self.assert_error("invalid-credentials", probe.parse_probe_input, raw)
        self.assertEqual(probe.MAX_PROBE_INPUT, 2 * probe.MAX_INPUT + len(probe.SPLIT_MAGIC) + 8)
        # Both records may be near16KiB due to JSON whitespace, preserving bounds.
        padded_pair = keypair + b' ' * (probe.MAX_INPUT - len(keypair))
        phrase_json = json.dumps({"passphrase": PASSPHRASE}).encode()
        padded_phrase = phrase_json + b' ' * (probe.MAX_INPUT - len(phrase_json))
        self.assertEqual(probe.parse_probe_input(self.split_frame(padded_pair, padded_phrase)), CREDENTIALS)

    def test_split_frame_never_overwrites_existing_passphrase(self):
        for value in [PASSPHRASE, "different", "", None]:
            raw = self.split_frame(json.dumps(dict(SIMPLE, passphrase=value)).encode(), PASSPHRASE.encode())
            self.assert_error("invalid-credentials", probe.parse_probe_input, raw)
        raw = self.split_frame(json.dumps({"apiKey": KEY, "apiSecret": SECRET, "pass_phrase": PASSPHRASE}).encode(), PASSPHRASE.encode())
        self.assert_error("invalid-credentials", probe.parse_probe_input, raw)

    def test_split_frame_preserves_unknown_duplicate_and_canonical_rejection(self):
        for value in [dict(BUNDLE, venue="mexc"), dict(BUNDLE, environment="testnet"), dict(BUNDLE, schema=True),
                      {"apiKey": KEY, "apiSecret": SECRET, "extra": "private"},
                      {"apiKey": KEY, "api_key": KEY, "apiSecret": SECRET}]:
            value.pop("passphrase", None)
            self.assert_error("invalid-credentials", probe.parse_probe_input,
                              self.split_frame(json.dumps(value).encode(), PASSPHRASE.encode()))
        pair = ('{"apiKey":"' + KEY + '","apiKey":"' + KEY + '","apiSecret":"' + SECRET + '"}').encode()
        self.assert_error("invalid-credentials", probe.parse_probe_input, self.split_frame(pair, PASSPHRASE.encode()))

    def test_separate_passphrase_strict_json_labels_and_control_rejection(self):
        for raw in [b'', b'\n', b'\xff', b'x' * 1025, b'value\x00', b'value\t', b'value\r', b'value\n\n', b'first\nsecond',
                    b'{"passphrase":"x","passphrase":"y"}', b'{"passphrase":"x","other":"y"}',
                    b'{"passphrase":123}', b'{"Passphrase":"x"}', b'{"passphrase":null}',
                    b'Passphrase:', b'Passphrase: secret\nprivate prose']:
            self.assert_error("invalid-credentials", probe.parse_separate_passphrase, raw)
        self.assertEqual(probe.parse_separate_passphrase(b' whole value '), ' whole value ')
        self.assertEqual(probe.parse_separate_passphrase(b'prefix Passphrase: whole value'), 'prefix Passphrase: whole value')
        self.assertEqual(probe.parse_separate_passphrase(b'x' * 1024), 'x' * 1024)

    def test_split_frame_main_metadata_only_and_signing_unchanged(self):
        raw = self.split_frame(json.dumps({"apiKey": KEY, "apiSecret": SECRET}).encode(), PASSPHRASE.encode())
        opener = opener_for(config(), trading(), funding(), fees())
        code, output, _create = self.run_main(raw, opener)
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)["feeReadVerified"])
        self.assertEqual(opener.open.call_count, 4)
        for call in opener.open.call_args_list:
            headers = dict(call[0][0].header_items())
            self.assertEqual(headers["Ok-access-key"], KEY)
            self.assertEqual(headers["Ok-access-passphrase"], PASSPHRASE)
        for value in CREDENTIALS:
            self.assertNotIn(value, output)

    def test_split_frame_failure_no_network_and_fixed_diagnostic_only(self):
        raw = self.split_frame(json.dumps(SIMPLE).encode(), PASSPHRASE.encode())
        code, output, create = self.run_main(raw)
        self.assertEqual(code, 1)
        create.assert_not_called()
        report = json.loads(output)
        self.assertEqual(report["failedStage"], "credentials")
        self.assertEqual(report["completedReads"], 0)
        self.assertEqual(report["credentialShape"]["format"], "unrecognised-text")
        for value in CREDENTIALS:
            self.assertNotIn(value, output)

    def test_plain_bundle_remains_supported_and_size_bound_unchanged(self):
        self.assertEqual(probe.parse_probe_input(json.dumps(SIMPLE).encode()), CREDENTIALS)
        raw = json.dumps(SIMPLE).encode() + b' ' * probe.MAX_INPUT
        self.assert_error("invalid-credentials", probe.parse_probe_input, raw)


if __name__ == "__main__":
    unittest.main()
