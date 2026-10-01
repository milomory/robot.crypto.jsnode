#!/usr/bin/python3 -I
"""Install only a bounded immutable UI bundle; never change config or runtime."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

BASE = Path('/home/mil/robot.crypto.jsnode/ui-releases')
ASSET = re.compile(r'dist/assets/[A-Za-z0-9_-]+\.(?:js|css|svg|png|jpeg|jpg|webp|ico|woff|woff2|ttf)')

def unpack(data, revision, digest):
    if len(data) > 32 * 1024 * 1024 or not re.fullmatch('[a-f0-9]{40}', revision) or not re.fullmatch('[a-f0-9]{64}', digest):
        raise ValueError()
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            name = member.name
            if not member.isfile() or (name not in ('manifest.json', 'dist/index.html') and not ASSET.fullmatch(name)) or name in files or len(files) >= 257 or not 0 <= member.size <= 8 * 1024 * 1024:
                raise ValueError()
            total += member.size
            if total > 32 * 1024 * 1024:
                raise ValueError()
            files[name] = archive.extractfile(member).read()
    raw = files.pop('manifest.json')
    if len(raw) > 128 * 1024 or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError()
    manifest = json.loads(raw)
    if set(manifest) != {'schema', 'sourceRevision', 'files'} or manifest['schema'] != 1 or manifest['sourceRevision'] != revision or set(manifest['files']) != set(files) or 'dist/index.html' not in files:
        raise ValueError()
    if any(hashlib.sha256(value).hexdigest() != manifest['files'][name] for name, value in files.items()):
        raise ValueError()
    return dict(files, **{'manifest.json': raw})

def install(files, revision):
    if BASE.resolve() != BASE or (BASE.exists() and (not BASE.is_dir() or BASE.stat().st_uid != os.getuid() or BASE.stat().st_mode & 0o022)):
        raise ValueError()
    BASE.mkdir(mode=0o755, exist_ok=True)
    destination, temporary = BASE / revision, BASE / ('.staging-' + revision)
    if destination.exists() or destination.is_symlink() or temporary.exists() or temporary.is_symlink():
        raise ValueError()
    temporary.mkdir(mode=0o700)
    try:
        for name, raw in files.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as out:
                out.write(raw)
            path.chmod(0o644)
        for path in temporary.rglob('*'):
            if path.is_dir():
                path.chmod(0o755)
        temporary.chmod(0o755)
        if destination.exists() or destination.is_symlink():
            raise ValueError()
        temporary.rename(destination)
    except BaseException:
        shutil.rmtree(str(temporary))
        raise

def main():
    if len(sys.argv) != 3 or os.getuid() != 1002:
        raise ValueError()
    files = unpack(sys.stdin.buffer.read(32 * 1024 * 1024 + 1), sys.argv[1], sys.argv[2])
    install(files, sys.argv[1])
    print(json.dumps({'installed': True, 'revision': sys.argv[1], 'manifestVerified': True, 'files': len(files) - 1}))

if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except BaseException:
        print('{"installed":false,"error":"ui-release-install-failed"}')
        sys.exit(1)
