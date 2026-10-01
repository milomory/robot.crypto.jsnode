#!/usr/bin/env python3
"""Offline tests only: all Docker commands target a temporary local fake executable."""
import ast
import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader('order_recovery_negative_acceptance', str(HERE / 'accept-installed.py'))
spec = importlib.util.spec_from_loader(loader.name, loader)
acceptance = importlib.util.module_from_spec(spec)
loader.exec_module(acceptance)

FAKE_DOCKER = r'''#!/usr/bin/python3
import json,os,pathlib,sys,time
os.umask(0o077)
args=sys.argv[1:];root=pathlib.Path(os.environ['ACCEPTANCE_FAKE_ROOT']);state=root/'container.json';log=root/'docker.jsonl'
row={'op':args[0]}
def logrow():
 with log.open('a') as output:output.write(json.dumps(row)+'\n')
if args[0]=='run':
 labels=[args[i+1] for i,value in enumerate(args) if value=='--label']
 release=next(value.split('=',1)[1] for value in labels if value.startswith('crypto-order-recovery.release='))
 request=next(value.split('=',1)[1] for value in labels if value.startswith('crypto-order-recovery.request='))
 row.update(stdinBytes=len(sys.stdin.buffer.read()),network=next(value for value in args if value.startswith('--network=')),mounts=[args[i+1] for i,value in enumerate(args) if value=='--mount'])
 logrow();cid='d'*64
 if os.environ.get('ACCEPTANCE_FAKE_NO_CID'):print('{"schema":1,"error":"recovery-failed"}');sys.exit(1)
 pathlib.Path(args[args.index('--cidfile')+1]).write_text(cid);state.write_text(json.dumps({'cid':cid,'release':release,'request':request}))
 if os.environ.get('ACCEPTANCE_FAKE_HANG'):time.sleep(20)
 if os.environ.get('ACCEPTANCE_FAKE_BAD_OUTPUT'):print('PRIVATE_CANARY'*1000);sys.exit(1)
 print('{"schema":1,"error":"recovery-failed"}');sys.exit(1)
if args[0]=='ps':
 logrow()
 if os.environ.get('ACCEPTANCE_FAKE_DAEMON_DOWN'):sys.exit(1)
 if state.exists():print(json.loads(state.read_text())['cid'])
 sys.exit(0)
if args[0]=='inspect':
 logrow()
 if not state.exists():sys.exit(1)
 value=json.loads(state.read_text());release='f'*64 if os.environ.get('ACCEPTANCE_FAKE_WRONG_LABEL') else value['release']
 print(value['cid']+' '+release+' '+value['request']);sys.exit(0)
if args[0]=='rm':
 row['target']=args[-1];logrow()
 if args[-1]!='d'*64:sys.exit(9)
 state.unlink();sys.exit(0)
sys.exit(3)
'''


