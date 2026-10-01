#!/usr/bin/env python3
"""Independent, read-only historical fee capture acceptance. Python 3.6.

Arguments are public release hash, archive UUID, archive SHA256. No network,
subprocess, writes, account key access, raw rates/UIDs/timestamps in output.
"""
from collections import OrderedDict
from decimal import Decimal, localcontext
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys

UID = 1002
BASE = Path('/home/mil/crypto-account-fees')
BOUND = Path('/home/mil/crypto-account-funds')
OLD_RELEASE = 'da4ad8a2e69855c9a49e1556287e55b2a7703e6e3aa67efe115969fb8105d7c5'
HASH = re.compile(r'^[a-f0-9]{64}$')
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
RATE = re.compile(r'^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?(?:[eE][+-]?\d{1,3})?$')
COST = re.compile(r'^(?:0(?:\.\d{1,30})?|1(?:\.0{1,30})?)$')
BLOCKERS = ('fee-currency-unconfirmed', 'mx-fee-conversion-unconfirmed', 'source-time-unavailable',
            'source-time-in-future', 'source-time-stale', 'rate-precision-over-18')
IDENTITY_KEYS = ('venue', 'uid', 'mainUid', 'accountType', 'mainAccountConfirmed', 'mainAccountEvidence', 'source', 'requestedAt', 'receivedAt')
PIN_KEYS = ('schema', 'kind', 'selection', 'identities', 'context', 'references', 'sourceHash', 'policyHash', 'bundleVersion',
            'credentialFingerprint', 'identitySelectionBound', 'mexcMainStatus', 'okxMainStatus', 'fundsVerified', 'admissionAllowed', 'executable')
POLICY = ('account-binding-v1;explicit-accepted-identity-selection;hmac-sha256-private-key-32;'
          'exact-credentials-references-origins-mainnet-global;opaque-mexc-uid-visible-ascii-1-256;'
          'okx-main-uid-type-consistent;mexc-main-unverified;capture-ms<=30000;age-from-start-ms<=60000;'
          'four-sequential-identity-funds-requests;mexc-then-okx;no-auto-enrollment;no-funds-admission')


def require(condition):
    if not condition:
        raise ValueError('private-fees-verification-failed')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def private_directory(path):
    info = path.lstat()
    require(path.resolve() == path and stat.S_ISDIR(info.st_mode) and info.st_uid == UID
            and stat.S_IMODE(info.st_mode) == 0o700)


def private_read(path, limit):
    require(path.is_absolute() and path.resolve() == path)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid == UID and stat.S_IMODE(before.st_mode) == 0o600
            and before.st_nlink == 1 and 0 < before.st_size <= limit)
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino))
        chunks, count = [], 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
            require(count <= limit)
        after = os.fstat(fd)
        require((opened.st_uid, opened.st_mode, opened.st_nlink, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                == (after.st_uid, after.st_mode, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns))
        require(count == before.st_size and path.lstat().st_ino == opened.st_ino)
        return b''.join(chunks)
    finally:
        os.close(fd)


def unique(pairs):
    result = OrderedDict()
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def no_constant(value):
    raise ValueError('private-fees-verification-failed')


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def decode(raw, canonical=True):
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=no_constant)
    if canonical:
        require(dumps(value) + b'\n' == raw)
    return value


def keys(value, expected, ordered=False):
    require(type(value) in (dict, OrderedDict) and (list(value) == list(expected) if ordered else set(value) == set(expected)))


def timestamp(value):
    require(type(value) is int and 0 < value <= 8640000000000000)
    return value


