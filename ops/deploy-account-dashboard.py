#!/usr/bin/env python3
"""Hyperion consumer-scoped account dashboard rollout. No secret values output."""
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import yaml

ROOT = Path('/home/mil/robot.crypto.jsnode')
PROJECTION = Path('/home/mil/crypto-pair-observer/state/dashboard')
APP = 'robot_crypto_jsnode'
DB = 'pg-crypto-robot'
SERVER_COMMAND = ['node', 'dist/server.js']
TRADING = ['migrations', 'src/services', 'src/exchange', 'src/risk', 'src/journal',
           'dist/services', 'dist/exchange', 'dist/risk', 'dist/journal']

def run(args):
    return subprocess.check_output(args, cwd=str(ROOT), stderr=subprocess.PIPE, timeout=180)

def fingerprints(directory):
    if not directory.is_dir() or directory.is_symlink() or any(p.is_symlink() for p in directory.rglob('*')):
        raise ValueError()
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in directory.rglob('*') if p.is_file()}

def mount(value):
    if isinstance(value, str):
        p = value.split(':')
        if len(p) not in (2, 3) or (len(p) == 3 and p[2] not in ('ro', 'rw')):
            raise ValueError()
        return p[0], p[1], len(p) > 2 and p[2] == 'ro'
    return value['source'], value['target'], value.get('read_only', False)

def private(path):
    s = path.lstat()
    if path.is_symlink() or not path.is_file() or s.st_nlink != 1 or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError()
    return path.read_bytes()

def command(value):
    parsed = shlex.split(value) if isinstance(value, str) else value
    if parsed != SERVER_COMMAND:
        raise ValueError()
    return parsed


def inspect(name):
    values = json.loads(run(['docker', 'inspect', name]))
    if len(values) != 1:
        raise ValueError()
    return values[0]


def identity(value):
    return {
        'Id': value['Id'], 'Image': value['Image'], 'Created': value['Created'],
        'RestartCount': value['RestartCount'], 'StartedAt': value['State']['StartedAt'],
        'Running': value['State']['Running'], 'OOMKilled': value['State'].get('OOMKilled', False)}


def mounts(api):
    values = [mount(v) for v in api.get('volumes', [])]
    if len({target for _, target, _ in values}) != len(values):
        raise ValueError()
    return sorted(values)


