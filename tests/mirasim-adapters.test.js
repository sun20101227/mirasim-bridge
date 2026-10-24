'use strict';
// Protocol-layer adapters verified against a mock relay:
//   /v1/chat/completions pass-through, `[1m]` normalisation, roster agent objects,
//   modelInfo() merge, and the opt-in adaptive_effort synthesis.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { RelayClient, readText, relayAgent } = require('../lib/relay');
const { summarizeRoster, rosterIds, modelInfo, bareId } = require('../lib/roster');
const { normalizeResponses } = require('../lib/responses');
const bridge = require('../mirasim-bridge');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

// Shaped exactly like the live roster 2026-10-24.v3+qaad272ef+sc5edcdfa: agents[] rows
// are objects carrying contextWindow/maxOutput/autoCompactRatio/adaptive/default/effort,
// deepseek is the `off` rung family, and `served` lists ids with no models[] entry.
const LIVE_ROSTER = {
  version: '2026-10-24.v3+qaad272ef+sc5edcdfa',
  cli: {
    claude: { minVersion: '2.1.293' }, codex: { minVersion: '0.159.3' }, kimi: { minVersion: '2.0.2' },
    dsh: { minVersion: '0.1.5-rc.2' }, pi: { minVersion: '0.87.0' }, gemini: { minVersion: '0.60.0' },
    qwen: { minVersion: '0.24.4' }, grok: { minVersion: '1.0.40' }, zcode: { minVersion: '3.14.1-27' },
    bogus: { minVersion: 'not a version' },
  },
  agents: {
    claude: [
      { id: 'claude-opus-5-5', label: 'opus 5.5', contextWindow: 1000000, maxOutput: 128000, autoCompactRatio: 0.95, adaptive: true, default: true },
      { id: 'claude-sonnet-5-5', label: 'sonnet 5.5', contextWindow: 1000000, maxOutput: 128000, autoCompactRatio: 0.95, adaptive: true },
      { id: 'claude-haiku-5-5', label: 'haiku 5.5', contextWindow: 1000000, maxOutput: 128000, autoCompactRatio: 0.95, adaptive: 'yes' },
    ],
    codex: [{ id: 'gpt-6-astra', contextWindow: 872000, maxOutput: 128000, autoCompactRatio: 0.9 }],
    dsh: [{ id: 'deepseek-flash', label: 'v4.1-flash', contextWindow: 1000000, maxOutput: 384000, autoCompactRatio: 0.9, effort: ['off', 'low', 'high', 'max'] }],
    kimi: [{ id: 'kimi-code/k3', contextWindow: 1048576, autoCompactRatio: 1.5, effort: ['low', 'high', 'max'] }],
  },
  served: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-6-astra', 'deepseek-flash',
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'gemini-4-argon', 'grok-4.7', 'mimo-v2.6-pro'],
  withdrawn: ['claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-8'],
  models: {
    'claude-opus-5-5': { pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 } },
    'claude-sonnet-5-5': { pricing: { input: 1, output: 5, cacheRead: 0.1 } },
    'gpt-6-astra': { effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], pricing: { input: 10, output: 50 } },
    'deepseek-flash': { effort: ['off', 'low', 'high', 'max'], pricing: { input: 0.2, output: 0.8 } },
  },
};
const roster = summarizeRoster(LIVE_ROSTER, Date.parse('2026-10-24T10:00:00Z'));

// ---------------------------------------------------------------------------
// Relay client: /v1/chat/completions allowlist + agent metadata
// ---------------------------------------------------------------------------

