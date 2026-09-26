'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { summarizeMembership } = require('../lib/membership');
const { summarizeLimits } = require('../lib/quota');
const keeper = require('../lib/window-keeper');
const b = require('../mirasim-bridge');
const { createCredential } = require('../lib/login');
const { createPanel } = require('../lib/panel');
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const close = (s) => new Promise(r => { s.close(r); s.closeAllConnections(); });
function quota(now = Date.now(), active = false) {
  return { ...summarizeLimits({ windows: ['5h', '7d'].map(name => ({ name, budget: 100, used: active ? 1 : 0,
    reset_at: Math.floor((active ? now + keeper.DURATIONS[name] : now - 60000) / 1000) })) }, now), stale: false };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-window-test-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG); cfg.backend = 'relay'; cfg._config_path = path.join(root, 'config.json');
  cfg.bridge_secret = 'test-bridge-key'; cfg.quota.sync_notes = false;
  const member = summarizeMembership({ id: 'test-account', plan: 'basic', plan_exp: Math.floor(Date.now() / 1000) + 86400 });
  cfg.window_keeper.model = 'claude-haiku-4-5'; cfg.window_keeper.state_id = keeper.initialize(cfg, member.account_ref); cfg.window_keeper.enabled = true;
  fs.writeFileSync(cfg._config_path, JSON.stringify(cfg));
  const ctx = { ...b.newAccountCtx('main'), membership: member, quota: quota() };
  return { root, cfg, ctx, read: () => keeper.readState(keeper.fileFor(cfg), cfg.window_keeper.state_id) };
}

test('membership expiry is plan_exp, never token exp; personal fields are not returned', () => {
  const now = Date.now();
  const raw = { id: 'user-secret', email: 'private@example.com', token: 'private-token', plan: 'plus', plan_exp: Math.floor(now / 1000) + 86400, exp: 1 };
  const s = summarizeMembership(raw, now);
  assert.equal(s.status, 'active'); assert.ok(!JSON.stringify(s).includes('private'));
  assert.notEqual(s.account_ref, raw.id);
  assert.equal(summarizeMembership({ plan: 'go', plan_exp: Math.floor(now / 1000) - 1 }, now).status, 'expired');
  assert.equal(summarizeMembership({ plan: 'free', plan_exp: null }, now).status, 'expiry_unknown');
  assert.equal(summarizeMembership({ plan: 'basic', plan_exp: 0 }, now).expires_at, null);
  assert.throws(() => summarizeMembership({ exp: 2000000000 }));
});

test('new profiles do not inherit an enabled keeper or its history identity', (t) => {
  const { cfg } = fixture(t), { profileConfig } = require('../scripts/account-login');
  const next = profileConfig(cfg, 'second', { 'public-base-url': 'http://mirasim-second:8787' });
  assert.equal(next.window_keeper.enabled, false); assert.equal(next.window_keeper.state_id, '');
  assert.equal(cfg.window_keeper.enabled, true);
});

test('release/install allowlists carry required membership and keeper modules', () => {
  const root = path.join(__dirname, '..');
  const docker = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  const install = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const bundle = fs.readFileSync(path.join(root, 'package.ps1'), 'utf8');
  for (const file of ['lib/membership.js', 'lib/window-keeper.js', 'lib/panel.js']) {
    assert.ok(docker.includes('!' + file)); assert.ok(install.includes(file)); assert.ok(bundle.includes(file));
  }
});

test('both expired windows coalesce, active zero-usage windows and exhausted weekly quotas do not trigger', (t) => {
  const { cfg, read } = fixture(t), state = read(), now = Date.now();
  assert.deepEqual(keeper.plan(state, quota(now), cfg.window_keeper, now).windows, ['5h', '7d']);
  const active = quota(now, true); active.windows.forEach(w => w.used = 0);
  assert.deepEqual(keeper.plan(state, active, cfg.window_keeper, now).windows, []);
  const blocked = quota(now); blocked.windows[1].exhausted = true; blocked.windows[1].reset_at = new Date(now + 3600000).toISOString();
  assert.equal(keeper.plan(state, blocked, cfg.window_keeper, now).reason, 'quota_exhausted');
  const moving = quota(now, true); moving.windows.forEach(w => { w.used = 0; state.observations[w.name] = { reset: Date.parse(w.reset_at) - 60000, at: now - 60000, used: 0 }; });
  assert.deepEqual(keeper.plan(state, moving, cfg.window_keeper, now).windows, ['5h', '7d']);
});

