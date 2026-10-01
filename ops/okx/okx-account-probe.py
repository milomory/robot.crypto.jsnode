#!/usr/bin/env python3
"""One-shot OKX account verification; credentials arrive only on protected stdin.

Only four fixed GET requests are possible. Output contains counts and permission
flags, never credentials, upstream error text, account identifiers or balances.
Python 3.6+; no third-party dependencies.
"""
import base64
import contextlib
import datetime
import hashlib
import hmac
import json
import re
import signal
import socket
import ssl
import struct
import sys
import urllib.error
import urllib.request

MAX_INPUT = 16 * 1024
SPLIT_MAGIC = b"OKX-SPLIT-1\0"
MAX_PROBE_INPUT = 2 * MAX_INPUT + len(SPLIT_MAGIC) + 8
MAX_BODY = 256 * 1024
REQUEST_SECONDS = 5
ORIGIN = "https://www.okx.com"
PATHS = (
    "/api/v5/account/config",
    "/api/v5/account/balance",
    "/api/v5/asset/balances",
    "/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT",
)
STAGES = ("config", "trading-balance", "funding-balance", "trade-fee")
ERRORS = frozenset({
    "invalid-credentials", "credential-set-missing", "missing-passphrase",
    "invalid-response", "response-too-large", "timeout", "redirect-refused",
    "authentication-failed", "access-denied", "rate-limited", "clock-skew",
    "api-rejected", "connection-failed", "output-rejected", "invalid-invocation",
    "probe-failed", "ip-not-allowed", "region-or-key-mismatch", "environment-mismatch",
})
DECIMAL = re.compile(r"-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,30})?\Z")
NONNEGATIVE = re.compile(r"(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,30})?\Z")
CURRENCY = re.compile(r"[A-Z0-9][A-Z0-9.-]{0,31}\Z")
FIELD_NAMES = {
    "apikey": "apiKey", "api key": "apiKey", "api_key": "apiKey",
    "apisecret": "apiSecret", "api_secret": "apiSecret", "api secret": "apiSecret",
    "secretkey": "apiSecret", "secret_key": "apiSecret", "secret key": "apiSecret",
    "passphrase": "passphrase", "pass_phrase": "passphrase", "api passphrase": "passphrase",
}
FIELD_LABEL = "(?:" + "|".join(re.escape(name).replace(r"\ ", r"[ \t]+")
                              for name in sorted(FIELD_NAMES, key=len, reverse=True)) + ")"
METADATA_FIELDS = frozenset({"schema", "venue", "environment", "region"})


class ProbeError(Exception):
    def __init__(self, code):
        self.code = code if code in ERRORS else "probe-failed"
        super().__init__(self.code)


def pairs_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate-field")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("invalid-number")


def decode_json(raw):
    return json.loads(raw, object_pairs_hook=pairs_without_duplicates,
                      parse_constant=reject_constant)


def field_name(label):
    return FIELD_NAMES.get(re.sub(r"[ \t]+", " ", label).lower())


def labelled_pairs(text):
    """Recognize a complete labelled document; never search inside free text."""
    field = FIELD_LABEL + r"[ \t]*[:=][ \t]*[^\s]+"
    if re.fullmatch(field + r"(?:\s+" + field + r"){0,99}", text, re.IGNORECASE):
        return re.findall("(" + FIELD_LABEL + r")[ \t]*[:=][ \t]*([^\s]+)", text, re.IGNORECASE)
    # Empty values are detectable only as exact standalone labelled lines. The
    # parser still rejects them; diagnostics only say the field was present.
    lines = text.splitlines()
    if not 1 <= len(lines) <= 100:
        raise ValueError()
    result = []
    for line in lines:
        match = re.fullmatch(r"[ \t]*(" + FIELD_LABEL + r")[ \t]*[:=][ \t]*([^\s]*)[ \t]*", line, re.IGNORECASE)
        if match is None:
            raise ValueError()
        result.append((match[1], match[2]))
    return result


class DiagnosticPairs(list):
    """Retain JSON object fields (including duplicates), separately from arrays."""


def credential_shape(raw):
    """Fixed metadata only: no values, raw labels, lengths, hashes or excerpts."""
    result = {
        "format": "unrecognised-text", "apiKeyPresent": False, "apiSecretPresent": False,
        "passphrasePresent": False, "unknownFields": 0, "duplicateFields": False,
    }
    try:
        if not isinstance(raw, bytes) or not raw or len(raw) > MAX_INPUT:
            return result
        text = raw.decode("utf-8").strip()
        try:
            value = json.loads(text, object_pairs_hook=DiagnosticPairs, parse_constant=reject_constant)
        except (ValueError, TypeError):
            pairs = labelled_pairs(text)
            result["format"] = "labelled-text"
        else:
            if not isinstance(value, DiagnosticPairs):
                result["format"] = "json-other"
                return result
            result["format"] = "json-object"
            pairs = value
        seen = set()
        for label, _value in pairs:
            name = field_name(label)
            identity = name if name is not None else label
            if identity in seen:
                result["duplicateFields"] = True
            seen.add(identity)
            if name is not None:
                result[name + "Present"] = True
            elif label not in METADATA_FIELDS:
                result["unknownFields"] = min(100, result["unknownFields"] + 1)
        return result
    except Exception:
        return result


