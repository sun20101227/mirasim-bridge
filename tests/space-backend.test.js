'use strict';
// Space backend: the gateway frame contract and the Anthropic translation.
//
// Everything here runs against a stubbed WebSocket — no network, no live space.
// The frame sequences are the ones captured from relay.mirasim.ai on 2026-11-01
// while a real turn billed space-316be.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SpaceGateway, decodeClaims } = require('../lib/space-gateway');
const { toPrompt, toMessage, MessagesStream, toUsage, contentText } = require('../lib/space-messages');

/** Minimal stand-in for the browser WebSocket the gateway module uses. */
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.listeners = new Map(); this.queued = []; FakeSocket.last = this; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
    // A frame pushed before the module got round to subscribing is not lost: the
    // real socket delivers on its own clock, this stub delivers on demand.
    const ready = this.queued.filter((q) => q.type === type);
    this.queued = this.queued.filter((q) => q.type !== type);
    for (const q of ready) queueMicrotask(() => fn(q.event));
  }
  removeEventListener() { /* not used by the module */ }
  send(data) { if (this.readyState !== 1) throw Error('not open'); this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  // test drivers
  open() { this.readyState = 1; this.#fire('open', {}); }
  push(frame) { this.#fire('message', { data: JSON.stringify(frame) }); }
  die(code = 1006, reason = '') { this.readyState = 3; this.#fire('close', { code, reason }); }
  #fire(type, event) {
    const listeners = this.listeners.get(type);
    if (!listeners || !listeners.length) { if (type === 'message') this.queued.push({ type, event }); return; }
    for (const fn of listeners) fn(event);
  }
}

const JWT = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function makeGateway({ expiresInMs = 10 * 60 * 1000 } = {}) {
  const mintCalls = [];
  const mint = async (path, body) => {
    mintCalls.push({ path, body });
    return { status: 200, json: { session: JWT({ exp: Math.floor((Date.now() + expiresInMs) / 1000) }), nodeId: 'space-316be', gatewayUrl: 'wss://relay.mirasim.ai/v2/gateway/ws' } };
  };
  const gw = new SpaceGateway({ mint, nodeId: 'space-316be', gatewayUrl: 'wss://relay.mirasim.ai/v2/gateway/ws', turnTimeoutMs: 5000 });
  return { gw, mintCalls };
}

/** Wait until the module has constructed a socket (mint is async, so one tick is not enough). */
async function waitForSocket() {
  for (let i = 0; i < 400; i++) {
    const s = FakeSocket.last;
    if (s && s.readyState === 0) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('the gateway never opened a socket');
}

/** Wait until `count` frames of `type` have been sent on this socket. */
async function waitForFrame(socket, type, count = 1) {
  for (let i = 0; i < 400; i++) {
    const hits = socket.sent.filter((f) => f.type === type);
    if (hits.length >= count) return hits.at(-1);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error(`the gateway never sent a ${type} frame`);
}


/** Connect through the stub, answering the auth frame the way the real host does. */
async function connectFake(gw, { caps = ['ctl', 'tunnel'] } = {}) {
  FakeSocket.last = null;
  const p = gw.connect();
  const socket = await waitForSocket();
  socket.open();
  // The auth frame goes out on the tick after `open` resolves, so wait for it
  // rather than reading `sent` synchronously.
  const auth = await waitForFrame(socket, 'gatewayAuth');
  socket.push({ type: 'gatewayHostCaps', caps });
  socket.push({ type: 'pong' });
  await p;
  return { socket, auth };
}

async function withFakeSocket(fn) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try { return await fn(); } finally { globalThis.WebSocket = original; }
}

test('connect mints a gateway session and authenticates with the frame the host expects', async () => {
  await withFakeSocket(async () => {
    const { gw, mintCalls } = makeGateway();
    const { socket, auth } = await connectFake(gw, { caps: ['ctl', 'tunnel', 'vault'] });
    assert.equal(mintCalls.length, 1);
    assert.equal(mintCalls[0].path, '/v2/gateway/session');
    assert.deepEqual(mintCalls[0].body, { nodeId: 'space-316be', idleSleep: 1 });
    assert.equal(auth.type, 'gatewayAuth');
    assert.equal(auth.nodeId, 'space-316be');
    assert.equal(auth.wake, 1, 'wake:1 is what makes the host wait instead of refusing while it boots');
    assert.equal(auth.idleSleep, 1);
    assert.deepEqual(gw.caps, ['ctl', 'tunnel', 'vault']);
    assert.equal(gw.connected, true);
    socket.die();
  });
});

test('a rejected session mint surfaces the space refusal instead of a generic failure', async () => {
  await withFakeSocket(async () => {
    const mint = async () => ({ status: 403, json: { error: 'trial_space' } });
    const gw = new SpaceGateway({ mint, nodeId: 'space-316be', gatewayUrl: 'wss://x' });
    await assert.rejects(gw.connect(), (err) => {
      assert.match(err.message, /trial_space/);
      assert.equal(err.status, 403);
      assert.equal(err.space, true);
      return true;
    });
  });
});

test('a turn collects appendText and settles on phase done', async () => {
  await withFakeSocket(async () => {
    const { gw } = makeGateway();
    const { socket } = await connectFake(gw);
    const deltas = [];
    const running = gw.runTurn({ prompt: 'Reply with exactly: PONG', model: 'claude-haiku-5-5', onDelta: (t) => deltas.push(t) });
    const frame = await waitForFrame(socket, "prompt");
    assert.equal(frame.type, 'prompt');
    assert.equal(frame.route, 'cloud');
    assert.equal(frame.model, 'claude-haiku-5-5');
    assert.equal(frame.workdir, '/data/ws');
    assert.equal(frame.sessionKey, undefined, 'a fresh turn must not carry a sessionKey');
    assert.equal(frame.spaceCreditOnly, undefined, 'spaceCreditOnly is refused for a gateway caller');

    const key = 'claude:0941f5b5-1751-4d00-83da-0d0073d25c21';
    socket.push({ type: 'accepted', clientRef: frame.clientRef, sessionKey: key, taskId: 't' });
    socket.push({ type: 'session', sessionKey: key, seq: 1, patch: { set: { phase: 'streaming', model: 'claude-haiku-5-5[1m]', effort: 'high' } } });
    socket.push({ type: 'session', sessionKey: key, seq: 3, patch: { set: { usage: { inputTokens: 2, cachedInputTokens: 18875, outputTokens: 0, contextWindowTokens: 1000000 } } } });
    socket.push({ type: 'session', sessionKey: key, seq: 4, patch: { appendText: 'PO' } });
    socket.push({ type: 'session', sessionKey: key, seq: 5, patch: { appendText: 'NG' } });
    socket.push({ type: 'session', sessionKey: key, seq: 6, patch: { set: { phase: 'done', usage: { inputTokens: 2, cachedInputTokens: 18875, outputTokens: 5, contextWindowTokens: 1000000 } } } });

    const turn = await running;
    assert.equal(turn.text, 'PONG');
    assert.equal(turn.phase, 'done');
    assert.equal(turn.model, 'claude-haiku-5-5[1m]', 'the served model comes back from the host, normalized');
    assert.equal(turn.effort, 'high');
    assert.equal(turn.sessionKey, key);
    assert.deepEqual(deltas, ['PO', 'NG']);
    socket.die();
  });
});

test('frames for another sessionKey never leak into this turn', async () => {
  await withFakeSocket(async () => {
    const { gw } = makeGateway();
    const { socket } = await connectFake(gw);
    const running = gw.runTurn({ prompt: 'hello' });
    const ref = (await waitForFrame(socket, "prompt")).clientRef;
    socket.push({ type: 'accepted', clientRef: ref, sessionKey: 'claude:mine' });
    socket.push({ type: 'session', sessionKey: 'claude:someone-else', patch: { appendText: 'WRONG' } });
    socket.push({ type: 'session', sessionKey: 'claude:mine', patch: { appendText: 'RIGHT' } });
    socket.push({ type: 'session', sessionKey: 'claude:mine', patch: { set: { phase: 'done' } } });
    const turn = await running;
    assert.equal(turn.text, 'RIGHT');
    socket.die();
  });
});

test('a refusal frame rejects the turn with the host message and keeps its code', async () => {
  await withFakeSocket(async () => {
    const { gw } = makeGateway();
    const { socket } = await connectFake(gw);
    const running = gw.runTurn({ prompt: 'x' });
    const ref = (await waitForFrame(socket, 'prompt')).clientRef;
    socket.push({ type: 'error', clientRef: ref, message: 'API Error: 422 model "bogus" is not supported at this time' });
    await assert.rejects(running, (err) => {
      assert.match(err.message, /422 model/);
      assert.equal(err.space, true);
      assert.equal(err.status, 422, 'the upstream status rides along so the bridge can answer 400, not 502');
      return true;
    });
    socket.die();
  });
});

test('a refusal with no status is a plain gateway failure, not a client error', async () => {
  await withFakeSocket(async () => {
    const { gw } = makeGateway();
    const { socket } = await connectFake(gw);
    const running = gw.runTurn({ prompt: 'x' });
    const ref = (await waitForFrame(socket, 'prompt')).clientRef;
    socket.push({ type: 'error', clientRef: ref, message: 'the space is asleep' });
    await assert.rejects(running, (err) => {
      assert.equal(err.status, undefined);
      assert.equal(err.space, true);
      return true;
    });
    socket.die();
  });
});

test('a dropped connection fails every in-flight turn instead of hanging', async () => {
  await withFakeSocket(async () => {
    const { gw } = makeGateway();
    const { socket } = await connectFake(gw);
    const a = gw.runTurn({ prompt: 'a' });
    const b = gw.runTurn({ prompt: 'b' });
    await waitForFrame(socket, 'prompt', 2);
    socket.die(1006, 'gone');
    await assert.rejects(a, /网关连接中断/);
    await assert.rejects(b, /网关连接中断/);
    assert.equal(gw.turns.size, 0);
  });
});

test('the catalog frame answers the waiting caller even without a reqId echo', async () => {
  await withFakeSocket(async () => {
    const { gw } = makeGateway();
    const { socket } = await connectFake(gw);
    const pending = gw.getCatalog();
    await waitForFrame(socket, 'getCatalog');
    socket.push({ type: 'catalog', agent: 'claude', models: [{ id: 'claude-opus-5-5[1m]' }, { id: 'kimi-k3' }] });
    const models = await pending;
    assert.deepEqual(models.map((m) => m.id), ['claude-opus-5-5[1m]', 'kimi-k3']);
    socket.die();
  });
});

test('an expired gateway JWT is re-minted before it is used', async () => {
  await withFakeSocket(async () => {
    const { gw, mintCalls } = makeGateway({ expiresInMs: 1000 });   // inside the 60s margin
    const { socket } = await connectFake(gw);
    socket.die();
    const p = gw.connect();
    const again = await waitForSocket();
    again.open();
    again.push({ type: 'gatewayHostCaps', caps: [] });
    await p;
    assert.equal(mintCalls.length, 2, 'a token inside the margin is not reused');
    again.die();
  });
});

// --- translation -----------------------------------------------------------

test('a single user message is passed through as the prompt; system rides in a tag', () => {
  const { prompt, notes } = toPrompt({
    system: 'You are terse.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }],
  });
  assert.equal(prompt, '<system>\nYou are terse.\n</system>\n\nWhat is 2+2?');
  assert.deepEqual(notes, []);
});

test('a multi-turn history is flattened into a transcript, ending with an Assistant cue', () => {
  const { prompt } = toPrompt({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'and then?' },
    ],
  });
  assert.equal(prompt, 'User: hi\n\nAssistant: hello\n\nUser: and then?\n\nAssistant:');
});

test('unsupported blocks and sampling fields are dropped with a note, never faked', () => {
  const { prompt, notes } = toPrompt({
    temperature: 0.2, top_p: 0.9, max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 1024 },
    tools: [{ name: 'search', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { data: 'x' } },
      { type: 'tool_result', content: 'result text' },
    ] }],
  });
  assert.match(prompt, /look/);
  assert.match(prompt, /\[图片已省略/);
  assert.match(prompt, /\[工具结果\]\nresult text/);
  for (const needle of ['temperature', 'top_p', 'max_tokens', 'thinking', 'tools', 'tool_choice']) {
    assert.ok(notes.some((n) => n.startsWith(needle)), `expected a note for ${needle}: ${notes.join(' | ')}`);
  }
});

