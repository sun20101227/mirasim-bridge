'use strict';
// 0.8.0: several Mira accounts behind ONE bridge base_url, told apart by the secret sub2api presents.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const b = require('../mirasim-bridge');
const { createPanel } = require('../lib/panel');
const { createCredential } = require('../lib/login');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith(prefix)); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function writeProfile(root, name, patch = {}) {
  const dir = path.join(root, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = b.deepMerge(b.deepMerge({}, b.DEFAULT_CONFIG), { backend: 'relay', bridge_secret: `secret-${name}`, listen: { host: '0.0.0.0', port: 9999 },
    relay: { setting_json: 'setting.json' }, sub2api: { account_name: `mira-${name}`, group_ids: [8], public_base_url: `http://mirasim-${name}:8787` }, ...patch });
  delete cfg._config_path;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: `access-${name}`, refresh: `refresh-${name}` })));
  return dir;
}
/** Fake relay: answers device/session + models and records which device signed each request. */
async function fakeRelay(t) {
  const devices = [];
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/device/session') return res.end('{"ticket":"t","expiresIn":600}');
    devices.push(req.headers['x-mirasim-device']);
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"claude-opus-5"},{"id":"kimi-k3"}]}');
    if (req.url === '/v1/limits') return res.end('{"windows":[{"name":"5h","used":10,"budget":100}]}');
    res.writeHead(404); res.end();
  });
  const origin = await listen(server); t.after(() => close(server));
  return { origin, devices };
}
function mainConfig(dir, origin) {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay', bridge_secret: 'secret-main', _config_path: path.join(dir, 'config.json') });
  cfg.listen = { host: '127.0.0.1', port: 8787 };
  cfg.relay.url = origin; cfg.relay.auth_url = origin; cfg.relay.setting_json = 'setting.json';
  cfg.sub2api.base_url = 'https://sub2.example'; cfg.sub2api.admin_api_key = 'admin-key-from-env'; cfg.sub2api.account_name = 'mira-main';
  cfg.sub2api.public_base_url = 'http://mirasim-bridge:8787';
  fs.writeFileSync(cfg._config_path, JSON.stringify({ ...cfg, sub2api: { ...cfg.sub2api, admin_api_key: '' }, _config_path: undefined }));
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'access-main', refresh: 'refresh-main' })));
  return cfg;
}

test('hosted profile inherits listen/sub2api connection/base_url from main and keeps its own identity', async (t) => {
  const dir = tmp(t, 'bridge-hosted-'); const { origin } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin);
  writeProfile(dir, 'second', { relay: { url: origin, auth_url: origin, setting_json: 'setting.json' } });
  const acct = b.loadHostedAccount(cfg, 'second');
  assert.equal(acct.key, 'second');
  assert.deepEqual(acct.cfg.listen, cfg.listen);
  assert.equal(acct.cfg.sub2api.admin_api_key, 'admin-key-from-env');
  assert.equal(acct.cfg.sub2api.public_base_url, 'http://mirasim-bridge:8787', 'same base_url as main: sub2api tells accounts apart by secret');
  assert.equal(b.bridgeBaseUrl(acct.cfg), b.bridgeBaseUrl(cfg));
  assert.equal(acct.cfg.bridge_secret, 'secret-second'); assert.equal(acct.cfg.sub2api.account_name, 'mira-second');
  assert.deepEqual(acct.cfg.sub2api.group_ids, [8], 'profile keeps its own group');
  assert.equal(acct.cfg.keepalive.enabled, false);
  assert.match(b.relaySettingPath(acct.cfg).replace(/\\/g, '/'), /profiles\/second\/setting\.json$/);
  fs.rmSync(path.join(dir, 'profiles/second/setting.json'));
  assert.throws(() => b.loadHostedAccount(cfg, 'second'), /凭证/);
  assert.throws(() => b.loadHostedAccount(cfg, 'missing'), /config\.json/);
  assert.throws(() => b.loadHostedAccount(cfg, '../x'), /profile/);
});