def parse_credentials(raw, passphrase_override=None):
    try:
        if not isinstance(raw, bytes) or not raw or len(raw) > MAX_INPUT:
            raise ValueError()
        text = raw.decode("utf-8").strip()
        if text.startswith("{"):
            value = decode_json(text)
            if not isinstance(value, dict):
                raise ValueError()
            metadata = METADATA_FIELDS
            if set(value) & metadata:
                if (not metadata.issubset(value) or type(value["schema"]) is not int
                        or value["schema"] != 1 or value["venue"] != "okx"
                        or value["environment"] != "mainnet" or value["region"] != "global"
                        or set(value) - metadata - {"apiKey", "apiSecret", "passphrase"}):
                    raise ValueError()
                value = {key: item for key, item in value.items() if key not in metadata}
        else:
            # Exactly labelled values, in any order; no arbitrary prose, guessed
            # ordering, URLs, filenames or extraction of values from free text.
            try:
                pairs = labelled_pairs(text)
            except ValueError:
                if re.fullmatch(r"[A-Za-z0-9_-]{8,1024}", text):
                    raise ProbeError("credential-set-missing")
                raise ValueError()
            value = pairs_without_duplicates(pairs)
        normalized = {}
        for key, item in value.items():
            name = field_name(key)
            if name is None or name in normalized:
                raise ValueError()
            normalized[name] = item
        if passphrase_override is not None:
            if "passphrase" in normalized:
                raise ValueError()
            normalized["passphrase"] = passphrase_override
        if set(normalized) == {"apiKey", "apiSecret"}:
            raise ProbeError("missing-passphrase")
        if set(normalized) != {"apiKey", "apiSecret", "passphrase"}:
            raise ValueError()
        api_key, api_secret, passphrase = (normalized[key] for key in ("apiKey", "apiSecret", "passphrase"))
        if (not isinstance(api_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", api_key)
                or not isinstance(api_secret, str) or not re.fullmatch(r"[\x21-\x7e]{1,1024}", api_secret)
                or not isinstance(passphrase, str) or not re.fullmatch(r"[\x20-\x7e]{1,1024}", passphrase)):
            raise ValueError()
        return api_key, api_secret, passphrase
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("invalid-credentials") from None


def parse_separate_passphrase(raw):
    """The entire second secret is the passphrase; never derive or search it."""
    try:
        if not isinstance(raw, bytes) or not 1 <= len(raw) <= MAX_INPUT:
            raise ValueError()
        text = raw.decode("utf-8")
        if text.endswith("\r\n"):
            text = text[:-2]
        elif text.endswith("\n"):
            text = text[:-1]
        if text.startswith("{"):
            value = decode_json(text)
            if not isinstance(value, dict) or set(value) != {"passphrase"}:
                raise ValueError()
            value = value["passphrase"]
        elif re.match(r"Passphrase[ \t]*:", text, re.IGNORECASE):
            match = re.fullmatch(r"Passphrase[ \t]*:[ \t]*([^\r\n]*)", text, re.IGNORECASE)
            if match is None:
                raise ValueError()
            value = match[1]
        else:
            value = text
        if not isinstance(value, str) or not re.fullmatch(r"[\x20-\x7e]{1,1024}", value):
            raise ValueError()
        return value
    except Exception:
        raise ProbeError("invalid-credentials") from None


def parse_probe_input(raw):
    """Accept the original bundle or exactly two length-delimited secret records."""
    if not isinstance(raw, bytes) or len(raw) > MAX_PROBE_INPUT:
        raise ProbeError("invalid-credentials")
    if not raw.startswith(SPLIT_MAGIC):
        return parse_credentials(raw)
    try:
        position, records = len(SPLIT_MAGIC), []
        for _index in range(2):
            if len(raw) - position < 4:
                raise ValueError()
            length = struct.unpack("!I", raw[position:position + 4])[0]
            position += 4
            if not 1 <= length <= MAX_INPUT or len(raw) - position < length:
                raise ValueError()
            records.append(raw[position:position + length])
            position += length
        if position != len(raw):
            raise ValueError()
        passphrase = parse_separate_passphrase(records[1])
        return parse_credentials(records[0], passphrase_override=passphrase)
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("invalid-credentials") from None


def expired(_signum, _frame):
    raise ProbeError("timeout")


@contextlib.contextmanager
def deadline():
    # Socket timeouts alone reset for each read; the alarm also bounds slow bodies
    # and DNS/TLS so the entire request finishes within five seconds.
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, REQUEST_SECONDS)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProbeError("redirect-refused")


