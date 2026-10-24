'use strict';
// local_only: the single-tenant shape. It narrows concurrency, background polling
// and idle synthetic probes. It deliberately does NOT touch signing, device
// identity or request pacing — those would be evading the provider's access
// control, which this project does not do. These tests pin both halves: what it
// changes, and that switching it off changes nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const b = require('../mirasim-bridge');
const { createCredential } = require('../lib/login');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** Relay that answers the control endpoints and counts every request it sees. */
async function fakeRelay(t, { models = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/device/session') return res.end('{"ticket":"t","expiresIn":600}');
    seen.push(req.url);
    if (req.url === '/v1/models') {
      if (models !== 200) { res.writeHead(models); return res.end('{"error":"nope"}'); }
      return res.end('{"data":[{"id":"claude-opus-5"},{"id":"kimi-k3"}]}');
    }
    if (req.url === '/v1/limits') return res.end('{"windows":[{"name":"5h","used":10,"budget":100}]}');
    if (req.url === '/v1/model-roster') return res.end('{"served":["claude-opus-5"],"withdrawn":[],"models":{}}');
    res.writeHead(404); res.end();
  });
  const origin = await listen(server); t.after(() => close(server));
  return { origin, seen };
}

function relayConfig(dir, origin, mutate = () => {}) {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay', bridge_secret: 'secret', _config_path: path.join(dir, 'config.json') });
  cfg.relay = { ...cfg.relay, url: origin, auth_url: origin, setting_json: 'setting.json' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  mutate(cfg);
  b.validateConfig(cfg);
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'access', refresh: 'refresh' })));
  return cfg;
}

test('local_only validates its own fields and is off by default', () => {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  assert.equal(cfg.local_only.enabled, false, 'an upgrade must not silently change behaviour');
  assert.doesNotThrow(() => b.validateConfig(cfg));
  for (const bad of [
    { enabled: 'yes' }, { single_concurrency: 1 }, { idle_probe: null },
    { idle_liveness_sec: 59 }, { quota_min_interval_sec: 0 }, { membership_min_interval_sec: 1.5 },
  ]) {
    const next = b.deepMerge({}, cfg);
    Object.assign(next.local_only, bad);
    assert.throws(() => b.validateConfig(next), /local_only/, JSON.stringify(bad));
  }
  const off = b.deepMerge({}, cfg);
  assert.throws(() => b.validateConfig({ ...off, local_only: null }), /local_only/);
});

test('off: concurrency and polling intervals are exactly the configured values', () => {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  cfg.forward.max_concurrency = 4; cfg.forward.kimi_max_concurrency = 2;
  cfg.quota.interval_sec = 600; cfg.membership.interval_sec = 700;
  assert.equal(b.effectiveConcurrency(cfg), 4);
  assert.equal(b.effectiveConcurrency(cfg, 'kimi'), 2);
  assert.equal(b.effectiveInterval(cfg, 'quota'), 600);
  assert.equal(b.effectiveInterval(cfg, 'membership'), 700);
});

test('on: one request at a time and longer background polling, without lowering explicit longer values', () => {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  cfg.forward.max_concurrency = 4; cfg.forward.kimi_max_concurrency = 2;
  cfg.quota.interval_sec = 3600; cfg.local_only.enabled = true;
  assert.equal(b.effectiveConcurrency(cfg), 1);
  assert.equal(b.effectiveConcurrency(cfg, 'kimi'), 1);
  assert.equal(b.effectiveInterval(cfg, 'quota'), 3600, 'an explicitly longer interval is not shortened');
  assert.equal(b.effectiveInterval(cfg, 'membership'), 1800);
  cfg.local_only.single_concurrency = false;
  assert.equal(b.effectiveConcurrency(cfg), 4, 'the switch really is a switch');
  assert.equal(b.effectiveConcurrency(cfg, 'kimi'), 2);
});

test('the concurrency gate enforces the local_only limit, not the configured one', async (t) => {
  const dir = tmp(t, 'mira-local-gate-'); const { origin } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin, (c) => { c.forward.max_concurrency = 3; c.local_only.enabled = true; });
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 3), base = await listen(server);
  t.after(() => close(server));
  // One request already in flight is enough: with a configured limit of 3 the old
  // gate would let a second through, and the relay would see two at once.
  ctx.inflight = 1;
  const blocked = await fetch(base + '/v1/models', { headers: { 'x-api-key': 'secret' } });
  assert.equal(blocked.status, 503);
  assert.match(await blocked.text(), /over concurrency limit \(1\)/);
  ctx.inflight = 0;
  assert.equal((await fetch(base + '/v1/models', { headers: { 'x-api-key': 'secret' } })).status, 200);
});

