#!/usr/bin/env python3
"""Offline fixed-contract, protected-stdin, manifest and teardown regression tests."""
import ast
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import struct
import subprocess
import tempfile
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


bridge = load('pair_bridge_test', HERE / 'pair-observer-bridge.py')
runner = load('pair_runner_test', HERE / 'run-pair-observer-once.py')
MEXC = b'{"apiKey":"FAKE_MEXC_KEY","apiSecret":"FAKE_MEXC_SECRET"}'
OKX = b'{"apiKey":"FAKE_OKX_KEY","apiSecret":"FAKE_OKX_SECRET"}'
PASSPHRASE = b'FAKE_OKX_PASSPHRASE'
RECORDS = {'mexc': bytearray(MEXC), 'okx-keypair': bytearray(OKX), 'okx-passphrase': bytearray(PASSPHRASE)}
GOOD = {'schema': 1, 'mode': 'observation-only',
        'accounts': {'mexc': {'available': True, 'feeReadVerified': True}, 'okx': {'available': True, 'feeReadVerified': True}},
        'books': {'mexc': True, 'okx': True}, 'comparisonCount': 2,
        'checkedAt': '2026-09-25T12:34:56.123Z', 'reportWritten': True, 'executable': False}
PIN = {'schema': 1, 'release': 'a' * 64, 'manifestSha256': 'b' * 64}


class ContractTests(unittest.TestCase):
    def test_python36_syntax_for_helpers_and_remote_verifier(self):
        for name in ('pair-observer-bridge.py', 'run-pair-observer-once.py'):
            ast.parse((HERE / name).read_text(), feature_version=(3, 6))
        ast.parse(bridge.REMOTE_VERIFIER.replace('__PIN_VALUE__', repr(PIN)), feature_version=(3, 6))

    def test_report_exact_projection_and_failure(self):
        projected = bridge.decode_report(json.dumps(GOOD).encode())
        self.assertEqual(projected, GOOD)
        self.assertIsNot(projected['accounts'], GOOD['accounts'])
        self.assertEqual(bridge.decode_report(b'{"schema":1,"error":"observer-failed"}'), bridge.FAILURE)

    def test_report_rejects_private_fields_every_level(self):
        for path in [(), ('accounts',), ('accounts', 'mexc'), ('books',)]:
            value = copy.deepcopy(GOOD)
            target = value
            for key in path:
                target = target[key]
            target['apiSecret'] = 'FAKE_PRIVATE'
            with self.assertRaises(ValueError):
                bridge.decode_report(json.dumps(value).encode())

    def test_report_rejects_bad_types_counts_times_and_status(self):
        for key, bad in [('schema', True), ('mode', 'live'), ('comparisonCount', True),
                         ('comparisonCount', -1), ('comparisonCount', 3), ('reportWritten', False),
                         ('executable', True), ('checkedAt', '2026-02-31T00:00:00Z'),
                         ('checkedAt', 'FAKE_PRIVATE')]:
            with self.assertRaises(ValueError):
                bridge.decode_report(json.dumps(dict(GOOD, **{key: bad})).encode())
        for value in [b'{"schema":1,"schema":1,"error":"observer-failed"}', b'NaN', b'[]', b'x' * 4097]:
            with self.assertRaises(ValueError):
                bridge.decode_report(value)

    def test_output_redaction_in_allowlisted_timestamp(self):
        with self.assertRaises(ValueError):
            bridge.safe_output(json.dumps(GOOD).encode(), ('12:34:56',))
        self.assertEqual(bridge.safe_output(json.dumps(GOOD).encode(), ('FAKE_SECRET',))[0], GOOD)

    def test_real_parsers_create_canonical_bundles_without_changing_records(self):
        modules = {
            bridge.MEXC_FORMAT: load('pair_mexc_format_test', HERE.parent / 'mexc/mexc-balance-bridge.py'),
            bridge.MEXC_PROBE: load('pair_mexc_probe_test', HERE.parent / 'mexc/mexc-balance-probe.py'),
            bridge.OKX_PROBE: load('pair_okx_probe_test', HERE.parent / 'okx/okx-account-probe.py'),
        }
        with mock.patch.object(bridge, 'load_root_module', side_effect=lambda name, path: modules[path]):
            raw, credentials = bridge.prepare_payload(RECORDS)
            result = json.loads(raw)
            self.assertEqual(result['schema'], 1)
            self.assertEqual(set(result), {'schema', 'mexc', 'okx'})
            for venue in ('mexc', 'okx'):
                self.assertEqual({k: result[venue][k] for k in ('schema', 'venue', 'region', 'environment')},
                                 {'schema': 1, 'venue': venue, 'region': 'global', 'environment': 'mainnet'})
            self.assertEqual(result['okx']['passphrase'], PASSPHRASE.decode())
            self.assertEqual(len(credentials), 5)
            self.assertEqual(RECORDS['mexc'], MEXC)
            with self.assertRaises(Exception):
                bridge.prepare_payload(dict(RECORDS, **{'okx-keypair': bytearray(b'{"apiKey":"A","apiSecret":"B","passphrase":"C"}')}))

    def test_root_module_loader_rejects_symlink_foreign_and_writable(self):
        for uid, mode in [(0, stat.S_IFLNK | 0o777), (1000, stat.S_IFREG | 0o644), (0, stat.S_IFREG | 0o666)]:
            with mock.patch.object(bridge.os, 'stat', return_value=types.SimpleNamespace(st_uid=uid, st_mode=mode)):
                with self.assertRaises(ValueError):
                    bridge.load_root_module('never', '/not/read')

    def test_scope_has_three_disjoint_exact_bindings_and_no_description(self):
        records = {ref: {'backend': 'sops-age', 'backend_id': 'synthetic-id', 'status': 'active',
                          'destinations': ['webintake'], 'description': 'FAKE_PRIVATE'} for _, ref in runner.PARTS}
        original = copy.deepcopy(records)
        scope = runner.scoped_registry(records)
        self.assertEqual(records, original)
        self.assertNotIn('FAKE_PRIVATE', json.dumps(scope))
        self.assertEqual(len(scope['profiles']), 3)
        for part, ref in runner.PARTS:
            profile = scope['profiles'][runner.PROFILE + '-' + part]
            self.assertEqual(profile['allowed_refs'], [ref])
            self.assertEqual(profile['allowed_destinations'], [runner.DESTINATION + '-' + part])
            self.assertEqual(profile['arguments'], ['--consumer', '--part', part, '--destination', runner.DESTINATION + '-' + part])
            self.assertEqual(profile['injection'], 'stdin')
            self.assertEqual(profile['timeout_seconds'], 80)