test('hub refuses duplicate secrets or sub2 names, and validateConfig checks accounts.hosted', async (t) => {
  const dir = tmp(t, 'bridge-hosted-'); const { origin } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin);
  const hub = new b.AccountHub(cfg, b.newAccountCtx('main'));
  writeProfile(dir, 'dupsecret', { bridge_secret: 'secret-main' });
  assert.throws(() => hub.add('dupsecret'), /bridge_secret/);
  writeProfile(dir, 'dupname', { sub2api: { account_name: 'mira-main', public_base_url: 'http://x:1' } });
  assert.throws(() => hub.add('dupname'), /账号名/);
  writeProfile(dir, 'ok');
  hub.add('ok');
  assert.throws(() => hub.add('ok'), /已在托管/);
  assert.equal(hub.find('secret-ok').key, 'ok'); assert.equal(hub.find('secret-main').key, 'main'); assert.equal(hub.find('nope'), null); assert.equal(hub.find(null), null);
  assert.throws(() => hub.remove('main'), /主账号/);
  assert.equal(hub.remove('ok').key, 'ok'); assert.equal(hub.get('ok'), null);
  for (const bad of [['main'], ['a', 'a'], ['Bad'], 'x']) { cfg.accounts.hosted = bad; assert.throws(() => b.validateConfig(cfg), /accounts\.hosted/); }
  cfg.accounts.hosted = ['ok']; cfg.backend = 'session'; assert.throws(() => b.validateConfig(cfg), /relay/);
  cfg.backend = 'relay'; b.validateConfig(cfg);
});

test('one listener routes each secret to its own account, relay credential and counters', { timeout: 20000 }, async (t) => {
  const dir = tmp(t, 'bridge-hosted-'); const { origin, devices } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin);
  writeProfile(dir, 'second', { relay: { url: origin, auth_url: origin, setting_json: 'setting.json' } });
  const ctx = b.newAccountCtx('main'); const hub = new b.AccountHub(cfg, ctx); const second = hub.add('second');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = await listen(server); t.after(() => close(server));
  const models = (key) => fetch(base + '/v1/models', { headers: { 'x-api-key': key } });
  assert.equal((await models('secret-main')).status, 200);
  assert.equal((await models('secret-second')).status, 200);
  const r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer secret-second' } }); assert.equal(r.status, 200, 'Bearer works too');
  assert.equal((await models('secret-other')).status, 503, 'unknown secret is 503, never 401/403');
  assert.equal(devices.length, 3); assert.notEqual(devices[0], devices[1], 'each account signs with its own device key');
  assert.equal(devices[1], devices[2]);
  assert.deepEqual([ctx.counters.total, ctx.counters.ok, ctx.counters.rejected], [2, 1, 1]);
  assert.deepEqual([second.ctx.counters.total, second.ctx.counters.ok], [2, 2]);
  assert.equal(b.getRelay(second.cfg).ready, true); assert.equal(b.getRelay(cfg).ready, true);
  // Per-account concurrency gate: second's limit is 1 while main stays at 2.
  second.cfg.forward.max_concurrency = 1; second.ctx.inflight = 1;
  assert.equal((await models('secret-second')).status, 503); assert.equal((await models('secret-main')).status, 200);
  second.ctx.inflight = 0;
  // Status endpoint lists every hosted account; the shape used by the old readiness check is kept.
  const status = await (await fetch(base + '/__status', { headers: { 'x-api-key': 'secret-main' } })).json();
  assert.equal(status.account, 'main'); assert.deepEqual(status.accounts.map((a) => a.key), ['main', 'second']);
  assert.equal(status.sub2api.schedulable, 'unmanaged'); assert.equal(status.relay.ready, true);
  assert.ok(!JSON.stringify(status).includes('secret-'), 'no secrets in status');
  const own = await (await fetch(base + '/__status', { headers: { 'x-api-key': 'secret-second' } })).json();
  assert.equal(own.account, 'second');
});

