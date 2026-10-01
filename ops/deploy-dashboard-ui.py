#!/usr/bin/env python3
"""Manifest-pinned UI-only rollout; Python 3.6 compatible, no secrets in output.

Deploy: deploy-dashboard-ui.py REVISION40 MANIFEST_SHA256
Undo:   deploy-dashboard-ui.py --rollback BACKUP_DIRECTORY_BASENAME
Only an exact, still-current UI change can be rolled back. No Auth/DB rollback.
The pinned legacy build/migration startup is replaced by the existing compiled
server. Recovery keeps this safe startup and restores the previous UI only.
"""
import contextlib
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shlex
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import yaml

ROOT = Path('/home/mil/robot.crypto.jsnode')
PROJECTION = '/home/mil/crypto-pair-observer/state/dashboard'
UI_TARGET = '/code/ui/dist'
APP = 'robot_crypto_jsnode'
DB = 'pg-crypto-robot'
BACKUP_PATTERN = r'dashboard-ui-\d{8}T\d{6}\.\d{6}Z-[a-f0-9]{8}'
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
LEGACY_COMMAND_SHA256 = 'd98266c260e84d0cff83f22c5cf366990cd3ebaa88a9de46804876aa58d9ba34'
SERVER_COMMAND = ['node', 'dist/server.js']


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf8')


def run(args):
    # Compose config and inspect can contain secrets: capture both streams and
    # never include subprocess errors, raw output or command data in reports.
    return subprocess.check_output(args, cwd=str(ROOT), stderr=subprocess.PIPE, timeout=180)


def regular(path, limit=MAX_FILE, private=False):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != 1002 or s.st_mode & (0o077 if private else 0o022) or s.st_size > limit:
        raise ValueError()
    raw = path.read_bytes()
    if len(raw) != s.st_size:
        raise ValueError()
    return raw


def directory(path):
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 1002 or s.st_mode & 0o022:
        raise ValueError()