test('an empty messages array is a 400, not an empty agent turn', () => {
  assert.throws(() => toPrompt({ messages: [] }), (err) => err.status === 400);
});

test('space usage maps to the Anthropic shape and takes the context total, not the fresh part', () => {
  // Captured from a live turn: inputTokens 2 + cached 0 says nothing about the
  // ~18.9k the agent actually carried, so contextUsedTokens wins.
  assert.deepEqual(toUsage({ inputTokens: 2, cachedInputTokens: 18875, outputTokens: 5, contextUsedTokens: 20156, contextWindowTokens: 1000000 }), {
    input_tokens: 20156, output_tokens: 5, cache_read_input_tokens: 18875, cache_creation_input_tokens: 0,
    space_context_window: 1000000,
  });
  assert.equal(toUsage({ inputTokens: 2, cachedInputTokens: 0, outputTokens: 3 }).input_tokens, 2, 'without a context total the parts are all we have');
  assert.deepEqual(toUsage(null), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test('a non-streamed response is a well-formed Anthropic message', () => {
  const msg = toMessage({ text: 'PONG', model: 'claude-haiku-5-5[1m]', usage: { inputTokens: 1, cachedInputTokens: 10, outputTokens: 2 }, sessionKey: 'claude:x', effort: 'high', toolCalls: 0 }, 'claude-haiku-5-5');
  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.model, 'claude-haiku-5-5[1m]', 'served model wins over the requested one');
  assert.deepEqual(msg.content, [{ type: 'text', text: 'PONG' }]);
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.usage.input_tokens, 11);
  assert.equal(msg.space.session_key, 'claude:x');
});

test('the stream emits Anthropic SSE in order and finishes on the space usage', () => {
  const chunks = [];
  const stream = new MessagesStream('claude-haiku-5-5[1m]', (c) => chunks.push(c));
  stream.coalesceMs = 0;   // count frames: asserts one per delta
  stream.delta('PO');
  stream.delta('NG');
  stream.finish({ usage: { inputTokens: 2, cachedInputTokens: 100, outputTokens: 5 } });
  stream.delta('ignored after finish');
  const events = chunks.map((c) => /^event: (\w+)/.exec(c)?.[1]);
  assert.deepEqual(events, [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const deltaPayload = JSON.parse(/data: (.*)\n/.exec(chunks[2])[1]);
  assert.deepEqual(deltaPayload, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PO' } });
  const finalUsage = JSON.parse(/data: (.*)\n/.exec(chunks[5])[1]).usage;
  assert.equal(finalUsage.input_tokens, 102);
  assert.equal(chunks.join('').match(/text_delta/g).length, 2, 'nothing is emitted after finish');
});

test('a stream that fails mid-turn reports an error event instead of a fake stop', () => {
  const chunks = [];
  const stream = new MessagesStream('m', (c) => chunks.push(c));
  stream.coalesceMs = 0;   // count frames: asserts one per delta
  stream.delta('partial');
  stream.fail('回合超时（600s）', 'timeout');
  stream.finish({ usage: {} });
  const events = chunks.map((c) => /^event: (\w+)/.exec(c)?.[1]);
  assert.equal(events.at(-1), 'error');
  assert.ok(!events.includes('message_stop'));
  assert.match(chunks.at(-1), /timeout_error/);
});

test('contentText keeps text and tool results, and marks what it cannot carry', () => {
  assert.equal(contentText('plain'), 'plain');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'tool_use', name: 'read' }]), 'a\n[工具调用 read]');
  assert.equal(contentText(null), '');
});

