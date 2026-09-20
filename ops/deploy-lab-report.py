#!/usr/bin/env python3
"""Scoped Hyperion report rollout. No credentials in output; no schema changes."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

import yaml

ROOT = Path('/home/mil/robot.crypto.jsnode')
EVIDENCE = Path('/home/mil/crypto-market-observations/store')

def run(args):
    return subprocess.check_output(args, cwd=str(ROOT), stderr=subprocess.PIPE)

def fingerprints(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob('*') if p.is_file()}

def mount(value):
    if isinstance(value, str):
        parts = value.split(':')
        return parts[0], parts[1], len(parts) > 2 and parts[2] == 'ro'
    return value['source'], value['target'], value.get('read_only', False)

def main():
    os.umask(0o077)
    revision = sys.argv[1]
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise RuntimeError('invalid revision')
    release = ROOT / 'releases' / revision
    override = ROOT / 'docker-compose.override.yml'
    original = override.read_bytes()
    config = yaml.safe_load(original)
    old = yaml.safe_load(run(['docker-compose', 'config']))
    if old['services']['api']['environment'].get('AUTH_CORE_ENABLED') != 'true':
        raise RuntimeError('unexpected auth state')
    old_mounts = [mount(v) for v in old['services']['api']['volumes']]
    previous = Path(next(source for source, target, ro in old_mounts if target == '/code'))
    for directory in ['migrations', 'src/services', 'src/exchange', 'src/risk', 'src/journal']:
        if fingerprints(previous / directory) != fingerprints(release / directory):
            raise RuntimeError('trading or migration files changed')
    if not (release / 'src/lab/instruments.ts').is_file() or not (EVIDENCE / 'current.json').is_file():
        raise RuntimeError('missing prepared release or evidence')
    api = config['services']['api']
    api['volumes'] = [v for v in api['volumes'] if mount(v)[1] not in ['/code', '/run/crypto-lab/report']]
    api['volumes'].extend([str(release) + ':/code', str(EVIDENCE) + ':/run/crypto-lab/report:ro'])
    api['environment']['LAB_OBSERVATION_RUN_DIR'] = '/run/crypto-lab/report'
    staged = ROOT / ('docker-compose.lab-' + revision[:7] + '.yml')
    with staged.open('x') as f:
        yaml.safe_dump(config, f, default_flow_style=False)
    new = yaml.safe_load(run(['docker-compose', '-f', 'docker-compose.yml', '-f', staged.name, 'config']))
    expected = copy.deepcopy(old)
    expected['services']['api']['environment']['LAB_OBSERVATION_RUN_DIR'] = '/run/crypto-lab/report'
    new_mounts = [mount(v) for v in new['services']['api']['volumes']]
    wanted = [(str(release) if target == '/code' else source, target, ro) for source, target, ro in old_mounts if target != '/run/crypto-lab/report']
    wanted.append((str(EVIDENCE), '/run/crypto-lab/report', True))
    if sorted(new_mounts) != sorted(wanted):
        raise RuntimeError('unexpected mounts')
    expected['services']['api']['volumes'] = new['services']['api']['volumes']
    if expected != new or override.read_bytes() != original:
        raise RuntimeError('unrelated or concurrent configuration change')
    backup = ROOT / 'backups' / ('lab-report-' + revision[:7])
    backup.mkdir()
    shutil.copy2(str(override), str(backup / 'docker-compose.override.yml'))
    (backup / 'deployment.json').write_text(json.dumps({'release': str(release), 'previous': str(previous),
        'evidence': str(EVIDENCE), 'revision': revision}))
    staged.replace(override)
    try:
        run(['docker-compose', 'up', '-d', '--no-deps', '--force-recreate', 'api'])
    except Exception:
        shutil.copy2(str(backup / 'docker-compose.override.yml'), str(override))
        run(['docker-compose', 'up', '-d', '--no-deps', '--force-recreate', 'api'])
        raise
    print(json.dumps({'configured': True, 'release': revision, 'backup': str(backup),
        'readiness': 'pending'}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'configured': False, 'error': 'scoped-lab-rollout-failed'}))
        sys.exit(1)
