#!/usr/bin/env python3
"""Offline fixed worker and immutable-install tests; fake Docker only."""
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


runner = load('identity_fixed_runner', HERE / 'run-once')
builder = load('identity_release_builder', HERE / 'prepare-release.py')
installer = load('identity_release_installer', HERE / 'install-remote.py')
GOOD = {'schema': 1, 'mode': 'account-identity-readonly', 'reportWritten': True,
        'executable': False, 'identityEnrolled': False, 'requestCount': 2,
        'mexc': {'observed': True, 'mainAccountConfirmed': False},
        'okx': {'observed': True, 'mainAccountConfirmed': True},
        'receipt': {'schema': 1, 'kind': 'account-identity-observation-receipt',
                    'archiveId': '10000000-0000-4000-8000-000000000001', 'archiveHash': 'c' * 64}}
FILES = {'package.json': b'{"type":"module"}', 'run-once': (HERE / 'run-once').read_bytes(),
         'dist/scripts/account-identity.js': b'// synthetic unit fixture; never install remotely\n'}


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
args=sys.argv[1:];home=pathlib.Path(os.environ['FAKE_IDENTITY_DOCKER_HOME']);state=home/'container.json';log=home/'docker.jsonl'
record={'op':args[0]}
def emitlog():
 with log.open('a') as f:f.write(json.dumps(record)+'\n')
if args[0]=='run':
 cid='d'*64;labels={args[i+1].split('=',1)[0]:args[i+1].split('=',1)[1] for i,x in enumerate(args) if x=='--label'}
 raw=sys.stdin.buffer.read();record.update(stdinBytes=len(raw),network=[x for x in args if x.startswith('--network=')][0],mounts=[args[i+1] for i,x in enumerate(args) if x=='--mount']);emitlog()
 pathlib.Path(args[args.index('--cidfile')+1]).write_text(cid);os.chmod(args[args.index('--cidfile')+1],0o600)
 state.write_text(json.dumps({'cid':cid,'release':labels['crypto-account-identity.release'],'invocation':labels['crypto-account-identity.invocation']}));os.chmod(state,0o600)
 if os.environ.get('FAKE_DOCKER_HANG'):time.sleep(10)
 if os.environ.get('FAKE_DOCKER_FAILED'):print('{"schema":1,"error":"identity-failed"}');sys.exit(1)
 value={'schema':1,'mode':'account-identity-readonly','executable':False,'identityEnrolled':False,'reportWritten':True,'requestCount':2,'mexc':{'observed':True,'mainAccountConfirmed':False},'okx':{'observed':True,'mainAccountConfirmed':True},'receipt':{'schema':1,'kind':'account-identity-observation-receipt','archiveId':'10000000-0000-4000-8000-000000000001','archiveHash':'c'*64}}
 if os.environ.get('FAKE_DOCKER_PRIVATE_OUTPUT'):value['uid']='FAKE_PRIVATE_CANARY'
 if os.environ.get('FAKE_DOCKER_OVERSIZED_OUTPUT'):print('x'*4097);sys.exit(0)
 print(json.dumps(value));sys.exit(0)
if args[0]=='ps':
 emitlog()
 if os.environ.get('FAKE_DOCKER_DAEMON_DOWN') or (os.environ.get('FAKE_DOCKER_POST_RM_DOWN') and (home/'removed').exists()):sys.exit(1)
 if state.exists():print('d'*64)
 sys.exit(0)
if args[0]=='inspect':
 emitlog()
 if os.environ.get('FAKE_DOCKER_INSPECT_FAILED'):sys.exit(1)
 if not state.exists():sys.exit(1)
 value=json.loads(state.read_text());print(value['cid']+' '+('0'*64 if os.environ.get('FAKE_DOCKER_WRONG_RELEASE') else value['release'])+' '+('wrong-invocation' if os.environ.get('FAKE_DOCKER_WRONG_INVOCATION') else value['invocation']));sys.exit(0)
