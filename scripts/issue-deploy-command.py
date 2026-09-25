#!/usr/bin/env python3
"""Publish one short-lived command to the dedicated GitHub control branch."""
import base64
import json
import os
import re
import secrets
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def make_command(target, action, now=None):
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', target):
        raise ValueError('Invalid target')
    if action not in ('deploy', 'rollback'):
        raise ValueError('Invalid action')
    now = int(time.time()) if now is None else now
    return {'id': secrets.token_hex(16), 'target': target, 'action': action,
            'issued_at': now, 'expires_at': now + 900}


def publish(repository, token, target, action):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid repository')
    command = make_command(target, action)

    def api(path, data=None, method=None):
        request = Request('https://api.github.com/repos/' + repository + '/' + path,
                          data=json.dumps(data).encode() if data is not None else None,
                          method=method,
                          headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                                   'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
        with urlopen(request, timeout=30) as response:
            return json.load(response)

    try:
        api('git/ref/heads/deploy-control')
    except HTTPError as exc:
        if exc.code != 404:
            raise
        source = api('git/ref/heads/main')['object']['sha']
        api('git/refs', {'ref': 'refs/heads/deploy-control', 'sha': source})
    path = 'contents/remote-control/' + target + '.json'
    content = base64.b64encode((json.dumps(command, indent=2) + '\n').encode()).decode()
    payload = {'message': 'Request ' + action + ' for ' + target, 'branch': 'deploy-control', 'content': content}
    try:
        payload['sha'] = api(path + '?ref=deploy-control')['sha']
    except HTTPError as exc:
        if exc.code != 404:
            raise
    api(path, payload, 'PUT')
    print(json.dumps(command))
    print('Published only. This does not confirm the server received or completed the command.')


if __name__ == '__main__':
    publish(os.environ['GITHUB_REPOSITORY'], os.environ['GH_TOKEN'],
            os.environ['DEPLOY_TARGET'], os.environ['DEPLOY_ACTION'])
