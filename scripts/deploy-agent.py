#!/usr/bin/env python3
"""Host-side deployment API for an existing Docker Compose bridge installation."""
import argparse
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

LOCAL_IMAGE = 'mirasim-bridge:local'
ACTIVE = {'checking', 'pulling', 'activating', 'rolling_back'}
READY_JS = r"""
const fs=require('fs'), http=require('http');
const c=JSON.parse(fs.readFileSync(process.env.MIRASIM_CONFIG||'/data/config.json','utf8'));
let host=process.env.MIRASIM_LISTEN_HOST||c.listen.host;
if(['0.0.0.0','::'].includes(host))host='127.0.0.1';
const r=http.get({host,port:Number(process.env.MIRASIM_LISTEN_PORT||c.listen.port),path:'/__status',
headers:{'x-api-key':process.env.MIRASIM_BRIDGE_SECRET||c.bridge_secret}},res=>{
let raw='';res.on('data',d=>{raw+=d;if(raw.length>1048576)r.destroy()});
res.on('end',()=>{try{const s=JSON.parse(raw);process.exit(res.statusCode===200&&s.sub2api.managed&&
s.sub2api.reachable&&s.sub2api.schedulable==='on'&&s.relay?.ready?0:1)}catch{process.exit(1)}});
});
r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exit(1));
setTimeout(()=>process.exit(1),4000).unref();
"""


