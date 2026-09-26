'use strict';
// Offline integration tests: local HTTP servers only, no real credentials/relay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const b = require('../mirasim-bridge');
const config = () => b.deepMerge({}, b.DEFAULT_CONFIG);
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

test('configuration, isolation and redaction', () => {
  const cfg = config();
  cfg.keepalive.respawn_backoff_sec.push(999);
  assert.ok(!b.DEFAULT_CONFIG.keepalive.respawn_backoff_sec.includes(999));
  const merged = b.deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(merged.polluted, undefined);
  assert.throws(() => b.validateConfig({ ...cfg, health: null }));
  cfg.forward.max_concurrency = 0;
  assert.throws(() => b.validateConfig(cfg));
  cfg.forward.max_concurrency = 2;
  cfg.constraints.model_filter = '(';
  assert.throws(() => b.validateConfig(cfg));
  b.targetCache.at = Date.now();
  b.targetCache.value = { keeperPid: null, is_keepalive: false };
  assert.equal(b.resolveTarget(config(), { strict: true, preferPid: null }), null);
  const line = 'ANTHROPIC_BASE_URL=http://127.0.0.1:8787/private-prefix ANTHROPIC_AUTH_TOKEN=private-token';
  const pub = JSON.stringify(b.resolveAgentEnv(line, 0));
  assert.ok(!pub.includes('private-prefix') && !pub.includes('private-token'));
  const secret = b.resolveAgentEnv(line, 0, { withSecret: true });
  assert.equal(secret.base_path, '/private-prefix');
  assert.equal(secret.token, 'private-token');
  assert.deepEqual(b.mergedHeaders({ connection: 'x-remove', 'x-remove': 'bad', trailer: 'bad', good: 'yes' }), { good: 'yes' });
  b.invalidateTarget();
});