if args[0]=='rm':
 record['target']=args[-1];emitlog()
 if args[-1]!='d'*64:sys.exit(9)
 if os.environ.get('FAKE_DOCKER_REMOVE_FAILED'):sys.exit(1)
 state.unlink();(home/'removed').write_text('done');sys.exit(0)
sys.exit(4)
'''


class ContractTests(unittest.TestCase):
    def test_python36_syntax(self):
        for name in ('run-once', 'prepare-release.py', 'install-remote.py', 'verify-isolation.py'):
            ast.parse((HERE / name).read_text(), feature_version=(3, 6))

    def test_strict_metadata_cannot_return_private_identity_or_enable_execution(self):
        self.assertEqual(runner.decode_report(json.dumps(GOOD).encode()), GOOD)
        for field, invalid in [('schema', True), ('requestCount', 3), ('mode', 'other'),
                               ('executable', True), ('identityEnrolled', True), ('uid', 'FAKE_PRIVATE')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                runner.decode_report(json.dumps(dict(GOOD, **{field: invalid})).encode())
        for venue in ('mexc', 'okx', 'receipt'):
            bad = copy.deepcopy(GOOD); bad[venue]['uid'] = 'FAKE_PRIVATE'
            with self.assertRaises(ValueError):
                runner.decode_report(json.dumps(bad).encode())
        bad = copy.deepcopy(GOOD); bad['mexc']['mainAccountConfirmed'] = True
        with self.assertRaises(ValueError):
            runner.decode_report(json.dumps(bad).encode())
        for raw in (b'NaN', b'{"schema":1,"schema":1}', b'{}', b'x' * 4097):
            with self.assertRaises(ValueError):
                runner.decode_report(raw)

    def test_fixed_docker_scope(self):
        args = runner.docker_arguments(Path('/release') / ('a'*64), Path('/state/cid'), '10000000-0000-4000-8000-000000000001')
        for flag in ('--network=bridge', '--pull=never', '--read-only', '--log-driver=none', '--user=1002:27', '--cap-drop=ALL', '--ulimit=core=0'):
            self.assertIn(flag, args)
        self.assertIn(runner.IMAGE, args)
        self.assertEqual(args[-3:], ['node', '--disable-proto=throw', runner.ENTRYPOINT])
        mounts = [args[index + 1] for index, value in enumerate(args) if value == '--mount']
        self.assertEqual(len(mounts), 3)
        self.assertTrue(mounts[0].endswith('dst=/code,readonly'))
        self.assertTrue(mounts[1].endswith('dst=/state'))
        self.assertTrue(mounts[2].endswith('dst=/observer-state'))
        for prohibited in ('/var/run/docker.sock', '/request', '/journal', '--env', '--publish', '--privileged'):
            self.assertNotIn(prohibited, ' '.join(args))

    def test_reproducible_archive_and_hostile_tar_guards(self):
        release, raw, count = builder.package(FILES)
        self.assertEqual((release, raw, count), builder.package(FILES))
        self.assertEqual(set(installer.unpack(raw, release)), set(FILES) | {'manifest.json'})
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
        self.temp = tempfile.TemporaryDirectory(prefix='identity-runtime-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'crypto-account-identity'
        self.observer = self.root / 'observer-state'; self.observer.mkdir(mode=0o700)
        for name, raw in (('.observer.lock', b''), ('cooldowns.json', b'{"schema":1,"mexc":0,"okx":0}')):
            path = self.observer / name; path.write_bytes(raw); path.chmod(0o600)
        self.release, artifact, _ = builder.package(FILES)
        self.files = installer.unpack(artifact, self.release)
        for module in (runner, installer):
            for key, value in (('BASE', self.base), ('UID', os.getuid())):
                patch = mock.patch.object(module, key, value); patch.start(); self.addCleanup(patch.stop)
        patch = mock.patch.object(runner, 'OBSERVER_STATE', self.observer); patch.start(); self.addCleanup(patch.stop)
        result = installer.install(self.files, self.release)
        self.assertFalse(result['runtimeStarted']); self.assertFalse(result['identityEnrolled']); self.assertFalse(result['keysDelivered'])
        self.release_path = self.base / 'releases' / self.release
        self.docker = self.root / 'fake-docker'; self.docker.write_text(FAKE_DOCKER); self.docker.chmod(0o700)
        for key, value in (('DOCKER', str(self.docker)), ('__file__', str(self.release_path / 'run-once'))):
            patch = mock.patch.object(runner, key, value); patch.start(); self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, {'FAKE_IDENTITY_DOCKER_HOME': str(self.root)})
        env.start(); self.addCleanup(env.stop)

    def invoke(self, args=()):
        output = io.StringIO()
        with tempfile.TemporaryFile() as payload:
            payload.write(b'FAKE_PRIVATE_CREDENTIALS'); payload.seek(0)
            stdin = type('PrivateInput', (), {'buffer': payload})()
            with mock.patch.object(runner.sys, 'argv', [str(self.release_path / 'run-once')] + list(args)), mock.patch.object(runner.sys, 'stdin', stdin), contextlib.redirect_stdout(output):
                runner.main()
        return json.loads(output.getvalue())

    def logs(self):
        path = self.root / 'docker.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_installed_full_manifest_and_immutable_publication(self):
        runner.verify_release(self.release_path)
        for path in (self.base, self.base / 'releases', self.base / 'state', self.release_path):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        with self.assertRaises(ValueError):
            installer.install(self.files, self.release)
        extra = self.release_path / 'extra'; extra.write_bytes(b'x'); extra.chmod(0o600)
        with self.assertRaises(ValueError):
            runner.verify_release(self.release_path)
        extra.unlink(); extra.mkdir(mode=0o700)
        with self.assertRaises(ValueError):
            runner.verify_release(self.release_path)

    def test_observation_consumes_only_stdin_and_cleanup_proves_absence(self):
        self.assertEqual(self.invoke(), GOOD)
        runs = [row for row in self.logs() if row['op'] == 'run']
        self.assertEqual(len(runs), 1); self.assertEqual(runs[0]['stdinBytes'], len(b'FAKE_PRIVATE_CREDENTIALS'))
        self.assertEqual(runs[0]['network'], '--network=bridge')
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d'*64])
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual(list((self.base / 'state').iterdir()), [self.base / 'state' / '.identity.lock'])

    def test_no_caller_options_or_paths(self):
        for args in (('--preflight',), ('fake-path',), ('--url', 'https://example.invalid')):
            with self.assertRaises(ValueError): self.invoke(args)
        self.assertEqual(self.logs(), [])

    def test_cooldown_missing_invalid_duplicate_active_or_wrong_mode_fails_before_docker(self):
        path = self.observer / 'cooldowns.json'
        cases = [b'{"schema":1,"mexc":0,"okx":0,"mexc":0}', b'{"schema":true,"mexc":0,"okx":0}',
                 b'{"schema":1,"mexc":-1,"okx":0}', b'{"schema":1,"mexc":0.5,"okx":0}',
                 b'{"schema":1,"mexc":8640000000000001,"okx":0}', b'{"schema":1,"mexc":0,"okx":0,"extra":0}',
                 json.dumps({'schema':1,'mexc':int(time.time()*1000)+60000,'okx':0}).encode()]
        for raw in cases:
            path.write_bytes(raw)
            with self.assertRaises(ValueError): self.invoke()
        path.write_bytes(b'{"schema":1,"mexc":0,"okx":0}'); path.chmod(0o644)
        with self.assertRaises(ValueError): self.invoke()
        path.unlink()
        with self.assertRaises(FileNotFoundError): self.invoke()
        self.assertEqual(self.logs(), [])

    def test_failed_or_private_or_oversized_output_still_cleans_own_container(self):
        for option in ('FAKE_DOCKER_FAILED', 'FAKE_DOCKER_PRIVATE_OUTPUT', 'FAKE_DOCKER_OVERSIZED_OUTPUT'):
            with mock.patch.dict(os.environ, {option:'1'}), self.assertRaises(ValueError): self.invoke()
            self.assertFalse((self.root / 'container.json').exists())

    def test_foreign_release_or_invocation_label_never_removed(self):
        for option in ('FAKE_DOCKER_WRONG_RELEASE', 'FAKE_DOCKER_WRONG_INVOCATION'):
            with self.subTest(option=option), mock.patch.dict(os.environ, {option:'1'}), self.assertRaises(ValueError): self.invoke()
            self.assertTrue((self.root / 'container.json').exists())
            self.assertEqual([row for row in self.logs() if row['op'] == 'rm'], [])
            (self.root / 'container.json').unlink()

    def test_daemon_error_is_not_proof_of_absence(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_DAEMON_DOWN':'1'}), self.assertRaises(ValueError): self.invoke()
        self.assertEqual([row for row in self.logs() if row['op'] == 'run'], [])

    def test_failed_removal_preserves_cid_evidence(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_REMOVE_FAILED':'1'}), self.assertRaises(RuntimeError): self.invoke()
        self.assertTrue((self.root / 'container.json').exists())
        self.assertEqual(len(list((self.base / 'state').glob('.container-*'))), 1)

    def test_failed_inspection_preserves_unknown_container_and_cid(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_INSPECT_FAILED':'1'}), self.assertRaises(RuntimeError): self.invoke()
        self.assertTrue((self.root / 'container.json').exists())
        self.assertEqual([row for row in self.logs() if row['op'] == 'rm'], [])
        self.assertEqual(len(list((self.base / 'state').glob('.container-*'))), 1)

    def test_daemon_failure_after_exact_removal_does_not_claim_cleanup(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_POST_RM_DOWN':'1'}), self.assertRaises(RuntimeError): self.invoke()
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d'*64])
        self.assertEqual(len(list((self.base / 'state').glob('.container-*'))), 1)

    def test_both_locks_are_still_held_during_cleanup(self):
        original = runner.cleanup_container
        checked = []
        def check_locked(*args):
            for path in (self.observer / '.observer.lock', self.base / 'state' / '.identity.lock'):
                with self.assertRaises(BlockingIOError): runner.locked_file(path)
                checked.append(str(path))
            return original(*args)
        with mock.patch.object(runner, 'cleanup_container', check_locked):
            self.assertEqual(self.invoke(), GOOD)
        self.assertEqual(len(checked), 2)

    def test_timeout_cleans_exact_own_cid(self):
        with mock.patch.dict(os.environ, {'FAKE_DOCKER_HANG':'1'}), mock.patch.object(runner, 'RUN_SECONDS', 0.2), self.assertRaises(TimeoutError): self.invoke()
        self.assertFalse((self.root / 'container.json').exists())
        self.assertEqual([row['target'] for row in self.logs() if row['op'] == 'rm'], ['d'*64])

    def test_both_locks_prevent_any_docker(self):
        for path in (self.observer / '.observer.lock', self.base / 'state' / '.identity.lock'):
            with runner.locked_file(path, create=True), self.assertRaises(BlockingIOError): self.invoke()
        self.assertEqual(self.logs(), [])

    def test_existing_container_preserved(self):
        (self.root / 'container.json').write_text('{"unrelated":true}')
        with self.assertRaises(ValueError): self.invoke()
        self.assertEqual([row for row in self.logs() if row['op'] in ('run','rm')], [])
        self.assertTrue((self.root / 'container.json').exists())

    def test_mutated_code_hardlink_symlink_and_unsafe_mode_refused(self):
        path = self.release_path / 'package.json'; original = path.read_bytes()
        path.write_bytes(original+b' ')
        with self.assertRaises(ValueError): self.invoke()
        path.write_bytes(original); path.chmod(0o644)
        with self.assertRaises(ValueError): self.invoke()
        path.chmod(0o600); peer = self.root / 'alias'; os.link(str(path), str(peer))
        with self.assertRaises(ValueError): self.invoke()
        peer.unlink(); path.unlink(); path.symlink_to(peer)
        with self.assertRaises(OSError): self.invoke()
        self.assertEqual(self.logs(), [])


if __name__ == '__main__':
    unittest.main()
