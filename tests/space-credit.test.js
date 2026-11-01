'use strict';
// Per-space credit. Mirasim keeps two ledgers and only one is visible in /v1/limits:
//   personal — /v1/limits (subject=usr_…), ignores ?space= and x-mirasim-space
//   space    — /v2/machines/<nodeId>/credit, no signing, access token only
// These tests pin the normalization, the route gate, and the fact that an unfunded
// space reports 0 rather than an error (that is Mirasim's honest answer for a
// machine that was attached but never funded).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const b = require('../mirasim-bridge');
const { summarizeCredit, summarizeNodes, isNodeId } = require('../lib/space-credit');
const { createCredential } = require('../lib/login');
const { createPanel } = require('../lib/panel');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });
function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Shape captured live from relay.mirasim.ai on 2026-10-31.
const FUNDED = { nodeId: 'space-316be', spaceKey: 'alloc_77f4ba7d0ac91f16', mode: 'space',
  balance: 1182, funded: 1250, used: 68, bonusPct: 0, capMode: 'none',
  me: { cap: null, used: 68, remaining: null, prefer: 'space', payer: 'space' },
  members: [{ userId: 'usr_x', email: 'a@b.c', name: 'sun', role: 'owner', cap: null, override: false, used: 68, contributed: 0, prefer: 'space' }],
  formerMembers: [], priorGenerations: [], can: { toggle: true, setCaps: true, transfer: true }, recent: [] };
const EMPTY = { nodeId: 'pc-58bc8744fccc63af7bf4', spaceKey: 'pc-58bc8744fccc63af7bf4', mode: 'space',
  balance: 0, funded: 0, used: 0, bonusPct: 0, capMode: 'none',
  me: { cap: null, used: 0, remaining: null, prefer: 'space', payer: 'personal', reason: 'space_empty' },
  members: [], formerMembers: [], priorGenerations: [], can: { toggle: true, setCaps: true, transfer: true }, recent: [] };
const SEATS = { total: 0, assigned: 0, idle: 0,
  spaces: [
    { nodeId: 'space-316be', spaceKey: 'alloc_77f4ba7d0ac91f16', name: 'space-316be', kind: 'managed', owner: true, mine: 0, seats: { used: 0, limit: 3, base: 3, extra: 0 } },
    { nodeId: 'pc-e084757168ba43fb1aac', spaceKey: 'pc-e084757168ba43fb1aac', name: 'DESKTOP', kind: 'attached', owner: true, mine: 0, seats: { used: 0, limit: 5, base: 5, extra: 0 } },
  ] };

test('node ids accept the shapes the API emits and reject everything else', () => {
  for (const id of ['space-316be', 'pc-58bc8744fccc63af7bf4', 'alloc_77f4ba7d0ac91f16']) assert.ok(isNodeId(id), id);
  for (const id of ['../../etc/passwd', 'space/../x', '', 'pc-', 'nope-123', null, 42, 'space-316be/../x', ' space-316be']) {
    assert.equal(isNodeId(id), false, String(id));
  }
});

test('a funded space reports its balance and is distinguishable from an empty one', () => {
  const funded = summarizeCredit(FUNDED);
  assert.equal(funded.node_id, 'space-316be');
  assert.equal(funded.space_key, 'alloc_77f4ba7d0ac91f16');
  assert.equal(funded.balance, 1182);
  assert.equal(funded.funded, 1250);
  assert.equal(funded.used, 68);
  assert.equal(funded.payer, 'space');
  assert.equal(funded.space_funded, true, 'a space-held balance is what callers branch on');
  assert.equal(funded.members[0].role, 'owner');

  const empty = summarizeCredit(EMPTY);
  assert.equal(empty.balance, 0);
  assert.equal(empty.payer, 'personal');
  assert.equal(empty.space_funded, false);
  assert.equal(empty.empty_reason, 'space_empty', 'Mirasim names the reason; it is not an error');
});

