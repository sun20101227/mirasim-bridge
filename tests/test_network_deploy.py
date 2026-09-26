import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import time
import os
import shutil
import subprocess
from types import SimpleNamespace
from unittest.mock import patch
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('deploy_agent', Path(__file__).parents[1] / 'scripts/deploy-agent.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
IMAGE = 'ghcr.io/example/mirasim@sha256:' + 'a' * 64
OLD = 'sha256:' + 'b' * 64


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='mirasim-network-test-')
        self.root = Path(self.tmp.name)
        (self.root / 'compose.yaml').write_text('services: {}')
        (self.root / 'compose.profile.yaml').write_text('services: {}')
        (self.root / '.env.second').write_text('MIRASIM_PROFILE=second')
        self.host = self.root / 'opt'
        self.host.mkdir()
        (self.host / 'deploy-agent.py').write_text('OLD_AGENT = 1\n')
        (self.host / 'web').mkdir()
        (self.host / 'web' / 'app.js').write_text('old app')
        self.cfg = {'manifest_url': 'https://example.test/deploy.json', 'image_repository': 'ghcr.io/example/mirasim',
                    'project_dir': str(self.root), 'state_dir': str(self.root / 'state'), 'health_timeout_sec': 10,
                    'targets': [{'name': 'main', 'compose_file': 'compose.yaml'}], 'host_dir': str(self.host)}
        self.calls = []
        self.fail_pull = False
        self.version = '0.6.0'
        # What the new image carries at HOST_FILES paths; tests may alter it.
        self.image_files = {'deploy-agent.py': b'NEW_AGENT = 2\n', 'panel-host.py': b'PANEL = 1\n',
                            'web/index.html': b'<html>', 'web/app.js': b'new app', 'web/style.css': b'css', 'web/icon.png': b'PNG'}

    def tearDown(self):
        self.tmp.cleanup()

    def run_docker(self, args, timeout=180):
        self.calls.append(args)
        if args[:2] == ['docker', 'pull'] and self.fail_pull:
            raise RuntimeError('failed pull')
        if args[:2] == ['docker', 'run'] and args[-1] == '--version':
            return self.version
        if args[:2] == ['docker', 'create']:
            return 'e' * 64
        if args[:2] == ['docker', 'cp']:
            name = next(n for n, src in m.HOST_FILES.items() if args[2].endswith(':' + src))
            Path(args[3]).write_bytes(self.image_files[name])
            return ''
        if args[0] == 'systemd-run':
            return ''
        if args[:3] == ['docker', 'image', 'inspect']:
            return OLD
        if args[:2] == ['docker', 'inspect']:
            return json.dumps({'State': {'Running': True}, 'Image': OLD})
        if args[:2] == ['docker', 'compose']:
            if args[-1] == m.READY_JS:
                return json.dumps({'version': self.version, 'backend': 'relay', 'managed': True,
                                   'reachable': True, 'schedulable': 'on', 'upstream_ready': True})
            profile = any('compose.profile.yaml' in s for s in args)
            if args[-3:] == ['config', '--format', 'json']:
                return json.dumps({'name': 'second' if profile else 'main', 'services': {'bridge': {'image': m.LOCAL_IMAGE}}})
            if args[-3:] == ['ps', '-q', 'bridge']:
                return ('c' if profile else 'd') * 64
        return ''

    def agent(self):
        return m.Agent(self.cfg, run=self.run_docker, fetch=lambda *_: {'version': '0.6.0', 'image': IMAGE}, pause=lambda _: None)

    def test_digest_and_fixed_source(self):
        for image in ['ghcr.io/example/mirasim:latest', 'evil.test/mirasim@sha256:' + 'a' * 64, IMAGE + ';whoami']:
            with self.assertRaises(ValueError):
                m.validate_manifest({'version': '0.6.0', 'image': image}, self.cfg['image_repository'])
        for url in ['http://example.test/release', 'https://user:password@example.test/release', 'file:///tmp/release']:
            with self.assertRaises(ValueError):
                m.https_url(url)

    def test_success_prepares_before_stop_and_only_recreates_bridge(self):
        agent = self.agent()
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'succeeded')
        pull = next(i for i, c in enumerate(self.calls) if c[:2] == ['docker', 'pull'])
        stop = next(i for i, c in enumerate(self.calls) if c[-2:] == ['stop', 'bridge'])
        self.assertLess(pull, stop)
        self.assertTrue(any('--force-recreate' in c and c[-1] == 'bridge' for c in self.calls))
        self.assertFalse(any('down' in c or 'setup' in c for c in self.calls))
        self.assertNotIn('snapshots', agent.status())

    def test_pull_and_version_failures_leave_running_containers_unchanged(self):
        for fail, version in [(True, '0.6.0'), (False, '0.5.0')]:
            self.fail_pull, self.version, self.calls = fail, version, []
            agent = self.agent()
            agent.deploy()
            self.assertEqual(agent.status()['phase'], 'failed')
            self.assertFalse(any('stop' in c or c[:2] == ['docker', 'tag'] for c in self.calls))

    def test_failed_health_restores_previous_image(self):
        agent = self.agent()
        attempts = []
        def readiness(_):
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError('new release unhealthy')
        agent.ready = readiness
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'rolled_back')
        self.assertEqual(self.calls[-1], ['docker', 'tag', OLD, m.LOCAL_IMAGE])
        self.assertEqual(len(attempts), 2)

    def test_rollback_attempts_all_accounts_and_reports_failure(self):
        self.cfg['targets'].append({'name': 'second', 'compose_file': 'compose.profile.yaml', 'env_file': '.env.second'})
        agent = self.agent()
        checks = []
        def readiness(target):
            checks.append(target['name'])
            raise RuntimeError('not ready')
        agent.ready = readiness
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'rollback_failed')
        self.assertEqual(checks, ['main', 'main', 'second'])
        self.assertFalse(agent.start())  # Do not erase a failed recovery journal.

    def test_restart_recovers_journal_and_jobs_are_serialized(self):
        agent = self.agent()
        snapshots, tag = agent.snapshot()
        agent.save(phase='activating', snapshots=snapshots, previous_tag=tag)
        recovered = self.agent()
        recovered.lock.acquire()
        self.assertFalse(recovered.start())
        recovered.lock.release()
        recovered.start(recover=True)
        recovered.worker.join(5)
        self.assertEqual(recovered.status()['phase'], 'rolled_back')

    def test_stopped_accounts_stay_stopped(self):
        agent = self.agent()
        original = agent.run
        agent.run = lambda args, **kw: '' if args[-3:] == ['ps', '-q', 'bridge'] else original(args, **kw)
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'failed')
        self.assertFalse(any('--force-recreate' in c for c in self.calls))

    def test_http_auth_rejects_arbitrary_deployment_input(self):
        agent = self.agent()
        started = []
        agent.start = lambda recover=False: started.append(recover) or True
        server = ThreadingHTTPServer(('127.0.0.1', 0), m.handler(agent, 'test-' + 'a' * 32))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        def call(method, path, body=None, auth=True):
            connection = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            try:
                headers = {'Authorization': 'Bearer test-' + 'a' * 32} if auth else {}
                connection.request(method, path, body=body, headers=headers)
                result = connection.getresponse()
                result.read()
                return result.status
            finally:
                connection.close()
        try:
            self.assertEqual(call('POST', '/v1/deploy', auth=False), 401)
            self.assertEqual(call('POST', '/v1/deploy', '{"url":"https://evil.test"}'), 400)
            self.assertEqual(call('POST', '/v1/deploy', '{}'), 202)
            self.assertEqual(call('GET', '/v1/deploy/status'), 200)
            self.assertEqual(call('POST', '/v1/deploy/rollback'), 202)
            self.assertEqual(started, [False, True])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def remote(self, agent):
        now = int(time.time())
        agent.cfg['remote_control'] = {'repository': 'example/mirasim', 'target': 'main', 'enrolled_at': now - 100}
        return {'id': 'e' * 32, 'target': 'main', 'action': 'deploy', 'issued_at': now - 2, 'expires_at': now + 60}

    def test_remote_rejects_wrong_target_expired_future_and_arbitrary_fields(self):
        agent = self.agent()
        valid = self.remote(agent)
        invalid = [{'target': 'other'}, {'expires_at': int(time.time()) - 1},
                   {'issued_at': int(time.time()) + 60}, {'issued_at': 0},
                   {'expires_at': int(time.time()) + 10000}, {'action': 'shell'},
                   {'id': '../etc'}, {'issued_at': True}, {'url': 'https://evil.test'}]
        for override in invalid:
            with self.subTest(override=override), self.assertRaises(ValueError):
                m.validate_remote_command({**valid, **override}, agent.cfg['remote_control'])
        self.assertEqual(m.validate_remote_command(valid, agent.cfg['remote_control']), valid)
        for repository, target in [('example/mirasim', '../main'), ('evil/x/../y', 'main')]:
            with self.assertRaises(ValueError):
                m.remote_url(repository, target)

    def test_remote_consumes_once_across_restart_and_rejects_older_commands(self):
        agent = self.agent()
        data = self.remote(agent)
        poller = m.RemotePoller(agent, fetch=lambda _: data)
        self.assertTrue(poller.once())
        agent.worker.join(5)
        self.assertEqual(agent.status()['phase'], 'succeeded')
        previous_calls = len(self.calls)
        self.assertFalse(poller.once())
        restarted = self.agent()
        self.assertFalse(m.RemotePoller(restarted, fetch=lambda _: data).once())
        old = {**data, 'id': 'f' * 32, 'issued_at': data['issued_at'] - 1}
        self.assertFalse(m.RemotePoller(restarted, fetch=lambda _: old).once())
        self.assertEqual(len(self.calls), previous_calls)

    def test_remote_busy_command_remains_pending_and_network_failure_does_not_deploy(self):
        agent = self.agent()
        data = self.remote(agent)
        poller = m.RemotePoller(agent, fetch=lambda _: data)
        agent.lock.acquire()
        self.assertFalse(poller.once())
        self.assertNotIn('remote_command', agent.state)
        agent.lock.release()
        def offline(_):
            raise OSError('offline')
        with self.assertRaises(OSError):
            m.RemotePoller(agent, fetch=offline).once()
        self.assertFalse(self.calls)
        self.assertTrue(poller.once())
        agent.worker.join(5)

    def test_remote_claim_write_failure_cannot_start_work(self):
        agent = self.agent()
        data = self.remote(agent)
        with patch.object(m, 'atomic_json', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                m.RemotePoller(agent, fetch=lambda _: data).once()
        self.assertFalse(self.calls)
        self.assertIsNone(agent.worker)
        self.assertNotIn('remote_command', agent.state)
        self.assertTrue(agent.lock.acquire(blocking=False))
        agent.lock.release()
        self.assertTrue(m.RemotePoller(agent, fetch=lambda _: data).once())
        agent.worker.join(5)

    def test_remote_rollback_uses_existing_recovery_journal(self):
        agent = self.agent()
        data = self.remote(agent)
        data['action'] = 'rollback'
        poller = m.RemotePoller(agent, fetch=lambda _: data)
        self.assertFalse(poller.once())
        agent.deploy()
        self.assertTrue(poller.once())
        agent.worker.join(5)
        self.assertEqual(agent.state['phase'], 'rolled_back')
        self.assertFalse(poller.once())

    def test_enrollment_preserves_keys_profiles_and_rejects_active_deployment(self):
        agent = self.agent()
        cfg_file = self.root / 'agent.json'
        key = self.root / 'key'
        key.write_text('existing-secret')
        self.cfg['token_file'] = str(key)
        m.atomic_json(cfg_file, self.cfg)
        dest = self.root / 'helper.py'
        dest.write_text('old helper')
        args = SimpleNamespace(repository='example/mirasim', target='main')
        with patch.object(m, 'require_linux_root'):
            m.enable_remote(args, run=self.run_docker, config_file=cfg_file, destination=dest)
            first = json.loads(cfg_file.read_text())
            m.enable_remote(args, run=self.run_docker, config_file=cfg_file, destination=dest)
            self.assertEqual(first, json.loads(cfg_file.read_text()))
            self.assertEqual(first['targets'], self.cfg['targets'])
            self.assertEqual(key.read_text(), 'existing-secret')
            agent.save(phase='activating')
            with self.assertRaises(ValueError):
                m.enable_remote(args, run=self.run_docker, config_file=cfg_file, destination=dest)
        self.assertIn(['systemctl', 'restart', 'mirasim-deploy.service'], self.calls)

    def test_command_publisher_only_accepts_named_targets_and_fixed_actions(self):
        spec = importlib.util.spec_from_file_location('issue_command', Path(__file__).parents[1] / 'scripts/issue-deploy-command.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for target in ['../main', 'main;id', 'main\n', '']:
            with self.assertRaises(ValueError):
                module.make_command(target, 'deploy')
        with self.assertRaises(ValueError):
            module.make_command('main', 'shell')
        remote = {'target': 'main', 'enrolled_at': 90}
        result = module.make_command('main', 'deploy', now=100)
        self.assertEqual(m.validate_remote_command(result, remote, now=101), result)


class HostSelfUpdateTests(DeploymentTests):
    """One web click updates the containers and, from the same verified image, the host tools."""

    def test_success_installs_changed_host_files_backs_up_and_restarts_service(self):
        agent = self.agent()
        agent.deploy()
        status = agent.status()
        self.assertEqual(status['phase'], 'succeeded')
        self.assertTrue(status['host_updated'] and status['host_restart'])
        self.assertEqual((self.host / 'deploy-agent.py').read_bytes(), b'NEW_AGENT = 2\n')
        self.assertEqual((self.host / 'web' / 'app.js').read_bytes(), b'new app')
        self.assertEqual((self.host / 'panel-host.py').read_bytes(), b'PANEL = 1\n')
        backup = Path(agent.state['host_backup'])
        self.assertEqual((backup / 'deploy-agent.py').read_text(), 'OLD_AGENT = 1\n')
        self.assertFalse((backup / 'panel-host.py').exists(), 'files that did not exist before are not backed up')
        stage = next(i for i, c in enumerate(self.calls) if c[:2] == ['docker', 'cp'])
        stop = next(i for i, c in enumerate(self.calls) if c[-2:] == ['stop', 'bridge'])
        self.assertLess(stage, stop, 'host files are staged and validated before any container stops')
        self.assertTrue(any(c[:2] == ['docker', 'rm'] for c in self.calls))
        restart = self.calls[-1]
        self.assertEqual(restart[0], 'systemd-run')
        self.assertEqual(restart[-3:], ['systemctl', 'restart', 'mirasim-deploy.service'])
        self.assertLess(self.calls.index(restart), len(self.calls), 'restart is the very last step')
        self.assertFalse(list((self.root / 'state').glob('stage-*')), 'staging directory removed')

    def test_identical_host_files_skip_install_and_restart(self):
        for name, data in self.image_files.items():
            (self.host / name).parent.mkdir(parents=True, exist_ok=True)
            (self.host / name).write_bytes(data)
        agent = self.agent()
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'succeeded')
        self.assertFalse(agent.status()['host_updated'])
        self.assertFalse(any(c[0] == 'systemd-run' for c in self.calls))

    def test_unparsable_agent_in_image_fails_before_any_container_or_host_change(self):
        self.image_files['deploy-agent.py'] = b'def broken(:\n'
        agent = self.agent()
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'failed')
        self.assertEqual((self.host / 'deploy-agent.py').read_text(), 'OLD_AGENT = 1\n')
        self.assertFalse(any(c[-2:] == ['stop', 'bridge'] or c[:2] == ['docker', 'tag'] for c in self.calls))

    def test_rollback_restores_previous_host_tools_and_restarts(self):
        agent = self.agent()
        agent.deploy()
        self.calls = []
        agent.start(recover=True)
        agent.worker.join(5)
        self.assertEqual(agent.status()['phase'], 'rolled_back')
        self.assertEqual((self.host / 'deploy-agent.py').read_text(), 'OLD_AGENT = 1\n')
        self.assertEqual((self.host / 'web' / 'app.js').read_text(), 'old app')
        self.assertFalse((self.host / 'panel-host.py').exists(), 'a file added by the release is removed again')
        self.assertEqual(self.calls[-1][0], 'systemd-run')
        self.assertEqual(agent.status()['host_restored'], ['deploy-agent.py', 'panel-host.py', 'web/index.html', 'web/app.js', 'web/style.css', 'web/icon.png'])

    def test_container_failure_after_staging_leaves_host_tools_untouched(self):
        agent = self.agent()
        attempts = []
        def readiness(_):
            attempts.append(True)
            if len(attempts) == 1:
                raise RuntimeError('unhealthy')
        agent.ready = readiness
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'rolled_back')
        self.assertEqual((self.host / 'deploy-agent.py').read_text(), 'OLD_AGENT = 1\n')
        self.assertFalse(any(c[0] == 'systemd-run' for c in self.calls))

    def test_self_update_can_be_disabled(self):
        self.cfg['self_update'] = False
        agent = self.agent()
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'succeeded')
        self.assertFalse(any(c[:2] in (['docker', 'create'], ['docker', 'cp']) for c in self.calls))
        self.assertEqual((self.host / 'deploy-agent.py').read_text(), 'OLD_AGENT = 1\n')

    def test_recovery_reports_fixed_failure_codes_and_preserves_initial_failure(self):
        agent = self.agent()
        def readiness(target):
            raise m.DeploymentError('bridge_unresponsive')
        agent.ready = readiness
        agent.deploy()
        status = agent.status()
        self.assertEqual(status['failure'], {'step': 'check_health', 'code': 'bridge_unresponsive', 'target': 'main'})
        self.assertEqual(status['recovery_errors'], [{'step': 'restore_health', 'code': 'bridge_unresponsive', 'target': 'main'}])
        self.assertEqual(status['phase'], 'rollback_failed')

    def test_paused_or_upstream_unavailable_is_not_a_failed_code_deployment(self):
        agent = self.agent()
        run = agent.run
        def paused(args, **kw):
            if args[-1] == m.READY_JS:
                return json.dumps({'version': '0.6.0', 'backend': 'relay', 'managed': True, 'reachable': False,
                                   'schedulable': 'off', 'upstream_ready': False})
            return run(args, **kw)
        agent.run = paused
        agent.deploy()
        self.assertEqual(agent.status()['phase'], 'succeeded')
        self.assertEqual(agent.status()['target_health']['main']['schedulable'], 'off')


