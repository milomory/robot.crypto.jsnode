"""Offline narrow broker result/pin/profile tests. No secrets, remote calls or mutations."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import shlex
import types
import unittest
from unittest import mock

HERE=Path(__file__).resolve().parent

def module(name, filename):
    spec=importlib.util.spec_from_file_location(name,str(HERE/filename))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

bridge=module('identity_bridge_test','funds-bridge.py')
controller=module('identity_controller_test','run-funds-once.py')
PIN={'schema':1,'release':'a'*64,'manifestSha256':'a'*64}
REPORT={'schema': 1, 'mode': 'account-funds-readonly', 'reportWritten': True, 'executable': False, 'identityEnrolled': True, 'fundsBound': True, 'fundsAdmission': False, 'requestCount': 4, 'mexc': {'observed': True, 'identityMatched': True, 'mainAccountConfirmed': False}, 'okx': {'observed': True, 'identityMatched': True, 'mainAccountConfirmed': True}, 'receipt': {'schema': 1, 'kind': 'account-funds-observation-receipt', 'archiveId': '10000000-0000-4000-8000-000000000001', 'archiveHash': 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'}}

def raw(value):return json.dumps(value).encode()

class Reports(unittest.TestCase):
    def test_exact_projection_and_subaccount_observation_only(self):
        self.assertEqual(bridge.decode_report(raw(REPORT)),REPORT)
        value=copy.deepcopy(REPORT);value['okx']['mainAccountConfirmed']=False
        with self.assertRaises(ValueError):bridge.decode_report(raw(value))
        self.assertEqual(bridge.decode_report(raw(bridge.FAILURE)),bridge.FAILURE)

    def test_private_and_unexpected_nested_data_rejected(self):
        for target in ('root','mexc','okx','receipt'):
            for key in ('uid','apiKey','url','headers','unknown'):
                value=copy.deepcopy(REPORT);(value if target=='root' else value[target])[key]='FAKE_PRIVATE'
                with self.subTest(target=target,key=key), self.assertRaises(ValueError):bridge.decode_report(raw(value))

    def test_booleans_counts_and_authority_cannot_be_upgraded(self):
        changes=[('schema',True),('identityEnrolled',False),('executable',True),('reportWritten',1),
                 ('requestCount',True),('requestCount',3),('requestCount',2.0),('mode','orders')]
        for key,value in changes:
            report=copy.deepcopy(REPORT);report[key]=value
            with self.subTest(key=key), self.assertRaises(ValueError):bridge.decode_report(raw(report))
        for venue in ('mexc','okx'):
            for key in ('observed','mainAccountConfirmed'):
                report=copy.deepcopy(REPORT);report[venue][key]=1
                with self.assertRaises(ValueError):bridge.decode_report(raw(report))
        report=copy.deepcopy(REPORT);report['mexc']['mainAccountConfirmed']=True
        with self.assertRaises(ValueError):bridge.decode_report(raw(report))

    def test_duplicate_large_nonfinite_and_receipt_injection(self):
        for value in (b'',b'x'*4097,b'{"schema":1,"schema":1,"error":"funds-failed"}',b'{"schema":NaN}'):
            with self.assertRaises(ValueError):bridge.decode_report(value)
        for key,bad in [('archiveId','../../secret'),('archiveHash','b'*65),('schema',True),('kind','other')]:
            report=copy.deepcopy(REPORT);report['receipt'][key]=bad
            with self.assertRaises(ValueError):bridge.decode_report(raw(report))

    def test_even_allowlisted_output_guard_rejects_credential_collision(self):
        with self.assertRaises(ValueError):bridge.safe_output(raw(REPORT),('c'*64,))
        self.assertEqual(bridge.safe_output(raw(REPORT),('FAKE_SECRET_UNIQUE',))[0],REPORT)

class Delivery(unittest.TestCase):
    def test_only_three_exact_refs_and_fixed_destinations(self):
        records={ref:{'status':'active','backend':'sops-age','backend_id':'fake-'+part,'description':'EXCLUDE'}
                 for part,ref in controller.PARTS}
        selected=controller.scoped_registry(records)
        self.assertEqual(set(selected['secrets']),set(records))
        self.assertEqual(len(selected['profiles']),3)
        self.assertNotIn('EXCLUDE',json.dumps(selected))
        for part,ref in controller.PARTS:
            profile=selected['profiles'][controller.PROFILE+'-'+part]
            self.assertEqual(profile['allowed_refs'],[ref])
            self.assertEqual(profile['allowed_destinations'],[controller.DESTINATION+'-'+part])
            self.assertEqual(profile['executable'],str(controller.BRIDGE))
            self.assertEqual(profile['injection'],'stdin')

    def test_pin_hashes_and_no_arbitrary_paths(self):
        self.assertEqual(bridge.parse_pin(PIN),PIN)
        for update in ({'release':'../elsewhere'},{'schema':True},{'manifestSha256':'b'*64},{'venue':'mexc'},{'path':'/tmp/x'}):
            with self.assertRaises(ValueError):bridge.verification_command(dict(PIN,**update))
        argv=shlex.split(bridge.verification_command(PIN,True))
        self.assertEqual(argv[:3],['/usr/bin/python3','-I','-c'])
        ast.parse(argv[-1],feature_version=(3,6));self.assertIn('PREFLIGHT = True',argv[-1])

    def test_bad_preflight_never_acknowledged(self):
        good={'schema':1,'release':PIN['release'],'manifestVerified':True}
        for result in [types.SimpleNamespace(returncode=1,stdout=raw(good)),
                types.SimpleNamespace(returncode=0,stdout=raw(dict(good,release='b'*64))),
                types.SimpleNamespace(returncode=0,stdout=raw(dict(good,uid='FAKE_PRIVATE'))),
                types.SimpleNamespace(returncode=0,stdout=b'{"schema":1,"schema":1}')]:
            with mock.patch.object(controller,'command',return_value=result) as command:
                with self.assertRaises((RuntimeError,ValueError)):controller.verify_remote_release(bridge,PIN)
                self.assertEqual(command.call_count,1)
                self.assertNotIn('secretctl',str(command.call_args))

    def test_preflight_verified_before_secret_service(self):
        source=(HERE/'run-funds-once.py').read_text()
        self.assertLess(source.index('verify_remote_release(report_module'),source.index("ROOT.mkdir(mode=0o700)"))
        with mock.patch.object(controller,'command',return_value=types.SimpleNamespace(returncode=0,stdout=raw({'schema':1,'release':PIN['release'],'manifestVerified':True}))):
            controller.verify_remote_release(bridge,PIN)

    def test_all_python_including_embedded_verifier_supports_hyperion36(self):
        for path in [HERE/'funds-bridge.py',HERE/'run-funds-once.py']:
            ast.parse(path.read_text(),feature_version=(3,6))
        self.assertLess(45+10,80)
        self.assertIn('timeout=80', (HERE/'funds-bridge.py').read_text())
        self.assertIn('signal.alarm(150)', (HERE/'run-funds-once.py').read_text())

if __name__=='__main__':unittest.main()
