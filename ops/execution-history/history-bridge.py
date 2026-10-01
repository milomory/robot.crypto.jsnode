#!/usr/bin/python3 -I
"""Three exact broker records to one fixed read-only history capture.

Secrets remain in memory/stdin; stdout is a strict projection of observation
metadata. No SSH command argument, environment override or secret file exists.
"""
import argparse
import datetime
import grp
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import socket
import stat
import struct
import subprocess
import sys
sys.dont_write_bytecode = True

DESTINATION = 'hyperion.crypto-execution-history'
SOCKET = '/run/agent-secrets-broker/crypto-execution-history.sock'
MEXC_FORMAT = '/usr/local/libexec/crypto-execution-history-mexc-format.py'
MEXC_PROBE = '/usr/local/libexec/crypto-execution-history-mexc-probe.py'
OKX_PROBE = '/usr/local/libexec/crypto-execution-history-okx-probe.py'
PIN = '/usr/local/libexec/crypto-execution-history-pin.json'
MAX_BYTES = 16384
MAX_REPORT = 4096
PARTS = (('mexc', b'M'), ('okx-keypair', b'K'), ('okx-passphrase', b'P'))
PART_MARKERS = dict(PARTS)
FAILURE = {'schema': 1, 'error': 'history-failed'}


def wipe(raw):
    raw[:] = b'\0' * len(raw)


def receive_exact(conn, size):
    data = bytearray()
    try:
        while len(data) < size:
            part = conn.recv(size - len(data))
            if not part or len(part) > size - len(data):
                raise ValueError()
            data.extend(part)
        return data
    except Exception:
        wipe(data)
        raise


def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def reject_constant(_value):
    raise ValueError()


def decode_report(raw):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_REPORT:
        raise ValueError()
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_pairs,
                       parse_constant=reject_constant)
    if type(value) is not dict or type(value.get('schema')) is not int or value['schema'] != 1:
        raise ValueError()
    if value == FAILURE:
        return dict(FAILURE)
    fields = {'schema', 'mode', 'captureId', 'checkedAt', 'venues', 'reportWritten', 'executable'}
    if (set(value) != fields or value['mode'] != 'execution-history-readonly'
            or value['reportWritten'] is not True or value['executable'] is not False
            or type(value['captureId']) is not str
            or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value['captureId'])):
        raise ValueError()
    venues = value['venues']
    if type(venues) is not dict or set(venues) != {'mexc', 'okx'}:
        raise ValueError()
    bounds = {'requests': 12, 'successfulRequests': 12, 'discoveredOrders': 3000,
              'capturedOrders': 2, 'fillRows': 5000, 'billRows': 300, 'errors': 30}
    for venue in ('mexc', 'okx'):
        item = venues[venue]
        if (type(item) is not dict or set(item) != set(bounds) | {'truncated'}
                or type(item['truncated']) is not bool
                or any(type(item[key]) is not int or not 0 <= item[key] <= maximum
                       for key, maximum in bounds.items())
                or item['successfulRequests'] > item['requests']
                or item['capturedOrders'] > item['discoveredOrders']):
            raise ValueError()
    stamp = value['checkedAt']
    if type(stamp) is not str or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', stamp):
        raise ValueError()
    datetime.datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%S.%fZ')
    return {'schema': 1, 'mode': 'execution-history-readonly', 'captureId': value['captureId'],
            'venues': {venue: {key: venues[venue][key] for key in tuple(bounds) + ('truncated',)}
                       for venue in ('mexc', 'okx')}, 'checkedAt': stamp,
            'reportWritten': True, 'executable': False}



def load_root_module(name, path):
    info = os.stat(path, follow_symlinks=False)
    if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
        raise ValueError()
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module