test('connection checks use each real bridge key, verify sub2 route, coalesce repeats and never resume accounts', async (t) => {
  const dir = tmp(t, 'bridge-check-'); const { origin, devices } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin);
  writeProfile(dir, 'second', { relay: { url: origin, auth_url: origin, setting_json: 'setting.json' } });
  const ctx = b.newAccountCtx('main'), hub = new b.AccountHub(cfg, ctx), second = hub.add('second');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = await listen(server); t.after(() => close(server));
  for (const a of hub.all()) a.cfg.listen.port = new URL(base).port;
  ctx.sm = { accountId: 11, desired: 'off' }; ctx.hold = true;
  second.ctx.sm = { accountId: 22, desired: 'off' }; second.ctx.hold = true;
  const reverse = [];
  const panel = createPanel(cfg, ctx, { bridge: { ...b, s2: { ...b.s2, syncModels: async (config, id) => {
    reverse.push({ id, key: config.bridge_secret });
    if (id === 22) throw Error('private-upstream-diagnostic');
    return { data: [{ id: 'kimi-k3' }] };
  } } } }); t.after(() => panel.close());
  const [main, duplicate] = await Promise.all([panel.call('account/check'), panel.call('account/check')]);
  assert.deepEqual(main, duplicate); assert.equal(main.bridge.ok, true); assert.equal(main.sub2api.ok, true);
  const result = await panel.call('account/check', { account: 'second' });
  assert.equal(result.bridge.ok, true); assert.equal(result.sub2api.ok, false);
  assert.ok(!JSON.stringify(result).includes('private-upstream-diagnostic'));
  assert.equal(result.bridge.model_count, 2);
  assert.deepEqual(reverse, [{ id: 11, key: 'secret-main' }, { id: 22, key: 'secret-second' }]);
  assert.equal(devices.length, 2); assert.notEqual(devices[0], devices[1], 'probes actually used different upstream identities');
  assert.equal(ctx.hold, true); assert.equal(second.ctx.hold, true); assert.equal(ctx.sm.desired, 'off');
  const access = await panel.call('account/access', { account: 'second', reveal: true });
  assert.equal(access.api_key, 'secret-second'); assert.equal(access.base_url, b.bridgeBaseUrl(cfg));
  await assert.rejects(panel.call('account/access', { account: 'second' }), /点击/);
});

test('panel hosts, scopes settings/models, pauses and unhosts accounts; persists to the right files', { timeout: 20000 }, async (t) => {
  const dir = tmp(t, 'bridge-hosted-'); const { origin } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin);
  writeProfile(dir, 'second', { relay: { url: origin, auth_url: origin, setting_json: 'setting.json' } });
  const ctx = b.newAccountCtx('main'); const hub = new b.AccountHub(cfg, ctx);
  const registered = [];
  hub.registerAccount = async (acct) => { registered.push(acct.key); acct.ctx.sm = { accountId: 55, desired: 'unknown', pauses: 0, async pause() { this.pauses++; this.desired = 'off'; return true; } }; acct.ctx.reachable = true; };
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  await assert.rejects(panel.call('account/host', { profile: 'main' }), /无效/);
  await assert.rejects(panel.call('account/host', { profile: 'nothere' }), /config\.json/);
  const hosted = await panel.call('account/host', { profile: 'second' });
  assert.deepEqual(hosted, { hosted: true, profile: 'second', account_name: 'mira-second', registered: true, reachable: true });
  assert.deepEqual(registered, ['second']);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg._config_path)).accounts.hosted, ['second']);
  assert.ok(!fs.readFileSync(cfg._config_path, 'utf8').includes('admin-key-from-env'), 'env-injected admin key never written');
  assert.deepEqual(await panel.call('account/host', { profile: 'second' }), hosted, 'lost response retry is idempotent');
  assert.deepEqual(registered, ['second'], 'retry does not register twice');
  const profiles = await panel.call('profiles');
  assert.deepEqual(profiles.map((p) => [p.profile, p.hosted, p.listed]), [['second', true, true]]);
  // Scoped settings go to the profile's own config.json; main's stays untouched.
  const before = fs.readFileSync(cfg._config_path, 'utf8');
  const saved = await panel.call('settings', { account: 'second', max_concurrency: 3, kimi_max_concurrency: 1, model_fallback: 'forbid' });
  assert.equal(saved.account, 'second'); assert.equal(hub.get('second').cfg.forward.max_concurrency, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'profiles/second/config.json'))).forward.max_concurrency, 3);
  assert.equal(fs.readFileSync(cfg._config_path, 'utf8'), before);
  await panel.call('model', { account: 'second', id: 'kimi-k3', enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'profiles/second/config.json'))).constraints.disabled_models.slice(-1), ['kimi-k3']);
  assert.ok(!cfg.constraints.disabled_models.includes('kimi-k3'));
  const rows = await panel.call('models', { account: 'second' });
  assert.deepEqual(rows.map((m) => [m.id, m.enabled]), [['claude-opus-5', true], ['kimi-k3', false]]);
  await assert.rejects(panel.call('models', { account: 'ghost' }), /未托管/);
  await assert.rejects(panel.call('models', { account: '../x' }), /无效/);
  // Manual pause holds the account out of the pool; resume only clears the hold (health loop re-enters).
  const paused = await panel.call('account/pause', { account: 'second' });
  assert.deepEqual(paused, { account: 'second', hold: true, paused: true, managed: true });
  assert.equal(hub.get('second').ctx.sm.pauses, 1);
  const status = await panel.call('status', { account: 'second' });
  assert.equal(status.hold, true); assert.equal(status.account, 'second'); assert.deepEqual(status.accounts.map((a) => a.key), ['main', 'second']);
  assert.equal((await panel.call('account/resume', { account: 'second' })).hold, false);
  assert.equal(hub.get('second').ctx.hold, false);
  const gone = await panel.call('account/unhost', { profile: 'second' });
  assert.equal(gone.hosted, false); assert.equal(gone.paused, true);
  assert.equal(hub.get('second'), null); assert.deepEqual(JSON.parse(fs.readFileSync(cfg._config_path)).accounts.hosted, []);
  assert.ok(fs.existsSync(path.join(dir, 'profiles/second/setting.json')), 'credential kept');
  assert.equal((await panel.call('accounts')).length, 1);
});