test('HTTP forwarding and cancellation', { timeout: 15000 }, async (t) => {
  let mode = 'models', seen, calls = 0, disconnected = false;
  const upstream = http.createServer(async (req, res) => {
    calls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen = { headers: req.headers, url: req.url, body: raw ? JSON.parse(raw) : null };
    if (mode === 'hang') return;
    if (mode === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: start\n\n');
      res.once('close', () => { disconnected = true; });
      return;
    }
    if (mode === 'auth') { res.writeHead(401); return res.end('unauthorized'); }
    if (mode === 'credit') { res.writeHead(400); return res.end('credit balance exhausted'); }
    if (mode === 'rate') { res.writeHead(429, { 'retry-after': '120' }); return res.end('slow down'); }
    if (mode === 'bad400') { res.writeHead(400); return res.end('invalid request'); }
    if (mode === 'unavailable' && seen.body?.model.startsWith('deepseek-')) {
      res.writeHead(503); return res.end(JSON.stringify({ error: { message: 'no upstream available for model deepseek-v4-flash' } }));
    }
    if (mode === 'sampling') {
      if (seen.body.temperature != null) { res.writeHead(400); return res.end('temperature unsupported'); }
      res.writeHead(401); return res.end('unauthorized on retry');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(mode === 'models' ? JSON.stringify({ data: [{ id: 'claude-test' }, { id: 'gpt-test' },
      { id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }, { id: 'glm-test' }, { id: 'claude-fable' }] }) : '{"ok":true}');
  });
  const upPort = await listen(upstream);
  const cfg = config();
  cfg.forward.upstream_headers_timeout_ms = 80;
  cfg.constraints.disabled_models = []; // explicit opt-in still supports DeepSeek if upstream recovers
  cfg.constraints.model_filter = '^(claude-|gpt-|deepseek-|kimi-)'; // the default is now open; this test exercises an explicit allow-list
  const ctx = {
    keepalive: { pid: 123456, ready: true, authFails: 0, noteUpstreamAuthFail() { this.authFails++; } },
    inflight: 0, backoffUntil: 0, startedAt: Date.now(),
    counters: { total: 0, rejected: 0, ok: 0, err: 0, injected: 0, sampling_retried: 0, models_filtered: 0, sanitized: {} },
  };
  const bridge = b.createBridgeServer(cfg, ctx, 'test-secret', 2);
  const port = await listen(bridge);
  const prime = () => {
    b.targetCache.at = Date.now();
    b.targetCache.value = { port: upPort, basePath: '/private-prefix', token: 'upstream-secret', keeperPid: 123456, is_keepalive: true };
  };
  const call = async (url = '/v1/models', body, headers = { 'x-api-key': 'test-secret' }) => {
    prime();
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', headers }, async (res) => {
        try { resolve({ status: res.statusCode, body: await b.readStreamText(res) }); } catch (err) { reject(err); }
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  };
  const payload = { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 };
  try {
    await t.test('internal endpoints require authentication', async () => {
      assert.equal((await call('/__status', null, {})).status, 503);
      assert.equal((await call('/__status')).status, 200);
    });
    await t.test('models filter, real prefix and credential replacement', async () => {
      const r = await call('/v1/models', null, { authorization: 'Bearer test-secret', connection: 'x-remove', 'x-remove': 'bad' });
      assert.deepEqual(JSON.parse(r.body).data, [{ id: 'claude-test' }, { id: 'gpt-test' }, { id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }]);
      assert.equal(seen.url, '/private-prefix/v1/models');
      assert.equal(seen.headers.authorization, 'Bearer upstream-secret');
      assert.equal(seen.headers['x-api-key'], undefined);
      assert.equal(seen.headers['x-remove'], undefined);
      assert.equal(seen.headers['accept-encoding'], 'identity');
    });
    await t.test('sanitize/inject messages', async () => {
      mode = 'message';
      assert.equal((await call('/v1/messages', { ...payload, temperature: 0.4 })).status, 200);
      assert.equal(seen.body.temperature, undefined);
      assert.ok(seen.body.system.length > 0);
    });
    for (const model of ['gpt-test', 'deepseek-v4-flash', 'kimi-k3']) {
      await t.test(`Messages forwards ${model} without aliasing`, async () => {
        mode = 'message';
        assert.equal((await call('/v1/messages', { ...payload, model })).status, 200);
        assert.equal(seen.body.model, model);
        assert.equal(seen.url, '/private-prefix/v1/messages');
      });
    }
    await t.test('unavailable DeepSeek does not trip global credential/cooldown state', async () => {
      mode = 'unavailable';
      const result = await call('/v1/messages', { ...payload, model: 'deepseek-v4-flash' });
      assert.equal(result.status, 503);
      assert.match(result.body, /no upstream available/);
      assert.equal(ctx.backoffUntil, 0);
      assert.equal(ctx.keepalive.authFails, 0);
      assert.equal((await call('/v1/messages', { ...payload, model: 'gpt-test' })).status, 200);
    });
    await t.test('catalog and request filtering use the same policy', async () => {
      const before = calls;
      assert.equal((await call('/v1/messages', { ...payload, model: 'glm-test' })).status, 400);
      assert.equal(calls, before);
    });
    await t.test('already removed sampling parameters are not replayed on 400', async () => {
      mode = 'bad400'; const before = calls;
      assert.equal((await call('/v1/messages', { ...payload, temperature: 0.2 })).status, 400);
      assert.equal(calls - before, 1);
    });
    await t.test('invalid JSON shape and compressed input rejected without upstream call', async () => {
      const before = calls;
      assert.equal((await call('/v1/messages', [])).status, 400);
      assert.equal((await call('/v1/messages', payload, { 'x-api-key': 'test-secret', 'content-encoding': 'gzip' })).status, 400);
      assert.equal(calls, before);
    });
    await t.test('retry response passes through auth handling', async () => {
      mode = 'sampling'; cfg.constraints.sampling_models = '^claude-test$';
      assert.equal((await call('/v1/messages', { ...payload, temperature: 0.4 })).status, 503);
      assert.equal(ctx.keepalive.authFails, 1);
      cfg.constraints.sampling_models = '';
    });
    await t.test('credit exhaustion cannot become permanent account auth error', async () => {
      mode = 'credit';
      assert.equal((await call('/v1/messages', payload)).status, 503);
      assert.ok(ctx.backoffUntil > Date.now()); ctx.backoffUntil = 0;
    });
    await t.test('Retry-After respected, requests suppressed during cooldown', async () => {
      mode = 'rate';
      assert.equal((await call()).status, 429);
      assert.ok(ctx.backoffUntil - Date.now() > 119000);
      const before = calls;
      assert.equal((await call()).status, 503);
      assert.equal(calls, before); ctx.backoffUntil = 0;
    });
    await t.test('no response headers times out and releases concurrency', async () => {
      mode = 'hang';
      assert.equal((await call()).status, 503);
      await delay(20); assert.equal(ctx.inflight, 0);
    });
    await t.test('session backend is not a generic proxy onto the local Mirasim server', async () => {
      const before = calls;
      for (const [url, body] of [['/api/shell', { cmd: 'x' }], ['/v1/complete', payload], ['/auth/me', null], ['/v1/messages', null]]) {
        assert.equal((await call(url, body)).status, 400);
      }
      assert.equal(calls, before);
    });
    await t.test('client cancellation destroys upstream SSE and releases concurrency', async () => {
      mode = 'stream'; prime();
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' } }, (res) => {
          res.once('data', () => { res.destroy(); resolve(); });
        });
        req.on('error', reject); req.end(JSON.stringify(payload));
      });
      for (let n = 0; n < 30 && (!disconnected || ctx.inflight); n++) await delay(10);
      assert.equal(disconnected, true); assert.equal(ctx.inflight, 0);
    });
    await t.test('shutdown rejects new traffic', async () => {
      ctx.shuttingDown = true;
      const before = calls;
      assert.equal((await call()).status, 503); assert.equal(calls, before);
    });
  } finally { await close(bridge); await close(upstream); b.invalidateTarget(); }
});