test('a successful request does not prove zero-usage moving windows started', (t) => {
  const { read } = fixture(t), state = read(), at = Date.now() - 1000;
  state.attempts.push({ at, model: 'test', windows: ['5h'], outcome: 'accepted' });
  const q = quota(Date.now(), true); q.windows[0].used = 0;
  keeper.verify(state, q, Date.now()); assert.equal(state.attempts[0].outcome, 'accepted');
  const later = at + 901000, moving = quota(later, true); moving.windows[0].used = 0;
  keeper.verify(state, moving, later); assert.equal(state.attempts[0].outcome, 'unverified');
});

test('dispatch is durable before sending; quota confirms start and restart cannot send again', async (t) => {
  const { cfg, ctx, read } = fixture(t); let sends = 0;
  const io = { quota: async () => quota(Date.now(), sends > 0), modelAllowed: async () => true, send: async () => {
    assert.equal(read().attempts.at(-1).outcome, 'dispatched'); sends++; return { ok: true, status: 200 };
  } };
  await keeper.tick(cfg, ctx, io);
  assert.equal(sends, 1); assert.equal(read().attempts[0].outcome, 'confirmed');
  await keeper.tick(cfg, { ...ctx, nextWindowCheckAt: 0 }, io);
  assert.equal(sends, 1);
});

test('missing/corrupt state and failed persistence stop inference', async (t) => {
  const { cfg, ctx, read } = fixture(t); let sends = 0;
  const io = { quota: async () => quota(), modelAllowed: async () => true, send: async () => { sends++; return { ok: true }; } };
  const rename = t.mock.method(fs, 'renameSync', () => { throw Error('disk full'); });
  await keeper.tick(cfg, ctx, io); rename.mock.restore();
  assert.equal(sends, 0); assert.equal(read().attempts.length, 0);
  fs.unlinkSync(keeper.fileFor(cfg));
  await keeper.tick(cfg, { ...ctx, nextWindowCheckAt: 0 }, io); assert.equal(sends, 0);
  assert.throws(() => keeper.initialize(cfg, ctx.membership.account_ref), /state_unreadable/);
});

test('paused and disabled accounts, concurrent workers and mid-check disable do not duplicate sends', async (t) => {
  const { cfg, ctx } = fixture(t); let sends = 0, release, started;
  const seen = new Promise(r => { started = r; }), gate = new Promise(r => { release = r; });
  const io = { quota: async () => quota(), modelAllowed: async () => true, send: async () => { sends++; started(); await gate; return { status: 0, ok: false }; } };
  await keeper.tick(cfg, { ...ctx, hold: true }, io); assert.equal(sends, 0);
  const first = keeper.tick(cfg, ctx, io); await seen;
  await keeper.tick(cfg, { ...ctx, windowKeeperBusy: false, nextWindowCheckAt: 0 }, io); assert.equal(sends, 1);
  release(); await first;
  assert.equal(keeper.summarize(cfg).attempts[0].outcome, 'ambiguous');
  const f = fixture(t); let cancelledSend = false;
  await keeper.tick(f.cfg, f.ctx, { quota: async () => { f.cfg.window_keeper = { ...f.cfg.window_keeper, enabled: false }; return quota(); },
    modelAllowed: async () => true, send: async () => { cancelledSend = true; } });
  assert.equal(cancelledSend, false);
});

test('rolling daily cap and short interval persist independently of process lifetime', (t) => {
  const { cfg, read } = fixture(t), state = read(), now = Date.now();
  state.attempts = Array.from({ length: 6 }, (_, i) => ({ at: now - (i + 1) * 3600000, windows: ['5h'], outcome: 'failed' }));
  assert.equal(keeper.plan(state, quota(now), cfg.window_keeper, now).reason, 'daily_cap');
  state.attempts = [{ at: now - 1000, windows: ['5h'], outcome: 'ambiguous' }];
  assert.equal(keeper.plan(state, quota(now), cfg.window_keeper, now).reason, 'minimum_interval');
});

