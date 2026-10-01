#!/usr/bin/env python3
"""Build a minimal, secret-free observer artifact from already built local source."""
import hashlib
import io
import json
from pathlib import Path
import tarfile

REPO = Path(__file__).resolve().parents[2]
OUT = Path('/tmp/crypto-pair-observer-release.tar.gz')

def main():
    files = {'package.json': b'{"type":"module","private":true}\n',
             'run-once': (REPO / 'ops/pair-observer/run-once').read_bytes()}
    for directory in ['dist/accounts', 'dist/lab', 'node_modules/zod']:
        for path in sorted((REPO / directory).rglob('*')):
            if path.is_symlink():
                raise ValueError('symlink-in-build')
            if path.is_file():
                files[str(path.relative_to(REPO))] = path.read_bytes()
    files['dist/scripts/pair-observer.js'] = (REPO / 'dist/scripts/pair-observer.js').read_bytes()
    manifest = json.dumps({name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(files.items())}, sort_keys=True, separators=(',', ':')).encode('ascii')
    release = hashlib.sha256(manifest).hexdigest()
    files['manifest.json'] = manifest
    with tarfile.open(str(OUT), 'w:gz') as tar:
        for name, raw in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(raw), 0o755 if name == 'run-once' else 0o644, 0
            tar.addfile(info, io.BytesIO(raw))
    pin = {'schema': 1, 'release': release, 'manifestSha256': release}
    (REPO / 'ops/pair-observer/release-pin.json').write_text(json.dumps(pin, separators=(',', ':')) + '\n')
    print(json.dumps({'release': release, 'files': len(files), 'artifact': str(OUT), 'bytes': OUT.stat().st_size}))

if __name__ == '__main__':
    main()
