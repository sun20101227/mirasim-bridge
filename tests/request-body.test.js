'use strict';
// Local signed relay only: no external accounts, credentials or inference.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { createCredential } = require('../lib/login');
const { createPanel } = require('../lib/panel');
const b = require('../mirasim-bridge');
const MB = 1024 * 1024;
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => { s.close(r); s.closeAllConnections(); });

async function fixture(t, limit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-request-body-'));
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/v1/device/session') return res.end('{"ticket":"mock-ticket","expiresIn":600}');
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push({ url: req.url, payload });
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: {
        id: 'mock-response', object: 'response', status: 'completed', model: payload.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
      } }) + '\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/responses/compact') return res.end('{"id":"mock-compact","object":"response.compaction","output":[]}');
    res.end(JSON.stringify({ model: payload.model, type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  });
  const upPort = await listen(upstream), cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay', _config_path: path.join(dir, 'config.json'), bridge_secret: 'mock-main-key' });
  cfg.relay.url = cfg.relay.auth_url = `http://127.0.0.1:${upPort}`; cfg.relay.setting_json = 'setting.json';
  if (limit !== undefined) cfg.forward.replay_buffer_mb = limit;
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'mock-access', refresh: 'mock-refresh' })));
  const ctx = b.newAccountCtx('main'), hub = new b.AccountHub(cfg, ctx);
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), port = await listen(server);
  const panel = createPanel(cfg, ctx);
  t.after(async () => {
    panel.close(); await close(server); await close(upstream);
    for (const a of hub.all()) await a.ctx.usageStore?.queue;
    assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('bridge-request-body-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = (raw, { route = '/v1/messages', key = cfg.bridge_secret, chunked = false } = {}) => new Promise((resolve, reject) => {
    const bytes = Buffer.from(raw);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: {
      'content-type': 'application/json', 'x-api-key': key,
      ...(chunked ? {} : { 'content-length': bytes.length }),
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    (async () => {
      if (chunked) {
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          if (!req.write(bytes.subarray(offset, offset + 65536))) await once(req, 'drain');
        }
        req.end();
      } else req.end(bytes);
    })().catch(reject);
  });
  const call = async (raw, options = {}) => {
    const result = await request(raw, options), account = hub.find(options.key || cfg.bridge_secret);
    // The response can finish before asynchronous usage persistence releases the slot.
    for (let n = 0; account.ctx.inflight && n < 500; n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(account.ctx.inflight, 0, 'request slot must be released after persistence');
    return result;
  };
  return { cfg, ctx, hub, panel, seen, call, dir };
}

const messages = text => JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: text }] });

test('default accepts requests larger than 8 MB without truncating Messages, Responses or compact input', { timeout: 30000 }, async t => {
  const f = await fixture(t), text = '中🙂' + 'x'.repeat(9 * MB) + '尾部';
  assert.equal((await f.call(messages(text))).status, 200);
  assert.equal(f.seen.at(-1).payload.messages[0].content, text);
  const input = [{ role: 'user', content: text }];
  for (const route of ['/v1/responses', '/backend-api/codex/responses', '/v1/responses/compact']) {
    const result = await f.call(JSON.stringify({ model: 'gpt-test', input, stream: !route.endsWith('/compact') }), { route });
    assert.equal(result.status, 200, result.raw);
    assert.deepEqual(f.seen.at(-1).payload.input, input);
  }
  assert.equal(f.seen.length, 4);
});

test('explicit legacy limit returns 413, panel raises it live and hosted accounts retain independent limits', { timeout: 30000 }, async t => {
  const f = await fixture(t, 8), body = messages('x'.repeat(9 * MB));
  let result = await f.call(body);
  assert.equal(result.status, 413);
  assert.equal(JSON.parse(result.raw).error.code, 'request_too_large');
  assert.equal(JSON.parse(result.raw).error.type, 'invalid_request_error');
  assert.match(result.raw, /8MB.*account settings/);
  assert.equal(f.seen.length, 0); assert.equal(f.ctx.backoffUntil, 0);
  assert.equal((await f.panel.call('summary')).replay_buffer_mb, 8);
  await f.panel.call('settings', { max_concurrency: 2, kimi_max_concurrency: 1, replay_buffer_mb: 64 });
  assert.equal(JSON.parse(fs.readFileSync(f.cfg._config_path)).forward.replay_buffer_mb, 64);
  assert.equal((await f.call(body)).status, 200);

  const profile = path.join(f.dir, 'profiles', 'small'); fs.mkdirSync(profile, { recursive: true });
  const small = b.deepMerge(f.cfg, { bridge_secret: 'mock-small-key', sub2api: { account_name: 'small' }, forward: { replay_buffer_mb: 1 } });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(small));
  fs.copyFileSync(path.join(f.dir, 'setting.json'), path.join(profile, 'setting.json'));
  const second = f.hub.add('small'), medium = messages('x'.repeat(2 * MB));
  const before = f.seen.length;
  result = await f.call(medium, { key: small.bridge_secret });
  assert.equal(result.status, 413); assert.match(result.raw, /1MB/); assert.equal(f.seen.length, before);
  assert.equal((await f.call(medium)).status, 200);
  await f.panel.call('settings', { account: 'small', max_concurrency: 2, kimi_max_concurrency: 1, replay_buffer_mb: 4 });
  assert.equal((await f.call(medium, { key: small.bridge_secret })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'config.json'))).forward.replay_buffer_mb, 4);
  assert.equal(f.cfg.forward.replay_buffer_mb, 64);
  assert.equal(second.ctx.inflight, 0); assert.equal(f.ctx.inflight, 0);
});

test('byte boundary is inclusive for fixed-length and chunked uploads; over-limit requests never reach upstream', { timeout: 15000 }, async t => {
  const f = await fixture(t, 1);
  const prefix = '中🙂', overhead = Buffer.byteLength(messages(prefix));
  const exact = messages(prefix + 'x'.repeat(MB - overhead));
  assert.equal(Buffer.byteLength(exact), MB);
  for (const chunked of [false, true]) {
    assert.equal((await f.call(exact, { chunked })).status, 200);
    const before = f.seen.length, result = await f.call(exact + ' ', { chunked });
    assert.equal(result.status, 413); assert.equal(f.seen.length, before);
    assert.equal((await f.call(messages('small request after rejection'), { chunked })).status, 200);
  }
  assert.equal(f.ctx.backoffUntil, 0); assert.equal(f.ctx.inflight, 0);
});
