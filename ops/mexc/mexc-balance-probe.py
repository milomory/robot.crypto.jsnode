#!/usr/bin/env python3
"""One-shot MEXC spot balance read; credentials arrive only on protected stdin."""
import datetime
import hashlib
import hmac
import json
import re
import signal
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_INPUT = 16 * 1024
MAX_BODY = 256 * 1024
DEADLINE_SECONDS = 20
ORIGIN = "https://api.mexc.com/api/v3/account"
AMOUNT = re.compile(r"(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,30})?\Z")
CURRENCY = re.compile(r"[A-Z0-9][A-Z0-9._-]{0,31}\Z")
ERRORS = frozenset({
    "invalid-credentials", "credential-pair-missing", "invalid-response", "response-too-large", "timeout",
    "redirect-refused", "authentication-failed", "access-denied", "rate-limited",
    "clock-skew", "api-rejected", "connection-failed", "output-rejected",
    "invalid-invocation", "probe-failed",
})


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


def parse_credentials(raw):
    try:
        if not isinstance(raw, bytes) or not raw or len(raw) > MAX_INPUT:
            raise ValueError()
        text = raw.decode("utf-8").strip()
        if text.startswith("{"):
            value = decode_json(text)
            if not isinstance(value, dict):
                raise ValueError()
            if set(value) == {"Access Key", "Secret Key"}:
                value = {"apiKey": value["Access Key"], "apiSecret": value["Secret Key"]}
            elif set(value) == {"accessKey", "secretKey"}:
                value = {"apiKey": value["accessKey"], "apiSecret": value["secretKey"]}
            simple = {"apiKey", "apiSecret"}
            full = simple | {"schema", "venue", "environment", "region"}
            if set(value) == full:
                if (type(value["schema"]) is not int or value["schema"] != 1
                        or value["venue"] != "mexc"
                        or value["environment"] != "mainnet"
                        or value["region"] != "global"):
                    raise ValueError()
            elif set(value) != simple:
                raise ValueError()
        else:
            # Recognize exactly two labelled fields, including the UI's single-line
            # "MEXC API / Access Key: ... Secret Key: ..." representation. No guessing
            # of field order for unlabeled values or extraction from arbitrary prose.
            label_key = r"(?:Access Key|API Key|apiKey)"
            label_secret = r"(?:Secret Key|API Secret|apiSecret)"
            prefix = r"(?:MEXC[ \t]+API[ \t]*(?:[:/]?[ \t\r\n]+))?"
            normal = prefix + label_key + r":[ \t]*(\S+)\s+" + label_secret + r":[ \t]*(\S+)"
            reverse = prefix + label_secret + r":[ \t]*(\S+)\s+" + label_key + r":[ \t]*(\S+)"
            match = re.fullmatch(normal, text, re.IGNORECASE)
            reversed_match = re.fullmatch(reverse, text, re.IGNORECASE) if not match else None
            if match:
                value = {"apiKey": match[1], "apiSecret": match[2]}
            elif reversed_match:
                value = {"apiKey": reversed_match[2], "apiSecret": reversed_match[1]}
            elif re.fullmatch(r"[A-Za-z0-9_-]{8,1024}", text):
                raise ProbeError("credential-pair-missing")
            else:
                raise ValueError()
        api_key, api_secret = value["apiKey"], value["apiSecret"]
        if (not isinstance(api_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", api_key)
                or not isinstance(api_secret, str)
                or not re.fullmatch(r"[\x21-\x7e]{1,1024}", api_secret)):
            raise ValueError()
        return api_key, api_secret
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("invalid-credentials") from None


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ProbeError("redirect-refused")


def make_opener():
    context = ssl.create_default_context()
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context),
        RefuseRedirects(),
    )
    opener.addheaders = []
    return opener


def api_error(code):
    if type(code) is not int:
        return "api-rejected"
    if code in {429, 418}:
        return "rate-limited"
    if code in {700003, 10073}:
        return "clock-skew"
    if code == 403:
        return "access-denied"
    if code in {400, 401, 602, 10072, 700001, 700002, 700006, 700007}:
        return "authentication-failed"
    return "api-rejected"


