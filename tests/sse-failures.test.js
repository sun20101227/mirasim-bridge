'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const b = require('../mirasim-bridge');
const { TerminalEvents } = require('../lib/sse');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });
const frame = (data) => 'data: ' + JSON.stringify(data) + '\n\n';
const start = frame({ type: 'message_start', message: { id: 'mock', content: [], usage: {} } });

test('SSE failures are explicit, never fake a successful finish or replay inference', async (t) => {
  let mode, calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream', ...(mode === 'encoded' ? { 'content-encoding': 'gzip' } : {}) });
    if (mode === 'empty') return res.end();
    if (mode === 'comments') return res.end(': ping\n\ndata: {"type":"ping"}\n\n');
    if (mode === 'error') return res.end('event: error\ndata: {"error":{"message":"secret upstream body","type":"api_error"}}\n\n');
    if (mode === 'json') return res.end('data: invalid json\n\n');
    if (mode === 'wrong-protocol') return res.end(frame({ choices: [{ delta: { content: 'Wrong protocol' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    if (mode === 'encoded') return res.end('not decodable as SSE');
    if (mode === 'heartbeat') {
      res.write(': ping\n\n'); const timer = setInterval(() => res.write(': ping\n\n'), 10);
      res.on('close', () => clearInterval(timer)); return;
    }
    res.write(start);
    if (mode === 'valid-tool') return res.end(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'tool', input: {} } })
      + frame({ type: 'content_block_stop', index: 0 }) + frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } })
      + frame({ type: 'message_stop' }));
    const timer = setTimeout(() => {
      if (mode === 'late-error') res.end(frame({ type: 'error', error: { type: 'api_error', message: 'failed after start' } }));
      else if (mode === 'tcp-reset') res.destroy();
      else res.end(frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }));
    }, 25);
    res.on('close', () => clearTimeout(timer));
  });
  const upPort = await listen(upstream);
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG); cfg.forward.upstream_headers_timeout_ms = 150;
  const ctx = { startedAt: Date.now(), inflight: 0, backoffUntil: 0, counters: { total: 0, ok: 0, err: 0, rejected: 0, injected: 0, sanitized: {} } };
  const server = b.createBridgeServer(cfg, ctx, 'bridge-key', 2), port = await listen(server);
  const call = async () => {
    b.targetCache.at = Date.now(); b.targetCache.value = { port: upPort, basePath: '', token: 'mock' };
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'bridge-key' },
      body: JSON.stringify({ model: 'claude-test', stream: true, messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.text(), headers: res.headers };
  };
  try {
    for (const [scenario, code] of [['empty', 'empty'], ['comments', 'empty'], ['error', 'error'], ['json', 'invalid_json'], ['wrong-protocol', 'protocol_mismatch'], ['encoded', 'encoding'], ['heartbeat', 'first_event_timeout']]) {
      await t.test(scenario + ' returns 503 before committing streaming headers', async () => {
        mode = scenario; const before = calls, result = await call();
        assert.equal(result.status, 503); assert.match(result.body, new RegExp('upstream_stream_' + code));
        assert.ok(!result.body.includes('secret upstream body'));
        assert.match(result.headers.get('x-bridge-request-id'), /^[a-f0-9]{16}$/);
        assert.equal(ctx.lastStreamError.request_id, result.headers.get('x-bridge-request-id'));
        assert.equal(calls, before + 1); assert.equal(ctx.inflight, 0);
      });
    }
    for (const scenario of ['truncated', 'tcp-reset', 'late-error']) {
      await t.test(scenario + ' emits a protocol error after streaming starts', async () => {
        mode = scenario; const before = calls, result = await call();
        assert.equal(result.status, 200); assert.match(result.body, /"type":"error"/);
        assert.ok(!result.body.includes('message_stop')); assert.ok(!result.body.includes('finish_reason'));
        assert.equal(result.headers.get('x-accel-buffering'), 'no'); assert.equal(calls, before + 1); assert.equal(ctx.inflight, 0);
      });
    }
    await t.test('tool-only responses retain actual stop reason and valid completion', async () => {
      mode = 'valid-tool'; const result = await call(); assert.equal(result.status, 200);
      assert.match(result.body, /"stop_reason":"tool_use"/); assert.match(result.body, /message_stop/);
      assert.ok(!result.body.includes('event: error')); assert.equal(ctx.counters.ok, 1);
    });
  } finally { b.invalidateTarget(); await close(server); await close(upstream); }
});

test('Responses terminal errors and incompatible events cannot be counted as success', () => {
  const e = new TerminalEvents('responses');
  assert.equal(e.push(Buffer.from(frame({ type: 'response.completed', response: { status: 'failed', error: { message: 'failed' } } }))), true);
  assert.equal(e.failed, true);
  assert.throws(() => new TerminalEvents('responses').push(Buffer.from(frame({ type: 'message_stop' }))), /protocol_mismatch/);
  assert.throws(() => new TerminalEvents('messages').push(Buffer.from('data: [DONE]\n\n')), /protocol_mismatch/);
});
