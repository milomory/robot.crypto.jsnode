#!/usr/bin/env python3
"""Run on Hyperion as mil after explicit SSO activation authorization."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
import yaml

ROOT = Path('/home/mil/robot.crypto.jsnode')
RELEASE = ROOT / 'releases/e5d7192'
BACKUP = ROOT / 'backups/sso-20260919T122313Z'

def run(args):
    return subprocess.run(args, cwd=str(ROOT), stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True).stdout

def main():
    os.umask(0o077)
    secret_file = ROOT / '.env.auth-core'
    values = dict(line.split('=', 1) for line in secret_file.read_text().splitlines()
                  if line and not line.startswith('#'))
    if set(values) != {'AUTH_CORE_CLIENT_SECRET', 'AUTH_CORE_VIEWER_IDS'}:
        raise RuntimeError('unexpected credential file keys')
    if len(values['AUTH_CORE_CLIENT_SECRET']) < 32:
        raise RuntimeError('client secret invalid')
    uuid.UUID(values['AUTH_CORE_VIEWER_IDS'])  # exactly one selected subject
    if secret_file.stat().st_mode & 0o077 or not (RELEASE / 'src/auth/auth-core.ts').is_file():
        raise RuntimeError('release or credential permissions invalid')
    del values
    override = ROOT / 'docker-compose.override.yml'
    original = override.read_bytes()
    config = yaml.safe_load(original)
    api = config['services']['api']
    if api['environment']['AUTH_CORE_ENABLED'] != 'false':
        raise RuntimeError('SSO already enabled; inspect instead of repeating')
    if not (BACKUP / 'database.dump').is_file():
        raise RuntimeError('backup missing')
    api['environment'].update({'AUTH_CORE_ENABLED': 'true',
        'AUTH_CORE_ORIGIN': 'https://auth.vpn', 'AUTH_CORE_APP_ORIGIN': 'https://crypto.robot.vpn'})
    api['env_file'] = ['./.env.auth-core']
    api['volumes'].append('./releases/e5d7192:/code')
    staged = ROOT / 'docker-compose.sso-staged.yml'
    with staged.open('x') as f:
        yaml.safe_dump(config, f, default_flow_style=False)
    merged = yaml.safe_load(run(['docker-compose', '-f', 'docker-compose.yml', '-f', staged.name, 'config']))
    old = yaml.safe_load(run(['docker-compose', 'config']))
    if merged['services']['db'] != old['services']['db']:
        raise RuntimeError('DB configuration changed')
    a, b = old['services']['api'], merged['services']['api']
    for key in ['image', 'command', 'ports', 'networks', 'extra_hosts']:
        if a.get(key) != b.get(key):
            raise RuntimeError('unrelated configuration changed')
    for key, value in a['environment'].items():
        if not key.startswith('AUTH_CORE_') and b['environment'].get(key) != value:
            raise RuntimeError('existing environment changed')
    if override.read_bytes() != original:
        raise RuntimeError('concurrent override edit')
    shutil.copy2(str(override), str(BACKUP / 'override.before-activation.yml'))
    staged.replace(override)
    try:
        run(['docker-compose', 'up', '-d', '--no-deps', '--force-recreate', 'api'])
    except Exception:
        shutil.copy2(str(BACKUP / 'override.before-activation.yml'), str(override))
        run(['docker-compose', 'up', '-d', '--no-deps', '--force-recreate', 'api'])
        raise
    print(json.dumps({'ok': True, 'release': str(RELEASE), 'backup': str(BACKUP),
                      'SSO': 'enabled', 'readiness': 'must verify separately'}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'ok': False, 'error': 'activation-failed-inspect-protected-state'}))
        raise SystemExit(1)
