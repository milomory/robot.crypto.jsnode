"""Independent offline root-pin and preflight boundaries; no real broker/SSH/keys."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(HERE / filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


bridge = module('independent_recovery_bridge', 'recovery-bridge.py')
controller = module('independent_recovery_controller', 'run-recovery-once.py')
PIN = {'schema': 1, 'release': 'a' * 64, 'manifestSha256': 'a' * 64,
       'requestSha256': 'b' * 64, 'venue': 'mexc'}
READY = {'schema': 1, 'mode': 'order-recovery-preflight', 'requestSha256': 'b' * 64,
         'venue': 'mexc', 'executable': False, 'captureProvenanceVerified': False,
         'accountIdentityVerified': False, 'ready': True}


class PinFilesystemBoundary(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='recovery-pin-boundary-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / 'request-pin.json'
        self.path.write_text(json.dumps(PIN)); self.path.chmod(0o600)
        original = os.fstat
        self.reported_owner = 0
        def fstat(descriptor):
            info = original(descriptor)
            return types.SimpleNamespace(st_uid=self.reported_owner, st_mode=info.st_mode,
                                         st_nlink=info.st_nlink, st_size=info.st_size)
        patch = mock.patch.object(bridge.os, 'fstat', side_effect=fstat)
        patch.start(); self.addCleanup(patch.stop)

    def test_root_owned_regular_private_pin_is_required(self):
        self.assertEqual(bridge.load_pin(self.path), PIN)
        self.reported_owner = 1002
        with self.assertRaises(ValueError): bridge.load_pin(self.path)
        self.reported_owner = 0
        for mode in (0o400, 0o640, 0o644, 0o700, 0o660):
            self.path.chmod(mode)
            with self.subTest(mode=mode), self.assertRaises(ValueError): bridge.load_pin(self.path)

    def test_symlink_hardlink_and_fifo_never_become_a_request_pin(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.path)
        with self.assertRaises(OSError): bridge.load_pin(alias)
        alias.unlink(); os.link(str(self.path), str(alias))
        with self.assertRaises(ValueError): bridge.load_pin(self.path)
        alias.unlink(); self.path.unlink(); os.mkfifo(str(self.path), 0o600)
        with self.assertRaises(ValueError): bridge.load_pin(self.path)

    def test_size_duplicates_nonfinite_and_unknown_fields_rejected(self):
        invalid = [b'x' * 1025, b'{"schema":1,"schema":1}', b'{"schema":NaN}',
                   json.dumps(dict(PIN, apiSecret='FAKE_PRIVATE')).encode(),
                   json.dumps(dict(PIN, venue='okx; shell')).encode(),
                   json.dumps(dict(PIN, schema=True)).encode()]
        for raw in invalid:
            self.path.write_bytes(raw)
            with self.subTest(size=len(raw)), self.assertRaises(ValueError): bridge.load_pin(self.path)


class PreflightBeforeBrokerBoundary(unittest.TestCase):
    def invoke_rejected_preflight(self, value, status=0):
        with tempfile.TemporaryDirectory(prefix='recovery-preflight-boundary-') as temporary:
            source = Path(temporary)
            (source / 'release-pin.json').write_text(json.dumps({key: PIN[key] for key in ('schema', 'release', 'manifestSha256')}))
            contract = types.SimpleNamespace(load_pin=lambda path: dict(PIN), unique_pairs=bridge.unique_pairs,
                reject_constant=bridge.reject_constant, verification_command=bridge.verification_command,
                decode_report=bridge.decode_report)
            spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _value: None))
            with mock.patch.object(controller.os, 'geteuid', return_value=0), \
                 mock.patch.object(controller.sys, 'argv', ['run-recovery-once.py']), \
                 mock.patch.object(controller, '__file__', str(source / 'run-recovery-once.py')), \
                 mock.patch.object(controller.importlib.util, 'spec_from_file_location', return_value=spec), \
                 mock.patch.object(controller.importlib.util, 'module_from_spec', return_value=contract), \
                 mock.patch.object(controller, 'command', return_value=types.SimpleNamespace(returncode=status, stdout=json.dumps(value).encode())) as command, \
                 mock.patch.object(controller.Path, 'read_bytes', side_effect=AssertionError('unexpected-vault-metadata-read')), \
                 mock.patch.object(controller.subprocess, 'Popen', side_effect=AssertionError('unexpected-process-start')), \
                 mock.patch.object(controller, 'scoped_registry', side_effect=AssertionError('unexpected-registry-creation')), \
                 self.assertRaises(ValueError):
                try:
                    controller.main()
                finally:
                    self.assertEqual(command.call_count, 1)
                    argv = command.call_args[0][0]
                    self.assertEqual(argv[:5], ['/usr/bin/sudo', '-n', '-u', 'anton', '/usr/bin/ssh'])
                    self.assertIn('StrictHostKeyChecking=yes', argv)
                    self.assertIn('PREFLIGHT = True', argv[-1])
                    self.assertNotIn('secretctl', ' '.join(argv))

    def test_negative_preflight_stops_before_metadata_or_secret_delivery(self):
        self.invoke_rejected_preflight({'schema': 1, 'error': 'recovery-failed'})

    def test_valid_report_does_not_override_ssh_failure(self):
        self.invoke_rejected_preflight(READY, status=1)

    def test_different_venue_request_or_extra_field_never_reaches_broker(self):
        for delta in ({'venue': 'okx'}, {'requestSha256': 'c' * 64}, {'executable': True},
                      {'private': 'FAKE_PRIVATE'}, {'ready': 1}):
            with self.subTest(delta=delta): self.invoke_rejected_preflight(dict(READY, **delta))

    def test_report_schema_bool_does_not_pass_as_schema_integer(self):
        self.invoke_rejected_preflight(dict(READY, schema=True))

    def test_outer_timeouts_cover_both_remote_phases_and_cleanup(self):
        # Check nesting relationships, so reducing an outer deadline or increasing
        # inner work cannot silently restore premature credential-channel teardown.
        remote = ast.parse((HERE / 'run-once').read_text())
        limits = {node.targets[0].id: node.value.value for node in remote.body
                  if isinstance(node, ast.Assign) and len(node.targets) == 1
                  and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Constant)
                  and type(node.value.value) is int}
        bridge_tree = ast.parse((HERE / 'recovery-bridge.py').read_text())
        controller_tree = ast.parse((HERE / 'run-recovery-once.py').read_text())
        ssh = [keyword.value.value for call in ast.walk(bridge_tree) if isinstance(call, ast.Call)
               and isinstance(call.func, ast.Attribute) and call.func.attr == 'run'
               for keyword in call.keywords if keyword.arg == 'timeout']
        sockets = [call.args[0].value for call in ast.walk(bridge_tree) if isinstance(call, ast.Call)
                   and isinstance(call.func, ast.Attribute) and call.func.attr == 'settimeout'
                   and isinstance(call.func.value, ast.Name) and call.func.value.id == 'conn']
        alarm = [call.args[0].value for call in ast.walk(controller_tree) if isinstance(call, ast.Call)
                 and isinstance(call.func, ast.Attribute) and call.func.attr == 'alarm' and call.args[0].value > 0]
        uses = [keyword.value.value for call in ast.walk(controller_tree) if isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name) and call.func.id == 'command'
                and any(isinstance(value, ast.Constant) and value.value == 'use' for value in ast.walk(call))
                for keyword in call.keywords if keyword.arg == 'timeout']
        service = [int(value.value.split('=')[1]) for value in ast.walk(controller_tree)
                   if isinstance(value, ast.Constant) and isinstance(value.value, str)
                   and value.value.startswith('RuntimeMaxSec=')]
        records = {ref: {'backend': 'sops-age', 'backend_id': 'fixture', 'status': 'active'}
                   for _, ref in controller.selected_parts('mexc')}
        profile = next(iter(controller.scoped_registry(records, 'mexc')['profiles'].values()))['timeout_seconds']
        self.assertEqual(len(ssh), 1); self.assertEqual(len(sockets), 2)
        self.assertEqual(len(uses), 1); self.assertEqual(len(alarm), 1); self.assertEqual(len(service), 1)
        remote_budget = limits['PREFLIGHT_SECONDS'] + limits['RUN_SECONDS'] + 2 * limits['CLEANUP_SECONDS']
        self.assertGreaterEqual(ssh[0], remote_budget + 10)
        self.assertGreater(min(sockets), ssh[0]); self.assertGreater(profile, max(sockets))
        self.assertGreater(uses[0], profile); self.assertGreater(alarm[0], uses[0] + 20)
        self.assertGreater(service[0], alarm[0])

    def test_checked_in_remote_and_broker_sources_use_python36_syntax(self):
        for filename in ('recovery-bridge.py', 'run-recovery-once.py', 'run-once',
                         'install-remote.py', 'prepare-release.py'):
            with self.subTest(filename=filename):
                ast.parse((HERE / filename).read_text(), feature_version=(3, 6))
        source = bridge.REMOTE_VERIFIER.replace('__PIN_VALUE__', repr(PIN)).replace('__PREFLIGHT__', 'True')
        ast.parse(source, feature_version=(3, 6))


if __name__ == '__main__':
    unittest.main()
