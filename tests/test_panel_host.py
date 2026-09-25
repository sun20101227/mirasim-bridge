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
