'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const d = require('../scripts/deployment');

test('fresh relay configuration is valid, has random bridge secret, and needs no keeper', () => {
  const args = { dest: '/opt/mirasim-bridge', url: 'https://sub.example', name: 'mirasim', group: '15', host: '127.0.0.1', publicUrl: '', backend: 'relay', adminKey: 'test-admin' };
  const a = d.newConfig(args), b = d.newConfig(args);
  assert.equal(a.backend, 'relay'); assert.equal(a.keepalive.enabled, false);
  assert.deepEqual(a.sub2api.group_ids, [15]); assert.notEqual(a.bridge_secret, b.bridge_secret);
  assert.match(a.bridge_secret, /^[0-9a-f]{64}$/);
  assert.throws(() => d.newConfig({ ...args, group: '0' }));
  assert.throws(() => d.newConfig({ ...args, adminKey: 'bad\nheader' }));
});

test('upgrade preserves legacy backend and uses explicitly configured credential path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-install-test-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"bridge_secret":"keep-me"}');
    assert.equal(d.readConfig(dir).backend, 'session');
    fs.writeFileSync(file, JSON.stringify({ backend: 'relay', relay: { setting_json: 'credentials/live.json' }, bridge_secret: 'keep-me' }));
    const cfg = d.readConfig(dir);
    assert.equal(cfg.bridge_secret, 'keep-me');
    assert.equal(d.credentialPath(dir, '/var/lib/mirasim', cfg), path.join(dir, 'credentials/live.json'));
    const absolute = path.resolve(dir, 'elsewhere.json');
    cfg.relay.setting_json = absolute;
    assert.equal(d.credentialPath(dir, '/var/lib/mirasim', cfg), absolute);
    assert.equal(d.credentialPath(dir, '/var/lib/mirasim', null), path.join('/var/lib/mirasim', '.mirasim', 'setting.json'));
    fs.writeFileSync(file, '{"bridge_secret":"secret-value",');
    assert.throws(() => d.readConfig(dir), (e) => !e.message.includes('secret-value') && /valid JSON/.test(e.message));
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('bridge-install-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('systemd stop timeout exceeds application deadline, with validated paths and user', () => {
  const template = fs.readFileSync(path.join(__dirname, '../mirasim-bridge.service'), 'utf8');
  const opts = { user: 'mirasim', group: 'mirasim', node: '/usr/bin/node', home: '/var/lib/mirasim', servicePath: '/usr/bin:/bin', totalTimeout: 300 };
  const result = d.renderUnit(template, opts);
  assert.match(result, /^TimeoutStopSec=315$/m);
  assert.match(result, /^KillMode=mixed$/m); assert.match(result, /^Environment=HOME=\/var\/lib\/mirasim$/m);
  assert.throws(() => d.renderUnit(template, { ...opts, user: 'root' }));
  assert.throws(() => d.renderUnit(template, { ...opts, servicePath: '/usr/bin\nExecStart=bad' }));
});