test('credit normalization drops unknown fields instead of inventing values', () => {
  const minimal = summarizeCredit({ nodeId: 'space-abc', balance: '1200', funded: null });
  // A string balance is not a number Mirasim sent; it is dropped rather than coerced.
  assert.equal(minimal.balance, null);
  assert.equal(minimal.funded, null);
  assert.equal(minimal.payer, null);
  assert.equal(minimal.space_funded, false, 'no payer means the space pool was not proven');
  assert.deepEqual(minimal.members, []);
  assert.throws(() => summarizeCredit({ balance: 1 }), /Invalid Mirasim credit/);
  assert.throws(() => summarizeCredit(null), /Invalid Mirasim credit/);
  assert.throws(() => summarizeCredit({ nodeId: '../../etc/passwd' }), /Invalid Mirasim credit/);
});

test('seat listing keeps only well-formed nodes', () => {
  const rows = summarizeNodes(SEATS);
  assert.deepEqual(rows.map((r) => r.node_id), ['space-316be', 'pc-e084757168ba43fb1aac']);
  assert.equal(rows[0].kind, 'managed');
  assert.deepEqual(rows[0].seats, { used: 0, limit: 3, base: 3, extra: 0 });
  assert.deepEqual(summarizeNodes({ spaces: [{ nodeId: '../x' }, null, { nodeId: 'space-ok' }] }).map((r) => r.node_id), ['space-ok']);
  assert.deepEqual(summarizeNodes(null), []);
  assert.deepEqual(summarizeNodes({ spaces: 'nope' }), []);
});

/** Relay stub answering only the /v2 credit routes. */
async function creditRelay(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    seen.push({ url: req.url, headers: req.headers });
    // /v2 uses the access token directly; ensureAccess() may still refresh first.
    if (req.url === '/auth/refresh') return res.end(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }));
    if (req.url === '/v1/device/session') return res.end('{"ticket":"ticket","expiresIn":600}');
    if (req.url === '/v2/machines/member-seats') return res.end(JSON.stringify(SEATS));
    if (req.url === '/v2/machines') return res.end(JSON.stringify({ machines: [{ nodeId: 'space-316be', name: 'space-316be', platform: 'linux', online: true, appVersion: '0.0.724', v2: { cert: 'opaque' } }] }));
    const m = req.url.match(/^\/v2\/machines\/([^/]+)\/credit$/);
    if (m) {
      if (m[1] === 'space-316be') return res.end(JSON.stringify(FUNDED));
      if (m[1] === 'pc-58bc8744fccc63af7bf4') return res.end(JSON.stringify(EMPTY));
      res.writeHead(404); return res.end('{"error":"not found"}');
    }
    res.writeHead(404); res.end('{}');
  });
  const origin = `http://127.0.0.1:${await listen(server)}`; t.after(() => close(server));
  return { origin, seen };
}

function relayCfg(dir, origin) {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  Object.assign(cfg, { backend: 'relay', bridge_secret: 'secret', _config_path: path.join(dir, 'config.json') });
  cfg.relay = { ...cfg.relay, url: origin, auth_url: origin, setting_json: 'setting.json' };
  cfg.quota.enabled = false; cfg.membership.enabled = false; cfg.keepalive.enabled = false;
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(createCredential({ access: 'access', refresh: 'refresh' })));
  return cfg;
}

