#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { profileDirectory, createCredential, startLogin, startEmailLogin, manualInput, listProfiles } = require('../lib/login');
const { RelayClient, request, readText } = require('../lib/relay');
const { DEFAULT_CONFIG, deepMerge, validateConfig } = require('../mirasim-bridge');

function profileConfig(base, name, flags) {
  const cfg = deepMerge(deepMerge({}, DEFAULT_CONFIG), base);
  delete cfg._config_path;
  cfg.backend = 'relay'; cfg.keepalive.enabled = false;
  cfg.window_keeper = { ...cfg.window_keeper, enabled: false, state_id: '' };
  cfg.relay.setting_json = 'setting.json';
  cfg.sub2api.account_name = flags['account-name'] || `${base.sub2api?.account_name || 'mirasim-cloud'}-${name}`;
  if (cfg.sub2api.account_name === base.sub2api?.account_name) throw Error('新账号必须使用不同的 sub2api 账号名');
  cfg.sub2api.public_base_url = flags['public-base-url'] || '';
  if (!cfg.sub2api.public_base_url) throw Error('请用 --public-base-url 指定新账号桥接器地址，避免覆盖原端点');
  cfg.listen.port = flags.port === undefined ? 8787 : Number(flags.port);
  if (flags['group-id'] !== undefined) cfg.sub2api.group_ids = [Number(flags['group-id'])];
  cfg.bridge_secret = crypto.randomBytes(32).toString('hex');
  cfg.forward.failure_log = 'requests.log';
  validateConfig(cfg);
  return cfg;
}

async function login(base, flags, { output = process.stdout } = {}) {
  if (base.backend !== 'relay') throw Error('独立账号登录需要 backend=relay');
  const root = path.dirname(path.resolve(base._config_path || path.join(__dirname, '../config.json')));
  const dir = profileDirectory(root, flags.profile);
  if (fs.existsSync(dir)) throw Error('profile 已存在；请使用新名称，原凭证不会被覆盖');
  const cfg = profileConfig(base, flags.profile, flags);
  cfg.forward.failure_log = path.join(dir, 'requests.log');
  if ((flags.provider || 'google') === 'email') {
    const readline = require('node:readline/promises');
    const input = readline.createInterface({ input: process.stdin, output });
    let capture;
    try {
      const email = (flags.email || await input.question('邮箱：')).trim();
      capture = await startEmailLogin({ authUrl: cfg.relay.auth_url, email });
      output.write('验证码已发送到邮箱。\n');
      const code = (await input.question('验证码：')).trim();
      const tokens = await capture.submit(code);
      const credential = createCredential(tokens);
      const response = await request(new URL(cfg.relay.auth_url.replace(/\/$/, '') + '/auth/me'), {
        headers: { authorization: 'Bearer ' + tokens.access }, totalTimeout: 15000 });
      await readText(response, 1024 * 1024);
      if (response.statusCode !== 200) throw Error(`登录凭证校验 HTTP ${response.statusCode}；原账号未修改`);
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 }); fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      output.write(`已保存独立 profile: ${flags.profile}；原账号和桌面配置未修改。\n新 sub2api 账号名: ${cfg.sub2api.account_name}\n`);
      return { profile: flags.profile, relay_ready: false };
    } finally { capture?.close(); input.close(); }
  }
  const capture = await startLogin({ authUrl: cfg.relay.auth_url, provider: flags.provider || 'google',
    port: flags['callback-port'] === undefined ? 0 : Number(flags['callback-port']) });
  const finishInput = manualInput((line) => {
    if (line === null) { capture.close(); return; }
    try { capture.accept(line); } catch (err) { output.write(err.message + '\n请重新粘贴本次登录的完整回调地址（输入隐藏）：\n'); }
  }, process.stdin, output);
  const cancel = () => capture.close();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  output.write(`请在浏览器的无痕窗口打开下面的地址，使用 ${flags.provider || 'google'} 登录新的 Mirasim 账号。无需退出桌面原账号。\n`
    + capture.url + '\n\n若服务器/容器的回调打不开，把浏览器最终地址粘贴到本终端并回车（输入隐藏）。\n不要把含 token 的回调地址发给别人。等待最多 15 分钟。\n');
  try {
    const tokens = await capture.result;
    const credential = createCredential(tokens);
    // Validate the actual authenticated identity before storing a login. Error
    // responses are never reflected into the terminal (may contain credentials).
    const response = await request(new URL(cfg.relay.auth_url.replace(/\/$/, '') + '/auth/me'), {
      headers: { authorization: 'Bearer ' + tokens.access }, totalTimeout: 15000 });
    await readText(response, 1024 * 1024);
    if (response.statusCode !== 200) throw Error(`登录凭证校验 HTTP ${response.statusCode}；原账号未修改`);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 }); // exclusive: another login cannot overwrite this one
    const credentialFile = path.join(dir, 'setting.json');
    fs.writeFileSync(credentialFile, JSON.stringify(credential, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // A relay availability problem must not discard a successful OAuth login.
    let relayReady = false;
    try {
      const relay = new RelayClient({ ...cfg.relay, setting_json: credentialFile });
      const res = await relay.request({ path: '/v1/models', signal: AbortSignal.timeout(20000) });
      const data = JSON.parse(await readText(res));
      relayReady = res.statusCode === 200 && (Array.isArray(data) || Array.isArray(data?.data) || Array.isArray(data?.models));
    } catch { /* report separately, retain new credential */ }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    output.write(`已保存独立 profile: ${flags.profile}；原账号和桌面配置未修改。\n新 sub2api 账号名: ${cfg.sub2api.account_name}\nrelay 检查: ${relayReady ? '通过' : '暂未通过，请使用新 profile 运行 doctor'}\n`);
    return { profile: flags.profile, relay_ready: relayReady };
  } finally {
    finishInput(); capture.close(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

module.exports = { profileConfig, login, listProfiles };
