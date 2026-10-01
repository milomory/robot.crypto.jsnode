#!/usr/bin/env python3
"""Real minimal build + no-key CLI refusal, entirely local and network trapped."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('identity_artifact_builder', HERE / 'prepare-release.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuiltArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = builder.build_files()

    def test_minimal_build_resolves_and_refuses_before_network_or_credentials(self):
        files = self.files
        for name in ('dist/scripts/account-funds.js', 'dist/accounts/account-funds-runtime.js', 'dist/scripts/account-funds-enroll.js'):
            self.assertIn(name, files)
        for name in ('dist/server.js', 'dist/scripts/pair-observer.js', 'dist/scripts/protected-order-recovery.js'):
            self.assertNotIn(name, files)
        self.assertFalse(any(name.startswith('dist/live/') or name.endswith('.env') for name in files))
        self.assertTrue(all(not name.startswith('node_modules/') or name.startswith('node_modules/zod/') for name in files))
        with tempfile.TemporaryDirectory(prefix='identity-built-negative-') as temporary:
            root = Path(temporary)
            for name, raw in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw); path.chmod(0o600)
            for entry_name in ('account-funds.js', 'account-funds-enroll.js'):
                entry = str(root / 'dist/scripts' / entry_name)
                probe = """
    import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
    import {syncBuiltinESMExports} from 'node:module';
    const blocked=()=>{process.stderr.write('UNEXPECTED_NETWORK');throw Error('UNEXPECTED_NETWORK');};
    globalThis.fetch=blocked;net.connect=blocked;net.createConnection=blocked;tls.connect=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;syncBuiltinESMExports();
    const oldOn=process.stdin.on.bind(process.stdin);process.stdin.on=(type,...args)=>{if(type==='data'){process.stderr.write('UNEXPECTED_CREDENTIAL_READ');throw Error('UNEXPECTED_CREDENTIAL_READ');}return oldOn(type,...args);};
    process.argv=[process.execPath,ENTRY];
    await import(ENTRY);
    """.replace('ENTRY', json.dumps(entry))
                result = subprocess.run(['node', '--input-type=module', '-e', probe], input=b'FAKE_UNUSED_CREDENTIALS',
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=temporary, timeout=10)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, b'')
                self.assertEqual(json.loads(result.stdout), {'schema': 1, 'error': 'funds-failed'})


    def test_python_selection_and_actual_node_enrollment_roundtrip_without_network(self):
        spec = importlib.util.spec_from_file_location('funds_cross_language_selection', HERE / 'test_selection.py')
        fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
        harness = fixtures.Selection('test_atomic_private_selection_exact_prior_identity_and_random_key_not_output')
        harness.setUp(); self.addCleanup(harness.doCleanups)
        release, archive, _ = builder.package(self.files)
        fixtures.fixtures.installer.install(fixtures.fixtures.installer.unpack(archive, release), release)
        fixtures.selector.select(release)
        observer = harness.root / 'observer'; observer.mkdir(mode=0o700)
        cooldown = observer / 'cooldowns.json'; cooldown.write_text('{"schema":1,"mexc":0,"okx":0}'); cooldown.chmod(0o600)
        root = harness.base / 'releases' / release
        paths = {'archive':str(harness.base/'state'),'observer':str(observer),'binding':str(harness.base/'binding'),
                 'manifest':str(root/'manifest.json')}
        source = r"""
import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{process.stderr.write('UNEXPECTED_NETWORK');throw Error('UNEXPECTED_NETWORK');};
globalThis.fetch=blocked;net.connect=blocked;net.createConnection=blocked;tls.connect=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;syncBuiltinESMExports();
const runtime=await import(ENTRY),paths=PATHS;
await runtime.preflightAccountFundsEnrollment(paths);
const frame={schema:1,mexc:{schema:1,venue:'mexc',environment:'mainnet',region:'global',apiKey:'fake-mexc-key',apiSecret:'fake-mexc-secret'},
 okx:{schema:1,venue:'okx',environment:'mainnet',region:'global',apiKey:'fake-okx-key',apiSecret:'fake-okx-secret',passphrase:'fake-passphrase'}};
const first=await runtime.executeAccountFundsEnrollment(Buffer.from(JSON.stringify(frame)),{paths,fetch:blocked});
if(!first.success)throw Error('ENROLLMENT_FAILED');
await runtime.preflightAccountFunds(paths);
const second=await runtime.executeAccountFundsEnrollment(Buffer.from(JSON.stringify(frame)),{paths,fetch:blocked});
if(second.success)throw Error('ENROLLMENT_REPEATED');
process.stdout.write(JSON.stringify({schema:1,enrolled:first.success,repeatRefused:!second.success,preflightPassed:true,networkCalls:0})+'\n');
""".replace('ENTRY',json.dumps(str(root/'dist/accounts/account-funds-runtime.js'))).replace('PATHS',json.dumps(paths))
        result = subprocess.run(['node','--input-type=module','-e',source],stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr.decode())
        self.assertEqual(result.stderr,b'')
        self.assertEqual(json.loads(result.stdout),{'schema':1,'enrolled':True,'repeatRefused':True,'preflightPassed':True,'networkCalls':0})
        info=(harness.base/'binding'/'pin.json').stat()
        self.assertEqual(info.st_nlink,1);self.assertEqual(info.st_mode & 0o777,0o600)


if __name__ == '__main__':
    unittest.main()