test('model diagnostics require a completed response with visible text', () => {
  const encode = (...events) => events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
  const start = { type: 'message_start', message: { usage: { input_tokens: 10 } } };
  const text = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } };
  const end = { type: 'message_stop' };
  const summary = (raw, status = 200) => b.summarizeModelResponse({ raw, status });
  assert.equal(summary(encode(start, text, end)).ok, true);
  assert.equal(summary(encode(start, text)).ok, false);
  assert.equal(summary(encode(start, end)).ok, false);
  assert.equal(summary(encode(start, text, { type: 'error', error: { message: 'failed' } }, end)).ok, false);
  assert.equal(summary('{"error":{"message":"no upstream available"}}', 503).error, 'no upstream available');
  assert.equal(summary(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' })).ok, true);
  const cfg = config();
  for (const model of ['claude-test', 'gpt-test', 'deepseek-test', 'kimi-k3']) assert.equal(b.isModelAllowed(model, cfg), true);
  assert.equal(b.isModelAllowed('deepseek-flash', cfg), false);
  cfg.constraints.model_filter = '^claude-';
  assert.equal(b.isModelAllowed('gpt-test', cfg), false); // Preserve explicit existing overrides.
});

test('safe registration and serialized scheduler transitions', async () => {
  const original = { ...b.s2 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const cfg = config();
  cfg._config_path = path.join(dir, 'config.json');
  cfg.sub2api.base_url = 'https://same-machine.example';
  cfg.sub2api.group_ids = [15];
  cfg.bridge_secret = 'test-only';
  const events = [];
  try {
    b.s2.findAccountByName = async () => null;
    b.s2.createAccount = async (_, body) => { assert.deepEqual(body.group_ids, []); events.push('create'); return { id: 123 }; };
    b.s2.setSchedulable = async (_, id, enabled) => { events.push(enabled ? 'resume' : 'pause'); };
    b.s2.updateAccount = async () => events.push('update');
    b.s2.syncModels = async () => { events.push('sync'); throw Error('unreachable'); };
    const result = await b.cmdRegister(cfg, { flags: {} });
    assert.deepEqual(events, ['create', 'pause', 'update', 'sync', 'pause']);
    assert.equal(result.reachable, false);
    assert.equal(b.loadState(cfg).account_id, 123);
    // Keep a pool assignment changed by the operator across bridge restarts.
    b.s2.findAccountByName = async () => ({ id: 123, group_ids: [8], credentials: {} });
    let existingPatch;
    b.s2.updateAccount = async (_, id, patch) => { existingPatch = patch; };
    await b.cmdRegister(cfg, { flags: {} });
    assert.equal(Object.hasOwn(existingPatch, 'group_ids'), false);
    cfg.sub2api.manage_existing_groups = true;
    await b.cmdRegister(cfg, { flags: {} });
    assert.deepEqual(existingPatch.group_ids, [15]);
    events.length = 0;
    b.s2.clearTempUnschedulable = async () => delay(20);
    b.s2.clearError = async () => {};
    b.s2.clearRateLimit = async () => {};
    const sm = new b.ScheduleState(cfg, 123);
    await Promise.all([sm.resume('test'), sm.pause('shutdown')]);
    assert.deepEqual(events, ['resume', 'pause']);
    assert.equal(sm.desired, 'off');
  } finally {
    Object.assign(b.s2, original);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('bridge-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
