#!/usr/bin/python3 -I
"""Key-free installed fee preflight against an existing binding. No credentials, GETs, enrollment or account writes."""
import hashlib
import types
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
BASE = Path('/home/mil/crypto-account-fees')
BINDING_BASE = Path('/home/mil/crypto-account-funds')
BINDING_SOURCE_HASH = 'da4ad8a2e69855c9a49e1556287e55b2a7703e6e3aa67efe115969fb8105d7c5'
BINDING_SOURCE = BINDING_BASE / 'releases' / BINDING_SOURCE_HASH
OBSERVER_STATE = Path('/home/mil/crypto-pair-observer/state')
UID = 1002
DOCKER = '/usr/bin/docker'
IMAGE = 'sha256:404c49b93e47f2eacecd16448ad73e021bf7f5edb621721f545667e8a58e9c08'
NAME = 'crypto-account-fees-readonly'
LABEL = 'crypto-account-fees.release'
INVOCATION_LABEL = 'crypto-account-fees.invocation'
ENTRYPOINT = 'dist/accounts/account-fees-main.js'
MAX_OUTPUT = 1024
RUN_SECONDS = 10
CLEANUP_SECONDS = 10
FAILURE = {'schema': 1, 'error': 'fees-preflight-check-failed'}
NODE_PREFLIGHT = r"""
try {
  const {preflightAccountFees} = await import('/code/dist/accounts/account-fees-runtime.js');
  await preflightAccountFees();
  process.stdout.write(JSON.stringify({schema:1,preflightPassed:true})+'\n');
} catch (error) {
  const reason = ['ENOENT','EACCES','EROFS'].includes(error?.code) ? error.code : 'other';
  process.stdout.write(JSON.stringify({schema:1,preflightPassed:false,reason})+'\n');
}
"""


def is_hash(value):
    return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None


def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def reject_constant(_value):
    raise ValueError()


def decode(raw):
    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique_pairs, parse_constant=reject_constant)


def private_directory(path):
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != UID or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError()


def read_private(path, maximum, executable=False):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != UID or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != (0o700 if executable else 0o600) or info.st_size > maximum):
            raise ValueError()
        value = source.read(maximum + 1)
        if len(value) > maximum:
            raise ValueError()
        return value


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def load_verified_runner(release):
    # Authenticate the module's pinned bytes before its Python top level executes.
    # The release is supplied by the caller's reviewed installation pin, not discovery.
    for path in (BASE, BASE / 'releases', release):
        private_directory(path)
    manifest_raw = read_private(release / 'manifest.json', 512 * 1024)
    if hashlib.sha256(manifest_raw).hexdigest() != release.name:
        raise ValueError()
    manifest = decode(manifest_raw)
    if type(manifest) is not dict or not is_hash(manifest.get('run-once')):
        raise ValueError()
    source = read_private(release / 'run-once', 8 * 1024 * 1024, executable=True)
    if hashlib.sha256(source).hexdigest() != manifest['run-once']:
        raise ValueError()
    module = types.ModuleType('verified_installed_account_fees_runner')
    module.__file__ = str(release / 'run-once')
    # Execute the already-hashed bytes, not a second path read or cached bytecode.
    exec(compile(source, module.__file__, 'exec'), module.__dict__)
    expected = {'BASE': BASE, 'UID': UID, 'DOCKER': DOCKER, 'IMAGE': IMAGE, 'NAME': NAME,
                'LABEL': LABEL, 'INVOCATION_LABEL': INVOCATION_LABEL, 'ENTRYPOINT': ENTRYPOINT,
                'BINDING_BASE': BINDING_BASE, 'BINDING_SOURCE': BINDING_SOURCE, 'BINDING_SOURCE_HASH': BINDING_SOURCE_HASH}
    if any(getattr(module, key, None) != value for key, value in expected.items()):
        raise ValueError()
    module.verify_release(release)
    return module