def identity(value, venue):
    keys(value, IDENTITY_KEYS)
    require(value['venue'] == venue and timestamp(value['receivedAt']) >= timestamp(value['requestedAt']))
    require(type(value['uid']) is str)
    if venue == 'mexc':
        require(re.fullmatch(r'[\x21-\x7e]{1,256}', value['uid']) is not None and value['mainUid'] is None
                and value['accountType'] is None and value['mainAccountConfirmed'] is False
                and value['mainAccountEvidence'] == 'not-reported' and value['source'] == '/api/v3/uid')
    else:
        require(re.fullmatch(r'[1-9]\d{0,63}', value['uid']) is not None and type(value['mainUid']) is str
                and re.fullmatch(r'[1-9]\d{0,63}', value['mainUid']) is not None)
        require(value['accountType'] == '0' and value['uid'] == value['mainUid'] and value['mainAccountConfirmed'] is True
                and value['mainAccountEvidence'] == 'uid-mainUid-and-account-type' and value['source'] == '/api/v5/account/config')
    return OrderedDict((key, value[key]) for key in IDENTITY_KEYS if key not in ('requestedAt', 'receivedAt'))


def normalized_cost(raw, venue):
    require(type(raw) is str and len(raw) <= 96 and RATE.fullmatch(raw) is not None)
    exponent = re.search(r'[eE]([+-]?\d+)$', raw)
    require(exponent is None or abs(int(exponent.group(1))) <= 100)
    with localcontext() as context:
        context.prec = 256
        number = Decimal(raw)
        if number == 0:
            return '0'
        require(abs(number) <= 1 and (venue != 'mexc' or number > 0))
        text = format(abs(number), 'f')
        if '.' in text:
            text = text.rstrip('0').rstrip('.')
        require(COST.fullmatch(text) is not None)
        return '0' if venue == 'okx' and number > 0 else text


def snapshot(value, venue, pin):
    keys(value, ('schema', 'environment', 'symbol', 'identityAccepted', 'executable', 'blockers', 'venue', 'origin', 'requestCount', 'identity', 'fees', 'configuration'))
    require(type(value['schema']) is int and value['schema'] == 1 and value['environment'] == 'mainnet'
            and value['symbol'] == 'BTC/USDT' and value['identityAccepted'] is True and value['executable'] is False
            and value['venue'] == venue and type(value['requestCount']) is int and value['requestCount'] == (3 if venue == 'mexc' else 2)
            and value['origin'] == ('https://api.mexc.com' if venue == 'mexc' else 'https://www.okx.com'))
    require(identity(value['identity'], venue) == identity(pin['identities'][venue], venue))
    fee, config = value['fees'], value['configuration']
    keys(fee, ('requestedAt', 'receivedAt', 'sourceUpdatedAt', 'makerRateRaw', 'takerRateRaw', 'makerCostRate', 'takerCostRate', 'source', 'rateConvention', 'feeGroupId'))
    require(timestamp(fee['receivedAt']) >= timestamp(fee['requestedAt']))
    require(fee['makerCostRate'] == normalized_cost(fee['makerRateRaw'], venue)
            and fee['takerCostRate'] == normalized_cost(fee['takerRateRaw'], venue))
    reasons = []
    intervals = [value['identity'], fee]
    if venue == 'mexc':
        require(fee['source'] == '/api/v3/tradeFee?symbol=BTCUSDT' and fee['rateConvention'] == 'positive-fee' and fee['feeGroupId'] is None)
        keys(config, ('requestedAt', 'receivedAt', 'source', 'mxDeductEnabled', 'feeCurrencyMode'))
        require(config['source'] == '/api/v3/mxDeduct/enable' and type(config['mxDeductEnabled']) is bool
                and config['feeCurrencyMode'] == 'unknown')
        reasons.append('fee-currency-unconfirmed')
        if config['mxDeductEnabled']:
            reasons.append('mx-fee-conversion-unconfirmed')
        intervals.append(config)
    else:
        require(fee['source'] == '/api/v5/account/trade-fee?instType=SPOT&instId=BTC-USDT'
                and fee['rateConvention'] == 'negative-fee-positive-rebate' and type(fee['feeGroupId']) is str
                and re.fullmatch(r'\d{1,6}', fee['feeGroupId']) is not None)
        keys(config, ('feeType', 'feeCurrencyMode'))
        require(config['feeType'] in ('0', '1', None))
        expected = 'received-asset' if config['feeType'] == '0' else 'quote' if config['feeType'] == '1' else 'unknown'
        require(config['feeCurrencyMode'] == expected)
        if expected == 'unknown':
            reasons.append('fee-currency-unconfirmed')
    source = fee['sourceUpdatedAt']
    if source is None:
        reasons.append('source-time-unavailable')
    else:
        require(type(source) is str and re.fullmatch(r'[1-9]\d{0,15}', source) is not None)
        source_at = timestamp(int(source))
        if source_at > fee['receivedAt']:
            reasons.append('source-time-in-future')
        elif fee['requestedAt'] - source_at > 60000:
            reasons.append('source-time-stale')
    if any(len(fee[name].split('.')[1]) > 18 for name in ('makerCostRate', 'takerCostRate') if '.' in fee[name]):
        reasons.append('rate-precision-over-18')
    require(type(value['blockers']) is list and all(item in BLOCKERS for item in value['blockers']) and value['blockers'] == reasons)
    return intervals, reasons