test('login/start with hosted=true registers the profile on the main base_url', async (t) => {
  const dir = tmp(t, 'bridge-hosted-'); const { origin } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin); cfg.sub2api.public_base_url = '';
  const upstream = http.createServer(async (req, res) => { req.resume(); if (req.url === '/auth/code') return res.end('{}'); if (req.url === '/auth/verify') return res.end('{"access_token":"a","refresh_token":"r"}'); res.end('{}'); });
  cfg.relay.auth_url = await listen(upstream); t.after(() => close(upstream));
  const panel = createPanel(cfg, b.newAccountCtx('main')); t.after(() => panel.close());
  const begun = await panel.call('login/start', { provider: 'email', profile: 'third', email: 't@example.com', hosted: true, group_id: 8 });
  assert.equal(begun.hosted, true);
  const done = await panel.call('login/complete', { id: begun.id, code: '123456' });
  assert.equal(done.hosted, true); assert.equal(done.account_name, 'mira-main-third');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'profiles/third/config.json')));
  assert.equal(saved.sub2api.public_base_url, 'http://127.0.0.1:8787'); assert.equal(saved.listen.port, 8787);
  assert.equal(saved.bridge_secret.length, 64); assert.notEqual(saved.bridge_secret, cfg.bridge_secret);
});

