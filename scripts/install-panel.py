#!/usr/bin/env python3
"""One-time host panel installation; preserve existing deployment and bridge data."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit


def origin(value):
    u = urlsplit(value)
    if u.scheme != 'https' or not u.netloc or u.username or u.password or u.path or u.query or u.fragment:
        raise ValueError('Use an HTTPS origin without a path, e.g. https://mira.example.com')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    args = parser.parse_args()
    url = origin(args.origin)
    if os.name != 'posix' or os.geteuid() != 0:
        raise ValueError('Run on the Linux host as root, not inside the bridge container')
    source = Path(__file__).resolve().parents[1]
    config_file = Path('/etc/mirasim-deploy/config.json')
    config = json.loads(config_file.read_text())
    spec = importlib.util.spec_from_file_location('deploy_agent', source / 'scripts/deploy-agent.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    agent = module.Agent(config)
    if agent.state.get('phase') in module.ACTIVE:
        raise ValueError('Wait for the current deployment to complete first')
    destination = Path('/opt/mirasim-deploy')
    files = {'deploy-agent.py': source / 'scripts/deploy-agent.py',
             'panel-host.py': source / 'scripts/panel-host.py',
             **{'web/' + n: source / 'web' / n for n in ('index.html', 'app.js', 'style.css')}}
    contents = {name: file.read_bytes() for name, file in files.items()}
    # Single service owns the journal. Stop it before replacing its code/config.
    module.command(['systemctl', 'stop', 'mirasim-deploy.service'], timeout=240)
    old = {name: (destination / name).read_bytes() if (destination / name).exists() else None for name in files}
    old_config = dict(config)
    try:
        current = module.Agent(config)
        if current.state.get('phase') in ('activating', 'rolling_back'):
            raise ValueError('Deployment interrupted; restart the old service to recover before installing')
        key_file = config_file.parent / 'panel.key'
        if not key_file.exists():
            fd = os.open(str(key_file), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(secrets.token_hex(32) + '\n')
        config['panel'] = {'origin': url, 'token_file': str(key_file)}
        config['self_update'] = True  # from now on the web upgrade also refreshes these host tools
        for name, data in contents.items():
            file = destination / name
            file.parent.mkdir(parents=True, exist_ok=True)
            tmp = file.with_name(file.name + '.install.tmp')
            tmp.write_bytes(data)
            os.replace(tmp, file)
        module.atomic_json(config_file, config)
        module.command(['systemctl', 'start', 'mirasim-deploy.service'])
        module.command(['systemctl', 'is-active', '--quiet', 'mirasim-deploy.service'])
    except Exception:
        for name, data in old.items():
            if data is not None:
                (destination / name).write_bytes(data)
        module.atomic_json(config_file, old_config)
        module.command(['systemctl', 'restart', 'mirasim-deploy.service'])
        raise
    print('Panel installed on 127.0.0.1:8790. Reverse proxy this address to ' + url)
    print('Read your separate admin key locally: sudo cat /etc/mirasim-deploy/panel.key')
    print('Open ' + url + '/panel. Upgrade bridge from the Versions page before using account management.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Panel installation failed:', type(exc).__name__, '(check prerequisites; no credentials printed)')
        raise SystemExit(1)
