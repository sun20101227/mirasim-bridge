'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { UsageObservation, UsageStore, storeFor, estimate } = require('../lib/usage');
const { TerminalEvents } = require('../lib/sse');
const { createPanel } = require('../lib/panel');
const { createCredential } = require('../lib/login');
const b = require('../mirasim-bridge');
const frame = e => 'data: ' + JSON.stringify(e) + '\n\n';
const NOW = Date.parse('2026-09-26T08:00:00Z');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-usage-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('mira-usage-')); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const record = patch => ({ model: 'claude-test', served_model: 'claude-test', protocol: 'messages', ok: true, status: 200, elapsed_ms: 10, attempts: 1,
  input_tokens: 150, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 10, reasoning_tokens: null, usage_state: 'complete', ...patch });
const rates = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };

test('cumulative Messages usage includes cache once, split UTF-8 frames and named events are observed', () => {
  const usage = new UsageObservation('messages'), parser = new TerminalEvents('messages', (e,t) => usage.accept(e,t));
  const raw = Buffer.from(frame({ type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } } })
    + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } })
    + frame({ type: 'message_delta', usage: { output_tokens: 10 } }) + frame({ type: 'message_delta', usage: { output_tokens: 20 } })
    + 'event: message_stop\ndata: {}\n\n');
  for (let i = 0; i < raw.length; i++) parser.push(raw.subarray(i, i + 1));
  assert.equal(usage.served, 'claude-test');
  assert.deepEqual(usage.snapshot(), { input_tokens: 150, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 10, reasoning_tokens: null, usage_state: 'complete' });
  assert.ok(Math.abs(estimate(usage.snapshot(), rates) - 0.0006495) < 1e-12);
});
test('Responses cache and reasoning are subsets, incomplete/missing/invalid usage is not billed as zero', () => {
  const usage = new UsageObservation('responses');
  usage.accept({ type: 'response.completed', response: { model: 'gpt-test', usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 20 } } } });
  assert.equal(usage.snapshot().input_tokens, 100);
  assert.equal(usage.snapshot().output_tokens, 30);
  assert.ok(Math.abs(estimate(usage.snapshot(), rates) - 0.000642) < 1e-12);
  assert.equal(new UsageObservation('messages').snapshot().usage_state, 'unknown');
  const broken = new UsageObservation('messages'); broken.accept({ type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 0 } } });
  assert.equal(broken.snapshot().usage_state, 'partial'); assert.equal(estimate(broken.snapshot(), rates), null);
  broken.accept({ type: 'message_stop' });
  assert.equal(broken.snapshot().usage_state, 'partial', 'message_start output=0 is not final output usage');
  usage.accept({ type: 'response.completed', response: { usage: { input_tokens: -2 } } });
  assert.equal(usage.snapshot().usage_state, 'partial');
  assert.equal(estimate(record(), { ...rates, cache_read: null }), null);
  assert.equal(estimate(record(), { input: 0, output: 0, cache_read: 0, cache_write: 0 }), 0);
});
test('persistent accounting is concurrent-safe, uses a strict data allowlist and preserves historical prices', async t => {
  const dir = temp(t), store = new UsageStore(dir, { now: () => NOW });
  await store.setPrice('claude-test', rates);
  await Promise.all(Array.from({ length: 40 }, () => store.record(record({ prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_KEY', completion: 'PRIVATE_REPLY' }))));
  await store.setPrice('claude-test', { input: 0, output: 0, cache_read: 0, cache_write: 0 });
  await store.record(record({ model: 'gpt-test', served_model: 'gpt-test', protocol: 'responses', usage_state: 'unknown', input_tokens: null, output_tokens: null, ok: false, status: 503 }));
  let result = await store.query();
  assert.equal(result.total.requests, 41); assert.equal(result.total.priced, 40); assert.equal(result.total.unknown, 1);
  assert.ok(Math.abs(result.total.estimated_usd - 40 * 0.0006495) < 1e-12);
  assert.equal((await store.query()).total.requests, 41, 'polling never re-counts records');
  const restarted = new UsageStore(dir, { now: () => NOW });
  result = await restarted.query({ days: 1, model: 'claude-test' });
  assert.equal(result.total.requests, 40); assert.equal(result.total.input_tokens, 6000);
  await restarted.record(record());
  assert.equal((await restarted.query({ days: 1, model: 'claude-test' })).total.requests, 41);
  assert.equal((await store.query()).total.requests, 42, 'new appended bytes can be read without duplicating old bytes');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '2026-09-26.jsonl'), 'utf8'), /PRIVATE_/);
  assert.throws(() => store.query({ days: 90 }), /参数/);
  assert.throws(() => store.setPrice('claude-test', { ...rates, input: -1 }), /单价/);
});
test('retention, corrupted lines, daily storage bounds and failed writes are explicit', async t => {
  const dir = temp(t); let now = NOW - 30 * 86400000;
  const store = new UsageStore(dir, { now: () => now }); await store.record(record());
  const old = path.join(dir, '2026-08-27.jsonl'); assert.equal(fs.existsSync(old), true);
  now = NOW; fs.writeFileSync(path.join(dir, '2026-09-26.jsonl'), '{partial crash');
  await store.record(record()); const result = await store.query();
  assert.equal(fs.existsSync(old), false); assert.equal(result.total.requests, 1); assert.equal(result.invalid_lines, 1);
  assert.equal((await new UsageStore(dir, { now: () => now }).query()).total.requests, 1);
  const full = path.join(dir, '2026-09-26.jsonl'); fs.truncateSync(full, 8 * 1024 * 1024 + 1);
  await store.record(record()); assert.equal(store.dropped, 1); assert.equal((await store.query()).storage_error, true);
  const notDirectory = path.join(dir, 'file'); fs.writeFileSync(notDirectory, 'x');
  const broken = new UsageStore(notDirectory, { now: () => now }); await broken.record(record());
  assert.equal(broken.dropped, 1); assert.equal((await broken.query()).storage_error, true);
});
test('account-scoped panel reads and prices cannot cross profile boundaries', async t => {
  const dir = temp(t), cfg = b.deepMerge({}, b.DEFAULT_CONFIG); cfg.backend = 'relay'; cfg._config_path = path.join(dir, 'config.json');
  const ctx = b.newAccountCtx('main'), second = { key: 'second', cfg: { ...cfg, _config_path: path.join(dir, 'profiles/second/config.json') }, ctx: b.newAccountCtx('second') };
  ctx.hub = { get: name => name === 'second' ? second : null };
  await storeFor(cfg, ctx).record(record()); await storeFor(second.cfg, second.ctx).record(record({ model: 'kimi-test' }));
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  assert.equal((await panel.call('usage', { account: 'second' })).models[0].model, 'kimi-test');
  await panel.call('usage/pricing', { account: 'second', model: 'kimi-test', rates });
  assert.equal(Object.keys((await panel.call('usage')).prices).length, 0);
  await assert.rejects(panel.call('usage', { account: '../second' }), /标识/);
  await assert.rejects(panel.call('usage', { account: 'missing' }), /托管/);
});

test('real bridge pass-through records Messages, Responses and compact without changing response bytes or making probes', async t => {
  const dir = temp(t); let mode = 'messages', calls = 0;
  const messageJson = JSON.stringify({ type: 'message', model: 'claude-test', content: [{ type: 'text', text: 'private reply' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } });
  const response = { object: 'response', model: 'gpt-test', status: 'completed', output: [{ type: 'message', content: [] }], usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 20 } } };
  const messageStream = frame({ type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 100, output_tokens: 0 } } })
    + frame({ type: 'message_delta', usage: { output_tokens: 20 } }) + frame({ type: 'message_stop' });
  const responseStream = frame({ type: 'response.created', response: { model: 'gpt-test' } }) + frame({ type: 'response.completed', response });
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url === '/v1/device/session') return res.end('{"ticket":"test","expiresIn":600}');
    calls++;
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"claude-test"}]}');
    if (mode === 'error') { res.writeHead(500); return res.end('unavailable'); }
    const streaming = ['messages', 'responses', 'partial'].includes(mode);
    res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
    res.end(mode === 'messages' ? messageStream : mode === 'responses' ? responseStream : mode === 'partial' ? messageStream.split('data: {"type":"message_stop"}')[0] : mode === 'json' ? messageJson : JSON.stringify({ ...response, object: 'response.compaction' }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG); cfg.backend = 'relay'; cfg._config_path = path.join(dir, 'config.json'); cfg.bridge_secret = 'test-bridge';
  cfg.relay.url = cfg.relay.auth_url = `http://127.0.0.1:${upstream.address().port}`; cfg.relay.setting_json = 'setting.json';
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'test-access', refresh: 'test-refresh' })));
  const ctx = b.newAccountCtx('main'), server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 4);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const s of [server, upstream]) await new Promise(r => { s.close(r); s.closeAllConnections(); }); await ctx.usageStore?.queue; });
  const call = async (route, body, key = cfg.bridge_secret) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await result.text();
    // Response bytes arrive before accounting finishes; wait for request finalization.
    for (let i = 0; ctx.inflight && i < 200; i++) await new Promise(r => setTimeout(r, 5));
    return { status: result.status, text };
  };
  const messages = { model: 'claude-test', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], max_tokens: 20, stream: true };
  assert.equal((await call('/v1/messages', messages)).text, messageStream);
  mode = 'json'; assert.equal((await call('/v1/messages', { ...messages, stream: false })).text, messageJson);
  mode = 'responses'; assert.equal((await call('/v1/responses', { model: 'gpt-test', input: 'PRIVATE_PROMPT', stream: true })).text, responseStream);
  assert.equal(JSON.parse((await call('/v1/responses', { model: 'gpt-test', input: 'PRIVATE_PROMPT', stream: false })).text).usage.output_tokens, 30);
  mode = 'compact'; assert.equal((await call('/backend-api/codex/responses/compact', { model: 'gpt-test', input: [] })).status, 200);
  mode = 'partial'; assert.match((await call('/v1/messages', messages)).text, /upstream_stream_truncated/);
  mode = 'error'; assert.equal((await call('/v1/messages', messages)).status, 500);
  const before = calls;
  await call('/v1/messages', messages, 'bad-key');
  let result = await storeFor(cfg, ctx).query();
  assert.equal(calls, before); assert.equal(result.total.requests, 7); assert.equal(result.total.complete, 5);
  assert.equal(result.total.partial, 1); assert.equal(result.total.unknown, 1); assert.equal(result.total.failed, 2);
  await call('/v1/models'); result = await storeFor(cfg, ctx).query(); assert.equal(result.total.requests, 7);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|private reply|test-access|test-bridge/);
  assert.equal((await new UsageStore(path.join(dir, 'usage')).query()).total.requests, 7);
});
