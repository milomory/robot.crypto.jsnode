"""Offline fault-injection tests. Only temporary fixture paths and fake commands."""
import builtins
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest import mock

import yaml

HERE = Path(__file__).resolve().parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

deploy = load('dashboard_deploy_offline', HERE / 'deploy-account-dashboard.py')
pin = load('dashboard_pin_offline', HERE / 'pair-observer/update-local.py')
installer = load('dashboard_install_offline', HERE / 'install-account-dashboard-release.py')
UID = '12345678-1234-4234-8234-123456789abc'
SECRET = 'synthetic-private-client-secret-never-output'
REVISION = 'a' * 40
OLD_PIN, NEW_PIN = 'b' * 64, 'c' * 64
TRADING = ['migrations', 'src/services', 'src/exchange', 'src/risk', 'src/journal',
           'dist/services', 'dist/exchange', 'dist/risk', 'dist/journal']

def write(path, raw, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw if isinstance(raw, bytes) else raw.encode('utf8'))
    path.chmod(mode)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

@contextlib.contextmanager
def fixture_uid(uid):
    # Preserve real filesystem modes/types/links, alias only fixture ownership.
    stat, lstat = Path.stat, Path.lstat
    def projected(result):
        values = {name: getattr(result, name) for name in dir(result) if name.startswith('st_')}
        values['st_uid'] = uid
        return types.SimpleNamespace(**values)
    with mock.patch.object(Path, 'stat', lambda self, *a, **k: projected(stat(self, *a, **k))), \
         mock.patch.object(Path, 'lstat', lambda self, *a, **k: projected(lstat(self, *a, **k))):
        yield

