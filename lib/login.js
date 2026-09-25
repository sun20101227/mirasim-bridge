'use strict';
// Independent OAuth session; never reads/writes the desktop setting.json and
// never calls logout/revoke. Reference: cpa-plugin-mirasim OAuth flow (MIT).
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { request, readText, validateEndpoint, parseCredential } = require('./relay');

function profileDirectory(root, name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw Error('profile 必须以小写字母开头，仅含字母/数字/_/-，最长 40 字符');
  return path.join(path.resolve(root), 'profiles', name);
}

function parseCallback(value, expected) {
  let u, target;
  try { u = new URL(value); target = new URL(expected); } catch { throw Error('无效的登录回调地址'); }
  if (u.origin !== target.origin || u.pathname !== target.pathname || u.username || u.password) throw Error('回调地址不属于本次登录');
  const q = u.searchParams;
  if (q.getAll('state').length !== 1 || q.get('state') !== target.searchParams.get('state')) throw Error('登录 state 不匹配');
  if (q.has('error')) throw Error('Mirasim 拒绝本次登录');
  const access = q.get('access_token'), refresh = q.get('refresh_token');
  const valid = (s) => typeof s === 'string' && s.length > 0 && s.length <= 65536 && !/[\s\0]/.test(s);
  if (q.getAll('access_token').length !== 1 || q.getAll('refresh_token').length !== 1 || !valid(access) || !valid(refresh)) throw Error('回调缺少有效且可续期的凭证');
  return { access, refresh };
}

function createCredential(tokens, now = Date.now()) {
  const key = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  const raw = { type: 'mirasim', access_token: tokens.access, refresh_token: tokens.refresh,
    device_private_key: key, expired: new Date(now + 30 * 60000).toISOString() };
  parseCredential(raw);
  return raw;
}

