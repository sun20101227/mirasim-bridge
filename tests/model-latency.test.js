'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TerminalEvents } = require('../lib/sse');
const b = require('../mirasim-bridge');

test('DeepSeek failing IDs disabled by default with explicit opt-in; Kimi defaults preserve caller controls', () => {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) assert.equal(b.isModelAllowed(id, cfg), false);
  cfg.constraints.disabled_models = []; assert.equal(b.isModelAllowed('deepseek-flash', cfg), true);
  const body = () => ({ model: 'kimi-k3', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 64 });
  assert.equal(b.sanitizeMessagesRequest(body(), cfg).body.output_config.effort, 'low');
  assert.equal(b.sanitizeMessagesRequest({ ...body(), output_config: { effort: 'max' } }, cfg).body.output_config.effort, 'max');
  assert.equal(b.sanitizeMessagesRequest({ ...body(), thinking: { type: 'disabled' } }, cfg).body.output_config, undefined);
  cfg.constraints.kimi_default_effort = ''; assert.equal(b.sanitizeMessagesRequest(body(), cfg).body.output_config, undefined);
});

test('terminal detector handles split UTF8, CRLF, comments and error frames', () => {
  const e = new TerminalEvents('messages');
  const bytes = Buffer.from('data: {"type":"content_block_delta","delta":{"text":"你好"}}\r\n\r\n');
  for (const byte of bytes) e.push(Buffer.from([byte]));
  assert.equal(e.done, false);
  e.push(Buffer.from(': ping\n\ndata: {"type":"message_stop"}\n')); assert.equal(e.done, false);
  e.push(Buffer.from('\n')); assert.equal(e.done, true); assert.equal(e.failed, false);
  const f = new TerminalEvents('responses'); f.push(Buffer.from('data: {"type":"response.failed"}\n\n')); assert.equal(f.failed, true);
});

test('bridge stops waiting at message_stop even when upstream keeps the connection open', { timeout: 5000 }, async () => {
  let closed = false;
  const upstream = http.createServer((req, res) => {
    req.resume(); req.once('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '99999' });
      res.write('data: {"type":"message_start","message":{"usage":{}}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\ndata: {"type":"message_stop"}\n\n');
      res.once('close', () => { closed = true; }); // deliberately never end()
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  const ctx = { inflight: 0, backoffUntil: 0, startedAt: Date.now(), counters: { total: 0, ok: 0, err: 0, rejected: 0, injected: 0, sanitized: {} } };
  const server = b.createBridgeServer(cfg, ctx, 'test-key', 2);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  b.targetCache.at = Date.now(); b.targetCache.value = { port: upstream.address().port, basePath: '', token: 'mock' };
  try {
    const target = { host: '127.0.0.1', port: server.address().port, prefix: '', headers: { 'x-api-key': 'test-key' } };
    const out = await b.checkDiagnosticModel(target, 'kimi-k3', { flags: { 'timeout-sec': '2' } });
    assert.equal(out.ok, true); assert.equal(out.text, 'OK'); assert.ok(out.elapsed_ms < 1800);
    await new Promise((r) => setTimeout(r, 30)); assert.equal(closed, true); assert.equal(ctx.inflight, 0);
  } finally {
    b.invalidateTarget(); await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    await new Promise((r) => { upstream.close(r); upstream.closeAllConnections(); });
  }
});

test('test timeout is bounded and reported without infinite retries', { timeout: 5000 }, async () => {
  let calls = 0;
  const server = http.createServer((req) => { calls++; req.resume(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const target = { host: '127.0.0.1', port: server.address().port, prefix: '', headers: {} };
    const out = await b.checkDiagnosticModel(target, 'kimi-k3', { flags: { 'timeout-sec': '1' } });
    assert.equal(out.ok, false); assert.equal(out.timeout_sec, 1); assert.match(out.error, /超时/); assert.equal(calls, 1);
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
});

test('one slow Kimi request cannot consume both upstream slots; cancellation releases its family slot', { timeout: 5000 }, async () => {
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (body.model === 'kimi-k3') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
    res.end('{"type":"message","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  const ctx = { inflight: 0, backoffUntil: 0, startedAt: Date.now(), counters: { total: 0, ok: 0, err: 0, rejected: 0, injected: 0, sanitized: {} } };
  const server = b.createBridgeServer(cfg, ctx, 'secret', 2);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const target = { host: '127.0.0.1', port: server.address().port, prefix: '', headers: { 'x-api-key': 'secret' } };
  const prime = () => { b.targetCache.at = Date.now(); b.targetCache.value = { port: upstream.address().port, token: 'mock', basePath: '' }; };
  let held;
  try {
    prime();
    held = await new Promise((resolve, reject) => {
      const req = http.request({ host: target.host, port: target.port, path: '/v1/messages', method: 'POST', headers: target.headers }, (res) => { res.once('data', () => resolve(res)); });
      req.on('error', reject); req.end(JSON.stringify({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }));
    });
    assert.equal(ctx.kimiInflight, 1); prime();
    assert.equal((await b.checkDiagnosticModel(target, 'kimi-k3', { flags: {} })).status, 503);
    prime(); assert.equal((await b.checkDiagnosticModel(target, 'claude-test', { flags: {} })).ok, true);
    held.destroy();
    for (let i = 0; i < 30 && ctx.kimiInflight; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx.kimiInflight, 0);
  } finally {
    held?.destroy(); b.invalidateTarget();
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
    await new Promise((r) => { upstream.close(r); upstream.closeAllConnections(); });
  }
});
