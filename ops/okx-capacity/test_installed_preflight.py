#!/usr/bin/env python3
"""Offline installed diagnostic tests. Fake Docker, empty stdin, no credentials/network."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


check = load('identity_installed_preflight', HERE / 'check-installed.py')
fixtures = load('identity_preflight_fixtures', HERE / 'test_runtime.py')


class ContractTests(unittest.TestCase):
    def test_python36_and_fixed_empty_readonly_scope(self):
        ast.parse((HERE / 'check-installed.py').read_text(), feature_version=(3, 6))
        args = check.docker_arguments(Path('/release') / ('a' * 64), Path('/cid'), 'test-invocation')
        self.assertIn('--network=none', args)
        self.assertIn('--read-only', args)
        self.assertIn('--log-driver=none', args)
        mounts = [args[index + 1] for index, value in enumerate(args) if value == '--mount']
        self.assertEqual(len(mounts), 5)
        self.assertTrue(all(value.endswith(',readonly') for value in mounts))
        self.assertEqual(args[-4:], ['--disable-proto=throw', '--input-type=module', '-e', check.NODE_PREFLIGHT])
        for prohibited in ('executeOkxCapacity', 'readCapacityStdin', 'fetch(', '/journal', 'robot.crypto.jsnode', '--env'):
            self.assertNotIn(prohibited, ' '.join(args))

    def test_strict_result_allows_only_booleans_and_safe_error_code(self):
        self.assertEqual(check.decode_result(b'{"schema":1,"preflightPassed":true}'), {'schema': 1, 'preflightPassed': True})
        for reason in ('ENOENT', 'EACCES', 'EROFS', 'other'):
            value = {'schema': 1, 'preflightPassed': False, 'reason': reason}
            self.assertEqual(check.decode_result(json.dumps(value).encode()), value)
        for raw in (b'{"schema":true,"preflightPassed":true}', b'{"schema":1,"preflightPassed":1}',
                    b'{"schema":1,"preflightPassed":false,"reason":"PRIVATE"}',
                    b'{"schema":1,"preflightPassed":true,"path":"PRIVATE"}',
                    b'{"schema":1,"schema":1,"preflightPassed":true}', b'x' * 1025):
            with self.assertRaises(ValueError): check.decode_result(raw)

    def test_actual_node_error_projection_never_prints_path_or_message(self):
        target = "import('/code/dist/accounts/okx-capacity-runtime.js')"
        for code in ('ENOENT', 'EACCES', 'EROFS', 'PRIVATE_CODE'):
            replacement = "Promise.resolve({preflightOkxCapacity:async()=>{throw Object.assign(new Error('PRIVATE_MESSAGE'),{code:" + json.dumps(code) + ",path:'PRIVATE_PATH'});}})"
            source = check.NODE_PREFLIGHT.replace(target, replacement)
            result = subprocess.run(['node', '--input-type=module', '-e', source], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, b'')
            self.assertNotIn(b'PRIVATE', result.stdout)
            self.assertEqual(check.decode_result(result.stdout)['reason'], code if code != 'PRIVATE_CODE' else 'other')


class InstalledPreflightTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='identity-installed-preflight-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.base = self.root / 'identity'
        self.observer = self.root / 'observer'; self.observer.mkdir(mode=0o700)
        for name, raw in (('.observer.lock', b''), ('cooldowns.json', b'{"schema":1,"mexc":0,"okx":0}')):
            path = self.observer / name; path.write_bytes(raw); path.chmod(0o600)
        self.binding = self.root / 'accepted-funds';self.binding.mkdir(mode=0o700)
        (self.binding/'binding').mkdir(mode=0o700);(self.binding/'releases').mkdir(mode=0o700)
        old_manifest=b'{"accepted":"synthetic-old-release"}'
        old_hash=hashlib.sha256(old_manifest).hexdigest()
        old_source=self.binding/'releases'/old_hash;old_source.mkdir(mode=0o700)
        for path,raw in ((old_source/'manifest.json',old_manifest),(self.binding/'binding'/'selection.json',b'{}'),
                         (self.binding/'binding'/'pin.json',b'{}'),(self.binding/'binding'/'binding-key',b'k'*32)):
            path.write_bytes(raw);path.chmod(0o600)
        for key,value in (('BINDING_BASE',self.binding),('BINDING_SOURCE',old_source),('BINDING_SOURCE_HASH',old_hash)):
            patch=mock.patch.object(check,key,value);patch.start();self.addCleanup(patch.stop)
        self.docker = self.root / 'fake-docker'
        fake = fixtures.FAKE_DOCKER.replace("print(json.dumps(value));sys.exit(0)",
            "value={'schema':1,'preflightPassed':True}\n if os.environ.get('FAKE_PREFLIGHT_REASON'):value={'schema':1,'preflightPassed':False,'reason':os.environ['FAKE_PREFLIGHT_REASON']}\n print(json.dumps(value));sys.exit(0)")
        self.docker.write_text(fake); self.docker.chmod(0o700)
        source = (HERE / 'run-once').read_text()
        for old, new in [("BASE = Path('/home/mil/crypto-okx-capacity')", 'BASE = Path(' + repr(str(self.base)) + ')'),
                         ("OBSERVER_STATE = Path('/home/mil/crypto-pair-observer/state')", 'OBSERVER_STATE = Path(' + repr(str(self.observer)) + ')'),
                         ("DOCKER = '/usr/bin/docker'", 'DOCKER = ' + repr(str(self.docker))),
                         ('UID = 1002', 'UID = ' + str(os.getuid())),
                         ("BINDING_BASE = Path('/home/mil/crypto-account-funds')", 'BINDING_BASE = Path('+repr(str(self.binding))+')'),
                         ("BINDING_SOURCE_HASH = 'da4ad8a2e69855c9a49e1556287e55b2a7703e6e3aa67efe115969fb8105d7c5'", 'BINDING_SOURCE_HASH = '+repr(old_hash))]:
            self.assertIn(old, source); source = source.replace(old, new)
        files = dict(fixtures.FILES, **{'run-once': source.encode()})
        for module in (check, fixtures.installer):
            for key, value in (('BASE', self.base), ('UID', os.getuid())):
                patch = mock.patch.object(module, key, value); patch.start(); self.addCleanup(patch.stop)
        for key, value in (('OBSERVER_STATE', self.observer), ('DOCKER', str(self.docker))):
            patch = mock.patch.object(check, key, value); patch.start(); self.addCleanup(patch.stop)
        patch = mock.patch.dict(os.environ, {'FAKE_IDENTITY_DOCKER_HOME': str(self.root)})
        patch.start(); self.addCleanup(patch.stop)
        self.release, raw, _ = fixtures.builder.package(files)
        fixtures.installer.install(fixtures.installer.unpack(raw, self.release), self.release)
        self.release_path = self.base / 'releases' / self.release

    def logs(self):
        path = self.root / 'docker.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_bootstrap_hash_and_manifest_verified_before_code_exec(self):
        check.load_verified_runner(self.release_path)
        target = self.release_path / 'run-once'
        marker = self.root / 'unexpected-code-exec'
        target.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("BAD")\n')
        with self.assertRaises(ValueError): check.check_installed(self.release)
        self.assertFalse(marker.exists())
        self.assertEqual(self.logs(), [])

    def test_valid_preflight_empty_stdin_exact_cleanup_no_observer_write(self):
        before = (self.observer / 'cooldowns.json').read_bytes()
        value = check.check_installed(self.release)
        self.assertTrue(value['preflightPassed']); self.assertTrue(value['cleanupVerified'])
        self.assertFalse(value['keysDelivered']); self.assertEqual(value['requestCount'], 0)
        rows = [row for row in self.logs() if row['op'] == 'run']
        self.assertEqual(len(rows), 1); self.assertEqual(rows[0]['stdinBytes'], 0)
        self.assertEqual(rows[0]['network'], '--network=none')
        self.assertTrue(all(mount.endswith(',readonly') for mount in rows[0]['mounts']))
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d' * 64])
        self.assertEqual(list((self.base / 'state').iterdir()), [self.base / 'state' / '.capacity.lock'])
        self.assertEqual((self.observer / 'cooldowns.json').read_bytes(), before)

    def test_allowed_failure_is_returned_only_after_verified_cleanup(self):
        with mock.patch.dict(os.environ, {'FAKE_PREFLIGHT_REASON': 'EACCES'}):
            value = check.check_installed(self.release)
        self.assertFalse(value['preflightPassed']); self.assertEqual(value['reason'], 'EACCES')
        self.assertTrue(value['cleanupVerified']); self.assertFalse((self.root / 'container.json').exists())

    def test_both_locks_block_before_container_start(self):
        helper = check.load_verified_runner(self.release_path)
        for path in (self.observer / '.observer.lock', self.base / 'state' / '.capacity.lock'):
            with helper.locked_file(path, create=True), self.assertRaises(BlockingIOError):
                check.check_installed(self.release)
        self.assertEqual(self.logs(), [])

    def test_foreign_invocation_preserves_container_and_marker(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_WRONG_INVOCATION': '1'}), self.assertRaises(ValueError):
            check.check_installed(self.release)
        self.assertEqual([row for row in self.logs() if row['op'] == 'rm'], [])
        self.assertTrue((self.root / 'container.json').exists())
        self.assertEqual(len(list((self.base / 'state').glob('.preflight-container-*'))), 1)

    def test_timeout_removes_only_exact_own_container(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_HANG': '1'}), mock.patch.object(check, 'RUN_SECONDS', .2), self.assertRaises(TimeoutError):
            check.check_installed(self.release)
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d' * 64])
        self.assertFalse((self.root / 'container.json').exists())


if __name__ == '__main__':
    unittest.main()
