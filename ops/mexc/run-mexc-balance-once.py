#!/usr/bin/python3 -I
"""One exact-ref balance check using an isolated, temporary broker instance.
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

REF = 'secret://inbox/public-review-record-b11569db2351'
DESTINATION = 'hyperion.crypto-mexc-balance'
PROFILE = 'hyperion-crypto-mexc-balance-once'
ROOT = Path('/run/crypto-mexc-balance-check')
SOCKET = Path('/run/agent-secrets-broker/crypto-mexc-balance.sock')
UNIT = 'crypto-mexc-balance-check.service'
BRIDGE = Path('/usr/local/libexec/crypto-mexc-balance-bridge.py')
PROBE = Path('/usr/local/libexec/crypto-mexc-balance-probe.py')
REPORT = Path('/usr/local/libexec/crypto-mexc-balance-report.py')


def command(argv, timeout=15):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, timeout=timeout, check=False)


def interrupted(_signal, _frame):
    raise InterruptedError()


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        return 64
    source = Path(__file__).resolve().parent
    for path in [ROOT, BRIDGE, PROBE, REPORT, SOCKET]:
        if path.exists() or path.is_symlink():
            raise RuntimeError('occupied-path')
    if command(['/usr/bin/systemctl', 'show', '--property=LoadState', '--value', UNIT]).stdout.strip() != b'not-found':
        raise RuntimeError('occupied-unit')
    lock = open('/run/lock/crypto-mexc-balance-once.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Metadata-only reads inside the operator; no descriptions or backend identifiers are output.
    registry = json.loads(Path('/etc/agent-secrets/athena-registry.json').read_bytes())
    existing = json.loads(Path('/etc/agent-secrets/athena-broker.json').read_bytes())
    record = registry['secrets'][REF]
    if record['status'] != 'active' or record['backend'] != 'sops-age' or existing['backend']['kind'] != 'sops-age':
        raise RuntimeError('unexpected-secret-backend')
    if existing.get('allowed_uid') != pwd.getpwnam('anton').pw_uid or existing.get('expected_cgroup_contains'):
        raise RuntimeError('unsupported-peer-policy')
    uid = pwd.getpwnam('agent-secrets').pw_uid
    gid = grp.getgrnam('agent-secrets-clients').gr_gid
    installed = []
    created = False
    service_attempted = False
    bridge = None
    result = {'schema': 1, 'venue': 'mexc', 'authenticatedRead': False, 'error': 'operation-failed'}
    cleanup_ok = False
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        for name, target in [('mexc-balance-bridge.py', BRIDGE), ('mexc-balance-probe.py', PROBE), ('mexc-balance-report.py', REPORT)]:
            raw = (source / name).read_bytes()
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
            try:
                with target.open('xb') as out:
                    installed.append((target, hashlib.sha256(raw).digest()))
                    out.write(raw)
                os.chown(target, 0, 0)
                target.chmod(0o755)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        spec = importlib.util.spec_from_file_location('mexc_report', str(REPORT))
        report_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report_module)
        ROOT.mkdir(mode=0o700)
        os.chown(ROOT, uid, gid)
        created = True
        scoped_registry = {'secrets': {REF: {key: record[key] for key in ['backend', 'backend_id', 'status']}},
            'profiles': {PROFILE: {'allowed_destinations': [DESTINATION], 'allowed_refs': [REF],
                'arguments': ['--consumer', '--destination', DESTINATION], 'executable': str(BRIDGE),
                'injection': 'stdin', 'timeout_seconds': 50}}}
        scoped_registry['secrets'][REF]['destinations'] = [DESTINATION]
        config = {'agent_id': 'crypto-mexc-balance-check', 'registry_path': str(ROOT / 'registry.json'),
            'socket_path': str(ROOT / 'broker.sock'), 'socket_dir_mode': 0o750, 'socket_mode': 0o660,
            'audit_path': str(ROOT / 'audit.jsonl'), 'audit_hmac_file_env': 'AGENT_SECRETS_AUDIT_KEY_FILE',
            'allowed_uid': existing['allowed_uid'], 'backend': existing['backend']}
        for name, content in [('registry.json', scoped_registry), ('broker.json', config)]:
            path = ROOT / name
            path.write_text(json.dumps(content))
            path.chmod(0o600)
            os.chown(path, uid, gid)
        properties = [
            'Type=exec', 'User=agent-secrets', 'Group=agent-secrets-clients', 'UMask=0077',
            'RuntimeMaxSec=90', 'TimeoutStopSec=5', 'KillMode=control-group',
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
        call = command(['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/local/bin/secretctl', 'use',
            '--socket', str(ROOT / 'broker.sock'), '--ref', REF, '--destination', DESTINATION, '--profile', PROFILE], timeout=60)
        audit = json.loads(call.stdout)
        stdout, _ = bridge.communicate(timeout=10)
        result = report_module.decode_report(stdout)
        if audit.get('ok') is not True and result.get('authenticatedRead') is True:
            raise RuntimeError('audit-mismatch')
        # Broker response has no child output; copy only its fixed metadata types.
        audit_id = audit.get('audit_id')
        import re
        if not isinstance(audit_id, str) or not re.fullmatch(r'[0-9a-f-]{36}', audit_id):
            raise RuntimeError('invalid-audit')
        result['brokerAuditId'] = audit_id
    except Exception:
        result = {'schema': 1, 'venue': 'mexc', 'authenticatedRead': False, 'error': 'operation-failed'}
    finally:
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
                    target = Path('/var/log/agent-secrets-broker') / ('mexc-balance-' + stamp + '.jsonl')
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
            cleanup_ok = True
        except Exception:
            cleanup_ok = False
        result['temporaryBindingRemoved'] = cleanup_ok
        print(json.dumps(result, separators=(',', ':')))
        lock.close()
    return 0 if result.get('authenticatedRead') is True and cleanup_ok else 1


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except Exception:
        print('{"schema":1,"venue":"mexc","authenticatedRead":false,"error":"setup-failed"}')
        sys.exit(1)