test('relayAgent maps roster cli names and the OpenAI route to codex for gpt ids', () => {
  assert.equal(relayAgent('/v1/responses', Buffer.from('{"model":"claude-x"}')), 'codex');
  assert.equal(relayAgent('/v1/chat/completions', Buffer.from('{"model":"gpt-6-astra"}')), 'codex');
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"claude-opus-5-5"}')), 'claude');
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"deepseek-flash"}')), 'dsh');
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"kimi-k3"}')), 'kimi');
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"glm-5.3-flash"}')), 'zcode');
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"gemini-4-argon"}')), 'gemini');
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"grok-4.7"}')), 'grok');
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"qwen-3-max"}')), 'qwen');
  // Unknown family: cosmetic metadata falls back, never guessed into a new engine.
  assert.equal(relayAgent('/v1/messages', Buffer.from('{"model":"mimo-v2.6-pro"}')), 'claude');
  assert.equal(relayAgent('/v1/messages', Buffer.from('not json')), 'claude');
});

test('mock relay: chat/completions is sealed, forwarded verbatim and not translated', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-adapters-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'setting.json');
  const recipient = crypto.generateKeyPairSync('x25519');
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const signer = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  fs.writeFileSync(file, JSON.stringify({ type: 'mirasim', access_token: 'access-test', refresh_token: 'refresh-test',
    device_private_key: signer.export({ format: 'pem', type: 'pkcs8' }),
    expired: new Date(Date.now() + 3600000).toISOString() }), { mode: 0o600 });

  const seen = [];
  const mock = http.createServer(async (req, res) => {
    const raw = await readText(req);
    if (req.url === '/v1/device/session') return res.end('{"ticket":"ticket-test","expiresIn":600}');
    const packed = Buffer.from(req.headers['x-mirasim-enc'] || '', 'base64url');
    const ephemeral = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), packed.subarray(0, 32)]), format: 'der', type: 'spki' });
    const shared = crypto.diffieHellman({ privateKey: recipient.privateKey, publicKey: ephemeral });
    const key = crypto.hkdfSync('sha256', shared, packed.subarray(0, 32), 'mrs-seal-v1', 32);
    const decipher = crypto.createDecipheriv('chacha20-poly1305', key, packed.subarray(32, 44), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`mrs-seal-v1\n${req.method}\n${req.url.split('?')[0]}`));
    decipher.setAuthTag(packed.subarray(-16));
    const headers = JSON.parse(Buffer.concat([decipher.update(packed.subarray(44, -16)), decipher.final()]));
    seen.push({ route: req.url, headers, body: raw ? JSON.parse(raw) : null });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404); res.end('{"error":"not found"}');
  });
  const origin = `http://127.0.0.1:${await listen(mock)}`;
  t.after(() => close(mock));

  const client = new RelayClient({ url: origin, auth_url: origin, setting_json: file, client_version: '0.0.354',
    seal_public_key: recipient.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') });
  const payload = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true };
  const res = await client.request({ path: '/v1/chat/completions', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mirasim-agent': 'forged', authorization: 'Bearer forged' },
    body: Buffer.from(JSON.stringify(payload)) });
  const text = await readText(res);
  assert.equal(res.statusCode, 200);
  assert.match(text, /chat\.completion\.chunk/);
  const hit = seen.find((entry) => entry.route === '/v1/chat/completions');
  assert.deepEqual(hit.body, payload, 'the OpenAI body is forwarded byte-for-byte');
  assert.equal(hit.headers['x-mirasim-agent'], 'codex', 'agent metadata is sealed, caller cannot forge it');
  assert.equal(hit.headers['x-mirasim-sig'] !== undefined, true);

  // Control routes still refuse anything that is not in the allowlist.
  await assert.rejects(client.request({ path: '/v1/completions', method: 'POST', body: Buffer.from('{}') }), /Unsupported direct relay route/);
  await assert.rejects(client.request({ path: '/v1/embeddings', method: 'POST', body: Buffer.from('{}') }), /Unsupported direct relay route/);
});

