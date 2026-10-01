#!/usr/bin/env python3
"""Offline archive/runner tests. Fake Docker is an ordinary local subprocess."""
import ast
import contextlib
import copy
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


runner = load('recovery_fixed_runner', HERE / 'run-once')
builder = load('recovery_release_builder', HERE / 'prepare-release.py')
installer = load('recovery_release_installer', HERE / 'install-remote.py')
DIGEST = 'b' * 64
GOOD = {'schema': 1, 'mode': 'order-recovery-readonly', 'requestSha256': DIGEST, 'venue': 'mexc',
        'reportWritten': True, 'executable': False, 'captureProvenanceVerified': False,
        'accountIdentityVerified': False, 'requestCount': 3,
        'receipt': {'schema': 1, 'kind': 'live-order-recovery-archive-receipt',
                    'archiveId': '10000000-0000-4000-8000-000000000001', 'archiveHash': 'c' * 64}}
PREFLIGHT = {key: value for key, value in GOOD.items() if key not in ('reportWritten', 'requestCount', 'receipt')}
PREFLIGHT.update(mode='order-recovery-preflight', ready=True)
FILES = {'package.json': b'{"type":"module"}', 'run-once': (HERE / 'run-once').read_bytes(),
         'dist/scripts/protected-order-recovery.js': b'// test-only synthetic package; never install remotely\n'}


def archive_members(items):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, content, mode, kind in items:
            item = tarfile.TarInfo(name)
            item.mode, item.size, item.type = mode, len(content), kind
            if kind == tarfile.SYMTYPE:
                item.linkname = '/tmp/escape'
            archive.addfile(item, io.BytesIO(content))
    return output.getvalue()


FAKE_DOCKER = r'''#!/usr/bin/env python3
import json,os,pathlib,sys,time
args=sys.argv[1:];home=pathlib.Path(os.environ['FAKE_DOCKER_HOME']);state=home/'container.json';log=home/'docker.jsonl'
record={'op':args[0]}
def emitlog():
 with log.open('a') as f:f.write(json.dumps(record)+'\n')
if args[0]=='run':
 cid='d'*64;release=[args[i+1].split('=',1)[1] for i,x in enumerate(args) if x=='--label' and args[i+1].startswith('crypto-order-recovery.release=')][0]
 request=args[args.index('--request-digest')+1];preflight='--preflight' in args
 raw=sys.stdin.buffer.read();record.update(preflight=preflight,stdinBytes=len(raw),network=[x for x in args if x.startswith('--network=')][0],mounts=[args[i+1] for i,x in enumerate(args) if x=='--mount']);emitlog()
 pathlib.Path(args[args.index('--cidfile')+1]).write_text(cid);os.chmod(args[args.index('--cidfile')+1],0o600)
 state.write_text(json.dumps({'cid':cid,'release':release,'request':request}));os.chmod(state,0o600)
 if os.environ.get('FAKE_DOCKER_HANG'):time.sleep(10)
 if os.environ.get('FAKE_DOCKER_FAIL_PREFLIGHT') and preflight:print('{"schema":1,"error":"recovery-failed"}');sys.exit(1)
 value={'schema':1,'mode':'order-recovery-preflight' if preflight else 'order-recovery-readonly','requestSha256':request,'venue':'mexc','executable':False,'captureProvenanceVerified':False,'accountIdentityVerified':False}
 if preflight:value['ready']=True
 else:value.update(reportWritten=True,requestCount=3,receipt={'schema':1,'kind':'live-order-recovery-archive-receipt','archiveId':'10000000-0000-4000-8000-000000000001','archiveHash':'c'*64})
 if os.environ.get('FAKE_DOCKER_PRIVATE_OUTPUT'):value['private']='FAKE_PRIVATE_CANARY'
 print(json.dumps(value));sys.exit(0)
if args[0]=='ps':
 emitlog()
 if os.environ.get('FAKE_DOCKER_DAEMON_DOWN'):sys.exit(1)
 if state.exists():print('d'*64)
 sys.exit(0)
if args[0]=='inspect':
 emitlog()
 if not state.exists():sys.exit(1)
 value=json.loads(state.read_text());print(value['cid']+' '+('0'*64 if os.environ.get('FAKE_DOCKER_WRONG_LABEL') else value['release'])+' '+value['request']);sys.exit(0)
if args[0]=='rm':
 record['target']=args[-1];emitlog()
 if args[-1]!='d'*64:sys.exit(9)
 state.unlink();sys.exit(0)
sys.exit(4)
'''


