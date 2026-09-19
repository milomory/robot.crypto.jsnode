#!/usr/bin/python3 -I
"""Fixed one-line Crypto backchannel ACL addition; never replaces Auth vhost."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SITE = Path('/etc/nginx/sites-available/auth.vpn')
LOCATION = '    location ~ ^/(api/sso/(exchange|introspect|revoke)|healthz)$ {\n'
ADDITION = '        allow 192.168.3.2;\n'

def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def patch(original):
    if original.count(LOCATION) != 1 or ADDITION in original:
        raise RuntimeError('unexpected or already patched configuration')
    start = original.index(LOCATION) + len(LOCATION)
    end = original.index('\n    }', start)
    block = original[start:end]
    if 'allow 192.168.5.3;' not in block or block.count('deny all;') != 1:
        raise RuntimeError('backchannel policy changed')
    if 'access_log off;' not in block or 'error_log /dev/null;' not in block:
        raise RuntimeError('logging policy changed')
    return original[:start] + ADDITION + original[start:]

def main():
    if os.geteuid() != 0 or sys.argv[1:] or SITE.is_symlink():
        raise RuntimeError('fixed root operation only')
    os.umask(0o077)
    original = SITE.read_text()
    changed = patch(original)
    run('/usr/sbin/nginx', '-t')
    stamp = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%S.%fZ')
    backup = Path('/root/crypto-auth-transport-backups') / stamp
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(str(SITE), str(backup / 'auth.vpn.before'))
    staged = SITE.with_name('auth.vpn.crypto-transport-stage')
    with staged.open('x') as handle:
        handle.write(changed)
    shutil.copystat(str(SITE), str(staged))
    if SITE.read_text() != original:
        staged.unlink()
        raise RuntimeError('concurrent vhost edit; not applied')
    staged.replace(SITE)
    try:
        run('/usr/sbin/nginx', '-t')
        run('systemctl', 'reload', 'nginx')
    except Exception:
        if SITE.read_text() == changed:
            shutil.copy2(str(backup / 'auth.vpn.before'), str(SITE))
            run('/usr/sbin/nginx', '-t')
            run('systemctl', 'reload', 'nginx')
        raise
    result = {'ok': True, 'backup': str(backup), 'addedSource': '192.168.3.2',
              'beforeSha256': hashlib.sha256(original.encode()).hexdigest(),
              'afterSha256': hashlib.sha256(changed.encode()).hexdigest()}
    target = Path('/home/mil/robot.crypto.jsnode/auth-transport-acl-status.json')
    target.write_text(json.dumps(result) + '\n')
    target.chmod(0o644)
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'ok': False, 'error': 'crypto-auth-transport-failed'}))
        sys.exit(1)