test('health tick keeps a held account paused and registers late accounts', async (t) => {
  const dir = tmp(t, 'bridge-hosted-'); const { origin, devices } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin); cfg.quota.enabled = false;
  const ctx = b.newAccountCtx('main'); new b.AccountHub(cfg, ctx);
  const probes = [];
  ctx.sm = { accountId: 1, desired: 'on', async onProbe(h) { probes.push(h); }, async pause() { return true; } };
  ctx.reachable = true;
  const original = { ...b.s2 };
  b.s2.syncModels = async () => ({ data: [{ id: 'claude-opus-5' }] });
  b.s2.getAccount = async () => ({ platform: 'anthropic', type: 'apikey', name: 'mira-main', credentials: { model_mapping: { 'claude-opus-5': 'claude-opus-5' } } });
  b.s2.listModels = async () => [{ id: 'claude-opus-5' }];
  t.after(() => Object.assign(b.s2, original));
  const acct = { key: 'main', cfg, ctx };
  await b.accountHealthTick(acct, { tickCount: 1, withSub2api: true, args: { flags: {} }, recheckEvery: 10 });
  assert.deepEqual(probes, [true]); assert.equal(ctx.lastHealthy, true);
  ctx.hold = true;
  await b.accountHealthTick(acct, { tickCount: 2, withSub2api: true, args: { flags: {} }, recheckEvery: 10 });
  assert.deepEqual(probes, [true, false], 'held account is reported unhealthy so it never resumes');
  ctx.hold = false;
  // A real request that just succeeded stands in for the synthetic /v1/models probe.
  const before = devices.length;
  ctx.lastUpstreamOkAt = Date.now();
  await b.accountHealthTick(acct, { tickCount: 3, withSub2api: true, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(devices.length, before, 'no probe sent to the relay within a healthy interval');
  assert.deepEqual(probes.slice(-1), [true]);
  ctx.lastUpstreamOkAt = Date.now() - cfg.health.interval_sec * 1000 - 1;
  await b.accountHealthTick(acct, { tickCount: 4, withSub2api: true, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(devices.length, before + 1, 'stale success: probe again');
});

test('panel codex op: read state, reject anthropic groups, persist per account, register now, pause on disable', async (t) => {
  const dir = tmp(t, 'bridge-hosted-'); const { origin } = await fakeRelay(t);
  const cfg = mainConfig(dir, origin);
  writeProfile(dir, 'second', { relay: { url: origin, auth_url: origin, setting_json: 'setting.json' } });
  const ctx = b.newAccountCtx('main'); const hub = new b.AccountHub(cfg, ctx); hub.add('second');
  const original = { ...b.s2 };
  b.s2.listGroups = async () => [{ id: 15, name: 'mira', platform: 'anthropic' }, { id: 20, name: 'codex', platform: 'openai' }];
  t.after(() => Object.assign(b.s2, original));
  const registered = [];
  hub.registerAccount = async (acct) => {
    registered.push(acct.key);
    const codex = b.managedAccounts(acct.cfg).find((x) => x.key === 'codex');
    acct.ctx.codex = { sm: { accountId: 88, desired: 'unknown', pauses: 0, async pause() { this.pauses++; return true; } }, reachable: true, name: codex.name, groups: codex.groupIds };
  };
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  const initial = await panel.call('codex', { account: 'second' });
  assert.deepEqual(initial, { account: 'second', enabled: false, account_name: 'mira-second-codex', custom_name: '', group_ids: [], sub2api_codex: { managed: false } });
  await assert.rejects(panel.call('codex', { account: 'second', enabled: true }), /openai 平台分组/);
  await assert.rejects(panel.call('codex', { account: 'second', enabled: true, group_id: 15 }), /anthropic/);
  await assert.rejects(panel.call('codex', { account: 'second', enabled: true, group_id: 99 }), /不存在/);
  await assert.rejects(panel.call('codex', { account: 'second', enabled: true, group_id: 20, account_name: 'mira-second' }), /不能与主账号相同/);
  const on = await panel.call('codex', { account: 'second', enabled: true, group_id: 20 });
  assert.equal(on.saved, true); assert.equal(on.registered, true); assert.equal(on.sub2api_codex.managed, true);
  assert.deepEqual(registered, ['second']);
  const second = hub.get('second');
  assert.deepEqual(second.ctx.codex.groups, [20]); assert.equal(second.ctx.codex.name, 'mira-second-codex');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'profiles/second/config.json'))).sub2api.openai_account, { enabled: true, account_name: '', group_ids: [20] });
  assert.equal(cfg.sub2api.openai_account.enabled, false, 'main account untouched');
  const sm = second.ctx.codex.sm;
  const off = await panel.call('codex', { account: 'second', enabled: false });
  assert.equal(off.enabled, false); assert.equal(off.sub2api_codex.managed, false);
  assert.equal(sm.pauses, 1); assert.equal(second.ctx.codex.sm, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'profiles/second/config.json'))).sub2api.openai_account.enabled, false);
  assert.deepEqual(registered, ['second'], 'disable does not re-register');
});