class ContractTests(unittest.TestCase):
    def test_python36_syntax(self):
        for name in ('run-once', 'prepare-release.py', 'install-remote.py'):
            ast.parse((HERE / name).read_text(), feature_version=(3, 6))

    def test_strict_metadata_no_private_fields_or_wrong_pin(self):
        for preflight, value in ((False, GOOD), (True, PREFLIGHT)):
            self.assertEqual(runner.decode_report(json.dumps(value).encode(), DIGEST, 'mexc', preflight), value)
            for field, invalid in [('schema', True), ('requestSha256', 'a'*64), ('venue', 'okx'),
                                   ('executable', True), ('accountIdentityVerified', True), ('private', 'FAKE_PRIVATE')]:
                with self.assertRaises(ValueError):
                    runner.decode_report(json.dumps(dict(value, **{field: invalid})).encode(), DIGEST, 'mexc', preflight)
        for raw in (b'NaN', b'{"schema":1,"schema":1}', b'{}', b'x' * 4097):
            with self.assertRaises(ValueError):
                runner.decode_report(raw, DIGEST, 'mexc', False)
        bad = copy.deepcopy(GOOD)
        bad['receipt']['apiSecret'] = 'FAKE_SECRET'
        with self.assertRaises(ValueError):
            runner.decode_report(json.dumps(bad).encode(), DIGEST, 'mexc', False)

    def test_fixed_docker_scope(self):
        for preflight in (True, False):
            args = runner.docker_arguments(Path('/release') / ('a'*64), Path('/request') / DIGEST, Path('/state/cid'), preflight)
            self.assertIn('--network=' + ('none' if preflight else 'bridge'), args)
            for flag in ('--pull=never', '--read-only', '--log-driver=none', '--user=1002:27', '--cap-drop=ALL', '--ulimit=core=0'):
                self.assertIn(flag, args)
            self.assertIn(runner.IMAGE, args)
            self.assertEqual(args[-4:] if preflight else args[-3:], [runner.ENTRYPOINT, '--request-digest', DIGEST] + (['--preflight'] if preflight else []))
            mounts = [args[index + 1] for index, value in enumerate(args) if value == '--mount']
            self.assertEqual(len(mounts), 5)
            self.assertTrue(all('readonly' in value for value in mounts[:3]))
            self.assertNotIn('/var/run/docker.sock', ' '.join(args))
            self.assertNotIn('--env', args)
            self.assertNotIn('--publish', args)
            if preflight:
                self.assertTrue(all('readonly' in value for value in mounts))

    def test_reproducible_minimal_archive_and_traversal_guards(self):
        release, raw, count = builder.package(FILES)
        self.assertEqual((release, raw, count), builder.package(FILES))
        self.assertEqual(installer.unpack(raw, release), dict(FILES, **{'manifest.json': json.dumps(
            {name: hashlib.sha256(content).hexdigest() for name, content in sorted(FILES.items())}, sort_keys=True, separators=(',', ':')).encode()}))
        for name in ('../escape', '/absolute', 'a//b', './file', 'a/../b', 'a\\b'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                installer.unpack(archive_members([(name, b'x', 0o600, tarfile.REGTYPE)]), release)
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.CHRTYPE):
            with self.assertRaises(ValueError):
                installer.unpack(archive_members([('unsafe', b'', 0o600, kind)]), release)
        for mode in (0o644, 0o777, 0o4600):
            with self.assertRaises(ValueError):
                installer.unpack(archive_members([('unsafe', b'x', mode, tarfile.REGTYPE)]), release)
        with self.assertRaises(ValueError):
            installer.unpack(archive_members([('dup', b'x', 0o600, tarfile.REGTYPE)]*2), release)
        with self.assertRaises(ValueError):
            installer.unpack(raw, 'f'*64)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='recovery-runtime-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'crypto-order-recovery'
        self.observer = self.root / 'observer-state'
        self.observer.mkdir(mode=0o700)
        (self.observer / '.observer.lock').write_bytes(b'')
        (self.observer / '.observer.lock').chmod(0o600)
        self.release, artifact, _ = builder.package(FILES)
        self.files = installer.unpack(artifact, self.release)
        for module in (runner, installer):
            for key, value in (('BASE', self.base), ('UID', os.getuid())):
                patch = mock.patch.object(module, key, value); patch.start(); self.addCleanup(patch.stop)
        patch = mock.patch.object(runner, 'OBSERVER_STATE', self.observer); patch.start(); self.addCleanup(patch.stop)
        installer.install(self.files, self.release)
        self.assertFalse((self.base / 'requests').exists())
        self.release_path = self.base / 'releases' / self.release
        request = b'{"venue":"mexc"}'
        self.request_digest = hashlib.sha256(request).hexdigest()
        self.request = self.base / 'requests' / self.request_digest
        (self.base / 'requests').mkdir(mode=0o700)
        self.request.mkdir(mode=0o700)
        (self.request / 'journal').mkdir(mode=0o700)
        (self.request / 'request.json').write_bytes(request)
        (self.request / 'request.json').chmod(0o600)
        self.docker = self.root / 'fake-docker'
        self.docker.write_text(FAKE_DOCKER); self.docker.chmod(0o700)
        for key, value in (('DOCKER', str(self.docker)), ('__file__', str(self.release_path / 'run-once'))):
            patch = mock.patch.object(runner, key, value); patch.start(); self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, {'FAKE_DOCKER_HOME': str(self.root)})
        env.start(); self.addCleanup(env.stop)

    def invoke(self, preflight=False):
        output = io.StringIO()
        with tempfile.TemporaryFile() as payload:
            payload.write(b'FAKE_PRIVATE_CREDENTIALS'); payload.seek(0)
            stdin = type('PrivateInput', (), {'buffer': payload})()
            args = [str(self.release_path / 'run-once')] + (['--preflight'] if preflight else []) + [self.request_digest]
            with mock.patch.object(runner.sys, 'argv', args), mock.patch.object(runner.sys, 'stdin', stdin), contextlib.redirect_stdout(output):
                runner.main()
        return json.loads(output.getvalue())

    def logs(self):
        path = self.root / 'docker.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_installed_tree_and_full_manifest_validation(self):
        runner.verify_release(self.release_path)
        for path in (self.base, self.base / 'releases', self.base / 'state', self.release_path):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        with self.assertRaises(ValueError):
            installer.install(self.files, self.release)
        extra = self.release_path / 'extra'; extra.write_bytes(b'x'); extra.chmod(0o600)
        with self.assertRaises(ValueError):
            runner.verify_release(self.release_path)
        extra.unlink()
        extra.mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            runner.verify_release(self.release_path)

    def test_no_credential_preflight_subprocess_and_cleanup_proof(self):
        result = self.invoke(True)
        self.assertEqual(result['mode'], 'order-recovery-preflight')
        calls = self.logs()
        runs = [row for row in calls if row['op'] == 'run']
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['stdinBytes'], 0)
        self.assertEqual(runs[0]['network'], '--network=none')
        self.assertEqual([row['target'] for row in calls if row['op'] == 'rm'], ['d'*64])
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual(list((self.base / 'state').iterdir()), [self.base / 'state' / '.recovery.lock'])

    def test_capture_has_separate_preflight_then_credential_stdin_only(self):
        result = self.invoke()
        self.assertEqual(result['requestCount'], 3)
        runs = [row for row in self.logs() if row['op'] == 'run']
        self.assertEqual([row['stdinBytes'] for row in runs], [0, len(b'FAKE_PRIVATE_CREDENTIALS')])
        self.assertEqual([row['network'] for row in runs], ['--network=none', '--network=bridge'])
        self.assertEqual(len([row for row in self.logs() if row['op'] == 'rm']), 2)
        self.assertNotIn('FAKE_PRIVATE', json.dumps(result))

    def test_negative_preflight_never_consumes_keys_or_starts_capture(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_FAIL_PREFLIGHT': '1'}), self.assertRaises(ValueError):
            self.invoke()
        runs = [row for row in self.logs() if row['op'] == 'run']
        self.assertEqual(len(runs), 1); self.assertEqual(runs[0]['stdinBytes'], 0)
        self.assertFalse((self.root / 'container.json').exists())

    def test_private_output_rejected_but_cleanup_still_completes(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_PRIVATE_OUTPUT': '1'}), self.assertRaises(ValueError):
            self.invoke()
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual(len([row for row in self.logs() if row['op'] == 'run']), 1)

    def test_wrong_label_never_removes_container_and_never_acknowledges(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_WRONG_LABEL': '1'}), self.assertRaises(ValueError):
            self.invoke(True)
        self.assertTrue((self.root / 'container.json').exists())
        self.assertEqual([row for row in self.logs() if row['op'] == 'rm'], [])

    def test_daemon_error_is_not_absence(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_DAEMON_DOWN': '1'}), self.assertRaises(ValueError):
            self.invoke(True)
        self.assertEqual([row for row in self.logs() if row['op'] == 'run'], [])

    def test_timeout_kills_only_recorded_fake_container_and_does_not_acknowledge(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_HANG': '1'}), mock.patch.object(runner, 'PREFLIGHT_SECONDS', 0.2):
            with self.assertRaises(TimeoutError):
                self.invoke(True)
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d'*64])

    def test_observer_and_dedicated_locks_block_without_docker(self):
        for path in (self.observer / '.observer.lock', self.base / 'state' / '.recovery.lock'):
            with runner.locked_file(path, create=True), self.assertRaises(BlockingIOError):
                self.invoke(True)
        self.assertEqual(self.logs(), [])

    def test_existing_container_is_preserved(self):
        (self.root / 'container.json').write_text('{"unrelated":true}')
        with self.assertRaises(ValueError):
            self.invoke(True)
        self.assertEqual([row for row in self.logs() if row['op'] in ('run', 'rm')], [])
        self.assertTrue((self.root / 'container.json').exists())

    def test_request_and_release_mutation_fail_before_any_docker(self):
        request_file = self.request / 'request.json'
        original = request_file.read_bytes()
        request_file.write_bytes(original + b' ')
        with self.assertRaises(ValueError):
            self.invoke(True)
        request_file.write_bytes(original)
        (self.release_path / 'package.json').chmod(0o644)
        with self.assertRaises(ValueError):
            self.invoke(True)
        self.assertEqual(self.logs(), [])

    def test_existing_symlink_hardlink_and_unsafe_modes_rejected(self):
        file = self.release_path / 'package.json'
        peer = self.root / 'alias'; os.link(str(file), str(peer))
        with self.assertRaises(ValueError):
            runner.verify_release(self.release_path)
        peer.unlink()
        original = file.read_bytes(); file.unlink(); file.symlink_to(peer)
        with self.assertRaises(OSError):
            runner.verify_release(self.release_path)
        file.unlink(); file.write_bytes(original); file.chmod(0o600)
        self.request.chmod(0o755)
        with self.assertRaises(ValueError):
            runner.verify_request(self.request_digest)

    def test_uncertain_post_rename_sync_keeps_verified_release_and_refuses_retry(self):
        files = dict(FILES, **{'new.js': b'new'})
        release, artifact, _ = builder.package(files)
        verified = installer.unpack(artifact, release)
        destination = self.base / 'releases' / release
        original_sync = installer.sync_directory
        def fail_after_publish(path):
            if path == destination.parent and destination.exists():
                raise OSError('FAKE_PRIVATE_IO')
            return original_sync(path)
        with mock.patch.object(installer, 'sync_directory', side_effect=fail_after_publish):
            with self.assertRaises(OSError):
                installer.install(verified, release)
        self.assertTrue(destination.is_dir())
        runner.verify_release(destination)
        with self.assertRaises(ValueError):
            installer.install(verified, release)

    def test_write_failure_preserves_staging_without_installing_or_provisioning(self):
        files = dict(FILES, **{'new.js': b'new'})
        release, artifact, _ = builder.package(files)
        verified = installer.unpack(artifact, release)
        original_sync = os.fsync
        def fail_file_sync(fd):
            if stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError('FAKE_PRIVATE_IO')
            return original_sync(fd)
        with mock.patch.object(installer.os, 'fsync', side_effect=fail_file_sync):
            with self.assertRaises(OSError):
                installer.install(verified, release)
        self.assertFalse((self.base / 'releases' / release).exists())
        self.assertTrue((self.base / 'releases' / ('.staging-' + release)).is_dir())
        with self.assertRaises(FileExistsError):
            installer.install(verified, release)
        self.assertEqual(set(self.observer.iterdir()), {self.observer / '.observer.lock'})


if __name__ == '__main__':
    unittest.main()