def make_opener():
    # Use system public CA validation; never inherit proxy credentials or routes.
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        RefuseRedirects(),
    )
    opener.addheaders = []
    return opener


def request_timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def checked_at():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def signed_request(path, credentials, timestamp=None):
    if path not in PATHS:
        raise ProbeError("invalid-invocation")
    api_key, api_secret, passphrase = credentials
    timestamp = request_timestamp() if timestamp is None else timestamp
    signature = base64.b64encode(hmac.new(
        api_secret.encode("ascii"), (timestamp + "GET" + path).encode("ascii"), hashlib.sha256,
    ).digest()).decode("ascii")
    return urllib.request.Request(ORIGIN + path, headers={
        "OK-ACCESS-KEY": api_key, "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json", "Accept": "application/json",
        "Accept-Encoding": "identity",
    }, method="GET")


def api_error(code):
    # Codes only, never upstream msg text (which can echo private request data).
    if code in {"50011", "50013", "50040"}:
        return "rate-limited"
    if code in {"50102", "50112"}:
        return "clock-skew"
    if code == "50101":
        return "environment-mismatch"
    if code == "50110":
        return "ip-not-allowed"
    if code == "50119":
        # Official FAQ says a regional domain mismatch can produce this code;
        # it does not establish that the credentials themselves are valid.
        return "region-or-key-mismatch"
    if code in {"50103", "50104", "50105", "50106", "50107", "50108", "50109", "50111", "50113"}:
        return "authentication-failed"
    return "api-rejected"


def http_error(status):
    if 300 <= status < 400:
        return "redirect-refused"
    return {401: "authentication-failed", 403: "access-denied", 418: "rate-limited",
            429: "rate-limited"}.get(status, "api-rejected")