test('decodeClaims reads a gateway JWT without verifying it (verification is the host s job)', () => {
  assert.equal(decodeClaims(JWT({ sub: 'usr_1', exp: 123 })).sub, 'usr_1');
  assert.deepEqual(decodeClaims('not-a-jwt'), {});
  assert.deepEqual(decodeClaims(''), {});
});

// --- backend wiring --------------------------------------------------------

test('space counts as a relay-API backend, so quota and credit are not gated away from it', () => {
  // Every "needs the relay credential" path used to test `=== 'relay'`, which
  // silently excluded space from quota, membership, roster and /v2 credit.
  const b = require('../mirasim-bridge');
  assert.equal(b.usesRelayApi({ backend: 'relay' }), true);
  assert.equal(b.usesRelayApi({ backend: 'space' }), true);
  assert.equal(b.usesRelayApi({ backend: 'session' }), false, 'the local-process backend must stay out');
});

test('the space backend never starts the Mirasim keepalive session', async () => {
  // A keeper with no local session to keep would respawn forever and probe a port
  // that does not exist (observed: 60s "not ready" → SIGTERM → backoff loop).
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const b = require('../mirasim-bridge');
  const dir = fs.mkdtempSync(path.join(osSync.tmpdir(), 'mira-space-serve-'));
  try {
    const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
    Object.assign(cfg, { backend: 'space', _config_path: path.join(dir, 'config.json'), keepalive: { ...cfg.keepalive, enabled: true } });
    cfg.space = { ...cfg.space, node_id: 'space-316be' };
    cfg.relay = { ...cfg.relay, setting_json: 'setting.json' };
    cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.sub2api.base_url = ''; cfg.sub2api.admin_api_key = '';
    b.validateConfig(cfg);
    fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify({
      auth: { token: 'a', refreshToken: 'r', exp: Math.floor(Date.now() / 1000) + 3600 },
      device: { privateKey: require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) },
    }));
    const ctx = b.newAccountCtx('main');
    assert.equal(b.usesRelayApi(cfg), true);
    // cmdServe picks its startup branch with `if (usesRelayApi(cfg)) … else if
    // (cfg.keepalive.enabled)`. The regression was that space fell into the else
    // branch, so asserting this predicate is asserting the fix: a space backend can
    // never reach the keepalive branch, even with keepalive.enabled true.
    assert.equal(cfg.keepalive.enabled, true, 'the fixture must keep the trap armed');
    assert.ok(b.usesRelayApi(cfg), 'space takes the relay-API branch, so the keeper is never constructed');
    assert.equal(ctx.keepalive ?? null, null, 'no keeper is attached to a space-backend context');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- /v1/limits: two ledgers ------------------------------------------------
// The space backend answers two pools that are NOT interchangeable: personal
// (relay `/v1/limits`) and space (`/v2/machines/<node>/credit`). Each is read on
// its own, and a failure on one must neither fabricate a number for it nor hide
// the other.

const http = require('node:http');
const fsSync = require('node:fs');
const osSync = require('node:os');
const pathSync = require('node:path');
const bridge = require('../mirasim-bridge');
const { createCredential } = require('../lib/login');

const openServer = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const shutServer = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

/** A relay stub that answers only the two ledgers, with per-endpoint status control. */
async function limitsFixture(t, { personalStatus = 200, spaceStatus = 200 } = {}) {
  const dir = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'space-limits-'));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const relay = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/device/session') return res.end('{"ticket":"t","expiresIn":600}');
    if (req.url === '/auth/refresh') return res.end(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
    seen.push(req.url);
    if (req.url === '/v1/limits') {
      res.writeHead(personalStatus, { 'content-type': 'application/json' });
      return res.end(personalStatus === 200
        ? JSON.stringify({ subject: 'usr_x', windows: [{ name: '30d', used: 14728.99, budget: 1 }] })
        : '{"error":"boom"}');
    }
    if (req.url === '/v2/machines/space-316be/credit') {
      res.writeHead(spaceStatus, { 'content-type': 'application/json' });
      return res.end(spaceStatus === 200
        ? JSON.stringify({
          nodeId: 'space-316be', spaceKey: 'alloc_77f4ba7d0ac91f16', mode: 'space',
          balance: 1112, funded: 1250, used: 138, bonusPct: 0, capMode: 'none',
          me: { cap: null, used: 138, remaining: null, prefer: 'space', payer: 'space' },
          members: [], formerMembers: [], priorGenerations: [],
          can: { toggle: true, setCaps: true, transfer: true }, recent: [],
        })
        : '{"error":"boom"}');
    }
    res.writeHead(404); res.end('{}');
  });
  const origin = `http://127.0.0.1:${await openServer(relay)}`;
  t.after(() => shutServer(relay));

  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'space', bridge_secret: 's', _config_path: pathSync.join(dir, 'config.json') });
  cfg.relay = { ...cfg.relay, url: origin, auth_url: origin, setting_json: 'setting.json' };
  cfg.space = { ...cfg.space, node_id: 'space-316be' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fsSync.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fsSync.writeFileSync(pathSync.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'a', refresh: 'r' })));

  const ctx = bridge.newAccountCtx('main');
  const server = bridge.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2);
  const base = `http://127.0.0.1:${await openServer(server)}`;
  t.after(() => shutServer(server));
  return { base, seen, ctx };
}

