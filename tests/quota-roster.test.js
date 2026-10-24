'use strict';
// End-to-end: a relay that refuses /v1/models with credit_exhausted_shared while
// /v1/model-roster still answers — the exact state observed live on 2026-10-24.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Readable } = require('node:stream');
const b = require('../mirasim-bridge');
const { createPanel } = require('../lib/panel');
const { createCredential } = require('../lib/login');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

const ROSTER = {
  version: '2026-10-24.v3+qaad272ef+sc5edcdfa',
  cli: { codex: { minVersion: '0.159.3' } },
  agents: { codex: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }], claude: [{ id: 'claude-opus-5-5' }] },
  served: ['gpt-6-astra', 'gpt-6-luna', 'claude-opus-5-5'],
  withdrawn: ['claude-sonnet-5'],
  models: {
    'gpt-6-astra': { effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], pricing: { input: 10, output: 50 } },
    'gpt-6-luna': { effort: ['low', 'medium', 'high', 'xhigh', 'max'], pricing: { input: 0.1, output: 0.5 } },
  },
};
const QUOTA_BODY = JSON.stringify({ error: { message: '平台的共享额度已用尽', type: 'credit_exhausted_shared' } });

test('shared-quota refusal keeps the account reachable via roster and names the cause', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/device/session') return res.end('{"ticket":"t","expiresIn":600}');
    seen.push(req.url);
    if (req.url === '/v1/models') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600',
        'x-mirasim-error': 'mirasim-router:quota_exhausted', 'x-router-failure': 'quota; scope=account', 'x-should-retry': 'false' });
      return res.end(QUOTA_BODY);
    }
    if (req.url === '/v1/model-roster') return res.end(JSON.stringify(ROSTER));
    if (req.url === '/v1/limits') return res.end('{"windows":[{"name":"30d","used":14728.996882,"budget":1,"reset_at":1794227913}]}');
    res.writeHead(404); res.end();
  });
  const origin = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));

  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay', bridge_secret: 'secret', _config_path: path.join(dir, 'config.json') });
  cfg.relay = { ...cfg.relay, url: origin, auth_url: origin, setting_json: 'setting.json' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'access-test', refresh: 'refresh-test' })));

  const ctx = b.newAccountCtx('main');
  const target = b.resolveTarget(cfg);
  const probe = await b.probeUpstream(target, '/v1/models', cfg);
  assert.equal(probe.status, 429);
  assert.equal(probe.failure.kind, 'quota');
  assert.equal(probe.failure.retry_after_sec, 3600);
  assert.equal(probe.failure.should_retry, false);
  assert.equal(probe.failure.detail, 'credit_exhausted_shared');
  assert.equal(b.getRelay(cfg).ready, false);
  assert.equal(b.getRelay(cfg).probe.kind, 'quota');
  assert.equal(b.getRelay(cfg).probe.status, 429);

  // The roster still answers: that is reachability, and it carries the routable set.
  const roster = await b.fetchRoster(cfg, ctx);
  assert.deepEqual(b.rosterIds(roster).sort(), ['claude-opus-5-5', 'gpt-6-luna', 'gpt-6-astra'].sort());
  assert.deepEqual(roster.models['gpt-6-astra'].effort.slice(-1), ['ultra']);
  assert.deepEqual(roster.withdrawn, ['claude-sonnet-5']);

  // ...and a second call inside the TTL must not hit the relay again.
  const before = seen.filter((p) => p === '/v1/model-roster').length;
  await b.fetchRoster(cfg, ctx);
  assert.equal(seen.filter((p) => p === '/v1/model-roster').length, before, 'roster is TTL-cached');

  // Health tick: probe fails, but the failure is recorded and the roster is read.
  ctx.sm = null;
  await b.accountHealthTick({ key: 'main', cfg, ctx }, { tickCount: 1, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(ctx.lastProbeFailure.kind, 'quota');
  assert.equal(ctx.lastProbeFailure.retry_after_sec, 3600);
  assert.ok(ctx.roster, 'roster cached even while /v1/models is refused');
  assert.equal(ctx.lastHealthy, false, 'a quota-exhausted account must not report healthy');
});

test('panel falls back to roster ids when the catalog is refused, and flags withdrawn ids', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-quota-panel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay', bridge_secret: 'secret', _config_path: path.join(dir, 'config.json'), _relay_mode: 'quota' });
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  const ctx = b.newAccountCtx('main');
  // Simulate the relay exactly as the live one behaves today.
  const relay = {
    request: async ({ path: route }) => {
      if (route === '/v1/models') {
        const body = Buffer.from(QUOTA_BODY);
        return Object.assign(Readable.from([body]), { statusCode: 429, headers: { 'retry-after': '3600' } });
      }
      if (route === '/v1/model-roster') return Object.assign(Readable.from([Buffer.from(JSON.stringify(ROSTER))]), { statusCode: 200 });
      return Object.assign(Readable.from([Buffer.from('{}')]), { statusCode: 404 });
    },
  };
  const readAll = async (stream) => { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts).toString('utf8'); };
  const fake = {
    ...b,
    getRelay: () => relay,
    rosterIds: b.rosterIds,
    // Mirrors bridge.fetchRoster, but over the injected relay above.
    fetchRoster: async (c, cctx = {}, { force = false } = {}) => {
      const at = Date.parse(cctx.roster?.fetched_at || '');
      if (!force && cctx.roster && Number.isFinite(at) && Date.now() - at < 600000) return cctx.roster;
      const res = await relay.request({ path: '/v1/model-roster' });
      if (res.statusCode !== 200) { cctx.roster_error = 'roster HTTP ' + res.statusCode; return cctx.roster || null; }
      cctx.roster = b.summarizeRoster(JSON.parse(await readAll(res)));
      return cctx.roster;
    },
  };
  const panel = createPanel(cfg, ctx, { bridge: fake });
  t.after(() => panel.close());
  const rows = await panel.call('models', {});
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['claude-opus-5-5', 'gpt-6-luna', 'gpt-6-astra'].sort());
  assert.equal(byId['gpt-6-astra'].source, 'roster');
  assert.deepEqual(byId['gpt-6-astra'].effort.slice(-1), ['ultra']);
  assert.equal(byId['gpt-6-astra'].served, true);
  assert.deepEqual(byId['gpt-6-luna'].effort.includes('ultra'), false);
  assert.equal(byId['gpt-6-astra'].withdrawn, false);
});
