#!/usr/bin/env python3
"""Offline fixed-contract, protected-stdin, manifest and teardown regression tests."""
import ast
import contextlib
import copy
import hashlib
import importlib.util
import importlib.machinery
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import struct
import subprocess
import sys
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


bridge = load('pair_bridge_test', HERE / 'history-bridge.py')
runner = load('pair_runner_test', HERE / 'run-history-once.py')
MEXC = b'{"apiKey":"FAKE_MEXC_KEY","apiSecret":"FAKE_MEXC_SECRET"}'
OKX = b'{"apiKey":"FAKE_OKX_KEY","apiSecret":"FAKE_OKX_SECRET"}'
PASSPHRASE = b'FAKE_OKX_PASSPHRASE'
RECORDS = {'mexc': bytearray(MEXC), 'okx-keypair': bytearray(OKX), 'okx-passphrase': bytearray(PASSPHRASE)}
VENUE = {'requests': 3, 'successfulRequests': 3, 'discoveredOrders': 2,
         'capturedOrders': 2, 'fillRows': 4, 'billRows': 3, 'errors': 0, 'truncated': False}
GOOD = {'schema': 1, 'mode': 'execution-history-readonly',
        'captureId': '00000000-0000-0000-0000-000000000001',
        'venues': {'mexc': dict(VENUE), 'okx': dict(VENUE)},
        'checkedAt': '2026-09-25T12:34:56.123Z', 'reportWritten': True, 'executable': False}
PIN = {'schema': 1, 'release': 'a' * 64, 'manifestSha256': 'b' * 64}


