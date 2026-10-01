#!/usr/bin/python3 -I
"""Swap only an inactive observer's exact release pin, retaining a rollback copy."""
import datetime
import fcntl
import signal
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

TARGET = Path('/opt/crypto-pair-observer')
RELATIVE = 'ops/pair-observer/release-pin.json'

def inactive(unit):
    result = subprocess.run(['/usr/bin/systemctl', 'show', '--property=ActiveState', '--value', unit],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=10)
    return result.stdout.strip() in (b'inactive', b'failed')

def safe(path):
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_uid != 0 or stat.st_nlink != 1 or stat.st_mode & 0o022:
        raise ValueError()
    return path.read_bytes()

def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch('[a-f0-9]{64}', sys.argv[1]):
        raise ValueError()
    lock = open('/run/lock/crypto-pair-observer-once.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not inactive('crypto-pair-observer.timer') or not inactive('crypto-pair-observer.service'):
        raise ValueError()
    manifest_path = TARGET / 'manifest.json'
    original_manifest = safe(manifest_path)
    manifest = json.loads(original_manifest)
    for name, digest in manifest.items():
        if '..' in Path(name).parts or Path(name).is_absolute() or hashlib.sha256(safe(TARGET / name)).hexdigest() != digest:
            raise ValueError()
    pin_path = TARGET / RELATIVE
    old_raw = safe(pin_path)
    old = json.loads(old_raw)
    new_raw = Path(__file__).with_name('release-pin.json').read_bytes()
    new = json.loads(new_raw)
    if old['release'] != sys.argv[1] or set(new) != {'schema', 'release', 'manifestSha256'} or new['schema'] != 1 or not re.fullmatch('[a-f0-9]{64}', new['release']) or new['release'] != new['manifestSha256']:
        raise ValueError()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = TARGET / 'backups' / ('dashboard-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'release-pin.json').write_bytes(old_raw)
    (backup / 'manifest.json').write_bytes(original_manifest)
    staged = pin_path.with_name('.dashboard-pin-' + stamp)
    staged_manifest = manifest_path.with_name('.dashboard-manifest-' + stamp)
    manifest[RELATIVE] = hashlib.sha256(new_raw).hexdigest()
    with staged.open('xb') as out:
        out.write(new_raw)
    with staged_manifest.open('xb') as out:
        out.write(json.dumps(manifest, sort_keys=True).encode('utf8'))
    staged.chmod(0o644)
    staged_manifest.chmod(0o644)
    if safe(pin_path) != old_raw or safe(manifest_path) != original_manifest:
        raise ValueError()
    # Block asynchronous termination for the two-file transaction and restore
    # exact prior bytes if either replacement fails.
    blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP})
    try:
        staged.replace(pin_path)
        staged_manifest.replace(manifest_path)
    except BaseException:
        for path, raw in [(pin_path, old_raw), (manifest_path, original_manifest)]:
            temporary = path.with_name('.rollback-' + path.name + '-' + stamp)
            with temporary.open('xb') as out:
                out.write(raw)
            temporary.chmod(0o644)
            temporary.replace(path)
        raise
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
    print(json.dumps({'updated': True, 'release': new['release'], 'previous': old['release'], 'backup': str(backup), 'activated': False}))

if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception:
        print('{"updated":false,"error":"scoped-observer-pin-update-failed"}')
        sys.exit(1)