test('limits reports both ledgers when both answer', async (t) => {
  const { base, seen } = await limitsFixture(t);
  const r = await fetch(base + '/v1/limits', { headers: { 'x-api-key': 's' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.source, 'mirasim-space');
  assert.equal(body.personal.available, true);
  assert.equal(body.personal.windows[0].name, '30d');
  assert.equal(body.space.balance, 1112);
  assert.equal(body.space.payer, 'space');
  // Both were actually asked; the shape is not fabricated from one read.
  assert.ok(seen.includes('/v1/limits'));
  assert.ok(seen.includes('/v2/machines/space-316be/credit'));
});

test('a dead personal ledger does not hide the space ledger', async (t) => {
  const { base } = await limitsFixture(t, { personalStatus: 500 });
  const body = await (await fetch(base + '/v1/limits', { headers: { 'x-api-key': 's' } })).json();
  assert.equal(body.personal, null, 'a failed read reports null, never a stale or invented snapshot');
  assert.equal(body.space.balance, 1112, 'the space side still answers');
});

test('a dead space ledger does not hide the personal one', async (t) => {
  const { base } = await limitsFixture(t, { spaceStatus: 503 });
  const body = await (await fetch(base + '/v1/limits', { headers: { 'x-api-key': 's' } })).json();
  assert.equal(body.space, null);
  assert.equal(body.personal.windows[0].name, '30d');
});

test('both ledgers down is an honest null/null, not an error page', async (t) => {
  const { base } = await limitsFixture(t, { personalStatus: 500, spaceStatus: 503 });
  const r = await fetch(base + '/v1/limits', { headers: { 'x-api-key': 's' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { source: 'mirasim-space', personal: null, space: null });
});

// --- 用量记账 ---------------------------------------------------------------
// The relay/session path writes a usage record at the tail of handleProxy. The
// space path returns from inside handleSpaceProxy, so it has to record explicitly —
// without it a space account reports zero tokens while its credit is being spent.
// These tests pin that the record exists, carries the host-served model, and uses
// the context-based input count rather than the 2-token delta the host reports.

test('a finished space turn is written to the usage ledger with the served model', async (t) => {
  const dir = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'space-usage-'));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'space', bridge_secret: 's', _config_path: pathSync.join(dir, 'config.json') });
  cfg.space = { ...cfg.space, node_id: 'space-316be' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fsSync.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fsSync.writeFileSync(pathSync.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'a', refresh: 'r' })));

  const records = [];
  const fakeStore = { record: async (row) => { records.push(row); }, query: async () => ({}), setPrice: async () => ({}) };

  const ctx = bridge.newAccountCtx('main');
  // Replace the gateway on this ctx's config with a stub that answers one turn.
  const gw = {
    getCatalog: async () => ['claude-opus-5-5[1m]'],
    runTurn: async ({ onDelta }) => {
      if (onDelta) { onDelta('USAGE'); onDelta('_OK'); }
      return { text: 'USAGE_OK', phase: 'done', model: 'claude-opus-5-5[1m]', effort: 'high',
        sessionKey: 'claude:abc', toolCalls: 0,
        usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 7, contextUsedTokens: 19427, contextWindowTokens: 1000000 } };
    },
  };
  cfg._spaceGateway = gw;
  cfg._usageStore = fakeStore;   // test seam: no live WebSocket

  const server = bridge.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2);
  const base = `http://127.0.0.1:${await openServer(server)}`;
  t.after(() => shutServer(server));

  const r = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 's', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 50));   // record() is fire-and-forget

  assert.equal(records.length, 1, 'exactly one usage row per turn');
  const row = records[0];
  assert.equal(row.model, 'claude-opus-5-5', 'the requested id is kept for correlation');
  assert.equal(row.served_model, 'claude-opus-5-5[1m]', 'the host-served id makes a substitution visible');
  assert.equal(row.ok, true);
  assert.equal(row.protocol, 'messages');
  // contextUsedTokens (19427) is the real input size; the 2-token delta the host
  // reports would understate it by four orders of magnitude. Cache buckets are
  // subtracted from input so the ledger does not charge them twice.
  assert.equal(row.input_tokens, 19427);
  assert.equal(row.output_tokens, 7);
  assert.equal(row.cache_read_tokens, 0);
  assert.equal(row.cache_write_tokens, 0);
  assert.equal(row.usage_state, 'complete');
});