def read_payload(opener, api_key, api_secret):
    query = urllib.parse.urlencode({"recvWindow": "5000", "timestamp": str(int(time.time() * 1000))})
    signature = hmac.new(api_secret.encode("ascii"), query.encode("ascii"), hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        ORIGIN + "?" + query + "&signature=" + signature,
        headers={"X-MEXC-APIKEY": api_key, "Accept": "application/json", "Accept-Encoding": "identity"},
        method="GET",
    )
    try:
        with opener.open(request, timeout=DEADLINE_SECONDS) as response:
            if response.status != 200:
                raise ProbeError("api-rejected")
            length = response.headers.get("Content-Length")
            if length is not None:
                if not re.fullmatch(r"[0-9]{1,12}", length):
                    raise ProbeError("invalid-response")
                if int(length) > MAX_BODY:
                    raise ProbeError("response-too-large")
            chunks, total = [], 0
            while True:
                chunk = response.read(min(16384, MAX_BODY + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BODY:
                    raise ProbeError("response-too-large")
                chunks.append(chunk)
            raw = b"".join(chunks)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        reason = {401: "authentication-failed", 403: "access-denied", 418: "rate-limited", 429: "rate-limited"}.get(status, "api-rejected")
        if 300 <= status < 400:
            reason = "redirect-refused"
        raise ProbeError(reason) from None
    except ProbeError:
        raise
    except TimeoutError:
        raise ProbeError("timeout") from None
    except Exception:
        raise ProbeError("connection-failed") from None
    try:
        payload = decode_json(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError()
        if "code" in payload:
            if type(payload["code"]) is not int:
                raise ValueError()
            if payload["code"] != 0:
                raise ProbeError(api_error(payload["code"]))
        return payload
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("invalid-response") from None


def balance_report(payload):
    try:
        if payload.get("accountType") != "SPOT":
            raise ValueError()
        balances = payload.get("balances")
        if not isinstance(balances, list) or len(balances) > 5000:
            raise ValueError()
        selected, seen, zero_assets = [], set(), 0
        for row in balances:
            if not isinstance(row, dict):
                raise ValueError()
            currency = row.get("asset")
            if not isinstance(currency, str) or not CURRENCY.fullmatch(currency) or currency in seen:
                raise ValueError()
            seen.add(currency)
            amounts = {}
            for field in ("free", "locked", "available"):
                if field == "available" and field not in row:
                    amounts[field] = None
                    continue
                value = row.get(field)
                if not isinstance(value, str) or not AMOUNT.fullmatch(value):
                    raise ValueError()
                amounts[field] = value
            if not any(re.search(r"[1-9]", value) for value in amounts.values() if value is not None):
                zero_assets += 1
            else:
                selected.append({"currency": currency, **amounts})
        return {
            "schema": 1, "venue": "mexc", "scope": "spot",
            "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "authenticatedRead": True, "totalAssets": len(balances),
            "zeroAssets": zero_assets, "balances": selected,
        }
    except Exception:
        raise ProbeError("invalid-response") from None


def serialize_report(report, credentials):
    encoded = json.dumps(report, ensure_ascii=True, separators=(",", ":"))
    if any(value in encoded or json.dumps(value, ensure_ascii=True)[1:-1] in encoded for value in credentials):
        raise ProbeError("output-rejected")
    return encoded


def expired(_signum, _frame):
    raise ProbeError("timeout")


def main():
    credentials = None
    try:
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(DEADLINE_SECONDS)
        if len(sys.argv) != 1 or sys.stdin.isatty():
            raise ProbeError("invalid-invocation")
        credentials = parse_credentials(sys.stdin.buffer.read(MAX_INPUT + 1))
        report = balance_report(read_payload(make_opener(), *credentials))
        encoded = serialize_report(report, credentials)
        print(encoded, flush=True)
        return 0
    except BaseException as error:
        code = error.code if isinstance(error, ProbeError) else "probe-failed"
        report = {"schema": 1, "venue": "mexc", "scope": "spot", "authenticatedRead": False, "error": code}
        # A pathological short credential can overlap fixed vocabulary: stay silent.
        try:
            encoded = serialize_report(report, credentials or ())
            print(encoded, flush=True)
        except BaseException:
            pass
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
