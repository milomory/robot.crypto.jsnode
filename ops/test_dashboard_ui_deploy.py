"""Offline fault injection for the one-mount UI deployment transaction."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import types
import unittest
from unittest import mock
import yaml

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ui_deploy_offline', str(HERE / 'deploy-dashboard-ui.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
REV = 'a' * 40
SECRET = 'fixture-super-private-never-output'
LEGACY_COMMAND = ['bash', '-lc', 'npm ci && npm run build && npm run db:migrate && npm start']
LEGACY_SHA = deploy.digest(deploy.canonical(LEGACY_COMMAND))


def write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode())
    path.chmod(0o600)


@contextlib.contextmanager
def fixture_uid():
    stat, lstat = Path.stat, Path.lstat
    def project(result):
        values = {key: getattr(result, key) for key in dir(result) if key.startswith('st_')}
        values['st_uid'] = 1002
        return types.SimpleNamespace(**values)
    with mock.patch.object(Path, 'stat', lambda self, *a, **k: project(stat(self, *a, **k))), \
         mock.patch.object(Path, 'lstat', lambda self, *a, **k: project(lstat(self, *a, **k))):
        yield


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='crypto-ui-deploy-offline-')
        self.root = Path(self.tmp.name)
        self.old_umask = os.umask(0o077)
        (self.root / 'backups').mkdir(mode=0o700)
        self.target = self.root / 'ui-releases' / REV / 'dist'
        write(self.target / 'index.html', '<!doctype html><script src="/assets/index-a.js"></script>')
        write(self.target / 'assets/index-a.js', 'console.log("public artifact")')
        self.manifest = {'schema': 1, 'sourceRevision': REV, 'files': {
            str(p.relative_to(self.target.parent)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in self.target.rglob('*') if p.is_file()}}
        self.repin()
        previous = self.root / 'releases' / ('b' * 40)
        self.old = {'services': {'api': {'image': 'current-image',
            'environment': {'TRADING_MODE': 'paper', 'AUTH_CORE_ENABLED': 'true',
                'LIVE_TRADING_LOCKED': 'true', 'AUTH_CORE_CLIENT_SECRET': SECRET},
            'command': LEGACY_COMMAND,
            'volumes': [str(previous) + ':/code', deploy.PROJECTION + ':/run/crypto-accounts:ro', 'some_modules:/code/node_modules'],
            'ports': ['127.0.0.1:5758:3000']},
            'db': {'image': 'same-db', 'environment': {'POSTGRES_PASSWORD': SECRET}}}}
        self.original = yaml.safe_dump(self.old).encode()
        recover = copy.deepcopy(self.old)
        recover['services']['api']['command'] = deploy.SERVER_COMMAND
        self.recovery = yaml.safe_dump(recover).encode()
        write(self.root / 'docker-compose.override.yml', self.original)
        write(self.root / 'docker-compose.yml', 'version: "3"\nservices: {}\n')
        write(self.root / '.env.auth-core', 'AUTH_CORE_CLIENT_SECRET=' + SECRET + '\n')
        self.env = (self.root / '.env.auth-core').read_bytes()
        self.db = self.runtime(self.old, 'c' * 64)
        self.app = self.runtime(self.old, 'd' * 64)
        self.calls = []
        self.recreates = 0
        self.output = io.StringIO()
        self.fail_recreate = False
        self.fail_readiness = False
        self.stage_mutation = None
        self.before_mutation = None
        self.after_mutation = None
        self.during_readiness = None
        self.config_count = 0

    def tearDown(self):
        os.umask(self.old_umask)
        self.tmp.cleanup()

    def repin(self):
        raw = json.dumps(self.manifest).encode()
        write(self.target.parent / 'manifest.json', raw)
        self.pin = hashlib.sha256(raw).hexdigest()

    def runtime(self, effective, identity):
        api = effective['services']['api']
        return {'Id': identity, 'Created': 'created-' + identity, 'Image': 'sha256:unchanged-image',
            'RestartCount': 0, 'State': {'Running': True, 'StartedAt': 'started-' + identity, 'OOMKilled': False},
            'Config': {'Hostname': identity[:12], 'Image': 'current-image', 'User': 'node',
                'WorkingDir': '/code', 'Entrypoint': ['docker-entrypoint.sh'],
                'Volumes': {target: {} for _, target, _ in deploy.mounts(api)},
                'Env': [key + '=' + str(value) for key, value in api['environment'].items()],
                'Cmd': api['command'], 'Labels': {'com.docker.compose.config-hash': identity, 'unrelated': 'fixed'}},
            'HostConfig': {'Binds': api['volumes'], 'Privileged': False,
                'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5758'}]}},
            'Mounts': [{'Type': 'bind', 'Source': s, 'Destination': t, 'RW': not ro, 'Propagation': 'rprivate'}
                for s, t, ro in deploy.mounts(api)], 'NetworkSettings': {'Networks': {'same-network': {}}}}

    def fake_run(self, args):
        self.calls.append(args)
        if args[0] == 'docker' and args[1] == 'inspect':
            return json.dumps([self.app if args[2] == deploy.APP else self.db]).encode()
        if args[-1] == 'config':
            if len(args) == 2:
                self.config_count += 1
                if self.config_count == 2 and self.before_mutation:
                    self.before_mutation()
                effective = yaml.safe_load((self.root / 'docker-compose.override.yml').read_bytes())
            else:
                effective = yaml.safe_load(Path(args[4]).read_bytes())
                if self.stage_mutation:
                    self.stage_mutation(effective)
            return yaml.safe_dump(effective).encode()
        self.assertEqual(args, ['docker-compose', 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'api'])
        self.recreates += 1
        if self.fail_recreate and self.recreates == 1:
            raise subprocess.CalledProcessError(1, args, stderr=SECRET.encode())
        effective = yaml.safe_load((self.root / 'docker-compose.override.yml').read_bytes())
        self.app = self.runtime(effective, str(self.recreates) * 64)
        if self.after_mutation and self.recreates == 1:
            self.after_mutation()
        return b''

    def fake_readiness(self):
        if self.during_readiness and self.recreates == 1:
            self.during_readiness()
        if self.fail_readiness and self.recreates == 1:
            raise ValueError(SECRET)
        return [200, 303, 401]

    @contextlib.contextmanager
    def context(self):
        with mock.patch.object(deploy, 'ROOT', self.root), \
             mock.patch.object(deploy, 'LEGACY_COMMAND_SHA256', LEGACY_SHA), \
             mock.patch.object(deploy, 'run', side_effect=self.fake_run), \
             mock.patch.object(deploy, 'readiness', side_effect=self.fake_readiness), \
             mock.patch.object(deploy.os, 'getuid', return_value=1002), \
             mock.patch.object(deploy.signal, 'signal'), fixture_uid(), \
             contextlib.redirect_stdout(self.output):
            yield
        self.assertNotIn(SECRET, self.output.getvalue())
        self.assertEqual((self.root / '.env.auth-core').read_bytes(), self.env)

    def execute(self):
        return deploy.deploy(REV, self.pin)

    def test_only_ui_bind_changes_with_exact_backend_env_db_and_private_backup(self):
        before_db = copy.deepcopy(self.db)
        with self.context():
            result = self.execute()
        self.assertTrue(result['ready'])
        new = yaml.safe_load((self.root / 'docker-compose.override.yml').read_bytes())
        expected = copy.deepcopy(self.old)
        expected['services']['api']['command'] = deploy.SERVER_COMMAND
        expected['services']['api']['volumes'].append(str(self.target) + ':/code/ui/dist:ro')
        self.assertEqual(new, expected)
        self.assertEqual(self.recreates, 1)
        self.assertEqual(self.db, before_db)
        backup = Path(result['backup'])
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        for file in backup.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual((backup / 'docker-compose.override.yml').read_bytes(), self.original)
        self.assertNotIn(SECRET, (backup / 'deployment.json').read_text())
        self.assertNotIn('manifest.json', yaml.safe_dump(new['services']['api']['volumes']))

    def test_checksum_mismatch_does_not_execute_commands(self):
        write(self.target / 'assets/index-a.js', 'changed after review')
        with self.context(), self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.calls, [])
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.original)

    def test_unknown_file_even_matching_manifest_is_rejected(self):
        write(self.target / '.env', SECRET)
        self.manifest['files']['dist/.env'] = hashlib.sha256(SECRET.encode()).hexdigest()
        self.repin()
        with self.context(), self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_symlink_hardlink_and_groupwrite_rejected(self):
        file = self.target / 'assets/index-a.js'
        original = file.read_bytes()
        for kind in ['symlink', 'hardlink', 'groupwrite']:
            with self.subTest(kind=kind):
                file.unlink()
                source = self.root / ('fixture-' + kind)
                write(source, original)
                if kind == 'symlink':
                    file.symlink_to(source)
                elif kind == 'hardlink':
                    os.link(str(source), str(file))
                else:
                    write(file, original)
                    file.chmod(0o620)
                with self.context(), self.assertRaises(ValueError):
                    self.execute()
        self.assertEqual(self.calls, [])

    def test_effective_backend_mutation_rejected_without_recreate(self):
        self.stage_mutation = lambda value: value['services']['api']['environment'].update(TRADING_MODE='live')
        with self.context(), self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.recreates, 0)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.original)

    def test_unrelated_effective_mutation_is_rejected(self):
        self.stage_mutation = lambda value: value['services']['db'].update(image='different-db')
        with self.context(), self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.recreates, 0)

    def test_container_identity_drift_before_write_rejected(self):
        self.before_mutation = lambda: self.app.update(Id='f' * 64)
        with self.context(), self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.recreates, 0)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.original)

    def test_failed_recreate_restores_only_override_and_recreates_previous_api(self):
        self.fail_recreate = True
        with self.context(), self.assertRaises(deploy.Failed) as error:
            self.execute()
        self.assertEqual(error.exception.result['rollback'], 'restored-ui-safe-startup-ready')
        self.assertEqual(self.recreates, 2)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.recovery)

    def test_readiness_failure_restores_previous_ui(self):
        self.fail_readiness = True
        with self.context(), self.assertRaises(deploy.Failed) as error:
            self.execute()
        self.assertEqual(error.exception.result['rollback'], 'restored-ui-safe-startup-ready')
        self.assertEqual(self.recreates, 2)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.recovery)

    def test_runtime_image_change_rejected_and_scoped_rollback_attempted(self):
        self.after_mutation = lambda: self.app.update(Image='unexpected-image')
        with self.context(), self.assertRaises(deploy.Failed) as error:
            self.execute()
        self.assertEqual(error.exception.result['rollback'], 'restored-ui-safe-startup-ready')
        self.assertEqual(self.recreates, 2)

    def test_changed_configuration_after_recreate_never_gets_stale_rollback(self):
        drift = self.original + b'# changed concurrently\n'
        def mutate():
            write(self.root / 'docker-compose.override.yml', drift)
            raise InterruptedError(SECRET)
        self.during_readiness = mutate
        with self.context(), self.assertRaises(deploy.Failed) as error:
            self.execute()
        self.assertEqual(error.exception.result['rollback'], 'blocked-config-drift')
        self.assertEqual(self.recreates, 1)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), drift)

    def test_database_identity_drift_blocks_rollback(self):
        def mutate():
            self.db['Id'] = 'f' * 64
            raise ValueError(SECRET)
        self.during_readiness = mutate
        with self.context(), self.assertRaises(deploy.Failed) as error:
            self.execute()
        self.assertEqual(error.exception.result['rollback'], 'blocked-config-drift')
        self.assertEqual(self.recreates, 1)

    def test_interrupt_after_write_rolls_back(self):
        def interrupt():
            raise InterruptedError(SECRET)
        self.during_readiness = interrupt
        with self.context(), self.assertRaises(deploy.Failed) as error:
            self.execute()
        self.assertEqual(error.exception.result['rollback'], 'restored-ui-safe-startup-ready')
        self.assertEqual(self.recreates, 2)

    def test_explicit_rollback_restores_exact_previous_mount(self):
        with self.context():
            result = self.execute()
            reverted = deploy.rollback(Path(result['backup']).name)
        self.assertTrue(reverted['rolledBack'])
        self.assertEqual(self.recreates, 2)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.recovery)

    def test_explicit_rollback_refuses_drift(self):
        with self.context():
            result = self.execute()
            drift = (self.root / 'docker-compose.override.yml').read_bytes() + b'# newer change\n'
            write(self.root / 'docker-compose.override.yml', drift)
            with self.assertRaises(ValueError):
                deploy.rollback(Path(result['backup']).name)
        self.assertEqual(self.recreates, 1)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), drift)

    def test_guard_rejects_unlocked_live_and_disabled_sso(self):
        for key, value in [('TRADING_MODE', 'live'), ('LIVE_TRADING_LOCKED', 'false'), ('AUTH_CORE_ENABLED', 'false')]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.old)
                changed['services']['api']['environment'][key] = value
                with mock.patch.object(deploy, 'ROOT', self.root), mock.patch.object(deploy, 'LEGACY_COMMAND_SHA256', LEGACY_SHA), self.assertRaises(ValueError):
                    deploy.validate_current(changed)

    def test_guard_rejects_public_port_and_nested_ui_mount(self):
        for change in ['port', 'nested']:
            changed = copy.deepcopy(self.old)
            if change == 'port':
                changed['services']['api']['ports'] = ['0.0.0.0:5758:3000']
            else:
                changed['services']['api']['volumes'].append('/arbitrary:/code/ui/dist/assets:ro')
            with self.subTest(change=change), mock.patch.object(deploy, 'ROOT', self.root), mock.patch.object(deploy, 'LEGACY_COMMAND_SHA256', LEGACY_SHA), self.assertRaises(ValueError):
                deploy.validate_current(changed)

    def test_new_overlay_replaces_previous_overlay_and_rollback_restores_it(self):
        previous = self.root / 'ui-releases' / ('e' * 40) / 'dist'
        self.old['services']['api']['volumes'].append(str(previous) + ':/code/ui/dist:ro')
        self.original = yaml.safe_dump(self.old).encode()
        recover = copy.deepcopy(self.old)
        recover['services']['api']['command'] = deploy.SERVER_COMMAND
        self.recovery = yaml.safe_dump(recover).encode()
        write(self.root / 'docker-compose.override.yml', self.original)
        self.app = self.runtime(self.old, 'd' * 64)
        with self.context():
            result = self.execute()
            new = yaml.safe_load((self.root / 'docker-compose.override.yml').read_bytes())
            self.assertEqual(sum(deploy.mount(v)[1] == '/code/ui/dist' for v in new['services']['api']['volumes']), 1)
            deploy.rollback(Path(result['backup']).name)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.recovery)

    def test_pinned_legacy_command_is_only_accepted_legacy_shape(self):
        with mock.patch.object(deploy, 'LEGACY_COMMAND_SHA256', LEGACY_SHA):
            self.assertEqual(deploy.command(LEGACY_COMMAND), LEGACY_COMMAND)
            quoted = "bash -lc 'npm ci && npm run build && npm run db:migrate && npm start'"
            self.assertEqual(deploy.command(quoted), LEGACY_COMMAND)
            self.assertEqual(deploy.command(deploy.SERVER_COMMAND), deploy.SERVER_COMMAND)
            for invalid in [['npm', 'start'], LEGACY_COMMAND + ['extra'], ['node', 'other.js']]:
                with self.subTest(command=invalid), self.assertRaises(ValueError):
                    deploy.command(invalid)

    def test_unsupported_current_command_refused_before_writes(self):
        self.old['services']['api']['command'] = ['node', 'unreviewed.js']
        write(self.root / 'docker-compose.override.yml', yaml.safe_dump(self.old))
        with self.context(), self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.recreates, 0)
        self.assertEqual(list((self.root / 'backups').iterdir()), [])

    def test_recovery_never_executes_legacy_build_or_migration_command(self):
        self.fail_readiness = True
        executed_commands = []
        fake = self.fake_run
        def recorded(args):
            if args[-1] == 'api':
                effective = yaml.safe_load((self.root / 'docker-compose.override.yml').read_bytes())
                executed_commands.append(effective['services']['api']['command'])
            return fake(args)
        with self.context(), mock.patch.object(deploy, 'run', side_effect=recorded), self.assertRaises(deploy.Failed):
            self.execute()
        self.assertEqual(executed_commands, [deploy.SERVER_COMMAND, deploy.SERVER_COMMAND])
        backup = next((self.root / 'backups').iterdir())
        self.assertEqual((backup / 'docker-compose.override.yml').read_bytes(), self.original)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.recovery)

    def test_failed_entrypoint_never_dumps_command_output_or_traceback(self):
        with mock.patch('sys.argv', ['deploy', 'invalid', SECRET]), \
             mock.patch('os.getuid', return_value=1002), mock.patch('signal.signal'), \
             mock.patch('subprocess.check_output') as no_run, contextlib.redirect_stdout(self.output):
            with self.assertRaises(SystemExit):
                runpy.run_path(str(HERE / 'deploy-dashboard-ui.py'), run_name='__main__')
        self.assertEqual(json.loads(self.output.getvalue()), {'configured': False, 'error': 'ui-deployment-validation-failed'})
        self.assertNotIn(SECRET, self.output.getvalue())
        no_run.assert_not_called()


class ReadinessTests(unittest.TestCase):
    def response(self, code, body=b'{}', headers=None):
        response = io.BytesIO(body)
        response.code = code
        response.headers = headers or {}
        return response

    def test_bounded_safe_paths_and_no_authenticated_requests(self):
        opener = mock.Mock()
        opener.open.side_effect = [self.response(200, b'{"ok":true}'),
            self.response(303, headers={'Location': '/auth/login'}), self.response(401)]
        with mock.patch.object(deploy.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(deploy.probe(), [200, 303, 401])
        requests = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual([request.full_url for request in requests], [
            'http://127.0.0.1:5758/health', 'http://127.0.0.1:5758/',
            'http://127.0.0.1:5758/api/accounts/dashboard'])
        self.assertTrue(all(request.get_method() == 'GET' for request in requests))
        self.assertTrue(all(not request.has_header('Authorization') and not request.has_header('Cookie') for request in requests))

    def test_api_redirect_and_false_health_rejected(self):
        for responses in [[self.response(200, b'{"ok":false}')],
                [self.response(200, b'{"ok":true}'), self.response(303, headers={'Location': '/auth/login'}),
                 self.response(401, headers={'Location': '/auth/login'})]]:
            opener = mock.Mock(); opener.open.side_effect = responses
            with mock.patch.object(deploy.urllib.request, 'build_opener', return_value=opener), self.assertRaises(ValueError):
                deploy.probe()


if __name__ == '__main__':
    unittest.main()