test('the bridge serves space credit behind bridge_secret, without signing it', async (t) => {
  const dir = tmp(t, 'mira-space-'); const { origin, seen } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));
  const get = (p, key = 'secret') => fetch(base + p, { headers: { 'x-api-key': key } });

  assert.equal((await get('/v2/machines/member-seats', 'wrong')).status, 503, 'no secret, no credit');

  const seats = await get('/v2/machines/member-seats');
  assert.equal(seats.status, 200);
  const seatBody = await seats.json();
  assert.deepEqual(seatBody.spaces.map((s) => s.node_id), ['space-316be', 'pc-e084757168ba43fb1aac']);
  assert.match(seatBody.source, /member-seats/);

  const credit = await get('/v2/machines/space-316be/credit');
  assert.equal(credit.status, 200);
  assert.equal(credit.headers.get('cache-control'), 'no-store');
  const body = await credit.json();
  assert.equal(body.credit.balance, 1182);
  assert.equal(body.credit.space_funded, true);

  const empty = await (await get('/v2/machines/pc-58bc8744fccc63af7bf4/credit')).json();
  assert.equal(empty.credit.balance, 0);
  assert.equal(empty.credit.space_funded, false);

  // /v2 takes the access token directly. The signature header is harmless (the relay
  // accepts but does not require it), but the sealed envelope must NOT be sent: the
  // relay reads /v2 as plain JSON and an x-mirasim-enc body would be unreadable.
  const creditCalls = seen.filter((s) => s.url.includes('/credit'));
  assert.ok(creditCalls.length, 'the proxy reached the relay');
  for (const call of creditCalls) {
    assert.equal(call.headers['x-mirasim-enc'], undefined, 'space credit is never sealed');
    assert.match(String(call.headers.authorization || ''), /^Bearer /, 'access token authenticates /v2');
  }
});

test('an unknown node is a 404 from upstream, and path traversal never reaches it', async (t) => {
  const dir = tmp(t, 'mira-space-404-'); const { origin, seen } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));

  const missing = await fetch(base + '/v2/machines/space-no-such/credit', { headers: { 'x-api-key': 'secret' } });
  assert.equal(missing.status, 404, 'upstream 404 passes through unchanged');

  const before = seen.length;
  for (const bad of ['/v2/machines/../../etc/passwd/credit', '/v2/machines/a%2F..%2Fb/credit', '/v2/machines/space-316be/credit/extra']) {
    const r = await fetch(base + bad, { headers: { 'x-api-key': 'secret' } });
    assert.notEqual(r.status, 200, bad + ' must not be proxied');
  }
  assert.equal(seen.length, before, 'nothing reached the relay for a rejected path');
});