def atomic_json(file, data):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = file.with_name(file.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, file)
        if os.name == 'posix':
            directory_fd = os.open(str(file.parent), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temp.exists():
            temp.unlink()


def https_url(value):
    u = urlsplit(value)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.fragment:
        raise ValueError('A credential-free HTTPS URL is required')
    return value


class HTTPSRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        https_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_manifest(url, repository):
    with build_opener(HTTPSRedirects()).open(https_url(url), timeout=30) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('Release manifest too large')
    return validate_manifest(json.loads(raw), repository)


def validate_manifest(data, repository):
    if not isinstance(data, dict) or not re.fullmatch(r'\d+\.\d+\.\d+', str(data.get('version', ''))):
        raise ValueError('Invalid release version')
    if not re.fullmatch(re.escape(repository) + r'@sha256:[0-9a-f]{64}', str(data.get('image', ''))):
        raise ValueError('Release must pin a digest in the configured image repository')
    return {key: data[key] for key in ('version', 'image')}


def remote_url(repository, target):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Expected GitHub owner/repository')
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', target):
        raise ValueError('Invalid remote target')
    return f'https://raw.githubusercontent.com/{repository}/deploy-control/remote-control/{target}.json'


def validate_remote_command(data, remote, now=None):
    now = int(time.time()) if now is None else now
    if not isinstance(data, dict) or set(data) != {'id', 'target', 'action', 'issued_at', 'expires_at'}:
        raise ValueError('Invalid remote command fields')
    if not re.fullmatch(r'[0-9a-f]{32}', str(data['id'])) or data['target'] != remote['target']:
        raise ValueError('Invalid remote command identity')
    if data['action'] not in ('deploy', 'rollback'):
        raise ValueError('Unsupported remote action')
    issued, expiry = data['issued_at'], data['expires_at']
    if type(issued) is not int or type(expiry) is not int:
        raise ValueError('Invalid remote command timestamps')
    if not remote['enrolled_at'] <= issued <= now or not issued < expiry <= issued + 900 or now >= expiry:
        raise ValueError('Remote command is expired, predates enrollment, or is from the future')
    return dict(data)


def fetch_remote_command(remote):
    from urllib.request import Request
    url = remote_url(remote['repository'], remote['target'])
    req = Request(url + '?poll=' + str(int(time.time())), headers={'Cache-Control': 'no-cache'})
    with build_opener(HTTPSRedirects()).open(req, timeout=20) as response:
        raw = response.read(4097)
    if len(raw) > 4096:
        raise ValueError('Remote command too large')
    return json.loads(raw)


class RemotePoller:
    def __init__(self, agent, fetch=fetch_remote_command):
        self.agent, self.fetch = agent, fetch

    def once(self):
        remote = self.agent.cfg['remote_control']
        data = validate_remote_command(self.fetch(remote), remote)
        return self.agent.start(recover=data['action'] == 'rollback', remote_command=data)

    def run(self, stopped):
        previous_error = None
        while not stopped.is_set():
            try:
                if self.once():
                    print('Remote deployment command accepted', flush=True)
                previous_error = None
            except Exception as exc:
                # 404 is normal before the first command. Never log the response body.
                label = type(exc).__name__
                if getattr(exc, 'code', None) != 404 and label != previous_error:
                    print('Remote command check failed:', label, flush=True)
                previous_error = label
            stopped.wait(self.agent.cfg['remote_control'].get('interval_sec', 30))


def command(args, timeout=180):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('Docker command unavailable or timed out') from None
    if result.returncode:
        # Compose output can contain expanded environment variables and secrets.
        raise RuntimeError('Docker operation failed; inspect the service locally')
    return result.stdout.strip()


class Agent:
    def __init__(self, config, run=command, fetch=fetch_manifest, pause=time.sleep):
        self.cfg, self.run, self.fetch, self.pause = config, run, fetch, pause
        https_url(config['manifest_url'])
        if not re.fullmatch(r'[a-z0-9.-]+(?::\d+)?/[a-z0-9._/-]+', config['image_repository']):
            raise ValueError('Invalid image repository')
        self.project = Path(config['project_dir']).resolve(strict=True)
        self.state_file = Path(config['state_dir']) / 'state.json'
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {'phase': 'idle'}
        self.lock, self.data_lock = threading.Lock(), threading.RLock()
        self.worker = None
        self.targets = config['targets']
        if not self.targets or len(self.targets) > 32:
            raise ValueError('Configure between 1 and 32 bridge targets')
        names = []
        for target in self.targets:
            name = target['name']
            if not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', name) or name in names:
                raise ValueError('Target names must be unique')
            names.append(name)
            for field in ('compose_file', 'env_file'):
                if target.get(field):
                    p = (self.project / target[field]).resolve(strict=True)
                    if self.project not in p.parents or not p.is_file():
                        raise ValueError('Target file must be inside the project directory')
        if not 10 <= config.get('health_timeout_sec', 180) <= 600:
            raise ValueError('health_timeout_sec must be 10..600')
        if config.get('remote_control'):
            remote = config['remote_control']
            remote_url(remote['repository'], remote['target'])
            if type(remote.get('enrolled_at')) is not int or remote['enrolled_at'] < 1:
                raise ValueError('Remote enrollment timestamp required')
            if not 10 <= remote.get('interval_sec', 30) <= 300:
                raise ValueError('Remote interval must be 10..300 seconds')

    def save(self, **patch):
        with self.data_lock:
            updated = {**self.state, **patch, 'updated_at': int(time.time())}
            atomic_json(self.state_file, updated)
            self.state = updated

    def status(self):
        with self.data_lock:
            return {k: self.state[k] for k in ('phase', 'job_id', 'version', 'updated_at', 'error', 'remote_command') if k in self.state}

    def compose(self, target, *args, timeout=180):
        argv = ['docker', 'compose', '--project-directory', str(self.project)]
        if target.get('env_file'):
            argv += ['--env-file', str(self.project / target['env_file'])]
        argv += ['-f', str(self.project / target['compose_file'])]
        return self.run(argv + list(args), timeout=timeout)

    def snapshot(self):
        items, projects = [], set()
        for target in self.targets:
            resolved = json.loads(self.compose(target, 'config', '--format', 'json'))
            if resolved['services']['bridge']['image'] != LOCAL_IMAGE:
                raise ValueError('This updater requires the standard mirasim-bridge:local image tag')
            if resolved['name'] in projects:
                raise ValueError('Targets must refer to separate Compose projects')
            projects.add(resolved['name'])
            container = self.compose(target, 'ps', '-q', 'bridge')
            if not container:
                continue  # Preserve intentionally stopped accounts.
            if not re.fullmatch(r'[0-9a-f]{12,64}', container):
                raise ValueError('Expected one bridge container per target')
            info = json.loads(self.run(['docker', 'inspect', '--format', '{{json .}}', container]))
            if info['State']['Running']:
                items.append({'target': dict(target), 'image': info['Image']})
        if not items:
            raise ValueError('No running bridge targets; finish initial setup first')
        tag = self.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', LOCAL_IMAGE])
        return items, tag

    def ready(self, target):
        end = time.monotonic() + self.cfg.get('health_timeout_sec', 180)
        while time.monotonic() < end:
            try:
                self.compose(target, 'exec', '-T', 'bridge', 'node', '-e', READY_JS, timeout=10)
                return
            except RuntimeError:
                self.pause(3)
        raise RuntimeError('Bridge registration/readiness did not recover in time')

    def rollback(self):
        self.save(phase='rolling_back')
        failed = False
        for item in self.state['snapshots']:
            try:
                self.run(['docker', 'tag', item['image'], LOCAL_IMAGE])
                self.compose(item['target'], 'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'bridge')
                self.ready(item['target'])
            except Exception:
                failed = True  # Attempt all accounts even if one cannot recover.
        try:
            self.run(['docker', 'tag', self.state['previous_tag'], LOCAL_IMAGE])
        except Exception:
            failed = True
        self.save(phase='rollback_failed' if failed else 'rolled_back',
                  error='Recovery incomplete; check containers locally' if failed else None)

    def deploy(self):
        changed = False
        try:
            manifest = self.fetch(self.cfg['manifest_url'], self.cfg['image_repository'])
            manifest = validate_manifest(manifest, self.cfg['image_repository'])
            self.save(phase='pulling', version=manifest['version'])
            self.run(['docker', 'pull', manifest['image']], timeout=1200)
            version = self.run(['docker', 'run', '--rm', '--network', 'none', manifest['image'], '--version'])
            if version != manifest['version']:
                raise ValueError('Image version differs from release manifest')
            self.run(['docker', 'run', '--rm', '--network', 'none', manifest['image'], 'selftest'])
            snapshots, previous = self.snapshot()
            # Journal before the first mutation; a restarted agent can recover.
            self.save(phase='activating', snapshots=snapshots, previous_tag=previous)
            changed = True
            self.run(['docker', 'tag', manifest['image'], LOCAL_IMAGE])
            for item in snapshots:
                self.compose(item['target'], 'stop', 'bridge', timeout=210)
                self.compose(item['target'], 'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'bridge')
                self.ready(item['target'])
            self.save(phase='succeeded', error=None)
        except Exception:
            if changed:
                self.rollback()
            else:
                self.save(phase='failed', error='Release preparation failed; running containers unchanged')

    def start(self, recover=False, remote_command=None):
        if not self.lock.acquire(blocking=False):
            return False
        try:
            if (recover and not self.state.get('snapshots')) or (not recover and self.state.get('phase') == 'rollback_failed'):
                self.lock.release()
                return False
            patch = {}
            if remote_command is not None:
                remote_command = validate_remote_command(remote_command, self.cfg['remote_control'])
                last = self.state.get('remote_command', {})
                if remote_command['issued_at'] <= last.get('issued_at', 0):
                    self.lock.release()
                    return False
                patch['remote_command'] = remote_command
            if not recover:
                patch.update(phase='checking', job_id=secrets.token_hex(12), version=None, error=None)
            elif remote_command is not None:
                patch.update(phase='rolling_back', job_id=secrets.token_hex(12), error=None)
            if patch:
                # Claim durably before starting work: a restart cannot replay a command.
                self.save(**patch)
            def work():
                try:
                    self.rollback() if recover else self.deploy()
                finally:
                    self.lock.release()
            self.worker = threading.Thread(target=work, daemon=False)
            self.worker.start()
            return True
        except Exception:
            self.lock.release()
            raise


def handler(agent, token):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_):
            pass

        def reply(self, code, data):
            raw = json.dumps(data).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            provided = self.headers.get('Authorization', '').encode()
            if len(self.headers.get_all('Authorization', [])) != 1 or not hmac.compare_digest(provided, ('Bearer ' + token).encode()):
                self.reply(401, {'error': 'unauthorized'})
                return False
            return True

        def do_GET(self):
            if self.authorized():
                self.reply(200, agent.status()) if self.path == '/v1/deploy/status' else self.reply(404, {'error': 'not found'})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path not in ('/v1/deploy', '/v1/deploy/rollback'):
                return self.reply(404, {'error': 'not found'})
            # The caller cannot supply commands, images, paths, or download URLs.
            if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Length', '0') not in ('0', '2'):
                return self.reply(400, {'error': 'only an empty body or {} is accepted'})
            if self.headers.get('Content-Length') == '2' and self.rfile.read(2) != b'{}':
                return self.reply(400, {'error': 'only {} is accepted'})
            try:
                started = agent.start(recover=self.path.endswith('/rollback'))
                self.reply(202 if started else 409, agent.status())
            except Exception:
                self.reply(500, {'error': 'deployment journal unavailable'})
    return Handler


def serve(config):
    import fcntl
    agent = Agent(config)
    agent.state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_file = open(agent.state_file.parent / 'agent.lock', 'a')
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    token = Path(config['token_file']).read_text().strip()
    if len(token) < 32:
        raise ValueError('Deployment token must have at least 32 characters')
    # A reverse proxy/SSH tunnel owns external TLS; never expose plaintext here.
    selected = handler(agent, token)
    if config.get('panel'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('panel_host', Path(__file__).with_name('panel-host.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        panel_token = Path(config['panel']['token_file']).read_text().strip()
        if not re.fullmatch(r'[a-f0-9]{64}', panel_token):
            raise ValueError('Invalid panel key')
        selected = module.handler(agent, panel_token, selected, atomic_json)
    server = ThreadingHTTPServer(('127.0.0.1', config.get('port', 8790)), selected)
    if agent.state.get('phase') in ('activating', 'rolling_back'):
        agent.start(recover=True)
    elif agent.state.get('phase') in ACTIVE:
        agent.save(phase='failed', error='Release preparation interrupted; containers unchanged')
    stopped = threading.Event()
    poller = None
    if config.get('remote_control'):
        poller = threading.Thread(target=RemotePoller(agent).run, args=(stopped,), daemon=True)
        poller.start()
    try:
        server.serve_forever()
    finally:
        stopped.set()
        server.server_close()
        if poller:
            poller.join(25)
        if agent.worker:
            agent.worker.join()
        lock_file.close()


def install(args):
    import shutil
    import sys
    if os.name != 'posix' or os.geteuid() != 0:
        raise ValueError('Install on the Linux Docker host with sudo')
    https_url(args.manifest)
    project = Path(args.project_dir).resolve(strict=True)
    compose = 'compose.host.yaml' if args.host_network else 'compose.yaml'
    targets = [{'name': 'main', 'compose_file': compose, 'env_file': '.env' if (project / '.env').exists() else None}]
    for name in args.profile:
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', name):
            raise ValueError('Invalid profile name')
        targets.append({'name': name, 'compose_file': 'compose.profile.host.yaml' if args.host_network else 'compose.profile.yaml', 'env_file': '.env.' + name})
    directory = Path('/etc/mirasim-deploy')
    config_file = directory / 'config.json'
    if config_file.exists():
        raise ValueError('Agent already installed; edit its config and restart instead')
    config = {'manifest_url': args.manifest, 'image_repository': args.image_repository,
              'project_dir': str(project), 'targets': targets, 'port': 8790,
              'state_dir': '/var/lib/mirasim-deploy', 'token_file': str(directory / 'api.key'), 'health_timeout_sec': 180}
    agent = Agent(config)
    agent.snapshot()  # Prove Docker access and standard Compose topology first.
    destination = Path('/opt/mirasim-deploy/deploy-agent.py')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    shutil.copyfile(__file__, destination)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = secrets.token_hex(32)
    for name, value in [('api.key', token + '\n'), ('auth.header', 'Authorization: Bearer ' + token + '\n')]:
        fd = os.open(str(directory / name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
    atomic_json(config_file, config)
    executable = str(Path(sys.executable).resolve())
    if any(c in executable for c in ' \n\r%'):
        raise ValueError('Use a standard system Python path')
    unit = ('[Unit]\nDescription=Mirasim deployment API\nAfter=docker.service network-online.target\nRequires=docker.service\n'
            '[Service]\nType=simple\nUser=root\nUMask=0077\n'
            f'ExecStart={executable} {destination} serve --config {config_file}\n'
            'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n'
            '[Install]\nWantedBy=multi-user.target\n')
    Path('/etc/systemd/system/mirasim-deploy.service').write_text(unit)
    command(['systemctl', 'daemon-reload'])
    command(['systemctl', 'enable', '--now', 'mirasim-deploy.service'])
    print('Installed on 127.0.0.1:8790; token header: /etc/mirasim-deploy/auth.header')


def require_linux_root():
    if os.name != 'posix' or os.geteuid() != 0:
        raise ValueError('Enable remote control from the Linux host console as root')


def enable_remote(args, run=command, config_file=Path('/etc/mirasim-deploy/config.json'),
                  destination=Path('/opt/mirasim-deploy/deploy-agent.py')):
    require_linux_root()
    remote_url(args.repository, args.target)
    config = json.loads(config_file.read_text())
    existing = config.get('remote_control')
    # Preserve enrollment on a repeat setup of the same target.
    enrolled = existing['enrolled_at'] if existing and existing['repository'] == args.repository and existing['target'] == args.target else int(time.time()) + 1
    config['remote_control'] = {'repository': args.repository, 'target': args.target,
                                'enrolled_at': enrolled, 'interval_sec': 30}
    agent = Agent(config, run=run)
    if agent.state.get('phase') in ACTIVE:
        raise ValueError('Wait for the current deployment before updating its agent')
    # Only upgrade the host helper and its control settings. Never touch bridge data.
    tmp = destination.with_name(destination.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(Path(__file__).read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, destination)
    finally:
        if tmp.exists():
            tmp.unlink()
    atomic_json(config_file, config)
    run(['systemctl', 'restart', 'mirasim-deploy.service'])
    run(['systemctl', 'is-active', '--quiet', 'mirasim-deploy.service'])
    print('Remote polling enabled for target ' + args.target + '; no SSH or inbound port required.')
    print('Workflow acceptance is not server completion; local status remains at /v1/deploy/status.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    listener = sub.add_parser('serve')
    listener.add_argument('--config', required=True)
    setup = sub.add_parser('install')
    setup.add_argument('--project-dir', required=True)
    setup.add_argument('--manifest', required=True)
    setup.add_argument('--image-repository', required=True)
    setup.add_argument('--host-network', action='store_true')
    setup.add_argument('--profile', action='append', default=[])
    remote = sub.add_parser('enable-remote')
    remote.add_argument('--repository', default='sun20101227/mirasim-bridge')
    remote.add_argument('--target', default='main')
    args = parser.parse_args()
    if args.action == 'install':
        install(args)
    elif args.action == 'enable-remote':
        enable_remote(args)
    else:
        config = json.loads(Path(args.config).read_text())
        config['_config_file'] = str(Path(args.config).resolve())
        serve(config)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # No Docker output or release payload is reflected to the service log.
        print('Deployment agent failed:', type(exc).__name__)
        raise SystemExit(1)