REMOTE_VERIFIER = r"""
import hashlib,json,os,re,stat,sys
PIN_VALUE = __PIN_VALUE__
BASE = '/home/mil/crypto-execution-history/releases'
def pairs(items):
    value={}
    for key,item in items:
        if key in value: raise ValueError()
        value[key]=item
    return value
try:
    root=BASE+'/'+PIN_VALUE['release']
    for directory in (BASE,root):
        mode=os.lstat(directory).st_mode
        if not stat.S_ISDIR(mode) or mode & 0o022: raise ValueError()
    manifest=root+'/manifest.json'
    info=os.lstat(manifest)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_size>4194304: raise ValueError()
    with open(manifest,'rb') as stream: raw=stream.read(4194305)
    if hashlib.sha256(raw).hexdigest()!=PIN_VALUE['manifestSha256']: raise ValueError()
    files=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs)
    if type(files) is not dict or not 1<=len(files)<=30000 or 'run-once' not in files: raise ValueError()
    for relative,digest in files.items():
        if (type(relative) is not str or len(relative)>4096 or relative=='manifest.json'
            or any(part in ('','.','..') for part in relative.split('/'))
            or '\x00' in relative or '\\' in relative or relative.startswith('/')
            or type(digest) is not str or not re.fullmatch('[0-9a-f]{64}',digest)): raise ValueError()
        target=root
        for index,part in enumerate(relative.split('/')):
            target+='/'+part
            info=os.lstat(target)
            if info.st_mode & 0o022: raise ValueError()
            if index<len(relative.split('/'))-1:
                if not stat.S_ISDIR(info.st_mode): raise ValueError()
            elif not stat.S_ISREG(info.st_mode): raise ValueError()
        content=hashlib.sha256()
        with open(target,'rb') as stream:
            while True:
                chunk=stream.read(1048576)
                if not chunk: break
                content.update(chunk)
        if content.hexdigest()!=digest: raise ValueError()
    actual=set()
    for directory,dirs,names in os.walk(root,followlinks=False):
        for name in dirs:
            if not stat.S_ISDIR(os.lstat(directory+'/'+name).st_mode): raise ValueError()
        for name in names:
            relative=os.path.relpath(directory+'/'+name,root)
            if relative!='manifest.json': actual.add(relative)
    if actual!=set(files): raise ValueError()
    os.execv(root+'/run-once',[root+'/run-once'])
except Exception:
    print('{"schema":1,"error":"history-failed"}')
    sys.exit(1)
"""


def load_pin():
    info = os.stat(PIN, follow_symlinks=False)
    if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_size > 512:
        raise ValueError()
    pin = json.loads(Path(PIN).read_text(), object_pairs_hook=unique_pairs, parse_constant=reject_constant)
    if (type(pin) is not dict or set(pin) != {'schema', 'release', 'manifestSha256'}
            or type(pin['schema']) is not int or pin['schema'] != 1
            or any(type(pin[key]) is not str or not re.fullmatch(r'[0-9a-f]{64}', pin[key])
                   for key in ('release', 'manifestSha256'))):
        raise ValueError()
    return pin


def verification_command(pin):
    source = REMOTE_VERIFIER.replace('__PIN_VALUE__', repr(pin))
    return '/usr/bin/python3 -I -c ' + shlex.quote(source)


