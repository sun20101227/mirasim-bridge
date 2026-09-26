'use strict';
// Start idle quota windows, never reset/extend provider limits. Observations are
// not evidence of inference success; requests and window confirmation are separate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DURATIONS = { '5h': 5 * 3600000, '7d': 7 * 86400000 };
const DEFAULTS = { enabled: false, model: '', windows: ['5h', '7d'], max_per_day: 6, state_id: '' };
const ms = (s) => typeof s === 'string' ? Date.parse(s) : NaN;
const fileFor = (cfg) => path.join(path.dirname(path.resolve(cfg._config_path || 'config.json')), 'window-keeper.json');

function validateConfig(c) {
  if (!c || typeof c.enabled !== 'boolean' || typeof c.model !== 'string'
      || (c.model && !/^[\w./-]{1,180}$/.test(c.model))
      || !Array.isArray(c.windows) || !c.windows.length || new Set(c.windows).size !== c.windows.length
      || c.windows.some((w) => !DURATIONS[w]) || !Number.isInteger(c.max_per_day) || c.max_per_day < 1 || c.max_per_day > 8
      || typeof c.state_id !== 'string' || (c.state_id && !/^[a-f0-9]{32}$/.test(c.state_id))
      || (c.enabled && (!c.model || !c.state_id))) throw Error('窗口任务配置无效；启用前请在网页选择模型并初始化记录');
}
function writeState(file, state) {
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    if (process.platform !== 'win32') { const fd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function readState(file, id, identity) {
  let s;
  try { if (fs.statSync(file).size > 256 * 1024) throw Error(); s = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw Error('state_unreadable'); }
  if (s?.schema !== 1 || !/^[a-f0-9]{32}$/.test(s.id || '') || (id && s.id !== id)
      || !/^[a-f0-9]{64}$/.test(s.identity || '') || (identity && s.identity !== identity)
      || !Array.isArray(s.attempts) || s.attempts.length > 64 || !s.observations || typeof s.observations !== 'object' || Array.isArray(s.observations)
      || !s.cooldowns || typeof s.cooldowns !== 'object' || Array.isArray(s.cooldowns)
      || Object.entries(s.observations).some(([k, v]) => !DURATIONS[k] || !v || !Number.isFinite(v.at) || (v.reset !== null && !Number.isFinite(v.reset)))
      || s.attempts.some((a) => !Number.isFinite(a.at) || a.at <= 0 || !Array.isArray(a.windows) || !a.windows.length
        || a.windows.some((w) => !DURATIONS[w]) || !['dispatched', 'accepted', 'confirmed', 'ambiguous', 'failed', 'unverified'].includes(a.outcome))
      || Object.values(s.cooldowns).some((v) => !Number.isFinite(v) || v < 0)) throw Error('state_invalid');
  return s;
}
function initialize(cfg, identity) {
  if (!/^[a-f0-9]{64}$/.test(identity || '')) throw Error('会员身份尚未确认，暂不能开启自动窗口');
  const file = fileFor(cfg);
  if (cfg.window_keeper.state_id) return readState(file, cfg.window_keeper.state_id, identity).id;
  if (fs.existsSync(file)) return readState(file, null, identity).id; // failed config save must not erase dispatch history
  const state = { schema: 1, id: crypto.randomBytes(16).toString('hex'), identity, attempts: [], observations: {}, cooldowns: {} };
  fs.writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  return state.id;
}
function snapshotWindows(q) { return (q?.windows || []).filter((w) => DURATIONS[w.name] && !w.model_scoped); }
function observe(state, quota) {
  for (const w of snapshotWindows(quota)) state.observations[w.name] = { reset: ms(w.reset_at) || null, at: ms(quota.observed_at), used: w.used };
}
function plan(state, quota, config, now = Date.now()) {
  const skip = (reason) => ({ reason, windows: [] });
  if (!quota?.available || quota.stale || !Number.isFinite(ms(quota.observed_at)) || now - ms(quota.observed_at) > 360000) return skip('quota_unknown');
  if (quota.unmetered) return skip('unmetered');
  if (quota.suspended || quota.degraded) return skip('account_restricted');
  const relevant = (quota.windows || []).filter((w) => !w.model_scoped
    || (w.name === '7d_claude' && config.model.startsWith('claude-'))
    || (w.name === '7d_fable' && config.model.includes('fable')));
  if (relevant.some((w) => w.exhausted && (!Number.isFinite(ms(w.reset_at)) || ms(w.reset_at) > now))) return skip('quota_exhausted');
  const attempts = state.attempts;
  if (attempts.filter((a) => a.at > now - 86400000).length >= config.max_per_day) return skip('daily_cap');
  if (attempts.some((a) => now - a.at < 300000)) return skip('minimum_interval');
  const due = [];
  for (const name of config.windows) {
    const w = snapshotWindows(quota).find((w) => w.name === name);
    if (!w || !(w.budget > 0) || w.used === null || w.used < 0) continue;
    if ((state.cooldowns[name] || 0) > now) continue;
    const reset = ms(w.reset_at), prior = state.observations[name];
    if (Number.isFinite(reset) && reset <= now - 30000) due.push(name);
    else if (w.used === 0 && Number.isFinite(reset) && prior && Number.isFinite(prior.reset)
      && ms(quota.observed_at) - prior.at >= 30000 && reset - prior.reset > 20000
      && Math.abs(reset - (now + DURATIONS[name])) < 180000) due.push(name);
    // A future, fixed reset with zero displayed usage is already a running
    // window. Never create an idle window solely from the polling clock.
  }
  return { reason: due.length ? 'window_due' : 'waiting_for_window', windows: due };
}
function verify(state, quota, now) {
  if (!quota?.available || quota.stale) return;
  for (const attempt of state.attempts.filter((a) => ['dispatched', 'accepted', 'ambiguous'].includes(a.outcome))) {
    if (ms(quota.observed_at) < attempt.at) continue;
    const started = attempt.windows.filter((name) => {
      const w = snapshotWindows(quota).find((v) => v.name === name), reset = ms(w?.reset_at);
      return w && reset > now && (w.used > 0 || (now - attempt.at >= 900000 && Math.abs(reset - (attempt.at + DURATIONS[name])) <= 120000));
    });
    if (started.length === attempt.windows.length) {
      attempt.outcome = 'confirmed'; attempt.verified_at = now;
      for (const name of started) state.cooldowns[name] = ms(snapshotWindows(quota).find((w) => w.name === name).reset_at) + 30000;
    } else if (now - attempt.at >= 900000) {
      attempt.outcome = 'unverified'; attempt.verified_at = now;
      // No evidence => wait a whole requested window, not a request every poll.
    }
  }
}
function publicState(cfg, runtime = {}) {
  const c = cfg.window_keeper;
  const settings = { enabled: c.enabled, model: c.model, windows: c.windows, max_per_day: c.max_per_day };
  if (!c.state_id) return { ...settings, reason: 'disabled', attempts: [] };
  try { const s = readState(fileFor(cfg), c.state_id); return { ...settings, reason: !c.enabled ? 'disabled' : runtime.reason || 'waiting_for_window',
    next_check_at: runtime.next_check_at || null, attempts: s.attempts.slice(-8).reverse(),
    sent_last_24h: s.attempts.filter((a) => a.at > Date.now() - 86400000).length }; }
  catch { return { ...settings, reason: 'state_unreadable', attempts: [] }; }
}

async function tick(cfg, ctx, io, now = Date.now()) {
  const c = cfg.window_keeper;
  const setReason = (reason) => { ctx.windowKeeperStatus = { reason, next_check_at: new Date(now + 60000).toISOString() }; return ctx.windowKeeperStatus; };
  if (!c.enabled) return setReason('disabled');
  if (ctx.windowKeeperBusy || now < (ctx.nextWindowCheckAt || 0)) return ctx.windowKeeperStatus;
  ctx.windowKeeperBusy = true; ctx.nextWindowCheckAt = now + 60000;
  const file = fileFor(cfg), lock = file + '.lock', owner = crypto.randomBytes(16).toString('hex');
  let locked = false;
  const eligible = () => cfg.window_keeper === c && c.enabled && !ctx.shuttingDown && !ctx.hold && !ctx.inflight && Date.now() >= (ctx.backoffUntil || 0)
    && (!ctx.sm || ctx.sm.desired === 'on')
    && (!ctx.membership?.expires_at || ms(ctx.membership.expires_at) > Date.now());
  try {
    if (!eligible()) return setReason('account_busy_or_paused');
    const member = ctx.membership;
    if (!member?.available || member.stale || !member.account_ref
      || (member.expires_at && ms(member.expires_at) <= now)) return setReason('membership_unavailable');
    try { fs.writeFileSync(lock, owner, { flag: 'wx', mode: 0o600 }); locked = true; }
    catch (err) {
      if (err.code !== 'EEXIST') throw Error('state_unreadable');
      // Never remove another worker's lock while it may still write the journal.
      // A stale lock requires an explicit recovery after confirming no request is running.
      return setReason(Date.now() - fs.statSync(lock).mtimeMs > 180000 ? 'stale_lock' : 'another_worker');
    }
    const state = readState(file, c.state_id, member.account_ref);
    verify(state, ctx.quota, now);
    const initial = plan(state, ctx.quota, c, now);
    if (!initial.windows.length) { observe(state, ctx.quota); writeState(file, state); return setReason(initial.reason); }
    const fresh = await io.quota();
    verify(state, fresh, now);
    const decision = plan(state, fresh, c, now);
    observe(state, fresh);
    if (!decision.windows.length || !eligible()) { writeState(file, state); return setReason(decision.reason); }
    if (!await io.modelAllowed(c.model) || !eligible()) { writeState(file, state); return setReason('model_unavailable'); }
    const attempt = { at: Date.now(), model: c.model, windows: decision.windows, outcome: 'dispatched' };
    state.attempts = state.attempts.filter((a) => a.at > now - 8 * 86400000).slice(-63);
    state.attempts.push(attempt);
    for (const name of decision.windows) state.cooldowns[name] = attempt.at + DURATIONS[name] + 30000;
    writeState(file, state); // durable reservation BEFORE any inference
    let result;
    try { result = await io.send(c.model); } catch { result = { ok: false, status: 0 }; }
    attempt.outcome = result.ok ? 'accepted' : result.status >= 400 && result.status < 600 ? 'failed' : 'ambiguous';
    attempt.http_status = result.status || 0;
    if (attempt.outcome === 'failed') {
      const count = state.attempts.filter((a) => a.outcome === 'failed').length;
      for (const name of attempt.windows) state.cooldowns[name] = attempt.at + Math.min(7200000, 600000 * 2 ** Math.min(4, count - 1));
    }
    writeState(file, state);
    try { const after = await io.quota(); verify(state, after, Date.now()); observe(state, after); writeState(file, state); } catch { /* leave accepted/ambiguous for next observation */ }
    return setReason(attempt.outcome);
  } catch { return setReason('state_or_probe_error'); }
  finally {
    if (locked) try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock); } catch {}
    ctx.windowKeeperBusy = false;
  }
}

module.exports = { DEFAULTS, DURATIONS, validateConfig, summarize: publicState, initialize, readState, fileFor, plan, verify, tick };