def validate_runtime(value, effective):
    api, cfg = effective['services']['api'], value['Config']
    command(api.get('command'))
    if cfg.get('Cmd') != SERVER_COMMAND or cfg.get('WorkingDir') != '/code' or cfg.get('Entrypoint') != ['docker-entrypoint.sh']:
        raise ValueError()
    if value['State'].get('Running') is not True or value['State'].get('OOMKilled') or value['RestartCount'] != 0:
        raise ValueError()
    env = dict(item.split('=', 1) for item in cfg['Env'])
    if len(env) != len(cfg['Env']):
        raise ValueError()
    expected_env = api['environment']
    for key, expected in expected_env.items():
        if env.get(key) != str(expected):
            raise ValueError()
    for key in ['AUTH_CORE_OWNER_IDS', 'ACCOUNT_DASHBOARD_DIR']:
        if env.get(key) != expected_env.get(key):
            raise ValueError()
    if env.get('TRADING_MODE') != 'paper' or env.get('AUTH_CORE_ENABLED', '').lower() != 'true' or env.get('LIVE_TRADING_LOCKED', '').lower() != 'true':
        raise ValueError()
    if value['HostConfig'].get('PortBindings') != {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5758'}]}:
        raise ValueError()
    wanted = {t: (s, ro) for s, t, ro in mounts(api) if t in ['/code', '/run/crypto-accounts', '/code/ui/dist']}
    actual = {m['Destination']: (m['Source'], not m['RW']) for m in value['Mounts'] if m['Destination'] in wanted}
    if wanted != actual or len({m['Destination'] for m in value['Mounts']}) != len(value['Mounts']):
        raise ValueError()


def runtime_contract(value):
    # Only approved /code source, account-reader bind and owner projection env
    # can differ. UI overlay, other bindings, image and all other env stay exact.
    cfg = copy.deepcopy(value['Config'])
    hostname = cfg.pop('Hostname', '')
    if hostname != value['Id'][:12]:
        cfg['Hostname'] = hostname
    cfg.get('Labels', {}).pop('com.docker.compose.config-hash', None)
    cfg['Env'] = sorted(item for item in cfg.get('Env', []) if item.split('=', 1)[0] not in ['AUTH_CORE_OWNER_IDS', 'ACCOUNT_DASHBOARD_DIR'])
    volumes = cfg.get('Volumes') or {}
    if '/run/crypto-accounts' in volumes and volumes.pop('/run/crypto-accounts') != {}:
        raise ValueError()
    cfg['Volumes'] = volumes
    host = copy.deepcopy(value['HostConfig'])
    binds = [mount(item) for item in host.pop('Binds', None) or []]
    host['Binds'] = sorted(('/approved-release' if target == '/code' else source, target, ro)
        for source, target, ro in binds if target != '/run/crypto-accounts')
    attached = []
    for item in value['Mounts']:
        if item['Destination'] == '/run/crypto-accounts':
            continue
        record = {key: item.get(key) for key in ['Type', 'Name', 'Source', 'Destination', 'RW', 'Propagation']}
        if record['Destination'] == '/code':
            record['Source'] = '/approved-release'
        attached.append(record)
    return {'image': value['Image'], 'config': cfg, 'host': host,
        'mounts': sorted(attached, key=lambda item: item['Destination']),
        'networks': sorted(value['NetworkSettings']['Networks'])}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    codes = []
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
            code = response.code
            if path == '/health' and (code != 200 or json.loads(raw).get('ok') is not True):
                raise ValueError()
            if path == '/' and (code != 303 or response.headers.get('Location') != '/auth/login'):
                raise ValueError()
            if path.startswith('/api/') and (code != 401 or response.headers.get('Location')):
                raise ValueError()
            codes.append(code)
    return codes


def readiness():
    deadline = time.monotonic() + 45
    while True:
        try:
            return probe()
        except (ValueError, OSError, urllib.error.URLError):
            if time.monotonic() >= deadline:
                raise ValueError()
            time.sleep(1)


def recreate():
    run(['docker-compose', 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'api'])


def replace_private(path, raw):
    staged = path.with_name('.account-restore-' + uuid.uuid4().hex)
    with staged.open('xb') as out:
        os.fchmod(out.fileno(), 0o600)
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    staged.replace(path)


@contextlib.contextmanager
def atomic_signals():
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP})
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


class Failed(Exception):
    def __init__(self, result):
        self.result = result


