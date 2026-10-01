#!/usr/bin/python3 -I
"""One pinned single-venue order recovery using an isolated, temporary broker instance.
The main registry, broker service, vault values and exchange state are unchanged.
"""
import datetime
import fcntl
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import subprocess
import sys
sys.dont_write_bytecode = True
import time

PARTS = (
    ('mexc', 'secret://inbox/public-review-record-b11569db2351'),
    ('okx-keypair', 'secret://inbox/public-review-record-e8115fd14c14'),
    ('okx-passphrase', 'secret://inbox/public-review-record-1425c23b6554'),
)
DESTINATION = 'hyperion.crypto-order-recovery'
PROFILE = 'hyperion-crypto-order-recovery-once'
REQUEST_PIN = Path('/etc/crypto-order-recovery/request-pin.json')
ROOT = Path('/run/crypto-order-recovery-check')
SOCKET = Path('/run/agent-secrets-broker/crypto-order-recovery.sock')
UNIT = 'crypto-order-recovery-check.service'
BRIDGE = Path('/usr/local/libexec/crypto-order-recovery-bridge.py')
MEXC_FORMAT = Path('/usr/local/libexec/crypto-order-recovery-mexc-format.py')
MEXC_PROBE = Path('/usr/local/libexec/crypto-order-recovery-mexc-probe.py')
OKX_PROBE = Path('/usr/local/libexec/crypto-order-recovery-okx-probe.py')
PIN = Path('/usr/local/libexec/crypto-order-recovery-pin.json')
TEMPORARY_PATHS = (ROOT, SOCKET, BRIDGE, MEXC_FORMAT, MEXC_PROBE, OKX_PROBE, PIN)
FAILURE = {'schema': 1, 'error': 'recovery-failed'}


def selected_parts(venue):
    if venue == 'mexc': return PARTS[:1]
    if venue == 'okx': return PARTS[1:]
    raise ValueError()


def scoped_registry(records, venue):
    parts = selected_parts(venue)
    if set(records) != {ref for _, ref in parts}: raise ValueError()
    scoped = {'secrets': {}, 'profiles': {}}
    for part, ref in parts:
        destination, profile = DESTINATION + '-' + part, PROFILE + '-' + part
        scoped['secrets'][ref] = {key: records[ref][key] for key in ('backend', 'backend_id', 'status')}
        scoped['secrets'][ref]['destinations'] = [destination]
        scoped['profiles'][profile] = {
            'allowed_destinations': [destination], 'allowed_refs': [ref],
            'arguments': ['--consumer', '--part', part, '--destination', destination],
            'executable': str(BRIDGE), 'injection': 'stdin', 'timeout_seconds': 110}
    return scoped


def command(argv, timeout=15):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, timeout=timeout, check=False)


