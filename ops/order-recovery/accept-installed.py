#!/usr/bin/python3 -I
"""Negative-only installed acceptance. No request provisioning, keys, account reads or application mounts."""
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

sys.dont_write_bytecode = True
BASE = Path('/home/mil/crypto-order-recovery')
UID = 1002
PYTHON = '/usr/bin/python3'
DOCKER = '/usr/bin/docker'
IMAGE = 'sha256:404c49b93e47f2eacecd16448ad73e021bf7f5edb621721f545667e8a58e9c08'
NAME = 'crypto-order-recovery-readonly'
LABEL = 'crypto-order-recovery.release'
REQUEST_LABEL = 'crypto-order-recovery.request'
ENTRYPOINT = 'dist/scripts/protected-order-recovery.js'
ZERO_REQUEST = '0' * 64
MAX_OUTPUT = 4096
RUN_SECONDS = 10
CLEANUP_SECONDS = 10
FAILURE = {'schema': 1, 'error': 'recovery-acceptance-failed'}
EXPECTED_FAILURE = {'schema': 1, 'error': 'recovery-failed'}


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
    module = types.ModuleType('verified_installed_order_recovery_runner')
    module.__file__ = str(release / 'run-once')
    # Execute the already-hashed bytes, not a second path read or cached bytecode.
    exec(compile(source, module.__file__, 'exec'), module.__dict__)
    expected = {'BASE': BASE, 'UID': UID, 'DOCKER': DOCKER, 'IMAGE': IMAGE, 'NAME': NAME,
                'LABEL': LABEL, 'REQUEST_LABEL': REQUEST_LABEL, 'ENTRYPOINT': ENTRYPOINT}
    if any(getattr(module, key, None) != value for key, value in expected.items()):
        raise ValueError()
    module.verify_release(release)
    return module


def request_must_be_absent():
    requests = BASE / 'requests'
    if requests.exists() or requests.is_symlink():
        private_directory(requests)
    target = requests / ZERO_REQUEST
    try:
        target.lstat()
    except FileNotFoundError:
        return
    raise ValueError()


def docker_arguments(release, cidfile):
    # Exactly one bind mount: packaged code only. No journal, request, account,
    # observer state, application data, Docker socket or host network is exposed.
    return [DOCKER, 'run', '--rm', '-i', '--pull=never', '--name', NAME,
            '--cidfile', str(cidfile), '--label', LABEL + '=' + release.name,
            '--label', REQUEST_LABEL + '=' + ZERO_REQUEST, '--log-driver=none', '--read-only',
            '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1002:27',
            '--pids-limit=64', '--memory=256m', '--cpus=0.5', '--ulimit=core=0',
            '--network=none', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
            '--mount', 'type=bind,src=' + str(release) + ',dst=/code,readonly',
            '--workdir=/code', IMAGE, 'node', '--disable-proto=throw', ENTRYPOINT,
            '--request-digest', ZERO_REQUEST, '--preflight']


def assert_fixed_failure(raw, returncode):
    if returncode != 1 or not 0 < len(raw) <= MAX_OUTPUT:
        raise ValueError()
    value = decode(raw)
    if value != EXPECTED_FAILURE or type(value.get('schema')) is not int:
        raise ValueError()


def run_negative(args):
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        deadline = time.monotonic() + RUN_SECONDS
        output = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            ready, _, _ = select.select([process.stdout], [], [], remaining)
            if not ready:
                raise TimeoutError()
            chunk = os.read(process.stdout.fileno(), min(4096, MAX_OUTPUT - len(output) + 1))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > MAX_OUTPUT:
                raise ValueError()
        process.wait(timeout=max(.001, deadline - time.monotonic()))
        assert_fixed_failure(bytes(output), process.returncode)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=1)
        process.stdout.close()


def isolated_entrypoint(helper, release):
    directory = BASE / 'state' / ('.acceptance-' + str(os.getpid()))
    # Exclusive directory creation prevents reusing another process's CID marker.
    directory.mkdir(mode=0o700)
    sync_directory(directory.parent)
    cidfile = directory / 'container.cid'
    cleaned = False
    try:
        run_negative(docker_arguments(release, cidfile))
        identity = helper.read_private(cidfile, 65).decode('ascii').strip()
        if not helper.is_hash(identity):
            raise ValueError()
    finally:
        previous = []
        for selected in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous.append((selected, signal.signal(selected, signal.SIG_IGN)))
        try:
            # Existing reviewed helper removes only the exact CID after both
            # labels match. A mismatch retains the marker and container.
            cleanup_deadline = time.monotonic() + CLEANUP_SECONDS
            helper.cleanup_container(cidfile, release.name, ZERO_REQUEST, cleanup_deadline)
            if not helper.absent_container(cleanup_deadline):
                raise RuntimeError()
            cleaned = True
        finally:
            for selected, handler in previous:
                signal.signal(selected, handler)
            if cleaned:
                # Never recursively remove state or a directory containing leftovers.
                directory.rmdir()
                sync_directory(directory.parent)


def accept_installed(release_digest):
    if os.getuid() != UID or not is_hash(release_digest):
        raise ValueError()
    release = BASE / 'releases' / release_digest
    helper = load_verified_runner(release)
    private_directory(BASE / 'state')
    with helper.locked_file(BASE / 'state' / '.recovery.lock', create=True):
        request_must_be_absent()
        if not helper.absent_container(time.monotonic() + 3):
            raise ValueError()
        # Absent request is rejected before the installed runner enters either
        # observer locking or Docker. No credential broker is called.
        run_negative([PYTHON, '-I', str(release / 'run-once'), '--preflight', ZERO_REQUEST])
        if not helper.absent_container(time.monotonic() + 3):
            raise ValueError()
        helper.verify_release(release)
        request_must_be_absent()
        isolated_entrypoint(helper, release)
        return {'schema': 1, 'release': release_digest, 'manifestVerified': True,
                'missingRequestRefused': True, 'isolatedEntrypointRefused': True,
                'networkDisabled': True, 'emptyStdin': True, 'cleanupVerified': True,
                'keysDelivered': False, 'liveCaptureStarted': False}


def interrupted(_signal, _frame):
    raise InterruptedError()


def main():
    if len(sys.argv) != 2:
        raise ValueError()
    print(json.dumps(accept_installed(sys.argv[1]), separators=(',', ':')))


if __name__ == '__main__':
    os.umask(0o077)
    for chosen in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(chosen, interrupted)
    try:
        main()
    except Exception:
        print(json.dumps(FAILURE, separators=(',', ':')))
        sys.exit(1)