def prepare_payload(records):
    if set(records) != set(PART_MARKERS) or any(not 0 < len(raw) <= MAX_BYTES for raw in records.values()):
        raise ValueError()
    mexc_format = load_root_module('pair_mexc_format', MEXC_FORMAT)
    mexc_probe = load_root_module('pair_mexc_probe', MEXC_PROBE)
    okx_probe = load_root_module('pair_okx_probe', OKX_PROBE)
    prepared = bytearray()
    try:
        prepared = mexc_format.prepare_payload(records['mexc'])
        mexc_key, mexc_secret = mexc_probe.parse_credentials(bytes(prepared))
        passphrase = okx_probe.parse_separate_passphrase(bytes(records['okx-passphrase']))
        okx_key, okx_secret, passphrase = okx_probe.parse_credentials(
            bytes(records['okx-keypair']), passphrase_override=passphrase)
        bundles = {}
        for venue, key, secret in [('mexc', mexc_key, mexc_secret), ('okx', okx_key, okx_secret)]:
            bundles[venue] = {'schema': 1, 'venue': venue, 'environment': 'mainnet', 'region': 'global',
                              'apiKey': key, 'apiSecret': secret}
        bundles['okx']['passphrase'] = passphrase
        return bytearray(json.dumps({'schema': 1, 'mexc': bundles['mexc'], 'okx': bundles['okx']},
                                    separators=(',', ':')).encode('ascii')), (mexc_key, mexc_secret, okx_key, okx_secret, passphrase)
    finally:
        if prepared is not records['mexc']:
            wipe(prepared)


def safe_output(raw, credentials):
    value = decode_report(raw)
    output = json.dumps(value, separators=(',', ':'))
    # Defence in depth: even schema-valid free text must not contain a credential.
    for credential in credentials:
        if credential in output or json.dumps(credential, ensure_ascii=True)[1:-1] in output:
            raise ValueError()
    return value, output


def consumer(part):
    if part not in PART_MARKERS:
        return 64
    raw = bytearray(sys.stdin.buffer.read(MAX_BYTES + 1))
    try:
        if not 0 < len(raw) <= MAX_BYTES:
            return 65
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(75)
            conn.connect(SOCKET)
            _, peer_uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer_uid != 0:
                return 66
            conn.sendall(PART_MARKERS[part])
            conn.sendall(struct.pack('!I', len(raw)))
            conn.sendall(raw)
            return 0 if receive_exact(conn, 1) == b'1' else 67
    finally:
        wipe(raw)


def server():
    if os.geteuid() != 0:
        return 68
    uid = pwd.getpwnam('agent-secrets').pw_uid
    records, combined, credentials = {}, bytearray(), ()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(SOCKET)
        try:
            os.chown(SOCKET, 0, grp.getgrnam('agent-secrets-clients').gr_gid)
            os.chmod(SOCKET, 0o660)
            listener.listen(1)
            listener.settimeout(20)
            for index, (part, marker) in enumerate(PARTS):
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(75)
                    _, peer_uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if peer_uid != uid or receive_exact(conn, 1) != marker:
                        raise ValueError()
                    size = struct.unpack('!I', receive_exact(conn, 4))[0]
                    if not 0 < size <= MAX_BYTES:
                        raise ValueError()
                    records[part] = receive_exact(conn, size)
                    if index < len(PARTS) - 1:
                        conn.sendall(b'1')  # Delivery only; no authentication claim.
                        continue
                    combined, credentials = prepare_payload(records)
                    result = subprocess.run(['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/bin/ssh',
                        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
                        'hyperion-trading', verification_command(load_pin())], input=bytes(combined),
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=65, check=False)
                    value, output = safe_output(result.stdout, credentials)
                    success = result.returncode == 0 and value.get('reportWritten') is True
                    if not success:
                        output = json.dumps(FAILURE, separators=(',', ':'))
                    conn.sendall(b'1' if success else b'0')
                    print(output)
                    return 0 if success else 1
        finally:
            for raw in records.values():
                wipe(raw)
            wipe(combined)
            credentials = ()
            os.unlink(SOCKET)


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--consumer', action='store_true')
    mode.add_argument('--server', action='store_true')
    parser.add_argument('--destination')
    parser.add_argument('--part', choices=tuple(PART_MARKERS))
    args = parser.parse_args()
    if (args.consumer and (args.part not in PART_MARKERS or args.destination != DESTINATION + '-' + args.part)
            or args.server and (args.destination or args.part)):
        return 64
    return consumer(args.part) if args.consumer else server()


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps(FAILURE, separators=(',', ':')))
        sys.exit(1)
