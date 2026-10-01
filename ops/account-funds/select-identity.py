#!/usr/bin/python3 -I
"""Select exactly one previously accepted private archive; never discover or replace.

One argument is the reviewed installed release digest. No network, credentials or
exchange calls. Publishes a new private binding directory atomically; interrupted
staging is retained for inspection and prevents blind retries. No identities or
random binding material are ever printed.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

BASE = Path('/home/mil/crypto-account-funds')
IDENTITY_BASE = Path('/home/mil/crypto-account-identity')
UID = 1002
ARCHIVE_ID = 'a9b927eb-a844-47f2-8cfd-1229c42bc0e9'
ARCHIVE_HASH = '139c971fbeb5277d32ab1c44e7178687dd4d8769074407a80fd15b1cbf6127e6'
MAX_TIME = 8640000000000000


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError()


def decode(raw):
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=reject_constant)


def is_hash(value):
    return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None


def clock(value):
    return type(value) is int and 0 < value <= MAX_TIME


def directory(path):
    info = path.lstat()
    if (path.resolve() != path or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != UID or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError()


def private_file(path, bound, executable=False):
    directory(path.parent)
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != UID or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != (0o700 if executable else 0o600) or info.st_size > bound):
            raise ValueError()
        raw = stream.read(bound + 1)
        if len(raw) > bound:
            raise ValueError()
        return raw


def sync(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def verify_release(release_hash):
    if not is_hash(release_hash):
        raise ValueError()
    release = BASE / 'releases' / release_hash
    for path in (BASE, BASE / 'releases', release):
        directory(path)
    raw = private_file(release / 'manifest.json', 512 * 1024)
    if hashlib.sha256(raw).hexdigest() != release_hash:
        raise ValueError()
    manifest = decode(raw)
    required = {'run-once', 'run-enroll', 'package.json', 'dist/scripts/account-funds.js', 'dist/scripts/account-funds-enroll.js'}
    if type(manifest) is not dict or not 5 <= len(manifest) <= 4096 or not required.issubset(manifest):
        raise ValueError()
    total = 0
    expected_dirs = set()
    for relative, digest in manifest.items():
        if (type(relative) is not str or len(relative) > 240 or not re.fullmatch('[A-Za-z0-9_./-]+', relative)
                or relative.startswith('/') or relative == 'manifest.json'
                or any(part in ('', '.', '..') for part in relative.split('/')) or not is_hash(digest)):
            raise ValueError()
        pieces = relative.split('/')
        for i in range(1, len(pieces)):
            parent = '/'.join(pieces[:i]); expected_dirs.add(parent); directory(release / parent)
        content = private_file(release / relative, 8 * 1024 * 1024, relative in ('run-once', 'run-enroll'))
        total += len(content)
        if total > 32 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != digest:
            raise ValueError()
    actual, actual_dirs = set(), set()
    for parent, dirs, files in os.walk(str(release), followlinks=False):
        directory(Path(parent))
        for name in dirs:
            target = Path(parent) / name; directory(target); actual_dirs.add(str(target.relative_to(release)))
        for name in files:
            relative = str((Path(parent) / name).relative_to(release))
            if relative != 'manifest.json': actual.add(relative)
    if actual != set(manifest) or actual_dirs != expected_dirs:
        raise ValueError()


def normalized_identity(row, venue, started, ended):
    fields = {'venue', 'uid', 'mainUid', 'accountType', 'mainAccountConfirmed', 'mainAccountEvidence', 'source', 'requestedAt', 'receivedAt'}
    if (type(row) is not dict or set(row) != fields or row['venue'] != venue
            or not clock(row['requestedAt']) or not clock(row['receivedAt'])
            or not started <= row['requestedAt'] <= row['receivedAt'] <= ended):
        raise ValueError()
    if venue == 'mexc':
        if (type(row['uid']) is not str or not re.fullmatch('[\x21-\x7e]{1,256}', row['uid'])
                or row['mainUid'] is not None or row['accountType'] is not None
                or row['mainAccountConfirmed'] is not False or row['mainAccountEvidence'] != 'not-reported'
                or row['source'] != '/api/v3/uid'):
            raise ValueError()
    elif (type(row['uid']) is not str or not re.fullmatch('[1-9][0-9]{0,63}', row['uid'])
            or row['mainUid'] != row['uid'] or type(row['mainUid']) is not str
            or row['accountType'] != '0' or row['mainAccountConfirmed'] is not True
            or row['mainAccountEvidence'] != 'uid-mainUid-and-account-type' or row['source'] != '/api/v5/account/config'):
        raise ValueError()
    return {name: row[name] for name in ('venue', 'uid', 'mainUid', 'accountType', 'mainAccountConfirmed',
                                        'mainAccountEvidence', 'source', 'requestedAt', 'receivedAt')}


def selected_identities(raw, selected_at):
    if hashlib.sha256(raw).hexdigest() != ARCHIVE_HASH:
        raise ValueError()
    report = decode(raw)
    fields = {'schema', 'kind', 'archiveId', 'startedAt', 'endedAt', 'environment', 'identityEnrolled', 'fundsBound', 'executable', 'requestCount', 'mexc', 'okx'}
    if (type(report) is not dict or set(report) != fields or type(report['schema']) is not int or report['schema'] != 1
            or report['kind'] != 'account-identity-observation' or report['archiveId'] != ARCHIVE_ID
            or report['environment'] != 'mainnet' or report['identityEnrolled'] is not False
            or report['fundsBound'] is not False or report['executable'] is not False
            or type(report['requestCount']) is not int or report['requestCount'] != 2
            or not clock(report['startedAt']) or not clock(report['endedAt']) or not clock(selected_at)
            or not report['startedAt'] <= report['endedAt'] <= selected_at
            or report['endedAt'] - report['startedAt'] >= 20000):
        raise ValueError()
    identities = {venue: normalized_identity(report[venue], venue, report['startedAt'], report['endedAt']) for venue in ('mexc', 'okx')}
    if identities['mexc']['receivedAt'] > identities['okx']['requestedAt']:
        raise ValueError()
    return identities


def write_exclusive(path, raw):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(raw); output.flush(); os.fsync(output.fileno())


def select(release_hash):
    if os.getuid() != UID:
        raise ValueError()
    verify_release(release_hash)
    for path in (IDENTITY_BASE, IDENTITY_BASE / 'state'):
        directory(path)
    selected_at = int(time.time() * 1000)
    raw = private_file(IDENTITY_BASE / 'state' / ('identity-' + ARCHIVE_ID + '.json'), 16 * 1024)
    identities = selected_identities(raw, selected_at)
    lockfd = os.open(str(BASE / '.selection.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, 'r+') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != UID or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError()
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        destination, staging = BASE / 'binding', BASE / '.binding-staging'
        if destination.exists() or destination.is_symlink() or staging.exists() or staging.is_symlink():
            raise ValueError()
        staging.mkdir(mode=0o700); sync(BASE)
        receipt = {'schema': 1, 'kind': 'account-identity-observation-receipt', 'archiveId': ARCHIVE_ID, 'archiveHash': ARCHIVE_HASH}
        selection = {'schema': 1, 'kind': 'explicit-account-selection',
                     'selection': {'kind': 'explicit-accepted-observation', 'receipt': receipt, 'selectedAt': selected_at},
                     'sourceHash': release_hash, 'bundleVersion': str(uuid.uuid4()), 'identities': identities}
        write_exclusive(staging / 'selection.json', (json.dumps(selection, separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8'))
        write_exclusive(staging / 'binding-key', os.urandom(32)); sync(staging)
        if destination.exists() or destination.is_symlink():
            raise ValueError()
        staging.rename(destination); sync(BASE)
    return {'schema': 1, 'selectionWritten': True, 'previousReceiptVerified': True, 'sourceHash': release_hash,
            'privateBinding': True, 'pinWritten': False, 'identityEnrolled': False, 'keysDelivered': False, 'requestCount': 0}


def main():
    if len(sys.argv) != 2:
        raise ValueError()
    print(json.dumps(select(sys.argv[1]), separators=(',', ':')))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception:
        print('{"schema":1,"error":"funds-selection-failed"}')
        sys.exit(1)
