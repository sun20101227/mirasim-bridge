'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { startLogin, startEmailLogin, parseCallback, createCredential, profileDirectory, listProfiles } = require('../lib/login');
const { profileConfig, login } = require('../scripts/account-login');
const { summarizeLimits, quotaNote, mergeQuotaNote } = require('../lib/quota');
const { request, readText } = require('../lib/relay');
const b = require('../mirasim-bridge');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

test('independent profile config and keys never reuse original identity or modify desktop/account config', () => {
  const base = b.deepMerge({}, b.DEFAULT_CONFIG); base.backend = 'relay'; base.bridge_secret = 'original-secret';
  base.sub2api.account_name = 'original'; base.sub2api.group_ids = [15]; base.relay.setting_json = '/original/setting.json';
  const before = JSON.stringify(base);
  const config = profileConfig(base, 'second', { 'public-base-url': 'http://mirasim-second:8787', 'group-id': '8' });
  assert.equal(JSON.stringify(base), before);
  assert.equal(config.sub2api.account_name, 'original-second'); assert.deepEqual(config.sub2api.group_ids, [8]);
  assert.equal(config.relay.setting_json, 'setting.json'); assert.notEqual(config.bridge_secret, base.bridge_secret);
  const a = createCredential({ access: 'one', refresh: 'one-refresh' }), c = createCredential({ access: 'two', refresh: 'two-refresh' });
  assert.notEqual(a.device_private_key, c.device_private_key);
  assert.throws(() => profileDirectory('/data', '../desktop'));
  assert.throws(() => profileConfig(base, 'second', { 'public-base-url': 'http://new', 'account-name': 'original' }));
  assert.throws(() => profileConfig(base, 'second', {}));
});

test('OAuth login discovers Google, validates one-time callback and never logs out another account', async () => {
  const paths = [];
  const mock = http.createServer((req, res) => { paths.push(req.url); res.end('{"providers":["github","google"]}'); });
  const origin = await listen(mock);
  let capture;
  try {
    capture = await startLogin({ authUrl: origin, provider: 'google', timeoutMs: 5000 });
    const url = new URL(capture.url);
    assert.equal(url.pathname, '/auth/oauth/google/login');
    assert.equal(url.searchParams.get('redirect_uri'), capture.callback);
    const result = new URL(capture.callback);
    result.searchParams.set('access_token', 'test-access'); result.searchParams.set('refresh_token', 'test-refresh');
    const bad = new URL(result); bad.searchParams.set('state', 'wrong');
    assert.throws(() => capture.accept(bad.href), /state/);
    const foreign = new URL(result); foreign.pathname = '/callback/foreign';
    assert.throws(() => parseCallback(foreign.href, capture.callback), /不属于/);
    const duplicate = new URL(result); duplicate.searchParams.append('access_token', 'injected');
    assert.throws(() => capture.accept(duplicate.href), /有效/);
    const response = await request(result, { totalTimeout: 5000 });
    const text = await readText(response);
    assert.equal(response.statusCode, 200); assert.ok(!text.includes('test-access'));
    assert.deepEqual(await capture.result, { access: 'test-access', refresh: 'test-refresh' });
    assert.throws(() => capture.accept(result.href), /已结束/);
    assert.deepEqual(paths, ['/auth/oauth/providers']);
  } finally { capture?.close(); await close(mock); }
});

test('OAuth timeout and unsupported provider do not create or overwrite credential files', async () => {
  const mock = http.createServer((_, res) => res.end('{"providers":["google"]}'));
  const origin = await listen(mock); let capture;
  try {
    await assert.rejects(startLogin({ authUrl: origin, provider: 'github' }), /未提供/);
    capture = await startLogin({ authUrl: origin, timeoutMs: 30 });
    await assert.rejects(capture.result, /超时/);
  } finally { capture?.close(); await close(mock); }
});

test('email OTP uses the desktop client auth/code and auth/verify endpoints', async () => {
  const paths = [], bodies = [];
  const mock = http.createServer(async (req, res) => {
    paths.push(req.url); let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(raw);
    if (req.url === '/auth/code') return res.end('{"dev_code":"must-not-be-forwarded"}');
    if (req.url === '/auth/verify') return res.end('{"access_token":"email-access","refresh_token":"email-refresh"}');
    res.writeHead(404); res.end();
  });
  const origin = await listen(mock); let capture;
  try {
    capture = await startEmailLogin({ authUrl: origin, email: 'new@example.com', timeoutMs: 5000 });
    assert.equal(paths.join(','), '/auth/code');
    await capture.submit('123456');
    assert.deepEqual(await capture.result, { access: 'email-access', refresh: 'email-refresh' });
    assert.deepEqual(paths, ['/auth/code', '/auth/verify']);
    assert.deepEqual(JSON.parse(bodies[0]), { email: 'new@example.com' });
    assert.deepEqual(JSON.parse(bodies[1]), { email: 'new@example.com', code: '123456' });
    await assert.rejects(capture.submit('bad'), /已结束/);
  } finally { capture?.close(); await close(mock); }
});