def docker_arguments(release, cidfile, invocation):
    return [DOCKER, 'run', '--rm', '-i', '--pull=never', '--name', NAME,
            '--cidfile', str(cidfile), '--label', LABEL + '=' + release.name,
            '--label', INVOCATION_LABEL + '=' + invocation, '--log-driver=none', '--read-only',
            '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1002:27',
            '--pids-limit=64', '--memory=256m', '--cpus=0.5', '--ulimit=core=0',
            '--network=none', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
            '--mount', 'type=bind,src=' + str(release) + ',dst=/code,readonly',
            '--mount', 'type=bind,src=' + str(BASE / 'state') + ',dst=/state,readonly',
            '--mount', 'type=bind,src=' + str(BINDING_BASE / 'binding') + ',dst=/binding,readonly',
            '--mount', 'type=bind,src=' + str(BINDING_SOURCE) + ',dst=/binding-source,readonly',
            '--mount', 'type=bind,src=' + str(OBSERVER_STATE) + ',dst=/observer-state,readonly',
            '--workdir=/code', IMAGE, 'node', '--disable-proto=throw', '--input-type=module', '-e', NODE_PREFLIGHT]


def decode_result(raw):
    if not 0 < len(raw) <= MAX_OUTPUT:
        raise ValueError()
    value = decode(raw)
    if (type(value) is not dict or type(value.get('schema')) is not int or value['schema'] != 1
            or type(value.get('preflightPassed')) is not bool):
        raise ValueError()
    expected = {'schema', 'preflightPassed'} if value['preflightPassed'] else {'schema', 'preflightPassed', 'reason'}
    if set(value) != expected or (not value['preflightPassed'] and value['reason'] not in ('ENOENT', 'EACCES', 'EROFS', 'other')):
        raise ValueError()
    return value


def run_preflight(helper, release):
    invocation = str(uuid.uuid4())
    cidfile = BASE / 'state' / ('.preflight-container-' + invocation)
    if cidfile.exists() or cidfile.is_symlink():
        raise ValueError()
    process = None
    try:
        process = subprocess.Popen(docker_arguments(release, cidfile, invocation),
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        value = decode_result(helper.bounded_output(process, RUN_SECONDS))
        identity = helper.read_private(cidfile, 65).decode('ascii').strip()
        if not helper.is_hash(identity):
            raise ValueError()
    finally:
        previous = []
        for chosen in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous.append((chosen, signal.signal(chosen, signal.SIG_IGN)))
        try:
            deadline = time.monotonic() + CLEANUP_SECONDS
            try:
                if process is not None and process.poll() is None:
                    process.kill()
                    process.wait(timeout=min(1, max(.001, deadline - time.monotonic())))
            finally:
                helper.cleanup_container(cidfile, release.name, invocation, deadline)
        finally:
            if process is not None and process.stdout is not None:
                process.stdout.close()
            for chosen, handler in previous:
                signal.signal(chosen, handler)
    return value


def check_installed(release_digest):
    if os.getuid() != UID or not is_hash(release_digest):
        raise ValueError()
    release = BASE / 'releases' / release_digest
    helper = load_verified_runner(release)
    if helper.OBSERVER_STATE != OBSERVER_STATE:
        raise ValueError()
    private_directory(BASE / 'state')
    helper.verify_binding_files()
    private_directory(OBSERVER_STATE)
    with helper.locked_file(OBSERVER_STATE / '.observer.lock'), helper.locked_file(BASE / 'state' / '.fees.lock', create=True):
        if not helper.absent_container(time.monotonic() + 3):
            raise ValueError()
        result = run_preflight(helper, release)
        result.update({'release': release_digest, 'manifestVerified': True, 'networkDisabled': True,
                       'emptyStdin': True, 'readOnlyMounts': True, 'cleanupVerified': True,
                       'keysDelivered': False, 'requestCount': 0, 'identityEnrolled': False})
        return result


def interrupted(_signal, _frame):
    raise InterruptedError()


def main():
    if len(sys.argv) != 2:
        raise ValueError()
    value = check_installed(sys.argv[1])
    print(json.dumps(value, separators=(',', ':')))
    return 0 if value['preflightPassed'] else 1


if __name__ == '__main__':
    os.umask(0o077)
    for selected in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(selected, interrupted)
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps(FAILURE, separators=(',', ':')))
        sys.exit(1)