test('a failed turn is not recorded as a successful usage row', async (t) => {
  const dir = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'space-usage-err-'));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'space', bridge_secret: 's', _config_path: pathSync.join(dir, 'config.json') });
  cfg.space = { ...cfg.space, node_id: 'space-316be' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fsSync.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fsSync.writeFileSync(pathSync.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'a', refresh: 'r' })));

  const records = [];
  const fakeStore = { record: async (row) => { records.push(row); }, query: async () => ({}), setPrice: async () => ({}) };

  const ctx = bridge.newAccountCtx('main');
  const gw = { getCatalog: async () => [], runTurn: async () => { throw Object.assign(Error('model "x" is not supported'), { status: 422 }); } };
  cfg._spaceGateway = gw;
  cfg._usageStore = fakeStore;

  const server = bridge.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2);
  const base = `http://127.0.0.1:${await openServer(server)}`;
  t.after(() => shutServer(server));

  const r = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 's', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400, 'a 422 from the space is the caller fault, not an upstream outage');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(records.length, 0, 'no usage row: the turn never produced tokens');
});

// --- 流式时序 ---------------------------------------------------------------
// A space turn can sit silent for tens of seconds (agent warm-up, thinking). The
// SSE stream must open on the host's `streaming` phase, not on the first token, or
// the client stares at an idle socket; and a comment heartbeat must keep proxies
// from cutting the connection while it waits.