test('bridge route gate lets POST /v1/chat/completions through to the relay', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-adapters-gate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'setting.json');
  const recipient = crypto.generateKeyPairSync('x25519');
  fs.writeFileSync(file, JSON.stringify({
    type: 'mirasim', access_token: 'access-test', refresh_token: 'refresh-test',
    device_private_key: crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
    expired: new Date(Date.now() + 3600000).toISOString(),
  }), { mode: 0o600 });

  let upstreamBody = null;
  const mock = http.createServer(async (req, res) => {
    const raw = await readText(req);
    if (req.url === '/v1/device/session') return res.end('{"ticket":"ticket-test","expiresIn":600}');
    upstreamBody = raw ? JSON.parse(raw) : null;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  });
  const origin = `http://127.0.0.1:${await listen(mock)}`;
  t.after(() => close(mock));

  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay', bridge_secret: 'secret', _config_path: path.join(tmp, 'config.json') });
  cfg.relay = { ...cfg.relay, url: origin, auth_url: origin, setting_json: 'setting.json' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fs.writeFileSync(path.join(tmp, 'setting.json'), fs.readFileSync(file));
  const ctx = bridge.newAccountCtx('main');
  const server = bridge.createBridgeServer(cfg, ctx, 'secret', 4);
  const port = await listen(server);
  t.after(() => close(server));

  const payload = JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'x-api-key': 'secret', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('error', reject); req.end(payload);
  });
  assert.equal(response.status, 200, response.body);
  assert.equal(JSON.parse(response.body).choices[0].message.content, 'pong');
  assert.deepEqual(upstreamBody, JSON.parse(payload), 'pass-through: no translation, no injected fields');

  // A route the relay does not serve is still refused locally, before any network call.
  const refused = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/completions', method: 'POST',
      headers: { 'x-api-key': 'secret', 'content-length': 2 } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(refused, 400);
});

// ---------------------------------------------------------------------------
// Roster parsing
// ---------------------------------------------------------------------------