class ContractTests(unittest.TestCase):
    def test_python36_syntax_for_helpers_and_remote_verifier(self):
        for name in ('history-bridge.py', 'run-history-once.py'):
            ast.parse((HERE / name).read_text(), feature_version=(3, 6))
        ast.parse(bridge.REMOTE_VERIFIER.replace('__PIN_VALUE__', repr(PIN)), feature_version=(3, 6))

    def test_report_exact_projection_and_failure(self):
        projected = bridge.decode_report(json.dumps(GOOD).encode())
        self.assertEqual(projected, GOOD)
        self.assertIsNot(projected['venues'], GOOD['venues'])
        self.assertEqual(bridge.decode_report(b'{"schema":1,"error":"history-failed"}'), bridge.FAILURE)

    def test_report_rejects_private_fields_every_level(self):
        for path in [(), ('venues',), ('venues', 'mexc'), ('venues', 'okx')]:
            value = copy.deepcopy(GOOD)
            target = value
            for key in path:
                target = target[key]
            target['apiSecret'] = 'FAKE_PRIVATE'
            with self.assertRaises(ValueError):
                bridge.decode_report(json.dumps(value).encode())

    def test_report_rejects_bad_types_counts_times_and_status(self):
        for key, bad in [('schema', True), ('mode', 'live'), ('captureId', 'secret-value'),
                         ('reportWritten', False), ('executable', True),
                         ('checkedAt', '2026-02-31T00:00:00.000Z'),
                         ('checkedAt', '2026-01-01T00:00:00Z'), ('checkedAt', 'FAKE_PRIVATE')]:
            with self.assertRaises(ValueError):
                bridge.decode_report(json.dumps(dict(GOOD, **{key: bad})).encode())
        for value in [b'{"schema":1,"schema":1,"error":"history-failed"}', b'NaN', b'[]', b'x' * 4097]:
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
        source = bridge.REMOTE_VERIFIER.replace('__PIN_VALUE__', repr(self.pin)).replace("BASE = '/home/mil/crypto-execution-history/releases'", 'BASE = ' + repr(str(self.base)))
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
        source = base / 'ops/execution-history'
        source.mkdir(parents=True)
        for relative in ['execution-history/history-bridge.py', 'mexc/mexc-balance-bridge.py',
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
        stack.enter_context(mock.patch.object(runner, '__file__', str(source / 'run-history-once.py')))
        stack.enter_context(mock.patch.object(runner.sys, 'argv', ['run-history-once.py']))
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
            return real_open(base / 'lock' if str(path) == '/run/lock/crypto-execution-history-once.lock' else path, *args, **kwargs)
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
        self.assertEqual(result['error'], 'history-failed')
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


class HistoryProjectionTests(unittest.TestCase):
    def test_all_numeric_bounds_and_bool_rejection(self):
        bounds = {'requests': 12, 'successfulRequests': 12, 'discoveredOrders': 3000,
                  'capturedOrders': 2, 'fillRows': 5000, 'billRows': 300, 'errors': 30}
        for venue in ('mexc', 'okx'):
            for key, maximum in bounds.items():
                for bad in (-1, maximum + 1, True, '0', 0.5):
                    value = copy.deepcopy(GOOD)
                    value['venues'][venue][key] = bad
                    with self.assertRaises(ValueError, msg=key):
                        bridge.decode_report(json.dumps(value).encode())
            for bad in (0, 'false', None):
                value = copy.deepcopy(GOOD)
                value['venues'][venue]['truncated'] = bad
                with self.assertRaises(ValueError):
                    bridge.decode_report(json.dumps(value).encode())

    def test_summary_cross_counts_and_exact_venue_set(self):
        for key, bad in [('requests', 1), ('discoveredOrders', 1)]:
            value = copy.deepcopy(GOOD)
            value['venues']['okx'][key] = bad
            with self.assertRaises(ValueError):
                bridge.decode_report(json.dumps(value).encode())
        value = copy.deepcopy(GOOD)
        value['venues']['other'] = dict(VENUE)
        with self.assertRaises(ValueError):
            bridge.decode_report(json.dumps(value).encode())

    def test_isolated_namespace_and_unchanged_ref_contract(self):
        self.assertEqual(runner.DESTINATION, 'hyperion.crypto-execution-history')
        self.assertEqual(runner.PROFILE, 'hyperion-crypto-execution-history-once')
        for path in runner.TEMPORARY_PATHS:
            self.assertIn('crypto-execution-history', str(path))
            self.assertNotIn('crypto-pair-observer', str(path))
        original = load('original_observer_metadata', HERE.parent / 'pair-observer/run-pair-observer-once.py')
        self.assertEqual(runner.PARTS, original.PARTS)
        self.assertNotEqual(runner.PIN, original.PIN)
        self.assertNotEqual(runner.SOCKET, original.SOCKET)
        self.assertNotEqual(runner.UNIT, original.UNIT)


remote_loader = importlib.machinery.SourceFileLoader('history_remote_test', str(HERE / 'run-once'))
remote_spec = importlib.util.spec_from_loader(remote_loader.name, remote_loader)
remote = importlib.util.module_from_spec(remote_spec)
remote_loader.exec_module(remote)


class RemoteCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cidfile = Path(self.temporary.name) / 'cid'
        self.identity, self.release = 'c' * 64, 'a' * 64
        self.cidfile.write_text(self.identity)
        self.cidfile.chmod(0o600)

    def result(self, code=0, output=b''):
        return subprocess.CompletedProcess([], code, output)

    def test_cleanup_removes_only_verified_cid_then_proves_absence(self):
        responses = [self.result(output=(self.identity + ' ' + self.release).encode()), self.result(), self.result()]
        with mock.patch.object(remote, 'command', side_effect=responses) as command:
            remote.cleanup_container(self.cidfile, self.release, float('inf'))
        self.assertEqual(command.call_args_list[1].args[0], ['/usr/bin/docker', 'rm', '-f', self.identity])
        self.assertEqual(command.call_args_list[2].args[0][-1], 'name=^/' + remote.NAME + '$')
        self.assertFalse(self.cidfile.exists())

    def test_foreign_release_label_is_preserved_and_not_deleted(self):
        with mock.patch.object(remote, 'command', return_value=self.result(output=(self.identity + ' ' + 'b' * 64).encode())) as command:
            with self.assertRaises(ValueError):
                remote.cleanup_container(self.cidfile, self.release, float('inf'))
        self.assertEqual(command.call_count, 1)
        self.assertTrue(self.cidfile.exists())

    def test_auto_removed_container_requires_successful_daemon_query(self):
        with mock.patch.object(remote, 'command', side_effect=[self.result(1), self.result()]) as command:
            remote.cleanup_container(self.cidfile, self.release, float('inf'))
        self.assertFalse(self.cidfile.exists())
        self.assertFalse(any(call.args[0][1] == 'rm' for call in command.call_args_list))

    def test_daemon_error_does_not_claim_cleanup(self):
        with mock.patch.object(remote, 'command', side_effect=[self.result(1), self.result(1)]):
            with self.assertRaises(RuntimeError):
                remote.cleanup_container(self.cidfile, self.release, float('inf'))
        self.assertTrue(self.cidfile.exists())

    def test_missing_cid_never_authorizes_name_based_delete(self):
        self.cidfile.unlink()
        with mock.patch.object(remote, 'command', return_value=self.result(output=self.identity.encode())) as command:
            with self.assertRaises(RuntimeError):
                remote.cleanup_container(self.cidfile, self.release, float('inf'))
        self.assertEqual(command.call_count, 1)
        self.assertEqual(command.call_args.args[0][1], 'ps')

    def test_symlink_cid_never_followed_or_deleted(self):
        target = self.cidfile.with_name('other')
        self.cidfile.rename(target)
        self.cidfile.symlink_to(target)
        with mock.patch.object(remote, 'command') as command:
            with self.assertRaises(ValueError):
                remote.cleanup_container(self.cidfile, self.release, float('inf'))
        command.assert_not_called()
        self.assertTrue(self.cidfile.is_symlink())
        self.assertTrue(target.exists())

    def test_expired_cleanup_budget_starts_no_command(self):
        with mock.patch.object(remote.subprocess, 'run') as run:
            with self.assertRaises(TimeoutError):
                remote.command(['/usr/bin/docker', 'ps'], 0)
        run.assert_not_called()

    def test_nonblocking_observer_lock_does_not_steal_lock(self):
        lock = self.cidfile.with_name('observer.lock')
        lock.touch(mode=0o600)
        with remote.locked_file(lock):
            with self.assertRaises(BlockingIOError):
                remote.locked_file(lock)
        with remote.locked_file(lock):
            pass

    def test_no_main_runtime_mount_or_published_port(self):
        arguments = remote.docker_arguments(Path('/code-release') / self.release, self.cidfile)
        mounts = [arguments[index + 1] for index, item in enumerate(arguments) if item == '--mount']
        self.assertEqual(len(mounts), 3)
        self.assertTrue(any('dst=/code,readonly' in mount for mount in mounts))
        self.assertTrue(any('dst=/observer-state' in mount for mount in mounts))
        self.assertFalse(any('.env' in mount or 'docker.sock' in mount or 'robot.crypto.jsnode' in mount for mount in mounts))
        for required in ['--log-driver=none', '--read-only', '--cap-drop=ALL', '--user=1002:27']:
            self.assertIn(required, arguments)
        self.assertNotIn('--publish', arguments)
        self.assertEqual(arguments[-1], 'dist/scripts/execution-history.js')
        original = (HERE.parent / 'pair-observer/run-once').read_text()
        self.assertIn('IMAGE = ' + repr(remote.IMAGE), original)
        self.assertEqual(remote.RUN_SECONDS, 45)
        self.assertEqual(remote.CLEANUP_SECONDS, 10)

    def test_all_helpers_have_python36_syntax(self):
        for name in ['run-once', 'history-bridge.py', 'run-history-once.py', 'install-remote.py', 'prepare-release.py']:
            ast.parse((HERE / name).read_text(), feature_version=(3, 6))

    def test_process_wait_failure_still_attempts_container_cleanup(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired('synthetic', 1)
        base = Path(self.temporary.name)
        release = base / 'releases' / self.release
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(remote, 'BASE', base))
            stack.enter_context(mock.patch.object(remote, '__file__', str(release / 'run-once')))
            stack.enter_context(mock.patch.object(remote.os, 'getuid', return_value=1002))
            stack.enter_context(mock.patch.object(remote.sys, 'argv', ['run-once']))
            stack.enter_context(mock.patch.object(remote.sys, 'stdin', types.SimpleNamespace(isatty=lambda: False, buffer=io.BytesIO())))
            stack.enter_context(mock.patch.object(remote, 'private_directory'))
            stack.enter_context(mock.patch.object(remote, 'locked_file', side_effect=lambda *args, **kwargs: contextlib.nullcontext()))
            stack.enter_context(mock.patch.object(remote, 'no_container', return_value=True))
            stack.enter_context(mock.patch.object(remote.subprocess, 'Popen', return_value=process))
            stack.enter_context(mock.patch.object(remote, 'bounded_output', side_effect=TimeoutError()))
            stack.enter_context(mock.patch.object(remote.signal, 'signal'))
            cleanup = stack.enter_context(mock.patch.object(remote, 'cleanup_container'))
            with self.assertRaises(subprocess.TimeoutExpired):
                remote.main()
            cleanup.assert_called_once()
        process.kill.assert_called_once()

    def test_bounded_output_does_not_buffer_oversized_child(self):
        process = subprocess.Popen([sys.executable, '-c', 'print("x" * 5000)'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            with self.assertRaises(ValueError):
                remote.bounded_output(process, 2)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=2)
            process.stdout.close()

class PackagingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / 'repo'
        self.builder = load('history_prepare_test', HERE / 'prepare-release.py')
        for directory in ['dist/accounts', 'dist/lab', 'dist/paper-pair', 'dist/paper-v2', 'node_modules/zod']:
            root = self.repo / directory
            root.mkdir(parents=True)
            (root / 'module.js').write_text('/* synthetic */')
        (self.repo / 'dist/scripts').mkdir()
        (self.repo / 'dist/scripts/execution-history.js').write_text('/* synthetic history */')
        directory = self.repo / 'ops/execution-history'
        directory.mkdir(parents=True)
        (directory / 'run-once').write_text('#!/usr/bin/python3\n')
        observer = self.repo / 'ops/pair-observer'
        observer.mkdir()
        self.original_pin = observer / 'release-pin.json'
        self.original_pin.write_text('preserved-observer-pin')
        self.output = self.base / 'artifact.tar.gz'
        self.builder.REPO = self.repo
        self.builder.OUT = self.output

    def test_builder_pins_only_history_and_binds_all_archive_files(self):
        import tarfile
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.builder.main()
        metadata = json.loads(output.getvalue())
        self.assertEqual(self.original_pin.read_text(), 'preserved-observer-pin')
        pin = json.loads((self.repo / 'ops/execution-history/release-pin.json').read_text())
        with tarfile.open(self.output) as tar:
            manifest_bytes = tar.extractfile('manifest.json').read()
            manifest = json.loads(manifest_bytes)
            self.assertEqual(hashlib.sha256(manifest_bytes).hexdigest(), pin['release'])
            self.assertEqual(pin['release'], metadata['release'])
            self.assertEqual(set(tar.getnames()), set(manifest) | {'manifest.json'})
            for name, digest in manifest.items():
                self.assertEqual(hashlib.sha256(tar.extractfile(name).read()).hexdigest(), digest)
            self.assertEqual(tar.getmember('run-once').mode, 0o755)

    def test_builder_refuses_existing_artifact_and_preserves_contents(self):
        self.output.write_bytes(b'previous-artifact')
        with self.assertRaises(FileExistsError):
            self.builder.main()
        self.assertEqual(self.output.read_bytes(), b'previous-artifact')
        self.assertFalse((self.repo / 'ops/execution-history/release-pin.json').exists())

    def test_missing_dependency_directory_does_not_create_partial_release(self):
        shutil.rmtree(self.repo / 'dist/accounts')
        with self.assertRaises(ValueError):
            self.builder.main()
        self.assertFalse(self.output.exists())

if __name__ == '__main__':
    unittest.main()
