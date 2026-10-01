#!/usr/bin/python3 -I
"""Only the selected venue records to one pinned read-only order recovery capture.

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

DESTINATION = 'hyperion.crypto-order-recovery'
SOCKET = '/run/agent-secrets-broker/crypto-order-recovery.sock'
MEXC_FORMAT = '/usr/local/libexec/crypto-order-recovery-mexc-format.py'
MEXC_PROBE = '/usr/local/libexec/crypto-order-recovery-mexc-probe.py'
OKX_PROBE = '/usr/local/libexec/crypto-order-recovery-okx-probe.py'
PIN = '/usr/local/libexec/crypto-order-recovery-pin.json'
MAX_BYTES = 16384
MAX_REPORT = 4096
PARTS = (('mexc', b'M'), ('okx-keypair', b'K'), ('okx-passphrase', b'P'))
PART_MARKERS = dict(PARTS)

def selected_parts(venue):
    if venue == 'mexc': return PARTS[:1]
    if venue == 'okx': return PARTS[1:]
    raise ValueError()
FAILURE = {'schema': 1, 'error': 'recovery-failed'}


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


def decode_report(raw, preflight=False, pin=None):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_REPORT:
        raise ValueError()
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_pairs,
                       parse_constant=reject_constant)
    if type(value) is not dict or type(value.get('schema')) is not int or value['schema'] != 1:
        raise ValueError()
    if value == FAILURE: return dict(FAILURE)
    common = {'schema', 'mode', 'requestSha256', 'venue', 'executable',
              'captureProvenanceVerified', 'accountIdentityVerified'}
    fields = common | ({'ready'} if preflight else {'reportWritten', 'requestCount', 'receipt'})
    if (set(value) != fields or value['mode'] != ('order-recovery-preflight' if preflight else 'order-recovery-readonly')
            or value['venue'] not in ('mexc', 'okx')
            or type(value['requestSha256']) is not str or not re.fullmatch('[a-f0-9]{64}', value['requestSha256'])
            or any(value[field] is not False for field in ('executable', 'captureProvenanceVerified', 'accountIdentityVerified'))):
        raise ValueError()
    if pin is not None and (value['requestSha256'] != pin['requestSha256'] or value['venue'] != pin['venue']):
        raise ValueError()
    if preflight:
        if value['ready'] is not True: raise ValueError()
    else:
        receipt = value['receipt']
        if (value['reportWritten'] is not True or type(value['requestCount']) is not int or value['requestCount'] != 3
                or type(receipt) is not dict or set(receipt) != {'schema', 'kind', 'archiveId', 'archiveHash'}
                or type(receipt['schema']) is not int or receipt['schema'] != 1
                or receipt['kind'] != 'live-order-recovery-archive-receipt'
                or type(receipt['archiveId']) is not str or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', receipt['archiveId'])
                or type(receipt['archiveHash']) is not str or not re.fullmatch('[a-f0-9]{64}', receipt['archiveHash'])):
            raise ValueError()
    return value



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
PREFLIGHT = __PREFLIGHT__
BASE = '/home/mil/crypto-order-recovery/releases'
def pairs(items):
    value={}
    for key,item in items:
        if key in value: raise ValueError()
        value[key]=item
    return value
try:
    if os.getuid()!=1002: raise ValueError()
    root=BASE+'/'+PIN_VALUE['release']
    for directory in (BASE,root):
        info=os.lstat(directory); mode=info.st_mode
        if not stat.S_ISDIR(mode) or mode & 0o022 or info.st_uid!=1002: raise ValueError()
    manifest=root+'/manifest.json'
    info=os.lstat(manifest)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=1002 or info.st_nlink!=1 or info.st_mode & 0o022 or info.st_size>4194304: raise ValueError()
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
            if info.st_mode & 0o022 or info.st_uid!=1002: raise ValueError()
            if index<len(relative.split('/'))-1:
                if not stat.S_ISDIR(info.st_mode): raise ValueError()
            elif not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>8388608: raise ValueError()
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
    os.execv(root+'/run-once',[root+'/run-once']+(['--preflight'] if PREFLIGHT else [])+[PIN_VALUE['requestSha256']])
except Exception:
    print('{"schema":1,"error":"recovery-failed"}')
    sys.exit(1)
"""


