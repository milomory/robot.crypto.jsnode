"""Offline selection proves exact old-receipt binding, never implicit first trust."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(HERE / filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value

selector = module('funds_selection', 'select-identity.py')
fixtures = module('funds_selection_fixtures', 'test_runtime.py')

class Selection(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='funds-selection-test-'); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name); self.base = self.root / 'funds'; self.identity = self.root / 'identity'
        self.identity.mkdir(mode=0o700); (self.identity / 'state').mkdir(mode=0o700)
        for m in (selector, fixtures.installer):
            for key, value in (('BASE', self.base), ('UID', os.getuid())):
                patch = mock.patch.object(m, key, value); patch.start(); self.addCleanup(patch.stop)
        patch = mock.patch.object(selector, 'IDENTITY_BASE', self.identity); patch.start(); self.addCleanup(patch.stop)
        self.release, raw, _ = fixtures.builder.package(fixtures.FILES)
        fixtures.installer.install(fixtures.installer.unpack(raw, self.release), self.release)
        self.report = {'schema':1,'kind':'account-identity-observation','archiveId':selector.ARCHIVE_ID,'startedAt':1000,'endedAt':1100,
            'environment':'mainnet','identityEnrolled':False,'fundsBound':False,'executable':False,'requestCount':2,
            'mexc':{'venue':'mexc','uid':'FAKE-OPAQUE:"\\UID','mainUid':None,'accountType':None,'mainAccountConfirmed':False,
                    'mainAccountEvidence':'not-reported','source':'/api/v3/uid','requestedAt':1000,'receivedAt':1020},
            'okx':{'venue':'okx','uid':'900000000000000001','mainUid':'900000000000000001','accountType':'0','mainAccountConfirmed':True,
                    'mainAccountEvidence':'uid-mainUid-and-account-type','source':'/api/v5/account/config','requestedAt':1020,'receivedAt':1100}}
        self.archive = self.identity / 'state' / ('identity-' + selector.ARCHIVE_ID + '.json')
        self.set_archive(self.report)

    def set_archive(self, report):
        raw = (json.dumps(report, separators=(',', ':')) + '\n').encode(); self.archive.write_bytes(raw); self.archive.chmod(0o600)
        patch = mock.patch.object(selector, 'ARCHIVE_HASH', hashlib.sha256(raw).hexdigest()); patch.start(); self.addCleanup(patch.stop)

    def test_atomic_private_selection_exact_prior_identity_and_random_key_not_output(self):
        result = selector.select(self.release)
        self.assertTrue(result['selectionWritten']); self.assertFalse(result['identityEnrolled']); self.assertEqual(result['requestCount'], 0)
        binding = self.base / 'binding'; selected = json.loads((binding / 'selection.json').read_bytes())
        self.assertEqual(selected['sourceHash'], self.release)
        self.assertEqual(selected['identities'], {venue:self.report[venue] for venue in ('mexc','okx')})
        self.assertEqual(selected['selection']['receipt']['archiveHash'], selector.ARCHIVE_HASH)
        self.assertEqual(selected['selection']['receipt']['archiveId'], selector.ARCHIVE_ID)
        self.assertEqual((binding/'selection.json').read_bytes(), (json.dumps(selected,separators=(',',':'),ensure_ascii=False)+'\n').encode())
        self.assertEqual(len((binding / 'binding-key').read_bytes()), 32)
        self.assertEqual(stat.S_IMODE(binding.stat().st_mode), 0o700)
        for name in ('selection.json','binding-key'):
            info=(binding/name).stat();self.assertEqual(stat.S_IMODE(info.st_mode),0o600);self.assertEqual(info.st_nlink,1)
        self.assertNotIn('FAKE', json.dumps(result)); self.assertNotIn('900000', json.dumps(result)); self.assertFalse((binding/'pin.json').exists())
        with self.assertRaises(ValueError): selector.select(self.release)
        self.assertEqual(json.loads((binding / 'selection.json').read_bytes()), selected)

    def test_newest_archive_never_selected_or_created_from_current_credentials(self):
        newer = self.identity / 'state' / 'identity-ffffffff-ffff-ffff-ffff-ffffffffffff.json'
        newer.write_text('FAKE_OTHER'); newer.chmod(0o600); self.archive.unlink()
        with self.assertRaises(FileNotFoundError): selector.select(self.release)
        self.assertFalse((self.base/'binding').exists())

    def test_wrong_old_archive_hash_is_rejected(self):
        self.archive.write_bytes(self.archive.read_bytes()+b' ')
        with self.assertRaises(ValueError): selector.select(self.release)
        self.assertFalse((self.base/'binding').exists())

    def test_missing_or_extra_private_fields_and_unsafe_timings_not_normalized(self):
        changes=[('schema',True),('requestCount',True),('identityEnrolled',True),('fundsBound',True),('executable',True),
                 ('endedAt',1000+20000),('startedAt',True),('archiveId','other'),('environment','testnet'),('extra','PRIVATE')]
        for key,value in changes:
            with self.subTest(key=key):
                altered=copy.deepcopy(self.report);altered[key]=value;self.set_archive(altered)
                with self.assertRaises(ValueError):selector.select(self.release)
                self.assertFalse((self.base/'binding').exists())

    def test_identity_mismatch_subaccount_unknown_key_or_private_extras_refused(self):
        cases=[('mexc','uid',''),('mexc','uid','BAD\nUID'),('mexc','uid',123),('mexc','uid','АБВ'),('mexc','mainAccountConfirmed',True),
               ('okx','mainUid','1'),('okx','accountType','1'),('okx','mainAccountConfirmed',False),('okx','requestedAt',1019),
               ('mexc','source','/api/v3/account'),('okx','apiKey','FAKE_SECRET')]
        for venue,key,value in cases:
            with self.subTest(venue=venue,key=key):
                altered=copy.deepcopy(self.report);altered[venue][key]=value;self.set_archive(altered)
                with self.assertRaises(ValueError):selector.select(self.release)

    def test_private_archive_permissions_links_and_directories_required(self):
        self.archive.chmod(0o644)
        with self.assertRaises(ValueError):selector.select(self.release)
        self.archive.chmod(0o600);linked=self.archive.with_suffix('.backup');os.link(self.archive,linked)
        with self.assertRaises(ValueError):selector.select(self.release)
        linked.unlink();raw=self.archive.read_bytes();self.archive.unlink();linked.write_bytes(raw);linked.chmod(0o600);self.archive.symlink_to(linked)
        with self.assertRaises(OSError):selector.select(self.release)
        self.archive.unlink();self.archive.write_bytes(raw);self.archive.chmod(0o600);(self.identity/'state').chmod(0o755)
        with self.assertRaises(ValueError):selector.select(self.release)

    def test_existing_directory_or_partial_staging_never_replaced(self):
        staging=self.base/'.binding-staging';staging.mkdir(mode=0o700);marker=staging/'marker';marker.write_text('KEEP')
        with self.assertRaises(ValueError):selector.select(self.release)
        self.assertEqual(marker.read_text(),'KEEP');self.assertFalse((self.base/'binding').exists())

    def test_failed_key_write_retains_private_staging_but_publishes_nothing(self):
        original=selector.write_exclusive
        def fail_key(path,raw):
            if path.name=='binding-key':raise OSError()
            return original(path,raw)
        with mock.patch.object(selector,'write_exclusive',side_effect=fail_key),self.assertRaises(OSError):selector.select(self.release)
        self.assertTrue((self.base/'.binding-staging'/'selection.json').exists());self.assertFalse((self.base/'binding').exists())
        with self.assertRaises(ValueError):selector.select(self.release)

    def test_installed_release_integrity_checked_before_archive_read(self):
        target=self.base/'releases'/self.release/'run-enroll';target.write_bytes(b'changed')
        with self.assertRaises(ValueError):selector.select(self.release)
        self.assertFalse((self.base/'binding').exists())

    def test_python36_and_no_external_calls(self):
        source=(HERE/'select-identity.py').read_text();ast.parse(source,feature_version=(3,6))
        for prohibited in ('subprocess','requests','urllib','socket','apiKey','apiSecret','passphrase'):
            self.assertNotIn(prohibited,source)
        self.assertIn("ARCHIVE_ID = 'a9b927eb-a844-47f2-8cfd-1229c42bc0e9'",source)
        self.assertIn("ARCHIVE_HASH = '139c971fbeb5277d32ab1c44e7178687dd4d8769074407a80fd15b1cbf6127e6'",source)

if __name__=='__main__':unittest.main()
