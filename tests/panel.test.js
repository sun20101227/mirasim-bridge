'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const b = require('../mirasim-bridge');
const { createPanel, ensurePanelKey } = require('../lib/panel');
const { startEmailLogin } = require('../lib/login');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-panel-test-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('mira-panel-test-')); fs.rmSync(dir, { recursive: true }); });
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG); cfg.backend = 'relay'; cfg.bridge_secret = 'inference-secret';
  cfg._config_path = path.join(dir, 'config.json'); cfg.sub2api.account_name = 'original';
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg)); fs.writeFileSync(path.join(dir, 'setting.json'), 'original-credential');
  const ctx = { counters: { total: 0, rejected: 0 }, startedAt: Date.now(), inflight: 0, backoffUntil: 0 };
  return { cfg, ctx, dir };
}
test('panel HTTP routes require independent key; shell assets use CSP and contain no secrets', async (t) => {
  const { cfg, ctx } = fixture(t), key = ensurePanelKey(cfg);
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), origin = await listen(server);
  t.after(() => close(server));
  const html = await fetch(origin + '/panel'); assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const text = await html.text(); assert.ok(!text.includes(key)); assert.ok(!text.includes(cfg.bridge_secret));
  const call = (headers, data = {}) => fetch(origin + '/__panel/summary', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  assert.equal((await call({ 'x-api-key': cfg.bridge_secret })).status, 403);
  assert.equal((await call({ 'x-panel-key': key })).status, 200);
  assert.equal((await call({ 'x-panel-key': key }, [])).status, 400);
  assert.equal((await fetch(origin + '/__live', { headers: { 'x-panel-key': key } })).status, 503);
  assert.equal((await fetch(origin + '/panel/unknown')).status, 404);
  const access = (headers) => fetch(origin + '/__panel/account/access', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ reveal: true }) });
  assert.equal((await access({ 'x-api-key': cfg.bridge_secret })).status, 403, 'inference key cannot read account keys');
  const revealed = await access({ 'x-panel-key': key });
  assert.equal(revealed.headers.get('cache-control'), 'no-store');
  const credentials = await revealed.json();
  assert.equal(credentials.api_key, cfg.bridge_secret);
  assert.equal(credentials.access_token, undefined);
  const summary = await (await call({ 'x-panel-key': key })).text();
  assert.ok(!summary.includes(cfg.bridge_secret), 'ordinary refresh never reveals inference keys');
});
test('email profile flow keeps original credentials and config intact; wrong code can retry without revealing tokens', async (t) => {
  const { cfg, ctx, dir } = fixture(t); const before = fs.readFileSync(cfg._config_path);
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push(req.url); const payload = raw ? JSON.parse(raw) : {};
    if (req.url === '/auth/code') return res.end('{"dev_code":"hidden-code"}');
    if (req.url === '/auth/verify') {
      if (payload.code !== '123456') { res.writeHead(400); return res.end('{"error":"private-token-should-not-leak"}'); }
      return res.end('{"access_token":"second-access","refresh_token":"second-refresh"}');
    }
    if (req.url === '/auth/me') return res.end('{}');
    res.writeHead(404); res.end();
  });
  cfg.relay.auth_url = await listen(upstream); t.after(() => close(upstream));
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  const login = { provider: 'email', profile: 'second', email: 'second@example.com', public_base_url: 'http://mirasim-second:8787', group_id: 15 };
  const begun = await panel.call('login/start', login); assert.equal(begun.provider, 'email'); assert.equal(begun.url, undefined);
  assert.ok(!JSON.stringify(begun).includes('hidden-code'));
  await assert.rejects(panel.call('login/start', { ...login, profile: 'third' }), /60/);
  await assert.rejects(panel.call('login/complete', { id: begun.id, code: '000000' }), (err) => !err.message.includes('private-token'));
  const result = await panel.call('login/complete', { id: begun.id, code: '123456' });
  assert.deepEqual(result, { profile: 'second', saved: true, hosted: false, account_name: 'original-second' });
  assert.deepEqual(fs.readFileSync(cfg._config_path), before);
  assert.equal(fs.readFileSync(path.join(dir, 'setting.json'), 'utf8'), 'original-credential');
  const cred = JSON.parse(fs.readFileSync(path.join(dir, 'profiles/second/setting.json')));
  assert.equal(cred.access_token, 'second-access');
  assert.ok(!seen.some((s) => /oauth|logout|revoke/.test(s)));
  assert.deepEqual(await panel.call('login/complete', { id: begun.id }), result);
});
test('OTP concurrent submits and cancellation never create a second successful login', async (t) => {
  let release, calls = 0;
  const gate = new Promise((r) => { release = r; });
  const upstream = http.createServer(async (req, res) => { req.resume(); if (req.url === '/auth/code') return res.end('{}'); calls++; await gate; res.end('{"access_token":"a","refresh_token":"r"}'); });
  const origin = await listen(upstream); t.after(() => close(upstream));
  const capture = await startEmailLogin({ authUrl: origin, email: 'x@example.com' });
  const first = capture.submit('123456'); await assert.rejects(capture.submit('123456'), /正在校验/);
  capture.close(); release(); await assert.rejects(first, /已结束/); await assert.rejects(capture.result, /取消/); assert.equal(calls, 1);
});

