import importlib.util
import json
from pathlib import Path
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import threading
import unittest
from unittest.mock import patch
import test_network_deploy as fixtures
m = fixtures.m

spec = importlib.util.spec_from_file_location('panel_host', Path(__file__).parents[1] / 'scripts/panel-host.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PanelHostTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.DeploymentTests()
        self.fixture.setUp()
        self.agent = self.fixture.agent()
        self.agent.cfg['panel'] = {'origin': 'https://panel.example'}

    def tearDown(self):
        self.fixture.tearDown()

    def test_http_origin_auth_and_no_arbitrary_commands(self):
        cls = p.handler(self.agent, 'a' * 64, m.handler(self.agent, 'b' * 64), m.atomic_json)
        server = ThreadingHTTPServer(('127.0.0.1', 0), cls)
        thread = threading.Thread(target=server.serve_forever); thread.start()
        def call(data, origin='https://panel.example', key='a' * 64):
            c = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            c.request('POST', '/panel/api', json.dumps(data), {'Content-Type': 'application/json', 'Origin': origin, 'X-Panel-Key': key})
            r = c.getresponse(); result = (r.status, json.loads(r.read())); c.close(); return result
        try:
            self.assertEqual(call({'operation': 'targets'})[0], 200)
            self.assertEqual(call({'operation': 'targets'}, key='b' * 64)[0], 401)
            self.assertEqual(call({'operation': 'deploy'}, origin='https://evil.test')[0], 403)
            self.assertEqual(call({'operation': 'shell', 'data': {'cmd': 'id'}})[0], 400)
            self.assertFalse(self.fixture.calls)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_release_check_is_cached_readonly_and_hides_errors(self):
        calls = []
        def fetch(url, repository):
            calls.append((url, repository))
            return {'version': '9.9.9', 'image': repository + '@sha256:' + '0' * 64}
        self.agent.fetch = fetch
        console = p.Console(self.agent, m.atomic_json)
        self.assertEqual(console.call({'operation': 'release/check'})['latest'], '9.9.9')
        self.assertEqual(console.call({'operation': 'release/check'})['latest'], '9.9.9')
        self.assertEqual(len(calls), 1, 'second check within 60 s is served from cache')
        self.assertEqual(calls[0][0], self.agent.cfg['manifest_url'])
        self.assertFalse(self.fixture.calls, 'no Docker command is run')
        fresh = console.call({'operation': 'release/check', 'data': {'force': True}})
        self.assertEqual(len(calls), 2, 'manual refresh bypasses the 60 second cache')
        self.assertFalse(fresh['cached'])
        self.assertEqual(fresh['source'], {'kind': 'custom'})
        console.release_cache = None
        self.agent.fetch = lambda *_: (_ for _ in ()).throw(OSError('network detail'))
        with self.assertRaisesRegex(ValueError, 'Release manifest unavailable'):
            console.call({'operation': 'release/check'})

    def test_follow_latest_preserves_installed_config_and_cannot_change_repository(self):
        self.agent.cfg['manifest_url'] = 'https://github.com/example/mirasim/releases/download/v0.8.2/deploy.json'
        file = self.fixture.root / 'host-config.json'
        stored = {**self.agent.cfg, 'panel': {'origin': 'https://panel.example', 'token_file': 'keep-panel-key'}}
        m.atomic_json(file, stored)
        self.agent.cfg['_config_file'] = str(file)
        console = p.Console(self.agent, m.atomic_json)
        self.agent.lock.acquire()
        try:
            with self.assertRaisesRegex(ValueError, 'Wait'):
                console.call({'operation': 'release/follow-latest', 'data': {'confirm': True}})
        finally:
            self.agent.lock.release()
        with self.assertRaises(ValueError):
            console.call({'operation': 'release/follow-latest', 'data': {'confirm': True, 'url': 'https://evil.test'}})
        result = console.call({'operation': 'release/follow-latest', 'data': {'confirm': True}})
        self.assertEqual(result['source']['kind'], 'github_latest')
        after = json.loads(file.read_text())
        self.assertEqual(after, {**stored, 'manifest_url': 'https://github.com/example/mirasim/releases/latest/download/deploy.json'})

    def test_failed_recovery_keeps_diagnostics_readable_but_blocks_mutations(self):
        self.agent.save(phase='rollback_failed')
        calls = []
        console = p.Console(self.agent, m.atomic_json, run_input=lambda argv, data: calls.append(data) or {'ok': True})
        for op in ['status', 'summary', 'models', 'profiles', 'groups', 'accounts', 'logs']:
            self.assertTrue(console.call({'operation': op})['ok'])
        self.assertEqual(len(calls), 7)
        for op in ['login/start', 'account/host', 'settings', 'start']:
            with self.assertRaisesRegex(ValueError, 'Recover the failed rollback'):
                console.call({'operation': op})

    def test_deploy_audit_reports_acceptance_not_completion(self):
        self.agent.start = lambda recover=False: True
        console = p.Console(self.agent, m.atomic_json)
        self.assertTrue(console.call({'operation': 'deploy'})['accepted'])
        self.assertEqual(console.events[-1]['action'], 'deploy/requested')

    def test_github_is_forwarded_without_replacing_the_provider(self):
        calls = []
        console = p.Console(self.agent, m.atomic_json, run_input=lambda argv, data: calls.append(data) or {})
        console.call({'operation': 'login/start', 'data': {'hosted': True, 'profile': 'github-account', 'provider': 'github'}})
        self.assertEqual(calls[0]['data']['provider'], 'github')

    def test_usage_read_is_available_during_deployment_and_pricing_is_a_mutation(self):
        calls = []
        console = p.Console(self.agent, m.atomic_json, run_input=lambda argv, data: calls.append(data) or {'ok': True})
        self.agent.lock.acquire()
        try:
            self.assertTrue(console.call({'operation': 'usage', 'data': {'account': 'second', 'days': 7}})['ok'])
            self.assertEqual(calls[0]['data']['account'], 'second')
            with self.assertRaises(ValueError):
                console.call({'operation': 'usage/pricing', 'data': {'model': 'test', 'rates': {}}})
        finally:
            self.agent.lock.release()
        self.assertTrue(console.call({'operation': 'usage/pricing', 'data': {'model': 'test', 'rates': {}}})['ok'])

    def test_repair_preserves_container_snapshots_but_does_not_restore_stale_host_code(self):
        spec = importlib.util.spec_from_file_location('install_panel', Path(__file__).parents[1] / 'scripts/install-panel.py')
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        snapshots, tag = self.agent.snapshot()
        self.agent.save(phase='rollback_failed', snapshots=snapshots, previous_tag=tag, host_backup='old-host', host_changed=['deploy-agent.py'])
        installer.prepare_recovery(self.agent)
        self.assertEqual(self.agent.state['phase'], 'rolling_back')
        self.assertEqual(self.agent.state['snapshots'], snapshots)
        self.assertEqual(self.agent.state['previous_tag'], tag)
        self.assertIsNone(self.agent.state['host_backup'])
        self.assertEqual(self.agent.state['host_changed'], [])
        with self.assertRaisesRegex(ValueError, 'Repair requires'):
            installer.prepare_recovery(self.agent)

    def test_background_read_does_not_block_oauth_completion_or_release_mutation_lock(self):
        reading, finish = threading.Event(), threading.Event()
        def bridge(args, data):
            if data['operation'] == 'summary':
                reading.set(); finish.wait(3)
            return {'stage': 'saved'}
        console = p.Console(self.agent, m.atomic_json, run_input=bridge)
        thread = threading.Thread(target=lambda: console.call({'operation': 'summary'}))
        thread.start()
        try:
            self.assertTrue(reading.wait(2))
            self.assertFalse(self.agent.lock.locked(), 'refresh must not acquire mutation mutex')
            self.assertEqual(console.call({'operation': 'login/complete'})['stage'], 'saved')
            self.agent.lock.acquire()
            try:
                self.assertEqual(console.call({'operation': 'login/status'})['stage'], 'saved')
                self.assertTrue(self.agent.lock.locked(), 'read must not release another operation lock')
                with self.assertRaises(ValueError):
                    console.call({'operation': 'login/complete'})
            finally:
                self.agent.lock.release()
        finally:
            finish.set(); thread.join(3)

    def test_bridge_input_uses_stdin_and_only_selected_target(self):
        calls = []
        console = p.Console(self.agent, m.atomic_json, run_input=lambda argv, data: calls.append((argv, data)) or {})
        console.call({'operation': 'login/complete', 'data': {'id': 'abc', 'code': '123456'}})
        self.assertNotIn('123456', ' '.join(calls[0][0]))
        self.assertEqual(calls[0][1]['data']['code'], '123456')
        with self.assertRaises(ValueError):
            console.call({'operation': 'status', 'target': '../bad'})
        self.agent.lock.acquire()
        with self.assertRaises(ValueError):
            console.call({'operation': 'start'})
        self.agent.lock.release()

    def test_attach_uses_fixed_volume_network_image_and_preserves_target_config(self):
        self.agent.cfg['_config_file'] = str(self.fixture.root / 'agent.json')
        console = p.Console(self.agent, m.atomic_json)
        resolved = {'services': {'bridge': {'image': 'mirasim-bridge:local', 'volumes': [{'type': 'volume', 'source': 'data', 'target': '/data'}]}}, 'networks': {'upstream': {'name': 'sub2_default'}}, 'volumes': {'data': {'name': 'mirasim-bridge_data'}}}
        console.topology = lambda: (resolved, 'sub2_default')
        console.bridge = lambda *_: {'port': 8787, 'public_base_url': 'http://mirasim-second:8787'}
        out = console.call({'operation': 'attach', 'data': {'profile': 'second'}})
        self.assertTrue(out['started'])
        saved = json.loads((self.fixture.root / 'panel-profile-second.json').read_text())
        self.assertEqual(saved['services']['bridge']['image'], m.LOCAL_IMAGE)
        self.assertEqual(saved['services']['bridge']['environment']['MIRASIM_CONFIG'], '/data/profiles/second/config.json')
        self.assertNotIn('docker.sock', json.dumps(saved))
        self.assertEqual(len(json.loads(Path(self.agent.cfg['_config_file']).read_text())['targets']), 2)
        with self.assertRaises(ValueError):
            console.call({'operation': 'attach', 'data': {'profile': 'second'}})

    def test_login_target_and_topology_are_not_caller_controlled(self):
        console = p.Console(self.agent, m.atomic_json)
        console.topology = lambda: ({}, 'network')
        x = console.login_options({'profile': 'third', 'public_base_url': 'https://evil.test', 'port': 22})
        self.assertEqual(x['public_base_url'], 'http://mirasim-third:8787')
        for value in ['../bad', 'main', 'bad\n', None]:
            with self.assertRaises(ValueError):
                console.login_options({'profile': value})
