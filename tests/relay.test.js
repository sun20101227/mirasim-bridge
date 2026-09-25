'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RelayClient, canonical, seal, loadCredential, validateEndpoint, readText } = require('../lib/relay');
const { normalizeResponses, aggregateResponses } = require('../lib/responses');
const bridge = require('../mirasim-bridge');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

// Public deterministic vectors from internal/mirasim/protocol_test.go (MIT).
test('Ed25519 canonical/signature matches reference crypto vector', () => {
  const input = { method: 'POST', path: '/v1/messages', timestamp: '1788200000123', nonce: 'AAECAwQFBgcICQoL',
    device: 'device-fixed', version: '0.0.260', credential: 'ticket-fixed',
    metadata: { 'x-mirasim-session': 'mirasim_00000000-0000-4000-8000-000000000000', 'x-mirasim-agent': 'claude', 'x-mirasim-call': '11111111-2222-4333-8444-555555555555' },
    body: Buffer.from('{"model":"claude-sonnet-5","messages":[]}') };
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const signature = crypto.sign(null, canonical(input), key).toString('base64url');
  assert.equal(signature, 'zUYTEKW17Gzn7TEdEzWZ2aEOpO4oW9YFFpdsyzJaUyS4A_byq3DUNYzNOL96D24MExQ0mVbot75TkvkJw3vVAQ');
  assert.equal(canonical({ ...input, metadata: {} }).toString().split('\n')[8], '');
  assert.throws(() => canonical({ ...input, path: '/v1/\0' }));
});

test('X25519/HKDF/ChaCha seal matches reference crypto vector', () => {
  const plain = '{"x-mirasim-agent":"claude","x-mirasim-call":"11111111-2222-4333-8444-555555555555","x-mirasim-device":"device-fixed","x-mirasim-nonce":"AAECAwQFBgcICQoL","x-mirasim-session":"mirasim_00000000-0000-4000-8000-000000000000","x-mirasim-sig":"zUYTEKW17Gzn7TEdEzWZ2aEOpO4oW9YFFpdsyzJaUyS4A_byq3DUNYzNOL96D24MExQ0mVbot75TkvkJw3vVAQ","x-mirasim-ts":"1788200000123"}';
  const got = seal(Buffer.from('NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=', 'base64'),
    Buffer.from('404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f', 'hex'),
    Buffer.from('a0a1a2a3a4a5a6a7a8a9aaab', 'hex'), Buffer.from(plain), Buffer.from('mrs-seal-v1\nPOST\n/v1/messages'));
  assert.equal(got.toString('base64url'), 'eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRqgoaKjpKWmp6ipqqtWlxgybxeoS1fVDaS5_1az3V-kX_XGGNPghY8g8q81tF8LkfDoIwY8W2FWXoe5_27zjH9q2jM05ZuvNfmdYnjW0x616SP-p3g96-PvzI8GDuAbPgt9-0sIkQHeCCZ35opOpopxt_tdTp55bPp8CmjCpb1OR0aWs_5UezjAlVNibbN4979hGY_BcQ7z07Bkt92DCgJiP9aP8pLSXM1gcFHvnDDAiAqfqqA1cWx2f3EIHn585U-tdtQsRZ5BJ7wJ4sZgMswGl5CxDgSFJ-MhnsQsyj6zAR_MVujCO4jUkLVsRtI38N6sN-T79EWL4w4N1ksEfzIUJDtYDNfbr83XkXpl3sB6DvYIrrrPi5Gq96WSWldJf5Pgz0IdJq_O36wS2dNYVqQmsOU-nwgigBh0NrD94K23PthUn8qbkULkp7PgyPGDXN-4MkvdjN8LVN-oEP1oaP5FMVbiH6b_7K_9NaXvJCELj59p2P_fCnJ2ULHCpwyfDGOKjg');
});