class ContractTests(unittest.TestCase):
    def test_python36_syntax(self):
        ast.parse((HERE / 'accept-installed.py').read_text(), feature_version=(3, 6))

    def test_exact_network_none_release_only_scope(self):
        release = Path('/release') / ('a' * 64)
        args = acceptance.docker_arguments(release, Path('/state/private/container.cid'))
        mounts = [args[i + 1] for i, value in enumerate(args) if value == '--mount']
        self.assertEqual(mounts, ['type=bind,src=' + str(release) + ',dst=/code,readonly'])
        for required in ('--network=none', '--read-only', '--log-driver=none', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                         '--user=1002:27', '--pids-limit=64', '--memory=256m', '--cpus=0.5', '--pull=never', '--ulimit=core=0'):
            self.assertIn(required, args)
        self.assertEqual(args[-4:], [acceptance.ENTRYPOINT, '--request-digest', '0' * 64, '--preflight'])
        self.assertNotIn('--env', args)
        self.assertNotIn('--publish', args)
        self.assertNotIn('/observer-state', ' '.join(args))
        self.assertNotIn('/var/run/docker.sock', ' '.join(args))

    def test_strict_fixed_failure_schema_and_exit_status(self):
        acceptance.assert_fixed_failure(b'{"schema":1,"error":"recovery-failed"}\n', 1)
        for raw, code in ((b'{"schema":true,"error":"recovery-failed"}', 1),
                          (b'{"schema":1,"error":"recovery-failed","private":"PRIVATE_CANARY"}', 1),
                          (b'{"schema":1,"schema":1,"error":"recovery-failed"}', 1),
                          (b'{"schema":1,"error":"recovery-failed"}', 0),
                          (b'PRIVATE_CANARY', 1), (b'x' * 4097, 1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ValueError):
                acceptance.assert_fixed_failure(raw, code)


class IsolatedRuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='order-recovery-acceptance-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.base = self.root / 'recovery'
        self.docker = self.root / 'fake-docker'
        self.docker.write_text(FAKE_DOCKER)
        self.docker.chmod(0o700)
        for name, value in (('BASE', self.base), ('UID', os.getuid()), ('DOCKER', str(self.docker))):
            patch = mock.patch.object(acceptance, name, value)
            patch.start(); self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, {'ACCEPTANCE_FAKE_ROOT': str(self.root)})
        env.start(); self.addCleanup(env.stop)
        for directory in (self.base, self.base / 'releases', self.base / 'state'):
            directory.mkdir(mode=0o700)
        source = (HERE / 'run-once').read_text().replace("BASE = Path('/home/mil/crypto-order-recovery')", 'BASE = Path(' + repr(str(self.base)) + ')')
        source = source.replace('UID = 1002', 'UID = ' + str(os.getuid())).replace("DOCKER = '/usr/bin/docker'", 'DOCKER = ' + repr(str(self.docker)))
        self.files = {'run-once': source.encode(), 'package.json': b'{"type":"module"}',
                      'dist/scripts/protected-order-recovery.js': b'// Offline fixture; fake Docker never executes this.\n'}
        manifest = json.dumps({name: hashlib.sha256(content).hexdigest() for name, content in sorted(self.files.items())}, sort_keys=True, separators=(',', ':')).encode()
        self.digest = hashlib.sha256(manifest).hexdigest()
        self.release = self.base / 'releases' / self.digest
        self.release.mkdir(mode=0o700)
        (self.release / 'dist').mkdir(mode=0o700)
        (self.release / 'dist' / 'scripts').mkdir(mode=0o700)
        for name, content in dict(self.files, **{'manifest.json': manifest}).items():
            path = self.release / name
            path.write_bytes(content); path.chmod(0o700 if name == 'run-once' else 0o600)

    def logs(self):
        path = self.root / 'docker.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_complete_negative_acceptance_with_fake_docker(self):
        result = acceptance.accept_installed(self.digest)
        self.assertEqual(result, {'schema': 1, 'release': self.digest, 'manifestVerified': True,
                                 'missingRequestRefused': True, 'isolatedEntrypointRefused': True,
                                 'networkDisabled': True, 'emptyStdin': True, 'cleanupVerified': True,
                                 'keysDelivered': False, 'liveCaptureStarted': False})
        runs = [row for row in self.logs() if row['op'] == 'run']
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['stdinBytes'], 0)
        self.assertEqual(runs[0]['network'], '--network=none')
        self.assertEqual(len(runs[0]['mounts']), 1)
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d' * 64])
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual([path.name for path in (self.base / 'state').iterdir()], ['.recovery.lock'])
        self.assertFalse((self.base / 'requests').exists())
        self.assertFalse((self.release / '__pycache__').exists())

    def test_expected_stdout_without_created_cid_is_not_execution_evidence(self):
        with mock.patch.dict(os.environ, {'ACCEPTANCE_FAKE_NO_CID': '1'}), self.assertRaises(FileNotFoundError):
            acceptance.accept_installed(self.digest)
        self.assertFalse(any(row['op'] == 'rm' for row in self.logs()))
        self.assertFalse((self.root / 'container.json').exists())

    def test_mismatched_labels_preserve_cid_and_never_remove(self):
        with mock.patch.dict(os.environ, {'ACCEPTANCE_FAKE_WRONG_LABEL': '1'}), self.assertRaises(ValueError):
            acceptance.accept_installed(self.digest)
        self.assertFalse(any(row['op'] == 'rm' for row in self.logs()))
        marker = self.base / 'state' / ('.acceptance-' + str(os.getpid())) / 'container.cid'
        self.assertTrue(marker.exists())
        self.assertTrue((self.root / 'container.json').exists())

    def test_existing_unrelated_container_is_never_removed(self):
        (self.root / 'container.json').write_text(json.dumps({'cid': 'e' * 64}))
        with self.assertRaises(ValueError):
            acceptance.accept_installed(self.digest)
        self.assertFalse(any(row['op'] in ('run', 'rm') for row in self.logs()))

    def test_present_zero_request_refuses_acceptance_without_creating_request(self):
        requests = self.base / 'requests'; requests.mkdir(mode=0o700)
        (requests / acceptance.ZERO_REQUEST).mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            acceptance.accept_installed(self.digest)
        self.assertEqual(self.logs(), [])

    def test_mutated_runner_rejected_before_execution(self):
        marker = self.root / 'untrusted-code-executed'
        changed = self.release / 'run-once'
        changed.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("bad")\n')
        with self.assertRaises(ValueError):
            acceptance.accept_installed(self.digest)
        self.assertFalse(marker.exists())
        self.assertEqual(self.logs(), [])

    def test_full_manifest_rejects_extra_file_without_docker(self):
        extra = self.release / 'extra'; extra.write_text('extra'); extra.chmod(0o600)
        with self.assertRaises(ValueError):
            acceptance.accept_installed(self.digest)
        self.assertEqual(self.logs(), [])

    def test_unexpected_output_still_cleans_exact_container(self):
        with mock.patch.dict(os.environ, {'ACCEPTANCE_FAKE_BAD_OUTPUT': '1'}), self.assertRaises(ValueError):
            acceptance.accept_installed(self.digest)
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d' * 64])

    def test_timeout_still_cleans_exact_container(self):
        with mock.patch.object(acceptance, 'RUN_SECONDS', .3), mock.patch.dict(os.environ, {'ACCEPTANCE_FAKE_HANG': '1'}), self.assertRaises(TimeoutError):
            acceptance.accept_installed(self.digest)
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d' * 64])

    def test_daemon_unavailable_refuses_without_starting(self):
        with mock.patch.dict(os.environ, {'ACCEPTANCE_FAKE_DAEMON_DOWN': '1'}), self.assertRaises(ValueError):
            acceptance.accept_installed(self.digest)
        self.assertFalse(any(row['op'] in ('run', 'rm') for row in self.logs()))

    def test_existing_private_acceptance_directory_is_not_reused_or_deleted(self):
        owned = self.base / 'state' / ('.acceptance-' + str(os.getpid()))
        owned.mkdir(mode=0o700); (owned / 'leftover').write_text('keep')
        with self.assertRaises(FileExistsError):
            acceptance.accept_installed(self.digest)
        self.assertTrue((owned / 'leftover').exists())
        self.assertFalse(any(row['op'] == 'run' for row in self.logs()))


if __name__ == '__main__':
    unittest.main()
