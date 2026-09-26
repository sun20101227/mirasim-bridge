'use strict';
// Identity injection scope, quota-fallback detection and byte-exact UTF-8 streaming. Local servers only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const b = require('../mirasim-bridge');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });
const CC = "You are Claude Code, Anthropic's official CLI for Claude.";
const hasCC = (system) => JSON.stringify(system || '').includes(CC);

test('sameModel follows the desktop client rule', () => {
  for (const [a, c] of [['claude-opus-4-8', 'claude-opus-4-8'], ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    ['gpt-6-astra', 'gpt-6-astra-latest'], ['anthropic.claude-sonnet-5', 'claude-sonnet-5']]) assert.equal(b.sameModel(a, c), true, `${a} = ${c}`);
  for (const [a, c] of [['gpt-6-astra', 'gpt-6-sol'], ['claude-opus-5', 'claude-sonnet-5'], ['claude-opus-4', 'claude-opus-4-8'], ['kimi-k3', 'deepseek-v4-flash']]) {
    assert.equal(b.sameModel(a, c), false, `${a} ≠ ${c}`);
  }
});

test('identity prompt only for Claude, retry safety net, fallback detection, exact UTF-8', { timeout: 20000 }, async (t) => {
  let seen = [], mode = 'ok', servedAs = null;
  const text = '中文校验：你好，世界！def f(x): return ((x+1)*(x-1))  # 结束 🙂';
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);
    if (mode === 'strict' && !hasCC(body.system)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"the request was rejected as invalid"}}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'message_start', message: { id: 'msg_1', model: servedAs || body.model, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }];
    const wire = Buffer.from(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    // One byte per write: every multi-byte character is split across chunks.
    for (let i = 0; i < wire.length; i++) { res.write(wire.subarray(i, i + 1)); if (i % 64 === 0) await new Promise((r) => setImmediate(r)); }
    res.end();
  });
  const upPort = await listen(upstream);
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG); cfg.constraints.disabled_models = [];
  const ctx = { keepalive: { pid: 42, ready: true, authFails: 0, noteUpstreamAuthFail() {} }, inflight: 0, backoffUntil: 0, startedAt: Date.now(),
    counters: { total: 0, rejected: 0, ok: 0, err: 0, injected: 0, sampling_retried: 0, cc_retried: 0, fallback: 0, models_filtered: 0, sanitized: {} } };
  const bridge = b.createBridgeServer(cfg, ctx, 'secret', 4), port = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); b.invalidateTarget(); });
  const call = (model) => {
    b.targetCache.at = Date.now();
    b.targetCache.value = { port: upPort, basePath: '', token: 'tok', keeperPid: 42, is_keepalive: true };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'x-api-key': 'secret', 'content-type': 'application/json' } }, (res) => {
        const out = []; res.on('data', (c) => out.push(c)); res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(out) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });
  };

  await t.test('non-Claude models are not told they are Claude Code', async () => {
    seen = [];
    for (const model of ['claude-opus-5', 'gpt-6-astra', 'kimi-k3']) assert.equal((await call(model)).status, 200);
    assert.deepEqual(seen.map((s) => hasCC(s.system)), [true, false, false]);
    assert.equal(ctx.counters.injected, 1);
  });
  await t.test('streamed UTF-8 survives byte-level chunking unchanged', async () => {
    const r = await call('gpt-6-astra');
    assert.ok(!r.raw.includes(Buffer.from([0xef, 0xbf, 0xbd])), 'no U+FFFD replacement characters');
    assert.ok(r.raw.toString('utf8').includes(JSON.stringify(text).slice(1, -1)), 'text arrives byte-for-byte');
  });
  await t.test('if relay starts requiring the identity block, one retry injects it', async () => {
    mode = 'strict'; seen = [];
    assert.equal((await call('gpt-6-astra')).status, 200);
    assert.deepEqual(seen.map((s) => hasCC(s.system)), [false, true]);
    assert.equal(ctx.counters.cc_retried, 1);
    mode = 'ok';
  });
  await t.test('observe: a substituted model is counted and forwarded', async () => {
    servedAs = 'gpt-6-luna';
    const r = await call('gpt-6-astra');
    assert.equal(r.status, 200); assert.equal(ctx.counters.fallback, 1);
    assert.deepEqual([ctx.lastFallback.requested, ctx.lastFallback.served], ['gpt-6-astra', 'gpt-6-luna']);
  });
  await t.test('forbid: a substituted turn is refused before any byte is sent', async () => {
    cfg.constraints.model_fallback = 'forbid';
    const r = await call('gpt-6-astra');
    assert.equal(r.status, 503); assert.match(r.raw.toString(), /model_fallback/);
    assert.ok(!r.raw.toString().includes('message_start'));
    servedAs = null;
    assert.equal((await call('gpt-6-astra')).status, 200, 'the real model still passes under forbid');
    cfg.constraints.model_fallback = 'observe';
  });
});