test('complete OAuth login writes a separate profile, validates it and leaves original files byte-for-byte intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-login-test-'));
  const configFile = path.join(dir, 'config.json'), originalFile = path.join(dir, 'setting.json');
  const base = b.deepMerge({}, b.DEFAULT_CONFIG); base.backend = 'relay'; base._config_path = configFile;
  const paths = []; let callbackTask;
  const mock = http.createServer((req, res) => {
    paths.push(req.url); req.resume();
    if (req.url === '/auth/oauth/providers') return res.end('{"providers":["google"]}');
    if (req.url === '/auth/me') { assert.equal(req.headers.authorization, 'Bearer second-access'); return res.end('{"id":"second"}'); }
    if (req.url === '/v1/device/session') return res.end('{"ticket":"new-ticket","expiresIn":600}');
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"kimi-k3"}]}');
    res.writeHead(404); res.end();
  });
  const origin = await listen(mock); base.relay.url = origin; base.relay.auth_url = origin;
  fs.writeFileSync(configFile, JSON.stringify(base)); fs.writeFileSync(originalFile, 'original account untouched');
  const before = fs.readFileSync(configFile, 'utf8');
  let outputText = '';
  const output = { write(text) {
    outputText += text;
    const url = text.split('\n').find((line) => line.startsWith(origin + '/auth/oauth/google/login'));
    if (url) {
      const callback = new URL(new URL(url).searchParams.get('redirect_uri'));
      callback.searchParams.set('access_token', 'second-access'); callback.searchParams.set('refresh_token', 'second-refresh');
      callbackTask = request(callback, { totalTimeout: 1000 }).then(readText);
    }
  } };
  try {
    const result = await login(base, { profile: 'second', 'public-base-url': 'http://mirasim-second:8787' }, { output });
    await callbackTask;
    assert.equal(result.relay_ready, true); assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    assert.equal(fs.readFileSync(originalFile, 'utf8'), 'original account untouched');
    const credential = JSON.parse(fs.readFileSync(path.join(dir, 'profiles/second/setting.json')));
    assert.equal(credential.access_token, 'second-access');
    assert.deepEqual(listProfiles(dir), [{ profile: 'second', credential_saved: true, configured: true }]);
    assert.ok(!outputText.includes('second-access')); assert.ok(!outputText.includes('second-refresh'));
    assert.ok(!paths.some((p) => /logout|revoke/.test(p)));
    await assert.rejects(login(base, { profile: 'second', 'public-base-url': 'http://mirasim-second:8787' }, { output }), /已存在/);
  } finally {
    await close(mock);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('bridge-login-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quota percentages are provider units, scoped exhaustion does not imply global exhaustion', () => {
  const snapshot = summarizeLimits({ windows: [
    { name: '5h', used: 25, budget: 100, reset_at: 2000000000 },
    { name: '7d', used: 0, budget: 0 },
    { name: '7d_fable', used: 11, budget: 10, model_scoped: true },
    { name: 'invalid', used: -1, budget: 2 },
  ] }, 0);
  assert.equal(snapshot.windows[0].remaining_percent, 75); assert.equal(snapshot.windows[0].remaining, 75);
  assert.equal(snapshot.windows[1].remaining_percent, null); assert.equal(snapshot.windows[2].remaining, 0);
  assert.equal(snapshot.account_exhausted, false);
  const block = quotaNote(snapshot);
  const notes = mergeQuotaNote('user custom note', block);
  assert.ok(notes.startsWith('user custom note\n')); assert.match(notes, /剩余 75%/); assert.match(notes, /非美元/);
  assert.equal(mergeQuotaNote(notes, block), notes);
  const stale = mergeQuotaNote(notes, quotaNote(snapshot, { stale: true }));
  assert.match(stale, /查询失败/); assert.ok(!stale.includes('剩余 75%'));
  assert.throws(() => mergeQuotaNote('[mirasim-quota]manual incomplete', block), /Incomplete/);
  assert.throws(() => summarizeLimits({}), /Invalid/);
});

test('quota sync only updates owned notes, throttles, preserves user text, never touches local billing limits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-quota-test-'));
  const file = path.join(dir, 'setting.json');
  fs.writeFileSync(file, JSON.stringify(createCredential({ access: 'test-access', refresh: 'test-refresh' })));
  let requests = 0, fail = false, notes = 'my manual note', updates = [];
  const mock = http.createServer((req, res) => {
    if (req.url === '/v1/device/session') return res.end('{"ticket":"ticket-test","expiresIn":600}');
    requests++; if (fail) { res.writeHead(503); return res.end('upstream down'); }
    res.end('{"windows":[{"name":"5h","used":10,"budget":100}]}');
  });
  const origin = await listen(mock), original = { ...b.s2 };
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG); cfg.backend = 'relay'; cfg.relay.setting_json = file; cfg.relay.url = origin; cfg.relay.auth_url = origin;
  const ctx = { sm: { accountId: 123 } };
  b.s2.getAccount = async () => ({ id: 123, name: cfg.sub2api.account_name, platform: 'anthropic', type: 'apikey', notes });
  b.s2.updateAccount = async (_, id, patch) => { assert.equal(id, 123); assert.deepEqual(Object.keys(patch), ['notes']); notes = patch.notes; updates.push(patch); };
  try {
    await b.refreshQuota(cfg, ctx); assert.equal(requests, 1); assert.match(notes, /剩余 90%/); assert.match(notes, /my manual note/);
    await b.refreshQuota(cfg, ctx); assert.equal(requests, 1); assert.equal(updates.length, 1);
    fail = true; await b.refreshQuota(cfg, ctx, { force: true }); assert.equal(ctx.quota.stale, true); assert.match(notes, /查询失败/);
    assert.ok(!notes.includes('剩余 90%')); assert.equal(updates.length, 2);
    cfg.quota.sync_notes = false; fail = false; await b.refreshQuota(cfg, ctx, { force: true }); assert.equal(updates.length, 2);
    assert.deepEqual(listProfiles(dir), []);
  } finally {
    Object.assign(b.s2, original); await close(mock);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('bridge-quota-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