test('Responses normalization/aggregation preserves tool and opaque items and detects failure', () => {
  const opaque = { type: 'compaction', encrypted_content: 'opaque-history' };
  const normal = normalizeResponses({ model: 'gpt-test', input: [opaque], stream: false, reasoning: { effort: 'ultra' } });
  assert.equal(normal.body.stream, true); assert.equal(normal.downstreamStream, false);
  assert.equal(normal.body.reasoning.effort, 'max'); assert.deepEqual(normal.body.input, [opaque]);
  const compact = normalizeResponses({ model: 'gpt-test', input: [opaque] }, { compact: true });
  assert.ok(!('stream' in compact.body));
  const normalized = normalizeResponses({ model: 'gpt-test', input: 'hello', max_output_tokens: 512, temperature: 0.1 });
  assert.equal(normalized.body.input[0].content[0].text, 'hello');
  assert.equal(normalized.body.store, false); assert.equal(normalized.body.max_output_tokens, undefined);
  assert.equal(normalized.body.temperature, undefined); assert.ok(normalized.body.include.includes('reasoning.encrypted_content'));
  assert.throws(() => normalizeResponses({ model: 'gpt-test', stream: true }, { compact: true }));
  assert.throws(() => normalizeResponses({ model: 'kimi-test' }));
  assert.throws(() => normalizeResponses({ model: 'gpt-test', reasoning: { effort: 'off' } }));
  const sse = (events) => events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('');
  const tool = { type: 'function_call', call_id: 'call-1', name: 'weather', arguments: '{"city":"上海"}' };
  const terminal = { type: 'response.completed', response: { object: 'response', status: 'completed', output: [], usage: { input_tokens: 42 } } };
  const out = aggregateResponses(sse([
    { type: 'response.output_item.done', output_index: 1, item: opaque },
    { type: 'response.output_item.done', output_index: 0, item: tool }, terminal,
  ]));
  assert.deepEqual(out.output, [tool, opaque]); assert.equal(out.usage.input_tokens, 42);
  assert.throws(() => aggregateResponses(sse([{ type: 'response.output_text.delta', delta: 'unfinished' }])));
  assert.throws(() => aggregateResponses(sse([terminal, { type: 'error' }])));
  assert.throws(() => aggregateResponses(sse([{ type: 'response.failed' }])));
  assert.deepEqual(aggregateResponses(sse([{ type: 'response.incomplete', response: { ...out, status: 'incomplete' } }])).status, 'incomplete');
});

