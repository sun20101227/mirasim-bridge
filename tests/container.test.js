'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepare } = require('../scripts/prepare-container');
const { check } = require('../scripts/healthcheck');
const { apply } = require('../scripts/container-config');
const b = require('../mirasim-bridge');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-container-test-'));
  const dataDir = path.join(root, 'data'), settingFile = path.join(root, 'input.json'), adminKeyFile = path.join(root, 'admin-key');
  const setting = { auth: { token: 'access-original', refreshToken: 'refresh-original', exp: 2000000000 },
    device: { privateKey: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) },
    providers: [{ api_key: 'do-not-copy-me' }] };
  fs.writeFileSync(settingFile, JSON.stringify(setting)); fs.writeFileSync(adminKeyFile, 'admin-test-only\n');
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('bridge-container-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, settingFile, adminKeyFile, setting, url: 'https://sub2api.example', group: '15' };
}

test('container setup produces stock sub2api upstream config without copying unrelated secrets', (t) => {
  const f = fixture(t);
  assert.equal(prepare(f).initialized, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json')));
  assert.equal(cfg.backend, 'relay'); assert.equal(cfg.listen.host, '0.0.0.0');
  assert.equal(cfg.sub2api.public_base_url, 'http://mirasim-bridge:8787');
  assert.equal(cfg.sub2api.base_url, f.url); assert.deepEqual(cfg.sub2api.group_ids, [15]);
  assert.equal(cfg.relay.setting_json, 'setting.json'); assert.equal(cfg.keepalive.enabled, false);
  assert.match(cfg.bridge_secret, /^[0-9a-f]{64}$/);
  assert.equal(cfg.sub2api.admin_api_key, 'admin-test-only');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'setting.json')))).sort(), ['auth', 'device']);
  assert.ok(!fs.existsSync(path.join(f.dataDir, '.setup.lock')));
});

test('reinitialization preserves rotated token, bridge secret and config despite different or missing inputs', (t) => {
  const f = fixture(t); prepare(f);
  const configPath = path.join(f.dataDir, 'config.json'), loginPath = path.join(f.dataDir, 'setting.json');
  const config = fs.readFileSync(configPath, 'utf8');
  const login = JSON.parse(fs.readFileSync(loginPath)); login.auth.token = 'new-access'; login.auth.refreshToken = 'new-refresh';
  fs.writeFileSync(loginPath, JSON.stringify(login));
  const bytes = fs.readFileSync(loginPath, 'utf8');
  assert.equal(prepare({ dataDir: f.dataDir, url: 'https://changed.example', settingFile: '/not-present', adminKeyFile: '/not-present' }).preserved, true);
  assert.equal(fs.readFileSync(configPath, 'utf8'), config); assert.equal(fs.readFileSync(loginPath, 'utf8'), bytes);
  assert.throws(() => prepare({ dataDir: f.dataDir, hostNetwork: true }), /different network topology/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), config);
});

test('host network setup selects localhost; partial initialization reuses stored credential', (t) => {
  const f = fixture(t); fs.mkdirSync(f.dataDir);
  const stored = { ...f.setting, auth: { ...f.setting.auth, token: 'newer-than-upload' } };
  fs.writeFileSync(path.join(f.dataDir, 'setting.json'), JSON.stringify(stored));
  prepare({ ...f, hostNetwork: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json')));
  assert.equal(cfg.listen.host, '127.0.0.1'); assert.equal(cfg.sub2api.public_base_url, 'http://127.0.0.1:8787');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'setting.json'))).auth.token, 'newer-than-upload');
});

test('invalid settings, group or concurrent setup fail before committing config', (t) => {
  const f = fixture(t);
  assert.throws(() => prepare({ ...f, group: '0' }));
  assert.ok(!fs.existsSync(path.join(f.dataDir, 'config.json')));
  assert.ok(!fs.existsSync(path.join(f.dataDir, 'setting.json')));
  fs.writeFileSync(f.settingFile, JSON.stringify({ auth: { token: 'mrs1:machine-encrypted' } }));
  assert.throws(() => prepare(f), /Encrypted mrs1/);
  fs.writeFileSync(path.join(f.dataDir, '.setup.lock'), 'other-setup');
  assert.throws(() => prepare(f), /locked/);
});

test('liveness requires authentication but not upstream readiness or free inference slots', async (t) => {
  const f = fixture(t), cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  cfg.backend = 'relay'; cfg.relay.setting_json = path.join(f.root, 'absent.json');
  const ctx = { inflight: 2, backoffUntil: Date.now() + 60000, startedAt: Date.now(), counters: { total: 0, rejected: 0 } };
  const server = b.createBridgeServer(cfg, ctx, 'health-secret', 2);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const file = path.join(f.root, 'health.json');
  fs.writeFileSync(file, JSON.stringify({ listen: { host: '127.0.0.1', port: server.address().port }, bridge_secret: 'health-secret' }));
  assert.equal(await check(file, { env: {} }), true);
  assert.equal(await check(file, { readiness: true, env: {} }), false);
  assert.equal(await check(file, { env: { MIRASIM_BRIDGE_SECRET: 'wrong' } }), false);
  ctx.shuttingDown = true;
  assert.equal(await check(file, { env: {} }), false);
});

test('malformed config cannot disclose credential fragments in CLI error output', (t) => {
  const f = fixture(t), file = path.join(f.root, 'bad-config.json');
  fs.writeFileSync(file, '{"bridge_secret":"do-not-log-this-token",');
  const result = spawnSync(process.execPath, [path.join(__dirname, '../mirasim-bridge.js'), 'groups', '--config', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.ok(!(result.stdout + result.stderr).includes('do-not-log-this-token'));
});

test('container config edit validates before atomic replacement and preserves old config on errors', (t) => {
  const f = fixture(t); prepare(f);
  const file = path.join(f.dataDir, 'config.json');
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => apply('{invalid-secret', file), (e) => !e.message.includes('invalid-secret'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const cfg = JSON.parse(original);
  assert.throws(() => apply(JSON.stringify({ ...cfg, bridge_secret: '' }), file), /bridge_secret/);
  assert.throws(() => apply(JSON.stringify({ ...cfg, backend: 'session' }), file), /relay/);
  assert.throws(() => apply(JSON.stringify({ ...cfg, relay: { setting_json: '/outside-volume.json' } }), file), /data volume/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  cfg.forward.max_concurrency = 1;
  apply(JSON.stringify(cfg), file);
  assert.equal(JSON.parse(fs.readFileSync(file)).forward.max_concurrency, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).bridge_secret, cfg.bridge_secret);
});
