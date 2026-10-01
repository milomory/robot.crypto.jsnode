#!/usr/bin/python3 -I
"""Strict metadata-only OKX probe output boundary. No credential/runtime access."""
import datetime
import json
import re

MAX_REPORT_BYTES = 8192
ERRORS = frozenset({
    'invalid-credentials', 'credential-set-missing', 'missing-passphrase',
    'invalid-response', 'response-too-large', 'timeout', 'redirect-refused',
    'authentication-failed', 'access-denied', 'rate-limited', 'clock-skew',
    'api-rejected', 'connection-failed', 'output-rejected', 'invalid-invocation',
    'probe-failed', 'ip-not-allowed', 'region-or-key-mismatch', 'environment-mismatch',
    'bridge-failed', 'operation-failed', 'setup-failed',
})
BASE = frozenset({'schema', 'venue', 'scope', 'authenticatedRead'})
SUCCESS = BASE | {'checkedAt', 'tradingAssets', 'fundingAssets', 'permissions', 'feeReadVerified'}
FAILURE = BASE | {'errorCode', 'failedStage', 'completedReads'}
SHAPE_FIELDS = frozenset({'format', 'apiKeyPresent', 'apiSecretPresent', 'passphrasePresent', 'unknownFields', 'duplicateFields'})
SHAPE_FORMATS = frozenset({'json-object', 'json-other', 'labelled-text', 'unrecognised-text'})
PERMISSIONS = frozenset({'read', 'trade', 'withdraw', 'unknownPermissionsPresent'})
STAGES = {'credentials': 0, 'config': 0, 'trading-balance': 1, 'funding-balance': 2, 'trade-fee': 3, 'output': None}


class ReportError(ValueError):
    def __init__(self):
        super().__init__('report-rejected')


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ReportError()
        result[key] = value
    return result


def reject_constant(_value):
    raise ReportError()


def decode_report(raw):
    try:
        if type(raw) is not bytes or not 0 < len(raw) <= MAX_REPORT_BYTES:
            raise ReportError()
        return validate_report(json.loads(raw.decode('utf8'), object_pairs_hook=unique_pairs,
                                          parse_constant=reject_constant))
    except Exception:
        raise ReportError() from None


def validate_report(value):
    try:
        if (type(value) is not dict or type(value.get('schema')) is not int or value['schema'] != 1
                or value.get('venue') != 'okx' or value.get('scope') != 'account-check'
                or type(value.get('authenticatedRead')) is not bool):
            raise ReportError()
        base = {'schema': 1, 'venue': 'okx', 'scope': 'account-check', 'authenticatedRead': value['authenticatedRead']}
        if set(value) == FAILURE or set(value) == FAILURE | {'credentialShape'}:
            stage, count, error = value['failedStage'], value['completedReads'], value['errorCode']
            if (type(stage) is not str or stage not in STAGES or type(count) is not int or not 0 <= count <= 4
                    or type(error) is not str or error not in ERRORS
                    or STAGES[stage] is not None and count != STAGES[stage]
                    or count > 0 and not value['authenticatedRead']
                    or stage == 'credentials' and value['authenticatedRead']):
                raise ReportError()
            result = dict(base, errorCode=error, failedStage=stage, completedReads=count)
            if 'credentialShape' in value:
                shape = value['credentialShape']
                if (stage != 'credentials' or type(shape) is not dict or set(shape) != SHAPE_FIELDS
                        or type(shape['format']) is not str or shape['format'] not in SHAPE_FORMATS
                        or type(shape['unknownFields']) is not int or not 0 <= shape['unknownFields'] <= 100
                        or any(type(shape[key]) is not bool for key in
                               ['apiKeyPresent', 'apiSecretPresent', 'passphrasePresent', 'duplicateFields'])):
                    raise ReportError()
                result['credentialShape'] = dict(shape)
            return result
        if set(value) != SUCCESS or value['authenticatedRead'] is not True or value['feeReadVerified'] is not True:
            raise ReportError()
        checked = value['checkedAt']
        if type(checked) is not str or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', checked):
            raise ReportError()
        datetime.datetime.strptime(checked, '%Y-%m-%dT%H:%M:%SZ')
        for name in ('tradingAssets', 'fundingAssets'):
            if type(value[name]) is not int or not 0 <= value[name] <= 2000:
                raise ReportError()
        permissions = value['permissions']
        if (type(permissions) is not dict or set(permissions) != PERMISSIONS
                or any(type(v) is not bool for v in permissions.values())):
            raise ReportError()
        return dict(base, checkedAt=checked, tradingAssets=value['tradingAssets'], fundingAssets=value['fundingAssets'],
                    permissions=dict(permissions), feeReadVerified=True)
    except Exception:
        raise ReportError() from None