class Fixtures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='crypto-dashboard-offline-')
        self.base = Path(self.tmp.name)
        self.old_umask = os.umask(0o077)
        self.output = io.StringIO()
    def tearDown(self):
        os.umask(self.old_umask)
        self.tmp.cleanup()
    def assert_private_output(self):
        self.assertNotIn(SECRET, self.output.getvalue())
        self.assertNotIn(UID, self.output.getvalue())
    def deployment(self):
        root = self.base / 'crypto'; root.mkdir()
        (root / 'backups').mkdir()
        previous = root / 'releases' / ('d' * 40)
        release = root / 'releases' / REVISION
        for directory in TRADING:
            for tree in [previous, release]:
                write(tree / directory / 'same.txt', 'same-trading-source', 0o644)
        write(release / 'dist/http/account-dashboard-routes.js', 'reviewed-code', 0o644)
        write(release / 'ui/dist/index.html', '<!doctype html>', 0o644)
        self.write_manifest(release)
        projection = self.base / 'projection'; projection.mkdir(mode=0o700)
        write(projection / 'current.json', json.dumps({'schema': 1, 'liveExecutionEnabled': False}))
        old = {'services': {'api': {'environment': {'AUTH_CORE_ENABLED': 'true', 'LIVE_TRADING_LOCKED': 'true',
            'TRADING_MODE': 'paper', 'RISK_MAX_ORDER_QUOTE': 50, 'AUTH_CORE_VIEWER_IDS': UID, 'AUTH_CORE_CLIENT_SECRET': SECRET},
            'volumes': [str(previous) + ':/code:ro', 'existing_volume:/code/node_modules', str(root / 'ui-releases' / ('e' * 40) / 'dist') + ':/code/ui/dist:ro'],
            'image': 'unchanged-api', 'ports': ['127.0.0.1:5758:3000'], 'command': ['node', 'dist/server.js']},
            'db': {'image': 'unchanged-db', 'volumes': ['unchanged:/db']}}}
        original = yaml.safe_dump(old).encode('utf8')
        write(root / 'docker-compose.override.yml', original)
        write(root / 'docker-compose.yml', 'services: {}\n')
        env = ('AUTH_CORE_CLIENT_SECRET=' + SECRET + '\nAUTH_CORE_VIEWER_IDS=' + UID + '\n').encode('utf8')
        write(root / '.env.auth-core', env)
        return root, release, projection, old, original, env
    def write_manifest(self, release):
        manifest = {str(p.relative_to(release)): sha(p.read_bytes()) for p in release.rglob('*')
                    if p.is_file() and p.name != 'dashboard-manifest.json'}
        write(release / 'dashboard-manifest.json', json.dumps(manifest), 0o644)
    def runtime(self, effective, container_id):
        api = effective['services']['api']
        return {'Id': container_id, 'Created': 'created-' + container_id, 'Image': 'sha256:unchanged-image',
            'RestartCount': 0, 'State': {'Running': True, 'StartedAt': 'started-' + container_id, 'OOMKilled': False},
            'Config': {'Hostname': container_id[:12], 'Image': 'unchanged-api', 'User': 'node',
                'WorkingDir': '/code', 'Entrypoint': ['docker-entrypoint.sh'],
                'Volumes': {target: {} for _, target, _ in deploy.mounts(api)},
                'Env': [key + '=' + str(value) for key, value in api['environment'].items()],
                'Cmd': api['command'], 'Labels': {'com.docker.compose.config-hash': container_id, 'fixed': 'same'}},
            'HostConfig': {'Binds': api['volumes'], 'Privileged': False,
                'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5758'}]}},
            'Mounts': [{'Type': 'bind', 'Source': source, 'Destination': target, 'RW': not ro, 'Propagation': 'rprivate'}
                for source, target, ro in deploy.mounts(api)], 'NetworkSettings': {'Networks': {'same-network': {}}}}

    @contextlib.contextmanager
    def deploy_context(self, fixture, mutate=None, docker_fail=False, readiness_fail=False,
                       before_runtime=None, after_runtime=None, during_readiness=None):
        root, release, projection, old, original, env = fixture
        calls = []
        self.app = self.runtime(old, '1' * 64)
        self.db = self.runtime(old, '2' * 64)
        self.recreates = 0
        self.ready_calls = 0
        if before_runtime:
            before_runtime(self.app)
        def effective(path):
            value = yaml.safe_load(path.read_bytes())
            lines = (root / '.env.auth-core').read_text().splitlines()
            owners = [line.split('=', 1)[1] for line in lines if line.startswith('AUTH_CORE_OWNER_IDS=')]
            if owners:
                self.assertEqual(owners, [UID])
                value['services']['api']['environment']['AUTH_CORE_OWNER_IDS'] = owners[0]
            return value
        def run(args):
            calls.append(list(args))
            if args[:2] == ['docker', 'inspect']:
                self.assertIn(args[2], [deploy.APP, deploy.DB])
                return json.dumps([self.app if args[2] == deploy.APP else self.db]).encode()
            if args == ['docker-compose', 'config']:
                return yaml.safe_dump(effective(root / 'docker-compose.override.yml')).encode()
            if args[-1] == 'config':
                value = effective(root / args[4])
                if mutate:
                    mutate(value)
                return yaml.safe_dump(value).encode('utf8')
            self.assertEqual(args, ['docker-compose', 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'api'])
            self.recreates += 1
            if docker_fail and self.recreates == 1:
                raise subprocess.CalledProcessError(1, args, stderr=SECRET.encode('utf8'))
            self.app = self.runtime(effective(root / 'docker-compose.override.yml'), str(self.recreates + 2) * 64)
            if after_runtime and self.recreates == 1:
                after_runtime(self.app)
            return b''
        def ready():
            self.ready_calls += 1
            if during_readiness and self.ready_calls == 1:
                during_readiness()
            if readiness_fail and self.ready_calls == 1:
                raise ValueError(SECRET)
            return [200, 303, 401]
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(deploy, 'ROOT', root))
            stack.enter_context(mock.patch.object(deploy, 'PROJECTION', projection))
            stack.enter_context(mock.patch.object(deploy.sys, 'argv', ['deploy', REVISION]))
            stack.enter_context(mock.patch.object(deploy.os, 'getuid', return_value=1002))
            stack.enter_context(mock.patch.object(deploy, 'run', side_effect=run))
            stack.enter_context(mock.patch.object(deploy, 'readiness', side_effect=ready))
            stack.enter_context(mock.patch.object(deploy.signal, 'signal'))
            stack.enter_context(fixture_uid(1002))
            stack.enter_context(contextlib.redirect_stdout(self.output))
            yield calls

