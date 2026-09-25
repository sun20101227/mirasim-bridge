"""Authenticated host console. Fixed operations only, never a general Docker API."""
import hmac
import json
import secrets
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

ASSETS = {'/panel': ('index.html', 'text/html'), '/panel/': ('index.html', 'text/html'),
          '/panel/app.js': ('app.js', 'text/javascript'), '/panel/style.css': ('style.css', 'text/css')}
OPERATIONS = {'status', 'summary', 'models', 'model', 'test', 'profiles', 'groups', 'login/start', 'login/complete', 'login/status'}


def command_input(args, data, timeout=55):
    try:
        p = subprocess.run(args, input=json.dumps(data), text=True, capture_output=True, timeout=timeout)
        if p.returncode or len(p.stdout) > 2 * 1024 * 1024:
            raise ValueError()
        result = json.loads(p.stdout)
        if result.get('status') != 200:
            raise ValueError()
        return result['data']
    except Exception:
        raise ValueError('Bridge request failed; check login code, account status or upgrade the bridge') from None


class Console:
    def __init__(self, agent, persist, run_input=command_input):
        self.agent, self.persist, self.run_input = agent, persist, run_input
        self.audit_file = agent.state_file.parent / 'panel-events.json'
        self.events = []
        try:
            self.events = json.loads(self.audit_file.read_text())[-100:]
        except (OSError, ValueError):
            pass
        self.event_lock = threading.Lock()

    def audit(self, action, target, ok):
        with self.event_lock:
            self.events.append({'at': int(time.time()), 'action': action, 'target': target, 'ok': ok})
            self.events = self.events[-100:]
            self.persist(self.audit_file, self.events)

    def target(self, name):
        return next((t for t in self.agent.targets if t['name'] == name), None)

    def bridge(self, target, operation, data=None):
        if target is None:
            raise ValueError('Unknown target')
        argv = ['docker', 'compose', '--project-directory', str(self.agent.project)]
        if target.get('env_file'):
            argv += ['--env-file', str(self.agent.project / target['env_file'])]
        argv += ['-f', str(self.agent.project / target['compose_file']), 'exec', '-T', 'bridge', 'node', '/app/scripts/panel-bridge.js']
        return self.run_input(argv, {'operation': operation, 'data': data or {}})

    def topology(self):
        main = self.target('main')
        resolved = json.loads(self.agent.compose(main, 'config', '--format', 'json'))
        service = resolved['services']['bridge']
        if service.get('image') != 'mirasim-bridge:local':
            raise ValueError('Use the standard bridge image')
        if service.get('network_mode') == 'host':
            return resolved, None
        network = resolved.get('networks', {}).get('upstream', {}).get('name')
        if not network:
            raise ValueError('Unsupported network topology')
        return resolved, network

    def login_options(self, data):
        import re
        profile = data.get('profile', '')
        if not isinstance(profile, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', profile) or profile == 'main':
            raise ValueError('Invalid profile name')
        if self.target(profile):
            raise ValueError('Profile target already exists')
        _, network = self.topology()
        port = 8787 if network else data.get('port')
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError('Choose an unused host port from 1024 to 65535')
        host = 'mirasim-' + profile if network else '127.0.0.1'
        return {**data, 'profile': profile, 'port': port, 'public_base_url': f'http://{host}:{port}'}

    def attach(self, profile):
        # Profile must be a saved credential/config, not data supplied by a browser.
        info = self.bridge(self.target('main'), 'profile/info', {'profile': profile})
        if self.target(profile):
            raise ValueError('Profile already managed; use Start')
        expected = self.login_options({'profile': profile, 'port': info['port']})
        if info['public_base_url'] != expected['public_base_url']:
            raise ValueError('Saved profile topology does not match this host')
        resolved, network = self.topology()
        volumes = resolved['services']['bridge'].get('volumes', [])
        mount = next((v for v in volumes if isinstance(v, dict) and v.get('target') == '/data' and v.get('type') == 'volume'), None)
        if not mount:
            raise ValueError('Profile activation requires the standard named data volume')
        volume = resolved['volumes'][mount['source']]['name']
        name = 'panel-profile-' + profile + '.json'
        file = self.agent.project / name
        cfgpath = '/data/profiles/' + profile + '/config.json'
        service = {'image': 'mirasim-bridge:local', 'user': '1000:1000', 'init': True, 'read_only': True,
                   'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'restart': 'unless-stopped',
                   'stop_grace_period': '180s', 'environment': {'MIRASIM_CONFIG': cfgpath},
                   'command': ['serve', '--config', cfgpath], 'volumes': ['data:/data'],
                   'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}}
        config = {'name': 'mirasim-profile-' + profile, 'services': {'bridge': service},
                  'volumes': {'data': {'external': True, 'name': volume}}}
        if network:
            service['networks'] = {'upstream': {'aliases': ['mirasim-' + profile]}, 'egress': {}}
            config['networks'] = {'upstream': {'external': True, 'name': network}, 'egress': {}}
        else:
            service['network_mode'] = 'host'
            import socket
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', info['port']))
        if file.exists():
            if json.loads(file.read_text()) != config:
                raise ValueError('Generated Compose filename already exists with different content')
        else:
            self.persist(file, config)
        target = {'name': profile, 'compose_file': name}
        self.agent.compose(target, 'config', '--quiet')
        next_cfg = {**self.agent.cfg, 'targets': [*self.agent.targets, target]}
        self.persist(Path(self.agent.cfg['_config_file']), {k: v for k, v in next_cfg.items() if not k.startswith('_')})
        self.agent.cfg.update(next_cfg)
        self.agent.targets = next_cfg['targets']
        self.agent.compose(target, 'up', '-d', '--no-build', '--pull', 'never', 'bridge')
        return {'started': True, 'target': profile, 'message': 'Container started; verify scheduling in Accounts'}

    def call(self, body):
        op, name, data = body.get('operation'), body.get('target', 'main'), body.get('data', {})
        if not isinstance(data, dict) or not isinstance(name, str):
            raise ValueError('Invalid request')
        if op == 'targets':
            return [{'name': t['name']} for t in self.agent.targets]
        if op == 'deployment':
            return self.agent.status()
        if op == 'events':
            return self.events[-50:]
        if op in ('deploy', 'rollback'):
            accepted = self.agent.start(recover=op == 'rollback')
            self.audit(op, 'all', accepted)
            return {'accepted': accepted, **self.agent.status()}
        if op not in OPERATIONS | {'start', 'stop', 'attach'}:
            raise ValueError('Unknown operation')
        if not self.agent.lock.acquire(blocking=False):
            raise ValueError('Another management operation is in progress')
        try:
            if self.agent.state.get('phase') == 'rollback_failed':
                raise ValueError('Recover the failed rollback first')
            if op == 'attach':
                result = self.attach(data.get('profile'))
            elif op in ('start', 'stop'):
                target = self.target(name)
                if not target:
                    raise ValueError('Unknown target')
                if op == 'start':
                    self.agent.compose(target, 'up', '-d', '--no-build', '--pull', 'never', 'bridge')
                else:
                    self.agent.compose(target, 'stop', 'bridge', timeout=210)
                result = {'completed': True}
            else:
                if op in ('login/start', 'login/complete', 'login/status', 'profiles') and name != 'main':
                    raise ValueError('Add profiles through the main account')
                if op == 'login/start':
                    data = self.login_options(data)
                result = self.bridge(self.target(name), op, data)
            if op not in {'status', 'summary', 'models', 'profiles', 'groups', 'login/status'}:
                self.audit(op, name, True)
            return result
        except Exception:
            self.audit(op, name, False)
            raise
        finally:
            self.agent.lock.release()


def handler(agent, token, fallback, persist):
    panel = agent.cfg['panel']
    origin = panel['origin']
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Panel origin must be an HTTPS origin without a path')
    console = Console(agent, persist)
    failures, auth_lock = [], threading.Lock()

    class Handler(fallback):
        def panel_reply(self, code, data):
            self.reply(code, data)

        def do_GET(self):
            route = '/panel' if self.path == '/' else self.path
            if route not in ASSETS:
                return super().do_GET()
            file, mime = ASSETS[route]
            assets = Path(__file__).parent / 'web'
            if not assets.is_dir():
                assets = Path(__file__).parents[1] / 'web'
            raw = (assets / file).read_bytes()
            if file == 'index.html':
                raw = raw.replace(b'data-mode="bridge"', b'data-mode="host"')
            self.send_response(200)
            for key, value in {'Content-Type': mime + '; charset=utf-8', 'Content-Length': str(len(raw)),
                               'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                               'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"}.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            if self.path != '/panel/api':
                return super().do_POST()
            if self.headers.get('Origin') != origin or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.panel_reply(403, {'error': 'Origin or content type rejected'})
            with auth_lock:
                failures[:] = [t for t in failures if time.monotonic() - t < 60]
                if len(failures) >= 20:
                    return self.panel_reply(429, {'error': 'Too many login attempts; wait one minute'})
                key = self.headers.get('X-Panel-Key', '')
                if len(self.headers.get_all('X-Panel-Key', [])) != 1 or not hmac.compare_digest(key.encode(), token.encode()):
                    failures.append(time.monotonic())
                    return self.panel_reply(401, {'error': 'Invalid panel key'})
            try:
                lengths = self.headers.get_all('Content-Length', [])
                size = int(lengths[0]) if len(lengths) == 1 else -1
                if self.headers.get('Transfer-Encoding') or not 0 <= size <= 160000:
                    raise ValueError('Invalid request size')
                raw = self.rfile.read(size)
                if len(raw) != size:
                    raise ValueError('Incomplete request')
                data = json.loads(raw)
                if not isinstance(data, dict) or set(data) - {'operation', 'target', 'data'}:
                    raise ValueError('Invalid request fields')
                self.panel_reply(200, console.call(data))
            except Exception:
                self.panel_reply(400, {'error': '操作未完成：检查验证码/参数、账号是否运行，或稍后重试。升级时请等待完成。'})
    return Handler
