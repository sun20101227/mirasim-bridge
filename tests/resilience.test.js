'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { RelayClient, loadCredential, parseCredential, request, readText } = require('../lib/relay');
const { aggregateResponses } = require('../lib/responses');
const bridge = require('../mirasim-bridge');

async function fixture(t, handler, expires = 3600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-resilience-'));
  const file = path.join(dir, 'setting.json');
  const setting = { auth: { token: 'access-old', refreshToken: 'refresh-old', exp: Math.floor(Date.now() / 1000) + expires },
    device: { privateKey: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) } };
  fs.writeFileSync(file, JSON.stringify(setting));
  const server = http.createServer(async (req, res) => {
    try { await readText(req); await handler(req, res); }
    catch { res.destroy(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { url, auth_url: url, setting_json: file, client_version: '0.0.354', collect: false };
  t.after(async () => {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('bridge-resilience-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { file, setting, options, server, url, client: new RelayClient(options) };
}
const mint = (res) => res.end(JSON.stringify({ ticket: 'ticket-new', expiresIn: 600 }));
const tokens = (res) => res.end(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }));

test('rotation survives one failed disk rename without refreshing the spent token again', async (t) => {
  let refreshes = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/auth/refresh') { refreshes++; return tokens(res); }
    return mint(res);
  }, -1);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.file) throw Object.assign(Error('denied'), { code: 'EACCES' }); return rename(from, to); };
  try { await assert.rejects(f.client.ensureAccess(), /Cannot persist refreshed credential/); }
  finally { fs.renameSync = rename; }
  assert.equal(refreshes, 1);
  assert.equal(f.client.credential.access, 'access-new');
  assert.equal(loadCredential(f.file).access, 'access-old');
  assert.ok(f.client.pendingCredential);
  assert.ok(fs.existsSync(f.file + '.refresh-lock'));
  await f.client.ensureAccess();
  assert.equal(refreshes, 1); assert.equal(loadCredential(f.file).refresh, 'refresh-new');
  assert.equal(f.client.pendingCredential, null);
  assert.ok(!fs.existsSync(f.file + '.refresh-lock'));
});

test('two clients sharing a credential serialize refresh and reread rotated secrets', async (t) => {
  let refreshes = 0;
  const f = await fixture(t, async (req, res) => {
    if (req.url === '/auth/refresh') { refreshes++; await delay(30); return tokens(res); }
    return mint(res);
  }, -1);
  const other = new RelayClient(f.options);
  await Promise.all([f.client.ensureAccess(), other.ensureAccess()]);
  assert.equal(refreshes, 1); assert.equal(other.credential.access, 'access-new');
});

test('refresh Retry-After is honored while an unexpired access token stays usable', async (t) => {
  let count = 0;
  const f = await fixture(t, (_, res) => { count++; res.writeHead(429, { 'retry-after': '120' }); res.end('contains-reflected-secret'); }, 90);
  await f.client.ensureAccess(); await f.client.ensureAccess();
  assert.equal(count, 1); assert.ok(f.client.refreshRetry > Date.now() + 119000);
  f.client.forceRefresh = true;
  await assert.rejects(f.client.ensureAccess(), /cooling down/);
});

test('ticket 401 never reuses the old ticket even if its expiry is in the future', async (t) => {
  const f = await fixture(t, (_, res) => { res.writeHead(401); res.end('refused'); });
  f.client.ticket = 'old-but-not-expired'; f.client.ticketExpires = Date.now() + 60000;
  await assert.rejects(f.client.getTicket(), /HTTP 401/);
  assert.equal(f.client.ticket, ''); assert.equal(f.client.forceRefresh, true);
});

test('a late old-request 401 cannot invalidate a newly minted ticket', async (t) => {
  let release, requested;
  const arrived = new Promise((r) => { requested = r; });
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/device/session') return mint(res);
    requested(); release = () => { res.writeHead(401); res.end('old request rejected'); };
  });
  f.client.ticket = 'ticket-old'; f.client.ticketExpires = Date.now() + 600000;
  const pending = f.client.request({ path: '/v1/models' });
  await arrived;
  const replacement = { ...f.setting, auth: { ...f.setting.auth, token: 'access-new', refreshToken: 'refresh-new' } };
  fs.writeFileSync(f.file, JSON.stringify(replacement));
  assert.equal(await f.client.getTicket(), 'ticket-new');
  release(); const res = await pending; await readText(res);
  assert.equal(res.statusCode, 401); assert.equal(f.client.ticket, 'ticket-new');
  assert.equal(f.client.forceRefresh, false);
});

test('cancelled caller stops waiting on shared mint; another caller still succeeds', async (t) => {
  let count = 0, release, requested;
  const arrived = new Promise((r) => { requested = r; });
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/device/session') { count++; requested(); release = () => mint(res); return; }
    res.end('{"data":[{"id":"gpt-test"}]}');
  });
  const controller = new AbortController();
  const cancelled = f.client.request({ path: '/v1/models', signal: controller.signal });
  const rejected = assert.rejects(cancelled, /aborted/i);
  await arrived;
  const survivor = f.client.request({ path: '/v1/models' });
  controller.abort(); await rejected;
  release(); const res = await survivor; assert.equal(res.statusCode, 200); await readText(res);
  assert.equal(count, 1);
  const before = count;
  await assert.rejects(f.client.request({ path: '/v1/models', signal: AbortSignal.abort() }));
  assert.equal(count, before);
});

test('total deadline terminates a response that keeps trickling bytes', async (t) => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(200); res.write('partial');
    const timer = setInterval(() => res.write('x'), 10);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  const res = await request(new URL(f.url), { totalTimeout: 80, headersTimeout: 1000, idleTimeout: 1000 });
  await assert.rejects(readText(res)); assert.ok(Date.now() - started < 1500);
});