def write_private(path, raw):
    with path.open('xb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def verify_release(revision, manifest_hash):
    if not re.fullmatch('[a-f0-9]{40}', revision) or not re.fullmatch('[a-f0-9]{64}', manifest_hash):
        raise ValueError()
    base = ROOT / 'ui-releases'
    release = base / revision
    for path in [ROOT, base, release, release / 'dist', release / 'dist/assets']:
        directory(path)
    manifest_raw = regular(release / 'manifest.json', 128 * 1024)
    if digest(manifest_raw) != manifest_hash:
        raise ValueError()
    manifest = json.loads(manifest_raw)
    if set(manifest) != {'schema', 'sourceRevision', 'files'} or manifest['schema'] != 1 or manifest['sourceRevision'] != revision:
        raise ValueError()
    files = manifest['files']
    if not isinstance(files, dict) or not 2 <= len(files) <= 256 or 'dist/index.html' not in files:
        raise ValueError()
    allowed = r'dist/(index\.html|assets/[A-Za-z0-9_-]+\.(?:js|css|svg|png|jpe?g|webp|ico|woff2?|ttf))'
    if any(not re.fullmatch(allowed, name) or not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{64}', sha) for name, sha in files.items()):
        raise ValueError()
    actual, total = set(), len(manifest_raw)
    for path in release.rglob('*'):
        name = str(path.relative_to(release))
        s = path.lstat()
        if stat.S_ISDIR(s.st_mode):
            if name not in ('dist', 'dist/assets'):
                raise ValueError()
            directory(path)
        else:
            if name != 'manifest.json' and name not in files:
                raise ValueError()
            raw = regular(path)
            total += len(raw)
            if total > MAX_TOTAL:
                raise ValueError()
            actual.add(name)
            if name in files and digest(raw) != files[name]:
                raise ValueError()
    if actual != set(files) | {'manifest.json'}:
        raise ValueError()
    return release / 'dist'


def mount(value):
    if isinstance(value, str):
        parts = value.split(':')
        if len(parts) not in (2, 3):
            raise ValueError()
        return parts[0], parts[1], len(parts) == 3 and parts[2] == 'ro'
    return value['source'], value['target'], value.get('read_only', False)


def mounts(api):
    result = [mount(value) for value in api.get('volumes', [])]
    if len({target for _, target, _ in result}) != len(result):
        raise ValueError()
    return sorted(result)


def config(staged=None):
    args = ['docker-compose']
    if staged is not None:
        args += ['-f', 'docker-compose.yml', '-f', str(staged)]
    return yaml.safe_load(run(args + ['config']))


def command(value):
    parsed = shlex.split(value) if isinstance(value, str) else value
    if not isinstance(parsed, list) or any(not isinstance(part, str) for part in parsed):
        raise ValueError()
    if parsed != SERVER_COMMAND and digest(canonical(parsed)) != LEGACY_COMMAND_SHA256:
        raise ValueError()
    return parsed


def validate_current(value):
    api = value['services']['api']
    command(api.get('command'))
    env = api['environment']
    if str(env.get('AUTH_CORE_ENABLED')).lower() != 'true' or str(env.get('LIVE_TRADING_LOCKED')).lower() != 'true' or env.get('TRADING_MODE') != 'paper':
        raise ValueError()
    found = {target: (source, ro) for source, target, ro in mounts(api)}
    source, _ = found['/code']
    if not re.fullmatch(re.escape(str(ROOT)) + '/releases/[a-f0-9]{40}', source):
        raise ValueError()
    if found.get('/run/crypto-accounts') != (PROJECTION, True):
        raise ValueError()
    if UI_TARGET in found:
        previous, read_only = found[UI_TARGET]
        if not re.fullmatch(re.escape(str(ROOT)) + '/ui-releases/[a-f0-9]{40}/dist', previous) or read_only is not True:
            raise ValueError()
    # No hidden child mount may supersede the immutable UI overlay.
    if any(target.startswith(UI_TARGET + '/') for target in found):
        raise ValueError()
    ports = api.get('ports', [])
    if len(ports) != 1:
        raise ValueError()
    port = ports[0]
    if isinstance(port, str):
        good = port in ('127.0.0.1:5758:3000', '127.0.0.1:5758:3000/tcp')
    else:
        good = port.get('host_ip') == '127.0.0.1' and str(port.get('published')) == '5758' and str(port.get('target')) == '3000' and port.get('protocol', 'tcp') == 'tcp'
    if not good:
        raise ValueError()


def exact_delta(old, new, target):
    validate_current(old)
    validate_current(new)
    expected = copy.deepcopy(old)
    if command(new['services']['api']['command']) != SERVER_COMMAND:
        raise ValueError()
    expected['services']['api']['command'] = new['services']['api']['command']
    expected['services']['api']['volumes'] = new['services']['api']['volumes']
    wanted = [v for v in mounts(old['services']['api']) if v[1] != UI_TARGET]
    wanted.append((str(target), UI_TARGET, True))
    if expected != new or sorted(wanted) != mounts(new['services']['api']):
        raise ValueError()


def inspect(name):
    values = json.loads(run(['docker', 'inspect', name]))
    if len(values) != 1:
        raise ValueError()
    return values[0]


def identity(value):
    return {
        'Id': value['Id'], 'Image': value['Image'], 'Created': value['Created'],
        'StartedAt': value['State']['StartedAt'], 'Running': value['State']['Running'],
        'RestartCount': value['RestartCount'], 'OOMKilled': value['State'].get('OOMKilled', False)}


def runtime_contract(value):
    # Container identity/hostname/config-hash change on recreation. Everything
    # else in Config + HostConfig stays exact, except the one new UI bind.
    cfg = copy.deepcopy(value['Config'])
    command(cfg.get('Cmd'))
    cfg['Cmd'] = SERVER_COMMAND
    hostname = cfg.pop('Hostname', '')
    if hostname != value['Id'][:12]:
        cfg['Hostname'] = hostname
    cfg.get('Labels', {}).pop('com.docker.compose.config-hash', None)
    cfg['Env'] = sorted(cfg.get('Env', []))
    volumes = cfg.get('Volumes') or {}
    if UI_TARGET in volumes:
        if volumes.pop(UI_TARGET) != {}:
            raise ValueError()
    cfg['Volumes'] = volumes
    host = copy.deepcopy(value['HostConfig'])
    binds = host.pop('Binds', None) or []
    parsed = [mount(item) for item in binds]
    host['Binds'] = sorted(item for item in parsed if item[1] != UI_TARGET)
    attached = []
    for item in value['Mounts']:
        if item['Destination'] != UI_TARGET:
            attached.append({key: item.get(key) for key in ['Type', 'Name', 'Source', 'Destination', 'RW', 'Propagation']})
    return {'image': value['Image'], 'config': cfg, 'host': host,
            'mounts': sorted(attached, key=lambda item: item['Destination']),
            'networks': sorted(value['NetworkSettings']['Networks'])}


def validate_runtime(value, effective, overlay=None):
    if value['State'].get('Running') is not True or value['State'].get('OOMKilled') or value['RestartCount'] != 0:
        raise ValueError()
    runtime = value['Config']
    if command(runtime.get('Cmd')) != command(effective['services']['api'].get('command')) or runtime.get('WorkingDir') != '/code' or runtime.get('Entrypoint') != ['docker-entrypoint.sh']:
        raise ValueError()
    env = dict(item.split('=', 1) for item in runtime['Env'])
    if env.get('TRADING_MODE') != 'paper' or env.get('AUTH_CORE_ENABLED', '').lower() != 'true' or env.get('LIVE_TRADING_LOCKED', '').lower() != 'true':
        raise ValueError()
    if value['HostConfig'].get('PortBindings') != {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5758'}]}:
        raise ValueError()
    expected = {t: (s, ro) for s, t, ro in mounts(effective['services']['api']) if t in ('/code', '/run/crypto-accounts', UI_TARGET)}
    actual = {item['Destination']: (item['Source'], not item['RW']) for item in value['Mounts'] if item['Destination'] in expected}
    if actual != expected:
        raise ValueError()
    if overlay is not None and actual.get(UI_TARGET) != (str(overlay), True):
        raise ValueError()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    result = []
    for path in ['/health', '/', '/api/accounts/dashboard']:
        request = urllib.request.Request('http://127.0.0.1:5758' + path,
            headers={'Host': 'crypto.robot.vpn', 'X-Forwarded-Proto': 'https'})
        try:
            response = opener.open(request, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(4097)
            if len(raw) > 4096:
                raise ValueError()
            status = response.code
            # Cookies/Location/body remain private; only expected booleans leave.
            if path == '/health' and (status != 200 or json.loads(raw).get('ok') is not True):
                raise ValueError()
            if path == '/' and (status != 303 or response.headers.get('Location') != '/auth/login'):
                raise ValueError()
            if path.startswith('/api/') and (status != 401 or response.headers.get('Location')):
                raise ValueError()
            result.append(status)
    return result


def readiness():
    deadline = time.monotonic() + 45
    while True:
        try:
            return probe()
        except (ValueError, OSError, urllib.error.URLError):
            if time.monotonic() >= deadline:
                raise ValueError()
            time.sleep(1)


@contextlib.contextmanager
def atomic_signals():
    signals = {signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def unchanged(original, base, expected, db, api=None):
    if regular(ROOT / 'docker-compose.override.yml') != original or regular(ROOT / 'docker-compose.yml') != base or config() != expected or identity(inspect(DB)) != db:
        raise ValueError()
    if api is not None and identity(inspect(APP)) != api:
        raise ValueError()


def recreate():
    run(['docker-compose', 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'api'])


def replace_private(destination, raw):
    staged = destination.with_name('.ui-restore-' + uuid.uuid4().hex)
    write_private(staged, raw)
    staged.replace(destination)


class Failed(Exception):
    def __init__(self, result):
        self.result = result


def deploy(revision, manifest_hash):
    target = verify_release(revision, manifest_hash)
    override = ROOT / 'docker-compose.override.yml'
    original = regular(override)
    base = regular(ROOT / 'docker-compose.yml')
    old = config()
    validate_current(old)
    before = inspect(APP)
    validate_runtime(before, old)
    db = identity(inspect(DB))
    if db['Running'] is not True:
        raise ValueError()
    staged_value = yaml.safe_load(original)
    api = staged_value['services']['api']
    api['command'] = list(SERVER_COMMAND)
    recovery_raw = yaml.safe_dump(staged_value, default_flow_style=False).encode('utf8')
    api['volumes'] = [v for v in api.get('volumes', []) if mount(v)[1] != UI_TARGET]
    api['volumes'].append(str(target) + ':' + UI_TARGET + ':ro')
    candidate = yaml.safe_dump(staged_value, default_flow_style=False).encode('utf8')
    backup_root = ROOT / 'backups'
    directory(backup_root)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = backup_root / ('dashboard-ui-' + stamp + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(mode=0o700)
    write_private(backup / 'docker-compose.override.yml', original)
    write_private(backup / 'candidate.yml', candidate)
    write_private(backup / 'recovery.yml', recovery_raw)
    # Compose resolves relative bind/env paths against the base file in ROOT.
    recovery = config(backup / 'recovery.yml')
    expected_recovery = copy.deepcopy(old)
    expected_recovery['services']['api']['command'] = recovery['services']['api']['command']
    if command(recovery['services']['api']['command']) != SERVER_COMMAND or expected_recovery != recovery:
        raise ValueError()
    new = config(backup / 'candidate.yml')
    exact_delta(old, new, target)
    exact_delta(recovery, new, target)
    metadata = {'schema': 1, 'revision': revision, 'manifestSha256': manifest_hash,
        'oldEffectiveSha256': digest(canonical(recovery)), 'initialEffectiveSha256': digest(canonical(old)), 'newEffectiveSha256': digest(canonical(new)),
        'baseSha256': digest(base), 'dbIdentity': db,
        'runtimeContractSha256': digest(canonical(runtime_contract(before)))}
    write_private(backup / 'deployment.json', canonical(metadata))
    unchanged(original, base, old, db, identity(before))
    verify_release(revision, manifest_hash)
    stage = ROOT / ('.ui-override-' + uuid.uuid4().hex)
    write_private(stage, candidate)
    applied = False
    try:
        with atomic_signals():
            stage.replace(override)
            applied = True
        # Close the final pre-recreate drift window before touching the container.
        unchanged(candidate, base, new, db, identity(before))
        recreate()
        codes = readiness()
        after = inspect(APP)
        validate_runtime(after, new, target)
        if runtime_contract(after) != runtime_contract(before) or after['Id'] == before['Id']:
            raise ValueError()
        unchanged(candidate, base, new, db, identity(after))
        verify_release(revision, manifest_hash)
        write_private(backup / 'accepted.json', canonical({'apiIdentity': identity(after), 'codes': codes}))
        return {'configured': True, 'ready': True, 'revision': revision, 'backup': str(backup),
                'frontendOnly': True, 'startupUsesExistingCompiledServer': True, 'databaseUnchanged': True, 'health': codes[0],
                'anonymousDocument': codes[1], 'anonymousApi': codes[2]}
    except BaseException:
        # Signals cannot interrupt the rollback halfway. A SIGKILL at an
        # incomplete stage needs manual review of the retained protected backup;
        # --rollback requires a verified matching running deployment.
        for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            signal.signal(sig, signal.SIG_IGN)
        result = {'configured': False, 'error': 'ui-rollout-failed', 'backup': str(backup), 'rollback': 'not-required'}
        if applied:
            result['rollback'] = 'blocked-config-drift'
            try:
                unchanged(candidate, base, new, db)
            except BaseException:
                raise Failed(result)
            try:
                replace_private(override, recovery_raw)
                recreate()
                readiness()
                restored = inspect(APP)
                validate_runtime(restored, recovery)
                if runtime_contract(restored) != runtime_contract(before):
                    raise ValueError()
                unchanged(recovery_raw, base, recovery, db, identity(restored))
                result['rollback'] = 'restored-ui-safe-startup-ready'
            except BaseException:
                result['rollback'] = 'restore-needs-review'
        raise Failed(result)


def rollback(name):
    if not re.fullmatch(BACKUP_PATTERN, name):
        raise ValueError()
    backup = ROOT / 'backups' / name
    directory(ROOT / 'backups')
    directory(backup)
    regular(backup / 'docker-compose.override.yml', private=True)
    original = regular(backup / 'recovery.yml', private=True)
    candidate = regular(backup / 'candidate.yml', private=True)
    metadata = json.loads(regular(backup / 'deployment.json', private=True))
    if metadata.get('schema') != 1:
        raise ValueError()
    base = regular(ROOT / 'docker-compose.yml')
    now = config()
    if digest(base) != metadata['baseSha256'] or digest(canonical(now)) != metadata['newEffectiveSha256']:
        raise ValueError()
    validate_current(now)
    current = inspect(APP)
    validate_runtime(current, now)
    if digest(canonical(runtime_contract(current))) != metadata['runtimeContractSha256']:
        raise ValueError()
    accepted = backup / 'accepted.json'
    if accepted.exists() and json.loads(regular(accepted, private=True))['apiIdentity'] != identity(current):
        raise ValueError()
    old = config(backup / 'recovery.yml')
    if digest(canonical(old)) != metadata['oldEffectiveSha256']:
        raise ValueError()
    exact_delta(old, now, ROOT / 'ui-releases' / metadata['revision'] / 'dist')
    unchanged(candidate, base, now, metadata['dbIdentity'], identity(current))
    with atomic_signals():
        replace_private(ROOT / 'docker-compose.override.yml', original)
    recreate()
    codes = readiness()
    restored = inspect(APP)
    validate_runtime(restored, old)
    if digest(canonical(runtime_contract(restored))) != metadata['runtimeContractSha256']:
        raise ValueError()
    unchanged(original, base, old, metadata['dbIdentity'], identity(restored))
    return {'configured': True, 'rolledBack': True, 'startupUsesExistingCompiledServer': True, 'ready': True, 'backup': str(backup), 'health': codes[0], 'anonymousDocument': codes[1], 'anonymousApi': codes[2]}


def main():
    os.umask(0o077)
    if os.getuid() != 1002 or len(sys.argv) != 3:
        raise ValueError()
    directory(ROOT)
    lock = ROOT / '.dashboard-ui-rollout.lock'
    descriptor = os.open(str(lock), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+b') as handle:
        regular(lock, private=True)
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = rollback(sys.argv[2]) if sys.argv[1] == '--rollback' else deploy(sys.argv[1], sys.argv[2])
    print(json.dumps(result, sort_keys=True))


def interrupted(_signal, _frame):
    raise InterruptedError()


if __name__ == '__main__':
    for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
        signal.signal(sig, interrupted)
    try:
        main()
    except Failed as error:
        print(json.dumps(error.result, sort_keys=True))
        sys.exit(1)
    except BaseException:
        print('{"configured":false,"error":"ui-deployment-validation-failed"}')
        sys.exit(1)