class BridgeTests(unittest.TestCase):
    def test_consumer_root_peer_guard_and_three_markers(self):
        for part, marker in bridge.PARTS:
            for uid in (0, 1000):
                conn = mock.MagicMock()
                conn.__enter__.return_value = conn
                conn.getsockopt.return_value = struct.pack('3i', 1, uid, 2)
                conn.recv.return_value = b'1'
                with mock.patch.object(bridge.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(b'FAKE_SECRET'))), mock.patch.object(bridge.socket, 'socket', return_value=conn):
                    result = bridge.consumer(part)
                if uid:
                    self.assertEqual(result, 66)
                    conn.sendall.assert_not_called()
                else:
                    self.assertEqual(result, 0)
                    self.assertEqual(conn.sendall.call_args_list[0], mock.call(marker))
                    self.assertEqual(conn.sendall.call_args_list[1], mock.call(struct.pack('!I', 11)))
                    self.assertEqual(conn.sendall.call_args_list[2].args[0], bytearray(11))

    def setup_server(self, markers=(b'M', b'K', b'P'), uid=456, missing=None, output=None, returncode=0):
        listener = mock.MagicMock()
        listener.__enter__.return_value = listener
        connections = []
        for marker, raw in zip(markers, (MEXC, OKX, PASSPHRASE)):
            conn = mock.MagicMock()
            conn.__enter__.return_value = conn
            conn.getsockopt.return_value = struct.pack('3i', 1, uid, 2)
            conn.recv.side_effect = [marker, struct.pack('!I', len(raw)), raw]
            connections.append(conn)
        listener.accept.side_effect = [TimeoutError() if i == missing else (conn, None) for i, conn in enumerate(connections)]
        out = io.StringIO()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        for target, name, value in [(bridge.os, 'geteuid', 0), (bridge.pwd, 'getpwnam', types.SimpleNamespace(pw_uid=456)),
                                    (bridge.grp, 'getgrnam', types.SimpleNamespace(gr_gid=456))]:
            stack.enter_context(mock.patch.object(target, name, return_value=value))
        stack.enter_context(mock.patch.object(bridge.socket, 'socket', return_value=listener))
        for name in ('chown', 'chmod', 'unlink'):
            stack.enter_context(mock.patch.object(bridge.os, name))
        stack.enter_context(mock.patch.object(bridge, 'prepare_payload', return_value=(bytearray(b'FAKE_BUNDLE'), ('FAKE_SECRET',))))
        stack.enter_context(mock.patch.object(bridge, 'load_pin', return_value=PIN))
        process = stack.enter_context(mock.patch.object(bridge.subprocess, 'run', return_value=subprocess.CompletedProcess([], returncode, json.dumps(GOOD if output is None else output).encode())))
        stack.enter_context(contextlib.redirect_stdout(out))
        return connections, process, out

    def test_full_delivery_secrets_only_stdin_fixed_pinned_command(self):
        connections, process, out = self.setup_server()
        self.assertEqual(bridge.server(), 0)
        for conn in connections:
            conn.sendall.assert_called_once_with(b'1')
        argv = process.call_args.args[0]
        self.assertEqual(argv[-2], 'hyperion-trading')
        self.assertIn('/releases', argv[-1])
        self.assertNotIn('/current/', argv[-1])
        self.assertNotIn('FAKE_BUNDLE', str(argv))
        self.assertEqual(process.call_args.kwargs['input'], b'FAKE_BUNDLE')
        self.assertNotIn('env', process.call_args.kwargs)
        self.assertEqual(process.call_args.kwargs['timeout'], 65)
        self.assertEqual(json.loads(out.getvalue()), GOOD)

    def test_wrong_order_or_peer_blocks_remote_call(self):
        for markers, uid in [((b'K', b'M', b'P'), 456), ((b'M', b'P', b'K'), 456), ((b'M', b'K', b'K'), 456), ((b'M', b'K', b'P'), 1000)]:
            connections, process, out = self.setup_server(markers=markers, uid=uid)
            with self.assertRaises(ValueError):
                bridge.server()
            process.assert_not_called()
            self.assertEqual(out.getvalue(), '')

    def test_missing_second_or_third_wipes_delivered_records(self):
        for missing in (1, 2):
            connections, process, out = self.setup_server(missing=missing)
            with mock.patch.object(bridge, 'wipe', wraps=bridge.wipe) as wipe:
                with self.assertRaises(TimeoutError):
                    bridge.server()
                self.assertEqual(wipe.call_count, missing + 1)
                self.assertTrue(all(not any(call.args[0]) for call in wipe.call_args_list))
            process.assert_not_called()
            self.assertEqual(out.getvalue(), '')

    def test_remote_nonzero_does_not_return_success_metadata(self):
        connections, process, out = self.setup_server(returncode=1)
        self.assertEqual(bridge.server(), 1)
        connections[-1].sendall.assert_called_once_with(b'0')
        self.assertEqual(json.loads(out.getvalue()), bridge.FAILURE)

    def test_remote_unknown_fields_never_output(self):
        connections, process, out = self.setup_server(output=dict(GOOD, secret='FAKE_SECRET'))
        with self.assertRaises(ValueError):
            bridge.server()
        self.assertEqual(out.getvalue(), '')
        connections[-1].sendall.assert_not_called()

    def test_partial_receive_is_wiped_before_error(self):
        conn = mock.Mock()
        conn.recv.side_effect = [b'FAKE', b'']
        with mock.patch.object(bridge, 'wipe', wraps=bridge.wipe) as wipe:
            with self.assertRaises(ValueError):
                bridge.receive_exact(conn, 10)
        self.assertEqual(wipe.call_args.args[0], bytearray(4))


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.release = self.base / ('a' * 64)
        self.release.mkdir(mode=0o755)
        script = self.release / 'run-once'
        script.write_text('#!/usr/bin/python3\nprint("SYNTHETIC_EXECUTED")\n')
        script.chmod(0o755)
        dependency = self.release / 'dependency'
        dependency.mkdir(mode=0o755)
        (dependency / 'module.js').write_text('synthetic public dependency')
        (dependency / 'module.js').chmod(0o644)
        self.files = {str(p.relative_to(self.release)): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in self.release.rglob('*') if p.is_file()}
        self.pin = dict(PIN)
        self.write_manifest()

    def write_manifest(self):
        raw = json.dumps(self.files).encode()
        (self.release / 'manifest.json').write_bytes(raw)
        (self.release / 'manifest.json').chmod(0o644)
        self.pin['manifestSha256'] = hashlib.sha256(raw).hexdigest()

    def run_verifier(self):
        source = bridge.REMOTE_VERIFIER.replace('__PIN_VALUE__', repr(self.pin)).replace("BASE = '/home/mil/crypto-pair-observer/releases'", 'BASE = ' + repr(str(self.base)))
        return subprocess.run(['/usr/bin/python3', '-I', '-c', source], capture_output=True, timeout=5)

    def assert_blocked(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), bridge.FAILURE)
        self.assertEqual(result.stderr, b'')

    def test_pinned_regular_release_executes(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'SYNTHETIC_EXECUTED\n')

    def test_changed_manifest_blocks_before_exec(self):
        (self.release / 'manifest.json').write_text('{}')
        self.assert_blocked()

    def test_changed_dependency_blocks_before_exec(self):
        (self.release / 'dependency/module.js').write_text('changed')
        self.assert_blocked()

    def test_extra_file_blocks_before_exec(self):
        (self.release / 'extra').write_text('unexpected')
        self.assert_blocked()

    def test_missing_file_blocks_before_exec(self):
        (self.release / 'dependency/module.js').unlink()
        self.assert_blocked()

    def test_symlink_file_blocks_before_exec(self):
        target = self.release / 'dependency/module.js'
        target.unlink()
        target.symlink_to('/dev/null')
        self.assert_blocked()

    def test_symlink_directory_blocks_before_exec(self):
        target = self.release / 'dependency'
        shutil.rmtree(target)
        target.symlink_to(self.base)
        self.assert_blocked()

    def test_traversal_path_blocks_before_exec(self):
        self.files['../elsewhere'] = 'c' * 64
        self.write_manifest()
        self.assert_blocked()

    def test_group_writable_release_blocks_before_exec(self):
        (self.release / 'run-once').chmod(0o775)
        self.assert_blocked()