def interrupted(_signal, _frame):
    raise InterruptedError()


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        return 64
    source = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('recovery_source_bridge', str(source / 'recovery-bridge.py'))
    contract = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(contract)
    pin = contract.load_pin(REQUEST_PIN)
    release_pin = json.loads((source / 'release-pin.json').read_text(), object_pairs_hook=contract.unique_pairs, parse_constant=contract.reject_constant)
    if (type(release_pin) is not dict or set(release_pin) != {'schema', 'release', 'manifestSha256'}
            or type(release_pin['schema']) is not int or release_pin['schema'] != 1
            or release_pin['release'] != pin['release'] or release_pin['manifestSha256'] != pin['manifestSha256']):
        raise ValueError()
    parts = selected_parts(pin['venue'])
    # No broker/value lookup before the exact selected request passes isolated preflight.
    checked = command(['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/bin/ssh',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
        'hyperion-trading', contract.verification_command(pin, preflight=True)], timeout=90)
    preflight = contract.decode_report(checked.stdout, preflight=True, pin=pin)
    if checked.returncode != 0 or preflight.get('ready') is not True: raise ValueError()
    lock = open('/run/lock/crypto-order-recovery-once.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    for path in TEMPORARY_PATHS:
        if path.exists() or path.is_symlink():
            raise RuntimeError('occupied-path')
    if command(['/usr/bin/systemctl', 'show', '--property=LoadState', '--value', UNIT]).stdout.strip() != b'not-found':
        raise RuntimeError('occupied-unit')
    # Metadata-only reads inside the operator; no descriptions or backend identifiers are output.
    original_hashes = {path: hashlib.sha256(Path(path).read_bytes()).digest() for path in
        ['/etc/agent-secrets/athena-registry.json', '/etc/agent-secrets/athena-broker.json']}
    registry = json.loads(Path('/etc/agent-secrets/athena-registry.json').read_bytes())
    existing = json.loads(Path('/etc/agent-secrets/athena-broker.json').read_bytes())
    records = {ref: registry['secrets'][ref] for _, ref in parts}
    if any(record['status'] != 'active' or record['backend'] != 'sops-age' for record in records.values()) or existing['backend']['kind'] != 'sops-age':
        raise RuntimeError('unexpected-secret-backend')
    if existing.get('allowed_uid') != pwd.getpwnam('anton').pw_uid or existing.get('expected_cgroup_contains'):
        raise RuntimeError('unsupported-peer-policy')
    uid = pwd.getpwnam('agent-secrets').pw_uid
    gid = grp.getgrnam('agent-secrets-clients').gr_gid
    installed = []
    created = False
    service_attempted = False
    bridge = None
    result = dict(FAILURE)
    cleanup_ok = False
    audits = {}
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(150)
    try:
        sources = [(source / 'recovery-bridge.py', BRIDGE), (REQUEST_PIN, PIN)]
        if pin['venue'] == 'mexc':
            sources += [(source.parent / 'mexc/mexc-balance-bridge.py', MEXC_FORMAT),
                        (source.parent / 'mexc/mexc-balance-probe.py', MEXC_PROBE)]
        else:
            sources += [(source.parent / 'okx/okx-account-probe.py', OKX_PROBE)]
        for source_path, target in sources:
            raw = source_path.read_bytes()
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGALRM})
            try:
                with target.open('xb') as out:
                    installed.append((target, hashlib.sha256(raw).digest()))
                    out.write(raw)
                os.chown(target, 0, 0)
                target.chmod(0o600 if target == PIN else 0o755)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        spec = importlib.util.spec_from_file_location('pair_bridge', str(BRIDGE))
        report_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report_module)
        if report_module.load_pin() != pin: raise ValueError()  # Never permit pin drift after preflight.
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGALRM})
        try:
            ROOT.mkdir(mode=0o700)
            created = True
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        os.chown(ROOT, uid, gid)
        scoped = scoped_registry(records, pin['venue'])
        config = {'agent_id': 'crypto-order-recovery-check', 'registry_path': str(ROOT / 'registry.json'),
            'socket_path': str(ROOT / 'broker.sock'), 'socket_dir_mode': 0o750, 'socket_mode': 0o660,
            'audit_path': str(ROOT / 'audit.jsonl'), 'audit_hmac_file_env': 'AGENT_SECRETS_AUDIT_KEY_FILE',
            'allowed_uid': existing['allowed_uid'], 'backend': existing['backend']}
        for name, content in [('registry.json', scoped), ('broker.json', config)]:
            path = ROOT / name
            path.write_text(json.dumps(content))
            path.chmod(0o600)
            os.chown(path, uid, gid)
        properties = [
            'Type=exec', 'User=agent-secrets', 'Group=agent-secrets-clients', 'UMask=0077',
            'RuntimeMaxSec=180', 'TimeoutStopSec=5', 'KillMode=control-group',
            'NoNewPrivileges=true', 'PrivateDevices=true', 'PrivateTmp=true', 'ProtectHome=true',
            'ProtectSystem=strict', 'ProtectKernelTunables=true', 'ProtectKernelModules=true',
            'ProtectControlGroups=true', 'RestrictAddressFamilies=AF_UNIX', 'RestrictSUIDSGID=true',
            'ReadOnlyPaths=/var/lib/agent-secrets-vault', 'ReadWritePaths=' + str(ROOT),
            'StandardOutput=null', 'StandardError=null',
            'LoadCredentialEncrypted=sops-age-identity:/etc/agent-secrets/credentials/athena-age.cred',
            'LoadCredentialEncrypted=audit-hmac-key:/etc/agent-secrets/credentials/athena-audit.cred',
            'Environment=SOPS_AGE_KEY_FILE=/run/credentials/' + UNIT + '/sops-age-identity AGENT_SECRETS_AUDIT_KEY_FILE=/run/credentials/' + UNIT + '/audit-hmac-key',
        ]
        argv = ['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + UNIT]
        for prop in properties:
            argv.append('--property=' + prop)
        argv += ['/usr/local/bin/secretctl', 'serve', '--config', str(ROOT / 'broker.json')]
        service_attempted = True
        if command(argv).returncode != 0:
            raise RuntimeError('isolated-broker-start-failed')
        for _ in range(100):
            if (ROOT / 'broker.sock').is_socket():
                break
            time.sleep(.05)
        else:
            raise RuntimeError('isolated-broker-timeout')
        bridge = subprocess.Popen(['/usr/bin/python3', '-I', str(BRIDGE), '--server'],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            if bridge.poll() is not None:
                raise RuntimeError('bridge-start-failed')
            if SOCKET.is_socket():
                break
            time.sleep(.05)
        else:
            raise RuntimeError('bridge-timeout')
        import re
        for part, ref in parts:
            call = command(['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/local/bin/secretctl', 'use',
                '--socket', str(ROOT / 'broker.sock'), '--ref', ref,
                '--destination', DESTINATION + '-' + part, '--profile', PROFILE + '-' + part], timeout=115)
            audit = json.loads(call.stdout)
            audit_id = audit.get('audit_id')
            if not isinstance(audit_id, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', audit_id):
                raise RuntimeError('invalid-audit')
            audits[part] = {'id': audit_id, 'ok': audit.get('ok') is True}
            if part != parts[-1][0] and audit.get('ok') is not True:
                raise RuntimeError('record-delivery-failed')
        stdout, _ = bridge.communicate(timeout=10)
        result = report_module.decode_report(stdout, pin=pin)
        if result.get('reportWritten') is True and not all(audit['ok'] for audit in audits.values()):
            raise RuntimeError('audit-mismatch')
    except Exception:
        result = dict(FAILURE)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if bridge is not None:
            try:
                os.killpg(bridge.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                bridge.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(bridge.pid, signal.SIGKILL)
                bridge.wait()
        try:
            if service_attempted:
                if command(['/usr/bin/systemctl', 'stop', UNIT], timeout=15).returncode != 0:
                    state = command(['/usr/bin/systemctl', 'show', '--property=LoadState', '--value', UNIT]).stdout.strip()
                    if state != b'not-found':
                        raise RuntimeError('isolated-broker-stop-failed')
            if created:
                audit_path = ROOT / 'audit.jsonl'
                if audit_path.is_file() and not audit_path.is_symlink():
                    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
                    target = Path('/var/log/agent-secrets-broker') / ('crypto-order-recovery-' + stamp + '.jsonl')
                    with target.open('xb') as out:
                        out.write(audit_path.read_bytes())
                    target.chmod(0o600)
                shutil.rmtree(ROOT)
            for path, digest in installed:
                if path.is_symlink() or hashlib.sha256(path.read_bytes()).digest() != digest:
                    raise RuntimeError('helper-changed')
                path.unlink()
            if SOCKET.is_socket() and SOCKET.stat().st_uid == 0:
                SOCKET.unlink()
            if any(path.exists() or path.is_symlink() for path in TEMPORARY_PATHS):
                raise RuntimeError('temporary-path-remains')
            cleanup_ok = True
        except Exception:
            cleanup_ok = False
        result['brokerAuditIds'] = {part: audit['id'] for part, audit in audits.items()}
        result['temporaryBindingRemoved'] = cleanup_ok
        try:
            result['mainConfigUnchanged'] = all(hashlib.sha256(Path(path).read_bytes()).digest() == digest
                for path, digest in original_hashes.items())
        except Exception:
            result['mainConfigUnchanged'] = False
        print(json.dumps(result, separators=(',', ':')))
        lock.close()
    return 0 if result.get('reportWritten') is True and cleanup_ok and result.get('mainConfigUnchanged') is True else 1


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps(FAILURE, separators=(',', ':')))
        sys.exit(1)