test('malformed credential/JWT and nonterminal Responses fail safely', async (t) => {
  const f = await fixture(t, (_, res) => res.end());
  assert.throws(() => parseCredential(null), /JSON object/);
  assert.doesNotThrow(() => parseCredential({ ...f.setting, auth: { ...f.setting.auth, token: 'e30.bnVsbA.x' } }));
  for (const raw of ['{"object":"response","status":"in_progress"}', '{"object":"response","status":"completed","output":"invalid"}', 'data: null\n\n']) {
    assert.throws(() => aggregateResponses(raw));
  }
});

test('catalog variants filter consistently and malformed catalogs fail closed', async (t) => {
  let body = { models: [{ id: 'gpt-test' }, { id: 'gpt-fable' }] };
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/device/session') return mint(res);
    res.end(JSON.stringify(body));
  });
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG); cfg.backend = 'relay'; cfg.constraints.model_block = 'fable'; cfg.relay = { ...cfg.relay, ...f.options };
  const ctx = { inflight: 0, backoffUntil: 0, startedAt: Date.now(), counters: { total: 0, ok: 0, err: 0, rejected: 0, models_filtered: 0 } };
  const server = bridge.createBridgeServer(cfg, ctx, 'test', 2);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const target = { host: '127.0.0.1', port: server.address().port, prefix: '', headers: { 'x-api-key': 'test' } };
  const result = await bridge.diagnosticRequest(target, '/v1/models');
  assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.raw), { models: [{ id: 'gpt-test' }] });
  body = { models: 'not-an-array' };
  assert.equal((await bridge.diagnosticRequest(target, '/v1/models')).status, 503);
  assert.equal(bridge.getRelay(cfg).ready, false);
  body = { data: [{ id: 'gpt-fable' }] };
  const probe = await bridge.probeUpstream(bridge.resolveTarget(cfg), '/v1/models', cfg);
  assert.equal(probe.modelCount, 0); assert.equal(bridge.getRelay(cfg).ready, false);
  assert.equal((await bridge.diagnosticRequest(target, '/v1/messages/count_tokens', { model: 'gpt-fable' })).status, 400);
});

test('catalog discovery accepts all supported shapes and preserves an unfiltered response byte-for-byte', () => {
  const rows = [{ id: 'gpt-6-astra', owned_by: 'mirasim' }, { id: 'kimi-code/k3' }];
  for (const value of [rows, { data: rows }, { models: rows }, { items: rows }, { result: { models: rows } }]) {
    assert.deepEqual(bridge.catalogRows(value).map((m) => typeof m === 'string' ? m : m.id), ['gpt-6-astra', 'kimi-code/k3']);
  }
  assert.deepEqual(bridge.catalogRows({ models: { 'gpt-6-astra': { owned_by: 'mirasim' } } }).map((m) => m.id), ['gpt-6-astra']);
  assert.deepEqual(bridge.catalogRows({ data: [] }), []);
  assert.throws(() => bridge.catalogRows({ broken: true }), /Invalid/);
});

test('shutdown deadline includes stuck registration, closes listener and cannot later resume work', async () => {
  const events = [];
  let release;
  const registration = new Promise((r) => { release = r; });
  const ctx = { inflight: 0 };
  const cfg = { shutdown: { total_timeout_sec: 0.06, drain_timeout_sec: 0.01 } };
  let exited;
  const done = new Promise((r) => { exited = r; });
  const stop = bridge.createShutdownHandler(cfg, ctx, {
    server: { close() { events.push('close'); }, closeAllConnections() { events.push('destroy'); } },
    registration: () => registration, stopHealth: () => events.push('stop-health'),
    exit: (code) => { events.push(code); exited(); },
  });
  await stop('test'); await done;
  release(); await delay(1);
  assert.deepEqual(events, ['stop-health', 'close', 'destroy', 1]);
  assert.equal(ctx.shuttingDown, true);
});

test('shutdown pauses account then drains before stopping upstream; repeated stop is idempotent', async () => {
  const events = [];
  const cfg = { shutdown: { total_timeout_sec: 0.2, drain_timeout_sec: 0.1 } };
  let exited;
  const done = new Promise((r) => { exited = r; });
  const ctx = { inflight: 1, sm: { async pause() { events.push('pause'); ctx.inflight = 0; } },
    keepalive: { stop() { events.push('upstream-stop'); } } };
  const stop = bridge.createShutdownHandler(cfg, ctx, {
    server: { close() { events.push('close'); }, closeAllConnections() {} }, registration: async () => {},
    stopHealth: () => {}, exit: (code) => { events.push(code); exited(); },
  });
  await Promise.all([stop('first'), stop('second')]); await done;
  assert.deepEqual(events, ['close', 'pause', 'upstream-stop', 0]);
});

test('account lookup paginates and refuses ambiguous names instead of modifying an arbitrary account', async (t) => {
  let duplicate = false;
  const pages = [];
  const f = await fixture(t, (req, res) => {
    const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page'));
    pages.push(page);
    const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ name: i === 0 && duplicate ? 'wanted' : `wanted-extra-${i}`, id: i + 1 })) : [{ name: 'wanted', id: 101 }];
    res.end(JSON.stringify({ code: 0, data: { items, total: 101 } }));
  });
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG); cfg.sub2api.base_url = f.url;
  assert.equal((await bridge.s2.findAccountByName(cfg, 'wanted')).id, 101);
  assert.deepEqual(pages, [1, 2]);
  duplicate = true;
  await assert.rejects(bridge.s2.findAccountByName(cfg, 'wanted'), /多个同名账号/);
});
