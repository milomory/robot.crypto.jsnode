#!/usr/bin/python3 -I
"""Install only a new isolated history release/state; never touch observer/runtime."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile

BASE = Path('/home/mil/crypto-execution-history')

def main():
    if len(sys.argv) != 2 or not re.fullmatch('[a-f0-9]{64}', sys.argv[1]) or os.getuid() != 1002:
        raise ValueError()
    release = sys.argv[1]
    data = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError()
    files = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or str(path) != member.name or any(p in ('..', '.', '') for p in path.parts) or member.name in files or len(files) > 30000:
                raise ValueError()
            if not 0 <= member.size <= 8 * 1024 * 1024:
                raise ValueError()
            total += member.size
            if total > 64 * 1024 * 1024:
                raise ValueError()
            files[member.name] = tar.extractfile(member).read()
    manifest_raw = files.pop('manifest.json')
    if hashlib.sha256(manifest_raw).hexdigest() != release:
        raise ValueError()
    manifest = json.loads(manifest_raw)
    if set(manifest) != set(files) or 'run-once' not in files or any(hashlib.sha256(raw).hexdigest() != manifest[name] for name, raw in files.items()):
        raise ValueError()
    for directory in [BASE, BASE / 'releases', BASE / 'state']:
        if not directory.exists():
            directory.mkdir(mode=0o700)
        info = directory.lstat()
        if directory.is_symlink() or not directory.is_dir() or info.st_uid != 1002 or info.st_mode & 0o077:
            raise ValueError()
    destination = BASE / 'releases' / release
    if destination.exists() or destination.is_symlink():
        raise ValueError()
    temporary = BASE / 'releases' / ('.staging-' + release)
    temporary.mkdir(mode=0o700)
    try:
        files['manifest.json'] = manifest_raw
        for name, raw in files.items():
            target = temporary / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as out:
                out.write(raw)
            target.chmod(0o755 if name == 'run-once' else 0o644)
        for path in temporary.rglob('*'):
            if path.is_dir():
                path.chmod(0o755)
        temporary.chmod(0o755)
        temporary.rename(destination)
    except Exception:
        shutil.rmtree(str(temporary))
        raise
    print(json.dumps({'installed': True, 'release': release, 'manifestVerified': True, 'privateState': True}))

if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception:
        print('{"installed":false,"error":"history-install-failed"}')
        sys.exit(1)