test('fresh business traffic cancels a due-window send; an exhausted unrelated model does not block it', async (t) => {
  const { cfg, ctx } = fixture(t); let sent = false;
  await keeper.tick(cfg, ctx, { quota: async () => quota(Date.now(), true), modelAllowed: async () => true, send: async () => { sent = true; } });
  assert.equal(sent, false);
  const q = quota(); q.windows.push({ name: '7d_fable', model_scoped: true, exhausted: true, reset_at: new Date(Date.now() + 3600000).toISOString() });
  const state = { attempts: [], cooldowns: {}, observations: {} };
  assert.deepEqual(keeper.plan(state, q, cfg.window_keeper).windows, ['5h', '7d']);
  cfg.window_keeper.model = 'claude-fable-5'; assert.equal(keeper.plan(state, q, cfg.window_keeper).reason, 'quota_exhausted');
});

test('only 7d is requested when no 5h window is reported; identity change and stale lock fail closed', async (t) => {
  const { cfg, ctx, read } = fixture(t);
  const q = quota(); q.windows = q.windows.filter(w => w.name === '7d');
  assert.deepEqual(keeper.plan(read(), q, cfg.window_keeper).windows, ['7d']);
  ctx.membership.account_ref = 'b'.repeat(64); let sends = 0;
  const io = { quota: async () => q, modelAllowed: async () => true, send: async () => { sends++; } };
  await keeper.tick(cfg, ctx, io); assert.equal(sends, 0);
  const lock = keeper.fileFor(cfg) + '.lock'; fs.writeFileSync(lock, 'other');
  fs.utimesSync(lock, new Date(0), new Date(0));
  await keeper.tick(cfg, { ...ctx, nextWindowCheckAt: 0 }, io); assert.equal(sends, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other');
});

test('real bridge route sends exactly one hi with bounded tokens and keeps identity separate from membership display', async (t) => {
  const { cfg, ctx, root, read } = fixture(t); let messages = 0;
  const up = http.createServer(async (req, res) => {
    if (req.url === '/v1/device/session') return res.end('{"ticket":"test-ticket","expiresIn":600}');
    if (req.url === '/auth/me') return res.end(JSON.stringify({ id: 'test-account', plan: 'basic', plan_exp: Math.floor(Date.now() / 1000) + 86400, email: 'private@example.com' }));
    if (req.url === '/v1/limits') return res.end(JSON.stringify({ windows: quota(Date.now(), messages > 0).windows.map(w => ({ ...w, reset_at: Date.parse(w.reset_at) / 1000 })) }));
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"claude-haiku-4-5"}]}');
    if (req.url === '/v1/messages') {
      let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw);
      assert.equal(body.messages[0].content, 'hi'); assert.equal(body.max_tokens, 16);
      assert.equal(read().attempts.at(-1).outcome, 'dispatched'); messages++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of [{ type: 'message_start', message: { model: body.model, id: 'msg_test' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  cfg.relay.url = cfg.relay.auth_url = await listen(up); t.after(() => close(up));
  cfg.relay.setting_json = path.join(root, 'setting.json'); fs.writeFileSync(cfg.relay.setting_json, JSON.stringify(createCredential({ access: 'access-test', refresh: 'refresh-test' })));
  const bridge = b.createBridgeServer(cfg, ctx, cfg.bridge_secret, 2), base = await listen(bridge); t.after(() => close(bridge)); cfg.listen.port = Number(new URL(base).port);
  await b.refreshMembership(cfg, ctx, { force: true }); assert.equal(ctx.membership.status, 'active'); assert.ok(!JSON.stringify(ctx.membership).includes('private@example'));
  await b.runWindowKeeper(cfg, ctx); assert.equal(messages, 1); assert.equal(read().attempts[0].outcome, 'confirmed');
  const panel = createPanel(cfg, ctx); t.after(() => panel.close());
  const off = await panel.call('window-keeper', { enabled: false }); assert.equal(off.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(cfg._config_path)).window_keeper.state_id, cfg.window_keeper.state_id);
  const before = read().attempts.length;
  const enabled = await panel.call('window-keeper', { enabled: true, model: 'claude-haiku-4-5', windows: ['5h', '7d'], max_per_day: 6 });
  assert.equal(enabled.enabled, true); assert.equal(read().attempts.length, before);
  await assert.rejects(panel.call('window-keeper', { enabled: true, model: 'unavailable', windows: ['5h'], max_per_day: 6 }), /请选择/);
  await assert.rejects(panel.call('window-keeper', { enabled: true, max_per_day: 1000 }), /无效/);
});