@unittest.skipUnless(shutil.which('node'), 'Node needed to execute the real readiness probe')
class ReadinessProbeTests(unittest.TestCase):
    def test_real_probe_accepts_local_status_without_requiring_upstream_and_rejects_invalid_response(self):
        payload = {'version': '0.8.3', 'backend': 'relay', 'relay': {'ready': False},
                   'sub2api': {'managed': False, 'reachable': False, 'schedulable': 'off'}}
        response_code = 200
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(response_code)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / 'config.json'
                file.write_text(json.dumps({'listen': {'host': '127.0.0.1', 'port': server.server_port}, 'bridge_secret': 'hidden-secret'}))
                env = {**os.environ, 'MIRASIM_CONFIG': str(file), 'MIRASIM_LISTEN_HOST': '127.0.0.1', 'MIRASIM_LISTEN_PORT': str(server.server_port)}
                def probe():
                    return subprocess.run(['node', '-e', m.READY_JS], env=env, capture_output=True, text=True, timeout=8)
                result = probe()
                self.assertEqual(result.returncode, 0)
                self.assertFalse(json.loads(result.stdout)['upstream_ready'])
                self.assertNotIn('hidden-secret', result.stdout)
                payload.update(backend='session', keepalive={'ready': True})
                self.assertEqual(probe().returncode, 0, 'session backend does not have relay.ready')
                response_code = 503
                self.assertNotEqual(probe().returncode, 0)
                response_code = 200
                payload.clear()
                self.assertNotEqual(probe().returncode, 0, 'empty success object is not a working bridge')
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
