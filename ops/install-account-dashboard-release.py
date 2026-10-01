#!/usr/bin/python3 -I
"""Install one manifest-verified source/build release. No config/runtime changes."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile

BASE = Path('/home/mil/robot.crypto.jsnode/releases')

def main():
    if len(sys.argv) != 3 or os.getuid() != 1002 or not re.fullmatch('[a-f0-9]{40}', sys.argv[1]) or not re.fullmatch('[a-f0-9]{64}', sys.argv[2]):
        raise ValueError()
    data = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError()
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or str(path) != member.name or any(p in ('..','.') for p in path.parts) or member.name in files or len(files) > 10000 or not 0 <= member.size <= 8 * 1024 * 1024:
                raise ValueError()
            total += member.size
            if total > 64 * 1024 * 1024:
                raise ValueError()
            files[member.name] = archive.extractfile(member).read()
    manifest_raw = files.pop('dashboard-manifest.json')
    if hashlib.sha256(manifest_raw).hexdigest() != sys.argv[2]:
        raise ValueError()
    manifest = json.loads(manifest_raw)
    if set(manifest) != set(files) or any(hashlib.sha256(raw).hexdigest() != manifest[name] for name,raw in files.items()):
        raise ValueError()
    destination = BASE / sys.argv[1]
    temporary = BASE / ('.dashboard-staging-' + sys.argv[1])
    if destination.exists() or destination.is_symlink() or BASE.is_symlink() or not BASE.is_dir():
        raise ValueError()
    temporary.mkdir(mode=0o700)
    try:
        files['dashboard-manifest.json'] = manifest_raw
        for name,raw in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as out:
                out.write(raw)
            path.chmod(0o644)
        for path in temporary.rglob('*'):
            if path.is_dir():
                path.chmod(0o755)
        temporary.chmod(0o755)
        temporary.rename(destination)
    except BaseException:
        shutil.rmtree(str(temporary))
        raise
    print(json.dumps({'installed':True,'revision':sys.argv[1],'manifestVerified':True,'files':len(files)}))

if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except BaseException:
        print('{"installed":false,"error":"dashboard-release-install-failed"}')
        sys.exit(1)