def read_body(response):
    length = response.headers.get("Content-Length")
    if length is not None:
        if not re.fullmatch(r"[0-9]{1,12}", length):
            raise ProbeError("invalid-response")
        if int(length) > MAX_BODY:
            raise ProbeError("response-too-large")
    if response.headers.get("Content-Encoding", "identity").lower() not in {"identity", ""}:
        raise ProbeError("invalid-response")
    chunks, total = [], 0
    while True:
        chunk = response.read(min(16384, MAX_BODY + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_BODY:
            raise ProbeError("response-too-large")
        chunks.append(chunk)
    return b"".join(chunks)


def read_payload(opener, path, credentials):
    try:
        with deadline():
            request = signed_request(path, credentials)
            try:
                with opener.open(request, timeout=REQUEST_SECONDS) as response:
                    status = response.status
                    raw = read_body(response)
            except urllib.error.HTTPError as error:
                try:
                    status = error.code
                    # Refuse redirects before inspecting their body.
                    if 300 <= status < 400:
                        raise ProbeError("redirect-refused")
                    raw = read_body(error)
                finally:
                    error.close()
    except ProbeError:
        raise
    except (TimeoutError, socket.timeout):
        raise ProbeError("timeout") from None
    except urllib.error.URLError as error:
        reason = "timeout" if isinstance(error.reason, (TimeoutError, socket.timeout)) else "connection-failed"
        raise ProbeError(reason) from None
    except Exception:
        raise ProbeError("connection-failed") from None
    try:
        payload = decode_json(raw.decode("utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("code"), str):
            raise ValueError()
        if payload["code"] != "0":
            raise ProbeError(api_error(payload["code"]))
        if status != 200:
            raise ProbeError(http_error(status))
        return array(payload.get("data"))
    except ProbeError:
        raise
    except Exception:
        raise ProbeError(http_error(status) if status != 200 else "invalid-response") from None


def array(value):
    if not isinstance(value, list) or len(value) > 2000:
        raise ProbeError("invalid-response")
    return value


def single(value):
    value = array(value)
    if len(value) != 1 or not isinstance(value[0], dict):
        raise ProbeError("invalid-response")
    return value[0]


def decimal(value, signed=True, nullable=False):
    if nullable and value == "":
        return
    if not isinstance(value, str) or not (DECIMAL if signed else NONNEGATIVE).fullmatch(value):
        raise ProbeError("invalid-response")


def timestamp(value):
    if (not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", value)
            or int(value) > 9007199254740991):
        raise ProbeError("invalid-response")


def permissions_report(data):
    row = single(data)
    value = row.get("perm")
    if (not isinstance(value, str) or not 1 <= len(value) <= 512
            or row.get("acctLv") not in {"1", "2", "3", "4"}):
        raise ProbeError("invalid-response")
    permissions = value.split(",")
    if (any(not re.fullmatch(r"[a-z][a-z_]{0,31}", item) for item in permissions)
            or len(set(permissions)) != len(permissions)):
        raise ProbeError("invalid-response")
    return {
        "read": "read_only" in permissions, "trade": "trade" in permissions,
        "withdraw": "withdraw" in permissions,
        "unknownPermissionsPresent": bool(set(permissions) - {"read_only", "trade", "withdraw"}),
    }


def currencies(rows):
    seen = set()
    for row in array(rows):
        if not isinstance(row, dict):
            raise ProbeError("invalid-response")
        value = row.get("ccy")
        if not isinstance(value, str) or not CURRENCY.fullmatch(value) or value in seen:
            raise ProbeError("invalid-response")
        seen.add(value)
    return rows


def trading_assets(data):
    row = single(data)
    timestamp(row.get("uTime"))
    decimal(row.get("totalEq"))
    rows = currencies(row.get("details"))
    for item in rows:
        decimal(item.get("cashBal"))
        decimal(item.get("eq"))
        for field in ("availBal", "availEq", "frozenBal"):
            decimal(item.get(field), signed=field != "frozenBal", nullable=True)
        timestamp(item.get("uTime"))
    return len(rows)


def funding_assets(data):
    rows = currencies(data)
    for item in rows:
        for field in ("bal", "availBal", "frozenBal"):
            decimal(item.get(field), signed=False)
    return len(rows)


def verify_fees(data):
    row = single(data)
    if row.get("instType") != "SPOT" or row.get("instId", "BTC-USDT") != "BTC-USDT":
        raise ProbeError("invalid-response")
    group = single(row.get("feeGroup"))
    if not isinstance(group.get("groupId"), str) or not re.fullmatch(r"[0-9]{1,6}", group["groupId"]):
        raise ProbeError("invalid-response")
    decimal(group.get("maker"))
    decimal(group.get("taker"))
    timestamp(row.get("ts"))
    return True


def base_report(authenticated=False):
    return {"schema": 1, "venue": "okx", "scope": "account-check", "authenticatedRead": authenticated}


def failure_report(code, stage, completed, authenticated):
    report = base_report(authenticated)
    report.update({"errorCode": code if code in ERRORS else "probe-failed",
                   "failedStage": stage, "completedReads": completed})
    return report


def account_report(opener, credentials):
    parsers = (permissions_report, trading_assets, funding_assets, verify_fees)
    values, authenticated = [], False
    for path, stage, parser in zip(PATHS, STAGES, parsers):
        try:
            data = read_payload(opener, path, credentials)
            authenticated = True
            values.append(parser(data))
        except BaseException as error:
            code = error.code if isinstance(error, ProbeError) else "probe-failed"
            return failure_report(code, stage, len(values), authenticated)
    report = base_report(True)
    report.update({"checkedAt": checked_at(), "permissions": values[0],
                   "tradingAssets": values[1], "fundingAssets": values[2], "feeReadVerified": values[3]})
    return report


def serialize_report(report, credentials):
    encoded = json.dumps(report, ensure_ascii=True, separators=(",", ":"))
    if any(value in encoded or json.dumps(value, ensure_ascii=True)[1:-1] in encoded for value in credentials):
        raise ProbeError("output-rejected")
    return encoded


def main():
    credentials, report, stage, raw = None, None, "credentials", None
    try:
        if len(sys.argv) != 1 or sys.stdin.isatty():
            raise ProbeError("invalid-invocation")
        with deadline():
            raw = sys.stdin.buffer.read(MAX_PROBE_INPUT + 1)
            credentials = parse_probe_input(raw)
        stage = "config"
        report = account_report(make_opener(), credentials)
        stage = "output"
        print(serialize_report(report, credentials), flush=True)
        return 0 if report.get("feeReadVerified") is True else 1
    except BaseException as error:
        code = error.code if isinstance(error, ProbeError) else "probe-failed"
        authenticated = report is not None and report.get("authenticatedRead") is True
        completed = (4 if report.get("feeReadVerified") is True else report.get("completedReads", 0)) if report else 0
        failure = failure_report(code, stage, completed, authenticated)
        if stage == "credentials" and raw is not None:
            failure["credentialShape"] = credential_shape(raw)
        try:
            print(serialize_report(failure, credentials or ()), flush=True)
        except BaseException:
            pass  # Pathological short credentials may overlap fixed vocabulary.
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
