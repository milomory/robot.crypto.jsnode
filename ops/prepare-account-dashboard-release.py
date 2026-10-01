#!/usr/bin/env python3
"""Package a committed, built application without env files or dependencies."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

REPO = Path(__file__).resolve().parents[1]
OUT = Path('/tmp/crypto-account-dashboard-release.tar.gz')

def included(name):
    return name.startswith(('src/', 'migrations/', 'ui/src/')) or name in (
        'package.json', 'package-lock.json', 'tsconfig.json', 'ui/index.html', 'ui/vite.config.ts')

def main():
    revision = subprocess.check_output(['git','rev-parse','HEAD'],cwd=str(REPO)).decode().strip()
    dirty = subprocess.check_output(['git','diff','HEAD','--name-only'],cwd=str(REPO)).decode().splitlines()
    if any(included(name) for name in dirty):
        raise ValueError('uncommitted-runtime-source')
    untracked = subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z'],cwd=str(REPO)).decode().split('\0')
    if any(included(name) for name in untracked):
        raise ValueError('untracked-runtime-source')
    names = subprocess.check_output(['git','ls-files','-z'],cwd=str(REPO)).decode().split('\0')
    files = {}
    for name in names:
        if included(name):
            path = REPO / name
            if path.is_symlink() or not path.is_file():
                raise ValueError('invalid-source')
            if any(part == '.env' or part.startswith('.env.') for part in path.parts):
                raise ValueError('env-in-source')
            files[name] = path.read_bytes()
    for folder in ['dist', 'ui/dist']:
        for path in sorted((REPO / folder).rglob('*')):
            if path.is_symlink():
                raise ValueError('symlink-in-build')
            if path.is_file():
                if any(part == '.env' or part.startswith('.env.') for part in path.parts):
                    raise ValueError('env-in-build')
                files[str(path.relative_to(REPO))] = path.read_bytes()
    if not all(name in files for name in ['dist/http/account-dashboard-routes.js','ui/dist/index.html']):
        raise ValueError('missing-build')
    manifest = json.dumps({name:hashlib.sha256(raw).hexdigest() for name,raw in sorted(files.items())},sort_keys=True,separators=(',',':')).encode('ascii')
    digest = hashlib.sha256(manifest).hexdigest()
    files['dashboard-manifest.json'] = manifest
    with tarfile.open(str(OUT),'w:gz') as archive:
        for name,raw in sorted(files.items()):
            entry = tarfile.TarInfo(name)
            entry.size,entry.mode,entry.mtime = len(raw),0o644,0
            archive.addfile(entry,io.BytesIO(raw))
    meta = {'revision':revision,'manifestSha256':digest,'artifact':str(OUT),'files':len(files)}
    Path('/tmp/crypto-account-dashboard-release.json').write_text(json.dumps(meta))
    print(json.dumps(meta))

if __name__ == '__main__':
    main()
