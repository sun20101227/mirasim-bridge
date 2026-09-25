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
  assert.deepEqual(result, { profile: 'second', saved: true });
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
test('panel model policy persists before memory update and marks sub2 mapping for resync', async (t) => {
  const { cfg, ctx } = fixture(t); const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  await panel.call('model', { id: 'gpt-test', enabled: false });
  assert.ok(cfg.constraints.disabled_models.includes('gpt-test'));
  assert.ok(JSON.parse(fs.readFileSync(cfg._config_path)).constraints.disabled_models.includes('gpt-test'));
  assert.equal(ctx.reachable, false);
  await assert.rejects(panel.call('model', { id: '../bad', enabled: true }));
});
