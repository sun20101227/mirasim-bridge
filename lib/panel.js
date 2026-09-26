'use strict';
// Privileged operations require a volume-only key, separate from inference keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startLogin, startEmailLogin, createCredential, profileDirectory, listProfiles } = require('./login');
const { request, readText } = require('./relay');

const rootOf = (cfg) => path.dirname(path.resolve(cfg._config_path || process.env.MIRASIM_CONFIG || 'config.json'));
const denied = (message) => Object.assign(Error(message), { publicMessage: message });
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
  let lastTest = 0, testing = false, nextEmailAt = 0, starting = false, closed = false;
  const file = path.resolve(cfg._config_path || path.join(rootOf(cfg), 'config.json'));
  const clean = () => {
    for (const [id, item] of sessions) if (Date.now() > item.expires) { item.capture.close(); sessions.delete(id); }
  };
  return {
    close() { closed = true; for (const item of sessions.values()) item.capture.close(); sessions.clear(); },
    async call(operation, data = {}) {
      clean();
      if (closed || ctx.shuttingDown) throw denied('服务正在停止');
      ensurePanelKey(cfg);
      if (cfg.backend !== 'relay') throw denied('网页账号管理需要 relay 后端');
      if (operation === 'status') return { version: b.VERSION || null, quota: ctx.quota || { available: false, stale: true }, schedulable: ctx.sm?.desired || 'unmanaged', reachable: Boolean(ctx.reachable), inflight: ctx.inflight, kimi_inflight: ctx.kimiInflight || 0, uptime_sec: Math.round((Date.now() - ctx.startedAt) / 1000),
        sub2api_codex: ctx.codex?.sm ? { managed: true, reachable: Boolean(ctx.codex.reachable), schedulable: ctx.codex.sm.desired } : { managed: false },
        counters: ctx.counters, last_stream_error: ctx.lastStreamError || null, last_fallback: ctx.lastFallback || null, model_fallback: cfg.constraints.model_fallback, backoff_sec_left: Math.max(0, Math.ceil(((ctx.backoffUntil || 0) - Date.now()) / 1000)) };
      if (operation === 'summary') return {
        account_name: cfg.sub2api.account_name, group_ids: cfg.sub2api.group_ids,
        public_base_url: cfg.sub2api.public_base_url, max_concurrency: cfg.forward.max_concurrency, kimi_max_concurrency: cfg.forward.kimi_max_concurrency, model_fallback: cfg.constraints.model_fallback,
        disabled_models: cfg.constraints.disabled_models,
      };
      if (operation === 'profiles') return listProfiles(rootOf(cfg));
      if (operation === 'profile/info') {
        const dir = profileDirectory(rootOf(cfg), data.profile);
        const p = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
        if (!fs.existsSync(path.join(dir, 'setting.json'))) throw denied('凭证尚未保存');
        return { profile: data.profile, public_base_url: p.sub2api.public_base_url, port: p.listen.port };
      }
      if (operation === 'groups') {
        const result = await b.s2.listGroups(cfg);
        const rows = Array.isArray(result) ? result : result?.items || result?.data || [];
        return rows.map((g) => ({ id: g.id, name: g.name, platform: g.platform }));
      }
      if (operation === 'models') {
        const response = await b.getRelay(cfg).request({ path: '/v1/models', signal: AbortSignal.timeout(15000) });
        const parsed = JSON.parse(await readText(response));
        const rows = Array.isArray(parsed) ? parsed : parsed.data || parsed.models;
        if (response.statusCode !== 200 || !Array.isArray(rows)) throw denied('上游模型目录暂不可用');
        const ids = [...new Set(rows.map((m) => typeof m === 'string' ? m : m.id || m.model_id).filter((id) => typeof id === 'string'))];
        return ids.filter((id) => /^(claude-|gpt-|deepseek-|kimi-)/.test(id)).map((id) => ({
          id, family: b.modelFamily(id), enabled: b.isModelAllowed(id, cfg),
          disabled: cfg.constraints.disabled_models.includes(id),
          note: id.startsWith('deepseek-') ? '历史测试：上游无可用容量' : id.startsWith('kimi-') ? '上游可能慢响应，默认并发 1' : '',
        }));
      }
      // Persist onto the on-disk file only: in-memory cfg may hold env-injected secrets (admin key, bridge_secret).
      const persist = (mutate) => {
        const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')); mutate(onDisk);
        const next = b.deepMerge({}, cfg); mutate(next); b.validateConfig(next); atomicConfig(file, onDisk);
      };
      if (operation === 'settings') {
        // Conservative ceiling: high concurrency on one Mira account is the main automated-abuse signal.
        const read = (v, name) => { if (!Number.isInteger(v) || v < 1 || v > 16) throw denied(name + '必须是 1-16 的整数'); return v; };
        const max = read(data.max_concurrency, '总并发'), kimi = read(data.kimi_max_concurrency, 'Kimi 并发');
        if (kimi > max) throw denied('Kimi 并发不能超过总并发');
        const fallback = data.model_fallback === undefined ? cfg.constraints.model_fallback : data.model_fallback;
        if (!['observe', 'forbid'].includes(fallback)) throw denied('模型替换策略只能是 observe 或 forbid');
        persist((c) => {
          c.forward = { ...(c.forward || {}), max_concurrency: max, kimi_max_concurrency: kimi };
          c.constraints = { ...(c.constraints || {}), model_fallback: fallback };
        });
        cfg.forward.max_concurrency = max; cfg.forward.kimi_max_concurrency = kimi; cfg.constraints.model_fallback = fallback;
        return { saved: true, max_concurrency: max, kimi_max_concurrency: kimi, model_fallback: fallback };
      }
      if (operation === 'models/family') {
        if (!['claude', 'gpt', 'deepseek', 'kimi'].includes(data.family) || typeof data.enabled !== 'boolean') throw denied('模型系列参数无效');
        const response = await b.getRelay(cfg).request({ path: '/v1/models', signal: AbortSignal.timeout(15000) });
        const parsed = JSON.parse(await readText(response));
        const rows = Array.isArray(parsed) ? parsed : parsed.data || parsed.models;
        if (response.statusCode !== 200 || !Array.isArray(rows)) throw denied('上游模型目录暂不可用');
        const ids = rows.map((m) => typeof m === 'string' ? m : m.id || m.model_id).filter((id) => typeof id === 'string' && id.startsWith(data.family + '-') && id.length <= 180);
        if (!ids.length) throw denied('上游目录中没有这个系列的模型');
        const disabled = new Set(cfg.constraints.disabled_models);
        for (const id of ids) data.enabled ? disabled.delete(id) : disabled.add(id);
        persist((c) => { c.constraints = { ...(c.constraints || {}), disabled_models: [...disabled] }; });
        cfg.constraints.disabled_models = [...disabled];
        ctx.reachable = false;
        return { saved: true, sync_pending: true, changed: ids.length };
      }
      if (operation === 'model') {
        if (typeof data.id !== 'string' || !/^(claude-|gpt-|deepseek-|kimi-)[\w./-]{1,160}$/.test(data.id) || typeof data.enabled !== 'boolean') throw denied('模型参数无效');
        const disabled = new Set(cfg.constraints.disabled_models);
        data.enabled ? disabled.delete(data.id) : disabled.add(data.id);
        persist((c) => { c.constraints = { ...(c.constraints || {}), disabled_models: [...disabled] }; });
        cfg.constraints.disabled_models = [...disabled];
        ctx.reachable = false; // The next health tick persists and verifies the new sub2 model mapping.
        return { saved: true, sync_pending: true };
      }
      if (operation === 'test') {
        if (typeof data.id !== 'string' || !/^[\w./-]{1,180}$/.test(data.id) || !b.isModelAllowed(data.id, cfg)) throw denied('模型未启用或名称无效');
        if (testing || Date.now() - lastTest < 10000) throw denied('模型测试正在进行或冷却中，请稍后重试');
        testing = true; lastTest = Date.now();
        try {
          const r = await b.checkDiagnosticModel(b.diagnosticTarget(cfg), data.id, { flags: { 'timeout-sec': 30, 'max-tokens': 128 } });
          return { model: data.id, ok: r.ok, status: r.status, elapsed_ms: r.elapsed_ms, ttfb_ms: r.ttfb_ms,
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
        const port = data.port === undefined || data.port === 0 ? 8787 : data.port;
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw denied('端口必须是 1024-65535 的整数');
        // sub2api will send user prompts and this profile's secret to public_base_url: allow only this host's own endpoints.
        if (![`http://mirasim-${data.profile}:${port}`, `http://127.0.0.1:${port}`].includes(data.public_base_url)) throw denied('桥接器地址只能是本机或同一 Docker 网络内的该 profile 地址');
        if (data.account_name !== undefined && (typeof data.account_name !== 'string' || !/^[\p{L}\p{N} _.@-]{1,64}$/u.test(data.account_name))) throw denied('账号名最多 64 个字符，只能包含文字、数字、空格和 _.@-');
        if (data.group_id !== undefined && (!Number.isInteger(data.group_id) || data.group_id < 1)) throw denied('分组 ID 必须是正整数');
        const { profileConfig } = require('../scripts/account-login');
        const profileCfg = profileConfig(cfg, data.profile, { 'account-name': data.account_name,
          'public-base-url': data.public_base_url, 'group-id': data.group_id, port });
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
        const item = { capture, profile: data.profile, provider, email: data.email,
          expires: Date.now() + 15 * 60000, stage: 'waiting' };
        item.result = capture.result.then(async (tokens) => {
          item.stage = 'validating'; await verifyLogin(tokens);
          if (closed || ctx.shuttingDown || Date.now() > item.expires) throw denied('登录过期或服务正在停止');
          const credential = createCredential(tokens);
          fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
          fs.mkdirSync(dir, { mode: 0o700 });
          fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(profileCfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          item.stage = 'saved'; return { profile: data.profile, saved: true };
        }).catch(() => { item.stage = 'failed'; throw denied('登录未完成或保存失败，原账号未修改'); }).finally(() => capture.close());
        item.result.catch(() => {}); sessions.set(id, item);
        return { id, url: capture.url, provider, expires_at: new Date(item.expires).toISOString() };
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