for (const provider of ['google', 'github']) test(`panel ${provider} generates OAuth link, accepts callback and preserves main credentials`, async (t) => {
  const { cfg, ctx, dir } = fixture(t);
  const before = fs.readFileSync(cfg._config_path);
  const upstream = http.createServer((req, res) => {
    if (req.url === '/auth/oauth/providers') return res.end(JSON.stringify({ providers: ['google', 'github'] }));
    if (req.url === '/auth/me') {
      assert.equal(req.headers.authorization, 'Bearer new-' + provider);
      return res.end('{}');
    }
    res.writeHead(404); res.end();
  });
  cfg.relay.auth_url = await listen(upstream); t.after(() => close(upstream));
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  const login = await panel.call('login/start', { provider, profile: provider + '-account', hosted: true, group_id: 15 });
  const url = new URL(login.url);
  assert.equal(url.pathname, `/auth/oauth/${provider}/login`);
  const callback = new URL(url.searchParams.get('redirect_uri'));
  assert.equal(callback.searchParams.get('state'), url.searchParams.get('state'));
  callback.searchParams.set('access_token', 'new-' + provider);
  callback.searchParams.set('refresh_token', 'refresh-' + provider);
  const saved = await panel.call('login/complete', { id: login.id, callback: callback.href });
  assert.equal(saved.saved, true);
  const status = await panel.call('login/status', { id: login.id });
  assert.equal(status.stage, 'saved'); assert.equal(status.saved, true); assert.equal(status.profile, provider + '-account');
  assert.ok(!JSON.stringify(status).includes('new-' + provider));
  assert.deepEqual(fs.readFileSync(cfg._config_path), before);
  assert.equal(fs.readFileSync(path.join(dir, 'setting.json'), 'utf8'), 'original-credential');
  const credential = JSON.parse(fs.readFileSync(path.join(dir, 'profiles', provider + '-account', 'setting.json')));
  assert.equal(credential.access_token, 'new-' + provider);
});
test('panel model policy persists before memory update and marks sub2 mapping for resync', async (t) => {
  const { cfg, ctx } = fixture(t); const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  await panel.call('model', { id: 'gpt-test', enabled: false });
  assert.ok(cfg.constraints.disabled_models.includes('gpt-test'));
  assert.ok(JSON.parse(fs.readFileSync(cfg._config_path)).constraints.disabled_models.includes('gpt-test'));
  assert.equal(ctx.reachable, false);
  await assert.rejects(panel.call('model', { id: '../bad', enabled: true }));
});
test('panel model toggle never writes env-injected secrets to disk', async (t) => {
  const { cfg, ctx } = fixture(t); const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  cfg.sub2api.admin_api_key = 'admin-from-env-only'; cfg.bridge_secret = 'secret-from-env-only';
  await panel.call('model', { id: 'gpt-test', enabled: false });
  const raw = fs.readFileSync(cfg._config_path, 'utf8');
  assert.ok(!raw.includes('admin-from-env-only')); assert.ok(!raw.includes('secret-from-env-only'));
  assert.ok(JSON.parse(raw).constraints.disabled_models.includes('gpt-test'));
});
test('panel login refuses to register a profile endpoint outside this host', async (t) => {
  const { cfg, ctx, dir } = fixture(t); const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  const base = { provider: 'google', profile: 'second', port: 8787 };
  for (const public_base_url of ['https://attacker.example', 'http://mirasim-other:8787', 'http://127.0.0.1:9999', undefined]) {
    await assert.rejects(panel.call('login/start', { ...base, public_base_url }), /桥接器地址/);
  }
  await assert.rejects(panel.call('login/start', { ...base, public_base_url: 'http://mirasim-second:8787', account_name: 'x'.repeat(65) }), /账号名/);
  await assert.rejects(panel.call('login/start', { ...base, public_base_url: 'http://mirasim-second:8787', group_id: -1 }), /分组/);
  // A normal name passes the name check (the call then fails on the group, not the name).
  await assert.rejects(panel.call('login/start', { ...base, public_base_url: 'http://mirasim-second:8787', account_name: 'mirasim second-二号', group_id: -1 }), /分组/);
  assert.equal(fs.existsSync(path.join(dir, 'profiles/second')), false);
});
test('panel concurrency settings validate range, persist without env secrets and apply live', async (t) => {
  const { cfg, ctx } = fixture(t); const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  cfg.bridge_secret = 'secret-from-env-only';
  for (const bad of [{ max_concurrency: 0, kimi_max_concurrency: 1 }, { max_concurrency: 17, kimi_max_concurrency: 1 },
    { max_concurrency: 2, kimi_max_concurrency: 3 }, { max_concurrency: '4', kimi_max_concurrency: 1 }]) await assert.rejects(panel.call('settings', bad));
  assert.deepEqual(await panel.call('settings', { max_concurrency: 4, kimi_max_concurrency: 2 }), { saved: true, account: 'main', max_concurrency: 4, kimi_max_concurrency: 2, model_fallback: 'observe', kimi_default_effort: 'low' });
  await assert.rejects(panel.call('settings', { max_concurrency: 4, kimi_max_concurrency: 2, model_fallback: 'always' }), /替换策略/);
  assert.equal((await panel.call('settings', { max_concurrency: 4, kimi_max_concurrency: 2, model_fallback: 'forbid' })).model_fallback, 'forbid');
  assert.equal(JSON.parse(fs.readFileSync(cfg._config_path)).constraints.model_fallback, 'forbid');
  const raw = fs.readFileSync(cfg._config_path, 'utf8'); assert.ok(!raw.includes('secret-from-env-only'));
  assert.equal(JSON.parse(raw).forward.max_concurrency, 4); assert.equal(cfg.forward.kimi_max_concurrency, 2);
  // The proxy gate reads the live value: a server started with limit 4 rejects once it is lowered to 1.
  Object.assign(ctx, { inflight: 1, counters: { total: 0, rejected: 0, err: 0 } });
  const server = b.createBridgeServer(cfg, ctx, 'inference-secret', 4), origin = await listen(server);
  t.after(() => close(server));
  cfg.forward.max_concurrency = 1;
  const r = await fetch(origin + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'inference-secret', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 503); assert.ok((await r.text()).includes('over concurrency limit (1)'));
});
test('panel family toggle changes only that family and persists', async (t) => {
  const { Readable } = require('node:stream');
  const { cfg, ctx } = fixture(t);
  const catalog = ['claude-opus-5', 'deepseek-v4-flash', 'deepseek-v4-pro', 'kimi-k3'];
  const fake = { ...b, getRelay: () => ({ request: async () => Object.assign(Readable.from([Buffer.from(JSON.stringify({ data: catalog.map((id) => ({ id })) }))]), { statusCode: 200 }) }) };
  const panel = createPanel(cfg, ctx, { bridge: fake }); t.after(() => panel.close());
  cfg.constraints.disabled_models = ['kimi-k3'];
  assert.equal((await panel.call('models/family', { family: 'deepseek', enabled: false })).changed, 2);
  assert.deepEqual(new Set(cfg.constraints.disabled_models), new Set(['kimi-k3', 'deepseek-v4-flash', 'deepseek-v4-pro']));
  assert.ok(JSON.parse(fs.readFileSync(cfg._config_path)).constraints.disabled_models.includes('deepseek-v4-pro'));
  await panel.call('models/family', { family: 'deepseek', enabled: true });
  assert.deepEqual(cfg.constraints.disabled_models, ['kimi-k3']);
  await assert.rejects(panel.call('models/family', { family: 'glm', enabled: true }), /系列/);
  assert.equal(ctx.reachable, false);
});