async function startLogin({ authUrl = 'https://auth.mirasim.ai', provider = 'google', timeoutMs = 15 * 60000, port = 0 } = {}) {
  if (provider === 'email') throw Error('邮箱登录请使用验证码流程');
  validateEndpoint(authUrl);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid OAuth callback port');
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw Error('Invalid OAuth provider');
  const discovery = await request(new URL(authUrl.replace(/\/$/, '') + '/auth/oauth/providers'), { totalTimeout: 10000 });
  const raw = await readText(discovery, 65536);
  let providers; try { providers = JSON.parse(raw).providers; } catch { /* below */ }
  if (discovery.statusCode !== 200 || !Array.isArray(providers) || !providers.includes(provider)) throw Error('Mirasim 当前未提供所选登录方式');
  let resolveResult, rejectResult, callback, used = false, timer;
  const result = new Promise((r, j) => { resolveResult = r; rejectResult = j; });
  // Attach a handler now: timeout may happen while an operator is reading output.
  result.catch(() => {});
  const accept = (value) => {
    if (used) throw Error('本次登录已结束');
    const tokens = parseCallback(value, callback);
    used = true; clearTimeout(timer); resolveResult(tokens); return true;
  };
  const server = http.createServer({ maxHeaderSize: 150000 }, (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET') { res.writeHead(405); return res.end('GET required'); }
    try { accept(new URL(req.url, new URL(callback).origin).href); res.end('登录凭证已收到，可以关闭此页面；请返回终端查看保存结果。'); }
    catch { res.writeHead(400); res.end('回调无效或已使用。请返回终端检查本次登录。'); }
  });
  server.headersTimeout = 15000; server.requestTimeout = 15000;
  await new Promise((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', r); });
  callback = `http://127.0.0.1:${server.address().port}/callback/${crypto.randomBytes(24).toString('hex')}?state=${crypto.randomBytes(32).toString('hex')}`;
  const url = new URL(authUrl.replace(/\/$/, '') + '/auth/oauth/' + provider + '/login');
  url.searchParams.set('redirect_uri', callback); url.searchParams.set('state', new URL(callback).searchParams.get('state'));
  timer = setTimeout(() => { used = true; rejectResult(Error('登录等待超时，请重新发起')); server.close(); server.closeAllConnections(); }, timeoutMs);
  return { url: url.href, callback, result, accept,
    close() { clearTimeout(timer); if (!used) { used = true; rejectResult(Error('登录已取消')); } server.close(); server.closeAllConnections(); } };
}

function validEmail(value) {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function authJson(authUrl, route, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const response = await request(new URL(authUrl.replace(/\/$/, '') + route), {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length }, body,
    headersTimeout: 15000, idleTimeout: 15000, totalTimeout: 20000,
  });
  const raw = await readText(response, 128 * 1024);
  let data = null;
  try { data = JSON.parse(raw); } catch { /* use a generic error below */ }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const err = Error(`Mirasim 邮箱登录请求 HTTP ${response.statusCode}`);
    err.status = response.statusCode; throw err;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Mirasim 邮箱登录响应格式错误');
  return data;
}

// The desktop client uses /auth/code and /auth/verify for email OTP login;
// this is separate from /auth/oauth/providers and the browser callback flow.
async function startEmailLogin({ authUrl = 'https://auth.mirasim.ai', email, timeoutMs = 15 * 60000 } = {}) {
  validateEndpoint(authUrl);
  if (!validEmail(email)) throw Error('请输入有效邮箱地址');
  await authJson(authUrl, '/auth/code', { email });
  let used = false, timer, submitting = false, attempts = 0;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});
  const submit = async (code) => {
    if (used) throw Error('本次邮箱登录已结束');
    if (submitting) throw Error('验证码正在校验');
    if (attempts >= 5) { used = true; clearTimeout(timer); rejectResult(Error('验证码尝试过多')); throw Error('验证码尝试过多，请重新发起'); }
    if (typeof code !== 'string' || !/^\d{4,12}$/.test(code.trim())) throw Error('验证码格式无效');
    submitting = true; attempts++;
    try {
    const data = await authJson(authUrl, '/auth/verify', { email, code: code.trim() });
    if (used) throw Error('本次邮箱登录已结束');
    if (typeof data.access_token !== 'string' || !data.access_token || /[\s\0]/.test(data.access_token)) {
      throw Error('邮箱登录响应缺少 access_token');
    }
    used = true; clearTimeout(timer);
    resolveResult({ access: data.access_token, refresh: typeof data.refresh_token === 'string' ? data.refresh_token : undefined });
    return { access: data.access_token, refresh: typeof data.refresh_token === 'string' ? data.refresh_token : undefined };
    } finally { submitting = false; }
  };
  timer = setTimeout(() => { used = true; rejectResult(Error('邮箱验证码登录等待超时，请重新发送')); }, timeoutMs);
  return {
    email, result, submit,
    close() { clearTimeout(timer); if (!used) { used = true; rejectResult(Error('邮箱登录已取消')); } },
  };
}

// Hide pasted token URL in an interactive terminal; do not put it in shell history.
function manualInput(onLine, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return () => {};
  let line = '';
  const wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  const handle = (data) => {
    for (const c of data.toString('utf8')) {
      if (c === '\u0003') { onLine(null); return; }
      if (c === '\r' || c === '\n') { if (line) { const value = line; line = ''; output.write('\n'); onLine(value); } }
      else if (c === '\u007f' || c === '\b') line = line.slice(0, -1);
      else if (c >= ' ' && line.length < 150000) line += c;
    }
  };
  input.on('data', handle);
  return () => { line = ''; input.removeListener('data', handle); input.setRawMode(Boolean(wasRaw)); input.pause(); };
}

function listProfiles(root) {
  const directory = path.join(root, 'profiles');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter((f) => f.isDirectory() && /^[a-z][a-z0-9_-]{0,39}$/.test(f.name)).map((f) => {
    const dir = profileDirectory(root, f.name);
    return { profile: f.name, credential_saved: fs.existsSync(path.join(dir, 'setting.json')), configured: fs.existsSync(path.join(dir, 'config.json')) };
  });
}
module.exports = { profileDirectory, parseCallback, createCredential, startLogin, startEmailLogin, validEmail, manualInput, listProfiles };