def rollout():
    os.umask(0o077)
    if len(sys.argv) != 2 or not re.fullmatch('[a-f0-9]{40}', sys.argv[1]) or os.getuid() != 1002:
        raise ValueError()
    revision = sys.argv[1]
    release = ROOT / 'releases' / revision
    if release.is_symlink() or not release.is_dir():
        raise ValueError()
    manifest_path = release / 'dashboard-manifest.json'
    manifest = json.loads(manifest_path.read_bytes())
    actual = {str(p.relative_to(release)) for p in release.rglob('*') if p.is_file()}
    if actual != set(manifest) | {'dashboard-manifest.json'} or any(p.is_symlink() or p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o022 for p in release.rglob('*')):
        raise ValueError()
    if any(hashlib.sha256((release / name).read_bytes()).hexdigest() != digest for name,digest in manifest.items()):
        raise ValueError()
    override = ROOT / 'docker-compose.override.yml'
    env_path = ROOT / '.env.auth-core'
    original = private(override) if override.stat().st_mode & 0o077 == 0 else override.read_bytes()
    if override.is_symlink() or override.stat().st_nlink != 1 or override.stat().st_uid != os.getuid() or override.stat().st_mode & 0o022:
        raise ValueError()
    base = (ROOT / 'docker-compose.yml').read_bytes()
    env_original = private(env_path)
    config = yaml.safe_load(original)
    old = yaml.safe_load(run(['docker-compose', 'config']))
    command(old['services']['api'].get('command'))
    before = inspect(APP)
    validate_runtime(before, old)
    db = identity(inspect(DB))
    if db['Running'] is not True:
        raise ValueError()
    contract = runtime_contract(before)
    environment = old['services']['api']['environment']
    if str(environment.get('AUTH_CORE_ENABLED')).lower() != 'true' or str(environment.get('LIVE_TRADING_LOCKED')).lower() != 'true':
        raise ValueError()
    viewers = environment.get('AUTH_CORE_VIEWER_IDS', '').split(',')
    # Freeze only the single previously approved owner; never infer all viewers
    # are account owners or change shared Auth membership.
    if len(viewers) != 1 or not re.fullmatch('[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', viewers[0]):
        raise ValueError()
    if environment.get('AUTH_CORE_OWNER_IDS') not in (None, '', viewers[0]):
        raise ValueError()
    lines = env_original.decode('utf8').splitlines()
    existing = [line.split('=',1)[1] for line in lines if line.startswith('AUTH_CORE_OWNER_IDS=')]
    if existing and existing != [viewers[0]]:
        raise ValueError()
    env_new = env_original if existing else env_original.rstrip(b'\n') + b'\nAUTH_CORE_OWNER_IDS=' + viewers[0].encode('ascii') + b'\n'
    old_mounts = mounts(old['services']['api'])
    previous = Path(next(source for source, target, ro in old_mounts if target == '/code'))
    if previous.is_symlink() or not re.fullmatch(re.escape(str(ROOT)) + '/releases/[a-f0-9]{40}', str(previous)):
        raise ValueError()
    trading = {directory: fingerprints(previous / directory) for directory in TRADING}
    def unchanged_previous_trading():
        if any(fingerprints(previous / directory) != trading[directory] for directory in TRADING):
            raise ValueError()
    def unchanged_trading():
        unchanged_previous_trading()
        if any(fingerprints(release / directory) != trading[directory] for directory in TRADING):
            raise ValueError()
    unchanged_trading()
    if not (release / 'dist/http/account-dashboard-routes.js').is_file() or not (release / 'ui/dist/index.html').is_file():
        raise ValueError()
    report = json.loads(private(PROJECTION / 'current.json'))
    if report.get('schema') != 1 or report.get('liveExecutionEnabled') is not False:
        raise ValueError()
    api = config['services']['api']
    api['volumes'] = [v for v in api['volumes'] if mount(v)[1] not in ['/code', '/run/crypto-accounts']]
    code_ro = next(ro for _,target,ro in old_mounts if target == '/code')
    api['volumes'].extend([str(release) + ':/code' + (':ro' if code_ro else ''), str(PROJECTION) + ':/run/crypto-accounts:ro'])
    api['environment']['ACCOUNT_DASHBOARD_DIR'] = '/run/crypto-accounts'
    # Avoid literal private UUID in compose YAML: the existing protected env_file
    # contributes the new owner setting without changing other env fields.
    if 'AUTH_CORE_OWNER_IDS' in api['environment']:
        raise ValueError()
    staged = ROOT / ('docker-compose.accounts-' + revision[:7] + '.yml')
    with staged.open('x') as out:
        yaml.safe_dump(config, out, default_flow_style=False)
    backup = ROOT / 'backups' / ('account-dashboard-' + revision[:7])
    backup.mkdir(mode=0o700)
    (backup / 'docker-compose.override.yml').write_bytes(original)
    (backup / '.env.auth-core').write_bytes(env_original)
    (backup / 'deployment.json').write_text(json.dumps({'release': str(release), 'previous': str(previous), 'revision': revision}))
    temp_env = env_path.with_name('.env.auth-core.dashboard-' + revision[:7])
    with temp_env.open('xb') as out:
        out.write(env_new)
    if override.read_bytes() != original or env_path.read_bytes() != env_original:
        raise ValueError()
    applied = False
    env_applied = False
    candidate = staged.read_bytes()
    def unchanged_files(wanted_override, wanted_env):
        if override.read_bytes() != wanted_override or private(env_path) != wanted_env or (ROOT / 'docker-compose.yml').read_bytes() != base:
            raise ValueError()
    def unchanged_runtime(wanted, api_identity=None):
        if yaml.safe_load(run(['docker-compose', 'config'])) != wanted or identity(inspect(DB)) != db:
            raise ValueError()
        if api_identity is not None and identity(inspect(APP)) != api_identity:
            raise ValueError()
    try:
        unchanged_trading()
        unchanged_runtime(old, identity(before))
        with atomic_signals():
            temp_env.replace(env_path)
            env_applied = True
        new = yaml.safe_load(run(['docker-compose','-f','docker-compose.yml','-f',staged.name,'config']))
        expected = copy.deepcopy(old)
        expected['services']['api']['environment']['ACCOUNT_DASHBOARD_DIR'] = '/run/crypto-accounts'
        expected['services']['api']['environment']['AUTH_CORE_OWNER_IDS'] = viewers[0]
        command(new['services']['api'].get('command'))
        new_mounts = mounts(new['services']['api'])
        wanted = [(str(release) if target == '/code' else source, target, ro) for source,target,ro in old_mounts if target != '/run/crypto-accounts']
        wanted.append((str(PROJECTION), '/run/crypto-accounts', True))
        expected['services']['api']['volumes'] = new['services']['api']['volumes']
        if sorted(wanted) != sorted(new_mounts) or expected != new or override.read_bytes() != original:
            raise ValueError()
        unchanged_files(original, env_new)
        unchanged_trading()
        if identity(inspect(DB)) != db or identity(inspect(APP)) != identity(before):
            raise ValueError()
        with atomic_signals():
            staged.replace(override)
            applied = True
        unchanged_files(candidate, env_new)
        unchanged_runtime(new, identity(before))
        recreate()
        codes = readiness()
        after = inspect(APP)
        validate_runtime(after, new)
        if runtime_contract(after) != contract or after['Id'] == before['Id']:
            raise ValueError()
        unchanged_files(candidate, env_new)
        unchanged_runtime(new, identity(after))
        unchanged_trading()
    except BaseException:
        for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            signal.signal(sig, signal.SIG_IGN)
        result = {'configured': False, 'error': 'scoped-account-dashboard-rollout-failed',
            'backup': str(backup), 'rollback': 'not-required'}
        if env_applied or applied:
            try:
                unchanged_files(candidate if applied else original, env_new)
                # Other referenced env_files are outside these two byte guards.
                # Refuse to overwrite or recreate after effective-config or DB
                # drift, including a failure before override publication.
                rollback_expected = new if applied else copy.deepcopy(old)
                if not applied:
                    rollback_expected['services']['api']['environment']['AUTH_CORE_OWNER_IDS'] = viewers[0]
                unchanged_runtime(rollback_expected)
            except BaseException:
                result['rollback'] = 'blocked-config-drift'
                raise Failed(result)
            try:
                unchanged_previous_trading()
                with atomic_signals():
                    replace_private(env_path, env_original)
                    if applied:
                        replace_private(override, original)
                if applied:
                    recreate()
                    readiness()
                    restored = inspect(APP)
                    validate_runtime(restored, old)
                    if runtime_contract(restored) != contract:
                        raise ValueError()
                unchanged_files(original, env_original)
                unchanged_runtime(old)
                unchanged_previous_trading()
                result['rollback'] = 'restored-previous-api-ready' if applied else 'restored-env'
            except BaseException:
                result['rollback'] = 'restore-needs-review'
        raise Failed(result)
    print(json.dumps({'configured': True, 'revision': revision, 'backup': str(backup), 'ownerCount': 1,
        'preservedTradingConfiguration': True, 'databaseUnchanged': True,
        'runtimeContractPreserved': True, 'startupUsesExistingCompiledServer': True,
        'readiness': 'passed', 'health': codes[0], 'anonymousDocument': codes[1], 'anonymousApi': codes[2]}))


def main():
    os.umask(0o077)
    if len(sys.argv) != 2 or not re.fullmatch('[a-f0-9]{40}', sys.argv[1]) or os.getuid() != 1002:
        raise ValueError()
    # Share the lock with UI delivery because both update this same override.
    lock = ROOT / '.dashboard-ui-rollout.lock'
    descriptor = os.open(str(lock), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+b') as handle:
        private(lock)
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        rollout()


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
        print('{"configured":false,"error":"scoped-account-dashboard-rollout-failed"}')
        sys.exit(1)
