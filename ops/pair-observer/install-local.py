#!/usr/bin/python3 -I
"""Install only the fixed Crypto observer controller; do not activate it."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

TARGET = Path('/opt/crypto-pair-observer')
UNITS = ('crypto-pair-observer.service', 'crypto-pair-observer.timer')
FILES = ('ops/pair-observer/run-pair-observer-once.py', 'ops/pair-observer/pair-observer-bridge.py',
         'ops/pair-observer/release-pin.json', 'ops/mexc/mexc-balance-bridge.py',
         'ops/mexc/mexc-balance-probe.py', 'ops/okx/okx-account-probe.py')

def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError()
    source = Path(__file__).resolve().parents[2]
    if TARGET.exists() or TARGET.is_symlink() or any((Path('/etc/systemd/system') / unit).exists() or (Path('/etc/systemd/system') / unit).is_symlink() for unit in UNITS):
        raise ValueError()
    installed = []
    made = False
    try:
        TARGET.mkdir(mode=0o755)
        made = True
        manifest = {}
        for relative in FILES:
            raw = (source / relative).read_bytes()
            target = TARGET / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            target.chmod(0o644)
            manifest[relative] = hashlib.sha256(raw).hexdigest()
        (TARGET / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True))
        (TARGET / 'manifest.json').chmod(0o644)
        for unit in UNITS:
            target = Path('/etc/systemd/system') / unit
            with target.open('xb') as out:
                installed.append(target)
                out.write((source / 'ops/pair-observer' / unit).read_bytes())
            target.chmod(0o644)
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=True)
        print(json.dumps({'installed': True, 'activated': False, 'controller': str(TARGET)}))
    except Exception:
        for path in installed:
            path.unlink()
        if made:
            shutil.rmtree(str(TARGET))
        subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        raise

if __name__ == '__main__':
    os.umask(0o022)
    try:
        main()
    except Exception:
        print('{"installed":false,"error":"observer-controller-install-failed"}')
        sys.exit(1)