class DashboardDeploymentTests(Fixtures):
    def test_exact_compose_and_protected_env_delta_only(self):
        fixture = self.deployment(); root, release, projection, old, original, env = fixture
        with self.deploy_context(fixture) as calls:
            deploy.main()
        self.assertEqual((root / '.env.auth-core').read_bytes(), env + b'AUTH_CORE_OWNER_IDS=' + UID.encode('ascii') + b'\n')
        changed = yaml.safe_load((root / 'docker-compose.override.yml').read_bytes())
        self.assertEqual(changed['services']['db'], old['services']['db'])
        self.assertNotIn('AUTH_CORE_OWNER_IDS', changed['services']['api']['environment'])
        self.assertEqual(changed['services']['api']['environment']['ACCOUNT_DASHBOARD_DIR'], '/run/crypto-accounts')
        self.assertIn(str(projection) + ':/run/crypto-accounts:ro', changed['services']['api']['volumes'])
        self.assertEqual(sum(call[-1] == 'api' for call in calls), 1)
        backup = root / 'backups' / ('account-dashboard-' + REVISION[:7])
        self.assertEqual((backup / '.env.auth-core').read_bytes(), env)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((backup / '.env.auth-core').stat().st_mode & 0o777, 0o600)
        self.assertEqual((root / '.env.auth-core').stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.output.getvalue())['ownerCount'], 1)
        self.assert_private_output()
    def test_unrelated_effective_config_mutation_rejected_and_env_restored(self):
        fixture = self.deployment(); root, _, _, _, original, env = fixture
        with self.deploy_context(fixture, mutate=lambda value: value['services']['api']['environment'].update(TRADING_MODE='live')) as calls:
            with self.assertRaises(deploy.Failed):
                deploy.main()
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
        self.assertFalse(any(call[-1] == 'api' for call in calls))
        self.assert_private_output()
    def test_failed_docker_recreate_restores_both_files_and_recreates_only_previous_api(self):
        fixture = self.deployment(); root, _, _, _, original, env = fixture
        with self.deploy_context(fixture, docker_fail=True) as calls:
            with self.assertRaises(deploy.Failed):
                deploy.main()
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
        self.assertEqual(sum(call[-1] == 'api' for call in calls), 2)
        self.assert_private_output()
    def test_interruption_after_env_replacement_rolls_back(self):
        fixture = self.deployment(); root, _, _, _, original, env = fixture
        def interrupt(_value):
            raise InterruptedError(SECRET)
        with self.deploy_context(fixture, mutate=interrupt):
            with self.assertRaises(deploy.Failed):
                deploy.main()
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
        self.assert_private_output()
    def test_dist_trading_mutation_rejected_even_with_matching_release_manifest(self):
        fixture = self.deployment(); root, release, _, _, original, env = fixture
        write(release / 'dist/exchange/same.txt', 'changed-runtime', 0o644)
        self.write_manifest(release)
        with self.deploy_context(fixture):
            with self.assertRaises(ValueError):
                deploy.main()
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
    def test_missing_and_symlink_trading_directories_rejected(self):
        with self.assertRaises(ValueError):
            deploy.fingerprints(self.base / 'missing')
        real = self.base / 'real'; real.mkdir(); write(real / 'test', 'test')
        alias = self.base / 'alias'; alias.symlink_to(real)
        with self.assertRaises(ValueError):
            deploy.fingerprints(alias)
        (real / 'link').symlink_to(real / 'test')
        with self.assertRaises(ValueError):
            deploy.fingerprints(real)
    def test_multiple_viewers_are_not_promoted_to_owners(self):
        fixture = self.deployment(); root, _, _, old, original, env = fixture
        old['services']['api']['environment']['AUTH_CORE_VIEWER_IDS'] += ',22345678-1234-4234-8234-123456789abc'
        with self.deploy_context(fixture):
            with self.assertRaises(ValueError):
                deploy.main()
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertFalse((root / 'backups' / ('account-dashboard-' + REVISION[:7])).exists())
    def test_entrypoint_errors_never_dump_exception_input(self):
        with mock.patch('sys.argv', ['deploy', 'invalid-' + SECRET]), \
             mock.patch('subprocess.check_output') as no_commands, mock.patch('signal.signal'), contextlib.redirect_stdout(self.output):
            with self.assertRaises(SystemExit):
                runpy.run_path(str(HERE / 'deploy-account-dashboard.py'), run_name='__main__')
        self.assertEqual(json.loads(self.output.getvalue()), {'configured': False, 'error': 'scoped-account-dashboard-rollout-failed'})
        no_commands.assert_not_called()
        self.assert_private_output()

    def test_legacy_build_migrate_startup_rejected_before_changes(self):
        fixture = self.deployment(); root, _, _, old, _, env = fixture
        changed = copy.deepcopy(old)
        changed['services']['api']['command'] = ['bash', '-lc', 'npm run build && npm run db:migrate && npm start']
        original = yaml.safe_dump(changed).encode()
        write(root / 'docker-compose.override.yml', original)
        with self.deploy_context(fixture) as calls:
            with self.assertRaises(ValueError):
                deploy.main()
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertFalse(any(call[-1] == 'api' for call in calls))

    def test_current_runtime_command_drift_rejected_before_changes(self):
        fixture = self.deployment(); root, _, _, _, original, env = fixture
        with self.deploy_context(fixture, before_runtime=lambda value: value['Config'].update(Cmd=['sh', '-c', 'node dist/server.js'])) as calls:
            with self.assertRaises(ValueError):
                deploy.main()
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertFalse(any(call[-1] == 'api' for call in calls))

    def test_already_configured_owner_and_ui_overlay_preserved(self):
        fixture = self.deployment(); root, _, projection, old, _, env = fixture
        env += b'AUTH_CORE_OWNER_IDS=' + UID.encode() + b'\n'
        write(root / '.env.auth-core', env)
        old['services']['api']['environment']['ACCOUNT_DASHBOARD_DIR'] = '/run/crypto-accounts'
        old['services']['api']['volumes'].append(str(projection) + ':/run/crypto-accounts:ro')
        write(root / 'docker-compose.override.yml', yaml.safe_dump(old))
        old['services']['api']['environment']['AUTH_CORE_OWNER_IDS'] = UID
        old_ui = next(item for item in old['services']['api']['volumes'] if ':/code/ui/dist:' in item)
        with self.deploy_context(fixture):
            deploy.main()
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        changed = yaml.safe_load((root / 'docker-compose.override.yml').read_bytes())
        self.assertIn(old_ui, changed['services']['api']['volumes'])
        self.assertEqual(self.ready_calls, 1)
        result = json.loads(self.output.getvalue())
        self.assertEqual([result['health'], result['anonymousDocument'], result['anonymousApi']], [200, 303, 401])
        self.assertTrue(result['runtimeContractPreserved'])
        self.assert_private_output()

    def test_readiness_failure_restores_both_files_and_previous_api(self):
        fixture = self.deployment(); root, _, _, _, original, env = fixture
        with self.deploy_context(fixture, readiness_fail=True) as calls:
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restored-previous-api-ready')
        self.assertEqual(self.recreates, 2)
        self.assertEqual(self.ready_calls, 2)
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)
        self.assertTrue(all('--no-build' in call and '--no-deps' in call and call[-1] == 'api'
            for call in calls if call[:2] == ['docker-compose', 'up']))
        self.assert_private_output()

    def test_changed_image_rolls_back_after_readiness(self):
        fixture = self.deployment(); root, _, _, _, original, env = fixture
        with self.deploy_context(fixture, after_runtime=lambda value: value.update(Image='sha256:unreviewed-image')):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restored-previous-api-ready')
        self.assertEqual(self.app['Image'], 'sha256:unchanged-image')
        self.assertEqual(self.recreates, 2)
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), original)
        self.assertEqual((root / '.env.auth-core').read_bytes(), env)

    def test_extra_runtime_environment_rolls_back(self):
        fixture = self.deployment()
        with self.deploy_context(fixture, after_runtime=lambda value: value['Config']['Env'].append('UNEXPECTED=' + SECRET)):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restored-previous-api-ready')
        self.assertEqual(self.recreates, 2)
        self.assert_private_output()

    def test_changed_ui_overlay_rolls_back(self):
        fixture = self.deployment()
        def change(value):
            next(item for item in value['Mounts'] if item['Destination'] == '/code/ui/dist')['Source'] = '/different-ui'
        with self.deploy_context(fixture, after_runtime=change):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restored-previous-api-ready')
        self.assertEqual(self.recreates, 2)

    def test_public_binding_change_rolls_back(self):
        fixture = self.deployment()
        def change(value):
            value['HostConfig']['PortBindings']['3000/tcp'][0]['HostIp'] = '0.0.0.0'
        with self.deploy_context(fixture, after_runtime=change):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restored-previous-api-ready')
        self.assertEqual(self.app['HostConfig']['PortBindings']['3000/tcp'][0]['HostIp'], '127.0.0.1')

    def test_changed_trading_release_after_recreate_restores_unchanged_previous(self):
        fixture = self.deployment(); _, release, _, _, _, _ = fixture
        def change():
            write(release / 'dist/exchange/same.txt', 'changed-after-preflight', 0o644)
        with self.deploy_context(fixture, during_readiness=change):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restored-previous-api-ready')
        self.assertEqual(self.recreates, 2)

    def test_changed_previous_trading_code_not_restarted_for_rollback(self):
        fixture = self.deployment(); root, _, _, old, _, _ = fixture
        previous = Path(next(source for source, target, _ in deploy.mounts(old['services']['api']) if target == '/code'))
        def change():
            write(previous / 'dist/exchange/same.txt', 'changed-old-source', 0o644)
        with self.deploy_context(fixture, during_readiness=change):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restore-needs-review')
        self.assertEqual(self.recreates, 1)

    def test_database_identity_change_is_detected_without_database_actions(self):
        fixture = self.deployment()
        def change():
            self.db['Id'] = '9' * 64
        with self.deploy_context(fixture, during_readiness=change) as calls:
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'blocked-config-drift')
        self.assertEqual(self.db['Id'], '9' * 64)
        self.assertEqual(self.recreates, 1)
        self.assertTrue(all(call[-1] == 'api' for call in calls if call[:2] == ['docker-compose', 'up']))

    def test_referenced_env_drift_blocks_rollback_with_override_and_auth_env_unchanged(self):
        fixture = self.deployment(); root, _, _, _, _, _ = fixture
        changed = []
        def change():
            changed.append(((root / 'docker-compose.override.yml').read_bytes(),
                (root / '.env.auth-core').read_bytes()))
        with self.deploy_context(fixture, during_readiness=change, readiness_fail=True):
            fake_run = deploy.run.side_effect
            def external_env(args):
                raw = fake_run(args)
                if changed and args == ['docker-compose', 'config']:
                    value = yaml.safe_load(raw)
                    value['services']['api']['environment']['EXTERNAL_ENV_FILE_CHANGED'] = SECRET
                    return yaml.safe_dump(value).encode()
                return raw
            with mock.patch.object(deploy, 'run', side_effect=external_env):
                with self.assertRaises(deploy.Failed) as error:
                    deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'blocked-config-drift')
        self.assertEqual(self.recreates, 1)
        self.assertEqual((root / 'docker-compose.override.yml').read_bytes(), changed[0][0])
        self.assertEqual((root / '.env.auth-core').read_bytes(), changed[0][1])
        self.assertNotIn(SECRET, json.dumps(error.exception.result))
        self.assert_private_output()

    def test_override_drift_is_not_overwritten_by_rollback(self):
        fixture = self.deployment(); root, _, _, _, _, _ = fixture
        def change():
            path = root / 'docker-compose.override.yml'
            path.write_bytes(path.read_bytes() + b'\n# concurrent operator change\n')
        with self.deploy_context(fixture, during_readiness=change):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'blocked-config-drift')
        self.assertIn(b'concurrent operator change', (root / 'docker-compose.override.yml').read_bytes())
        self.assertEqual(self.recreates, 1)

    def test_restore_failure_is_reported_without_secret_exception(self):
        fixture = self.deployment()
        with self.deploy_context(fixture, readiness_fail=True), mock.patch.object(deploy, 'replace_private', side_effect=OSError(SECRET)):
            with self.assertRaises(deploy.Failed) as error:
                deploy.main()
        self.assertEqual(error.exception.result['rollback'], 'restore-needs-review')
        self.assertNotIn(SECRET, json.dumps(error.exception.result))