test('POST to a space credit route is refused', async (t) => {
  const dir = tmp(t, 'mira-space-post-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));
  const r = await fetch(base + '/v2/machines/space-316be/credit', { method: 'POST', headers: { 'x-api-key': 'secret', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400);
});

test('panel exposes space credit per account', async (t) => {
  const dir = tmp(t, 'mira-space-panel-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());

  const spaces = await panel.call('space-credit', {});
  assert.deepEqual(spaces.spaces.map((s) => s.node_id), ['space-316be', 'pc-e084757168ba43fb1aac']);

  const one = await panel.call('space-credit', { node: 'space-316be' });
  assert.equal(one.credit.balance, 1182);

  await assert.rejects(panel.call('space-credit', { node: '../etc/passwd' }), /节点|无效/);
});

test('the space-backend panel card reports config and connection state without spending credit', async (t) => {
  const dir = tmp(t, 'mira-space-backend-'); const { origin, seen } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  cfg.backend = 'space';
  cfg.space = { ...cfg.space, node_id: 'space-316be' };
  const ctx = b.newAccountCtx('main');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());

  const before = seen.length;
  const out = await panel.call('space-backend', {});
  assert.equal(out.backend, 'space');
  assert.equal(out.enabled, true);
  assert.equal(out.node_id, 'space-316be');
  assert.equal(out.connected, false, 'nothing is connected until the console asks');
  assert.equal(out.last_turn, null);
  assert.equal(seen.length, before, 'the default read must not touch the relay at all');
});

test('the space-backend card is inert on any other backend', async (t) => {
  const dir = tmp(t, 'mira-space-backend-off-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);   // backend: relay
  const panel = createPanel(cfg, b.newAccountCtx('main')); t.after(() => panel.close());
  const out = await panel.call('space-backend', {});
  assert.equal(out.enabled, false);
  assert.equal(out.backend, 'relay');
});

test('the space-backend card is inert on any other backend', async (t) => {
  const dir = tmp(t, 'mira-space-backend-off-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);   // backend: relay
  const panel = createPanel(cfg, b.newAccountCtx('main')); t.after(() => panel.close());
  const out = await panel.call('space-backend', {});
  assert.equal(out.enabled, false);
  assert.equal(out.backend, 'relay');
});

test('/v2 requests carry only the access token, like the official client', async (t) => {
  // server-main.cjs ugn(): authorization + content-type, nothing else. An extra
  // x-mirasim-* header is data the official client never sends.
  const dir = tmp(t, 'mira-space-headers-'); const { origin, seen } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));
  await (await fetch(base + '/v2/machines/space-316be/credit', { headers: { 'x-api-key': 'secret' } })).text();
  const call = seen.filter((s) => s.url === '/v2/machines/space-316be/credit').pop();
  assert.ok(call, 'reached the relay');
  const mirasimHeaders = Object.keys(call.headers).filter((k) => k.startsWith('x-mirasim-'));
  assert.deepEqual(mirasimHeaders, [], 'no x-mirasim-* headers on /v2');
  assert.match(String(call.headers.authorization), /^Bearer /);
});

test('only mode and prefer may be written, and only with explicit confirmation', async (t) => {
  const dir = tmp(t, 'mira-space-pool-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));
  const put = (p, body) => fetch(base + p, { method: 'PUT', headers: { 'x-api-key': 'secret', 'content-type': 'application/json' }, body });

  // The relay client refuses every other /v2 write, keeping transfers unexposed.
  const { RelayClient } = require('../lib/relay');
  const relay = b.getRelay(cfg);
  await assert.rejects(relay.request({ path: '/v2/machines/space-316be/credit/transfers', method: 'PUT', body: Buffer.from('{}') }),
    /Unsupported direct relay route/);
  await assert.rejects(relay.request({ path: '/v2/machines/space-316be/credit/caps', method: 'PUT', body: Buffer.from('{}') }),
    /Unsupported direct relay route/);

  // setSpacePool validates before it ever reaches the network.
  await assert.rejects(b.setSpacePool(cfg, '../etc/passwd', { mode: 'space' }), /节点 ID 无效/);
  await assert.rejects(b.setSpacePool(cfg, 'space-316be', { mode: 'free' }), /mode 只能是/);
  await assert.rejects(b.setSpacePool(cfg, 'space-316be', {}), /需要 mode 或 prefer/);
});

test('panel requires confirm before switching the paying pool', async (t) => {
  const dir = tmp(t, 'mira-space-confirm-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  await assert.rejects(panel.call('space-pool', { node: 'space-316be', mode: 'space' }), /显式确认/);
  await assert.rejects(panel.call('space-pool', { node: '../x', mode: 'space', confirm: true }), /节点 ID 无效/);
  await assert.rejects(panel.call('space-pool', { node: 'space-316be', mode: 'nope', confirm: true }), /mode/);
});

test('listing spaces includes each node balance, and one failure does not hide the list', async (t) => {
  const dir = tmp(t, 'mira-space-list-');
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/auth/refresh') return res.end(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }));
    if (req.url === '/v1/device/session') return res.end('{"ticket":"t","expiresIn":600}');
    if (req.url === '/v2/machines/member-seats') return res.end(JSON.stringify(SEATS));
    if (req.url === '/v2/machines/space-316be/credit') return res.end(JSON.stringify(FUNDED));
    res.writeHead(500); res.end('{"error":"boom"}');   // the other node fails
  });
  const origin = `http://127.0.0.1:${await listen(server)}`; t.after(() => close(server));
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  const out = await panel.call('space-credit', {});
  assert.equal(out.spaces.length, 2, 'both nodes are listed');
  const byId = Object.fromEntries(out.spaces.map((s) => [s.node_id, s.credit]));
  assert.equal(byId['space-316be'].balance, 1182);
  assert.equal(byId['space-316be'].space_funded, true);
  assert.equal(byId['pc-e084757168ba43fb1aac'].balance, null, 'the failing node reports null, not a fake 0');
  assert.match(byId['pc-e084757168ba43fb1aac'].error, /500/);
});

test('/v2 requests carry only the access token, like the official client', async (t) => {
  // server-main.cjs ugn(): authorization + content-type, nothing else. An extra
  // x-mirasim-* header is data the official client never sends.
  const dir = tmp(t, 'mira-space-headers-'); const { origin, seen } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));
  await (await fetch(base + '/v2/machines/space-316be/credit', { headers: { 'x-api-key': 'secret' } })).text();
  const call = seen.filter((s) => s.url === '/v2/machines/space-316be/credit').pop();
  assert.ok(call, 'reached the relay');
  const mirasimHeaders = Object.keys(call.headers).filter((k) => k.startsWith('x-mirasim-'));
  assert.deepEqual(mirasimHeaders, [], 'no x-mirasim-* headers on /v2');
  assert.match(String(call.headers.authorization), /^Bearer /);
});

test('only mode and prefer may be written, and only with explicit confirmation', async (t) => {
  const dir = tmp(t, 'mira-space-pool-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const server = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = `http://127.0.0.1:${await listen(server)}`;
  t.after(() => close(server));
  const put = (p, body) => fetch(base + p, { method: 'PUT', headers: { 'x-api-key': 'secret', 'content-type': 'application/json' }, body });

  // The relay client refuses every other /v2 write, keeping transfers unexposed.
  const { RelayClient } = require('../lib/relay');
  const relay = b.getRelay(cfg);
  await assert.rejects(relay.request({ path: '/v2/machines/space-316be/credit/transfers', method: 'PUT', body: Buffer.from('{}') }),
    /Unsupported direct relay route/);
  await assert.rejects(relay.request({ path: '/v2/machines/space-316be/credit/caps', method: 'PUT', body: Buffer.from('{}') }),
    /Unsupported direct relay route/);

  // setSpacePool validates before it ever reaches the network.
  await assert.rejects(b.setSpacePool(cfg, '../etc/passwd', { mode: 'space' }), /节点 ID 无效/);
  await assert.rejects(b.setSpacePool(cfg, 'space-316be', { mode: 'free' }), /mode 只能是/);
  await assert.rejects(b.setSpacePool(cfg, 'space-316be', {}), /需要 mode 或 prefer/);
});

test('panel requires confirm before switching the paying pool', async (t) => {
  const dir = tmp(t, 'mira-space-confirm-'); const { origin } = await creditRelay(t);
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  await assert.rejects(panel.call('space-pool', { node: 'space-316be', mode: 'space' }), /显式确认/);
  await assert.rejects(panel.call('space-pool', { node: '../x', mode: 'space', confirm: true }), /节点 ID 无效/);
  await assert.rejects(panel.call('space-pool', { node: 'space-316be', mode: 'nope', confirm: true }), /mode/);
});

test('listing spaces includes each node balance, and one failure does not hide the list', async (t) => {
  const dir = tmp(t, 'mira-space-list-');
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/auth/refresh') return res.end(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }));
    if (req.url === '/v1/device/session') return res.end('{"ticket":"t","expiresIn":600}');
    if (req.url === '/v2/machines/member-seats') return res.end(JSON.stringify(SEATS));
    if (req.url === '/v2/machines/space-316be/credit') return res.end(JSON.stringify(FUNDED));
    res.writeHead(500); res.end('{"error":"boom"}');   // the other node fails
  });
  const origin = `http://127.0.0.1:${await listen(server)}`; t.after(() => close(server));
  const cfg = relayCfg(dir, origin);
  const ctx = b.newAccountCtx('main');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  const out = await panel.call('space-credit', {});
  assert.equal(out.spaces.length, 2, 'both nodes are listed');
  const byId = Object.fromEntries(out.spaces.map((s) => [s.node_id, s.credit]));
  assert.equal(byId['space-316be'].balance, 1182);
  assert.equal(byId['space-316be'].space_funded, true);
  assert.equal(byId['pc-e084757168ba43fb1aac'].balance, null, 'the failing node reports null, not a fake 0');
  assert.match(byId['pc-e084757168ba43fb1aac'].error, /500/);
});

