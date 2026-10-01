#!/usr/bin/python3 -I
"""Install one verified release under a new namespace. No request provisioning.

Never execute the package, start a container or touch observer/app state. Interrupted
staging and uncertain publication survive for inspection; no blind retry cleanup.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile

BASE = Path('/home/mil/crypto-order-recovery')
UID = 1002
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_FILES = 4096
ENTRY = 'dist/scripts/protected-order-recovery.js'


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError()


def valid_name(name):
    return (type(name) is str and len(name) <= 240 and re.fullmatch('[A-Za-z0-9_./-]+', name)
            and not name.startswith('/') and all(part not in ('', '.', '..') for part in name.split('/')))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unpack(data, release):
    if not 0 < len(data) <= MAX_ARCHIVE or not re.fullmatch('[a-f0-9]{64}', release):
        raise ValueError()
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if (member.type != tarfile.REGTYPE or member.pax_headers or member.sparse is not None
                    or not valid_name(member.name) or member.name in files or len(files) >= MAX_FILES + 1
                    or member.mode != (0o700 if member.name == 'run-once' else 0o600)
                    or member.uid != 0 or member.gid != 0 or not 0 <= member.size <= 8 * 1024 * 1024):
                raise ValueError()
            total += member.size
            if total > MAX_TOTAL:
                raise ValueError()
            content = archive.extractfile(member).read(member.size + 1)
            if len(content) != member.size:
                raise ValueError()
            files[member.name] = content
    raw = files.pop('manifest.json')
    if len(raw) > 512 * 1024 or sha(raw) != release:
        raise ValueError()
    manifest = json.loads(raw.decode('ascii'), object_pairs_hook=unique_pairs, parse_constant=reject_constant)
    if (type(manifest) is not dict or set(manifest) != set(files)
            or not {'package.json', 'run-once', ENTRY}.issubset(manifest)
            or any(type(value) is not str or not re.fullmatch('[a-f0-9]{64}', value) for value in manifest.values())
            or any(sha(content) != manifest[name] for name, content in files.items())):
        raise ValueError()
    # A file cannot also act as a directory, regardless of archive ordering.
    if any('/'.join(name.split('/')[:i]) in files for name in files for i in range(1, len(name.split('/')))):
        raise ValueError()
    files['manifest.json'] = raw
    return files


def directory(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != UID or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError()


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def install(files, release):
    # Fixed existing parent cannot be a symlink or foreign/writable shared path.
    parent = BASE.parent.lstat()
    if (BASE.parent.resolve() != BASE.parent or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != UID or parent.st_mode & 0o022):
        raise ValueError()
    for path in (BASE, BASE / 'releases', BASE / 'state'):
        directory(path, create=True)
        sync_directory(path.parent)
    destination = BASE / 'releases' / release
    if destination.exists() or destination.is_symlink():
        raise ValueError()
    staging = BASE / 'releases' / ('.staging-' + release)
    staging.mkdir(mode=0o700)
    sync_directory(staging.parent)
    created_dirs = {staging}
    for name, raw in sorted(files.items()):
        target = staging / name
        current = staging
        for part in Path(name).parts[:-1]:
            current = current / part
            directory(current, create=True)
            created_dirs.add(current)
        mode = 0o700 if name == 'run-once' else 0o600
        descriptor = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
    for path in sorted(created_dirs, key=lambda p: len(p.parts), reverse=True):
        sync_directory(path)
    # The destination is immutable and never replaced. Exclusive installer lock
    # serializes publication; no cross-filesystem or power-loss atomicity claim.
    if destination.exists() or destination.is_symlink():
        raise ValueError()
    staging.rename(destination)
    sync_directory(destination.parent)
    return {'schema': 1, 'installed': True, 'release': release, 'manifestVerified': True,
            'privateState': True, 'requestProvisioned': False, 'runtimeStarted': False}


def main():
    if len(sys.argv) != 2 or os.getuid() != UID or not re.fullmatch('[a-f0-9]{64}', sys.argv[1]):
        raise ValueError()
    data = sys.stdin.buffer.read(MAX_ARCHIVE + 1)
    files = unpack(data, sys.argv[1])
    # The exclusive per-release staging directory is the install lock and remains
    # on failure, so an uncertain install cannot be silently overwritten/retried.
    print(json.dumps(install(files, sys.argv[1]), separators=(',', ':')))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception:
        print('{"schema":1,"installed":false,"error":"recovery-install-failed"}')
        sys.exit(1)