class RunnerCleanupTests(unittest.TestCase):
    def setup_runner(self, fail_part=None, fail_chown=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        source = base / 'ops/pair-observer'
        source.mkdir(parents=True)
        for relative in ['pair-observer/pair-observer-bridge.py', 'mexc/mexc-balance-bridge.py',
                         'mexc/mexc-balance-probe.py', 'okx/okx-account-probe.py']:
            target = base / 'ops' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((HERE.parent / relative).read_bytes())
        (source / 'release-pin.json').write_text(json.dumps(PIN))
        targets = {name: base / name.lower() for name in ('ROOT', 'SOCKET', 'BRIDGE', 'MEXC_FORMAT', 'MEXC_PROBE', 'OKX_PROBE', 'PIN')}
        records = {ref: {'backend': 'sops-age', 'backend_id': 'synthetic-id', 'status': 'active', 'destinations': ['webintake']} for _, ref in runner.PARTS}
        registry = json.dumps({'secrets': records}).encode()
        config = json.dumps({'backend': {'kind': 'sops-age'}, 'allowed_uid': 1000}).encode()
        real_read_bytes, real_stat = Path.read_bytes, Path.stat
        real_open = open
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        for name, target in targets.items():
            stack.enter_context(mock.patch.object(runner, name, target))
        stack.enter_context(mock.patch.object(runner, 'TEMPORARY_PATHS', tuple(targets.values())))
        stack.enter_context(mock.patch.object(runner, '__file__', str(source / 'run-pair-observer-once.py')))
        stack.enter_context(mock.patch.object(runner.sys, 'argv', ['run-pair-observer-once.py']))
        stack.enter_context(mock.patch.object(runner.os, 'geteuid', return_value=0))
        stack.enter_context(mock.patch.object(runner.pwd, 'getpwnam', side_effect=lambda name: types.SimpleNamespace(pw_uid=1000 if name == 'anton' else 456)))
        stack.enter_context(mock.patch.object(runner.grp, 'getgrnam', return_value=types.SimpleNamespace(gr_gid=456)))
        def chown(path, uid, gid):
            if fail_chown and path == targets['ROOT']:
                raise OSError('synthetic ownership failure')
        stack.enter_context(mock.patch.object(runner.os, 'chown', side_effect=chown))
        stack.enter_context(mock.patch.object(runner.os, 'killpg'))
        stack.enter_context(mock.patch.object(runner.signal, 'signal'))
        alarms = stack.enter_context(mock.patch.object(runner.signal, 'alarm'))
        stack.enter_context(mock.patch.object(runner.signal, 'pthread_sigmask', return_value=set()))
        def read_bytes(path):
            if str(path) == '/etc/agent-secrets/athena-registry.json': return registry
            if str(path) == '/etc/agent-secrets/athena-broker.json': return config
            return real_read_bytes(path)
        stack.enter_context(mock.patch.object(Path, 'read_bytes', read_bytes))
        def stat_path(path, *args, **kwargs):
            value = real_stat(path, *args, **kwargs)
            return types.SimpleNamespace(st_uid=0, st_mode=value.st_mode) if path == targets['SOCKET'] else value
        stack.enter_context(mock.patch.object(Path, 'stat', stat_path))
        stack.enter_context(mock.patch.object(Path, 'is_socket', lambda path: path.exists()))
        def opening(path, *args, **kwargs):
            return real_open(base / 'lock' if str(path) == '/run/lock/crypto-pair-observer-once.lock' else path, *args, **kwargs)
        stack.enter_context(mock.patch('builtins.open', opening))
        validator = types.SimpleNamespace(load_pin=lambda: PIN, decode_report=bridge.decode_report)
        spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda module: None))
        stack.enter_context(mock.patch.object(runner.importlib.util, 'spec_from_file_location', return_value=spec))
        stack.enter_context(mock.patch.object(runner.importlib.util, 'module_from_spec', return_value=validator))
        calls = []
        def command(argv, timeout=15):
            calls.append(argv)
            if argv[0] == '/usr/bin/systemctl':
                return subprocess.CompletedProcess(argv, 0, b'not-found\n')
            if argv[0] == '/usr/bin/systemd-run':
                (targets['ROOT'] / 'broker.sock').touch()
                return subprocess.CompletedProcess(argv, 0, b'')
            part = argv[-1].replace(runner.PROFILE + '-', '')
            index = [item[0] for item in runner.PARTS].index(part) + 1
            return subprocess.CompletedProcess(argv, 0, json.dumps({'audit_id': '00000000-0000-0000-0000-' + str(index).zfill(12), 'ok': part != fail_part}).encode())
        stack.enter_context(mock.patch.object(runner, 'command', side_effect=command))
        process = mock.Mock(pid=12345)
        process.poll.return_value = None
        process.communicate.return_value = (json.dumps(GOOD).encode(), None)
        process.wait.return_value = 0
        def popen(*args, **kwargs):
            targets['SOCKET'].touch()
            return process
        popen_mock = stack.enter_context(mock.patch.object(runner.subprocess, 'Popen', side_effect=popen))
        stdout = io.StringIO()
        stack.enter_context(contextlib.redirect_stdout(stdout))
        return targets, calls, alarms, popen_mock, stdout

    def test_success_removes_every_temporary_path_and_preserves_main_config(self):
        targets, calls, alarms, popen, output = self.setup_runner()
        self.assertEqual(runner.main(), 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result['temporaryBindingRemoved'])
        self.assertTrue(result['mainConfigUnchanged'])
        self.assertEqual(set(result['brokerAuditIds']), {part for part, _ in runner.PARTS})
        self.assertFalse(any(path.exists() for path in targets.values()))
        self.assertEqual(alarms.call_args_list, [mock.call(90), mock.call(0)])
        self.assertTrue(any(call[:2] == ['/usr/bin/systemctl', 'stop'] for call in calls))

    def test_second_delivery_failure_cleans_first_without_attempting_third(self):
        targets, calls, alarms, popen, output = self.setup_runner(fail_part='okx-keypair')
        self.assertEqual(runner.main(), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result['error'], 'observer-failed')
        self.assertEqual(set(result['brokerAuditIds']), {'mexc', 'okx-keypair'})
        self.assertTrue(result['temporaryBindingRemoved'])
        self.assertFalse(any(path.exists() for path in targets.values()))
        uses = [call for call in calls if call[0] == '/usr/bin/sudo']
        self.assertEqual(len(uses), 2)

    def test_mkdir_ownership_failure_still_removes_created_root_and_helpers(self):
        targets, calls, alarms, popen, output = self.setup_runner(fail_chown=True)
        self.assertEqual(runner.main(), 1)
        self.assertTrue(json.loads(output.getvalue())['temporaryBindingRemoved'])
        self.assertFalse(any(path.exists() for path in targets.values()))
        popen.assert_not_called()
        self.assertFalse(any(call[0] == '/usr/bin/systemd-run' for call in calls))


if __name__ == '__main__':
    unittest.main()