test('idle health ticks stay silent while the account is known healthy and recently active', async (t) => {
  const dir = tmp(t, 'mira-local-idle-'); const { origin, seen } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin, (c) => { c.local_only.enabled = true; c.health.interval_sec = 30; });
  const ctx = b.newAccountCtx('main');
  ctx.reachable = true;   // registered to sub2api: health is forward AND reverse
  const acct = { key: 'main', cfg, ctx };
  const probes = () => seen.filter((p) => p === '/v1/models').length;

  await b.accountHealthTick(acct, { tickCount: 1, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(probes(), 1, 'first tick has no baseline, so it probes once');
  assert.equal(ctx.lastKnownForwardOk, true);

  // Six consecutive ticks inside the liveness window: no traffic at all to the relay.
  const before = probes();
  for (let i = 2; i <= 7; i++) {
    await b.accountHealthTick(acct, { tickCount: i, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  }
  assert.equal(probes(), before, 'no synthetic /v1/models probe while idle');
  assert.equal(ctx.counters.idle_probe_skipped, 6);
  assert.equal(ctx.lastHealthy, true, 'silence must not be mistaken for failure');

  // A real successful request re-arms the quiet window.
  ctx.lastUpstreamAt = Date.now();
  await b.accountHealthTick(acct, { tickCount: 8, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(probes(), before);

  // Past idle_liveness_sec with no traffic at all, one liveness probe is sent.
  ctx.lastUpstreamAt = 0; ctx.lastUpstreamOkAt = 0; ctx.lastProbeAt = Date.now() - (cfg.local_only.idle_liveness_sec + 1) * 1000;
  await b.accountHealthTick(acct, { tickCount: 9, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(probes(), before + 1, 'liveness probe after the idle window expires');
});

test('idle silence never masks a failure: an unhealthy account keeps probing', async (t) => {
  const dir = tmp(t, 'mira-local-sick-'); const { origin, seen } = await fakeRelay(t, { models: 500 });
  const cfg = relayConfig(dir, origin, (c) => { c.local_only.enabled = true; });
  const ctx = b.newAccountCtx('main');
  const acct = { key: 'main', cfg, ctx };
  const probes = () => seen.filter((p) => p === '/v1/models').length;
  await b.accountHealthTick(acct, { tickCount: 1, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(ctx.lastKnownForwardOk, false);
  const before = probes();
  await b.accountHealthTick(acct, { tickCount: 2, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  await b.accountHealthTick(acct, { tickCount: 3, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  assert.equal(probes(), before + 2, 'recovery cannot be detected without probing');
  assert.equal(ctx.lastHealthy, false);
});

test('off: the health loop keeps probing every tick, as before', async (t) => {
  const dir = tmp(t, 'mira-local-off-'); const { origin, seen } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin);
  const ctx = b.newAccountCtx('main');
  const acct = { key: 'main', cfg, ctx };
  const probes = () => seen.filter((p) => p === '/v1/models').length;
  for (let i = 1; i <= 3; i++) {
    await b.accountHealthTick(acct, { tickCount: i, withSub2api: false, args: { flags: {} }, recheckEvery: 10 });
  }
  assert.equal(probes(), 3);
  assert.equal(ctx.counters.idle_probe_skipped, undefined);
});

test('status reports the enforced concurrency rather than the configured one', async (t) => {
  const dir = tmp(t, 'mira-local-status-'); const { origin } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin, (c) => { c.forward.max_concurrency = 3; c.local_only.enabled = true; });
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 3), base = await listen(server);
  t.after(() => close(server));
  const status = await (await fetch(base + '/__status', { headers: { 'x-api-key': 'secret' } })).json();
  assert.equal(status.local_only.enabled, true);
  assert.equal(status.local_only.concurrency, 1);
  const summary = b.accountSummary({ key: 'main', cfg, ctx });
  assert.equal(summary.max_concurrency, 3, 'the configured value is still reported');
  assert.equal(summary.effective_concurrency, 1, 'the enforced value is reported alongside it');
  assert.equal(summary.local_only, true);
});

test('upstreamConcurrency is what registration tells sub2api: never more than the gate', () => {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  assert.equal(b.upstreamConcurrency(cfg), 2, 'defaults agree: sub2api 2 and the gate 2');
  cfg.sub2api.concurrency = 8; cfg.forward.max_concurrency = 3;
  assert.equal(b.upstreamConcurrency(cfg), 3, 'a stale sub2api value cannot ask for more than the gate allows');
  cfg.sub2api.concurrency = 1; cfg.forward.max_concurrency = 4;
  assert.equal(b.upstreamConcurrency(cfg), 1, 'a lower sub2api value is respected');
  cfg.local_only.enabled = true; cfg.sub2api.concurrency = 6; cfg.forward.max_concurrency = 6;
  assert.equal(b.upstreamConcurrency(cfg), 1, 'local_only pins registration to one in-flight request');
  cfg.local_only.single_concurrency = false;
  assert.equal(b.upstreamConcurrency(cfg), 6);
});

test('saving concurrency settings pushes the same value to the sub2api account', async (t) => {
  const dir = tmp(t, 'mira-local-sync-'); const { origin } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin, (c) => { c.forward.max_concurrency = 3; c.local_only.enabled = true; });
  const ctx = b.newAccountCtx('main');
  ctx.sm = { accountId: 77, desired: 'on', async pause() { return true; }, async onProbe() {} };
  const updates = [];
  const original = { ...b.s2 };
  b.s2.updateAccount = async (c, id, patch) => { updates.push({ id, patch }); return {}; };
  t.after(() => Object.assign(b.s2, original));
  const { createPanel } = require('../lib/panel');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());

  const saved = await panel.call('settings', { max_concurrency: 3, kimi_max_concurrency: 1 });
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.sub2api_concurrency, { applied: true, concurrency: 1 });
  assert.deepEqual(updates, [{ id: 77, patch: { concurrency: 1 } }],
    'sub2api is told 1, not the 3 written to the config file');
  assert.equal(cfg.forward.max_concurrency, 3, 'the configured ceiling is still recorded');
});

test('a failed sub2api concurrency sync does not fail the save', async (t) => {
  const dir = tmp(t, 'mira-local-sync-fail-'); const { origin } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin);
  const ctx = b.newAccountCtx('main');
  ctx.sm = { accountId: 88, desired: 'on', async pause() { return true; }, async onProbe() {} };
  const original = { ...b.s2 };
  b.s2.updateAccount = async () => { throw Error('admin api down'); };
  t.after(() => Object.assign(b.s2, original));
  const { createPanel } = require('../lib/panel');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());

  const saved = await panel.call('settings', { max_concurrency: 2, kimi_max_concurrency: 1 });
  assert.equal(saved.saved, true, 'local config is authoritative for the gate');
  assert.equal(saved.sub2api_concurrency.applied, false);
  assert.match(saved.sub2api_concurrency.error, /admin api down/);
  assert.equal(JSON.parse(fs.readFileSync(cfg._config_path, 'utf8')).forward.max_concurrency, 2);
});

test('upstreamConcurrency is what registration tells sub2api: never more than the gate', () => {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  assert.equal(b.upstreamConcurrency(cfg), 2, 'defaults agree: sub2api 2 and the gate 2');
  cfg.sub2api.concurrency = 8; cfg.forward.max_concurrency = 3;
  assert.equal(b.upstreamConcurrency(cfg), 3, 'a stale sub2api value cannot ask for more than the gate allows');
  cfg.sub2api.concurrency = 1; cfg.forward.max_concurrency = 4;
  assert.equal(b.upstreamConcurrency(cfg), 1, 'a lower sub2api value is respected');
  cfg.local_only.enabled = true; cfg.sub2api.concurrency = 6; cfg.forward.max_concurrency = 6;
  assert.equal(b.upstreamConcurrency(cfg), 1, 'local_only pins registration to one in-flight request');
  cfg.local_only.single_concurrency = false;
  assert.equal(b.upstreamConcurrency(cfg), 6);
});

test('saving concurrency settings pushes the same value to the sub2api account', async (t) => {
  const dir = tmp(t, 'mira-local-sync-'); const { origin } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin, (c) => { c.forward.max_concurrency = 3; c.local_only.enabled = true; });
  const ctx = b.newAccountCtx('main');
  ctx.sm = { accountId: 77, desired: 'on', async pause() { return true; }, async onProbe() {} };
  const updates = [];
  const original = { ...b.s2 };
  b.s2.updateAccount = async (c, id, patch) => { updates.push({ id, patch }); return {}; };
  t.after(() => Object.assign(b.s2, original));
  const { createPanel } = require('../lib/panel');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());

  const saved = await panel.call('settings', { max_concurrency: 3, kimi_max_concurrency: 1 });
  assert.equal(saved.saved, true);
  assert.deepEqual(saved.sub2api_concurrency, { applied: true, concurrency: 1 });
  assert.deepEqual(updates, [{ id: 77, patch: { concurrency: 1 } }],
    'sub2api is told 1, not the 3 written to the config file');
  assert.equal(cfg.forward.max_concurrency, 3, 'the configured ceiling is still recorded');
});

test('a failed sub2api concurrency sync does not fail the save', async (t) => {
  const dir = tmp(t, 'mira-local-sync-fail-'); const { origin } = await fakeRelay(t);
  const cfg = relayConfig(dir, origin);
  const ctx = b.newAccountCtx('main');
  ctx.sm = { accountId: 88, desired: 'on', async pause() { return true; }, async onProbe() {} };
  const original = { ...b.s2 };
  b.s2.updateAccount = async () => { throw Error('admin api down'); };
  t.after(() => Object.assign(b.s2, original));
  const { createPanel } = require('../lib/panel');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());

  const saved = await panel.call('settings', { max_concurrency: 2, kimi_max_concurrency: 1 });
  assert.equal(saved.saved, true, 'local config is authoritative for the gate');
  assert.equal(saved.sub2api_concurrency.applied, false);
  assert.match(saved.sub2api_concurrency.error, /admin api down/);
  assert.equal(JSON.parse(fs.readFileSync(cfg._config_path, 'utf8')).forward.max_concurrency, 2);
});