test('direct relay lifecycle, control signing, sealed inference and bridge routes', { timeout: 20000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-relay-test-'));
  const file = path.join(tmp, 'setting.json');
  const signer = crypto.generateKeyPairSync('ed25519');
  const recipient = crypto.generateKeyPairSync('x25519');
  const pem = signer.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const state = { auth: { token: 'access-test', refreshToken: 'refresh-test', exp: Math.floor(Date.now() / 1000) + 7200 }, device: { privateKey: pem }, unrelated: { keep: 1 } };
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  let mint = 0, refresh = 0, seen, mintStatus = 200, errorStatus = 0, incomplete = false;
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    try {
      const raw = await readText(req);
      const route = req.url.split('?')[0];
      calls.push(route);
      if (route === '/auth/refresh') {
        refresh++; assert.equal(JSON.parse(raw).refresh_token, 'refresh-test');
        return res.end(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 7200 }));
      }
      let h = { ...req.headers };
      if (h['x-mirasim-enc']) {
        const packed = Buffer.from(h['x-mirasim-enc'], 'base64url');
        const ephemeral = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), packed.subarray(0, 32)]), format: 'der', type: 'spki' });
        const shared = crypto.diffieHellman({ privateKey: recipient.privateKey, publicKey: ephemeral });
        const key = crypto.hkdfSync('sha256', shared, packed.subarray(0, 32), 'mrs-seal-v1', 32);
        const decipher = crypto.createDecipheriv('chacha20-poly1305', key, packed.subarray(32, 44), { authTagLength: 16 });
        decipher.setAAD(Buffer.from(`mrs-seal-v1\n${req.method}\n${route}`)); decipher.setAuthTag(packed.subarray(-16));
        h = { ...h, ...JSON.parse(Buffer.concat([decipher.update(packed.subarray(44, -16)), decipher.final()])) };
      }
      const metadata = Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith('x-mirasim-') && !['x-mirasim-client', 'x-mirasim-enc', 'x-mirasim-sig', 'x-mirasim-ts', 'x-mirasim-device', 'x-mirasim-nonce'].includes(k)));
      const signed = canonical({ method: req.method, path: route, timestamp: h['x-mirasim-ts'], nonce: h['x-mirasim-nonce'],
        device: h['x-mirasim-device'], version: h['x-mirasim-client'], credential: h.authorization.slice(7), metadata, body: Buffer.from(raw) });
      assert.ok(crypto.verify(null, signed, signer.publicKey, Buffer.from(h['x-mirasim-sig'], 'base64url')));
      seen = { route, metadata, wire: req.headers, body: raw ? JSON.parse(raw) : null };
      if (route === '/v1/device/session') {
        mint++; assert.equal(seen.body.deviceId, h['x-mirasim-device']);
        res.writeHead(mintStatus); return res.end(JSON.stringify({ ticket: 'ticket-test', expiresIn: 600 }));
      }
      if (errorStatus) { res.writeHead(errorStatus); return res.end('mock error'); }
      if (route === '/v1/models') {
        assert.deepEqual(metadata, {}); assert.equal(req.headers['x-mirasim-enc'], undefined);
        return res.end(JSON.stringify({ data: [{ id: 'claude-test' }, { id: 'gpt-test' }, { id: 'deepseek-test' }, { id: 'kimi-test' }] }));
      }
      if (route === '/v1/limits' || route === '/v1/model-roster') {
        assert.deepEqual(metadata, {});
        return res.end(JSON.stringify({ windows: [{ name: '5h', budget: 100, used: 20 }, { name: '7d_fable', model_scoped: true, budget: 1, used: 1 }] }));
      }
      if (route === '/v1/responses') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"OK"}]}}\n\n');
        if (!incomplete) res.write('data: {"type":"response.completed","response":{"id":"resp-test","object":"response","status":"completed","output":[],"usage":{"output_tokens":1}}}\n\n');
        return res.end();
      }
      return res.end(JSON.stringify({ ok: true, output: [{ type: 'compaction', encrypted_content: 'unchanged' }] }));
    } catch (err) { res.writeHead(500); res.end(err.stack); }
  });
  const mockPort = await listen(mock);
  const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay' });
  Object.assign(cfg.relay, { url: `http://127.0.0.1:${mockPort}`, auth_url: `http://127.0.0.1:${mockPort}`, setting_json: file,
    seal_public_key: recipient.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') });
  const client = bridge.getRelay(cfg);
  const ctx = { inflight: 0, backoffUntil: 0, startedAt: Date.now(), counters: { total: 0, ok: 0, err: 0, rejected: 0, injected: 0, sampling_retried: 0, models_filtered: 0, sanitized: {} } };
  const server = bridge.createBridgeServer(cfg, ctx, 'bridge-test', 4);
  const port = await listen(server);
  const target = { host: '127.0.0.1', port, prefix: '', headers: { 'x-api-key': 'bridge-test', 'x-mirasim-session': 'forged', 'anthropic-beta': 'oauth-2025-04-20,other-beta' } };
  try {
    await t.test('single ticket for concurrent model requests; control calls never infer', async () => {
      const results = await Promise.all(Array.from({ length: 3 }, async () => {
        const response = await client.request({ path: '/v1/models' }); await readText(response); return response.statusCode;
      }));
      assert.deepEqual(results, [200, 200, 200]); assert.equal(mint, 1);
      assert.ok(calls.every((p) => ['/v1/models', '/v1/device/session'].includes(p)));
    });
    await t.test('quota does not cause inference and does not collapse model-scoped quota', async () => {
      const r = await bridge.diagnosticRequest(target, '/v1/limits');
      assert.equal(r.status, 200); assert.equal(JSON.parse(r.raw).windows[1].model_scoped, true);
      assert.equal(seen.wire['x-mirasim-enc'], undefined);
    });
    for (const [model, agent] of [['claude-test', 'claude'], ['deepseek-test', 'dsh'], ['kimi-test', 'kimi']]) {
      await t.test(`sealed Messages selects ${agent} for ${model}`, async () => {
        const r = await bridge.diagnosticRequest(target, '/v1/messages', { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16 });
        assert.equal(r.status, 200, r.raw); assert.equal(seen.metadata['x-mirasim-agent'], agent);
        assert.equal(seen.metadata['x-mirasim-collect'], 'off'); assert.notEqual(seen.metadata['x-mirasim-session'], 'forged');
        assert.equal(seen.metadata['x-mirasim-account'], undefined);
        assert.equal(seen.wire['anthropic-beta'], 'other-beta'); assert.ok(seen.wire['x-mirasim-enc']);
      });
    }
    await t.test('Responses JSON reconstructs terminal output; stream mode preserves SSE', async () => {
      const r = await bridge.diagnosticRequest(target, '/v1/responses', { model: 'gpt-test', input: 'Hello', stream: false });
      assert.equal(r.status, 200, r.raw); assert.equal(JSON.parse(r.raw).output[0].content[0].text, 'OK');
      assert.equal(seen.body.stream, true); assert.equal(seen.metadata['x-mirasim-agent'], 'codex');
      assert.equal(seen.body.system, undefined); assert.equal(seen.body.max_tokens, undefined);
      const streaming = await bridge.diagnosticRequest(target, '/v1/responses', { model: 'gpt-test', input: 'Hello', stream: true });
      assert.match(streaming.raw, /response.completed/);
    });
    await t.test('truncated Responses JSON returns 503, never a fake successful response', async () => {
      incomplete = true;
      const r = await bridge.diagnosticRequest(target, '/v1/responses', { model: 'gpt-test', input: 'Hi' });
      assert.equal(r.status, 503); incomplete = false;
    });
    await t.test('Codex compact alias preserves opaque input/output without injecting CC', async () => {
      const input = [{ type: 'compaction', encrypted_content: 'opaque-input' }];
      const r = await bridge.diagnosticRequest(target, '/backend-api/codex/responses/compact', { model: 'gpt-test', input });
      assert.equal(r.status, 200, r.raw); assert.equal(seen.route, '/v1/responses/compact');
      assert.deepEqual(seen.body.input, input); assert.ok(!('stream' in seen.body)); assert.ok(!('system' in seen.body));
      assert.equal(JSON.parse(r.raw).output[0].encrypted_content, 'unchanged');
    });
    await t.test('unsupported route/method, blocked model and invalid JSON stay local', async () => {
      const before = calls.length;
      assert.equal((await bridge.diagnosticRequest(target, '/v1/chat/completions', { model: 'gpt-test' })).status, 400);
      assert.equal((await bridge.diagnosticRequest(target, '/v1/responses')).status, 400);
      assert.equal((await bridge.diagnosticRequest(target, '/v1/responses', { model: 'gpt-fable' })).status, 400);
      assert.equal((await bridge.diagnosticRequest(target, '/v1/responses', [])).status, 400);
      assert.equal(calls.length, before);
    });
    await t.test('expired token refreshes once, persists rotated tokens, retains unrelated settings', async () => {
      const old = JSON.parse(fs.readFileSync(file)); old.auth.exp = 1; fs.writeFileSync(file, JSON.stringify(old));
      client.credential = loadCredential(file); client.ticket = '';
      const responses = await Promise.all(Array.from({ length: 3 }, async () => {
        const res = await client.request({ path: '/v1/models' }); await readText(res); return res.statusCode;
      }));
      assert.deepEqual(responses, [200, 200, 200]); assert.equal(refresh, 1);
      const disk = JSON.parse(fs.readFileSync(file));
      assert.equal(disk.auth.refreshToken, 'refresh-new'); assert.equal(disk.unrelated.keep, 1);
      assert.ok(!fs.existsSync(file + '.refresh-lock'));
    });
    await t.test('404 ticket mint falls back to signed access with quiet period', async () => {
      mintStatus = 404; client.ticket = ''; client.ticketRetry = 0;
      const before = mint;
      for (let i = 0; i < 2; i++) {
        const res = await client.request({ path: '/v1/models' }); assert.equal(res.statusCode, 200); await readText(res);
      }
      assert.equal(mint, before + 1); assert.equal(seen.wire.authorization, 'Bearer access-new');
    });
    await t.test('ticket 429 cools down without falling back to access token', async () => {
      mintStatus = 429; client.ticket = ''; client.ticketQuiet = 0;
      await assert.rejects(client.request({ path: '/v1/models' }), /ticket HTTP 429/);
      const before = mint;
      await assert.rejects(client.request({ path: '/v1/models' }), /cooling down/);
      assert.equal(mint, before); client.ticketRetry = 0; mintStatus = 200;
    });
    await t.test('inference 401 is not replayed and invalidates ticket, returning local 503', async () => {
      errorStatus = 401;
      const before = calls.filter((p) => p === '/v1/responses').length;
      const r = await bridge.diagnosticRequest(target, '/v1/responses', { model: 'gpt-test', input: 'Hi' });
      assert.equal(r.status, 503);
      assert.equal(calls.filter((p) => p === '/v1/responses').length, before + 1);
      assert.equal(client.ticket, ''); assert.equal(client.ready, false);
      errorStatus = 0;
    });
    await t.test('status redacts credentials and encrypted headers', async () => {
      const r = await bridge.diagnosticRequest(target, '/__status');
      assert.equal(JSON.parse(r.raw).backend, 'relay');
      for (const s of ['access-new', 'refresh-new', 'ticket-test', 'PRIVATE KEY', 'x-mirasim-enc']) assert.ok(!r.raw.includes(s));
    });
  } finally {
    await close(server); await close(mock);
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('bridge-relay-test-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('relay endpoints require HTTPS, except loopback; never accept credential URLs', () => {
  assert.throws(() => validateEndpoint('http://example.com'));
  assert.throws(() => validateEndpoint('https://user:pass@example.com'));
  assert.throws(() => validateEndpoint('https://example.com/?token=secret'));
  assert.doesNotThrow(() => validateEndpoint('http://127.0.0.1:1234'));
});

test('mrs1 export decrypts only account credentials, preserves identity and rejects wrong keys', () => {
  const { portable, exportCredential } = require('../scripts/export-credential');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  const enc = (s) => {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(s), cipher.final()]);
    return 'mrs1:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  };
  const raw = { auth: { token: enc('access-test'), refreshToken: enc('refresh-test'), exp: 2000000000 },
    device: { privateKey: enc(pem) }, providers: [{ apiKey: 'unrelated-provider-key' }], failover: { manualKey: 'another-key' } };
  assert.throws(() => portable(raw), /master key/);
  assert.throws(() => portable(raw, crypto.randomBytes(32)), /Cannot decrypt/);
  const out = portable(raw, key);
  assert.equal(out.auth.token, 'access-test'); assert.equal(out.device.privateKey, pem);
  assert.equal(out.providers, undefined); assert.equal(out.failover, undefined);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-export-test-'));
  try {
    const source = path.join(tmp, 'source.json'), dest = path.join(tmp, 'dest.json');
    fs.writeFileSync(source, JSON.stringify(out));
    exportCredential(source, dest); assert.equal(loadCredential(dest).access, 'access-test');
    assert.throws(() => exportCredential(source, dest), /EEXIST/);
    assert.throws(() => exportCredential(source, source), /must differ/);
    fs.writeFileSync(source, JSON.stringify(raw));
    assert.throws(() => loadCredential(source), /Encrypted mrs1/);
  } finally {
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('bridge-export-test-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