def main(argv):
    require(len(argv) == 4)
    release, archive_id, archive_hash = argv[1:]
    require(HASH.fullmatch(release) is not None and UUID.fullmatch(archive_id) is not None and HASH.fullmatch(archive_hash) is not None and release != OLD_RELEASE)
    new_release, old_release, binding, state = BASE / 'releases' / release, BOUND / 'releases' / OLD_RELEASE, BOUND / 'binding', BASE / 'state'
    for directory in (BASE, BASE / 'releases', new_release, BOUND, BOUND / 'releases', old_release, binding, state):
        private_directory(directory)
    old_manifest = private_read(old_release / 'manifest.json', 512 * 1024)
    new_manifest = private_read(new_release / 'manifest.json', 512 * 1024)
    require(digest(old_manifest) == OLD_RELEASE and digest(new_manifest) == release)
    for raw in (old_manifest, new_manifest):
        manifest = decode(raw, False)
        require(type(manifest) in (dict, OrderedDict) and 3 <= len(manifest) <= 4096)
        require(all(type(name) is str and type(value) is str and HASH.fullmatch(value) is not None for name, value in manifest.items()))
    pin_raw = private_read(binding / 'pin.json', 64 * 1024)
    selection = decode(private_read(binding / 'selection.json', 16 * 1024))
    pin = decode(pin_raw)
    key = private_read(binding / 'binding-key', 32)
    require(len(key) == 32)
    keys(pin, PIN_KEYS + ('pinIntegrity',), True)
    keys(pin['selection'], ('kind', 'receipt', 'selectedAt'), True)
    keys(pin['identities'], ('mexc', 'okx'), True)
    for venue in ('mexc', 'okx'):
        keys(pin['identities'][venue], IDENTITY_KEYS, True)
        identity(pin['identities'][venue], venue)
    keys(pin['context'], ('environment', 'region', 'origins'), True)
    keys(pin['context']['origins'], ('mexc', 'okx'), True)
    keys(pin['references'], ('mexc', 'okx', 'okxPassphrase'), True)
    keys(pin['selection']['receipt'], ('schema', 'kind', 'archiveId', 'archiveHash'), True)
    body = OrderedDict((name, pin[name]) for name in PIN_KEYS)
    computed = hmac.new(key, b'crypto-account-binding/pin/v1\0' + dumps(body), hashlib.sha256).hexdigest()
    require(type(pin['pinIntegrity']) is str and hmac.compare_digest(computed, pin['pinIntegrity']))
    require(pin['sourceHash'] == OLD_RELEASE and pin['policyHash'] == digest(POLICY.encode('ascii'))
            and pin['kind'] == 'account-binding-pin' and type(pin['schema']) is int and pin['schema'] == 1
            and pin['identitySelectionBound'] is True and pin['mexcMainStatus'] == 'user-declared-unverified'
            and pin['okxMainStatus'] == 'exchange-confirmed' and pin['fundsVerified'] is False
            and pin['admissionAllowed'] is False and pin['executable'] is False)
    require(pin['context'] == {'environment': 'mainnet', 'region': 'global', 'origins': {'mexc': 'https://api.mexc.com', 'okx': 'https://www.okx.com'}})
    require(pin['references'] == {'mexc': 'secret://inbox/public-review-record-b11569db2351',
        'okx': 'secret://inbox/public-review-record-e8115fd14c14', 'okxPassphrase': 'secret://inbox/public-review-record-1425c23b6554'})
    keys(selection, ('schema', 'kind', 'selection', 'sourceHash', 'bundleVersion', 'identities'))
    require(type(selection['schema']) is int and selection['schema'] == 1 and selection['kind'] == 'explicit-account-selection'
            and selection['sourceHash'] == OLD_RELEASE and selection['bundleVersion'] == pin['bundleVersion']
            and selection['selection'] == pin['selection'] and selection['identities'] == pin['identities'])
    archive_raw = private_read(state / ('fees-' + archive_id + '.json'), 128 * 1024)
    require(digest(archive_raw) == archive_hash)
    archive = decode(archive_raw)
    keys(archive, ('schema', 'kind', 'archiveId', 'startedAt', 'endedAt', 'environment', 'selectionReceipt', 'bundleVersion', 'pinHash',
                  'bindingSourceHash', 'collectorSourceHash', 'identityEnrolled', 'feesBound', 'feeAdmission', 'executable', 'requestCount', 'mexc', 'okx'))
    require(type(archive['schema']) is int and archive['schema'] == 1 and archive['kind'] == 'account-fees-observation'
            and archive['archiveId'] == archive_id and archive['environment'] == 'mainnet' and archive['selectionReceipt'] == pin['selection']['receipt']
            and archive['bundleVersion'] == pin['bundleVersion'] and archive['pinHash'] == digest(pin_raw)
            and archive['bindingSourceHash'] == OLD_RELEASE and archive['collectorSourceHash'] == release
            and archive['identityEnrolled'] is True and archive['feesBound'] is True and archive['feeAdmission'] is False
            and archive['executable'] is False and type(archive['requestCount']) is int and archive['requestCount'] == 5)
    intervals, blockers = [], {}
    for venue in ('mexc', 'okx'):
        observed, blockers[venue] = snapshot(archive[venue], venue, pin)
        intervals.extend(observed)
    sequence = [timestamp(archive['startedAt'])]
    for observed in intervals:
        sequence.extend((timestamp(observed['requestedAt']), timestamp(observed['receivedAt'])))
    sequence.append(timestamp(archive['endedAt']))
    require(len(intervals) == 5 and all(left <= right for left, right in zip(sequence, sequence[1:]))
            and archive['endedAt'] - archive['startedAt'] <= 30000
            and timestamp(pin['selection']['selectedAt']) <= archive['startedAt'])
    # Deliberately no wall-clock freshness check: this is historical acceptance.
    return {'schema': 1, 'accepted': True, 'readOnly': True, 'privateFilesVerified': True, 'manifestHashesVerified': True,
            'pinHmacVerified': True, 'selectionBound': True, 'identitiesMatched': True, 'fiveFixedReadsVerified': True,
            'captureTimingVerified': True, 'exactRatesVerified': True, 'derivedModesAndBlockersVerified': True,
            'freshAtAcceptanceNotAsserted': True, 'credentialsRechecked': False, 'executable': False,
            'mexc': {'blockers': blockers['mexc']}, 'okx': {'blockers': blockers['okx']},
            'receipt': {'schema': 1, 'kind': 'account-fees-observation-receipt', 'archiveId': archive_id, 'archiveHash': archive_hash},
            'collectorSourceHash': release, 'bindingSourceHash': OLD_RELEASE}


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv), separators=(',', ':'), sort_keys=True))
    except BaseException:
        print('{"schema":1,"error":"private-fees-verification-failed"}')
        sys.exit(1)
