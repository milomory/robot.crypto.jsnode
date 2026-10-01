#!/usr/bin/env python3
"""Build an isolated, secret-free execution-history artifact from built source."""
import hashlib
import io
import json
from pathlib import Path
import tarfile

REPO = Path(__file__).resolve().parents[2]
# Tests may override OUT. Normal builds keep earlier artifacts by release hash.
OUT = None

def main():
    files = {'package.json': b'{"type":"module","private":true}\n',
             'run-once': (REPO / 'ops/execution-history/run-once').read_bytes()}
    for directory in ['dist/accounts', 'dist/lab', 'dist/paper-pair', 'dist/paper-v2', 'node_modules/zod']:
        if (REPO / directory).is_symlink() or not (REPO / directory).is_dir():
            raise ValueError('missing-or-linked-build-directory')
        for path in sorted((REPO / directory).rglob('*')):
            if path.is_symlink():
                raise ValueError('symlink-in-build')
            if path.is_file():
                files[str(path.relative_to(REPO))] = path.read_bytes()
    files['dist/scripts/execution-history.js'] = (REPO / 'dist/scripts/execution-history.js').read_bytes()
    manifest = json.dumps({name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(files.items())}, sort_keys=True, separators=(',', ':')).encode('ascii')
    release = hashlib.sha256(manifest).hexdigest()
    files['manifest.json'] = manifest
    artifact = OUT if OUT is not None else Path('/tmp/crypto-execution-history-' + release + '.tar.gz')
    with artifact.open('xb') as destination:
        with tarfile.open(fileobj=destination, mode='w:gz') as tar:
            for name, raw in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(raw), 0o755 if name == 'run-once' else 0o644, 0
                tar.addfile(info, io.BytesIO(raw))
    pin = {'schema': 1, 'release': release, 'manifestSha256': release}
    pin_path = REPO / 'ops/execution-history/release-pin.json'
    staged = pin_path.with_name('.release-pin.json.tmp')
    with staged.open('x') as output:
        output.write(json.dumps(pin, separators=(',', ':')) + '\n')
    staged.replace(pin_path)
    print(json.dumps({'release': release, 'files': len(files), 'artifact': str(artifact), 'bytes': artifact.stat().st_size}))

if __name__ == '__main__':
    main()
