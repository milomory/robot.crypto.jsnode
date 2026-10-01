"""Offline immutable-UI installer checks; fixture paths only, no runtime changes."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name('install-dashboard-ui.py')
spec = importlib.util.spec_from_file_location('dashboard_ui_installer_offline', str(SOURCE))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
REVISION = 'a' * 40
PRIVATE_ERROR = 'synthetic-sensitive-exception-input'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def tar(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, raw, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(raw) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = '/outside/never-write'
            archive.addfile(member, io.BytesIO(raw) if member.isfile() else None)
    return output.getvalue()


def bundle(files=None, manifest_mutation=None, extra=()):
    files = files if files is not None else {
        'dist/index.html': b'<!doctype html><div>offline fixture</div>',
        'dist/assets/index-fixture.js': b'console.log("fixture")',
        'dist/assets/index-fixture.css': b'body{color:white}',
    }
    manifest = {'schema': 1, 'sourceRevision': REVISION,
                'files': {name: sha(raw) for name, raw in files.items()}}
    if manifest_mutation:
        manifest_mutation(manifest)
    raw = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode('ascii')
    entries = [(name, value, tarfile.REGTYPE) for name, value in files.items()]
    entries.append(('manifest.json', raw, tarfile.REGTYPE))
    entries.extend(extra)
    return tar(entries), sha(raw), dict(files, **{'manifest.json': raw})


class UnpackTests(unittest.TestCase):
    def test_exact_manifest_accepts_only_expected_bytes(self):
        data, digest, expected = bundle()
        self.assertEqual(installer.unpack(data, REVISION, digest), expected)

    def test_path_escape_absolute_nested_and_non_asset_members_rejected(self):
        names = ['../outside', '/dist/assets/evil.js', 'dist/../outside',
                 'dist/assets/../evil.js', 'dist/assets/nested/evil.js',
                 '.env', 'dist/server.js', 'src/config.ts', 'dist/assets/secret.env']
        for name in names:
            with self.subTest(name=name):
                data, digest, _ = bundle(extra=[(name, b'never-write', tarfile.REGTYPE)])
                with self.assertRaises(ValueError):
                    installer.unpack(data, REVISION, digest)

    def test_symlink_hardlink_directory_and_device_rejected(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.CHRTYPE]:
            with self.subTest(kind=kind):
                data, digest, _ = bundle(extra=[('dist/assets/link.js', b'', kind)])
                with self.assertRaises(ValueError):
                    installer.unpack(data, REVISION, digest)

    def test_duplicate_member_rejected_even_when_bytes_match(self):
        data, digest, expected = bundle()
        duplicate = ('dist/index.html', expected['dist/index.html'], tarfile.REGTYPE)
        data, digest, _ = bundle(extra=[duplicate])
        with self.assertRaises(ValueError):
            installer.unpack(data, REVISION, digest)

    def test_wrong_manifest_digest_or_revision_rejected(self):
        data, digest, _ = bundle()
        for revision, supplied in [(REVISION, '0' * 64), ('b' * 40, digest),
                                   ('../outside', digest), (REVISION, 'not-a-hash')]:
            with self.subTest(revision=revision, digest=supplied):
                with self.assertRaises(ValueError):
                    installer.unpack(data, revision, supplied)

    def test_file_hash_and_exact_file_set_are_enforced(self):
        mutations = [
            lambda m: m['files'].update({'dist/index.html': '0' * 64}),
            lambda m: m['files'].pop('dist/index.html'),
            lambda m: m['files'].update({'dist/assets/absent.js': '0' * 64}),
            lambda m: m.update({'extra': True}),
            lambda m: m.update({'schema': 2}),
        ]
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index):
                data, digest, _ = bundle(manifest_mutation=mutation)
                with self.assertRaises(ValueError):
                    installer.unpack(data, REVISION, digest)

    def test_missing_html_or_manifest_rejected(self):
        data, digest, _ = bundle(files={'dist/assets/index.js': b'x'})
        with self.assertRaises(ValueError):
            installer.unpack(data, REVISION, digest)
        with self.assertRaises(KeyError):
            installer.unpack(tar([('dist/index.html', b'x', tarfile.REGTYPE)]), REVISION, '0' * 64)

    def test_declared_oversized_member_rejected_before_extract(self):
        member = tarfile.TarInfo('dist/assets/big.js')
        member.size = 8 * 1024 * 1024 + 1
        import gzip
        data = gzip.compress(member.tobuf() + b'\0' * 1024)
        with self.assertRaises(ValueError):
            installer.unpack(data, REVISION, '0' * 64)

    def test_truncated_member_size_mismatch_rejected(self):
        member = tarfile.TarInfo('dist/index.html')
        member.size = 2048
        import gzip
        data = gzip.compress(member.tobuf() + b'incomplete-body')
        with self.assertRaises(tarfile.ReadError):
            installer.unpack(data, REVISION, '0' * 64)

    def test_archive_size_total_size_file_count_and_manifest_bounds(self):
        with self.assertRaises(ValueError):
            installer.unpack(b'\0' * (32 * 1024 * 1024 + 1), REVISION, '0' * 64)
        data, digest, _ = bundle(files={
            'dist/assets/large-%d.js' % i: b'x' * (8 * 1024 * 1024) for i in range(5)})
        with self.assertRaises(ValueError):
            installer.unpack(data, REVISION, digest)
        data, digest, _ = bundle(files={
            'dist/assets/tiny-%d.js' % i: b'x' for i in range(257)})
        with self.assertRaises(ValueError):
            installer.unpack(data, REVISION, digest)
        raw = b'x' * (128 * 1024 + 1)
        data = tar([('manifest.json', raw, tarfile.REGTYPE)])
        with self.assertRaises(ValueError):
            installer.unpack(data, REVISION, sha(raw))


class InstallTests(unittest.TestCase):
    def setUp(self):
        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        self.directory = tempfile.TemporaryDirectory(prefix='crypto-ui-install-test-')
        self.root = Path(self.directory.name).resolve()
        self.base = self.root / 'ui-releases'
        self.base_patch = mock.patch.object(installer, 'BASE', self.base)
        self.base_patch.start()
        self.addCleanup(self.base_patch.stop)
        self.addCleanup(self.directory.cleanup)
        data, digest, expected = bundle()
        self.files = installer.unpack(data, REVISION, digest)

    def test_publish_complete_tree_modes_and_no_staging(self):
        installer.install(self.files, REVISION)
        published = self.base / REVISION
        actual = {str(p.relative_to(published)): p.read_bytes()
                  for p in published.rglob('*') if p.is_file()}
        self.assertEqual(actual, self.files)
        self.assertFalse((self.base / ('.staging-' + REVISION)).exists())
        for path in [published] + list(published.rglob('*')):
            self.assertEqual(path.stat().st_mode & 0o777, 0o755 if path.is_dir() else 0o644)
        self.assertEqual(list(self.root.iterdir()), [self.base])

    def test_existing_release_preserved_without_overwrite(self):
        installer.install(self.files, REVISION)
        marker = self.base / REVISION / 'dist/index.html'
        marker.write_bytes(b'existing-release-must-survive')
        with self.assertRaises(ValueError):
            installer.install(self.files, REVISION)
        self.assertEqual(marker.read_bytes(), b'existing-release-must-survive')
        self.assertFalse((self.base / ('.staging-' + REVISION)).exists())

    def test_existing_staging_and_destination_symlink_are_preserved(self):
        self.base.mkdir()
        staging = self.base / ('.staging-' + REVISION)
        staging.mkdir()
        marker = staging / 'existing'
        marker.write_bytes(b'preserve')
        with self.assertRaises(ValueError):
            installer.install(self.files, REVISION)
        self.assertEqual(marker.read_bytes(), b'preserve')
        staging.rename(self.base / '.previous-staging')
        destination = self.base / REVISION
        destination.symlink_to(self.root / 'missing-target')
        with self.assertRaises(ValueError):
            installer.install(self.files, REVISION)
        self.assertTrue(destination.is_symlink())
        self.assertFalse((self.root / 'missing-target').exists())

    def test_partial_write_failure_removes_only_its_staging(self):
        self.base.mkdir()
        preserved = self.base / 'existing-release'
        preserved.mkdir()
        (preserved / 'keep').write_bytes(b'unchanged')
        original = Path.open
        def fail(path, *args, **kwargs):
            if path.name == 'index-fixture.js':
                raise OSError(PRIVATE_ERROR)
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, 'open', fail):
            with self.assertRaises(OSError):
                installer.install(self.files, REVISION)
        self.assertFalse((self.base / REVISION).exists())
        self.assertFalse((self.base / ('.staging-' + REVISION)).exists())
        self.assertEqual((preserved / 'keep').read_bytes(), b'unchanged')

    def test_symlink_base_and_symlink_parent_rejected(self):
        real = self.root / 'real'
        real.mkdir()
        self.base.symlink_to(real)
        with self.assertRaises(ValueError):
            installer.install(self.files, REVISION)
        self.assertEqual(list(real.iterdir()), [])
        alias = self.root / 'alias'
        alias.symlink_to(real)
        with mock.patch.object(installer, 'BASE', alias / 'nested'):
            with self.assertRaises(ValueError):
                installer.install(self.files, REVISION)
        self.assertEqual(list(real.iterdir()), [])

    def test_writable_base_rejected_without_changes(self):
        self.base.mkdir(mode=0o775)
        self.base.chmod(0o775)
        with self.assertRaises(ValueError):
            installer.install(self.files, REVISION)
        self.assertEqual(list(self.base.iterdir()), [])

    def test_entrypoint_failure_hides_exception_and_does_not_install(self):
        import runpy
        output = io.StringIO()
        with mock.patch('sys.argv', ['install', '../' + PRIVATE_ERROR, '0' * 64]), \
             mock.patch('sys.stdin', type('Input', (), {'buffer': io.BytesIO(b'invalid')})()), \
             mock.patch('os.getuid', return_value=1002), \
             mock.patch('os.umask'), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit):
                runpy.run_path(str(SOURCE), run_name='__main__')
        self.assertEqual(json.loads(output.getvalue()),
                         {'installed': False, 'error': 'ui-release-install-failed'})
        self.assertNotIn(PRIVATE_ERROR, output.getvalue())
        self.assertFalse(self.base.exists())


if __name__ == '__main__':
    unittest.main()