test('roster keeps per-agent model objects with bounded validation', () => {
  assert.deepEqual(roster.agents.claude.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  const opus = roster.agents.claude[0];
  assert.deepEqual(opus, { id: 'claude-opus-5-5', label: 'opus 5.5', context_window: 1000000, max_output: 128000,
    auto_compact_ratio: 0.95, adaptive: true, default: true });
  // Only a literal `true` is adaptive; the string "yes" is dropped.
  assert.equal(roster.agents.claude[2].adaptive, undefined);
  assert.equal(roster.agents.claude[1].default, undefined);
  // effort rungs survive in roster order, including deepseek's `off`.
  assert.deepEqual(roster.agents.dsh[0].effort, ['off', 'low', 'high', 'max']);
  // autoCompactRatio outside (0,1] is dropped, exactly like the official client's bound.
  assert.equal(roster.agents.kimi[0].auto_compact_ratio, undefined);
  assert.equal(roster.agents.codex[0].auto_compact_ratio, 0.9);
  // pricing stays under its camelCase keys and gains a normalised view for usage accounting.
  assert.deepEqual(roster.models['claude-opus-5-5'].pricing, { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
  assert.deepEqual(roster.models['claude-sonnet-5-5'].pricing_usd, { input: 1, output: 5, cache_read: 0.1 });
  assert.deepEqual(roster.models['gpt-6-astra'].pricing_usd, { input: 10, output: 50 });
  // cli versions are still validated.
  assert.equal(roster.cli_min_versions.bogus, undefined);
  assert.equal(Object.keys(roster.cli_min_versions).length, 9);
});

test('rosterIds unions served with agent objects and skips withdrawn', () => {
  const ids = rosterIds(roster);
  for (const id of ['claude-opus-5-5', 'kimi-code/k3', 'deepseek-flash', 'deepseek-v4-flash-vision-exp']) assert.ok(ids.includes(id), id);
  for (const id of roster.withdrawn) assert.ok(!ids.includes(id), `${id} is withdrawn`);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates across served and agents');
  // Legacy shape (bare strings) still works, so old snapshots keep loading.
  assert.deepEqual(rosterIds({ served: ['a'], agents: { claude: ['b', 'a'] } }).sort(), ['a', 'b']);
});

test('modelInfo merges models[] under the agent row and resolves the [1m] suffix', () => {
  const bare = modelInfo(roster, 'claude', 'claude-opus-5-5');
  assert.equal(bare.adaptive, true);
  assert.equal(bare.context_window, 1000000);
  assert.deepEqual(bare.pricing_usd, { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 });
  // Same row for the context-window spelling the desktop client sends.
  assert.deepEqual(modelInfo(roster, 'claude', 'claude-opus-5-5[1m]'), bare);
  assert.deepEqual(modelInfo(roster, 'claude', 'claude-opus-5-5[1M]'), bare);
  // agent = null searches every agent list.
  assert.equal(modelInfo(roster, null, 'deepseek-flash[1m]').effort.includes('off'), true);
  // A served id with no models[] entry still resolves through its agent row.
  assert.equal(modelInfo(roster, 'dsh', 'deepseek-flash').label, 'v4.1-flash');
  assert.equal(modelInfo(roster, null, 'deepseek-v4-flash'), null);
  // A row is only merged from the agent list that actually lists it.
  assert.equal(modelInfo(roster, 'codex', 'claude-opus-5-5').adaptive, undefined);
  assert.equal(bareId('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(bareId('claude-opus-5[1M]'), 'claude-opus-5');
  assert.equal(bareId('kimi-k3'), 'kimi-k3');
});

// ---------------------------------------------------------------------------
// [1m] suffix: validate on the bare id, send the caller's exact string
// ---------------------------------------------------------------------------

test('[1m] suffix passes through while every local match uses the bare id', () => {
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });
  const r = bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5[1m]', messages: [msg('user', 'hi')], max_tokens: 10, temperature: 0.5 }, cfg);
  assert.equal(r.error, null);
  assert.equal(r.body.model, 'claude-opus-5-5[1m]', 'the relay sees what the client sent');
  assert.ok(r.notes.includes('model_1m_suffix'));
  assert.ok(r.notes.includes('sampling_stripped'));
  assert.equal(bridge.modelFamily('claude-opus-5-5[1m]'), 'claude');
  assert.equal(bridge.isModelAllowed('gpt-6-astra[1M]', cfg), true);
  // A disabled model stays disabled in either spelling.
  const blocked = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  blocked.constraints.model_block = '^claude-opus-5-5$';
  assert.equal(bridge.isModelAllowed('claude-opus-5-5[1m]', blocked), false);
  assert.equal(bridge.isModelAllowed('deepseek-v4-flash[1m]', cfg), false, 'disabled_models matches the bare id');
  // No suffix, no note.
  assert.equal(bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5', messages: [msg('user', 'hi')], max_tokens: 10 }, cfg).notes.includes('model_1m_suffix'), false);
});

// ---------------------------------------------------------------------------
// adaptive_effort switch
// ---------------------------------------------------------------------------

const adaptiveMsg = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

function adaptiveCfg(enabled, rung = 'high') {
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  cfg.constraints.adaptive_effort = enabled;
  cfg.constraints.adaptive_default_effort = rung;
  cfg.constraints.cc_identity_models = '';   // keep the assertion about thinking/output_config only
  return cfg;
}

test('adaptive_effort off: nothing is synthesised, even for an adaptive model', () => {
  const cfg = adaptiveCfg(false);
  const r = bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5', messages: adaptiveMsg, max_tokens: 10 }, cfg, { roster });
  assert.equal(r.error, null);
  assert.equal(r.body.thinking, undefined);
  assert.equal(r.body.output_config, undefined);
  assert.equal(r.notes.includes('adaptive_effort'), false);
});

test('adaptive_effort on: adaptive models get thinking.type=adaptive + output_config.effort', () => {
  const cfg = adaptiveCfg(true, 'high');
  const r = bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5[1m]', messages: adaptiveMsg, max_tokens: 10 }, cfg, { roster });
  assert.equal(r.error, null);
  assert.deepEqual(r.body.thinking, { type: 'adaptive' });
  assert.deepEqual(r.body.output_config, { effort: 'high' });
  assert.equal(r.body.model, 'claude-opus-5-5[1m]');
  assert.ok(r.notes.includes('adaptive_effort'));
  // A model the roster does not mark adaptive is untouched.
  const plain = bridge.sanitizeMessagesRequest({ model: 'gpt-6-astra', messages: adaptiveMsg, max_tokens: 10 }, cfg, { roster });
  assert.equal(plain.body.thinking, undefined);
  assert.equal(plain.body.output_config, undefined);
  // A claude model the roster does not mark adaptive (an agent row is required) is untouched.
  const notAdaptive = bridge.sanitizeMessagesRequest({ model: 'claude-haiku-5-5', messages: adaptiveMsg, max_tokens: 10 }, cfg,
    { roster: { ...roster, agents: { ...roster.agents, claude: roster.agents.claude.filter((m) => m.id !== 'claude-haiku-5-5') } } });
  assert.equal(notAdaptive.body.thinking, undefined);
  // No cached roster → no evidence of `adaptive` → nothing is guessed.
  const unknown = bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5', messages: adaptiveMsg, max_tokens: 10 }, cfg);
  assert.equal(unknown.body.thinking, undefined);
  // Switch on but no rung configured: still nothing.
  const noRung = bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5', messages: adaptiveMsg, max_tokens: 10 }, adaptiveCfg(true, ''), { roster });
  assert.equal(noRung.body.thinking, undefined);
});

test('adaptive_effort on never overwrites a caller-supplied thinking or output_config', () => {
  const cfg = adaptiveCfg(true, 'high');
  const withThinking = bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5', messages: adaptiveMsg, max_tokens: 10,
    thinking: { type: 'enabled', budget_tokens: 2048 } }, cfg, { roster });
  assert.deepEqual(withThinking.body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(withThinking.body.output_config, undefined);
  const withEffort = bridge.sanitizeMessagesRequest({ model: 'claude-opus-5-5', messages: adaptiveMsg, max_tokens: 10,
    output_config: { effort: 'low' } }, cfg, { roster });
  assert.deepEqual(withEffort.body.output_config, { effort: 'low' });
  assert.equal(withEffort.body.thinking, undefined);
  // Kimi's default-effort path also leaves an explicit thinking alone.
  const kimi = bridge.sanitizeMessagesRequest({ model: 'kimi-code/k3', messages: adaptiveMsg, max_tokens: 10,
    thinking: { type: 'disabled' } }, bridge.deepMerge({}, bridge.DEFAULT_CONFIG), { roster });
  assert.equal(kimi.body.output_config, undefined);
});

test('config validation: adaptive_effort is a boolean, adaptive_default_effort a known rung', () => {
  const ok = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  ok.constraints.adaptive_effort = true; ok.constraints.adaptive_default_effort = 'xhigh';
  assert.doesNotThrow(() => bridge.validateConfig(ok));
  const badSwitch = bridge.deepMerge({}, bridge.DEFAULT_CONFIG); badSwitch.constraints.adaptive_effort = 'yes';
  assert.throws(() => bridge.validateConfig(badSwitch), /adaptive_effort/);
  const badRung = bridge.deepMerge({}, bridge.DEFAULT_CONFIG); badRung.constraints.adaptive_default_effort = 'turbo';
  assert.throws(() => bridge.validateConfig(badRung), /adaptive_default_effort/);
  assert.equal(bridge.DEFAULT_CONFIG.constraints.adaptive_effort, false, 'default must stay off');
});

// ---------------------------------------------------------------------------
// Effort rung vocabulary
// ---------------------------------------------------------------------------

test('Responses accepts the roster rung set including off, and still rejects inventions', () => {
  for (const effort of ['none', 'minimal', 'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const out = normalizeResponses({ model: 'gpt-6-astra', input: 'hi', reasoning: { effort } });
    assert.equal(out.body.reasoning.effort, effort);
  }
  for (const effort of ['', 'turbo', 'OFF']) {
    assert.throws(() => normalizeResponses({ model: 'gpt-6-astra', input: 'hi', reasoning: { effort } }), /reasoning\.effort/);
  }
});