def parse_pin(pin):
    if (type(pin) is not dict or set(pin) != {'schema', 'release', 'manifestSha256', 'requestSha256', 'venue'}
            or type(pin['schema']) is not int or pin['schema'] != 1 or pin['venue'] not in ('mexc', 'okx')
            or any(type(pin[key]) is not str or not re.fullmatch(r'[0-9a-f]{64}', pin[key])
                   for key in ('release', 'manifestSha256', 'requestSha256'))
            or pin['release'] != pin['manifestSha256']):
        raise ValueError()
    return pin


def load_pin(path=PIN):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_mode & 0o777 != 0o600 or info.st_size > 1024):
            raise ValueError()
        raw = stream.read(1025)
    if len(raw) > 1024: raise ValueError()
    return parse_pin(json.loads(raw, object_pairs_hook=unique_pairs, parse_constant=reject_constant))


def verification_command(pin, preflight=False):
    parse_pin(pin)
    if type(preflight) is not bool: raise ValueError()
    source = REMOTE_VERIFIER.replace('__PIN_VALUE__', repr(pin)).replace('__PREFLIGHT__', repr(preflight))
    return '/usr/bin/python3 -I -c ' + shlex.quote(source)


def prepare_payload(records, venue):
    required = dict(selected_parts(venue))
    if set(records) != set(required) or any(not 0 < len(raw) <= MAX_BYTES for raw in records.values()):
        raise ValueError()
    prepared = bytearray()
    try:
        if venue == 'mexc':
            formatter = load_root_module('recovery_mexc_format', MEXC_FORMAT)
            probe = load_root_module('recovery_mexc_probe', MEXC_PROBE)
            prepared = formatter.prepare_payload(records['mexc'])
            key, secret = probe.parse_credentials(bytes(prepared))
            credentials = (key, secret)
        else:
            probe = load_root_module('recovery_okx_probe', OKX_PROBE)
            passphrase = probe.parse_separate_passphrase(bytes(records['okx-passphrase']))
            key, secret, passphrase = probe.parse_credentials(bytes(records['okx-keypair']), passphrase_override=passphrase)
            credentials = (key, secret, passphrase)
        bundle = {'schema': 1, 'venue': venue, 'environment': 'mainnet', 'region': 'global', 'apiKey': key, 'apiSecret': secret}
        if venue == 'okx': bundle['passphrase'] = passphrase
        return bytearray(json.dumps({'schema': 1, 'venue': venue, venue: bundle}, separators=(',', ':')).encode('ascii')), credentials
    finally:
        if prepared is not records.get('mexc'): wipe(prepared)


def safe_output(raw, credentials, pin=None):
    value = decode_report(raw, pin=pin)
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
            conn.settimeout(105)
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
    pin = load_pin()
    parts = selected_parts(pin['venue'])
    uid = pwd.getpwnam('agent-secrets').pw_uid
    records, combined, credentials = {}, bytearray(), ()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(SOCKET)
        try:
            os.chown(SOCKET, 0, grp.getgrnam('agent-secrets-clients').gr_gid)
            os.chmod(SOCKET, 0o660)
            listener.listen(1)
            listener.settimeout(20)
            for index, (part, marker) in enumerate(parts):
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(105)
                    _, peer_uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if peer_uid != uid or receive_exact(conn, 1) != marker:
                        raise ValueError()
                    size = struct.unpack('!I', receive_exact(conn, 4))[0]
                    if not 0 < size <= MAX_BYTES:
                        raise ValueError()
                    records[part] = receive_exact(conn, size)
                    if index < len(parts) - 1:
                        conn.sendall(b'1')  # Delivery only; no authentication claim.
                        continue
                    combined, credentials = prepare_payload(records, pin['venue'])
                    result = subprocess.run(['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/bin/ssh',
                        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
                        'hyperion-trading', verification_command(pin)], input=bytes(combined),
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90, check=False)
                    value, output = safe_output(result.stdout, credentials, pin)
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
