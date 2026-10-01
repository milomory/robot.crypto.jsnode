#!/usr/bin/python3 -I
"""Fixed broker-to-Hyperion bridge for one OKX account read check."""
import argparse
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

DESTINATION = 'hyperion.crypto-okx-account'
SOCKET = '/run/agent-secrets-broker/crypto-okx-account.sock'
PROBE = '/usr/local/libexec/crypto-okx-account-probe.py'
MAX_BYTES = 16384
PART_MARKERS = {'keypair': b'K', 'passphrase': b'P'}
SPLIT_MAGIC = b'OKX-SPLIT-1\0'


def wipe(raw):
    raw[:] = b'\0' * len(raw)


def receive_exact(conn, size):
    data = bytearray()
    while len(data) < size:
        part = conn.recv(size - len(data))
        if not part:
            raise ValueError()
        data.extend(part)
    return data


def consumer(part='keypair'):
    if part not in PART_MARKERS:
        return 64
    raw = bytearray(sys.stdin.buffer.read(MAX_BYTES + 1))
    try:
        if not 0 < len(raw) <= MAX_BYTES:
            return 65
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(45)
            conn.connect(SOCKET)
            # Verify root owns the other endpoint before sending credentials.
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
    keypair, raw, combined = bytearray(), bytearray(), bytearray()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(SOCKET)  # Fail closed if another operation owns this path.
        try:
            os.chown(SOCKET, 0, grp.getgrnam('agent-secrets-clients').gr_gid)
            os.chmod(SOCKET, 0o660)
            listener.listen(1)
            listener.settimeout(20)
            first, _ = listener.accept()
            with first:
                first.settimeout(40)
                _, peer_uid, _ = struct.unpack('3i', first.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if peer_uid != uid or receive_exact(first, 1) != b'K':
                    raise ValueError()
                size = struct.unpack('!I', receive_exact(first, 4))[0]
                if not 0 < size <= MAX_BYTES:
                    raise ValueError()
                keypair = receive_exact(first, size)
                first.sendall(b'1')  # Delivery only, not account authentication.
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(40)
                _, peer_uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if peer_uid != uid or receive_exact(conn, 1) != b'P':
                    raise ValueError()
                size = struct.unpack('!I', receive_exact(conn, 4))[0]
                if not 0 < size <= MAX_BYTES:
                    raise ValueError()
                raw = receive_exact(conn, size)
                combined = bytearray(SPLIT_MAGIC)
                combined.extend(struct.pack('!I', len(keypair)))
                combined.extend(keypair)
                combined.extend(struct.pack('!I', len(raw)))
                combined.extend(raw)
                info = os.stat(PROBE, follow_symlinks=False)
                if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
                    raise ValueError()
                source = Path(PROBE).read_text()
                # Source is public, fixed and root-owned. Credentials arrive only on stdin.
                command = '/usr/bin/python3 -I -c ' + shlex.quote(source)
                result = subprocess.run(['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/bin/ssh',
                    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
                    'hyperion-trading', command], input=bytes(combined), stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, timeout=35, check=False)
                if len(result.stdout) > 262144:
                    raise ValueError()
                # The reviewed probe emits only allowlisted check metadata or fixed errors.
                report_path = Path('/usr/local/libexec/crypto-okx-account-report.py')
                info = report_path.stat(follow_symlinks=False)
                if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
                    raise ValueError()
                spec = importlib.util.spec_from_file_location('okx_report', str(report_path))
                report = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(report)
                output = report.decode_report(result.stdout)
                success = result.returncode == 0 and output.get('feeReadVerified') is True
                conn.sendall(b'1' if success else b'0')
                print(json.dumps(output, separators=(',', ':')))
                return 0 if success else 1
        finally:
            wipe(keypair)
            wipe(raw)
            wipe(combined)
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
        print('{"schema":1,"venue":"okx","scope":"account-check","authenticatedRead":false,"errorCode":"bridge-failed","failedStage":"output","completedReads":0}')
        sys.exit(1)