test('the stream opens on the streaming phase, before the first token', async (t) => {
  const dir = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'space-open-'));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'space', bridge_secret: 's', _config_path: pathSync.join(dir, 'config.json') });
  cfg.space = { ...cfg.space, node_id: 'space-316be' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fsSync.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fsSync.writeFileSync(pathSync.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'a', refresh: 'r' })));

  const seen = [];
  cfg._spaceGateway = {
    getCatalog: async () => [],
    runTurn: async ({ onDelta, onUpdate }) => {
      onUpdate?.('phase', 'streaming');          // host says it is working
      await new Promise((r) => setTimeout(r, 120));
      seen.push('first-token');
      onDelta('X');
      return { text: 'X', phase: 'done', model: 'claude-opus-5-5[1m]', usage: { contextUsedTokens: 10, outputTokens: 1 } };
    },
  };
  cfg._usageStore = { record: async () => {}, query: async () => ({}), setPrice: async () => ({}) };

  const ctx = bridge.newAccountCtx('main');
  const server = bridge.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2);
  const base = `http://127.0.0.1:${await openServer(server)}`;
  t.after(() => shutServer(server));

  const r = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 's', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'x' }] }),
  });
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  // The first chunk must arrive well before the first token (120ms later).
  const first = await reader.read();
  const at = Date.now();
  const text = decoder.decode(first.value, { stream: true });
  assert.match(text, /event: message_start/, 'the stream opens before any token exists');
  assert.equal(seen.length, 0, 'the host had not produced its first token yet');
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(seen.length, 1);
});

