'use strict';
// Privileged operations require a volume-only key, separate from inference keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startLogin, startEmailLogin, createCredential, profileDirectory, listProfiles } = require('./login');
const { request, readText } = require('./relay');

const rootOf = (cfg) => path.dirname(path.resolve(cfg._config_path || process.env.MIRASIM_CONFIG || 'config.json'));
const denied = (message) => Object.assign(Error(message), { publicMessage: message });
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const ASSETS = { '/panel': ['index.html','text/html; charset=utf-8'], '/panel/': ['index.html','text/html; charset=utf-8'], '/panel/app.js': ['app.js','text/javascript; charset=utf-8'], '/panel/style.css': ['style.css','text/css; charset=utf-8'] };
function page(res, route = '/panel') {
  const asset = ASSETS[route];
  if (!asset) { res.writeHead(404); return res.end(); }
  const raw = fs.readFileSync(path.join(__dirname, '../web', asset[0]));
  res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  res.end(raw);
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
  const rows = Array.isArray(parsed) ? parsed : parsed.data || parsed.models;
  if (response.statusCode !== 200 || !Array.isArray(rows)) throw denied('上游模型目录暂不可用');
  return [...new Set(rows.map((m) => typeof m === 'string' ? m : m.id || m.model_id).filter((id) => typeof id === 'string' && id.length <= 180))];
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
        return { version: b.VERSION || null, account: a.key, quota: a.ctx.quota || { available: false, stale: true }, schedulable: a.ctx.sm?.desired || 'unmanaged', reachable: Boolean(a.ctx.reachable), hold: Boolean(a.ctx.hold), inflight: a.ctx.inflight, kimi_inflight: a.ctx.kimiInflight || 0, uptime_sec: Math.round((Date.now() - ctx.startedAt) / 1000),
          sub2api: { managed: Boolean(a.ctx.sm), reachable: Boolean(a.ctx.reachable), schedulable: a.ctx.sm?.desired || 'unmanaged', account_id: a.ctx.sm?.accountId || null },
          sub2api_codex: a.ctx.codex?.sm ? { managed: true, reachable: Boolean(a.ctx.codex.reachable), schedulable: a.ctx.codex.sm.desired } : { managed: false },
          counters: a.ctx.counters, last_stream_error: a.ctx.lastStreamError || null, last_fallback: a.ctx.lastFallback || null, model_fallback: a.cfg.constraints.model_fallback, backoff_sec_left: Math.max(0, Math.ceil(((a.ctx.backoffUntil || 0) - Date.now()) / 1000)),
          hosting: Boolean(ctx.hub), accounts: ctx.hub ? ctx.hub.all().map(summary) : [summary({ key: 'main', cfg, ctx })] };
      }
      if (operation === 'accounts') return ctx.hub ? ctx.hub.all().map(summary) : [summary({ key: 'main', cfg, ctx })];
      if (operation === 'summary') {
        const { cfg: c } = pick(data);
        return {
          account_name: c.sub2api.account_name, group_ids: c.sub2api.group_ids,
          public_base_url: c.sub2api.public_base_url, max_concurrency: c.forward.max_concurrency, kimi_max_concurrency: c.forward.kimi_max_concurrency, model_fallback: c.constraints.model_fallback,
          disabled_models: c.constraints.disabled_models, hosted: ctx.hub ? ctx.hub.all().filter((a) => a.key !== 'main').map((a) => a.key) : [],
        };
      }
      if (operation === 'profiles') {
        return listProfiles(rootOf(cfg)).map((p) => ({ ...p, hosted: Boolean(ctx.hub?.get(p.profile)), listed: cfg.accounts?.hosted?.includes(p.profile) || false }));
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
          await Promise.race([registering, new Promise((r) => setTimeout(r, 40000))]);
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
        const a = pick(data);
        const ids = await catalogIds(b, a.cfg);
        return ids.filter((id) => /^(claude-|gpt-|deepseek-|kimi-)/.test(id)).map((id) => ({
          id, family: b.modelFamily(id), enabled: b.isModelAllowed(id, a.cfg),
          disabled: a.cfg.constraints.disabled_models.includes(id),
          note: id.startsWith('deepseek-') ? '历史测试：上游无可用容量' : id.startsWith('kimi-') ? '上游可能慢响应，默认并发 1' : '',
        }));
      }
      if (operation === 'settings') {
        const a = pick(data);
        // Conservative ceiling: high concurrency on one Mira account is the main automated-abuse signal.
        const read = (v, name) => { if (!Number.isInteger(v) || v < 1 || v > 16) throw denied(name + '必须是 1-16 的整数'); return v; };
        const max = read(data.max_concurrency, '总并发'), kimi = read(data.kimi_max_concurrency, 'Kimi 并发');
        if (kimi > max) throw denied('Kimi 并发不能超过总并发');
        const fallback = data.model_fallback === undefined ? a.cfg.constraints.model_fallback : data.model_fallback;
        if (!['observe', 'forbid'].includes(fallback)) throw denied('模型替换策略只能是 observe 或 forbid');
        persist(a, (c) => {
          c.forward = { ...(c.forward || {}), max_concurrency: max, kimi_max_concurrency: kimi };
          c.constraints = { ...(c.constraints || {}), model_fallback: fallback };
        });
        a.cfg.forward.max_concurrency = max; a.cfg.forward.kimi_max_concurrency = kimi; a.cfg.constraints.model_fallback = fallback;
        return { saved: true, account: a.key, max_concurrency: max, kimi_max_concurrency: kimi, model_fallback: fallback };
      }
      if (operation === 'models/family') {
        const a = pick(data);
        if (!['claude', 'gpt', 'deepseek', 'kimi'].includes(data.family) || typeof data.enabled !== 'boolean') throw denied('模型系列参数无效');
        const ids = (await catalogIds(b, a.cfg)).filter((id) => id.startsWith(data.family + '-'));
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
        if (typeof data.id !== 'string' || !/^(claude-|gpt-|deepseek-|kimi-)[\w./-]{1,160}$/.test(data.id) || typeof data.enabled !== 'boolean') throw denied('模型参数无效');
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
            message: r.ok ? '收到完整回复' : r.status === 503 ? '上游暂不可用或正在退避' : '测试未完成，请检查上游状态或超时' };
        } finally { testing = false; }
      }
      if (operation === 'login/start') {
        if (starting) throw denied('正在发起登录，请稍候');
        if (sessions.size >= 8) throw denied('待完成登录过多，请稍后重试');
        const provider = data.provider === undefined ? 'google' : data.provider;
        if (!['google', 'email'].includes(provider)) throw denied('登录方式只能选择 google 或 email');
        if (provider === 'email' && Date.now() < nextEmailAt) throw denied('发送验证码需间隔至少 60 秒');
        if ([...sessions.values()].some((s) => s.profile === data.profile && !['failed', 'saved'].includes(s.stage))) throw denied('这个 profile 已有待完成登录');
        const dir = profileDirectory(rootOf(cfg), data.profile);
        if (fs.existsSync(dir)) throw denied('该 profile 已存在，原账号不会被覆盖');
        // Empty form fields arrive as 0; treat them as "not specified".
        if (data.group_id === 0 || data.group_id === null) delete data.group_id;
        const hosted = data.hosted === true;
        const port = hosted ? cfg.listen.port : (data.port === undefined || data.port === 0 ? 8787 : data.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw denied('端口必须是 1024-65535 的整数');
        // sub2api will send user prompts and this profile's secret to public_base_url: allow only this host's own endpoints.
        // 托管账号复用本 bridge 的对外地址（sub2api 按密钥区分账号，不需要新地址）。
        const publicBase = hosted ? b.bridgeBaseUrl(cfg) : data.public_base_url;
        if (!hosted && ![`http://mirasim-${data.profile}:${port}`, `http://127.0.0.1:${port}`].includes(publicBase)) throw denied('桥接器地址只能是本机或同一 Docker 网络内的该 profile 地址');
        if (data.account_name !== undefined && (typeof data.account_name !== 'string' || !/^[\p{L}\p{N} _.@-]{1,64}$/u.test(data.account_name))) throw denied('账号名最多 64 个字符，只能包含文字、数字、空格和 _.@-');
        if (data.group_id !== undefined && (!Number.isInteger(data.group_id) || data.group_id < 1)) throw denied('分组 ID 必须是正整数');
        const { profileConfig } = require('../scripts/account-login');
        const profileCfg = profileConfig(cfg, data.profile, { 'account-name': data.account_name,
          'public-base-url': publicBase, 'group-id': data.group_id, port });
        profileCfg.forward.failure_log = path.join(dir, 'requests.log');
        starting = true;
        let capture;
        try {
        if (provider === 'email') nextEmailAt = Date.now() + 60000;
        capture = provider === 'email'
          ? await beginEmailLogin({ authUrl: cfg.relay.auth_url, email: data.email })
          : await beginLogin({ authUrl: cfg.relay.auth_url, provider });
        } finally { starting = false; }
        const id = crypto.randomBytes(24).toString('hex');
        const item = { capture, profile: data.profile, provider, email: data.email, hosted,
          expires: Date.now() + 15 * 60000, stage: 'waiting' };
        item.result = capture.result.then(async (tokens) => {
          item.stage = 'validating'; await verifyLogin(tokens);
          if (closed || ctx.shuttingDown || Date.now() > item.expires) throw denied('登录过期或服务正在停止');
          const credential = createCredential(tokens);
          fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
          fs.mkdirSync(dir, { mode: 0o700 });
          fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(profileCfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          item.stage = 'saved'; return { profile: data.profile, saved: true, hosted, account_name: profileCfg.sub2api.account_name };
        }).catch(() => { item.stage = 'failed'; throw denied('登录未完成或保存失败，原账号未修改'); }).finally(() => capture.close());
        item.result.catch(() => {}); sessions.set(id, item);
        return { id, url: capture.url, provider, hosted, expires_at: new Date(item.expires).toISOString() };
      }
      if (operation === 'login/complete' || operation === 'login/status') {
        const item = sessions.get(data.id);
        if (!item) throw denied('登录已过期或服务已重启，请重新发起');
        if (operation === 'login/status') return { stage: item.stage, profile: item.profile, provider: item.provider };
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
  } catch (err) { reply(400, { error: err.publicMessage || '操作失败，请检查服务状态和参数' }); }
}
module.exports = { createPanel, authorized, handle, page, ensurePanelKey };
