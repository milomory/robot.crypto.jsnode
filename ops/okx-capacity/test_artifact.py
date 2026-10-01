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
spec = importlib.util.spec_from_file_location('capacity_artifact_builder', HERE / 'prepare-release.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuiltArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = builder.build_files()

    def test_minimal_build_resolves_and_refuses_before_network_or_credentials(self):
        files = self.files
        for name in ('dist/accounts/okx-capacity-main.js', 'dist/accounts/okx-capacity-runtime.js', 'check-installed.py'):
            self.assertIn(name, files)
        for name in ('dist/server.js', 'dist/scripts/pair-observer.js', 'dist/scripts/protected-order-recovery.js'):
            self.assertNotIn(name, files)
        self.assertFalse(any(name.startswith('dist/live/') or name.endswith('.env') for name in files))
        self.assertTrue(all(not name.startswith('node_modules/') or name.startswith('node_modules/zod/') for name in files))
        with tempfile.TemporaryDirectory(prefix='capacity-built-negative-') as temporary:
            root = Path(temporary)
            for name, raw in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw); path.chmod(0o600)
            for entry_name in ('okx-capacity-main.js',):
                entry = str(root / 'dist/accounts' / entry_name)
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
                self.assertEqual(json.loads(result.stdout), {'schema': 1, 'error': 'capacity-failed'})



if __name__ == '__main__':
    unittest.main()