class ReadinessProbeTests(unittest.TestCase):
    def response(self, code, body=b'{}', headers=None):
        result = io.BytesIO(body)
        result.code = code
        result.headers = headers or {}
        return result

    def test_health_document_api_exact_contract_and_fixed_local_targets(self):
        responses = [self.response(200, b'{"ok":true}'), self.response(303, headers={'Location': '/auth/login'}), self.response(401)]
        opener = mock.Mock()
        opener.open.side_effect = responses
        with mock.patch.object(deploy.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(deploy.probe(), [200, 303, 401])
        self.assertEqual([call.args[0].full_url for call in opener.open.call_args_list],
            ['http://127.0.0.1:5758/health', 'http://127.0.0.1:5758/', 'http://127.0.0.1:5758/api/accounts/dashboard'])
        self.assertTrue(all(call.args[0].get_method() == 'GET' for call in opener.open.call_args_list))
        self.assertTrue(all(call.kwargs == {'timeout': 2} for call in opener.open.call_args_list))

    def test_redirected_api_wrong_document_target_and_bad_health_rejected(self):
        cases = [(200, b'{"ok":false}', '/auth/login', 401, None),
            (200, b'{"ok":true}', 'https://other.example/', 401, None),
            (200, b'{"ok":true}', '/auth/login', 303, '/auth/login'),
            (200, b'{"ok":true}', '/auth/login', 401, '/auth/login')]
        for code, body, location, api_code, api_location in cases:
            with self.subTest(code=code, document=location, api=api_code, api_location=api_location):
                opener = mock.Mock()
                opener.open.side_effect = [self.response(code, body), self.response(303, headers={'Location': location}),
                    self.response(api_code, headers={'Location': api_location} if api_location else {})]
                with mock.patch.object(deploy.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaises(ValueError):
                        deploy.probe()

    def test_readiness_timeout_is_bounded(self):
        with mock.patch.object(deploy, 'probe', side_effect=ValueError()), \
             mock.patch.object(deploy.time, 'monotonic', side_effect=[0, 46]), \
             mock.patch.object(deploy.time, 'sleep') as sleep:
            with self.assertRaises(ValueError):
                deploy.readiness()
        sleep.assert_not_called()

class PinTransactionTests(Fixtures):
    def test_second_replace_failure_restores_both_exact_files_and_private_backups(self):
        target = self.base / 'controller'; target.mkdir()
        pin_path = target / pin.RELATIVE
        old = json.dumps({'schema': 1, 'release': OLD_PIN, 'manifestSha256': OLD_PIN}).encode()
        write(pin_path, old, 0o644)
        manifest_path = target / 'manifest.json'
        manifest = json.dumps({pin.RELATIVE: sha(old)}).encode()
        write(manifest_path, manifest, 0o644)
        source = self.base / 'source'; source.mkdir()
        write(source / 'release-pin.json', json.dumps({'schema': 1, 'release': NEW_PIN, 'manifestSha256': NEW_PIN}))
        actual_replace = Path.replace
        failed = []
        def replace(path, destination):
            if path.name.startswith('.dashboard-manifest-') and not failed:
                failed.append(True)
                raise OSError('synthetic second replace failure')
            return actual_replace(path, destination)
        def lock_open(path, mode):
            self.assertEqual(path, '/run/lock/crypto-pair-observer-once.lock')
            handle = builtins.open(str(self.base / 'fixture.lock'), mode)
            self.addCleanup(handle.close)
            return handle
        with mock.patch.object(pin, 'TARGET', target), mock.patch.object(pin, '__file__', str(source / 'update-local.py')), \
             mock.patch.object(pin.sys, 'argv', ['pin', OLD_PIN]), mock.patch.object(pin.os, 'geteuid', return_value=0), \
             mock.patch.object(pin, 'inactive', return_value=True), mock.patch.object(pin, 'open', side_effect=lock_open, create=True), \
             mock.patch.object(Path, 'replace', replace), fixture_uid(0), \
             mock.patch.object(pin.signal, 'pthread_sigmask', return_value=set()) as masks, contextlib.redirect_stdout(self.output):
            with self.assertRaises(OSError):
                pin.main()
        self.assertEqual(pin_path.read_bytes(), old)
        self.assertEqual(manifest_path.read_bytes(), manifest)
        self.assertEqual(masks.call_count, 2)
        self.assertEqual(masks.call_args_list[0][0][0], signal.SIG_BLOCK)
        self.assertEqual(masks.call_args_list[1][0][0], signal.SIG_SETMASK)
        backup = next((target / 'backups').iterdir())
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((backup / 'release-pin.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual((backup / 'release-pin.json').read_bytes(), old)
        self.assertEqual((backup / 'manifest.json').read_bytes(), manifest)
        self.assertFalse(list(target.rglob('.rollback-*')))
        self.assert_private_output()

class ReleaseInstallerTests(Fixtures):
    def archive(self, files=None, extras=None, wrong_hash=False):
        files = files or {'dist/server.js': b'public-code', 'ui/dist/index.html': b'<html>'}
        manifest = json.dumps({name: sha(raw) for name, raw in files.items()}).encode()
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for name, raw in list(files.items()) + [('dashboard-manifest.json', manifest)]:
                info = tarfile.TarInfo(name); info.size = len(raw); archive.addfile(info, io.BytesIO(raw))
            for info, raw in extras or []:
                archive.addfile(info, io.BytesIO(raw))
        return output.getvalue(), 'f' * 64 if wrong_hash else sha(manifest)
    @contextlib.contextmanager
    def install_context(self, data, digest):
        base = self.base / 'releases'; base.mkdir(exist_ok=True)
        with mock.patch.object(installer, 'BASE', base), mock.patch.object(installer.os, 'getuid', return_value=1002), \
             mock.patch.object(installer.sys, 'argv', ['install', REVISION, digest]), \
             mock.patch.object(installer.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(data))), \
             contextlib.redirect_stdout(self.output):
            yield base
    def test_verified_release_only_no_runtime_commands_and_no_overwrite(self):
        data, digest = self.archive()
        with self.install_context(data, digest) as base:
            installer.main()
        destination = base / REVISION
        self.assertEqual((destination / 'dist/server.js').read_bytes(), b'public-code')
        self.assertEqual((destination / 'dist/server.js').stat().st_mode & 0o777, 0o644)
        self.assertFalse((base / ('.dashboard-staging-' + REVISION)).exists())
        with self.install_context(data, digest):
            with self.assertRaises(ValueError):
                installer.main()
        self.assertEqual((destination / 'dist/server.js').read_bytes(), b'public-code')
        self.assert_private_output()
    def test_manifest_mismatch_never_creates_release(self):
        data, digest = self.archive(wrong_hash=True)
        with self.install_context(data, digest) as base:
            with self.assertRaises(ValueError):
                installer.main()
        self.assertEqual(list(base.iterdir()), [])
    def test_traversal_duplicate_and_link_members_rejected(self):
        for kind in ['traversal', 'duplicate', 'symlink']:
            info = tarfile.TarInfo('../escape' if kind == 'traversal' else 'dist/server.js' if kind == 'duplicate' else 'linked')
            raw = b'x'; info.size = 1
            if kind == 'symlink':
                info.type = tarfile.SYMTYPE; info.linkname = '/etc/passwd'; info.size = 0; raw = b''
            data, digest = self.archive(extras=[(info, raw)])
            with self.subTest(kind=kind), self.install_context(data, digest) as base:
                with self.assertRaises(ValueError):
                    installer.main()
            self.assertEqual(list(base.iterdir()), [])
            self.assertFalse((self.base / 'escape').exists())
    def test_failed_publication_removes_only_its_staging_directory(self):
        data, digest = self.archive()
        actual_rename = Path.rename
        def fail_publish(path, target):
            if path.name.startswith('.dashboard-staging-'):
                raise OSError('synthetic publication failure')
            return actual_rename(path, target)
        with self.install_context(data, digest) as base, mock.patch.object(Path, 'rename', fail_publish):
            existing = base / 'existing'; existing.mkdir(); write(existing / 'keep', 'preserve')
            with self.assertRaises(OSError):
                installer.main()
        self.assertEqual((existing / 'keep').read_text(), 'preserve')
        self.assertEqual([p.name for p in base.iterdir()], ['existing'])

if __name__ == '__main__':
    unittest.main()
