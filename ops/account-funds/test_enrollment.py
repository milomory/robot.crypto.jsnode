"""Offline explicit binding enrollment is a separate fixed no-network consumer."""
import ast
import contextlib
import copy
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest import mock

HERE=Path(__file__).resolve().parent

def module(name,filename):
    loader=importlib.machinery.SourceFileLoader(name,str(HERE/filename));spec=importlib.util.spec_from_loader(name,loader)
    value=importlib.util.module_from_spec(spec);loader.exec_module(value);return value

runner=module('funds_enrollment_runner','run-enroll')
bridge=module('funds_enrollment_bridge','enrollment-bridge.py')
controller=module('funds_enrollment_controller','run-enrollment-once.py')
fixtures=module('funds_enrollment_fixtures','test_runtime.py')
GOOD={'schema':1,'mode':'account-binding-enrollment','pinWritten':True,'selectionBound':True,'identityEnrolled':False,'executable':False,'requestCount':0}

class EnrollmentContracts(unittest.TestCase):
    def test_exact_results_no_private_fields_or_trading_authority(self):
        for function in (runner.decode_report,bridge.decode_report):
            self.assertEqual(function(json.dumps(GOOD).encode()),GOOD)
            for key,value in [('schema',True),('requestCount',True),('requestCount',1),('identityEnrolled',True),('executable',True),('uid','FAKE_UID'),('selection','PRIVATE')]:
                with self.subTest(key=key),self.assertRaises(ValueError):function(json.dumps(dict(GOOD,**{key:value})).encode())
            with self.assertRaises(ValueError):function(json.dumps(fixtures.GOOD).encode())
        self.assertEqual(bridge.decode_report(json.dumps(bridge.FAILURE).encode()),bridge.FAILURE)
        with self.assertRaises(ValueError):bridge.decode_report(b'{"schema":true,"error":"funds-failed"}')

    def test_no_network_exact_enrollment_entrypoint_only_binding_writable(self):
        args=runner.docker_arguments(Path('/release')/('a'*64),Path('/cid'),'invocation')
        self.assertIn('--network=none',args);self.assertNotIn('--network=bridge',args)
        mounts=[args[i+1] for i,v in enumerate(args) if v=='--mount']
        self.assertEqual(len(mounts),4);self.assertTrue(mounts[0].endswith('/code,readonly'));self.assertTrue(mounts[1].endswith('/state,readonly'))
        self.assertTrue(mounts[2].endswith('/binding'));self.assertTrue(mounts[3].endswith('/observer-state,readonly'))
        self.assertEqual(args[-1],'dist/scripts/account-funds-enroll.js')
        self.assertEqual(runner.NAME,'crypto-account-funds-enrollment')
        self.assertEqual(runner.RUN_SECONDS,45)

    def test_fixed_separate_profiles_and_verified_entrypoint(self):
        self.assertEqual(controller.PARTS, module('funds_capture_controller_compare','run-funds-once.py').PARTS)
        records={ref:{'backend':'sops-age','backend_id':'fake-'+part,'status':'active'} for part,ref in controller.PARTS}
        registry=controller.scoped_registry(records)
        self.assertEqual(len(registry['profiles']),3)
        for part,ref in controller.PARTS:
            selected=registry['profiles'][controller.PROFILE+'-'+part]
            self.assertEqual(selected['allowed_refs'],[ref]);self.assertIn('enrollment',selected['allowed_destinations'][0]);self.assertIn('enrollment',selected['executable'])
        command=shlex.split(bridge.verification_command({'schema':1,'release':'a'*64,'manifestSha256':'a'*64}))
        self.assertIn("os.execv(root+'/run-enroll',[root+'/run-enroll'])",command[-1])
        self.assertIn("BASE = '/home/mil/crypto-account-funds/releases'",command[-1])
        self.assertNotIn("os.execv(root+'/run-once'",command[-1])
        for name in ('run-enroll','enrollment-bridge.py','run-enrollment-once.py'):
            ast.parse((HERE/name).read_text(),feature_version=(3,6))
        ast.parse(command[-1],feature_version=(3,6))

class EnrollmentRuntime(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='funds-enroll-test-');self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);self.base=self.root/'funds';self.observer=self.root/'observer';self.observer.mkdir(mode=0o700)
        for name,raw in (('.observer.lock',b''),('cooldowns.json',b'{"schema":1,"mexc":0,"okx":0}')):
            p=self.observer/name;p.write_bytes(raw);p.chmod(0o600)
        for value in (runner,fixtures.installer):
            for key,target in (('BASE',self.base),('UID',os.getuid())):
                patch=mock.patch.object(value,key,target);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(runner,'OBSERVER_STATE',self.observer);patch.start();self.addCleanup(patch.stop)
        self.release,raw,_=fixtures.builder.package(fixtures.FILES);fixtures.installer.install(fixtures.installer.unpack(raw,self.release),self.release)
        (self.base/'binding').mkdir(mode=0o700);self.release_path=self.base/'releases'/self.release
        fake=fixtures.FAKE_DOCKER.replace(' value='+repr(fixtures.GOOD),' value='+repr(GOOD))
        self.assertNotEqual(fake,fixtures.FAKE_DOCKER)
        self.docker=self.root/'fake-docker';self.docker.write_text(fake);self.docker.chmod(0o700)
        for key,target in (('DOCKER',str(self.docker)),('__file__',str(self.release_path/'run-enroll'))):
            patch=mock.patch.object(runner,key,target);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.dict(os.environ,{'FAKE_IDENTITY_DOCKER_HOME':str(self.root)});patch.start();self.addCleanup(patch.stop)

    def invoke(self,args=()):
        output=io.StringIO()
        with tempfile.TemporaryFile() as data:
            data.write(b'FAKE_CREDENTIAL_ENROLLMENT');data.seek(0);stdin=type('Input',(),{'buffer':data})()
            with mock.patch.object(runner.sys,'argv',[str(self.release_path/'run-enroll')]+list(args)),mock.patch.object(runner.sys,'stdin',stdin),contextlib.redirect_stdout(output):runner.main()
        return json.loads(output.getvalue())

    def logs(self):
        path=self.root/'docker.jsonl';return [json.loads(row) for row in path.read_text().splitlines()] if path.exists() else []

    def test_success_exact_cleanup_only_stdin_credentials(self):
        self.assertEqual(self.invoke(),GOOD)
        rows=[row for row in self.logs() if row['op']=='run'];self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['network'],'--network=none');self.assertEqual(rows[0]['stdinBytes'],len(b'FAKE_CREDENTIAL_ENROLLMENT'))
        self.assertEqual([row['target'] for row in self.logs() if row['op']=='rm'],['d'*64])
        self.assertFalse((self.root/'container.json').exists())

    def test_no_caller_override_and_both_locks_guard_enrollment(self):
        with self.assertRaises(ValueError):self.invoke(('--capture',))
        for path in (self.observer/'.observer.lock',self.base/'state'/'.funds.lock'):
            with runner.locked_file(path,create=True),self.assertRaises(BlockingIOError):self.invoke()
        self.assertEqual(self.logs(),[])

    def test_private_output_or_wrong_invocation_refused(self):
        with mock.patch.dict(os.environ,{'FAKE_DOCKER_PRIVATE_OUTPUT':'1'}),self.assertRaises(ValueError):self.invoke()
        self.assertFalse((self.root/'container.json').exists())
        with mock.patch.dict(os.environ,{'FAKE_DOCKER_WRONG_INVOCATION':'1'}),self.assertRaises(ValueError):self.invoke()
        self.assertTrue((self.root/'container.json').exists())

if __name__=='__main__':unittest.main()