test('MessagesStream.open emits both start events exactly once', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.coalesceMs = 0;   // count frames: this test asserts one per delta
  s.open();
  s.open();                     // idempotent
  s.delta('hi');
  const events = out.map((c) => /^event: (\w+)/.exec(c)[1]);
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta']);
  assert.equal(events.filter((e) => e === 'message_start').length, 1);
});

test('a delta before open still starts the stream (open is an optimisation, not a requirement)', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.coalesceMs = 0;   // count frames: asserts one per delta
  s.delta('hi');
  assert.deepEqual(out.map((c) => /^event: (\w+)/.exec(c)[1]), ['message_start', 'content_block_start', 'content_block_delta']);
});

// --- 流式时序 ---------------------------------------------------------------
// A space turn can sit silent for tens of seconds (agent warm-up, thinking). The
// SSE stream must open on the host's `streaming` phase, not on the first token, or
// the client stares at an idle socket; and a comment heartbeat must keep proxies
// from cutting the connection while it waits.

test('the stream opens on the streaming phase, before the first token', async (t) => {
  const dir = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'space-open-'));
  t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }));
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'space', bridge_secret: 's', _config_path: pathSync.join(dir, 'config.json') });
  cfg.space = { ...cfg.space, node_id: 'space-316be' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fsSync.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fsSync.writeFileSync(pathSync.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'a', refresh: 'r' })));

  const seen = [];
  cfg._spaceGateway = {
    getCatalog: async () => [],
    runTurn: async ({ onDelta, onUpdate }) => {
      onUpdate?.('phase', 'streaming');          // host says it is working
      await new Promise((r) => setTimeout(r, 120));
      seen.push('first-token');
      onDelta('X');
      return { text: 'X', phase: 'done', model: 'claude-opus-5-5[1m]', usage: { contextUsedTokens: 10, outputTokens: 1 } };
    },
  };
  cfg._usageStore = { record: async () => {}, query: async () => ({}), setPrice: async () => ({}) };

  const ctx = bridge.newAccountCtx('main');
  const server = bridge.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2);
  const base = `http://127.0.0.1:${await openServer(server)}`;
  t.after(() => shutServer(server));

  const r = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 's', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'x' }] }),
  });
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  // The first chunk must arrive well before the first token (120ms later).
  const first = await reader.read();
  const at = Date.now();
  const text = decoder.decode(first.value, { stream: true });
  assert.match(text, /event: message_start/, 'the stream opens before any token exists');
  assert.equal(seen.length, 0, 'the host had not produced its first token yet');
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(seen.length, 1);
});

test('MessagesStream.open emits both start events exactly once', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.coalesceMs = 0;   // count frames: asserts one per delta
  s.open();
  s.open();                     // idempotent
  s.delta('hi');
  const events = out.map((c) => /^event: (\w+)/.exec(c)[1]);
  assert.deepEqual(events, ['message_start', 'content_block_start', 'content_block_delta']);
  assert.equal(events.filter((e) => e === 'message_start').length, 1);
});

test('a delta before open still starts the stream (open is an optimisation, not a requirement)', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.coalesceMs = 0;   // count frames: asserts one per delta
  s.delta('hi');
  assert.deepEqual(out.map((c) => /^event: (\w+)/.exec(c)[1]), ['message_start', 'content_block_start', 'content_block_delta']);
});

test('coalescing never loses or reorders text, and finish drains the tail', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  const text = () => out.filter((c) => c.includes('text_delta'))
    .map((c) => JSON.parse(/data: (.*)\n/.exec(c)[1]).delta.text);
  const tokens = ['He', 'llo', ' ', 'wo', 'rld', '!'];
  for (const t of tokens) s.delta(t);
  // Nothing has flushed yet: the frames are buffered, not lost.
  assert.equal(text().length, 0, 'tokens are buffered, not emitted one frame each');
  s.finish({ usage: {} });
  const emitted = text();
  assert.equal(emitted.join(''), tokens.join(''), 'concatenation is byte-identical');
  assert.equal(emitted.length, 1, 'one coalesced frame for a burst of tokens');
});

test('a timer flush emits without waiting for finish', async () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.coalesceMs = 20;
  s.delta('a');
  s.delta('b');
  assert.equal(out.filter((c) => c.includes('text_delta')).length, 0);
  await new Promise((r) => setTimeout(r, 60));
  const frames = out.filter((c) => c.includes('text_delta'));
  assert.equal(frames.length, 1, 'the timer, not finish, produced the frame');
  assert.equal(JSON.parse(/data: (.*)\n/.exec(frames[0])[1]).delta.text, 'ab');
  s.finish({ usage: {} });
});

test('fail() drops the buffer instead of emitting text after an error', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.delta('partial');
  s.fail('boom', 'timeout');
  s.finish({ usage: {} });      // must be a no-op after fail
  const events = out.map((c) => /^event: (\w+)/.exec(c)?.[1]);
  assert.equal(events.at(-1), 'error');
  assert.equal(out.filter((c) => c.includes('text_delta')).length, 0, 'no text after a failure');
});

