#!/usr/bin/env python3
"""Local-only profile, archive, launch-guard and bounded-transfer checks."""
import ast
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

OPS = Path(__file__).resolve().parent
sys.path.insert(0, str(OPS))
from pair_paper_profiles import inspect_archive, launch_arguments, profile_limits


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, OPS / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


RUNNER = module('paper_runner', 'run-pair-paper-probe.py')
VERIFIER = module('paper_verifier', 'verify-pair-paper-probe.py')


def embedded_assignment(file, name):
    tree = ast.parse((OPS / file).read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                return node.value.value
    raise AssertionError('embedded script missing')


class Profiles(unittest.TestCase):
    def test_fixed_day_budget(self):
        day = profile_limits('study-24h')
        self.assertEqual(day['samples'], 1440)
        self.assertEqual(day['command'], 'collect-day')
        self.assertEqual(day['watchdog'], '86450s')
        self.assertEqual(day['maxDurationMs'], 86_430_000)
        self.assertEqual(day['minimumFreeBytes'], 256 * 1024 * 1024)
        self.assertGreaterEqual(day['maxArchiveBytes'], (day['samples'] + 3) * day['maxFileBytes'])
        # POSIX tar member headers/padding plus end padding fit the transfer cap.
        self.assertGreater(day['maxTransferBytes'], day['maxArchiveBytes'] + (day['samples'] + 3) * 1024 + 10240)
        self.assertGreater(day['transferTimeout'], 120)

    def test_profiles_do_not_mutate_legacy(self):
        self.assertEqual(profile_limits('probe')['watchdog'], '350s')
        self.assertEqual(profile_limits('study-30m')['watchdog'], '1850s')
        original = profile_limits('study-24h')
        original['samples'] = 2
        self.assertEqual(profile_limits('study-24h')['samples'], 1440)
        with self.assertRaisesRegex(RuntimeError, 'invalid-profile'):
            profile_limits('unlimited')

    def test_cli_rejects_unknown_or_extra_flags(self):
        self.assertEqual(launch_arguments(['--study-24h', 'bundle', 'new']), ('study-24h', ['bundle', 'new']))
        self.assertEqual(launch_arguments(['bundle', 'new'])[0], 'probe')
        for args in [[], ['--unknown', 'bundle'], ['--study-24h', 'bundle'], ['--study-24h', 'bundle', 'new', 'extra']]:
            with self.assertRaises(RuntimeError):
                launch_arguments(args)


class Archive(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / 'archive'
        self.root.mkdir(mode=0o700)
        self.limits = profile_limits('study-24h')

    def tearDown(self):
        self.temporary.cleanup()

    def save(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path

    def manifest(self):
        return self.save('manifest.json', {'startedAt': 1_800_000_000_000, 'plan': {'maxDurationMs': self.limits['maxDurationMs']},
                                           'feeEvidence': 'DO-NOT-RETURN'})

    def test_running_reports_only_safe_counts_and_times(self):
        self.manifest()
        self.save('000.json', {'private': 'DO-NOT-RETURN'})
        self.save('1000.json', {'private': 'DO-NOT-RETURN'})
        result = inspect_archive(self.root, self.limits, running=True)
        self.assertEqual(set(result), {'sampledCount', 'archiveBytes', 'startedAt', 'deadlineAt'})
        self.assertEqual(result['sampledCount'], 2)
        self.assertEqual(result['deadlineAt'], 1_800_086_430_000)
        self.assertNotIn('DO-NOT-RETURN', json.dumps(result))
        self.assertEqual(result['archiveBytes'], sum(p.stat().st_size for p in self.root.iterdir()))

    def test_running_before_archive_is_safe_but_final_requires_it(self):
        missing = self.root / 'absent'
        self.assertEqual(inspect_archive(missing, self.limits, running=True)['sampledCount'], 0)
        with self.assertRaises(RuntimeError):
            inspect_archive(missing, self.limits)

    def test_unknown_members_and_symlinks_rejected(self):
        path = self.save('1440.json', {})
        with self.assertRaisesRegex(RuntimeError, 'file-set'):
            inspect_archive(self.root, self.limits, running=True)
        path.unlink()
        target = self.save('000.json', {})
        (self.root / '001.json').symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'invalid-archive-file'):
            inspect_archive(self.root, self.limits, running=True)

    def test_file_permissions_and_day_size_bound(self):
        path = self.save('000.json', {})
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'invalid-archive-file'):
            inspect_archive(self.root, self.limits, running=True)
        path.chmod(0o600)
        path.write_bytes(b'x' * (32 * 1024 + 1))
        with self.assertRaisesRegex(RuntimeError, 'invalid-archive-file'):
            inspect_archive(self.root, self.limits, running=True)

    def test_aggregate_bound_and_manifest_deadline_are_enforced(self):
        self.manifest()
        with self.assertRaisesRegex(RuntimeError, 'archive-too-large'):
            inspect_archive(self.root, dict(self.limits, maxArchiveBytes=1), running=True)
        self.save('manifest.json', {'startedAt': 123, 'plan': {'maxDurationMs': 1}})
        with self.assertRaisesRegex(RuntimeError, 'manifest-deadline'):
            inspect_archive(self.root, self.limits, running=True)

    def test_running_allows_one_atomic_temporary_without_counting_it(self):
        self.manifest()
        self.save('000.json', {})
        temporary = self.save('001.json.tmp-12345678-1234-4234-a234-123456789abc', {'inProgress': True})
        result = inspect_archive(self.root, self.limits, running=True)
        self.assertEqual(result['sampledCount'], 1)
        self.assertEqual(result['archiveBytes'], sum(p.stat().st_size for p in self.root.iterdir()))
        self.assertNotIn(temporary.name, json.dumps(result))
        with self.assertRaisesRegex(RuntimeError, 'file-set'):
            inspect_archive(self.root, self.limits)
        self.save('002.json.tmp-12345678-1234-4234-a234-123456789abc', {})
        with self.assertRaisesRegex(RuntimeError, 'file-set'):
            inspect_archive(self.root, self.limits, running=True)

    def test_only_expected_atomic_temporary_names_and_bounds_are_allowed(self):
        temporary = self.save('other.json.tmp-12345678-1234-4234-a234-123456789abc', {})
        with self.assertRaisesRegex(RuntimeError, 'file-set'):
            inspect_archive(self.root, self.limits, running=True)
        temporary.unlink()
        temporary = self.save('000.json.tmp-bad-id', {})
        with self.assertRaisesRegex(RuntimeError, 'file-set'):
            inspect_archive(self.root, self.limits, running=True)
        temporary.unlink()
        temporary = self.save('000.json.tmp-12345678-1234-4234-a234-123456789abc', {})
        temporary.write_bytes(b'x' * (32 * 1024 + 1))
        with self.assertRaisesRegex(RuntimeError, 'invalid-archive-file'):
            inspect_archive(self.root, self.limits, running=True)

    def test_disappearing_atomic_temporary_during_progress_is_safe(self):
        self.manifest()
        temporary = self.save('000.json.tmp-12345678-1234-4234-a234-123456789abc', {})
        original = Path.lstat
        def lstat(path, *args, **kwargs):
            if path == temporary:
                temporary.unlink()
                raise FileNotFoundError()
            return original(path, *args, **kwargs)
        with patch.object(Path, 'lstat', lstat):
            result = inspect_archive(self.root, self.limits, running=True)
        self.assertEqual(result['sampledCount'], 0)
        self.assertEqual(result['archiveBytes'], (self.root / 'manifest.json').stat().st_size)

    def test_complete_archive_hashes_preserve_data_and_four_digit_names(self):
        self.manifest()
        self.save('instruments.json', {})
        self.save('state.json', {})
        for i in range(1440):
            self.save(f'{i:03d}.json', {'i': i})
        result = inspect_archive(self.root, self.limits)
        self.assertEqual(result['sampledCount'], 1440)
        self.assertEqual(len(result['files']), 1443)
        self.assertEqual(result['files']['1439.json'], hashlib.sha256((self.root / '1439.json').read_bytes()).hexdigest())
        (self.root / '1439.json').unlink()
        with self.assertRaisesRegex(RuntimeError, 'file-set'):
            inspect_archive(self.root, self.limits)


class Launch(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.bundle = self.root / 'pair-paper.mjs'
        self.bundle.write_text('test bundle')
        self.lock = self.root / 'launch.lock'
        self.script = embedded_assignment('run-pair-paper-probe.py', 'launch').replace(
            "'/home/mil/.crypto-pair-paper-launch.lock'", repr(str(self.lock)))
        self.values = {'ROOT': str(self.root), 'LIMITS': profile_limits('study-24h'),
                       'DIGEST': hashlib.sha256(self.bundle.read_bytes()).hexdigest(),
                       'NAME': 'crypto-pair-paper-20260926T000000Z-abcdef12',
                       'IMAGE': 'test-image', 'WATCHDOG': '86450s', 'COMMAND': 'collect-day'}
        self.calls = []

    def tearDown(self):
        self.temporary.cleanup()

    def execute(self, active='', free=512 * 1024 * 1024):
        def docker(args, **kwargs):
            self.calls.append(args)
            return active.encode() if args[:2] == ['docker', 'ps'] else b'test-container'
        scope = dict(self.values)
        try:
            with patch('subprocess.check_output', side_effect=docker), patch('shutil.disk_usage', return_value=SimpleNamespace(free=free)), contextlib.redirect_stdout(io.StringIO()):
                exec(compile(self.script, '<remote-launch>', 'exec'), scope)
        finally:
            if isinstance(scope.get('lock'), int):
                os.close(scope['lock'])

    def test_valid_launch_keeps_container_isolation(self):
        self.execute()
        args = self.calls[-1]
        self.assertEqual(args[:2], ['docker', 'run'])
        for name, value in [('--restart', 'no'), ('--log-driver', 'none'), ('--memory', '128m'), ('--cpus', '0.5'), ('--pids-limit', '64')]:
            self.assertEqual(args[args.index(name) + 1], value)
        self.assertIn('--read-only', args)
        self.assertIn('86450s', args)
        self.assertIn('collect-day', args)
        self.assertEqual(sum(a.startswith('type=bind,') for a in args), 3)
        self.assertEqual(self.lock.stat().st_mode & 0o777, 0o600)

    def test_active_capture_blocks_launch(self):
        with self.assertRaisesRegex(RuntimeError, 'another-pair-lab-running'):
            self.execute(active='other-app\ncrypto-pair-paper-existing\n')
        self.assertFalse(any(args[:2] == ['docker', 'run'] for args in self.calls))

    def test_space_and_bundle_mismatch_block_launch(self):
        with self.assertRaisesRegex(RuntimeError, 'insufficient-free-space'):
            self.execute(free=256 * 1024 * 1024 - 1)
        self.values['DIGEST'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'bundle-mismatch'):
            self.execute()
        self.assertFalse(any(args[:2] == ['docker', 'run'] for args in self.calls))

    def test_lock_symlink_and_permission_guard(self):
        self.lock.symlink_to(self.bundle)
        with self.assertRaises(OSError):
            self.execute()
        self.lock.unlink()
        self.lock.write_text('')
        self.lock.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'invalid-launch-lock'):
            self.execute()
        self.assertFalse(self.calls)

    def test_concurrent_launcher_lock_is_nonblocking(self):
        fd = os.open(self.lock, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.execute()
        finally:
            os.close(fd)
        self.assertFalse(self.calls)

    def test_remote_scripts_compile_and_transport_checks_host(self):
        for name in ['prepare', 'launch']:
            compile(embedded_assignment('run-pair-paper-probe.py', name), '<remote>', 'exec')
        compile(embedded_assignment('verify-pair-paper-probe.py', 'script'), '<remote>', 'exec')
        with patch.object(RUNNER, 'checked', return_value='{}') as checked:
            RUNNER.remote('pass')
            self.assertIn('StrictHostKeyChecking=yes', checked.call_args.args[0])


class VerifierIntegration(unittest.TestCase):
    def fixture(self, base):
        name = 'crypto-pair-paper-20260926T000000Z-abcdef12'
        app = {'id': 'app-id', 'image': 'app-image', 'startedAt': 'earlier', 'status': 'running', 'restarts': 0}
        launch = {'name': name, 'remoteRoot': '/home/mil/' + name, 'bundleSha256': 'a' * 64,
                  'sourceRevision': 'b' * 40, 'profile': 'study-24h', 'limits': profile_limits('study-24h'),
                  'appBefore': app, 'container': 'lab-id', 'image': 'lab-image'}
        (base / 'launch.json').write_text(json.dumps(launch))
        return launch

    def test_full_injected_running_script_executes_and_discloses_only_progress(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            launch = self.fixture(root)
            scripts = []
            def check(args, input_text=None):
                self.assertIn('StrictHostKeyChecking=yes', args)
                scripts.append(input_text)
                return json.dumps({'ready': False, 'status': 'running'})
            with patch.object(VERIFIER, 'checked', side_effect=check), patch.object(sys, 'argv', ['verify', str(root)]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(VERIFIER.main(), 75)
            remote = root / 'remote'
            archive = remote / 'data' / 'archive'
            archive.mkdir(mode=0o700, parents=True)
            for name, content in [('manifest.json', {'startedAt': 1_800_000_000_000, 'plan': {'maxDurationMs': 86_430_000}, 'fees': 'PRIVATE-MARKER'}), ('000.json', {'books': 'PRIVATE-MARKER'})]:
                path = archive / name
                path.write_text(json.dumps(content))
                path.chmod(0o600)
            captured = {'id': 'lab-id', 'image': 'lab-image', 'state': {'Status': 'running', 'StartedAt': '2026-09-26T00:00:00Z'},
                        'restarts': 0, 'user': '1002:27', 'ports': None,
                        'host': {'ReadonlyRootfs': True, 'RestartPolicy': {'Name': 'no'}, 'Memory': 134217728,
                                 'NanoCpus': 500000000, 'PidsLimit': 64, 'CapDrop': ['ALL'],
                                 'SecurityOpt': ['no-new-privileges'], 'LogConfig': {'Type': 'none'}},
                        'mounts': [{'Source': str(remote / source), 'Destination': destination, 'RW': rw}
                                   for source, destination, rw in [('pair-paper.mjs', '/lab/pair-paper.mjs', False),
                                                                   ('fees.json', '/lab/fees.json', False), ('data', '/data', True)]],
                        'command': ['timeout', '--signal=TERM', '--kill-after=10s', '86450s', 'node', '/lab/pair-paper.mjs', 'collect-day', '/lab/fees.json', '/data/archive']}
            def inspect_container(args):
                return json.dumps(launch['appBefore'] if args[-1] == 'robot_crypto_jsnode' else captured).encode()
            output = io.StringIO()
            with patch('subprocess.check_output', side_effect=inspect_container), contextlib.redirect_stdout(output):
                with self.assertRaises(SystemExit) as ended:
                    exec(compile(scripts[0].replace(launch['remoteRoot'], str(remote)), '<injected-remote-verifier>', 'exec'), {})
            self.assertEqual(ended.exception.code, 0)
            result = json.loads(output.getvalue())
            self.assertTrue(result['appUnchanged'])
            self.assertTrue(result['isolationVerified'])
            self.assertEqual(result['sampledCount'], 1)
            self.assertEqual(result['expectedSamples'], 1440)
            self.assertNotIn('PRIVATE-MARKER', output.getvalue())

    def test_modified_launch_limits_rejected_before_ssh(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            launch = self.fixture(root)
            launch['limits']['samples'] = 1
            (root / 'launch.json').write_text(json.dumps(launch))
            with patch.object(VERIFIER, 'checked') as check, patch.object(sys, 'argv', ['verify', str(root)]):
                with self.assertRaisesRegex(RuntimeError, 'launch-limits-mismatch'):
                    VERIFIER.main()
                check.assert_not_called()


class Streams(unittest.TestCase):
    def test_bounded_stream_exact_limit_and_overflow(self):
        cmd = [sys.executable, '-c', "import sys;sys.stdout.buffer.write(b'x'*16)"]
        self.assertEqual(VERIFIER.read_bounded_stream(cmd, max_bytes=16, timeout=5), b'x' * 16)
        with self.assertRaisesRegex(RuntimeError, 'too-large'):
            VERIFIER.read_bounded_stream(cmd, max_bytes=15, timeout=5)

    def test_stream_rejects_failed_and_timed_out_children(self):
        with self.assertRaisesRegex(RuntimeError, 'stream-failed'):
            VERIFIER.read_bounded_stream([sys.executable, '-c', 'raise SystemExit(1)'], timeout=5)
        with self.assertRaisesRegex(RuntimeError, 'stream-timeout'):
            VERIFIER.read_bounded_stream([sys.executable, '-c', 'import time;time.sleep(3)'], timeout=0.05)


if __name__ == '__main__':
    unittest.main()
