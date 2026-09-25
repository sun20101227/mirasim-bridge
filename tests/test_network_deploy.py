import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

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
        self.cfg = {'manifest_url': 'https://example.test/deploy.json', 'image_repository': 'ghcr.io/example/mirasim',
                    'project_dir': str(self.root), 'state_dir': str(self.root / 'state'), 'health_timeout_sec': 10,
                    'targets': [{'name': 'main', 'compose_file': 'compose.yaml'}]}
        self.calls = []
        self.fail_pull = False
        self.version = '0.6.0'

    def tearDown(self):
        self.tmp.cleanup()

    def run_docker(self, args, timeout=180):
        self.calls.append(args)
        if args[:2] == ['docker', 'pull'] and self.fail_pull:
            raise RuntimeError('failed pull')
        if args[:2] == ['docker', 'run'] and args[-1] == '--version':
            return self.version
        if args[:3] == ['docker', 'image', 'inspect']:
            return OLD
        if args[:2] == ['docker', 'inspect']:
            return json.dumps({'State': {'Running': True}, 'Image': OLD})
        if args[:2] == ['docker', 'compose']:
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


if __name__ == '__main__':
    unittest.main()