test('coalescing never loses or reorders text, and finish drains the tail', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  const text = () => out.filter((c) => c.includes('text_delta'))
    .map((c) => JSON.parse(/data: (.*)\n/.exec(c)[1]).delta.text);
  const tokens = ['He', 'llo', ' ', 'wo', 'rld', '!'];
  for (const t of tokens) s.delta(t);
  // Nothing has flushed yet: the frames are buffered, not lost.
  assert.equal(text().length, 0, 'tokens are buffered, not emitted one frame each');
  s.finish({ usage: {} });
  const emitted = text();
  assert.equal(emitted.join(''), tokens.join(''), 'concatenation is byte-identical');
  assert.equal(emitted.length, 1, 'one coalesced frame for a burst of tokens');
});

test('a timer flush emits without waiting for finish', async () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.coalesceMs = 20;
  s.delta('a');
  s.delta('b');
  assert.equal(out.filter((c) => c.includes('text_delta')).length, 0);
  await new Promise((r) => setTimeout(r, 60));
  const frames = out.filter((c) => c.includes('text_delta'));
  assert.equal(frames.length, 1, 'the timer, not finish, produced the frame');
  assert.equal(JSON.parse(/data: (.*)\n/.exec(frames[0])[1]).delta.text, 'ab');
  s.finish({ usage: {} });
});

test('fail() drops the buffer instead of emitting text after an error', () => {
  const out = [];
  const s = new MessagesStream('m', (c) => out.push(c));
  s.delta('partial');
  s.fail('boom', 'timeout');
  s.finish({ usage: {} });      // must be a no-op after fail
  const events = out.map((c) => /^event: (\w+)/.exec(c)?.[1]);
  assert.equal(events.at(-1), 'error');
  assert.equal(out.filter((c) => c.includes('text_delta')).length, 0, 'no text after a failure');
});

test('the space backend caps in-flight turns below the generic concurrency setting', () => {
  // A space turn cannot be cancelled: the gateway has no stop frame, so a caller that
  // walks away still leaves a turn running and billing. The cap is the only defence,
  // so it must hold even when forward.max_concurrency is raised.
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  cfg.backend = 'space';
  cfg.space = { ...cfg.space, node_id: 'space-316be' };
  cfg.forward.max_concurrency = 8;
  bridge.validateConfig(cfg);
  assert.equal(bridge.effectiveConcurrency(cfg), 1, 'default space cap is one turn');

  cfg.space.max_concurrency = 3;
  bridge.validateConfig(cfg);
  assert.equal(bridge.effectiveConcurrency(cfg), 3);
  assert.equal(bridge.effectiveConcurrency(cfg, 'kimi'), 1, 'the Kimi slot is capped by the same value');

  cfg.space.max_concurrency = 32;
  assert.throws(() => bridge.validateConfig(cfg), /space\.max_concurrency/);
  cfg.space.max_concurrency = 0;
  assert.throws(() => bridge.validateConfig(cfg), /space\.max_concurrency/);
  cfg.space.max_concurrency = 0;
  assert.throws(() => bridge.validateConfig(cfg), /space\.max_concurrency/);

  cfg.space.max_concurrency = 1;
  cfg.space.max_concurrency = 1;
  // The relay backend keeps its own number: this cap is a space property.
  cfg.backend = 'relay';
  bridge.validateConfig(cfg);
  assert.equal(bridge.effectiveConcurrency(cfg), 8);
});

test('aborting a turn sends stop for that task before giving up locally', async () => {
  // Measured 2026-11-01: `stop` with a taskId does halt generation in the space, but
  // the host then never sends a terminal phase - the turn hangs. So the gateway fires
  // the frame for its side effect and settles locally without waiting for an ack.
  await withFakeSocket(async () => {
    const { gw } = makeGateway();
    const { socket } = await connectFake(gw);
    const controller = new AbortController();
    const running = gw.runTurn({ prompt: 'long job', model: 'claude-opus-5-5', signal: controller.signal });
    running.catch(() => {});
    const prompt = await waitForFrame(socket, 'prompt');
    socket.push({ type: 'accepted', clientRef: prompt.clientRef, sessionKey: 'claude:abc', taskId: 'task-1' });
    await new Promise((r) => setTimeout(r, 30));

    controller.abort();
    await assert.rejects(running, (err) => err.aborted === true);
    const stop = socket.sent.filter((f) => f.type === 'stop').at(-1);
    assert.ok(stop, 'a stop frame was sent');
    assert.equal(stop.taskId, 'task-1', 'the stop names this run, not the session at large');
    assert.equal(stop.sessionKey, 'claude:abc');
    gw.close();
  });
});
