'use strict';
// Privileged operations require a volume-only key, separate from inference keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { startLogin, startEmailLogin, createCredential, importCredential, profileDirectory, listProfiles } = require('./login');
const { request, readText } = require('./relay');
const windowKeeper = require('./window-keeper');
const { storeFor: usageStoreFor } = require('./usage');

const rootOf = (cfg) => path.dirname(path.resolve(cfg._config_path || process.env.MIRASIM_CONFIG || 'config.json'));
const denied = (message) => Object.assign(Error(message), { publicMessage: message });
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const ASSETS = {
  '/panel': ['index.html', 'text/html; charset=utf-8'], '/panel/': ['index.html', 'text/html; charset=utf-8'],
  '/panel/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/panel/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/panel/tokens.css': ['tokens.css', 'text/css; charset=utf-8'], '/panel/modal.js': ['modal.js', 'text/javascript; charset=utf-8'],
  '/panel/undo.js': ['undo.js', 'text/javascript; charset=utf-8'], '/panel/icon.png': ['icon.png', 'image/png'] };
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
// Parsed asset bytes, keyed by absolute path. Panel polling hits the same handful of
// files every few seconds; stat-gate the cache so 140 KB of JS/CSS is never re-read or
// re-gzipped unless the file actually changed.
const assetCache = new Map();
const missingAssets = new Set();
function warnOnce(message) {
  if (missingAssets.has(message)) return;
  missingAssets.add(message);
  process.stdout.write(`[panel] WARN ${message}\n`);
}
function loadAsset(full) {
  const st = fs.statSync(full);
  const hit = assetCache.get(full);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = fs.readFileSync(full);
  const entry = { mtimeMs: st.mtimeMs, size: st.size,
    etag: '"' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32) + '"',
    raw, gzip: null };
  assetCache.set(full, entry);
  return entry;
}
function acceptsGzip(header) {
  if (typeof header !== 'string') return false;
  let explicit = null, wildcard = null;
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    if (Number.isNaN(q)) continue;
    if (token === 'gzip') explicit = q;
    else if (token === '*' && wildcard === null) wildcard = q;
  }
  // RFC 9110: an explicit gzip entry wins over the * wildcard.
  return (explicit === null ? wildcard ?? 0 : explicit) > 0;
}
function matchesEtag(header, etag) {
  if (typeof header !== 'string') return false;
  return header.split(',').some((value) => {
    const candidate = value.trim();
    if (candidate === '*') return true;
    return (candidate.startsWith('W/') ? candidate.slice(2) : candidate) === etag;
  });
}
function page(res, route = '/panel', req = res && res.req) {
  const asset = ASSETS[route];
  if (!asset) { res.writeHead(404); return res.end(); }
  const full = path.join(__dirname, '../web', asset[0]);
  if (asset[0] === 'index.html') {
    // The shell names the asset URLs; it must never be cached or the page keeps loading old files.
    let raw;
    try { raw = fs.readFileSync(full); }
    catch { warnOnce(`panel asset missing: web/${asset[0]}`); res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', 'content-length': raw.length, ...SECURITY_HEADERS });
    return res.end(raw);
  }
  let entry;
  try { entry = loadAsset(full); }
  catch { warnOnce(`panel asset missing: web/${asset[0]}`); res.writeHead(404); return res.end(); }
  // Text assets are compressed for clients that accept it, so the response varies on that header.
  const compressible = /^text\//.test(asset[1]);
  const headers = { 'cache-control': 'no-cache', etag: entry.etag, ...(compressible ? { vary: 'accept-encoding' } : {}), ...SECURITY_HEADERS };
  if (matchesEtag(req && req.headers && req.headers['if-none-match'], entry.etag)) { res.writeHead(304, headers); return res.end(); }
  let body = entry.raw;
  if (compressible && req && acceptsGzip(req.headers && req.headers['accept-encoding'])) {
    if (entry.gzip === null) {
      const packed = zlib.gzipSync(entry.raw, { level: 6 });
      entry.gzip = packed.length < entry.raw.length ? packed : false;
    }
    if (entry.gzip) { headers['content-encoding'] = 'gzip'; body = entry.gzip; }
  }
  res.writeHead(200, { 'content-type': asset[1], 'content-length': body.length, ...headers });
  res.end(body);
}
function authorized(cfg, key) {
  try {
    const expected = fs.readFileSync(path.join(rootOf(cfg), '.panel-key'), 'utf8').trim();
    return typeof key === 'string' && /^[a-f0-9]{64}$/.test(expected) && key.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  } catch { return false; }
}
function ensurePanelKey(cfg) {
  const file = path.join(rootOf(cfg), '.panel-key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, key + '\n', { flag: 'wx', mode: 0o600 });
    return key;
  }
}
function atomicConfig(file, cfg) {
  const value = { ...cfg }; delete value._config_path;
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
async function catalogIds(b, cfg) {
  const response = await b.getRelay(cfg).request({ path: '/v1/models', signal: AbortSignal.timeout(15000) });
  const parsed = JSON.parse(await readText(response));
  if (response.statusCode !== 200) throw denied('上游模型目录暂不可用');
  let rows;
  try { rows = b.catalogRows(parsed); } catch { throw denied('上游模型目录格式无法识别'); }
  return [...new Set(rows.map((m) => typeof m === 'string' ? m : m.id).filter((id) => typeof id === 'string' && id.length <= 256))];
}

/**
 * /v1/models is refused (HTTP 429 credit_exhausted_shared) whenever the account's
 * shared pool is spent, while /v1/model-roster keeps answering. Try the live
 * catalog first; fall back to the roster's routed ids so the model page keeps
 * working during quota exhaustion instead of failing outright.
 * The roster is TTL-cached, so opening the page costs at most one extra request
 * per 10 minutes, and it also carries effort/context/pricing facts per model.
 */
async function catalogRowsFor(b, acct) {
  const fetchRoster = typeof b.fetchRoster === 'function' ? b.fetchRoster : null;
  const cachedRoster = () => (fetchRoster ? fetchRoster(acct.cfg, acct.ctx || {}).catch(() => acct.ctx?.roster || null) : acct.ctx?.roster || null);
  // Run both: the catalog is authoritative for what exists, the roster says which
  // of those ids are routable and what effort/context each accepts. The roster is
  // TTL-cached, so this normally costs no extra relay request.
  const [roster, catalog] = await Promise.allSettled([cachedRoster(), catalogIds(b, acct.cfg)]);
  if (catalog.status === 'fulfilled') {
    return { ids: catalog.value, source: 'models', roster: roster.status === 'fulfilled' ? roster.value : null };
  }
  const fresh = fetchRoster ? await fetchRoster(acct.cfg, acct.ctx || {}, { force: true }).catch(() => null) : null;
  const ids = fresh && b.rosterIds ? b.rosterIds(fresh) : [];
  if (!ids.length) throw catalog.reason;
  return { ids, source: 'roster', roster: fresh };
}
function createPanel(cfg, ctx, deps = {}) {
  const b = deps.bridge || require('../mirasim-bridge');
  const beginLogin = deps.startLogin || startLogin;
  const beginEmailLogin = deps.startEmailLogin || startEmailLogin;
  const verifyLogin = deps.verifyLogin || (async (tokens) => {
    const response = await request(new URL(cfg.relay.auth_url.replace(/\/$/, '') + '/auth/me'), {
      headers: { authorization: 'Bearer ' + tokens.access }, totalTimeout: 15000 });
    await readText(response, 1024 * 1024);
    if (response.statusCode !== 200) throw denied('Mirasim 登录校验失败，请重新授权');
  });
  const sessions = new Map();
  const connectionChecks = new Map();
  let lastTest = 0, testing = false, nextEmailAt = 0, starting = false, closed = false, hosting = false;
  let groupsCache = { at: 0, rows: [] };
  // sub2api 分组变化很少；缓存 60 秒，页面反复打开对话框不会打爆管理接口
  const listGroups = async () => {
    if (Date.now() - groupsCache.at < 60000) return groupsCache.rows;
    const result = await b.s2.listGroups(cfg);
    const rows = (Array.isArray(result) ? result : result?.items || result?.data || []).map((g) => ({ id: g.id, name: g.name, platform: g.platform }));
    groupsCache = { at: Date.now(), rows };
    return rows;
  };
  const file = path.resolve(cfg._config_path || path.join(rootOf(cfg), 'config.json'));
  const clean = () => {
    for (const [id, item] of sessions) if (Date.now() > item.expires) { item.capture.close(); sessions.delete(id); }
    // Keep the last result for display; the 10-second request cache is checked
    // separately below. Reading status must never start another upstream probe.
    for (const [key, item] of connectionChecks) if (!item.pending && Date.now() - item.at >= 86400000) connectionChecks.delete(key);
  };
  // Every account-scoped operation resolves (cfg, ctx) for data.account; "main" is this bridge's own account.
  const pick = (data) => {
    const key = data.account === undefined || data.account === '' ? 'main' : data.account;
    if (typeof key !== 'string' || (key !== 'main' && !PROFILE_RE.test(key))) throw denied('账号标识无效');
    if (key === 'main') return { key: 'main', cfg, ctx };
    const acct = ctx.hub?.get(key);
    if (!acct) throw denied('该账号未托管在这个 bridge 上');
    return acct;
  };
  const summary = (acct) => (b.accountSummary ? b.accountSummary(acct) : { key: acct.key, account_name: acct.cfg.sub2api.account_name });
  /**
   * Push the enforced concurrency onto the sub2api account. Without this the console
   * says "1" while sub2api keeps sending what it was told when the account was
   * created — a second request then hits the gate and answers 503, which sub2api
   * records as an upstream failure. Best effort: the local gate already holds, so a
   * failed sync is reported, not treated as a failed save.
   */
  const syncSub2Concurrency = async (acct) => {
    const sm = acct.ctx.sm;
    if (!sm?.accountId || typeof b.upstreamConcurrency !== 'function') return null;
    const wanted = b.upstreamConcurrency(acct.cfg);
    try {
      await b.s2.updateAccount(acct.cfg, sm.accountId, { concurrency: wanted });
      return { applied: true, concurrency: wanted };
    } catch (err) {
      return { applied: false, concurrency: wanted, error: err.message };
    }
  };
  // Persist onto the account's on-disk file only: in-memory cfg may hold env-injected secrets (admin key, bridge_secret).
  const persist = (acct, mutate) => {
    const target = acct.key === 'main' ? file : path.resolve(acct.cfg._config_path);
    const onDisk = JSON.parse(fs.readFileSync(target, 'utf8')); mutate(onDisk);
    const next = b.deepMerge({}, acct.cfg); mutate(next); b.validateConfig(next); atomicConfig(target, onDisk);
  };
  return {
    close() { closed = true; for (const item of sessions.values()) item.capture.close(); sessions.clear(); },
    async call(operation, data = {}) {
      clean();
      if (closed || ctx.shuttingDown) throw denied('服务正在停止');
      ensurePanelKey(cfg);
      if (cfg.backend !== 'relay') throw denied('网页账号管理需要 relay 后端');
      if (operation === 'status') {
        const a = pick(data);
        return { version: b.VERSION || null, account: a.key, membership: a.ctx.membership || { available: false, stale: true }, quota: a.ctx.quota || { available: false, stale: true }, schedulable: a.ctx.sm?.desired || 'unmanaged', reachable: Boolean(a.ctx.reachable), hold: Boolean(a.ctx.hold), inflight: a.ctx.inflight, kimi_inflight: a.ctx.kimiInflight || 0, uptime_sec: Math.round((Date.now() - ctx.startedAt) / 1000),
          sub2api: { managed: Boolean(a.ctx.sm), reachable: Boolean(a.ctx.reachable), schedulable: a.ctx.sm?.desired || 'unmanaged', account_id: a.ctx.sm?.accountId || null },
          sub2api_codex: a.ctx.codex?.sm ? { managed: true, reachable: Boolean(a.ctx.codex.reachable), schedulable: a.ctx.codex.sm.desired } : { managed: false },
          counters: a.ctx.counters, last_stream_error: a.ctx.lastStreamError || null, last_fallback: a.ctx.lastFallback || null, last_gpt_request: a.ctx.lastGptRequest || null, model_fallback: a.cfg.constraints.model_fallback, backoff_sec_left: Math.max(0, Math.ceil(((a.ctx.backoffUntil || 0) - Date.now()) / 1000)),
          last_upstream_ok_at: a.ctx.lastUpstreamOkAt ? new Date(a.ctx.lastUpstreamOkAt).toISOString() : null,
          history: (a.ctx.history || []).slice(-60), latency: b.latencySummary ? b.latencySummary(a.ctx) : {},
          hosting: Boolean(ctx.hub), accounts: ctx.hub ? ctx.hub.all().map(summary) : [summary({ key: 'main', cfg, ctx })] };
      }
      if (operation === 'logs') return { lines: b.recentLogs ? b.recentLogs(data.limit) : [] };
      if (operation === 'usage') {
        const a = pick(data);
        return { account: a.key, ...await usageStoreFor(a.cfg, a.ctx).query({ days: data.days, model: data.model }) };
      }
      if (operation === 'usage/pricing') {
        const a = pick(data);
        return await usageStoreFor(a.cfg, a.ctx).setPrice(data.model, data.rates);
      }
      if (operation === 'accounts') return ctx.hub ? ctx.hub.all().map(summary) : [summary({ key: 'main', cfg, ctx })];
      if (operation === 'membership/refresh') {
        const a = pick(data); return await b.refreshMembership(a.cfg, a.ctx, { force: true }) || { available: false, stale: true };
      }
      if (operation === 'window-keeper') {
        const a = pick(data), current = a.cfg.window_keeper;
        if (data.enabled === undefined) return { ...windowKeeper.summarize(a.cfg, a.ctx.windowKeeperStatus), running: Boolean(a.ctx.windowKeeperBusy || a.ctx.windowKeeperManualFlight) };
        if (typeof data.enabled !== 'boolean' || Object.keys(data).some((k) => !['account', 'enabled', 'model', 'windows', 'max_per_day'].includes(k))) throw denied('窗口任务参数无效');
        const next = { ...current, enabled: data.enabled,
          model: data.model === undefined ? current.model : data.model,
          windows: data.windows === undefined ? current.windows : data.windows,
          max_per_day: data.max_per_day === undefined ? current.max_per_day : data.max_per_day };
        windowKeeper.validateConfig({ ...next, enabled: false });
        if (next.enabled) {
          if (!a.cfg.quota.enabled || !a.cfg.membership.enabled) throw denied('请先启用额度和会员查询');
          if (!b.isModelAllowed(next.model, a.cfg) || !(await catalogIds(b, a.cfg)).includes(next.model)) throw denied('请选择当前账号目录中已启用的模型');
          const membership = await b.refreshMembership(a.cfg, a.ctx, { force: true });
          if (!membership?.available || membership.stale || membership.status === 'expired') throw denied('会员状态不可用或已到期');
          if (ctx.hub?.all().some((other) => other.key !== a.key && other.cfg.window_keeper.enabled && other.ctx.membership?.account_ref === membership.account_ref)) throw denied('同一 Mira 身份已有自动窗口任务，请先停用另一份任务');
          next.state_id = windowKeeper.initialize(a.cfg, membership.account_ref);
        }
        windowKeeper.validateConfig(next);
        persist(a, (c) => { c.window_keeper = next; });
        a.cfg.window_keeper = next;
        a.ctx.nextWindowCheckAt = 0;
        return windowKeeper.summarize(a.cfg, a.ctx.windowKeeperStatus);
      }
      if (operation === 'window-keeper/check') {
        const a = pick(data);
        if (!a.cfg.window_keeper.enabled) return { ...windowKeeper.summarize(a.cfg, a.ctx.windowKeeperStatus), accepted: false };
        if (!a.ctx.windowKeeperManualFlight) {
          a.ctx.windowKeeperStatus = { reason: 'checking' };
          a.ctx.windowKeeperManualFlight = (async () => {
            await b.refreshMembership(a.cfg, a.ctx);
            await b.refreshQuota(a.cfg, a.ctx, { force: true });
            await b.runWindowKeeper(a.cfg, a.ctx);
          })().catch(() => { a.ctx.windowKeeperStatus = { reason: 'state_or_probe_error' }; }).finally(() => { a.ctx.windowKeeperManualFlight = null; });
        }
        return { ...windowKeeper.summarize(a.cfg, a.ctx.windowKeeperStatus), accepted: true };
      }
      if (operation === 'account/access') {
        const a = pick(data);
        if (data.reveal !== true) throw denied('请点击查看或复制密钥');
        return { account: a.key, account_name: a.cfg.sub2api.account_name, base_url: b.bridgeBaseUrl(a.cfg), api_key: a.cfg.bridge_secret };
      }
      if (operation === 'account/check') {
        const a = pick(data), prior = connectionChecks.get(a.key);
        if (prior && prior.cfg === a.cfg && (prior.pending || Date.now() - prior.at < 10000)) return prior.promise;
        if ([...connectionChecks.values()].filter((c) => c.pending).length >= 2) throw denied('已有两个账号正在检测，请稍后重试');
        const entry = { at: Date.now(), pending: true, cfg: a.cfg };
        entry.promise = (async () => {
          const started = Date.now();
          let forward;
          try {
            // Exercise the real bridge listener and this account's routing key,
            // not a direct relay request which bypasses authentication/routing.
            const r = await b.diagnosticRequest(b.diagnosticTarget(a.cfg), '/v1/models', undefined, { timeoutMs: 8000 });
            const count = r.status === 200 ? b.catalogRows(JSON.parse(r.raw)).length : 0;
            forward = { ok: r.status === 200, status: r.status, model_count: count, elapsed_ms: r.elapsed_ms,
              message: r.status === 200 ? '经桥接器读取上游目录成功' : '桥接器或上游暂不可用，请查看运行日志' };
            if (r.status !== 200) {
              // The bridge answers 429 with the relay's body: name the actual cause
              // (shared quota vs. rate limit) instead of "upstream unavailable".
              let failure = null;
              try { failure = b.classifyUpstreamFailure(r.status, r.headers || {}, r.raw); } catch {}
              if (failure) {
                forward.failure = failure;
                forward.message = failure.kind === 'quota'
                  ? `上游共享额度已用尽${failure.retry_after_sec ? `，${Math.round(failure.retry_after_sec / 60)} 分钟后可重试` : ''}；账号与凭证正常`
                  : failure.kind === 'rate_limit' ? '上游限流中，请稍后重试'
                  : failure.kind === 'auth' ? '上游拒绝凭证，可能需要重新登录'
                  : failure.kind === 'server' ? '上游服务异常，请稍后重试' : forward.message;
              }
            }
          } catch {
            forward = { ok: false, elapsed_ms: Date.now() - started, message: '桥接器连接失败、超时或目录格式异常' };
          }
          let reverse = { ok: null, checked: false, message: '账号尚未注册到 sub2，未测试反向连接' };
          if (a.ctx.sm?.accountId) {
            try {
              // Read upstream catalog through sub2. Do not rewrite mappings, resume
              // paused accounts, or send an inference request during a connection check.
              const catalog = b.catalogRows(await b.s2.syncModels(a.cfg, a.ctx.sm.accountId));
              reverse = { ok: true, checked: true, model_count: catalog.length, message: 'sub2 → 此账号桥接器已连通' };
            } catch {
              reverse = { ok: false, checked: true, message: 'sub2 无法读取此账号目录，请检查注册地址、密钥和网络' };
            }
          }
          entry.result = { account: a.key, checked_at: new Date().toISOString(), ok: forward.ok && reverse.ok !== false, bridge: forward, sub2api: reverse };
          return entry.result;
        })().finally(() => { entry.pending = false; entry.at = Date.now(); });
        connectionChecks.set(a.key, entry);
        return entry.promise;
      }
      if (operation === 'account/check/status') {
        const a = pick(data), entry = connectionChecks.get(a.key);
        if (!entry || entry.cfg !== a.cfg) return { account: a.key, running: false, result: null };
        return { account: a.key, running: entry.pending, result: entry.result || null };
      }
      if (operation === 'summary') {
        const { cfg: c } = pick(data);
        return {
          account_name: c.sub2api.account_name, group_ids: c.sub2api.group_ids,
          replay_buffer_mb: c.forward.replay_buffer_mb,
          public_base_url: c.sub2api.public_base_url, max_concurrency: c.forward.max_concurrency, kimi_max_concurrency: c.forward.kimi_max_concurrency, model_fallback: c.constraints.model_fallback, kimi_default_effort: c.constraints.kimi_default_effort, gpt_default_effort: c.constraints.gpt_default_effort,
          disabled_models: c.constraints.disabled_models, hosted: ctx.hub ? ctx.hub.all().filter((a) => a.key !== 'main').map((a) => a.key) : [],
        };
      }
      if (operation === 'profiles') {
        return listProfiles(rootOf(cfg)).map((p) => ({ ...p, hosted: Boolean(ctx.hub?.get(p.profile)), listed: cfg.accounts?.hosted?.includes(p.profile) || false }));
      }
      if (operation === 'reauth') {
        // Why the account cannot authenticate any more, or null. Distinguishing
        // "sign in again" from "temporarily down" is the whole point: only one of
        // them is something the operator can act on.
        const a = pick(data);
        const relay = b.getRelay ? b.getRelay(a.cfg) : null;
        const state = relay && typeof relay.needsReauth === 'function' ? relay.needsReauth() : null;
        const credential = b.relaySettingPath ? b.relaySettingPath(a.cfg) : null;
        return { account: a.key, needs_reauth: Boolean(state), reason: state?.reason || null,
          since: state?.at || null, credential_file: credential,
          credential_saved: credential ? fs.existsSync(credential) : null };
      }
      if (operation === 'profile/info') {
        const dir = profileDirectory(rootOf(cfg), data.profile);
        const p = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
        if (!fs.existsSync(path.join(dir, 'setting.json'))) throw denied('凭证尚未保存');
        return { profile: data.profile, public_base_url: p.sub2api.public_base_url, port: p.listen.port, hosted: Boolean(ctx.hub?.get(data.profile)), hosting_supported: Boolean(ctx.hub) };
      }
      if (operation === 'account/host') {
        if (!ctx.hub || !ctx.hub.registerAccount) throw denied('当前进程不支持托管（需 serve 且 backend=relay）');
        if (typeof data.profile !== 'string' || !PROFILE_RE.test(data.profile) || data.profile === 'main') throw denied('profile 名称无效');
        const existing = ctx.hub.get(data.profile);
        if (existing && cfg.accounts.hosted.includes(data.profile)) return { hosted: true, profile: data.profile,
          account_name: existing.cfg.sub2api.account_name, registered: Boolean(existing.ctx.sm), reachable: Boolean(existing.ctx.reachable) };
        if (hosting) throw denied('正在托管另一个账号，请稍候');
        hosting = true;
        try {
          const acct = ctx.hub.add(data.profile);   // 校验凭证/密钥/账号名唯一性
          try {
            persist({ key: 'main', cfg, ctx }, (c) => { c.accounts = { ...(c.accounts || {}), hosted: [...new Set([...(c.accounts?.hosted || []), data.profile])] }; });
          } catch (err) { ctx.hub.remove(data.profile); throw err; }
          cfg.accounts.hosted = [...new Set([...cfg.accounts.hosted, data.profile])];
          // 注册通常几秒；超过 40 秒就先返回，健康循环会继续补注册
          let done = false;
          const registering = ctx.hub.registerAccount(acct).then(() => { done = true; }).catch(() => {});
          let registrationTimer;
          try { await Promise.race([registering, new Promise((r) => { registrationTimer = setTimeout(r, 40000); })]); }
          finally { clearTimeout(registrationTimer); }
          return { hosted: true, profile: data.profile, account_name: acct.cfg.sub2api.account_name, registered: done && Boolean(acct.ctx.sm), reachable: Boolean(acct.ctx.reachable) };
        } finally { hosting = false; }
      }
      if (operation === 'account/unhost') {
        if (!ctx.hub) throw denied('当前进程不支持托管');
        if (typeof data.profile !== 'string' || !PROFILE_RE.test(data.profile) || data.profile === 'main') throw denied('profile 名称无效');
        const acct = ctx.hub.get(data.profile);
        if (!acct) throw denied('该账号未托管');
        acct.ctx.hold = true;
        const pauses = [acct.ctx.sm, acct.ctx.codex?.sm].filter(Boolean).map((sm) => sm.pause('移出托管'));
        const results = await Promise.all(pauses.map((p) => p.then((ok) => ok, () => false)));
        persist({ key: 'main', cfg, ctx }, (c) => { c.accounts = { ...(c.accounts || {}), hosted: (c.accounts?.hosted || []).filter((n) => n !== data.profile) }; });
        cfg.accounts.hosted = cfg.accounts.hosted.filter((n) => n !== data.profile);
        ctx.hub.remove(data.profile);
        return { hosted: false, profile: data.profile, paused: results.every(Boolean), note: 'sub2api 账号保留为暂停态，凭证文件未删除' };
      }
      if (operation === 'account/pause' || operation === 'account/resume') {
        const a = pick(data);
        if (operation === 'account/pause') {
          a.ctx.hold = true;
          const results = await Promise.all([a.ctx.sm, a.ctx.codex?.sm].filter(Boolean).map((sm) => sm.pause('网页手动暂停').then((ok) => ok, () => false)));
          return { account: a.key, hold: true, paused: results.every(Boolean), managed: Boolean(a.ctx.sm) };
        }
        a.ctx.hold = false;
        return { account: a.key, hold: false, note: '健康检查连续通过后自动恢复调度（通常 1-2 分钟）' };
      }
      if (operation === 'groups') return listGroups();
      if (operation === 'codex') {
        // 读/写当前账号的 Codex 专用账号（platform=openai，原样转发 /v1/responses）
        const a = pick(data);
        const state = () => {
          const o = a.cfg.sub2api.openai_account || { enabled: false, account_name: '', group_ids: [] };
          return { account: a.key, enabled: Boolean(o.enabled), account_name: o.account_name || `${a.cfg.sub2api.account_name}-codex`, custom_name: o.account_name || '', group_ids: o.group_ids || [],
            sub2api_codex: a.ctx.codex?.sm ? { managed: true, reachable: Boolean(a.ctx.codex.reachable), schedulable: a.ctx.codex.sm.desired, account_id: a.ctx.codex.sm.accountId } : { managed: false } };
        };
        if (data.enabled === undefined) return state();
        if (typeof data.enabled !== 'boolean') throw denied('enabled 必须是布尔值');
        const current = a.cfg.sub2api.openai_account || { enabled: false, account_name: '', group_ids: [] };
        let groupIds = current.group_ids || [];
        if (data.group_id !== undefined && data.group_id !== null && data.group_id !== 0) {
          if (!Number.isInteger(data.group_id) || data.group_id < 1) throw denied('分组 ID 必须是正整数');
          groupIds = [data.group_id];
        }
        if (data.enabled) {
          if (!groupIds.length) throw denied('请选择一个 openai 平台分组');
          const group = (await listGroups()).find((g) => g.id === groupIds[0]);
          if (!group) throw denied('分组不存在，请刷新分组列表');
          if (!['openai', 'composite'].includes(group.platform)) throw denied('Codex 账号必须放在 openai 或 composite 分组；anthropic 分组会把 Responses 转成 Messages，Codex 的审批/工具参数会丢失');
        }
        let name = current.account_name || '';
        if (data.account_name !== undefined) {
          if (data.account_name !== '' && (typeof data.account_name !== 'string' || !/^[\p{L}\p{N} _.@-]{1,64}$/u.test(data.account_name))) throw denied('账号名最多 64 个字符，只能包含文字、数字、空格和 _.@-');
          name = data.account_name;
        }
        if ((name || `${a.cfg.sub2api.account_name}-codex`) === a.cfg.sub2api.account_name) throw denied('Codex 账号名不能与主账号相同');
        const next = { enabled: data.enabled, account_name: name, group_ids: groupIds };
        persist(a, (c) => { c.sub2api = { ...(c.sub2api || {}), openai_account: next }; });
        a.cfg.sub2api.openai_account = next;
        if (!data.enabled && a.ctx.codex?.sm) {
          const sm = a.ctx.codex.sm;
          a.ctx.codex = { sm: null, reachable: false };
          await sm.pause('网页关闭 Codex 账号').catch(() => false);
        }
        let registered = false;
        if (data.enabled && !a.ctx.codex?.sm && ctx.hub?.registerAccount) {
          await Promise.race([ctx.hub.registerAccount(a).then(() => { registered = true; }).catch(() => {}), new Promise((r) => setTimeout(r, 40000))]);
        }
        return { ...state(), saved: true, registered };
      }
      if (operation === 'models') {
        // 目录直接来自上游，不再按写死的四个系列过滤：上游新增的模型/系列自动出现
        const a = pick(data);
        const { ids, source, roster } = await catalogRowsFor(b, a);
        const latency = b.latencySummary ? b.latencySummary(a.ctx) : {};
        const block = a.cfg.constraints.model_block ? new RegExp(a.cfg.constraints.model_block) : null;
        const filter = a.cfg.constraints.model_filter ? new RegExp(a.cfg.constraints.model_filter) : null;
        const withdrawn = new Set(roster?.withdrawn || []);
        const served = new Set(roster?.served || []);
        return ids.map((id) => {
          const meta = roster?.models?.[id] || null;
          return {
            id, family: b.modelFamily(id), enabled: b.isModelAllowed(id, a.cfg),
            disabled: a.cfg.constraints.disabled_models.includes(id),
            blocked: Boolean(block && block.test(id)), filtered: Boolean(filter && !filter.test(id)),
            // roster facts the relay publishes: per-model effort rungs, context limits,
            // pricing and whether the id is actually routable right now (`served`).
            effort: meta?.effort || null, context_window: meta?.context_window || null,
            max_output: meta?.max_output || null, pricing: meta?.pricing || null,
            served: roster ? served.has(id) : null, withdrawn: withdrawn.has(id),
            source,
            note: block && block.test(id) ? 'model_block 命中（单价偏高），改配置才能放行' : filter && !filter.test(id) ? '不在 model_filter 范围内'
              : withdrawn.has(id) ? '上游已下架（roster.withdrawn），请求会被拒绝' : roster && !served.has(id) ? '不在 roster.served，当前不可路由'
              : id.startsWith('deepseek-') ? '历史测试：上游无可用容量' : id.startsWith('kimi-') ? '上游可能慢响应，默认并发 1' : '',
            latency: latency[id] || null,
          };
        });
      }
      if (operation === 'settings') {
        const a = pick(data);
        // Conservative ceiling: high concurrency on one Mira account is the main automated-abuse signal.
        const read = (v, name) => { if (!Number.isInteger(v) || v < 1 || v > 16) throw denied(name + '必须是 1-16 的整数'); return v; };
        const max = read(data.max_concurrency, '总并发'), kimi = read(data.kimi_max_concurrency, 'Kimi 并发');
        if (kimi > max) throw denied('Kimi 并发不能超过总并发');
        const replay = data.replay_buffer_mb === undefined ? a.cfg.forward.replay_buffer_mb : data.replay_buffer_mb;
        if (!Number.isInteger(replay) || replay < 1 || replay > 1024) throw denied('请求体上限必须是 1-1024 MB 的整数');
        const fallback = data.model_fallback === undefined ? a.cfg.constraints.model_fallback : data.model_fallback;
        if (!['observe', 'forbid'].includes(fallback)) throw denied('模型替换策略只能是 observe 或 forbid');
        const effort = data.kimi_default_effort === undefined ? a.cfg.constraints.kimi_default_effort : data.kimi_default_effort;
        if (!['', 'low', 'high', 'max'].includes(effort)) throw denied('Kimi 推理档只能是 空、low、high 或 max');
        const gptEffort = data.gpt_default_effort === undefined ? a.cfg.constraints.gpt_default_effort : data.gpt_default_effort;
        if (!['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(gptEffort)) throw denied('GPT 默认推理档只能是 空、low、medium、high、xhigh、max 或 ultra');
        persist(a, (c) => {
          c.forward = { ...(c.forward || {}), max_concurrency: max, kimi_max_concurrency: kimi, replay_buffer_mb: replay };
          c.constraints = { ...(c.constraints || {}), model_fallback: fallback, kimi_default_effort: effort, gpt_default_effort: gptEffort };
        });
        a.cfg.forward.max_concurrency = max; a.cfg.forward.kimi_max_concurrency = kimi; a.cfg.constraints.model_fallback = fallback; a.cfg.constraints.kimi_default_effort = effort;
        a.cfg.constraints.gpt_default_effort = gptEffort;
        a.cfg.forward.replay_buffer_mb = replay;
        // sub2api 按注册时声明的并发真的会并发发请求；不同步，页面上的新值就只是本地闸门。
        const synced = await syncSub2Concurrency(a);
        return { saved: true, account: a.key, max_concurrency: max, kimi_max_concurrency: kimi, replay_buffer_mb: replay, model_fallback: fallback, kimi_default_effort: effort, gpt_default_effort: gptEffort,
          ...(synced ? { sub2api_concurrency: synced } : {}) };
      }
      if (operation === 'models/family') {
        const a = pick(data);
        if (typeof data.family !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(data.family) || typeof data.enabled !== 'boolean') throw denied('模型系列参数无效');
        const ids = (await catalogRowsFor(b, a)).ids.filter((id) => b.modelFamily(id) === data.family);
        if (!ids.length) throw denied('上游目录中没有这个系列的模型');
        const disabled = new Set(a.cfg.constraints.disabled_models);
        for (const id of ids) data.enabled ? disabled.delete(id) : disabled.add(id);
        persist(a, (c) => { c.constraints = { ...(c.constraints || {}), disabled_models: [...disabled] }; });
        a.cfg.constraints.disabled_models = [...disabled];
        a.ctx.reachable = false;
        return { saved: true, account: a.key, sync_pending: true, changed: ids.length };
      }
      if (operation === 'model') {
        const a = pick(data);
        if (typeof data.id !== 'string' || !/^[A-Za-z0-9][\w./:-]{0,180}$/.test(data.id) || typeof data.enabled !== 'boolean') throw denied('模型参数无效');
        const disabled = new Set(a.cfg.constraints.disabled_models);
        data.enabled ? disabled.delete(data.id) : disabled.add(data.id);
        persist(a, (c) => { c.constraints = { ...(c.constraints || {}), disabled_models: [...disabled] }; });
        a.cfg.constraints.disabled_models = [...disabled];
        a.ctx.reachable = false; // The next health tick persists and verifies the new sub2 model mapping.
        return { saved: true, account: a.key, sync_pending: true };
      }
      if (operation === 'test') {
        const a = pick(data);
        if (typeof data.id !== 'string' || !/^[\w./-]{1,180}$/.test(data.id) || !b.isModelAllowed(data.id, a.cfg)) throw denied('模型未启用或名称无效');
        if (testing || Date.now() - lastTest < 10000) throw denied('模型测试正在进行或冷却中，请稍后重试');
        testing = true; lastTest = Date.now();
        try {
          // 直连该账号的 relay：托管账号不能经 main 的密钥走转发层
          const r = await b.checkDiagnosticModel(b.diagnosticTarget(a.cfg, true), data.id, { flags: { 'timeout-sec': 30, 'max-tokens': 128, direct: true } });
          return { model: data.id, account: a.key, ok: r.ok, status: r.status, elapsed_ms: r.elapsed_ms, ttfb_ms: r.ttfb_ms,
            message: r.ok ? '收到完整回复' : r.failure?.kind === 'quota' ? '上游共享额度已用尽，账号与凭证正常'
              : r.status === 429 || r.status === 529 ? '上游限流，请稍后重试'
              : r.status === 503 ? '上游暂不可用或正在退避' : '测试未完成，请检查上游状态或超时' };
        } finally { testing = false; }
      }
      if (operation === 'account/import') {
        if (data.request_id !== undefined && (typeof data.request_id !== 'string' || !/^[a-f0-9-]{32,36}$/.test(data.request_id))) throw denied('导入请求标识无效');
        const importId = 'import-' + (data.request_id || crypto.randomUUID());
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
        const existing = sessions.get(importId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw denied('导入参数已改变，请重新选择文件');
          return existing.result;
        }
        if (sessions.size >= 8) throw denied('待完成任务过多，请稍后重试');
        if (typeof data.profile !== 'string' || !PROFILE_RE.test(data.profile) || data.profile === 'main') throw denied('profile 名称无效');
        if (!data.credential || typeof data.credential !== 'object' || Array.isArray(data.credential)) throw denied('请上传凭证 JSON 对象');
        const dir = profileDirectory(rootOf(cfg), data.profile);
        if ([...sessions.values()].some(s => s.profile === data.profile && !['failed', 'saved'].includes(s.stage))) throw denied('这个 profile 已有待完成登录或导入');
        if (fs.existsSync(dir)) throw denied('该 profile 已存在，原账号不会被覆盖');
        if (data.group_id === 0 || data.group_id === null) delete data.group_id;
        if (data.group_id !== undefined && (!Number.isInteger(data.group_id) || data.group_id < 1)) throw denied('分组 ID 必须是正整数');
        if (data.account_name !== undefined && (typeof data.account_name !== 'string' || !/^[\p{L}\p{N} _.@-]{1,64}$/u.test(data.account_name))) throw denied('账号名最多 64 个字符，只能包含文字、数字、空格和 _.@-');
        const hosted = data.hosted === true;
        const port = hosted ? cfg.listen.port : (data.port === undefined || data.port === 0 ? 8787 : data.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw denied('端口必须是 1024-65535 的整数');
        const publicBase = hosted ? b.bridgeBaseUrl(cfg) : data.public_base_url;
        if (!hosted && ![`http://mirasim-${data.profile}:${port}`, `http://127.0.0.1:${port}`].includes(publicBase)) throw denied('桥接器地址只能是本机或同一 Docker 网络内的该 profile 地址');
        let credential;
        try { credential = importCredential(data.credential); } catch (err) { throw denied(err.message); }
        const { profileConfig } = require('../scripts/account-login');
        const profileCfg = profileConfig(cfg, data.profile, { 'account-name': data.account_name, 'public-base-url': publicBase, 'group-id': data.group_id, port });
        profileCfg.forward.failure_log = path.join(dir, 'requests.log');
        const item = { profile: data.profile, provider: 'import', hosted, fingerprint, stage: 'validating', expires: Date.now() + 15 * 60000, capture: { close() {} } };
        item.result = (async () => {
        try { await verifyLogin({ access: credential.access_token }); }
        catch { throw denied('凭证校验未通过或连接失败，请检查有效期和网络；本次未自动刷新共享凭证'); }
        if (closed || ctx.shuttingDown || Date.now() > item.expires) throw denied('导入已过期或服务正在停止');
        fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
        try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (err.code === 'EEXIST') throw denied('该 profile 已存在，原账号不会被覆盖'); throw err; }
        let wroteSetting = false;
        try {
          fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          wroteSetting = true;
          fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(profileCfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        } catch (err) {
          if (wroteSetting) try { fs.unlinkSync(path.join(dir, 'setting.json')); } catch {}
          try { fs.rmdirSync(dir); } catch {}
          throw denied('凭证验证通过，但保存 profile 失败；原账号未修改');
        }
        item.stage = 'saved';
        return { profile: data.profile, saved: true, hosted, account_name: profileCfg.sub2api.account_name };
        })().catch(err => { item.stage = 'failed'; sessions.delete(importId); throw err; });
        sessions.set(importId, item); return item.result;
      }
      if (operation === 'login/cancel') {
        const item = sessions.get(data.id);
        if (!item) return { cancelled: true };
        if (item.stage === 'saved') return { stage: 'saved', ...await item.result };
        if (item.stage === 'validating') throw denied('正在校验并保存，请等待完成后再操作');
        item.capture.close(); sessions.delete(data.id); return { cancelled: true };
      }
      if (operation === 'login/start') {
        if (starting) throw denied('正在发起登录，请稍候');
        if (sessions.size >= 8) throw denied('待完成登录过多，请稍后重试');
        const provider = data.provider === undefined ? 'google' : data.provider;
        if (!['google', 'github', 'email'].includes(provider)) throw denied('登录方式只能选择 google、github 或 email');
        if (provider === 'email' && Date.now() < nextEmailAt) throw denied('发送验证码需间隔至少 60 秒');
        if ([...sessions.values()].some((s) => s.profile === data.profile && !['failed', 'saved'].includes(s.stage))) throw denied('这个 profile 已有待完成登录');
        // Two very different operations share this endpoint:
        //   renew=false (default) — create a brand new profile; never overwrite.
        //   renew=true            — replace the credentials of an EXISTING profile
        //                           whose refresh token is dead. Same account, same
        //                           sub2 name, same group; only setting.json changes.
        const renew = data.renew === true;
        const isMain = data.profile === 'main';
        // The main account's credential lives where relay.setting_json points, not in
        // profiles/main. Hosted profiles live under profiles/<name>.
        const dir = isMain ? null : profileDirectory(rootOf(cfg), data.profile);
        if (!isMain && !PROFILE_RE.test(data.profile || '')) throw denied('profile 名称无效');
        if (!renew && dir && fs.existsSync(dir)) throw denied('该 profile 已存在，原账号不会被覆盖');
        if (renew && isMain) {
          const target = b.relaySettingPath(cfg);
          if (!fs.existsSync(target)) throw denied('主账号凭证文件不存在，请按新增账号导入');
        }
        if (renew && !isMain) {
          if (!fs.existsSync(path.join(dir, 'config.json'))) throw denied('这个 profile 不存在，无法重新登录；请新增账号');
          if (ctx.hub && !ctx.hub.get(data.profile) && !cfg.accounts?.hosted?.includes(data.profile)) {
            throw denied('只能为已托管的账号重新登录；未托管的 profile 请按新增账号处理');
          }
        }
        if (renew && data.profile === data.account) { /* account and profile are the same key here */ }
        // Empty form fields arrive as 0; treat them as "not specified".
        if (data.group_id === 0 || data.group_id === null) delete data.group_id;
        const hosted = renew ? true : data.hosted === true;
        const port = hosted ? cfg.listen.port : (data.port === undefined || data.port === 0 ? 8787 : data.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw denied('端口必须是 1024-65535 的整数');
        // sub2api will send user prompts and this profile's secret to public_base_url: allow only this host's own endpoints.
        // 托管账号复用本 bridge 的对外地址（sub2api 按密钥区分账号，不需要新地址）。
        const publicBase = hosted ? b.bridgeBaseUrl(cfg) : data.public_base_url;
        if (!hosted && ![`http://mirasim-${data.profile}:${port}`, `http://127.0.0.1:${port}`].includes(publicBase)) throw denied('桥接器地址只能是本机或同一 Docker 网络内的该 profile 地址');
        if (data.account_name !== undefined && (typeof data.account_name !== 'string' || !/^[\p{L}\p{N} _.@-]{1,64}$/u.test(data.account_name))) throw denied('账号名最多 64 个字符，只能包含文字、数字、空格和 _.@-');
        if (data.group_id !== undefined && (!Number.isInteger(data.group_id) || data.group_id < 1)) throw denied('分组 ID 必须是正整数');
        let profileCfg;
        if (renew) {
          // Reuse the existing profile config verbatim so a re-login cannot silently
          // change the account's name, group, port or limits.
          if (!isMain) {
            try { profileCfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); }
            catch { throw denied('现有 profile 的 config.json 无法读取；请先修复该文件'); }
          } else {
            profileCfg = { sub2api: { account_name: cfg.sub2api.account_name } };
          }
        } else {
          const { profileConfig } = require('../scripts/account-login');
          profileCfg = profileConfig(cfg, data.profile, { 'account-name': data.account_name,
            'public-base-url': publicBase, 'group-id': data.group_id, port });
          profileCfg.forward.failure_log = path.join(dir, 'requests.log');
        }
        starting = true;
        let capture;
        try {
        if (provider === 'email') nextEmailAt = Date.now() + 60000;
        capture = provider === 'email'
          ? await beginEmailLogin({ authUrl: cfg.relay.auth_url, email: data.email })
          : await beginLogin({ authUrl: cfg.relay.auth_url, provider });
        if (closed || ctx.shuttingDown) { capture.close(); throw denied('服务正在停止'); }
        } finally { starting = false; }
        const id = crypto.randomBytes(24).toString('hex');
        const item = { capture, profile: data.profile, provider, email: data.email, hosted, renew,
          expires: Date.now() + 15 * 60000, stage: 'waiting' };
        item.result = capture.result.then(async (tokens) => {
          item.stage = 'validating'; await verifyLogin(tokens);
          if (closed || ctx.shuttingDown || Date.now() > item.expires) throw denied('登录过期或服务正在停止');
          const credential = createCredential(tokens);
          if (renew) {
            const target = isMain ? b.relaySettingPath(cfg) : path.join(dir, 'setting.json');
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            // Keep the previous credential aside as a corrupt-file escape hatch, then
            // replace it atomically so a crash mid-write cannot leave an empty file.
            if (fs.existsSync(target)) fs.copyFileSync(target, path.join(path.dirname(target), 'setting.previous.json'));
            const temp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
            try {
              fs.writeFileSync(temp, JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
              fs.renameSync(temp, target);
            } finally { try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
            // The running client still holds the dead ticket and the old tokens.
            // Pick up the new credential without restarting the bridge.
            const acctCfg = isMain ? cfg : (ctx.hub?.get(data.profile)?.cfg || cfg);
            const relay = b.getRelay ? b.getRelay(acctCfg) : null;
            if (relay && typeof relay.reloadCredential === 'function') {
              try { relay.reloadCredential(); } catch { /* the next request re-reads the file */ }
            }
          } else {
            fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
            fs.mkdirSync(dir, { mode: 0o700 });
            fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(profileCfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          }
          item.stage = 'saved';
          return { profile: data.profile, saved: true, renew, hosted, account_name: profileCfg.sub2api?.account_name || null };
        }).catch(() => { item.stage = 'failed'; throw denied(renew ? '重新登录未完成或保存失败，原凭证未被修改' : '登录未完成或保存失败，原账号未修改'); }).finally(() => capture.close());
        item.result.catch(() => {}); sessions.set(id, item);
        return { id, url: capture.url, provider, hosted, renew, expires_at: new Date(item.expires).toISOString() };
      }
      if (operation === 'login/complete' || operation === 'login/status') {
        const item = sessions.get(data.id);
        if (!item) throw denied('登录已过期或服务已重启，请重新发起');
        if (operation === 'login/status') return { stage: item.stage, profile: item.profile, provider: item.provider, hosted: item.hosted,
          saved: item.stage === 'saved', ...(item.stage === 'saved' ? await item.result : {}) };
        if (item.stage === 'waiting') {
          if (item.provider === 'email') {
            try { await item.capture.submit(data.code); } catch (err) { throw denied(err.message.includes('HTTP') ? '验证码错误或已过期，请重试' : err.message); }
          } else {
            if (typeof data.callback !== 'string' || data.callback.length > 150000) throw denied('请粘贴完整回调地址');
            try { item.capture.accept(data.callback); } catch { throw denied('回调地址不属于本次登录，或已失效'); }
          }
        }
        return item.result;
      }
      throw denied('未知管理操作');
    },
  };
}

async function handle(req, res, cfg, ctx) {
  const reply = (code, data) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (!authorized(cfg, req.headers['x-panel-key'])) return reply(403, { error: '管理权限不足' });
  if (req.method === 'GET' && (req.url === '/panel' || req.url === '/panel/')) return page(res);
  if (req.method !== 'POST' || !/^application\/json(?:;|$)/.test(req.headers['content-type'] || '')) return reply(405, { error: '仅接受 JSON POST' });
  try {
    // Concatenate bytes first: decoding each chunk separately splits multi-byte UTF-8 (Chinese names, emails).
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 160000) throw denied('请求过大'); chunks.push(chunk); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw denied('请求格式错误');
    ctx.panel ||= createPanel(cfg, ctx);
    const result = await ctx.panel.call(req.url.slice('/__panel/'.length), data);
    reply(200, result);
  } catch (err) {
    let message = err.publicMessage || (err instanceof Error ? err.message : '');
    const blocked = ['token', 'secret', 'authorization', '/data', '\\', '/etc/', 'setting.json'];
    if (!message || message.length > 240 || blocked.some((part) => message.toLowerCase().includes(part))) message = '操作失败，请检查服务状态和参数';
    reply(400, { error: message });
  }
}
module.exports = { createPanel, authorized, handle, page, ensurePanelKey, ASSETS };
