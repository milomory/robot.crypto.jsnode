#!/usr/bin/python3 -I
"""Strict projection for public MEXC probe output; no secret or runtime access."""
import datetime
import json
import re

MAX_REPORT_BYTES = 256 * 1024
MAX_ASSETS = 5000
AMOUNT = re.compile(r"(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,30})?\Z")
CURRENCY = re.compile(r"[A-Z0-9][A-Z0-9._-]{0,31}\Z")
CHECKED_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")
ERRORS = frozenset({
    "invalid-credentials", "credential-pair-missing", "invalid-response", "response-too-large", "timeout",
    "redirect-refused", "authentication-failed", "access-denied", "rate-limited",
    "clock-skew", "api-rejected", "connection-failed", "output-rejected",
    "invalid-invocation", "probe-failed",
})
BASE_FIELDS = frozenset({"schema", "venue", "scope", "authenticatedRead"})
SUCCESS_FIELDS = BASE_FIELDS | {"checkedAt", "totalAssets", "zeroAssets", "balances"}
ERROR_FIELDS = BASE_FIELDS | {"error"}
BALANCE_FIELDS = frozenset({"currency", "free", "locked", "available"})


class ReportError(ValueError):
    def __init__(self):
        super().__init__("report-rejected")


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ReportError()
        result[key] = value
    return result


def _reject_constant(_value):
    raise ReportError()


def decode_report(raw):
    """Parse bounded UTF-8 JSON, refusing duplicate fields and non-finite values."""
    try:
        if type(raw) is not bytes or not 0 < len(raw) <= MAX_REPORT_BYTES:
            raise ReportError()
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs,
                           parse_constant=_reject_constant)
        return validate_report(value)
    except Exception:
        raise ReportError() from None


def validate_report(value):
    """Return only known public fields; reject additions rather than echoing them."""
    try:
        if (type(value) is not dict or type(value.get("schema")) is not int
                or value["schema"] != 1 or value.get("venue") != "mexc"
                or value.get("scope") != "spot"
                or type(value.get("authenticatedRead")) is not bool):
            raise ReportError()
        base = {"schema": 1, "venue": "mexc", "scope": "spot",
                "authenticatedRead": value["authenticatedRead"]}
        if value["authenticatedRead"] is False:
            if (set(value) != ERROR_FIELDS or type(value.get("error")) is not str
                    or value["error"] not in ERRORS):
                raise ReportError()
            return {**base, "error": value["error"]}
        if set(value) != SUCCESS_FIELDS:
            raise ReportError()
        checked_at = value["checkedAt"]
        if type(checked_at) is not str or not CHECKED_AT.fullmatch(checked_at):
            raise ReportError()
        datetime.datetime.strptime(checked_at, "%Y-%m-%dT%H:%M:%SZ")
        total, zero = value["totalAssets"], value["zeroAssets"]
        if (type(total) is not int or not 0 <= total <= MAX_ASSETS
                or type(zero) is not int or not 0 <= zero <= total):
            raise ReportError()
        rows = value["balances"]
        if type(rows) is not list or len(rows) != total - zero:
            raise ReportError()
        selected, seen = [], set()
        for row in rows:
            if type(row) is not dict or set(row) != BALANCE_FIELDS:
                raise ReportError()
            currency = row["currency"]
            if (type(currency) is not str or not CURRENCY.fullmatch(currency)
                    or currency in seen):
                raise ReportError()
            seen.add(currency)
            amounts = {}
            for field in ("free", "locked", "available"):
                amount = row[field]
                if field == "available" and amount is None:
                    amounts[field] = None
                    continue
                if type(amount) is not str or not AMOUNT.fullmatch(amount):
                    raise ReportError()
                amounts[field] = amount
            if not any(re.search(r"[1-9]", amount) for amount in amounts.values()
                       if amount is not None):
                raise ReportError()
            selected.append({"currency": currency, **amounts})
        return {**base, "checkedAt": checked_at, "totalAssets": total,
                "zeroAssets": zero, "balances": selected}
    except Exception:
        raise ReportError() from None
