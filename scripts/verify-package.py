#!/usr/bin/env python3
"""Check release integrity against source bytes, including binary assets."""
import hashlib
from pathlib import Path
import sys
import zipfile


def verify(archive):
    root = Path(__file__).resolve().parents[1]
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive entries')
        sums = bundle.read('mirasim-bridge/SHA256SUMS').decode('utf-8')
        listed = set()
        for line in sums.splitlines():
            digest, relative = line.split('  ', 1)
            if relative.startswith('/') or '..' in relative.split('/') or '\\' in relative:
                raise ValueError('Invalid archive path')
            if relative.startswith('private/') or relative in ('config.json', 'setting.json', '.env', 'state.json'):
                raise ValueError('Private configuration in source archive')
            name = 'mirasim-bridge/' + relative
            data = bundle.read(name)
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError('Hash mismatch: ' + relative)
            original = (root / relative).read_bytes()
            expected = original if relative.endswith('.png') else original.decode('utf-8-sig').replace('\r\n', '\n').encode('utf-8')
            if data != expected:
                raise ValueError('Source bytes differ: ' + relative)
            listed.add(name)
        if set(names) != listed | {'mirasim-bridge/SHA256SUMS'}:
            raise ValueError('Unlisted archive file')
    print('Source archive hashes, binary assets and file list verified')


if __name__ == '__main__':
    verify(sys.argv[1])
