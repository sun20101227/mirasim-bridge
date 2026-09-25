#!/usr/bin/env node
'use strict';

/**
 * mirasim-bridge.js —— Mirasim → sub2api 桥接器
 *
 * session：进程发现、会话保活、Messages 转发。
 * relay：设备签名直连、凭证刷新、Messages / GPT Responses / quota。
 * 两种后端共用入站鉴权、限流、sub2api 注册与健康调度。
 *
 * 设计约束提醒（详见 DESIGN.md）：
 *   - §7-7  按 PID 收窄，绝不全端口扫——避免给同机无关服务发垃圾请求
 *   - §2.4  桥接器自身故障用 503，避免上游认证码误禁用 sub2api 账号
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { RelayClient, loadCredential, validateEndpoint, request: httpRequest } = require('./lib/relay');
const { normalizeResponses, aggregateResponses } = require('./lib/responses');
const { summarizeLimits, quotaNote, mergeQuotaNote } = require('./lib/quota');
const { pipeEvents } = require('./lib/sse');
const VERSION = '0.6.0';
const IS_WIN = process.platform === 'win32';

/**
 * 自排除标记。
 *
 * Linux 上进程匹配是拿 /proc/<pid>/cmdline 比对的，而本脚本的 cmdline 是
 * `node .../mirasim-bridge.js observe`——它自己就含有 'mirasim'，会自命中，
 * 把桥接器自己当成 Mirasim 进程（Windows 侥幸躲过：进程名是 node、路径不含 mirasim）。
 * 顺带也排除同时在跑的另一个桥接器实例（例如一个终端跑 observe、另一个跑 serve）。
 */
const SELF_SCRIPT = path.basename(__filename, '.js');   // 'mirasim-bridge'

// ---------------------------------------------------------------------------
// 1. 配置
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  // Existing configurations keep the session backend. New Linux installs use relay.
  backend: 'session',
  relay: {
    url: 'https://relay.mirasim.ai', auth_url: 'https://auth.mirasim.ai',
    setting_json: '', client_version: '0.0.354', collect: false, locale: '',
    seal_public_key: '',
  },
  listen: { host: '127.0.0.1', port: 8787 },
  sub2api: {
    base_url: '',
    admin_api_key: '',
    account_name: 'mirasim-cloud',
    group_ids: [],
    priority: 0,
    concurrency: 2,
    public_base_url: '',
    manage_existing_groups: false,
  },
  bridge_secret: '',
  quota: { enabled: true, interval_sec: 300, sync_notes: true },
  diagnostics: { timeout_sec: 30, max_tokens: 128 },
  health: { interval_sec: 30, fail_threshold: 2, success_threshold: 2, min_dwell_sec: 60 },
  forward: {
    replay_buffer_mb: 8,
    // 保守起步：单会话代理的并发能力未测，且高并发最容易触发上游的滥用阈值。
    // 观察稳定后再往上调，别一上来就放开。
    max_concurrency: 2,
    // 上游 4xx 失败时把请求/响应载荷落盘（截断 1500 字符）——relay 的含混 400
    // 不指名字段，没有载荷对照根本没法排。mira-bridge 的约束全是这么找出来的。
    // 日志含对话内容，别外传，已加进 .gitignore。
    log_failures: false,
    failure_log: 'requests.log',
    upstream_headers_timeout_ms: 60000,
    upstream_idle_timeout_ms: 300000,
    kimi_max_concurrency: 1,
  },
  // 上游报错后的退避。目的是不制造错误风暴——被自动风控扫到的多是错误率，不是总量。
  backoff: { on_429_sec: 60, on_529_sec: 30, max_sec: 600 },
  // 上游（relay）不写在任何文档里的请求体约束，踩中一律回同一句含混的 400
  // "The request was rejected as invalid."。约束目录见 DESIGN.md §1.2。
  constraints: {
    // 正则：只有匹配的模型才下发采样参数，其余一律剥离（等价 temperature=1）。
    // 旧版实测只有 haiku 接受；2026-09-25 复核发现 haiku 的 temperature=0.8 也被拒了
    //（自愈重试兜住才开始怀疑，日志确认）。默认空串 = 全部剥离，交给上游去演化。
    sampling_models: '',
    model_filter: '^(claude-|gpt-|deepseek-|kimi-)', // Messages 支持四系列；relay 另提供 GPT Responses
    model_block: 'fable',       // 黑名单正则：不发往上游、不出现在 /v1/models。空串放行全部
    default_max_tokens: 8192,   // max_tokens 缺失 / 0 / 负数时回落到这个值
    disabled_models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    kimi_default_effort: 'low',
  },
  keepalive: {
    enabled: true,
    server_cjs: '',                                  // 留空按平台推断
    respawn_backoff_sec: [5, 15, 45, 120, 300],
    ready_timeout_sec: 60,
    // 进程活着不代表凭证活着：relay 侧令牌失效时 local proxy 全回 401，
    // 进程不退、天然不会触发重启。连续这么多次上游 401 就主动重启会话换新凭证。
    authfail_respawn_threshold: 3,
  },
  shutdown: { drain_timeout_sec: 30, total_timeout_sec: 150 },
  port_policy: 'sticky',
  // 阶段 0 专用
  discovery: {
    process_match: ['mirasim'],   // 进程名 / 可执行文件路径的匹配子串（大小写不敏感）
    // 探测超时不能太短：上游繁忙时 /v1/models 也会变慢，1~2 秒容易误判「端点没了」，
    // 进而误触发 PAUSE。mira-bridge 实测 5 秒才稳（它的早期版本就在这踩过）。
    probe_timeout_ms: 5000,
    probe_concurrency: 16,
    probe_path: '/v1/models',
  },
  observe: {
    interval_sec: 5,
    out: 'timeline.jsonl',
    heartbeat_sec: 300,           // 静默期心跳，区分「没事发生」与「观测器死了」
    log_all_ports: true,          // 记录全部 LISTEN 端口的增减，不只是 proxy 端口
    track_agents: true,           // 跟踪 Mirasim 拉起的 CLI 进程（见下方说明）
  },
};

/**
 * Agent 凭证的真实传递机制【2026-08-28 本机实测确定】
 *
 * Mirasim 拉起 CLI 时**不是**把 env 内联进命令行，而是：
 *   1. 写一个临时设置文件 `%TEMP%/mirasim-claude-settings-<hash>.json`
 *      内容形如 {"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:<port>",
 *                       "ANTHROPIC_AUTH_TOKEN":"<43 字符>","ANTHROPIC_API_KEY":""}}
 *   2. 命令行上只出现 `--settings <该文件路径>`
 *
 * 实测样本：`claude.EXE -p ... --settings C:\...\Temp\mirasim-claude-settings-8ec9….json ...`
 *
 * ⚠️ 这些临时文件**在会话结束后不会被清理**（本机 TEMP 里留着 7 个历史文件）。
 * 所以必须「活进程 → 它命令行上的路径 → 该文件」这样反查，
 * 绝不能直接挑 TEMP 里最新的文件——那会读到一个早已失效的 token。
 */
const AGENT_SETTINGS_RE = /mirasim-[A-Za-z0-9_-]*settings[A-Za-z0-9_.-]*\.json/i;
const AGENT_ENV_MARKER = 'ANTHROPIC_BASE_URL';   // 备用通道：个别启动方式可能内联

function tokenFingerprint(tok) {
  if (!tok) return null;
  return crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
    // plainObject 总是深拷贝——否则 out 会和 patch 共享嵌套对象的引用，
    // 改 out 的嵌套字段会隔空改到 patch（实测中过：tcfgHaiku 改掉了 DEFAULT_CONFIG）
    if (isPlainObject(v)) out[k] = deepMerge(isPlainObject(out[k]) ? out[k] : {}, v);
    else if (v !== undefined) out[k] = Array.isArray(v) ? v.map((x) => isPlainObject(x) ? deepMerge({}, x) : x) : v;
  }
  return out;
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

function loadConfig(args) {
  let cfg = deepMerge({}, DEFAULT_CONFIG);

  // --config <path>，缺省为脚本目录下的 config.json（不存在则跳过，不报错）
  const explicit = typeof args.flags.config === 'string' ? args.flags.config : null;
  const cfgPath = explicit || path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!isPlainObject(parsed)) throw new Error('config must be an object');
      cfg = deepMerge(cfg, parsed);
      cfg._config_path = cfgPath;
    } catch (err) {
      fatal(`配置文件读取失败或不是有效的 JSON 对象: ${cfgPath}`);
    }
  } else if (explicit) {
    fatal(`--config 指定的文件不存在: ${cfgPath}`);
  }

  // 环境变量覆盖（命名对齐 sub2api 自带的 admin 脚本，见 DESIGN.md §4）
  const env = process.env;
  if (env.SUB2API_BASE_URL) cfg.sub2api.base_url = env.SUB2API_BASE_URL;
  if (env.SUB2API_ADMIN_API_KEY) cfg.sub2api.admin_api_key = env.SUB2API_ADMIN_API_KEY;
  if (env.MIRASIM_ACCOUNT_NAME) cfg.sub2api.account_name = env.MIRASIM_ACCOUNT_NAME;
  if (env.MIRASIM_LISTEN_HOST) cfg.listen.host = env.MIRASIM_LISTEN_HOST;
  if (env.MIRASIM_LISTEN_PORT) cfg.listen.port = Number(env.MIRASIM_LISTEN_PORT);
  if (env.MIRASIM_BRIDGE_SECRET) cfg.bridge_secret = env.MIRASIM_BRIDGE_SECRET;

  validateConfig(cfg);

  return cfg;
}

function validateConfig(cfg) {
  if (!['session', 'relay'].includes(cfg.backend)) throw new Error('backend 必须是 session 或 relay');
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (isPlainObject(DEFAULT_CONFIG[key]) && !isPlainObject(cfg[key])) throw new Error(`配置 ${key} 必须是对象`);
  }
  const positive = [
    ['listen.port', cfg.listen.port, 65535],
    ['forward.max_concurrency', cfg.forward.max_concurrency, 1024],
    ['forward.kimi_max_concurrency', cfg.forward.kimi_max_concurrency, 1024],
    ['forward.replay_buffer_mb', cfg.forward.replay_buffer_mb, 1024],
    ['forward.upstream_headers_timeout_ms', cfg.forward.upstream_headers_timeout_ms, 3600000],
    ['forward.upstream_idle_timeout_ms', cfg.forward.upstream_idle_timeout_ms, 3600000],
    ['health.interval_sec', cfg.health.interval_sec, 86400],
    ['health.fail_threshold', cfg.health.fail_threshold, 1000],
    ['health.success_threshold', cfg.health.success_threshold, 1000],
    ['discovery.probe_timeout_ms', cfg.discovery.probe_timeout_ms, 3600000],
    ['discovery.probe_concurrency', cfg.discovery.probe_concurrency, 1024],
    ['keepalive.ready_timeout_sec', cfg.keepalive.ready_timeout_sec, 3600],
    ['keepalive.authfail_respawn_threshold', cfg.keepalive.authfail_respawn_threshold, 1000],
    ['sub2api.concurrency', cfg.sub2api.concurrency, 1024],
    ['shutdown.drain_timeout_sec', cfg.shutdown.drain_timeout_sec, 86400],
    ['shutdown.total_timeout_sec', cfg.shutdown.total_timeout_sec, 86400],
  ];
  for (const [name, value, max] of positive) {
    if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`配置 ${name} 必须是 1..${max} 的整数`);
  }
  for (const value of [cfg.health.min_dwell_sec, ...Object.values(cfg.backoff)]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('退避/驻留时间必须是非负数');
  }
  if (!Array.isArray(cfg.keepalive.respawn_backoff_sec) || !cfg.keepalive.respawn_backoff_sec.length
      || cfg.keepalive.respawn_backoff_sec.some((n) => !Number.isFinite(n) || n < 1)) throw new Error('respawn_backoff_sec 必须是非空正数数组');
  if (!Array.isArray(cfg.sub2api.group_ids) || cfg.sub2api.group_ids.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('group_ids 必须是正整数数组');
  if (typeof cfg.sub2api.manage_existing_groups !== 'boolean') throw new Error('manage_existing_groups 必须是布尔值');
  for (const key of ['model_filter', 'model_block', 'sampling_models']) {
    if (typeof cfg.constraints[key] !== 'string') throw new Error(`constraints.${key} 必须是字符串`);
    if (cfg.constraints[key]) new RegExp(cfg.constraints[key]);
  }
  for (const value of [cfg.sub2api.base_url, cfg.sub2api.public_base_url]) {
    if (!value) continue;
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('服务地址必须是无凭据、查询参数和片段的 HTTP(S) URL');
  }
  if (typeof cfg.bridge_secret !== 'string' || typeof cfg.listen.host !== 'string' || !cfg.listen.host) throw new Error('bridge_secret/listen.host 类型错误');
  if (typeof cfg.keepalive.enabled !== 'boolean' || typeof cfg.forward.log_failures !== 'boolean') throw new Error('keepalive.enabled / forward.log_failures 必须是布尔值');
  validateEndpoint(cfg.relay.url); validateEndpoint(cfg.relay.auth_url);
  if (typeof cfg.relay.collect !== 'boolean' || typeof cfg.relay.setting_json !== 'string') throw new Error('relay.collect/setting_json 类型错误');
  if (typeof cfg.relay.client_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(cfg.relay.client_version)) throw new Error('relay.client_version 必须是三段版本号');
  if (typeof cfg.relay.locale !== 'string' || cfg.relay.locale.length > 128 || /[\r\n\0]/.test(cfg.relay.locale)) throw new Error('relay.locale 无效');
  if (cfg.shutdown.total_timeout_sec <= cfg.shutdown.drain_timeout_sec) throw new Error('shutdown.total_timeout_sec 必须大于 drain_timeout_sec');
  if (!Array.isArray(cfg.constraints.disabled_models) || cfg.constraints.disabled_models.some((s) => typeof s !== 'string' || !s.trim())) throw new Error('disabled_models 必须是模型 ID 数组');
  if (!['', 'low', 'high', 'max'].includes(cfg.constraints.kimi_default_effort)) throw new Error('kimi_default_effort 必须为空/low/high/max');
  if (typeof cfg.quota.enabled !== 'boolean' || typeof cfg.quota.sync_notes !== 'boolean' || !Number.isInteger(cfg.quota.interval_sec) || cfg.quota.interval_sec < 60) throw new Error('quota 需要布尔开关和至少 60 秒的同步间隔');
  if (!Number.isInteger(cfg.diagnostics.timeout_sec) || cfg.diagnostics.timeout_sec < 1 || cfg.diagnostics.timeout_sec > 600 || !Number.isInteger(cfg.diagnostics.max_tokens) || cfg.diagnostics.max_tokens < 1 || cfg.diagnostics.max_tokens > 8192) throw new Error('diagnostics 超时/输出预算无效');
  if (!Number.isInteger(cfg.constraints.default_max_tokens) || cfg.constraints.default_max_tokens < 1) throw new Error('default_max_tokens 必须是正整数');
}

const relayClients = new WeakMap();
function relaySettingPath(cfg) {
  const file = cfg.relay.setting_json;
  return file ? path.resolve(path.dirname(cfg._config_path || path.join(__dirname, 'config.json')), file)
    : path.join(os.homedir(), '.mirasim', 'setting.json');
}
function getRelay(cfg) {
  if (!relayClients.has(cfg)) relayClients.set(cfg, new RelayClient({ ...cfg.relay, setting_json: relaySettingPath(cfg) }));
  return relayClients.get(cfg);
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  process.stdout.write(`[${ts()}] ${msg}\n`);
}

function warn(msg) {
  process.stdout.write(`[${ts()}] WARN ${msg}\n`);
}

function fatal(msg) {
  process.stderr.write(`[${ts()}] FATAL ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. 端口发现
// ---------------------------------------------------------------------------

/** 清洗用户提供的匹配串，避免拼进 PowerShell 后被当代码执行 */
function sanitizePattern(p) {
  return String(p).replace(/[^A-Za-z0-9_@.\-]/g, '');
}

function runPowerShell(script) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 20000 }
  );
}

function parsePsJson(raw) {
  const t = (raw || '').trim();
  if (!t) return [];
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    return [];
  }
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Windows：定位 Mirasim 进程。先用快的 Get-Process，无果再退回 Win32_Process（能看到命令行）。 */
function winFindProcesses(patterns) {
  const pats = patterns.map(sanitizePattern).filter(Boolean);
  if (!pats.length) return [];
  const psList = pats.map((p) => `'${p}'`).join(',');

  const fast = `
$ErrorActionPreference = 'SilentlyContinue'
$pats = @(${psList})
$r = Get-Process | Where-Object {
  $n = $_.ProcessName; $pp = $_.Path
  $hit = $false
  foreach ($pat in $pats) {
    if ($n -like "*$pat*") { $hit = $true }
    elseif ($pp -and $pp -like "*$pat*") { $hit = $true }
  }
  $hit
} | Select-Object @{n='pid';e={$_.Id}}, @{n='name';e={$_.ProcessName}}, @{n='exe';e={$_.Path}}
ConvertTo-Json -Compress -Depth 3 -InputObject @($r)`;

  let procs = [];
  try {
    procs = parsePsJson(runPowerShell(fast));
  } catch (err) {
    warn(`Get-Process 失败: ${err.message}`);
  }
  if (procs.length) return procs;

  const slow = `
$ErrorActionPreference = 'SilentlyContinue'
$pats = @(${psList})
$r = Get-CimInstance Win32_Process | Where-Object {
  $n = $_.Name; $pp = $_.ExecutablePath; $cl = $_.CommandLine
  $hit = $false
  foreach ($pat in $pats) {
    if ($n -like "*$pat*") { $hit = $true }
    elseif ($pp -and $pp -like "*$pat*") { $hit = $true }
    elseif ($cl -and $cl -like "*$pat*") { $hit = $true }
  }
  $hit
} | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='name';e={$_.Name}}, @{n='exe';e={$_.ExecutablePath}}
ConvertTo-Json -Compress -Depth 3 -InputObject @($r)`;

  try {
    return parsePsJson(runPowerShell(slow));
  } catch (err) {
    warn(`Win32_Process 查询失败: ${err.message}`);
    return [];
  }
}

/** Windows：取指定 PID 集合的 LISTEN 端口。Get-NetTCPConnection 不可用时退回 netstat -ano。 */
function winListenPorts(pids) {
  if (!pids.length) return [];
  const pidList = pids.join(',');
  const script = `
$ErrorActionPreference = 'Stop'
$pids = @(${pidList})
$r = Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } |
  Select-Object @{n='addr';e={$_.LocalAddress}}, @{n='port';e={$_.LocalPort}}, @{n='pid';e={$_.OwningProcess}}
ConvertTo-Json -Compress -Depth 3 -InputObject @($r)`;

  try {
    return parsePsJson(runPowerShell(script));
  } catch {
    // 老系统没有 Get-NetTCPConnection
    return winListenPortsNetstat(pids);
  }
}

function winListenPortsNetstat(pids) {
  const want = new Set(pids.map(Number));
  let raw;
  try {
    raw = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 20000,
    });
  } catch (err) {
    warn(`netstat 回退失败: ${err.message}`);
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!m) continue;
    const pid = Number(m[2]);
    if (!want.has(pid)) continue;
    const idx = m[1].lastIndexOf(':');
    if (idx === -1) continue;
    let addr = m[1].slice(0, idx);
    if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
    out.push({ addr, port: Number(m[1].slice(idx + 1)), pid });
  }
  return out;
}

/** Linux：扫 /proc 找匹配的进程 */
function linuxFindProcesses(patterns) {
  const pats = patterns.map((p) => String(p).toLowerCase()).filter(Boolean);
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (err) {
    warn(`读取 /proc 失败: ${err.message}`);
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    let cmdline = '';
    let exe = '';
    try {
      cmdline = fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch { /* 进程已退出或无权限 */ }
    try {
      exe = fs.readlinkSync(`/proc/${e}/exe`);
    } catch { /* 同上 */ }
    const hay = `${cmdline} ${exe}`.toLowerCase();
    if (!hay.trim()) continue;
    if (hay.includes(SELF_SCRIPT)) continue;          // 桥接器自己 / 另一个桥接器实例
    if (pats.some((p) => hay.includes(p))) {
      out.push({ pid, name: path.basename(exe || cmdline.split(' ')[0] || ''), exe: exe || null });
    }
  }
  return out;
}

/**
 * Linux：收集这些 PID 持有的 socket inode。
 *
 * /proc/<pid>/fd 只有同用户（或 root/CAP_SYS_PTRACE）能读。桥接器若以独立服务用户
 * 跑 systemd，这里会全线 EACCES——必须把它和「Mirasim 没启动」区分开，
 * 否则排障时看到的现象一模一样（都是「没找到端口」）。
 */
function linuxSocketInodes(pids) {
  const inodes = new Map(); // inode -> pid
  let denied = 0;
  for (const pid of pids) {
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') denied++;
      continue; // 无权限或进程已退出
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = target.match(/^socket:\[(\d+)\]$/);
      if (m) inodes.set(m[1], pid);
    }
  }
  return { inodes, denied };
}

/** /proc/net/tcp 的 local_address 是小端十六进制 */
function hexToIPv4(hex) {
  const b = [];
  for (let i = 0; i < 8; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

function hexToIPv6(hex) {
  // 4 个 32 位组，每组内部小端
  const bytes = [];
  for (let g = 0; g < 4; g++) {
    const grp = hex.slice(g * 8, g * 8 + 8);
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(grp.slice(i, i + 2), 16));
  }
  if (bytes.every((v) => v === 0)) return '::';
  if (bytes.slice(0, 15).every((v) => v === 0) && bytes[15] === 1) return '::1';
  // IPv4-mapped ::ffff:a.b.c.d
  if (bytes.slice(0, 10).every((v) => v === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return parts.join(':');
}

/**
 * 解析 /proc/net/tcp{,6} 的文本。独立成函数是为了能在非 Linux 机器上用
 * 合成数据验证——见 `selftest` 子命令。
 * 字段序：sl(0) local(1) rem(2) st(3) tx:rx(4) tr:tm(5) retrnsmt(6) uid(7) timeout(8) inode(9)
 */
function parseProcNetTcpText(raw, v6, inodes, out) {
  const lines = String(raw).split('\n').slice(1); // 跳表头
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (f[3] !== '0A') continue;                   // 0A = TCP_LISTEN
    const inode = f[9];
    if (!inodes.has(inode)) continue;
    const [addrHex, portHex] = f[1].split(':');
    const addr = v6 ? hexToIPv6(addrHex) : hexToIPv4(addrHex);
    out.push({ addr, port: parseInt(portHex, 16), pid: inodes.get(inode) });
  }
}

function parseProcNetTcpFile(file, v6, inodes, out) {
  try {
    parseProcNetTcpText(fs.readFileSync(file, 'utf8'), v6, inodes, out);
  } catch { /* tcp6 在禁用 IPv6 的内核上可能不存在 */ }
}

function linuxListenPorts(pids) {
  const { inodes, denied } = linuxSocketInodes(pids);
  if (denied) {
    warn(`${denied}/${pids.length} 个 Mirasim 进程的 /proc/<pid>/fd 读不了（EACCES）。` +
         `桥接器需要与 Mirasim 同用户运行，或具备 CAP_SYS_PTRACE。` +
         `否则端口发现会一直是空的，看起来就像 Mirasim 没启动。`);
  }
  if (!inodes.size) return [];
  const out = [];
  parseProcNetTcpFile('/proc/net/tcp', false, inodes, out);
  parseProcNetTcpFile('/proc/net/tcp6', true, inodes, out);
  return out;
}

/** 从 127.0.0.1 视角可达：回环地址或通配地址 */
function isLoopbackReachable(addr) {
  if (!addr) return false;
  const a = String(addr).trim().toLowerCase();
  return (
    a === '0.0.0.0' || a === '::' || a === '*' ||
    a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.')
  );
}

/**
 * 定位 Mirasim 进程并返回它自己监听的回环端口。
 * 这是 DESIGN.md §7-7「按 PID 收窄」的实现——不做全端口扫。
 */
function listCandidatePorts(cfg, opts = {}) {
  const patterns = cfg.discovery.process_match;
  const procs = (IS_WIN ? winFindProcesses(patterns) : linuxFindProcesses(patterns))
    .filter((p) => Number(p.pid) !== process.pid);
  const pids = [...new Set(procs.map((p) => Number(p.pid)).filter(Boolean))];

  let ports = [];
  if (pids.length) ports = IS_WIN ? winListenPorts(pids) : linuxListenPorts(pids);

  const exclude = new Set(opts.excludePorts || []);
  const seen = new Set();
  const candidates = [];
  for (const p of ports) {
    const port = Number(p.port);
    if (!port || seen.has(port)) continue;
    if (exclude.has(port)) continue;          // 排除桥接器自身的监听端口
    if (!isLoopbackReachable(p.addr)) continue;
    seen.add(port);
    candidates.push({ port, pid: Number(p.pid), addr: String(p.addr) });
  }
  candidates.sort((a, b) => a.port - b.port);
  return { procs, pids, candidates };
}

// ---------------------------------------------------------------------------
// 2b. Agent 进程跟踪
// ---------------------------------------------------------------------------

/** 从一段文本里抠 env 变量（内联 JSON 或 `NAME=value` 两种写法都认） */
function pickEnvVar(text, name) {
  const json = text.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  if (json) return json[1];
  const bare = text.match(new RegExp(`(?:^|\\s)${name}=([^\\s"']+)`));
  return bare ? bare[1] : null;
}

/** 从命令行里取出 `--settings <path>` 指向的 mirasim 临时设置文件路径 */
function extractSettingsPath(cmd) {
  // 路径可能带引号，也可能是裸路径（Windows 含空格时通常带引号）
  const quoted = cmd.match(/--settings\s+"([^"]+)"/);
  const bare = cmd.match(/--settings\s+(\S+)/);
  const p = quoted ? quoted[1] : (bare ? bare[1] : null);
  if (!p) return null;
  return AGENT_SETTINGS_RE.test(path.basename(p)) ? p : null;
}

/**
 * 解析一个 agent 进程实际拿到的 base_url / token。
 * 三条通道按可靠性排序，取第一个成功的：
 *   settings_file → 命令行内联 → /proc/<pid>/environ（仅 Linux，同用户可读）
 */
function resolveAgentEnv(cmd, pid, { withSecret = false } = {}) {
  const shape = (baseUrl, token, source) => {
    let port = null;
    let basePath = '';
    if (baseUrl) {
      try {
        const u = new URL(baseUrl);
        port = u.port ? Number(u.port) : null;
        // 2026-09-25 实测：新版 Mirasim 的反代端点藏在随机路径前缀下
        // （base_url = http://127.0.0.1:<port>/<43字符>），不带前缀一律 401。
        basePath = u.pathname.replace(/\/+$/, '');
      } catch {
        const m = String(baseUrl).match(/:(\d+)/);
        if (m) port = Number(m[1]);
      }
    }
    return {
      base_url: baseUrl ? (withSecret ? baseUrl : String(baseUrl).replace(/(https?:\/\/[^/]+).*/, '$1')) : null,
      base_port: port,
      base_path: withSecret ? basePath : '',
      base_path_fp: tokenFingerprint(basePath),
      token_fp: tokenFingerprint(token),
      token_len: token ? token.length : 0,
      token_source: baseUrl ? source : null,
      // 原文 token 只在转发时需要，默认不带出——避免顺手打进日志或 --json 输出
      ...(withSecret ? { token: token || null } : {}),
    };
  };

  // 1. --settings <临时文件>：Mirasim 的实际做法
  const sp = extractSettingsPath(cmd);
  if (sp) {
    try {
      const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const env = (j && j.env) || {};
      if (env.ANTHROPIC_BASE_URL) {
        return shape(env.ANTHROPIC_BASE_URL,
          env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY, 'settings_file');
      }
    } catch { /* 文件已删或坏了，落到下一条通道 */ }
  }

  // 2. 命令行内联
  const inlineBase = pickEnvVar(cmd, 'ANTHROPIC_BASE_URL');
  if (inlineBase) {
    return shape(inlineBase,
      pickEnvVar(cmd, 'ANTHROPIC_AUTH_TOKEN') || pickEnvVar(cmd, 'ANTHROPIC_API_KEY'), 'cmdline');
  }

  // 3. Linux 独有：/proc/<pid>/environ 同用户可读。
  //    Windows 上读别的进程环境块需要 ReadProcessMemory，零依赖 Node 做不到——
  //    这是 Linux 侧反而更好实现的一处平台差异。
  if (!IS_WIN && pid) {
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').replace(/\0/g, '\n');
      const b = pickEnvVar(environ, 'ANTHROPIC_BASE_URL');
      if (b) {
        return shape(b,
          pickEnvVar(environ, 'ANTHROPIC_AUTH_TOKEN') || pickEnvVar(environ, 'ANTHROPIC_API_KEY'),
          'proc_environ');
      }
    } catch { /* 无权限或已退出 */ }
  }

  return shape(null, null, null);
}

function winFindAgentProcesses() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$r = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%mirasim-%settings%' OR CommandLine LIKE '%${AGENT_ENV_MARKER}%'" |
  Select-Object @{n='pid';e={$_.ProcessId}}, @{n='ppid';e={$_.ParentProcessId}},
                @{n='name';e={$_.Name}}, @{n='cmd';e={$_.CommandLine}}
ConvertTo-Json -Compress -Depth 3 -InputObject @($r)`;
  try {
    return parsePsJson(runPowerShell(script));
  } catch (err) {
    warn(`agent 进程扫描失败: ${err.message}`);
    return [];
  }
}

function linuxFindAgentProcesses() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!cmd.includes(AGENT_ENV_MARKER) && !AGENT_SETTINGS_RE.test(cmd)) {
      // Linux 某些启动器只用环境变量传凭证；仅检查 CLI/Node 候选，避免全系统读环境。
      if (!/(?:^|[\/\s])(?:claude|node)(?:\s|$)/i.test(cmd)) continue;
      try {
        if (!fs.readFileSync(`/proc/${e}/environ`, 'utf8').includes(AGENT_ENV_MARKER + '=')) continue;
      } catch { continue; }
    }
    let ppid = null;
    try {
      const stat = fs.readFileSync(`/proc/${e}/status`, 'utf8').match(/^PPid:\s*(\d+)/m);
      if (stat) ppid = Number(stat[1]);
    } catch { /* 忽略 */ }
    out.push({ pid: Number(e), ppid, name: path.basename(cmd.split(' ')[0] || ''), cmd });
  }
  return out;
}

/**
 * 找出 Mirasim 拉起的 agent CLI 进程，连同它被告知的 base_url / token 指纹。
 *
 * 只保留真正解析出 base_url 的条目：查询进程自己的命令行里也含有
 * 'ANTHROPIC_BASE_URL' 这个过滤串（WQL/grep 都会自命中），
 * 而它解析不出 base_url，正好被这一条规则滤掉。
 */
function findAgentProcesses({ withSecret = false } = {}) {
  const raw = IS_WIN ? winFindAgentProcesses() : linuxFindAgentProcesses();
  return raw
    .map((p) => ({
      pid: Number(p.pid),
      ppid: p.ppid != null ? Number(p.ppid) : null,
      name: p.name || null,
      ...resolveAgentEnv(String(p.cmd || ''), Number(p.pid), { withSecret }),
    }))
    .filter((a) => a.base_url && a.pid !== process.pid);
}

// ---------------------------------------------------------------------------
// 3. 端口探测（三态分类）
// ---------------------------------------------------------------------------

/**
 * GET /v1/models 分类（DESIGN.md §1）：
 *   200 + JSON 模型列表 → proxy   目标端点
 *   200 + HTML          → webui   应用自己的界面
 *   401/403             → auth    shell 端口
 *   连接失败            → closed
 *   其余                → other
 *
 * 不带任何认证头：本地端点本就不鉴权，带上反而可能把 shell 端口误判成 proxy。
 */
function classifyResponse(status, headers, body, ms, port) {
  const base = { port, status, ms };
  if (status === 401 || status === 403) return { ...base, class: 'auth', models: [] };

  if (status === 200) {
    const ctype = String(headers['content-type'] || '').toLowerCase();
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const obj = JSON.parse(body);
        const list = Array.isArray(obj) ? obj
          : Array.isArray(obj.data) ? obj.data
            : Array.isArray(obj.models) ? obj.models : null;
        if (list) {
          const models = list
            .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
            .filter(Boolean);
          // 模型列表可以是空数组——仍然是 proxy 形态，只是还没拉到模型
          return { ...base, class: 'proxy', models };
        }
      } catch { /* 落到 other */ }
      return { ...base, class: 'other', models: [] };
    }
    if (ctype.includes('text/html') || trimmed.startsWith('<')) {
      return { ...base, class: 'webui', models: [] };
    }
    return { ...base, class: 'other', models: [] };
  }

  return { ...base, class: 'other', models: [] };
}

function probeModels(port, cfg) {
  const timeout = cfg.discovery.probe_timeout_ms;
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: cfg.discovery.probe_path,
        method: 'GET',
        headers: {
          accept: 'application/json',
          'anthropic-version': '2023-06-01',
          'user-agent': `mirasim-bridge/${VERSION}`,
          connection: 'close',
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          if (len < 256 * 1024) { chunks.push(c); len += c.length; }
        });
        res.on('end', () => {
          done(classifyResponse(
            res.statusCode, res.headers,
            Buffer.concat(chunks).toString('utf8'),
            Date.now() - started, port
          ));
        });
        res.on('error', (err) => done({
          port, class: 'closed', status: 0, ms: Date.now() - started,
          models: [], error: err.code || err.message,
        }));
      }
    );

    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', (err) => done({
      port, class: 'closed', status: 0, ms: Date.now() - started,
      models: [], error: err.code || err.message,
    }));
    req.end();
  });
}

/** 并发限流的探测池（DESIGN.md §7-7：并发 16） */
async function probeAll(ports, cfg) {
  const limit = Math.max(1, cfg.discovery.probe_concurrency);
  const results = new Array(ports.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, ports.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= ports.length) return;
      results[i] = await probeModels(ports[i], cfg);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 一次完整扫描：进程 → 端口 → 探测 */
async function scanOnce(cfg, opts = {}) {
  const { procs, pids, candidates } = listCandidatePorts(cfg, opts);
  const probes = await probeAll(candidates.map((c) => c.port), cfg);
  const byPort = new Map();
  candidates.forEach((c, i) => {
    byPort.set(c.port, { ...c, ...probes[i] });
  });
  const agents = opts.trackAgents ? findAgentProcesses() : [];
  return { ts: ts(), procs, pids, entries: byPort, agents };
}

/** 粘滞选择：上一个 proxy 端口若仍是 proxy 就继续用，否则取端口号最小的 proxy */
function chooseProxyPort(entries, previous) {
  const proxies = [...entries.values()]
    .filter((e) => e.class === 'proxy')
    .map((e) => e.port)
    .sort((a, b) => a - b);
  if (previous && proxies.includes(previous)) return previous;
  return proxies.length ? proxies[0] : null;
}

// ---------------------------------------------------------------------------
// 3b. Claude Code 身份提示词注入（DESIGN.md §1.1）
// ---------------------------------------------------------------------------

/**
 * relay 强制要求 /v1/messages 的 system 以这句开头（或作为独立 system 块存在），
 * 否则一律 400 invalid_request_error。实测规则：
 *   - 大小写敏感；末尾句号可省；夹在句子中间不算；短前缀不算
 *   - 数组形式下顺序不限，任一块满足即可
 *   - /v1/models 与 /v1/messages/count_tokens 不受此限制
 */
const CC_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const CC_PREFIX = CC_SYSTEM.slice(0, -1);        // 去掉末尾句号，用于宽松前缀判定

/** 只有 /v1/messages 需要注入；count_tokens 与 models 不要动 */
function needsCCInjection(url) {
  const p = String(url || '').split('?')[0].replace(/\/+$/, '');
  return p === '/v1/messages';
}

function hasCC(system) {
  if (typeof system === 'string') return system.startsWith(CC_PREFIX);
  if (Array.isArray(system)) {
    return system.some((b) => b && typeof b.text === 'string' && b.text.startsWith(CC_PREFIX));
  }
  return false;
}

/**
 * 幂等注入：客户端本身就是 Claude Code（body 里已有该块）时原样返回，
 * 不重复注入——否则白白多花 token，也可能触发上游异常。
 */
function injectCC(body) {
  if (!body || typeof body !== 'object') return body;
  const s = body.system;
  if (hasCC(s)) return body;
  const block = { type: 'text', text: CC_SYSTEM };
  if (typeof s === 'string' && s) return { ...body, system: [block, { type: 'text', text: s }] };
  if (Array.isArray(s)) return { ...body, system: [block, ...s] };
  return { ...body, system: [block] };
}

// ---------------------------------------------------------------------------
// 3b2. 请求体约束处理（DESIGN.md §1.2）
//
// relay 对请求体有一批不文档化的约束，踩中一律回同一句含混的 400
// "The request was rejected as invalid."，绝不指出是哪个字段。
// 这些结论全部来自实测（致谢：mira-bridge 项目的探针矩阵，MIT；本机复核见 §1.2）。
// 池子里的流量来自任意客户端，这些雷全都会踩到，所以转发前必须逐条兜底。
// ---------------------------------------------------------------------------

const reCache = new Map();          // 正则按源串缓存，也挡住无效正则的重复告警
function compileRe(src) {
  if (!src) return null;
  if (reCache.has(src)) return reCache.get(src);
  let re = null;
  try { re = new RegExp(src); } catch { warn(`无效正则 "${src}"，按「不过滤」处理`); }
  reCache.set(src, re);
  return re;
}

/** 实测除 claude-haiku-4-5 外全是推理模型，带任一采样参数即 400（temperature=1 除外） */
const acceptsSampling = (model, cfg) => {
  const re = compileRe(cfg.constraints.sampling_models);
  return re ? re.test(model ?? '') : false;
};
const hasSampling = (r) => r.temperature != null || r.top_p != null || r.top_k != null;

/** 递归剥掉 cache_control.scope（Claude Code 2.1+ 的跨会话 cache 扩展），ttl 本身合法保留 */
function stripCacheScope(v) {
  if (Array.isArray(v)) { v.forEach(stripCacheScope); return v; }
  if (v && typeof v === 'object') {
    if (v.cache_control && typeof v.cache_control === 'object' && 'scope' in v.cache_control) {
      delete v.cache_control.scope;
    }
    for (const val of Object.values(v)) stripCacheScope(val);
  }
  return v;
}

/** 剥掉 content 数组里的空 text 块（任何位置的 "" 都触发 400；纯空白 "   " 反而合法） */
function dropEmptyTextBlocks(messages) {
  let dropped = 0;
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      const before = m.content.length;
      m.content = m.content.filter((b) => !(b && b.type === 'text' && b.text === ''));
      dropped += before - m.content.length;
    }
  }
  return dropped;
}

/**
 * 连续两条以上 assistant 消息直接 400（连续 user 反而会被上游自动合并）。
 * 合并到上一条同角色消息：内容块拼接，语义不变。
 */
function mergeConsecutiveAssistants(messages) {
  const out = [];
  let merged = 0;
  for (const m of messages) {
    const last = out.at(-1);
    if (m?.role === 'assistant' && last?.role === 'assistant') {
      merged++;
      const lb = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content ?? '' }];
      const mb = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content ?? '' }];
      last.content = [...lb, ...mb];
    } else {
      out.push(m);
    }
  }
  return { messages: out, merged };
}

/**
 * 清洗 /v1/messages 请求体，让它通过 relay 的全部隐藏约束。
 * 返回 { body, notes, error }：
 *   notes —— 本次实际做了哪些修改（记日志/计数用）
 *   error —— 无法静默兜底、必须回给客户端的明确错误（对象；此时 body 不应发往上游）
 * 只有在 error 为 null 时才把 body 发出去——宁可本地回一个说人话的 400，
 * 也不让客户端收到那句什么都诊断不了的 "rejected as invalid"。
 */
function modelFamily(id) {
  return /^(claude|gpt|deepseek|kimi)-/i.exec(String(id))?.[1].toLowerCase() || 'other';
}

function isModelAllowed(id, cfg) {
  if (typeof id !== 'string' || !id) return false;
  if (cfg.constraints.disabled_models?.includes(id)) return false;
  const allow = compileRe(cfg.constraints.model_filter);
  const block = compileRe(cfg.constraints.model_block);
  return (!allow || allow.test(id)) && (!block || !block.test(id));
}

function catalogRows(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : value?.models;
  if (!Array.isArray(rows) || rows.some((m) => typeof m !== 'string' && (!isPlainObject(m) || typeof m.id !== 'string'))) throw new Error('Invalid upstream model catalog');
  return rows;
}

function sanitizeMessagesRequest(body, cfg) {
  const notes = [];
  if (typeof body.model !== 'string' || !body.model.trim()) return { body, notes, error: { message: 'model 必须是非空字符串' } };

  // Mirasim 内部的 context 变体写法（claude-opus-5[1M]），上游 404。提前给明确错误。
  if (/\[1M\]$/i.test(String(body.model))) {
    return {
      body, notes,
      error: { message: `模型名不要带 [1M] 后缀（那是 Mirasim 内部写法）。用 GET /v1/models 返回的裸名字。`, type: 'invalid_request_error' },
    };
  }

  const blockRe = compileRe(cfg.constraints.model_block);
  if (blockRe && blockRe.test(body.model)) {
    return {
      body, notes,
      error: {
        message: `模型 ${body.model} 已在本地禁用（model_block 命中，单价偏高）。可用模型见 GET /v1/models；要放行请调整 config 的 constraints.model_block。`,
        type: 'invalid_request_error', code: 'model_blocked',
      },
    };
  }
  if (!isModelAllowed(body.model, cfg)) {
    return { body, notes, error: { message: `模型 ${body.model} 不在 model_filter 允许范围内`, code: 'model_filtered' } };
  }
  if (modelFamily(body.model) === 'kimi' && cfg.constraints.kimi_default_effort && body.thinking == null && body.output_config == null) {
    body.output_config = { effort: cfg.constraints.kimi_default_effort };
    notes.push('kimi_default_effort');
  }

  // 顶层显式 null：上游 schema 不接受，未设置的可选字段必须省略而非发 null。
  // Claude Code 2.1.237 就会发 tool_choice: null。
  for (const [k, v] of Object.entries(body)) {
    if (v === null) { delete body[k]; notes.push('null_fields'); }
  }

  // 采样参数：推理模型一个都不下发（等价于其唯一合法值 temperature=1）；
  // 接受的模型也要钳 [0,1]，且 temperature 与 top_p 二选一。
  if (hasSampling(body)) {
    if (!acceptsSampling(body.model, cfg)) {
      delete body.temperature; delete body.top_p; delete body.top_k;
      notes.push('sampling_stripped');
    } else {
      if (body.temperature != null && body.top_p != null) { delete body.top_p; notes.push('top_p_dropped'); }
      if (body.temperature != null) {
        const c = Math.min(Math.max(body.temperature, 0), 1);
        if (c !== body.temperature) { body.temperature = c; notes.push('temp_clamped'); }
      }
      if (body.top_p != null) {
        const c = Math.min(Math.max(body.top_p, 0), 1);
        if (c !== body.top_p) { body.top_p = c; notes.push('top_p_clamped'); }
      }
    }
  }

  // cache_control.scope 就地剥离（Claude Code 2.1+ 客户端会带）
  const hadScope = JSON.stringify(body).includes('"scope"');
  stripCacheScope(body);
  if (hadScope) notes.push('cache_scope_stripped');

  if (Array.isArray(body.messages)) {
    const dropped = dropEmptyTextBlocks(body.messages);
    if (dropped) notes.push(`empty_text_blocks:${dropped}`);
    const { messages, merged } = mergeConsecutiveAssistants(body.messages);
    if (merged) { body.messages = messages; notes.push(`assistant_merged:${merged}`); }
    if (!body.messages.length) {
      return {
        body, notes,
        error: { message: 'messages 清洗后为空：至少需要一条内容非空的 user/assistant 消息', type: 'invalid_request_error' },
      };
    }
    // 推理模型不支持 assistant prefill（messages 以 assistant 结尾），只有 haiku 支持。
    // 这条没法静默兜底：丢末条丢信息，转成 user 改变语义——只能回明确错误。
    if (!acceptsSampling(body.model, cfg) && body.messages.at(-1)?.role === 'assistant') {
      return {
        body, notes,
        error: {
          message: `${body.model} 不支持 assistant prefill（messages 以 assistant 结尾）——推理模型的限制。` +
            '可改用 claude-haiku-4-5，或在末尾补一条 user 消息。',
          type: 'invalid_request_error',
        },
      };
    }
  } else {
    return { body, notes, error: { message: 'messages 必须是数组', type: 'invalid_request_error' } };
  }

  // stop_sequences 不能含纯空白项（"\n"、" " 均 400）；全被滤掉则不下发该字段
  if (Array.isArray(body.stop_sequences)) {
    const seqs = body.stop_sequences.filter((s) => typeof s === 'string' && s.trim() !== '');
    if (seqs.length !== body.stop_sequences.length) {
      if (seqs.length) body.stop_sequences = seqs; else delete body.stop_sequences;
      notes.push('stop_filtered');
    }
  }

  // max_tokens 必填且 >= 1。注意刻意不做 thinking 补偿：Anthropic 原生调用方
  // 本就知道该额度含 thinking token，擅自放大会违背其预期（见 §1.2）。
  if (!Number.isFinite(body.max_tokens) || body.max_tokens < 1) {
    body.max_tokens = cfg.constraints.default_max_tokens;
    notes.push('max_tokens_defaulted');
  }

  return { body: injectCC(body), notes, error: null };
}

// ---------------------------------------------------------------------------
// 3c. 目标解析：当前该往哪个端口、用哪个 token
// ---------------------------------------------------------------------------

/**
 * 取一个可用的转发目标。
 *
 * ⚠️ 端口和 token 每会话一换（DESIGN.md §A 实验 1），所以**每次请求都要重解析**，
 * 不能在启动时缓存一份长期用。这里做了 2 秒的短缓存，只为削掉突发请求下的重复扫描开销。
 */
const targetCache = { at: 0, value: null };

function resolveTarget(cfg, { preferPid = null, maxAgeMs = 2000, strict = false } = {}) {
  if (cfg.backend === 'relay') return { relay: getRelay(cfg), kind: 'relay' };
  if (strict && !preferPid) return null;
  if (targetCache.value && Date.now() - targetCache.at < maxAgeMs) {
    // 缓存命中也要过 strict 闸门：保活会话死了缓存还活着的 2 秒内，不能漏到别人的会话上
    if ((!preferPid || targetCache.value.keeperPid === preferPid)
        && (!strict || targetCache.value.is_keepalive)) return targetCache.value;
  }

  let agents = findAgentProcesses({ withSecret: true })
    .filter((a) => a.base_port && a.token);
  if (strict && preferPid) {
    // serve 模式只用保活器自己拉起的会话——绝不能静默蹭用户/别的交互会话：
    // 那会烧错人的额度，还把池流量记进别人的流量记录
    agents = agents.filter((a) => a.ppid === preferPid);
  }
  if (!agents.length) {
    targetCache.value = null;
    targetCache.at = Date.now();
    return null;
  }
  const pick = (preferPid && agents.find((a) => a.ppid === preferPid)) || agents[0];
  const target = {
    port: pick.base_port, basePath: pick.base_path || '', token: pick.token, pid: pick.pid,
    keeperPid: pick.ppid || null,
    token_fp: pick.token_fp, is_keepalive: Boolean(preferPid && pick.ppid === preferPid),
  };
  targetCache.value = target;
  targetCache.at = Date.now();
  return target;
}

function invalidateTarget() {
  targetCache.value = null;
  targetCache.at = 0;
}

// ---------------------------------------------------------------------------
// 3d. 会话保活器（DESIGN.md §12）
// ---------------------------------------------------------------------------

function defaultServerCjs() {
  if (IS_WIN) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Programs', '@mirasimdesktop', 'resources', 'server.cjs');
  }
  // Linux 安装布局待验（DESIGN.md §A 实验 2），先给几个常见候选
  for (const p of [
    '/opt/@mirasimdesktop/resources/server.cjs',
    '/usr/lib/mirasim/resources/server.cjs',
    path.join(os.homedir(), '.local/share/@mirasimdesktop/resources/server.cjs'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/**
 * 维持一个永不结束的 agent 会话，让端口与 token 稳定存在。
 *
 * 形态来自实测：`-p --input-format stream-json` 时 claude 读 stdin 直到关闭。
 * 两条铁律：
 *   1. 绝不 stdin.end()  —— 一关会话立刻收尾，端口和 token 随之消失
 *   2. 绝不向 stdin 写入 —— 写了就是一次真实模型调用，要烧额度；空转是 0 成本
 */
class KeepaliveSupervisor {
  constructor(cfg, hooks = {}) {
    this.cfg = cfg;
    this.hooks = hooks;                 // {onUp(target), onDown(reason)}
    this.child = null;
    this.attempt = 0;          // 退避档位，就绪后清零
    this.respawnTotal = 0;     // 累计重启次数，不清零——这个才是运维要看的
    this.authFails = 0;        // 连续上游 401 计数，就绪后清零
    this.stopping = false;
    this.ready = false;
    this.serverCjs = cfg.keepalive.server_cjs || defaultServerCjs();
  }

  start() {
    if (!this.serverCjs || !fs.existsSync(this.serverCjs)) {
      throw new Error(
        `找不到 server.cjs（${this.serverCjs || '未配置'}）。` +
        '请在 config.json 里设置 keepalive.server_cjs 指向 Mirasim 的 resources/server.cjs。'
      );
    }
    this._spawn();
  }

  _spawn() {
    if (this.stopping) return;
    this.ready = false;
    invalidateTarget();

    this.child = spawn(
      process.execPath,
      [this.serverCjs, 'claude', '-p', '--verbose',
        '--input-format', 'stream-json', '--output-format', 'stream-json'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    log(`保活会话已拉起 pid=${this.child.pid}（stdin 保持打开且永不写入）`);

    // 子进程的输出只做诊断，不解析——我们从不给它发消息，它也不该有实质输出
    const sink = (s, tag) => {
      s.setEncoding('utf8');
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) log(`  [保活${tag}] ${line.length > 160 ? line.slice(0, 160) + '…' : line}`);
        }
      });
    };
    sink(this.child.stdout, '');
    sink(this.child.stderr, '!');

    const pid = this.child.pid;
    let exited = false;
    const onExit = (code, sig) => {
      if (exited) return;
      exited = true;
      this.child = null;
      if (this.stopping) return;
      this.ready = false;
      invalidateTarget();
      warn(`保活会话意外退出 pid=${pid} code=${code} signal=${sig}`);
      if (this.hooks.onDown) this.hooks.onDown('keepalive_exit');
      this._scheduleRespawn();
    };
    this.child.on('exit', onExit);
    this.child.on('error', (err) => { warn(`保活进程启动失败：${err.code || err.message}`); onExit(null, 'spawn_error'); });
    this.child.stdin.on('error', () => {});

    this._waitReady(pid);
  }

  /** 轮询等新会话把端口和 token 就位，并用 GET /v1/models 自检 */
  _waitReady(pid) {
    const deadline = Date.now() + this.cfg.keepalive.ready_timeout_sec * 1000;
    const tick = async () => {
      if (this.stopping || !this.child || this.child.pid !== pid) return;
      invalidateTarget();
      const t = resolveTarget(this.cfg, { preferPid: pid, maxAgeMs: 0, strict: true });
      if (t && t.is_keepalive) {
        const probe = await probeUpstream(t, '/v1/models', this.cfg);
        if (this.stopping || !this.child || this.child.pid !== pid) return;
        if (probe.status === 200 && probe.modelCount > 0) {
          this.ready = true;
          this.attempt = 0;
          this.authFails = 0;
          log(`保活会话就绪 port=${t.port} token_fp=${t.token_fp} 模型数=${probe.modelCount}`);
          if (this.hooks.onUp) this.hooks.onUp(t);
          return;
        }
      }
      if (Date.now() > deadline) {
        warn(`保活会话 ${this.cfg.keepalive.ready_timeout_sec}s 内未就绪，重启`);
        try { this.child.kill(); } catch { /* 已退 */ }
        return;   // exit 事件会触发 _scheduleRespawn
      }
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2000);
  }

  /**
   * 转发层打给我：保活会话的凭证被上游 401 了。
   * 进程活着 != 凭证活着——连续达到阈值就杀子进程，走正常重启序列换新凭证。
   * 若上游整体故障，重启也救不了：有退避封顶兜着，无害。
   */
  noteUpstreamAuthFail() {
    if (this.stopping) return;
    this.authFails++;
    const th = this.cfg.keepalive.authfail_respawn_threshold;
    warn(`保活会话上游 401（连续 ${this.authFails}/${th}）`);
    if (this.authFails >= th && this.child) {
      warn('凭证疑似失效，主动重启保活会话');
      this.ready = false;
      this.authFails = 0;
      try { this.child.kill(); } catch { /* 已退 */ }   // exit 事件会触发 _scheduleRespawn
    }
  }

  _scheduleRespawn() {
    const table = this.cfg.keepalive.respawn_backoff_sec;
    const wait = table[Math.min(this.attempt, table.length - 1)];
    this.attempt++;
    this.respawnTotal++;
    log(`${wait}s 后重启保活会话（退避档 ${this.attempt}，累计重启 ${this.respawnTotal} 次）`);
    setTimeout(() => this._spawn(), wait * 1000);
  }

  get pid() { return this.child ? this.child.pid : null; }

  stop() {
    this.stopping = true;
    if (!this.child) return;
    // 这里才允许关 stdin：让会话自然收尾，而不是硬杀
    try { this.child.stdin.end(); } catch { /* 已关 */ }
    const c = this.child;
    setTimeout(() => { try { c.kill(); } catch { /* 已退 */ } }, 3000);
  }
}

// ---------------------------------------------------------------------------
// 3e. 上游请求
// ---------------------------------------------------------------------------

/** 对目标端点发一个简单请求（自检用），返回 {status, modelCount, models} */
async function probeUpstream(target, pathname, cfg) {
  try {
    const timeout = cfg.discovery.probe_timeout_ms * 4;
    const response = await requestUpstream(target, undefined, { method: 'GET', path: pathname,
      headers: { authorization: 'Bearer ' + (target.token || ''), 'anthropic-version': '2023-06-01', accept: 'application/json', 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(timeout), headersTimeout: timeout, idleTimeout: timeout });
    const body = await readStreamText(response);
    const models = response.statusCode === 200 ? catalogRows(JSON.parse(body))
      .map((m) => typeof m === 'string' ? m : m.id).filter((id) => isModelAllowed(id, cfg)) : [];
    if (target.relay) target.relay.ready = response.statusCode === 200 && models.length > 0;
    return { status: response.statusCode, models, modelCount: models.length, body };
  } catch (err) {
    if (target.relay) target.relay.ready = false;
    return { status: 0, models: [], modelCount: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 3g. sub2api 管理客户端（DESIGN.md §2）
// ---------------------------------------------------------------------------

/**
 * sub2api 响应包络是 {code, message, data}，code 非 0 即错误。
 * 认证优先用管理 Key（x-api-key），JWT 作备用通道。
 */
async function sub2apiRequest(cfg, method, apiPath, body = null) {
    const base = String(cfg.sub2api.base_url || '').replace(/\/+$/, '');
    if (!base) throw new Error('sub2api.base_url 未配置');
    const url = new URL(base + apiPath);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;

    const headers = { accept: 'application/json' };
    if (cfg.sub2api.admin_api_key) headers['x-api-key'] = cfg.sub2api.admin_api_key;
    else if (cfg.sub2api.jwt) headers.authorization = 'Bearer ' + cfg.sub2api.jwt;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }

    const res = await httpRequest(url, { method, headers, body: payload, headersTimeout: 30000, idleTimeout: 30000, totalTimeout: 30000 });
    const raw = await readStreamText(res);
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error(`${method} ${apiPath} HTTP ${res.statusCode}: invalid JSON`); }
    if (!isPlainObject(json) || res.statusCode < 200 || res.statusCode >= 300 || json.code !== 0) {
      throw new Error(`${method} ${apiPath} HTTP ${res.statusCode} code=${json?.code ?? '?'}`);
    }
    return json.data;
}

const s2 = {
  listGroups: (cfg) => sub2apiRequest(cfg, 'GET', '/api/v1/admin/groups/all'),

  /** 按 name 精确查重（search 是模糊匹配，必须客户端再过滤一次） */
  async findAccountByName(cfg, name) {
    const found = [];
    for (let page = 1; page <= 100; page++) {
      const q = `?search=${encodeURIComponent(name)}&platform=anthropic&page_size=100&page=${page}`;
      const data = await sub2apiRequest(cfg, 'GET', '/api/v1/admin/accounts' + q);
      if (!Array.isArray(data?.items)) throw new Error('sub2api account list has invalid shape');
      found.push(...data.items.filter((a) => a.name === name));
      if (found.length > 1) throw new Error('sub2api 存在多个同名账号，请先改为唯一账号名');
      const total = Number(data.total ?? data.pagination?.total);
      if (data.items.length === 0 || (Number.isFinite(total) ? page * 100 >= total : data.items.length < 100)) return found[0] || null;
    }
    throw new Error('sub2api account search exceeded pagination limit');
  },

  createAccount: (cfg, body) => sub2apiRequest(cfg, 'POST', '/api/v1/admin/accounts', body),
  updateAccount: (cfg, id, body) => sub2apiRequest(cfg, 'PUT', `/api/v1/admin/accounts/${id}`, body),
  getAccount: (cfg, id) => sub2apiRequest(cfg, 'GET', `/api/v1/admin/accounts/${id}`),
  syncModels: (cfg, id) => sub2apiRequest(cfg, 'POST', `/api/v1/admin/accounts/${id}/models/sync-upstream`),
  listModels: (cfg, id) => sub2apiRequest(cfg, 'GET', `/api/v1/admin/accounts/${id}/models`),
  setSchedulable: (cfg, id, on) =>
    sub2apiRequest(cfg, 'POST', `/api/v1/admin/accounts/${id}/schedulable`, { schedulable: on }),
  clearTempUnschedulable: (cfg, id) =>
    sub2apiRequest(cfg, 'DELETE', `/api/v1/admin/accounts/${id}/temp-unschedulable`),
  getTempUnschedulable: (cfg, id) =>
    sub2apiRequest(cfg, 'GET', `/api/v1/admin/accounts/${id}/temp-unschedulable`),
  clearError: (cfg, id) => sub2apiRequest(cfg, 'POST', `/api/v1/admin/accounts/${id}/clear-error`),
  clearRateLimit: (cfg, id) => sub2apiRequest(cfg, 'POST', `/api/v1/admin/accounts/${id}/clear-rate-limit`),
};

/** sub2api sync-upstream returns a catalog; model_mapping needs a separate PUT.
 * GET /accounts/:id/models falls back to platform defaults when mapping is empty,
 * so a nonempty response there is NOT proof that live models were saved.
 */
async function syncAccountModels(cfg, id, { beforeWrite = async () => {} } = {}) {
  const catalog = await s2.syncModels(cfg, id);
  const models = [...new Set(catalogRows(catalog).map((m) => typeof m === 'string' ? m : m.id)
    .filter((model) => isModelAllowed(model, cfg)))].sort();
  if (!models.length) throw new Error('上游模型目录为空或没有允许的模型，不恢复调度');
  const account = await s2.getAccount(cfg, id);
  if (account?.platform !== 'anthropic' || account?.type !== 'apikey' || account?.name !== cfg.sub2api.account_name) {
    throw new Error('模型同步目标与受管账号不一致，拒绝修改');
  }
  const mapping = Object.fromEntries(models.map((model) => [model, model]));
  const previous = account.credentials?.model_mapping;
  const matches = (value) => isPlainObject(value) && Object.keys(value).length === models.length
    && models.every((model) => value[model] === model);
  const changed = !matches(previous);
  if (changed) {
    if (await beforeWrite() === false) throw new Error('无法暂停账号，未更新模型映射');
    // Preserve non-secret credential fields too: sub2api replaces these as a
    // whole object while separately retaining omitted sensitive fields.
    await s2.updateAccount(cfg, id, { credentials: { ...(account.credentials || {}), model_mapping: mapping } });
    const stored = await s2.getAccount(cfg, id);
    if (!matches(stored?.credentials?.model_mapping)) throw new Error('模型映射未成功保存，账号不能恢复调度');
  }
  const result = await s2.listModels(cfg, id);
  const rows = Array.isArray(result) ? result : result?.items;
  if (!Array.isArray(rows)) throw new Error('模型映射回读格式错误');
  const saved = [...new Set(rows.map((m) => typeof m === 'string' ? m : m?.model_id || m?.id))].sort();
  if (saved.length !== models.length || saved.some((model, i) => model !== models[i])) {
    throw new Error('保存后的模型目录与上游不一致，账号不能恢复调度');
  }
  return { models, changed };
}

async function refreshQuota(cfg, ctx, { force = false } = {}) {
  if (cfg.backend !== 'relay' || !cfg.quota.enabled || ctx.shuttingDown) return;
  if (!force && Date.now() < (ctx.nextQuotaAt || 0)) return;
  ctx.nextQuotaAt = Date.now() + cfg.quota.interval_sec * 1000;
  let snapshot;
  try {
    const res = await getRelay(cfg).request({ path: '/v1/limits', signal: AbortSignal.timeout(15000) });
    const raw = await readStreamText(res);
    if (res.statusCode !== 200) throw Error(`limits HTTP ${res.statusCode}`);
    snapshot = summarizeLimits(JSON.parse(raw));
    ctx.quota = { ...snapshot, stale: false };
  } catch {
    ctx.quota = { ...(ctx.quota || {}), stale: true, error: '额度查询失败，历史值可能过期' };
  }
  if (cfg.quota.sync_notes && ctx.sm && !ctx.shuttingDown) {
    const a = await s2.getAccount(cfg, ctx.sm.accountId);
    if (a?.name !== cfg.sub2api.account_name || a?.platform !== 'anthropic' || a?.type !== 'apikey') throw Error('额度同步账号不匹配');
    const notes = mergeQuotaNote(a.notes, quotaNote(snapshot || ctx.quota, { stale: ctx.quota.stale }));
    if (notes !== a.notes && !ctx.shuttingDown) await s2.updateAccount(cfg, a.id, { notes });
  }
  return ctx.quota;
}

/** 注册时用的 base_url：拓扑 B 填 public_base_url，否则指向本机固定端口 */
function bridgeBaseUrl(cfg) {
  const pub = String(cfg.sub2api.public_base_url || '').trim();
  if (pub) return pub.replace(/\/+$/, '');
  return `http://127.0.0.1:${cfg.listen.port}`;   // 无 /v1、无尾斜杠（§2.5）
}

// ---------------------------------------------------------------------------
// 3h. 调度状态机（DESIGN.md §5）
// ---------------------------------------------------------------------------

/**
 * PAUSE 是单步；RESUME 是组合动作，因为 schedulable 与 temp_unschedulable 是
 * 两个正交闸门（§2.3b），只把 schedulable 置回 true 不够。
 *
 * 原子性：前 3 步全成功才置 desired='on'。任一步失败保持 'unknown' 下轮整体重试——
 * 否则会出现「temp 清了但 schedulable 没置回」而 desired 已乐观置 on，账号静默死在池外。
 */
class ScheduleState {
  constructor(cfg, accountId) {
    this.cfg = cfg;
    this.accountId = accountId;
    this.desired = 'unknown';
    this.successCount = 0;
    this.failCount = 0;
    this.lastTransitionAt = 0;
    this.resumeFailures = 0;
    this.nextResumeAt = 0;
    this.operations = Promise.resolve();
  }

  _dwellOk() {
    return Date.now() - this.lastTransitionAt >= this.cfg.health.min_dwell_sec * 1000;
  }

  pause(reason) {
    const result = this.operations.then(() => this._pause(reason));
    this.operations = result.catch(() => {});
    return result;
  }

  resume(reason) {
    const result = this.operations.then(() => this._resume(reason));
    this.operations = result.catch(() => {});
    return result;
  }

  async _pause(reason) {
    if (!this.accountId) return false;
    try {
      await s2.setSchedulable(this.cfg, this.accountId, false);
      this.desired = 'off';
      this.lastTransitionAt = Date.now();
      log(`sub2api PAUSE 成功（${reason}）`);
      return true;
    } catch (err) {
      warn(`sub2api PAUSE 失败：${err.message}`);
      this.desired = 'unknown';
      return false;
    }
  }

  async _resume(reason) {
    if (!this.accountId) return false;
    if (Date.now() < this.nextResumeAt) return false;
    const id = this.accountId;
    try {
      await s2.clearTempUnschedulable(this.cfg, id);   // 1. 清 TTL 封禁
      await s2.clearError(this.cfg, id);               // 2. 清 error 态
      await s2.setSchedulable(this.cfg, id, true);     // 3. 放开调度
    } catch (err) {
      // 半成功：保持 unknown，下一轮整体重试
      this.desired = 'unknown';
      this.resumeFailures++;
      const table = [30, 60, 120, 300, 600];
      const wait = table[Math.min(this.resumeFailures - 1, table.length - 1)];
      this.nextResumeAt = Date.now() + wait * 1000;
      warn(`sub2api RESUME 组合动作失败（${err.message}），${wait}s 后重试`);
      return false;
    }
    try {
      await s2.clearRateLimit(this.cfg, id);           // 4. 可选，失败只记日志
    } catch (err) {
      log(`clear-rate-limit 失败（不影响）：${err.message}`);
    }
    this.desired = 'on';
    this.lastTransitionAt = Date.now();
    this.resumeFailures = 0;
    this.nextResumeAt = 0;
    log(`sub2api RESUME 成功（${reason}）`);
    return true;
  }

  /** 每个健康 tick 调用一次，带双向迟滞 + 最小驻留 */
  async onProbe(healthy) {
    if (healthy) {
      this.successCount++;
      this.failCount = 0;
      if (this.successCount >= this.cfg.health.success_threshold
          && this.desired !== 'on'
      && (this.desired === 'unknown' || this._dwellOk())) {
        await this.resume(`连续 ${this.successCount} 次探测健康`);
      }
    } else {
      this.failCount++;
      this.successCount = 0;
      if (this.failCount >= this.cfg.health.fail_threshold
          && this.desired !== 'off'
          && (this.desired === 'unknown' || this._dwellOk())) {
        await this.pause(`连续 ${this.failCount} 次探测失败`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3i. 状态落盘
// ---------------------------------------------------------------------------

function statePath(cfg) {
  return path.join(cfg._config_path ? path.dirname(path.resolve(cfg._config_path)) : __dirname, 'state.json');
}

function loadState(cfg) {
  try {
    return JSON.parse(fs.readFileSync(statePath(cfg), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(cfg, patch) {
  const cur = loadState(cfg);
  const next = { ...cur, ...patch, updated_at: ts() };
  try {
    const temp = statePath(cfg) + `.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, statePath(cfg));
  } catch (err) {
    warn(`state.json 写入失败：${err.message}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 3f. 转发服务器
// ---------------------------------------------------------------------------

// 逐跳头：不能转发（RFC 7230）
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade',
]);

/** 取客户端出示的密钥：x-api-key（Anthropic 习惯，sub2api 走这条）或 Authorization: Bearer */
function presentedKey(req) {
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

/** 定长比较，避免 !== 的时序侧信道 */
function secretMatches(given, expected) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 桥接器自身故障一律 503，绝不用 401/403。
 * 原因见 DESIGN.md §2.4：sub2api 收到 401/403 会把账号打成 error 态（永久禁用，
 * 要 clear-error 才能救），而 5xx 落在它的 switch 之外，账号状态不受影响。
 */
function fail503(res, reason) {
  if (res.headersSent) { try { res.destroy(); } catch { /* 已断 */ } return; }
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message: `mirasim-bridge: ${reason}` },
  });
  res.writeHead(503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function createBridgeServer(cfg, ctx, secret, maxConc) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: Math.max(4, maxConc * 2) });
  const replayLimit = cfg.forward.replay_buffer_mb * 1024 * 1024;

  const server = http.createServer(async (req, res) => {
    ctx.counters.total++;

    // --- 入站鉴权（§8）---
    if (secret && !secretMatches(presentedKey(req), secret)) {
      ctx.counters.rejected++;
      return fail503(res, 'bridge_secret mismatch');   // 不是 403：见 fail503 注释
    }
    if (ctx.shuttingDown) return fail503(res, 'shutting down');
    if (req.url.startsWith('/__')) {
      try { return handleInternal(req, res, cfg, ctx); }
      catch { return fail503(res, 'status unavailable'); }
    }

    // --- 并发闸门 ---
    if (ctx.inflight >= maxConc) {
      ctx.counters.rejected++;
      return fail503(res, `over concurrency limit (${maxConc})`);
    }

    // --- 退避期 ---
    if (Date.now() < ctx.backoffUntil) {
      ctx.counters.rejected++;
      const left = Math.ceil((ctx.backoffUntil - Date.now()) / 1000);
      return fail503(res, `backing off for ${left}s after upstream rate limit`);
    }

    ctx.inflight++;
    try {
      await handleProxy(req, res, cfg, ctx, agent, replayLimit);
    } catch (err) {
      ctx.counters.err++;
      fail503(res, `forward failed: ${err.message}`);
    } finally {
      ctx.inflight--;
    }
  });

  // 这两个超时约束入站上传，不限制已经开始的 SSE 响应。
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.timeout = 0;
  server.keepAliveTimeout = 72_000;
  server.on('connection', (s) => s.setNoDelay(true));
  server.on('close', () => agent.destroy());
  return server;
}

function handleInternal(req, res, cfg, ctx) {
  const p = req.url.split('?')[0];
  if (p === '/__live') {
    // Process health only: no credential reads, upstream requests or discovery.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end('{"ok":true}');
  }
  const target = resolveTarget(cfg, {
    preferPid: ctx.keepalive ? ctx.keepalive.pid : null,
    strict: Boolean(ctx.keepalive),   // serve 模式只用保活会话；test/doctor 等不带 keepalive 的活
  });
  if (p === '/__health') {
    const ok = Boolean(target) && (!target.relay || target.relay.ready) && (!ctx.keepalive || ctx.keepalive.ready)
      && Date.now() >= ctx.backoffUntil && !ctx.shuttingDown;
    const body = JSON.stringify({ ok, port: target ? target.port : null });
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(body);
  }
  if (p === '/__status') {
    const body = JSON.stringify({
      version: VERSION,
      backend: cfg.backend,
      relay: target?.relay ? { ready: target.relay.ready } : undefined,
      quota: ctx.quota || { available: false, stale: true },
      disabled_models: cfg.constraints.disabled_models,
      sub2api: {
        managed: Boolean(ctx.sm),
        reachable: Boolean(ctx.reachable),
        schedulable: ctx.sm ? ctx.sm.desired : 'unmanaged',
        account_id: ctx.sm?.accountId || null,
      },
      uptime_sec: Math.round((Date.now() - ctx.startedAt) / 1000),
      target: target ? { port: target.port, token_fp: target.token_fp, is_keepalive: target.is_keepalive } : null,
      keepalive: ctx.keepalive
        ? {
          enabled: true, pid: ctx.keepalive.pid, ready: ctx.keepalive.ready,
          respawns_total: ctx.keepalive.respawnTotal, backoff_step: ctx.keepalive.attempt,
        }
        : { enabled: false },
      inflight: ctx.inflight,
      kimi_inflight: ctx.kimiInflight || 0,
      backoff_sec_left: Math.max(0, Math.ceil((ctx.backoffUntil - Date.now()) / 1000)),
      counters: ctx.counters,
    }, null, 2);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(body);
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"unknown internal endpoint"}');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let overflow = false;
    req.on('data', (c) => {
      len += c.length;
      if (len > limit) { overflow = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ body: overflow ? null : Buffer.concat(chunks), overflow, len }));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('client aborted upload')));
  });
}

/** 发一次上游请求；Promise 在拿到响应头时 resolve（消费/丢弃响应流是调用方的事） */
function requestUpstream(target, agent, { method, path: p, headers, body, signal, headersTimeout = 60000, idleTimeout = 300000 }) {
  if (target.relay) return target.relay.request({ method, path: p, headers, body, signal, headersTimeout, idleTimeout });
  return new Promise((resolve, reject) => {
    const up = http.request(
      // basePath：新版 Mirasim 的反代藏在随机路径前缀下，必须拼上
      { host: '127.0.0.1', port: target.port, path: (target.basePath || '') + p, method, headers, agent, signal },
      (response) => { clearTimeout(timer); resolve(response); }
    );
    const timer = setTimeout(() => up.destroy(new Error('upstream response headers timeout')), headersTimeout);
    timer.unref();
    up.setTimeout(idleTimeout, () => up.destroy(new Error('upstream idle timeout')));
    up.on('close', () => clearTimeout(timer));
    up.on('error', reject);
    if (body) up.write(body);
    up.end();
  });
}

function readStreamText(stream, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let b = '';
    let bytes = 0;
    stream.setEncoding('utf8');
    stream.on('data', (c) => {
      bytes += Buffer.byteLength(c);
      if (bytes > limit) stream.destroy(new Error('upstream response exceeds buffer limit'));
      else b += c;
    });
    stream.on('end', () => resolve(b));
    stream.on('error', reject);
    stream.on('aborted', () => reject(new Error('upstream response aborted')));
  });
}

/** 日志只留排障需要的：超长字符串（base64 图片、长上下文）截断到 1500 字符 */
function truncLog(v, max = 1500) {
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (typeof s !== 'string') s = String(s);
  return s.length > max ? s.slice(0, max) + `…[截断,共${s.length}字符]` : s;
}

/**
 * 上游 4xx 失败载荷落盘（JSONL）。relay 的含混 400 不指名字段，
 * 「发给上游什么 / 上游回了什么」的对照是唯一排障依据。
 * 注意含对话内容——别外传，已在 .gitignore。
 */
function logFailure(cfg, entry) {
  if (!cfg.forward.log_failures) return;
  try {
    const p = path.resolve(cfg.forward.failure_log);
    // 单文件轮转，防无界增长（content 量小但架不住长年累月）
    if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) {
      try { fs.renameSync(p, p + '.1'); } catch { /* 轮转失败照样继续写 */ }
    }
    fs.appendFileSync(p, JSON.stringify({ ts: ts(), ...entry }) + '\n', { mode: 0o600 });
  } catch { /* 日志写失败不影响转发主路径 */ }
}

/**
 * 合并响应头。extra 的键要能盖住上游同名头——对象键区分大小写，
 * 'Content-Type' 盖不住上游的 'content-type'，两个都会发出去，
 * 客户端收到的就是重复值。所以先按小写比对剔除（致谢 mira-bridge 的注释）。
 */
function mergedHeaders(upstreamHeaders, extra = {}) {
  const overridden = new Set(Object.keys(extra).map((k) => k.toLowerCase()));
  const connectionTokens = String(upstreamHeaders.connection || '').toLowerCase().split(',').map((s) => s.trim());
  const out = {};
  for (const [k, v] of Object.entries(upstreamHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || overridden.has(lk) || connectionTokens.includes(lk)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/** 约束清洗发现的问题走这里：回一个说人话的 400，而不是那句什么都诊断不了的含混报错 */
function fail400(res, error) {
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: error.type || 'invalid_request_error',
      message: `mirasim-bridge: ${error.message}`,
      ...(error.code ? { code: error.code } : {}),
    },
  });
  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleProxy(req, res, cfg, ctx, agent, replayLimit) {
  const controller = new AbortController();
  let kimiSlot = false;
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
  const target = resolveTarget(cfg, {
    preferPid: ctx.keepalive ? ctx.keepalive.pid : null,
    strict: Boolean(ctx.keepalive),
  });
  if (!target) {
    ctx.counters.err++;
    return fail503(res, 'no live agent session (keepalive down?)');
  }

  const { body, overflow } = await readBody(req, replayLimit);
  if (overflow) {
    ctx.counters.err++;
    return fail503(res, `request body exceeds replay_buffer_mb (${cfg.forward.replay_buffer_mb}MB)`);
  }

  const pathname = String(req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  let upstreamPath = req.url;
  if (pathname === '/backend-api/codex/responses' || pathname === '/backend-api/codex/responses/compact') {
    upstreamPath = req.url.replace('/backend-api/codex/', '/v1/');
  }
  const wirePath = upstreamPath.split('?')[0].replace(/\/+$/, '');
  const isResponses = wirePath === '/v1/responses' || wirePath === '/v1/responses/compact';
  if (target.relay) {
    const control = ['/v1/models', '/v1/limits', '/v1/model-roster'].includes(wirePath);
    if (!(control ? req.method === 'GET' : req.method === 'POST' && (isResponses || ['/v1/messages', '/v1/messages/count_tokens'].includes(wirePath)))) {
      return fail400(res, { message: '直连模式支持 Messages、GPT Responses/compact，以及 models/limits/model-roster；不支持 Chat Completions' });
    }
    // Match the signed path exactly, including requests ending with a slash.
    upstreamPath = wirePath + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '');
  }
  if (isResponses && !target.relay) return fail400(res, { message: 'Responses 需要 backend=relay；session 后端仅支持 Messages' });
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    return fail400(res, { message: '不支持压缩请求体，请发送未压缩 JSON' });
  }

  // --- /v1/messages：约束清洗（§1.2）+ CC 注入（§1.1），幂等 ---
  let outBody = body;
  let cleanBody = null;      // 清洗后的请求对象；自愈重试时还要再改
  let hadSampling = false;
  let responsesStream = true;
  if (req.method === 'POST' && isResponses) {
    try {
      const normalized = normalizeResponses(JSON.parse(body.toString('utf8')), {
        compact: wirePath.endsWith('/compact'), allowed: (id) => isModelAllowed(id, cfg),
      });
      responsesStream = normalized.downstreamStream;
      cleanBody = normalized.body;
      outBody = Buffer.from(JSON.stringify(cleanBody));
    } catch (err) { return fail400(res, { message: err.message }); }
  }
  if (req.method === 'POST' && wirePath === '/v1/messages/count_tokens') {
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { /* handled below */ }
    if (!isPlainObject(parsed) || !isModelAllowed(parsed.model, cfg)) return fail400(res, { message: 'count_tokens 需要允许的 model 和 JSON 对象' });
  }
  if (req.method === 'POST' && pathname === '/v1/messages') {
    let parsed = null;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { /* 下面统一返回本地 400 */ }
    if (!isPlainObject(parsed)) return fail400(res, { message: '请求体必须是 JSON 对象' });
    if (parsed) {
      if (!hasCC(parsed.system)) ctx.counters.injected++;
      const { body: cleaned, notes, error } = sanitizeMessagesRequest(parsed, cfg);
      if (error) {
        ctx.counters.err++;
        return fail400(res, error);
      }
      for (const n of notes) ctx.counters.sanitized[n] = (ctx.counters.sanitized[n] || 0) + 1;
      cleanBody = cleaned;
      hadSampling = hasSampling(cleaned);
      outBody = Buffer.from(JSON.stringify(cleaned));
    }
  }

  // --- 头部卫生（§7-4）---
  if (cleanBody && modelFamily(cleanBody.model) === 'kimi') {
    if ((ctx.kimiInflight || 0) >= cfg.forward.kimi_max_concurrency) {
      ctx.counters.rejected++;
      return fail503(res, 'Kimi concurrency limit reached; other models remain available');
    }
    ctx.kimiInflight = (ctx.kimiInflight || 0) + 1;
    kimiSlot = true;
  }
  const headers = {};
  for (const [k, v] of Object.entries(mergedHeaders(req.headers))) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'host' || lk === 'content-length') continue;   // 自己重写
    if (lk === 'x-api-key' || lk === 'authorization' || lk.startsWith('x-mirasim-')) continue;
    headers[k] = v;
  }
  if (!target.relay) {
    headers.host = `127.0.0.1:${target.port}`;
    headers.authorization = 'Bearer ' + target.token;
  }
  if (isResponses) headers.accept = wirePath.endsWith('/compact') ? 'application/json' : 'text/event-stream';
  headers['accept-encoding'] = 'identity';

  const sendOnce = (bodyBuf) => {
    const h = { ...headers };
    if (bodyBuf) h['content-length'] = bodyBuf.length;
    return requestUpstream(target, agent, {
      method: req.method, path: upstreamPath, headers: h, body: bodyBuf,
      signal: controller.signal,
      headersTimeout: cfg.forward.upstream_headers_timeout_ms,
      idleTimeout: cfg.forward.upstream_idle_timeout_ms,
    });
  };

  let upRes;
  try {
    upRes = await sendOnce(outBody);
  } catch (err) {
    invalidateTarget();
    ctx.counters.err++;
    return fail503(res, `upstream error: ${err.code || err.message}`);
  }

  if (upRes.statusCode === 400 && hadSampling && cleanBody) {
    const firstError = await readStreamText(upRes);
    // 仅在明确指出采样参数时重试一次，含混 400 不自动重放。
    if (/temperature|top_p|top_k/i.test(firstError) && !/credit balance/i.test(firstError)) {
      delete cleanBody.temperature; delete cleanBody.top_p; delete cleanBody.top_k;
      upRes = await sendOnce(Buffer.from(JSON.stringify(cleanBody)));
      ctx.counters.sampling_retried++;
    } else {
      if (/credit balance/i.test(firstError)) {
        ctx.backoffUntil = Math.max(ctx.backoffUntil, Date.now() + cfg.backoff.max_sec * 1000);
        ctx.counters.err++;
        return fail503(res, 'upstream credit unavailable');
      }
      ctx.counters.err++;
      const buf = Buffer.from(firstError);
      res.writeHead(400, mergedHeaders(upRes.headers, { 'content-length': buf.length }));
      return res.end(buf);
    }
  }
  const status = upRes.statusCode;
  if (status >= 200 && status < 300 && ctx.keepalive && target.is_keepalive) ctx.keepalive.authFails = 0;

  // --- 上游 401/403 绝不透传（§2.4）：会把 sub2api 账号打成 error 态永久禁用 ---
  if (status === 401 || status === 403) {
    invalidateTarget();
    ctx.counters.err++;
    upRes.resume();
    warn(`上游 ${status} —— token 可能已失效，作废缓存并返回 503`);
    // 进程活着不等于凭证活着：通知保活器，连续达到阈值它会主动重启会话
    if (ctx.keepalive && target.is_keepalive) ctx.keepalive.noteUpstreamAuthFail();
    return fail503(res, `upstream auth failed (${status}); token invalidated`);
  }

  if (status === 429 || status === 529) {
    const sec = status === 429 ? cfg.backoff.on_429_sec : cfg.backoff.on_529_sec;
    const retryAfter = String(upRes.headers['retry-after'] || '');
    const retrySec = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000) || 0;
    ctx.backoffUntil = Math.max(ctx.backoffUntil, Date.now() + Math.max(Math.min(sec, cfg.backoff.max_sec), retrySec) * 1000);
    warn(`上游 ${status} —— 本地退避 ${sec}s（同时把状态码透传给 sub2api，它会按 TTL 处理）`);
  }

  // --- /v1/messages 的其他 4xx:缓冲下来记失败日志,再原样回客户端 ---
  // relay 的报错不指名字段,不留载荷根本没法排。4xx body 都很小,缓冲无压力。
  if (status >= 400 && status < 500 && status !== 429 && (pathname === '/v1/messages' || isResponses)) {
    const text = await readStreamText(upRes);
    if (status === 400 && /credit balance/i.test(text)) {
      ctx.backoffUntil = Math.max(ctx.backoffUntil, Date.now() + cfg.backoff.max_sec * 1000);
      ctx.counters.err++;
      return fail503(res, 'upstream credit unavailable');
    }
    logFailure(cfg, {
      status, ua: req.headers['user-agent'] ?? null,
      sent: truncLog(cleanBody ?? '(非JSON,未解析)'), upstream: truncLog(text),
    });
    ctx.counters.err++;
    const buf = Buffer.from(text, 'utf8');
    res.writeHead(status, mergedHeaders(upRes.headers, { 'content-length': buf.length }));
    res.end(buf);
    return;
  }

  // --- GET /v1/models：按白名单/黑名单过滤 ---
  // sub2api sync-upstream 注册进账号模型列表的就是这份响应；放进去一个实际不可路由
  // （或本地禁用）的模型，sub2api 就会把对应的用户请求送过来吃 400。
  if (req.method === 'GET' && pathname === '/v1/models' && status === 200) {
    const text = await readStreamText(upRes);
    try {
      const j = JSON.parse(text);
      const list = catalogRows(j);
        const kept = list.filter((m) => {
          const id = typeof m === 'string' ? m : m?.id;
          return isModelAllowed(id, cfg);
        });
        ctx.counters.models_filtered += list.length - kept.length;
        const catalog = Array.isArray(j) ? kept : { ...j, data: kept };
        if (!Array.isArray(catalog)) delete catalog.models;
        const out = Buffer.from(JSON.stringify(catalog), 'utf8');
        if (target.relay) target.relay.ready = kept.length > 0;
        ctx.counters.ok++;
        res.writeHead(200, mergedHeaders(upRes.headers, {
          'content-type': 'application/json; charset=utf-8', 'content-length': out.length,
        }));
        res.end(out);
    } catch {
      if (target.relay) target.relay.ready = false;
      ctx.counters.err++;
      return fail503(res, 'invalid upstream model catalog');
    }
    return;
  }

  if (status === 200 && wirePath === '/v1/responses' && !responsesStream) {
    const response = aggregateResponses(await readStreamText(upRes));
    const out = Buffer.from(JSON.stringify(response));
    ctx.counters.ok++;
    res.writeHead(200, mergedHeaders(upRes.headers, { 'content-type': 'application/json', 'content-length': out.length }));
    return res.end(out);
  }

  if (status === 200 && /text\/event-stream/i.test(upRes.headers['content-type'] || '')
      && ['/v1/messages', '/v1/responses'].includes(wirePath)) {
    const eventHeaders = mergedHeaders(upRes.headers);
    delete eventHeaders['content-length']; // Terminal events can finish before the upstream body/EOF.
    res.writeHead(status, eventHeaders);
    try {
      const ok = await pipeEvents(upRes, res, wirePath === '/v1/messages' ? 'messages' : 'responses');
      if (ok) ctx.counters.ok++; else ctx.counters.err++;
    } catch { ctx.counters.err++; res.destroy(); }
    return;
  }

  // --- 其余一切：原样转发（SSE 流式也走这条，pipe 自带背压）---
  res.writeHead(status, mergedHeaders(upRes.headers));
  await new Promise((done) => {
    let finished = false;
    const finish = (complete) => {
      if (finished) return;
      finished = true;
      if (complete && status >= 200 && status < 400) ctx.counters.ok++; else ctx.counters.err++;
      if (!complete) res.destroy();
      done();
    };
    upRes.once('end', () => finish(true));
    upRes.once('close', () => finish(upRes.complete));
    upRes.once('error', () => finish(false));
    res.once('close', () => { if (!res.writableFinished) finish(false); });
    upRes.pipe(res);
  });
  } finally {
    if (kimiSlot) ctx.kimiInflight--;
    res.removeListener('close', abort);
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// 4. 子命令
// ---------------------------------------------------------------------------

async function cmdDiscover(cfg, args) {
  const snap = await scanOnce(cfg, { trackAgents: cfg.observe.track_agents });
  const rows = [...snap.entries.values()];

  if (args.flags.json) {
    process.stdout.write(JSON.stringify({
      ts: snap.ts,
      platform: process.platform,
      processes: snap.procs,
      candidates: rows,
      agents: snap.agents,
      proxy_port: chooseProxyPort(snap.entries, null),
    }, null, 2) + '\n');
    return;
  }

  log(`平台 ${process.platform} / 匹配模式 ${JSON.stringify(cfg.discovery.process_match)}`);
  if (!snap.procs.length) {
    warn('没有找到 Mirasim 进程。应用没启动？或需要调整 discovery.process_match。');
    return;
  }
  log(`命中进程 ${snap.procs.length} 个：`);
  for (const p of snap.procs) {
    log(`  pid=${p.pid} name=${p.name || '?'} exe=${p.exe || '?'}`);
  }
  if (!rows.length) {
    warn('这些进程当前没有监听任何回环端口。');
    return;
  }

  log(`回环 LISTEN 端口 ${rows.length} 个：`);
  log('  PORT   PID     ADDR                 CLASS   HTTP  MS     MODELS');
  for (const r of rows) {
    const models = r.class === 'proxy'
      ? `${r.models.length}${r.models.length ? ' (' + r.models.slice(0, 3).join(', ') + (r.models.length > 3 ? ', …' : '') + ')' : ''}`
      : (r.error || '-');
    log(`  ${String(r.port).padEnd(6)} ${String(r.pid).padEnd(7)} ${r.addr.padEnd(20)} ` +
        `${r.class.padEnd(7)} ${String(r.status || '-').padEnd(5)} ${String(r.ms).padEnd(6)} ${models}`);
  }
  if (snap.agents.length) {
    log(`在跑的 agent CLI ${snap.agents.length} 个：`);
    for (const a of snap.agents) {
      log(`  pid=${a.pid} ppid=${a.ppid} name=${a.name} base_url=${a.base_url} ` +
          `token_fp=${a.token_fp || '-'} token_len=${a.token_len}`);
    }
  } else {
    log('当前没有 agent CLI 在跑（命令行里未见 ANTHROPIC_BASE_URL）。');
  }

  const proxy = chooseProxyPort(snap.entries, null);
  log(proxy ? `→ 目标端点：127.0.0.1:${proxy}` : '→ 未发现 proxy 形态端点（探测未带凭证，见 DESIGN.md §1）');
}

/**
 * observe：长时间轮询，把端口生命周期写成 JSONL 时间线。
 * 这是 DESIGN.md §A 实验 1 的唯一产出物。
 */
async function cmdObserve(cfg, args) {
  const intervalSec = Number(args.flags.interval) || cfg.observe.interval_sec;
  const outPath = path.resolve(
    typeof args.flags.out === 'string' ? args.flags.out : cfg.observe.out
  );
  const heartbeatSec = Number(args.flags.heartbeat) || cfg.observe.heartbeat_sec;
  const logAll = cfg.observe.log_all_ports;

  const stream = fs.createWriteStream(outPath, { flags: 'a' });
  let stopping = false;
  let lastHeartbeat = 0;
  let tick = 0;

  // 上一轮快照
  let prevPorts = new Map();   // port -> {class, pid, models_count}
  let prevPids = new Set();
  let prevAgents = new Map();  // pid -> {base_port, token_fp}
  let prevProxy = null;
  const seenTokenFps = new Set();  // 用于回答「token 是否每会话一换」

  const emit = (event, fields = {}) => {
    const rec = { ts: ts(), event, ...fields };
    stream.write(JSON.stringify(rec) + '\n');
    // 同步打一行人类可读的，方便盯着看
    const detail = Object.entries(fields)
      .filter(([, v]) => v !== null && v !== undefined && !Array.isArray(v))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    log(`${event.padEnd(14)} ${detail}`);
  };

  emit('observe_start', {
    version: VERSION,
    platform: process.platform,
    interval_sec: intervalSec,
    process_match: cfg.discovery.process_match.join(','),
    out: outPath,
  });

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    emit('observe_stop', { signal, ticks: tick });
    stream.end(() => process.exit(0));
    // 兜底：流没能及时关掉也要退出
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const runTick = async () => {
    if (stopping) return;
    tick++;
    let snap;
    try {
      snap = await scanOnce(cfg, { trackAgents: cfg.observe.track_agents });
    } catch (err) {
      emit('tick_error', { error: err.message });
      return;
    }

    // --- 进程增减 ---
    const pids = new Set(snap.pids);
    for (const pid of pids) {
      if (!prevPids.has(pid)) {
        const p = snap.procs.find((x) => Number(x.pid) === pid);
        emit('process_up', { pid, name: (p && p.name) || null });
      }
    }
    for (const pid of prevPids) {
      if (!pids.has(pid)) emit('process_down', { pid });
    }

    // --- 端口增减 / 分类变化 ---
    const cur = new Map();
    for (const e of snap.entries.values()) {
      cur.set(e.port, {
        class: e.class, pid: e.pid, addr: e.addr,
        models_count: e.models ? e.models.length : 0,
        status: e.status, ms: e.ms, error: e.error || null,
      });
    }

    for (const [port, info] of cur) {
      const before = prevPorts.get(port);
      if (!before) {
        if (logAll || info.class === 'proxy') {
          emit('listen_up', {
            port, pid: info.pid, addr: info.addr, probe_class: info.class,
            http: info.status, models_count: info.models_count, ms: info.ms,
          });
        }
        if (info.class === 'proxy') {
          emit('proxy_up', { port, pid: info.pid, models_count: info.models_count });
        }
      } else if (before.class !== info.class) {
        // 端口还在，但形态变了——比如会话结束后 socket 仍监听却不再应答 /v1/models。
        // 这正是实验 1 要区分的关键情形。
        emit('probe_class_change', {
          port, pid: info.pid, from: before.class, to: info.class,
          http: info.status, models_count: info.models_count, error: info.error,
        });
        if (info.class === 'proxy') emit('proxy_up', { port, pid: info.pid, models_count: info.models_count });
        if (before.class === 'proxy') emit('proxy_down', { port, pid: info.pid, reason: 'class_change', to: info.class });
      } else if (info.class === 'proxy' && before.models_count !== info.models_count) {
        emit('models_change', { port, from: before.models_count, to: info.models_count });
      }
    }

    for (const [port, before] of prevPorts) {
      if (!cur.has(port)) {
        if (logAll || before.class === 'proxy') {
          emit('listen_down', { port, pid: before.pid, was_class: before.class });
        }
        if (before.class === 'proxy') {
          emit('proxy_down', { port, pid: before.pid, reason: 'socket_gone' });
        }
      }
    }

    // --- agent CLI 增减 ---
    // 这是判断「会话是否在跑」最可靠的信号，也是唯一能看到 token 轮换的地方。
    const curAgents = new Map(snap.agents.map((a) => [a.pid, a]));
    for (const [pid, a] of curAgents) {
      if (!prevAgents.has(pid)) {
        const fresh = a.token_fp && !seenTokenFps.has(a.token_fp);
        if (a.token_fp) seenTokenFps.add(a.token_fp);
        emit('agent_spawn', {
          pid, ppid: a.ppid, name: a.name,
          base_url: a.base_url, base_port: a.base_port,
          token_fp: a.token_fp, token_len: a.token_len,
          token_is_new: fresh,                       // false = 沿用了之前见过的 token
          distinct_tokens_so_far: seenTokenFps.size,
        });
      }
    }
    for (const [pid, a] of prevAgents) {
      if (!curAgents.has(pid)) {
        emit('agent_exit', { pid, base_port: a.base_port, token_fp: a.token_fp });
      }
    }

    // --- 目标端点切换 ---
    const proxy = chooseProxyPort(snap.entries, prevProxy);
    if (proxy !== prevProxy) {
      emit('proxy_switch', { from: prevProxy, to: proxy });
      prevProxy = proxy;
    }

    // --- 心跳 ---
    const now = Date.now();
    if (now - lastHeartbeat >= heartbeatSec * 1000) {
      lastHeartbeat = now;
      emit('heartbeat', {
        tick, pids: snap.pids.length, listen_ports: cur.size,
        proxy_port: proxy, agents: curAgents.size,
      });
    }

    prevPorts = cur;
    prevPids = pids;
    prevAgents = curAgents;
  };

  // 递归 setTimeout 而非 setInterval：避免慢 tick 叠加
  const loop = async () => {
    if (stopping) return;
    await runTick();
    if (!stopping) setTimeout(loop, intervalSec * 1000);
  };
  await loop();
}

/**
 * selftest：用合成数据验证平台相关的纯函数。
 *
 * 存在的理由：Linux 的解析路径（/proc/net/tcp 十六进制地址、inode 反查、命令行提取）
 * 没有 Linux 机器就没法端到端验证。把这些函数做成纯函数并喂合成输入，
 * 至少能在 Windows 上证明解析逻辑本身是对的，剩下的不确定性只有系统调用层。
 */
function cmdSelftest() {
  const cases = [];
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    cases.push({ name, ok, got, want });
  };

  // --- /proc/net/tcp 地址解码（小端十六进制）---
  eq('hexToIPv4 127.0.0.1', hexToIPv4('0100007F'), '127.0.0.1');
  eq('hexToIPv4 0.0.0.0', hexToIPv4('00000000'), '0.0.0.0');
  eq('hexToIPv4 192.168.1.10', hexToIPv4('0A01A8C0'), '192.168.1.10');
  eq('hexToIPv6 ::', hexToIPv6('0'.repeat(32)), '::');
  eq('hexToIPv6 ::1', hexToIPv6('00000000000000000000000001000000'), '::1');
  eq('hexToIPv6 v4-mapped 127.0.0.1',
    hexToIPv6('0000000000000000FFFF00000100007F'), '::ffff:127.0.0.1');

  // --- /proc/net/tcp 行解析：只收 LISTEN(0A) 且 inode 在集合里的行 ---
  const tcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:2274 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 90001 1 0000 100',
    '   1: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000  00000000  1000        0 90002 1 0000 100',
    '   2: 00000000:1388 00000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 99999 1 0000 100',
  ].join('\n');
  const out4 = [];
  parseProcNetTcpText(tcp, false, new Map([['90001', 4242], ['90002', 4242]]), out4);
  eq('parseProcNetTcp 只取 LISTEN + 已知 inode',
    out4, [{ addr: '127.0.0.1', port: 0x2274, pid: 4242 }]);

  const tcp6 = [
    '  sl  local_address                         remote_address                        st ... inode',
    '   0: 0000000000000000FFFF00000100007F:2266 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000  00000000  1000        0 90003 1 0000 100',
  ].join('\n');
  const out6 = [];
  parseProcNetTcpText(tcp6, true, new Map([['90003', 777]]), out6);
  eq('parseProcNetTcp6 v4-mapped',
    out6, [{ addr: '::ffff:127.0.0.1', port: 0x2266, pid: 777 }]);

  // --- 回环可达判定 ---
  eq('loopback 判定', [
    isLoopbackReachable('127.0.0.1'), isLoopbackReachable('0.0.0.0'),
    isLoopbackReachable('::1'), isLoopbackReachable('::ffff:127.0.0.1'),
    isLoopbackReachable('192.168.1.5'), isLoopbackReachable(''),
  ], [true, true, true, true, false, false]);

  // --- settings 文件路径提取 ---
  // 样本取自本机实测的真实命令行
  const realCmd = 'C:\\Users\\x\\.local\\bin\\claude.EXE -p --verbose --output-format stream-json ' +
    '--model claude-opus-5[1m] --settings C:\\Users\\x\\AppData\\Local\\Temp\\' +
    'mirasim-claude-settings-8ec9bc0fd66bd206.json --effort high --resume abc';
  eq('extractSettingsPath 真实命令行',
    path.win32.basename(extractSettingsPath(realCmd) || ''), 'mirasim-claude-settings-8ec9bc0fd66bd206.json');
  eq('extractSettingsPath 带引号',
    path.win32.basename(extractSettingsPath('claude --settings "C:\\a b\\mirasim-claude-settings-1.json" -p') || ''),
    'mirasim-claude-settings-1.json');
  // 安全性：不属于 mirasim 的 --settings 文件不碰——避免误读用户自己的配置
  eq('extractSettingsPath 拒绝非 mirasim 文件',
    extractSettingsPath('claude --settings /home/u/.claude/settings.json -p'), null);
  eq('extractSettingsPath 无 --settings', extractSettingsPath('claude -p hi'), null);

  // --- resolveAgentEnv 三条通道 ---
  const tmpFile = path.join(os.tmpdir(), `mirasim-claude-settings-${process.pid}-selftest.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8812',
        ANTHROPIC_AUTH_TOKEN: 'sk-fake-token-abc',
        ANTHROPIC_API_KEY: '',
      },
    }));
    const a1 = resolveAgentEnv(`claude -p --settings ${tmpFile} --effort high`, process.pid);
    eq('resolveAgentEnv 走 settings 文件',
      [a1.base_url, a1.base_port, a1.token_len, a1.token_source],
      ['http://127.0.0.1:8812', 8812, 17, 'settings_file']);
    eq('resolveAgentEnv token 指纹稳定', a1.token_fp, tokenFingerprint('sk-fake-token-abc'));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* 清理失败无所谓 */ }
  }
  // 文件不存在时不能崩，要静默降级
  const gone = resolveAgentEnv('claude --settings /nope/mirasim-claude-settings-x.json -p', 0);
  eq('resolveAgentEnv settings 文件缺失时降级', [gone.base_url, gone.token_source], [null, null]);

  const a2 = resolveAgentEnv('env ANTHROPIC_BASE_URL=http://127.0.0.1:9001 ANTHROPIC_AUTH_TOKEN=zzz claude', 0);
  eq('resolveAgentEnv 走命令行内联',
    [a2.base_url, a2.base_port, a2.token_len, a2.token_source],
    ['http://127.0.0.1:9001', 9001, 3, 'cmdline']);
  eq('resolveAgentEnv 无匹配', resolveAgentEnv('node mirasim-bridge.js observe', 0).base_url, null);
  // 2026-09-25 新版 Mirasim：base_url 带随机路径前缀，必须完整保留（不带前缀一律 401）
  const a3 = resolveAgentEnv('env ANTHROPIC_BASE_URL=http://127.0.0.1:9002/AbC123xYz_ ANTHROPIC_AUTH_TOKEN=t claude', 0, { withSecret: true });
  eq('resolveAgentEnv 保留随机路径前缀', [a3.base_port, a3.base_path], [9002, '/AbC123xYz_']);
  const a4 = resolveAgentEnv('env ANTHROPIC_BASE_URL=http://127.0.0.1:9003 ANTHROPIC_AUTH_TOKEN=t claude', 0);
  eq('resolveAgentEnv 无路径前缀时为空串', a4.base_path, '');

  // --- 三态分类（含本机实测的两种 401）---
  const cls = (s, ct, body) => classifyResponse(s, { 'content-type': ct }, body, 1, 1).class;
  eq('分类 proxy', cls(200, 'application/json', '{"data":[{"id":"claude-haiku"}]}'), 'proxy');
  eq('分类 webui', cls(200, 'text/html', '<!doctype html><html>'), 'webui');
  eq('分类 auth (shell 端口)', cls(401, 'application/json', '{"error":"bad shell token"}'), 'auth');
  eq('分类 auth (反代端点)',
    cls(401, 'application/json',
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'auth');
  eq('分类 other', cls(200, 'text/plain', 'pong'), 'other');

  // --- Claude Code 身份注入（§1.1，规则来自实测）---
  eq('needsCC /v1/messages', needsCCInjection('/v1/messages'), true);
  eq('needsCC 带 query', needsCCInjection('/v1/messages?beta=true'), true);
  eq('needsCC count_tokens 不注入', needsCCInjection('/v1/messages/count_tokens'), false);
  eq('needsCC /v1/models 不注入', needsCCInjection('/v1/models'), false);

  eq('注入：原本没有 system',
    injectCC({ model: 'm' }).system, [{ type: 'text', text: CC_SYSTEM }]);
  eq('注入：客户端是字符串 system',
    injectCC({ system: 'Be terse.' }).system,
    [{ type: 'text', text: CC_SYSTEM }, { type: 'text', text: 'Be terse.' }]);
  eq('注入：客户端是数组 system',
    injectCC({ system: [{ type: 'text', text: 'Be terse.' }] }).system,
    [{ type: 'text', text: CC_SYSTEM }, { type: 'text', text: 'Be terse.' }]);

  // 幂等：已经带了就别再塞一遍
  const already = { system: [{ type: 'text', text: CC_SYSTEM }, { type: 'text', text: 'x' }] };
  eq('幂等：数组里已有 CC 块', injectCC(already) === already, true);
  const alreadyStr = { system: CC_SYSTEM + ' And be terse.' };
  eq('幂等：字符串已以 CC 开头', injectCC(alreadyStr) === alreadyStr, true);
  // 末尾句号可省也算已有（实测 200）
  eq('幂等：CC 少末尾句号也算',
    injectCC({ system: CC_PREFIX }) === undefined, false);
  eq('幂等：CC 少末尾句号不重复注入',
    Array.isArray(injectCC({ system: CC_PREFIX }).system), false);
  // 不该被误判为已有的情形（实测这些都会 400，必须注入）
  eq('非 CC 的 system 要注入',
    injectCC({ system: 'You are a helpful assistant.' }).system.length, 2);
  eq('短前缀不算已有', injectCC({ system: 'You are Claude Code' }).system.length, 2);

  // --- 请求体约束清洗（§1.2，规则来自 mira-bridge 的实测探针矩阵）---
  const tcfg = deepMerge({}, DEFAULT_CONFIG);
  const san = (o) => sanitizeMessagesRequest(o, tcfg);
  // 显式放开采样参数白名单的配置，用来测「接受采样的模型」分支（默认已全部剥离）
  const tcfgHaiku = deepMerge({}, DEFAULT_CONFIG);
  tcfgHaiku.constraints.sampling_models = 'haiku';
  const sanH = (o) => sanitizeMessagesRequest(o, tcfgHaiku);
  const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });

  // 采样参数：默认（正则空）全部剥；白名单内的模型保留但要钳 [0,1]、temp/top_p 二选一
  {
    const r = san({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10, temperature: 0.8 });
    eq('清洗：默认全部剥采样参数',
      [r.error, 'temperature' in r.body, r.notes.includes('sampling_stripped')],
      [null, false, true]);
  }
  {
    const r = sanH({ model: 'claude-sonnet-5', messages: [msg('user', 'hi')], max_tokens: 10, temperature: 1, top_p: 0.9 });
    eq('清洗：白名单外模型剥采样参数',
      [r.error, 'temperature' in r.body, 'top_p' in r.body, r.notes.includes('sampling_stripped')],
      [null, false, false, true]);
  }
  {
    const r = sanH({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10, temperature: 0.8 });
    eq('清洗：白名单内保留采样参数', [r.error, r.body.temperature], [null, 0.8]);
  }
  {
    const r = sanH({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10, temperature: 1.7 });
    eq('清洗：temperature 钳到 1', [r.error, r.body.temperature, r.notes.includes('temp_clamped')], [null, 1, true]);
  }
  {
    const r = sanH({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10, temperature: 0.5, top_p: 0.9 });
    eq('清洗：temp+top_p 只留 temp', [r.error, 'top_p' in r.body], [null, false]);
  }
  // cache_control.scope 递归剥，ttl 保留（system 块、messages 内容块、tools 都可能带）
  {
    const scope = { type: 'ephemeral', ttl: '1h', scope: 'global' };
    const r = san({
      model: 'claude-haiku-4-5', max_tokens: 10,
      system: [{ type: 'text', text: 'x', cache_control: { ...scope } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { ...scope } }] }],
      tools: [{ name: 't', input_schema: {}, cache_control: { ...scope } }],
    });
    const msgCc = r.body.messages[0].content[0].cache_control;
    const toolCc = r.body.tools[0].cache_control;
    eq('清洗：剥 scope 留 ttl', [r.error, msgCc, toolCc], [null, { type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h' }]);
  }
  // 顶层显式 null（Claude Code 2.1.237 的 tool_choice: null）
  {
    const r = san({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10, tool_choice: null });
    eq('清洗：剥顶层 null 字段', [r.error, 'tool_choice' in r.body], [null, false]);
  }
  // 空 text 块丢弃；纯空白块保留；连续 assistant 合并
  {
    const r = san({
      model: 'claude-haiku-4-5', max_tokens: 10,
      messages: [
        msg('user', 'a'),
        msg('assistant', 'r1'), msg('assistant', 'r2'), msg('assistant', 'r3'),
        { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: '   ' }, { type: 'text', text: 'b' }] },
      ],
    });
    eq('清洗：合并连续 assistant', [r.error, r.body.messages.length, r.body.messages[1].content.length],
      [null, 3, 3]);
    eq('清洗：丢空块留空白块', r.body.messages[2].content.map((b) => b.text), ['   ', 'b']);
  }
  // prefill：推理模型报错；旧实测 haiku 支持 prefill（用白名单配置验证该分支）
  {
    const bad = san({ model: 'claude-sonnet-5', messages: [msg('user', 'a'), msg('assistant', 'r')], max_tokens: 10 });
    eq('清洗：推理模型 prefill 报明确错', [Boolean(bad.error), /prefill/.test(bad.error?.message || '')], [true, true]);
    const ok = sanH({ model: 'claude-haiku-4-5', messages: [msg('user', 'a'), msg('assistant', 'r')], max_tokens: 10 });
    eq('清洗：haiku prefill 放行', ok.error, null);
  }
  // 空 messages / 非数组
  eq('清洗：messages 空数组报错', Boolean(san({ model: 'claude-haiku-4-5', messages: [], max_tokens: 10 }).error), true);
  eq('清洗：messages 非数组报错', Boolean(san({ model: 'claude-haiku-4-5', messages: 'x', max_tokens: 10 }).error), true);
  // stop_sequences 纯空白项
  {
    const r = san({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10, stop_sequences: ['\n', ' ', 'STOP'] });
    eq('清洗：过滤空白 stop', r.body.stop_sequences, ['STOP']);
    const r2 = san({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10, stop_sequences: ['\n', '  '] });
    eq('清洗：全空白则删字段', 'stop_sequences' in r2.body, false);
  }
  // max_tokens：缺失/0/负数回落默认；合法值不动；刻意不做 thinking 补偿
  eq('清洗：max_tokens=0 回落默认', san({ model: 'claude-sonnet-5', messages: [msg('user', 'hi')], max_tokens: 0 }).body.max_tokens, 8192);
  eq('清洗：max_tokens=5 保留', san({ model: 'claude-sonnet-5', messages: [msg('user', 'hi')], max_tokens: 5 }).body.max_tokens, 5);
  // 模型名 [1M] 后缀、黑名单
  eq('清洗：[1M] 后缀报明确错', Boolean(san({ model: 'claude-opus-5[1M]', messages: [msg('user', 'hi')], max_tokens: 10 }).error), true);
  {
    const r = san({ model: 'claude-fable-5', messages: [msg('user', 'hi')], max_tokens: 10 });
    eq('清洗：黑名单模型报明确错', [Boolean(r.error), r.error?.code], [true, 'model_blocked']);
  }
  // 清洗后 CC 注入仍然生效、且幂等
  {
    const r = san({ model: 'claude-haiku-4-5', messages: [msg('user', 'hi')], max_tokens: 10 });
    eq('清洗后 CC 已注入', hasCC(r.body.system), true);
    const withCC = san({ model: 'claude-haiku-4-5', system: CC_SYSTEM, messages: [msg('user', 'hi')], max_tokens: 10 });
    eq('清洗对已有 CC 幂等', JSON.stringify(withCC.body.system), JSON.stringify(CC_SYSTEM));
  }
  // 响应头合并：extra 按小写盖住上游同名头，不会发出两份 content-type
  {
    const h = mergedHeaders({ 'content-type': 'text/event-stream', 'x-a': '1', connection: 'keep' },
      { 'Content-Type': 'application/json', 'content-length': 5 });
    eq('头部合并小写覆盖', [h['content-type'], h['Content-Type'], h['x-a'], h.connection], [undefined, 'application/json', '1', undefined]);
  }

  // --- 正则缓存：同一实例返回，无效正则不抛 ---
  {
    const a = compileRe('^claude-'), b = compileRe('^claude-');
    eq('compileRe 缓存同一实例', a === b, true);
    eq('compileRe 无效正则返回 null', compileRe('(['), null);
    eq('compileRe 空串返回 null', compileRe(''), null);
  }

  // --- 出示密钥：x-api-key 与 Bearer 双通道 ---
  {
    const k1 = presentedKey({ headers: { 'x-api-key': ' k1 ' } });
    const k2 = presentedKey({ headers: { authorization: 'Bearer k2' } });
    const k3 = presentedKey({ headers: { 'x-api-key': 'k1', authorization: 'Bearer k2' } }); // x-api-key 优先
    const k4 = presentedKey({ headers: {} });
    eq('presentedKey 双通道', [k1, k2, k3, k4], ['k1', 'k2', 'k1', null]);
  }

  // --- 定长密钥比较 ---
  eq('secretMatches 相同', secretMatches('abc123', 'abc123'), true);
  eq('secretMatches 不同', secretMatches('abc123', 'abc124'), false);
  eq('secretMatches 长度不同', secretMatches('abc', 'abcd'), false);

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) {
    log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!c.ok) {
      log(`      得到 ${JSON.stringify(c.got)}`);
      log(`      期望 ${JSON.stringify(c.want)}`);
    }
  }
  log(`${cases.length - failed.length}/${cases.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

/**
 * test：端到端验证链路。
 * 蹭任意一个活会话（不必是保活器拉起的），取模型列表 → 发一条最小 stream:true 对话。
 */
function diagnosticTarget(cfg, direct = false) {
  if (direct && cfg.backend === 'relay') return { relay: getRelay(cfg), backend: 'relay', diagnostics: cfg.diagnostics };
  if (direct) {
    const t = resolveTarget(cfg, { maxAgeMs: 0 });
    if (!t) throw new Error('没有活的 Mirasim 会话');
    return { host: '127.0.0.1', port: t.port, prefix: t.basePath || '', headers: { authorization: 'Bearer ' + t.token } };
  }
  return {
    backend: cfg.backend,
    diagnostics: cfg.diagnostics,
    host: ['0.0.0.0', '::'].includes(cfg.listen.host) ? '127.0.0.1' : cfg.listen.host,
    port: cfg.listen.port, prefix: '', headers: { 'x-api-key': cfg.bridge_secret || '' },
  };
}

function diagnosticRequest(target, pathname, payload, { timeoutMs = 60000 } = {}) {
  if (target.relay) return (async () => {
    const started = Date.now();
    const res = await target.relay.request({ path: pathname, method: payload ? 'POST' : 'GET',
      body: payload ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0), signal: AbortSignal.timeout(timeoutMs) });
    const ttfb = Date.now() - started;
    return { status: res.statusCode, raw: await readStreamText(res), ttfb_ms: ttfb, elapsed_ms: Date.now() - started };
  })();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    let timer, ttfb;
    const req = http.request({
      host: target.host, port: target.port, path: target.prefix + pathname,
      method: data ? 'POST' : 'GET',
      headers: { ...target.headers, 'anthropic-version': '2023-06-01', 'accept-encoding': 'identity',
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
    }, (res) => {
      ttfb = Date.now() - started;
      readStreamText(res).then((raw) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, raw, ttfb_ms: ttfb, elapsed_ms: Date.now() - started });
      }, (err) => { clearTimeout(timer); err.ttfb_ms = ttfb; reject(err); });
    });
    timer = setTimeout(() => req.destroy(new Error(`检测 ${timeoutMs / 1000} 秒超时；不代表凭证失效`)), timeoutMs);
    timer.unref();
    req.on('error', (err) => { clearTimeout(timer); err.ttfb_ms = ttfb; reject(err); });
    req.end(data);
  });
}

function summarizeModelResponse(result) {
  const out = { status: result.status, ok: false, text: '', usage: null, stop_reason: null,
    ttfb_ms: result.ttfb_ms, elapsed_ms: result.elapsed_ms };
  let complete = false;
  if (result.status !== 200) {
    try { const v = JSON.parse(result.raw); out.error = v.error?.message || v.message || result.raw.slice(0, 500); }
    catch { out.error = result.raw.slice(0, 500); }
    return out;
  }
  const event = (e) => {
    if (e.type === 'error') out.error = e.error?.message || 'upstream stream error';
    if (e.type === 'message_start') out.usage = e.message?.usage || null;
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') out.text += e.delta.text || '';
    if (e.type === 'message_delta') {
      out.usage = { ...(out.usage || {}), ...(e.usage || {}) };
      out.stop_reason = e.delta?.stop_reason || out.stop_reason;
    }
    if (e.type === 'message_stop') complete = true;
    if (e.type === 'response.output_text.delta') out.text += e.delta || '';
    if (['response.completed', 'response.incomplete'].includes(e.type)) {
      complete = true; out.usage = e.response?.usage;
      if (!out.text) out.text = (e.response?.output || []).flatMap((item) => item.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      out.stop_reason = e.response?.status || e.type;
    }
    if (e.type === 'response.failed') out.error = e.response?.error?.message || 'Responses failed';
  };
  if (result.raw.trimStart().startsWith('{')) {
    try {
      const e = JSON.parse(result.raw);
      if (e.type === 'error' || e.error) out.error = e.error?.message || 'upstream error';
      else if (e.type === 'message' && Array.isArray(e.content)) {
        out.text = e.content.filter((v) => v.type === 'text').map((v) => v.text).join('');
        out.usage = e.usage; out.stop_reason = e.stop_reason; complete = true;
      } else if (e.object === 'response') {
        out.text = (e.output || []).flatMap((item) => item.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
        out.usage = e.usage; out.stop_reason = e.status;
        complete = ['completed', 'incomplete'].includes(e.status);
      }
    } catch { out.error = '上游响应不是有效 JSON'; }
  } else {
    for (const frame of result.raw.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { event(JSON.parse(data)); } catch { out.error = '上游 SSE 数据无法解析'; }
    }
  }
  out.ok = complete && Boolean(out.text.trim()) && !out.error;
  if (!out.ok && !out.error) out.error = !complete ? '上游流未正常结束' : '没有可见文本，可能输出预算被推理占用；不能认定检测成功';
  return out;
}

async function getDiagnosticCatalog(target) {
  const r = await diagnosticRequest(target, '/v1/models');
  if (r.status !== 200) throw new Error(`模型列表 HTTP ${r.status}: ${r.raw.slice(0, 300)}`);
  const j = JSON.parse(r.raw);
  const rows = Array.isArray(j) ? j : j.data || j.models;
  if (!Array.isArray(rows)) throw new Error('模型列表格式错误');
  return [...new Set(rows.map((v) => typeof v === 'string' ? v : v.id).filter((v) => typeof v === 'string'))];
}

async function checkDiagnosticModel(target, model, args) {
  const maxTokens = args.flags['max-tokens'] === undefined ? (target.diagnostics?.max_tokens || 128) : Number(args.flags['max-tokens']);
  const timeoutSec = args.flags['timeout-sec'] === undefined ? (target.diagnostics?.timeout_sec || 30) : Number(args.flags['timeout-sec']);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) throw new Error('--timeout-sec 必须是 1..600 的整数');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error('--max-tokens 必须是 1..8192 的整数');
  let payload = { model, max_tokens: maxTokens, stream: true,
    messages: [{ role: 'user', content: 'Reply only OK.' }] };
  // 直连需要自己注入；默认经桥接器，让测试真正覆盖转发层的注入处理。
  if (args.flags.direct) payload = injectCC(payload);
  if (modelFamily(model) === 'kimi') payload.output_config = { effort: 'low' };
  const protocol = args.flags.protocol || (target.backend === 'relay' && modelFamily(model) === 'gpt' ? 'responses' : 'messages');
  if (!['messages', 'responses'].includes(protocol)) throw new Error('--protocol 必须是 messages 或 responses');
  if (protocol === 'responses') payload = { model, stream: true, store: false, input: 'Reply only OK.', max_output_tokens: maxTokens };
  const started = Date.now();
  try { return { model, family: modelFamily(model), protocol, ...summarizeModelResponse(await diagnosticRequest(target, '/v1/' + protocol, payload, { timeoutMs: timeoutSec * 1000 })) }; }
  catch (err) { return { model, family: modelFamily(model), protocol, ok: false, status: 0, ttfb_ms: err.ttfb_ms ?? null, elapsed_ms: Date.now() - started, error: err.message, timeout_sec: timeoutSec }; }
}

async function cmdModels(cfg, args) {
  const target = diagnosticTarget(cfg, Boolean(args.flags.direct));
  const catalog = await getDiagnosticCatalog(target);
  let ids = catalog;
  if (typeof args.flags.model === 'string') {
    if (!catalog.includes(args.flags.model)) throw new Error('模型不在当前列表中：' + args.flags.model);
    ids = [args.flags.model];
  }
  if (typeof args.flags.family === 'string') ids = ids.filter((id) => modelFamily(id) === args.flags.family.toLowerCase());
  if (args.flags.check && typeof args.flags.model !== 'string') throw new Error('--check 必须同时指定 --model，避免无意批量消耗额度');
  const rows = [];
  for (const id of ids) rows.push(args.flags.check ? await checkDiagnosticModel(target, id, args) : { model: id, family: modelFamily(id), availability: 'not_tested' });
  if (args.flags.json) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  else {
    for (const r of rows) log(args.flags.check ? `${r.ok ? 'OK' : 'FAIL'} ${r.model} HTTP ${r.status} ${r.error || JSON.stringify(r.text)}` : `${r.family.padEnd(9)} ${r.model}（仅列出，未验证推理可用性）`);
    log(`共 ${rows.length} 个；relay 模式 GPT 推荐 Responses，其他系列 Messages；来源 ${args.flags.direct ? 'Mirasim 直连' : '桥接器'}`);
  }
  if (rows.some((r) => r.ok === false)) process.exitCode = 1;
  return rows;
}

async function cmdTest(cfg, args) {
  const target = diagnosticTarget(cfg, Boolean(args.flags.direct));
  const ids = await getDiagnosticCatalog(target);
  const model = typeof args.flags.model === 'string' ? args.flags.model : ids.find((id) => /haiku/i.test(id)) || ids[0];
  if (!model || !ids.includes(model)) throw new Error('指定模型不在当前列表中：' + model);
  const result = await checkDiagnosticModel(target, model, args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
  return result;
}

function createShutdownHandler(cfg, ctx, { server, registration, stopHealth, exit = (code) => process.exit(code) }) {
  let started = false, finished = false, deadlineTimer;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const finish = (forced) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadlineTimer);
    if (forced) warn('退出总超时：强制停止；请检查 sub2api 账号是否已暂停');
    else log('在途请求已排空，退出');
    ctx.keepalive?.stop();
    server.closeAllConnections?.();
    resolveDone();
    const grace = forced ? 0 : Math.min(ctx.keepalive ? 3500 : 0, Math.max(0, ctx.shutdownDeadline - Date.now()));
    setTimeout(() => exit(forced ? 1 : 0), grace);
  };
  return async (sig) => {
    if (started) return done;
    started = true;
    ctx.shuttingDown = true;
    ctx.shutdownDeadline = Date.now() + cfg.shutdown.total_timeout_sec * 1000;
    log(`收到 ${sig}，开始优雅退出`);
    stopHealth();
    server.close();
    deadlineTimer = setTimeout(() => finish(true), cfg.shutdown.total_timeout_sec * 1000);
    await Promise.race([Promise.resolve().then(registration).catch(() => {}), done]);
    if (finished) return;
    if (ctx.sm) {
      await Promise.race([ctx.sm.pause('优雅退出').catch((e) => warn(`PAUSE 失败：${e.message}`)), done]);
    }
    if (finished) return;
    const drainUntil = Date.now() + cfg.shutdown.drain_timeout_sec * 1000;
    while (!finished && ctx.inflight > 0 && Date.now() < drainUntil) await Promise.race([new Promise((r) => setTimeout(r, 100)), done]);
    finish(ctx.inflight > 0);
  };
}

async function cmdServe(cfg, args) {
  const host = typeof args.flags.host === 'string' ? args.flags.host : cfg.listen.host;
  const port = Number(args.flags.port) || cfg.listen.port;
  cfg.listen = { host, port };
  validateConfig(cfg);
  const secret = cfg.bridge_secret || '';
  if (!secret && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('非回环监听必须配置 bridge_secret');
  const maxConc = Math.max(1, cfg.forward.max_concurrency);

  const ctx = {
    keepalive: null,
    inflight: 0,
    queue: [],
    counters: {
      total: 0, ok: 0, err: 0, rejected: 0, injected: 0,
      sampling_retried: 0,      // 采样参数被上游拒后剥离重试成功的次数（§1.2）
      models_filtered: 0,       // /v1/models 响应里被白名单/黑名单滤掉的模型数
      sanitized: {},            // 约束清洗动作计数，键见 sanitizeMessagesRequest 的 notes
    },
    backoffUntil: 0,
    startedAt: Date.now(),
  };

  const withSub2api = Boolean(cfg.sub2api.base_url && (cfg.sub2api.admin_api_key || cfg.sub2api.jwt))
    && !args.flags['no-register'];

  if (cfg.backend === 'relay') {
    getRelay(cfg);
    log('直连 relay 模式：不启动 Mirasim 后端或 Claude 保活会话');
  } else if (cfg.keepalive.enabled) {
    ctx.keepalive = new KeepaliveSupervisor(cfg, {
      onDown: () => {
        // 保活挂了 = 立刻没有可用凭证，不等健康循环慢慢发现
        if (ctx.sm) ctx.sm.pause('保活会话退出').catch((e) => warn(`PAUSE 失败：${e.message}`));
      },
      onUp: (t) => log(`保活就绪，可对外服务 port=${t.port}`),
    });
    try {
      ctx.keepalive.start();
    } catch (err) {
      return fatal(err.message);
    }
  } else {
    log('保活器已禁用——只能蹭现有会话，会话结束即不可用');
  }

  const server = createBridgeServer(cfg, ctx, secret, maxConc);
  let registration = Promise.resolve();
  let healthTimer;
  const shutdown = createShutdownHandler(cfg, ctx, { server, registration: () => registration, stopHealth: () => clearInterval(healthTimer) });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (err) {
    if (ctx.keepalive) ctx.keepalive.stop();
    throw err;
  }
  log(`桥接器监听 http://${host}:${port}`);
  log(secret ? '入站鉴权：已启用（x-api-key）' : '⚠️ 入站鉴权：未启用（bridge_secret 为空）');
  log(`并发上限 ${maxConc}（保守起步，观察稳定后再调）`);
  if (cfg.backend === 'relay') {
    const probe = await probeUpstream(resolveTarget(cfg), '/v1/models', cfg);
    log(`relay 初始探测 HTTP ${probe.status}，模型 ${probe.modelCount} 个`);
  }
  if (ctx.shuttingDown) return;

  // --- sub2api 接入 ---
  const registerAccount = async () => {
  if (withSub2api) {
    try {
      // 先 listen 再注册：sync-upstream 会打回桥接器，端口没开这步必失败
      const reg = await cmdRegister(cfg, args);
      if (reg && reg.id) {
        ctx.sm = new ScheduleState(cfg, reg.id);
        ctx.reachable = Boolean(reg.reachable);
        log(`调度状态机就绪 account_id=${reg.id}，desired=unknown（先探测，不预设）`);
        if (!ctx.reachable) {
          warn('sub2api 够不着桥接器，账号将保持暂停——健康循环会定期重试 sync-upstream。');
        }
      }
    } catch (err) {
      warn(`sub2api 注册失败：${err.message}`);
      warn('转发层照常工作，但账号不会自动进出池。修好后可单独跑 `register`。');
    }
  } else {
    log('未接入 sub2api（缺 base_url/admin_api_key 或指定了 --no-register）');
  }

  // --- 健康循环 ---
  //
  // 健康要两个方向都成立，缺一不可：
  //   正向 桥接器 → Mirasim   每 tick 探
  //   反向 sub2api → 桥接器   由 sync-upstream 证明，失败时定期重试（别每 tick 打，太吵）
  // 只探正向是不够的：本机一切正常、而 sub2api 根本连不上桥接器时，
  // 状态机会把一个不可达的账号 RESUME 进池，直接产生用户可见的 5xx。
  };

  let running = false;             // 重叠保护：慢 tick 不叠加
  let tickCount = 0;
  const RECHECK_EVERY = 10;        // 不可达时每 10 个 tick 重试一次反向验证
  healthTimer = setInterval(async () => {
    if (running || ctx.shuttingDown) return;
    running = true;
    tickCount++;
    try {
      if (withSub2api && !ctx.sm && tickCount % RECHECK_EVERY === 0) {
        await registration;
        if (ctx.shuttingDown) return;
        registration = registerAccount();
        await registration;
      }
      const t = resolveTarget(cfg, {
        preferPid: ctx.keepalive ? ctx.keepalive.pid : null, maxAgeMs: 0,
        strict: Boolean(ctx.keepalive),
      });
      let forwardOk = false;
      if (t) {
        const probe = await probeUpstream(t, '/v1/models', cfg);
        forwardOk = probe.status === 200 && probe.modelCount > 0;
        if (ctx.keepalive && t.is_keepalive && [401, 403].includes(probe.status)) ctx.keepalive.noteUpstreamAuthFail();
        if (!forwardOk) warn(`健康探测失败 HTTP ${probe.status} ${probe.error || ''}`);
      } else {
        warn('健康探测：没有可用的 agent 会话');
      }

      // 反向可达性：只在还没通过时定期重试
      if (ctx.sm && forwardOk && (!ctx.reachable || tickCount % RECHECK_EVERY === 0)) {
        try {
          const synced = await syncAccountModels(cfg, ctx.sm.accountId, {
            beforeWrite: () => ctx.sm.pause('更新上游模型映射'),
          });
          const list = synced.models;
          ctx.reachable = list.length > 0;
          if (list.length) {
            ctx.reachable = true;
            log(`反向可达性恢复：sub2api 已能打通桥接器（模型 ${list.length} 个）`);
          }
        } catch (err) {
          ctx.reachable = false;
          log(`反向可达性仍未通过：${err.message}`);
        }
      }

      if (ctx.shuttingDown) return;
      try { await refreshQuota(cfg, ctx); } catch (err) { warn(`额度备注同步失败：${err.message}`); }
      if (ctx.shuttingDown) return;
      const healthy = forwardOk && ctx.reachable && Date.now() >= ctx.backoffUntil
        && (!ctx.keepalive || ctx.keepalive.ready);
      ctx.lastHealthy = healthy;
      if (ctx.sm) await ctx.sm.onProbe(healthy);
    } catch (err) {
      warn(`健康循环异常：${err.message}`);
      ctx.lastHealthy = false;
      if (ctx.sm && !ctx.shuttingDown) await ctx.sm.onProbe(false);
    } finally {
      running = false;
    }
  }, cfg.health.interval_sec * 1000);

  registration = registerAccount();
  await registration;
  try { await refreshQuota(cfg, ctx, { force: true }); } catch (err) { warn(`额度备注同步失败：${err.message}`); }
}

async function cmdGroups(cfg, args) {
  const groups = await s2.listGroups(cfg);
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(groups, null, 2) + '\n');
    return;
  }
  log(`分组 ${groups.length} 个：`);
  log('  ID    平台          倍率   独占    状态      名称');
  for (const g of groups) {
    log(`  ${String(g.id).padEnd(5)} ${String(g.platform).padEnd(13)} x${String(g.rate_multiplier).padEnd(5)} ` +
        `${String(g.is_exclusive).padEnd(7)} ${String(g.status).padEnd(9)} ${g.name}`);
  }
  const usable = groups.filter((g) => g.platform === 'anthropic' || g.platform === 'composite');
  log('');
  log(usable.length
    ? `可放 anthropic 账号的分组：${usable.map((g) => `${g.id}(${g.name}/${g.platform})`).join('、')}`
    : '⚠️ 没有 anthropic 或 composite 分组——需要先建一个，否则账号入池也不会被调度');
}

/**
 * register：幂等注册。按 name 查重 → 建或改 → **以 sync-upstream 收尾**。
 * 最后那步不能省：账号模型列表为空 → 调度时被 isModelSupportedByAccount 过滤 → 零流量（§2.3a）。
 */
async function cmdRegister(cfg, args) {
  const name = cfg.sub2api.account_name;
  const baseUrl = bridgeBaseUrl(cfg);
  const groupIds = cfg.sub2api.group_ids || [];

  if (!groupIds.length && !args.flags.force) {
    throw new Error('sub2api.group_ids 为空。账号不属于任何分组就不会被调度——' +
                 '先跑 `groups` 选一个填进 config.json（或加 --force 强行继续）。');
  }

  log(`账号名 ${name} · base_url ${baseUrl} · group_ids [${groupIds}]`);
  if (!cfg.bridge_secret) {
    warn('bridge_secret 为空：同机任何进程都能白嫖这个端点（§8）。生产务必设置。');
  }

  // --- 拓扑预检（DESIGN.md §3）---
  // base_url 是从 **sub2api 服务器** 出发解析的。sub2api 在远端而这里填回环地址，
  // 它会去连自己的 localhost —— 必然打不通。这个检查能在建号之前就说清楚。
  const s2Host = (() => {
    try { return new URL(cfg.sub2api.base_url).hostname; } catch { return ''; }
  })();
  const s2IsRemote = s2Host && !['127.0.0.1', 'localhost', '::1'].includes(s2Host);
  const baseIsLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl);
  if (s2IsRemote && baseIsLoopback) {
    warn('管理地址使用域名，注册地址使用回环：仅凭域名无法判断是否同机。账号保持暂停，等待 sync-upstream 验证可达性。');
  }

  const existing = await s2.findAccountByName(cfg, name);
  let id;

  if (existing) {
    id = existing.id;
    await s2.setSchedulable(cfg, id, false);
    log(`已存在账号 id=${id}，执行更新`);
    const patch = {
      credentials: { ...(existing.credentials || {}), api_key: cfg.bridge_secret || 'no-auth', base_url: baseUrl },
      concurrency: cfg.sub2api.concurrency,
      priority: cfg.sub2api.priority,
    };
    if (groupIds.length && cfg.sub2api.manage_existing_groups) patch.group_ids = groupIds;
    await s2.updateAccount(cfg, id, patch);
    log('账号已更新');
  } else {
    log('账号不存在，创建');
    const created = await s2.createAccount(cfg, {
      name,
      platform: 'anthropic',
      type: 'apikey',
      credentials: { api_key: cfg.bridge_secret || 'no-auth', base_url: baseUrl },
      extra: {},
      concurrency: cfg.sub2api.concurrency,
      priority: cfg.sub2api.priority,
      rate_multiplier: 1.0,
      group_ids: [], // 先在分组外创建，暂停后再加入目标分组，避免首次创建的可调度窗口。
      auto_pause_on_expired: false,
      confirm_mixed_channel_risk: true,
      // 刻意不设任何配额字段：apikey 账号会走配额闸门，limit>0 才会卡（§2.3 闸门 4）
    });
    id = created && created.id;
    if (!id) throw new Error('建号响应缺少 id');
    saveState(cfg, { account_id: id, account_name: name, base_url: baseUrl });
    await s2.setSchedulable(cfg, id, false);
    if (groupIds.length) await s2.updateAccount(cfg, id, { group_ids: groupIds });
    log(`账号已创建 id=${id}`);
  }

  saveState(cfg, { account_id: id, account_name: name, base_url: baseUrl });

  // 收尾：拉真实模型列表（§2.3a）。
  //
  // 这一步同时是**唯一一个从 sub2api 那侧出发、能证明它够得着桥接器的检查**：
  // sync-upstream 会让 sub2api 去打 base_url。成功 = 反向可达，失败 = 账号必须保持暂停，
  // 否则它会带着一个连不通的 base_url 待在池子里，把真实用户流量变成 5xx。
  log('同步上游模型列表（sync-upstream，同时验证 sub2api → 桥接器 反向可达）…');
  let reachable = false;
  try {
    const { models: list } = await syncAccountModels(cfg, id);
    log(`模型列表 ${list.length} 个：${list.map((m) => m.model_id || m.id || m).slice(0, 12).join(', ')}`);
    if (list.length) {
      reachable = true;
    } else {
      warn('模型列表为空——账号会进池但拿不到任何流量。');
    }
  } catch (err) {
    warn(`sync-upstream 失败：${err.message}`);
    warn('说明 sub2api 够不着桥接器（拓扑不对，或桥接器没在 listen）。');
  }

  if (!reachable) {
    // 新建的账号默认就是 schedulable=true，必须立刻按住，别让它进池
    try {
      await s2.setSchedulable(cfg, id, false);
      warn('已把账号置为不可调度，避免它带着不可达的 base_url 接流量。');
    } catch (err) {
      warn(`⚠️ 连暂停都失败了（${err.message}）——请手动把账号 ${id} 停掉。`);
    }
  }

  saveState(cfg, { account_id: id, reachable });
  return { id, reachable };
}

async function cmdPause(cfg) {
  const id = (await s2.findAccountByName(cfg, cfg.sub2api.account_name) || {}).id;
  if (!id) return fatal('找不到账号，先跑 register');
  const sm = new ScheduleState(cfg, id);
  const ok = await sm.pause('手动');
  if (!ok) process.exitCode = 1;
}

async function cmdResume(cfg) {
  const id = (await s2.findAccountByName(cfg, cfg.sub2api.account_name) || {}).id;
  if (!id) return fatal('找不到账号，先跑 register');
  const sm = new ScheduleState(cfg, id);
  await syncAccountModels(cfg, id, { beforeWrite: () => sm.pause('手动恢复前更新模型映射') });
  const ok = await sm.resume('手动');
  if (!ok) process.exitCode = 1;
}

/**
 * doctor：一次性把这台机器上所有会挡住部署的问题查出来。
 * 设计目标是「云端跑一条命令，就知道要改什么」——尤其是 Linux 侧那些
 * 在 Windows 上无法验证的项（进程名匹配、/proc 权限、凭证传递方式）。
 */
async function cmdDoctor(cfg, args) {
  const checks = [];
  const add = (name, level, detail, hint) => checks.push({ name, level, detail, hint });

  // --- 运行环境 ---
  const major = Number(process.versions.node.split('.')[0]);
  add('Node 版本', major >= 18 ? 'OK' : 'FAIL', `v${process.versions.node}`,
    major >= 18 ? null : '需要 Node ≥ 18');
  add('平台', 'OK', `${process.platform} ${os.release()} (${os.userInfo().username})`);
  let target = null;
  if (cfg.backend === 'relay') {
    add('后端', 'OK', 'relay 直连（无需 server.cjs / claude CLI / 活会话）');
    try {
      const credential = loadCredential(relaySettingPath(cfg));
      add('Mirasim 凭证', credential.refresh ? 'OK' : 'WARN', credential.cpa ? 'CPA OAuth 文件 + Ed25519 设备密钥' : 'Mirasim setting.json + Ed25519 设备密钥',
        credential.refresh ? null : '缺少 refresh token，到期后需重新登录');
      target = resolveTarget(cfg);
      const probe = await probeUpstream(target, '/v1/models', cfg);
      add('relay 签名与模型列表', probe.status === 200 && probe.modelCount ? 'OK' : 'FAIL', `HTTP ${probe.status}，模型 ${probe.modelCount} 个`, probe.error);
    } catch (err) { add('relay 初始化', 'FAIL', err.message); }
  } else {

  // --- Mirasim 后端 ---
  const serverCjs = cfg.keepalive.server_cjs || defaultServerCjs();
  const hasServer = Boolean(serverCjs && fs.existsSync(serverCjs));
  add('server.cjs', hasServer ? 'OK' : 'FAIL', serverCjs || '(未找到)',
    hasServer ? null : '把 Mirasim 的 resources/server.cjs 路径填进 keepalive.server_cjs');

  // server.cjs claude 是在 PATH 里直接 exec `claude` 的（源码 vle→C__、fSn→qbv 已确认）。
  // 云端部署这一条最容易漏：装了 server.cjs 不代表有 claude CLI。
  {
    const probe = spawnSync('claude', ['--version'], { shell: true, encoding: 'utf8', timeout: 15000 });
    const ver = (probe.stdout || '').trim().split('\n')[0];
    add('claude CLI', probe.status === 0 ? 'OK' : 'FAIL',
      probe.status === 0 ? ver : 'PATH 里找不到 claude',
      probe.status === 0 ? null : '保活器靠它拉起会话：npm install -g @anthropic-ai/claude-code');
  }

  // --- 登录凭证 ---
  const settingPath = path.join(os.homedir(), '.mirasim', 'setting.json');
  if (fs.existsSync(settingPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingPath, 'utf8'));
      const auth = s.auth || {};
      const hasTok = Boolean(auth.token);
      const hasRefresh = Boolean(auth.refreshToken);
      const hours = auth.exp ? Math.round((auth.exp * 1000 - Date.now()) / 3600000) : null;
      // access token 本来就是短命的，有 refresh_token 就会自动续期——别把它报成告警
      const expiryNote = hours === null ? ''
        : hasRefresh ? `（access token ${hours}h 后到期，有 refresh_token 会自动续期）`
          : `（${hours}h 后到期，且没有 refresh_token）`;
      add('Mirasim 登录态', hasTok ? (hasRefresh ? 'OK' : 'WARN') : 'FAIL',
        hasTok ? `user=${auth.name || '?'} ${expiryNote}` : 'setting.json 里没有 auth.token',
        hasTok
          ? (hasRefresh ? null : '没有 refresh_token，到期后需要重新登录')
          : '在这台机器上跑 `node server.cjs login`，或从已登录机器拷贝 ~/.mirasim/setting.json');
      add('设备私钥', s.device && s.device.privateKey ? 'OK' : 'WARN',
        s.device && s.device.privateKey ? '存在（relay HMAC 签名用）' : '缺失',
        s.device && s.device.privateKey ? null : '拷贝 setting.json 时要带上 device.privateKey');
    } catch (err) {
      add('Mirasim 登录态', 'FAIL', `setting.json 解析失败: ${err.message}`);
    }
  } else {
    add('Mirasim 登录态', 'FAIL', `${settingPath} 不存在`,
      '跑 `node server.cjs login`，或从已登录机器拷贝整个 ~/.mirasim/');
  }

  // --- 进程发现（Linux 上最容易出问题的一步）---
  const { procs, pids, candidates } = listCandidatePorts(cfg);
  if (!procs.length) {
    add('Mirasim 进程发现', 'WARN', `匹配模式 ${JSON.stringify(cfg.discovery.process_match)} 没命中任何进程`,
      'Mirasim 没在跑属正常。若在跑却没命中，把可执行文件路径里的特征词加进 discovery.process_match');
  } else {
    add('Mirasim 进程发现', 'OK', `命中 ${procs.length} 个进程 (pid ${pids.slice(0, 5).join(',')})`);
    if (!candidates.length) {
      add('回环端口枚举', IS_WIN ? 'WARN' : 'FAIL', '进程找到了，但一个回环 LISTEN 端口都没有',
        IS_WIN ? '可能确实没有会话在跑'
          : '典型原因是读不了 /proc/<pid>/fd（EACCES）。桥接器必须与 Mirasim 同用户运行，' +
            '或授予 CAP_SYS_PTRACE。systemd 里把 User= 设成 Mirasim 的属主。');
    } else {
      add('回环端口枚举', 'OK', `${candidates.length} 个：${candidates.map((c) => c.port).join(', ')}`);
    }
  }

  // --- 凭证采集通道（Windows 与 Linux 可能不同）---
  const agents = findAgentProcesses();
  if (!agents.length) {
    add('活会话与凭证采集', 'WARN', '当前没有 agent 会话在跑',
      '起一个会话再跑一次 doctor，才能验证凭证采集通道；或直接跑 `serve` 让保活器拉起');
  } else {
    const srcs = [...new Set(agents.map((a) => a.token_source))].join('/');
    add('活会话与凭证采集', 'OK',
      `${agents.length} 个会话，凭证来源=${srcs}，端口=${agents.map((a) => a.base_port).join(',')}`);
    if (!IS_WIN && srcs === 'proc_environ') {
      add('凭证通道差异', 'WARN', 'Linux 走的是 /proc/environ 而非 settings 文件',
        '说明 Linux 上 Mirasim 用环境变量传子进程。功能不受影响（已支持），但记录下来');
    }
  }

  // --- 端到端探测 ---
  target = resolveTarget(cfg, { maxAgeMs: 0 });
  if (target) {
    const probe = await probeUpstream(target, '/v1/models', cfg);
    add('上游端点自检', probe.status === 200 ? 'OK' : 'FAIL',
      `127.0.0.1:${target.port} → HTTP ${probe.status}，模型 ${probe.modelCount} 个`,
      probe.status === 200 ? null : `token 可能失效或端点异常：${probe.error || ''}`);
  } else {
    add('上游端点自检', 'WARN', '没有可用目标，跳过');
  }

  }
  // --- 桥接器自身 ---
  add('bridge_secret', cfg.bridge_secret ? 'OK' : 'WARN',
    cfg.bridge_secret ? `已设置（${cfg.bridge_secret.length} 字符）` : '为空 = 不鉴权',
    cfg.bridge_secret ? null
      : '同机任何进程都能白嫖这个端点。生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');

  const portFree = await new Promise((resolve) => {
    const srv = http.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(cfg.listen.port, cfg.listen.host, () => srv.close(() => resolve(true)));
  });
  add('监听端口', portFree ? 'OK' : 'WARN', `${cfg.listen.host}:${cfg.listen.port} ${portFree ? '可用' : '已被占用'}`,
    portFree ? null : '换个端口，或先停掉已在跑的 serve');

  // --- sub2api ---
  if (cfg.sub2api.base_url && (cfg.sub2api.admin_api_key || cfg.sub2api.jwt)) {
    try {
      const groups = await s2.listGroups(cfg);
      add('sub2api 连通与鉴权', 'OK', `${groups.length} 个分组`);

      const ids = cfg.sub2api.group_ids || [];
      const bad = ids.filter((id) => !groups.some((g) => g.id === id));
      const usable = groups.filter((g) => ids.includes(g.id)
        && (g.platform === 'anthropic' || g.platform === 'composite'));
      add('目标分组', ids.length === 0 ? 'FAIL' : bad.length ? 'FAIL' : usable.length === ids.length ? 'OK' : 'FAIL',
        ids.length === 0 ? '未配置 group_ids'
          : bad.length ? `分组 ${bad.join(',')} 不存在`
            : usable.length ? usable.map((g) => `${g.id}(${g.name}/${g.platform} x${g.rate_multiplier})`).join('、')
              : `分组 ${ids.join(',')} 的 platform 不接受 anthropic 账号`,
        ids.length ? null : '跑 `groups` 挑一个填进 sub2api.group_ids');

      const acct = await s2.findAccountByName(cfg, cfg.sub2api.account_name);
      if (acct) {
        let registered = [];
        try {
          const m = await s2.listModels(cfg, acct.id);
          const list = Array.isArray(m) ? m : (m && m.items) || [];
          registered = list.map((x) => x.model_id || x.id || String(x));
        } catch { /* 忽略 */ }
        add('账号现状', 'OK',
          `id=${acct.id} status=${acct.status} schedulable=${acct.schedulable} 模型 ${registered.length} 个`,
          registered.length ? null : '模型列表为空 → 即使入池也拿不到流量，需要成功跑一次 sync-upstream');

        // 模型列表一致性：建号时 sub2api 会自动填一批平台默认模型，
        // 那批和上游实际提供的往往对不上。多出来的部分是**危险的**——
        // sub2api 会把这些模型的请求路由过来，而上游根本没有，直接报错。
        if (registered.length && target) {
          const up = await probeUpstream(target, '/v1/models', cfg);
          if (up.status === 200 && up.models.length) {
            up.models = up.models.filter((m) => isModelAllowed(m, cfg));
            const upSet = new Set(up.models);
            const regSet = new Set(registered);
            const phantom = registered.filter((m) => !upSet.has(m));
            const missing = up.models.filter((m) => !regSet.has(m));
            add('模型列表一致性', phantom.length ? 'FAIL' : (missing.length ? 'WARN' : 'OK'),
              `已注册 ${registered.length} / 上游实有 ${up.models.length}`
              + (phantom.length ? ` · 多出 ${phantom.length}` : '')
              + (missing.length ? ` · 缺 ${missing.length}` : ''),
              phantom.length
                ? `这些模型已注册但上游没有，会被错误路由过来：${phantom.join(', ')}。`
                  + '跑一次成功的 sync-upstream 覆盖掉默认列表。'
                : (missing.length
                  ? `上游有但没注册（拿不到这部分流量）：${missing.join(', ')}`
                  : null));
          }
        }
      } else {
        add('账号现状', 'WARN', `不存在（名为 ${cfg.sub2api.account_name}）`, '跑 `register` 创建');
      }
    } catch (err) {
      add('sub2api 连通与鉴权', 'FAIL', err.message, '检查 base_url 与 admin_api_key');
    }
  } else {
    add('sub2api 连通与鉴权', 'WARN', '未配置 base_url / admin_api_key', '阶段 3 需要');
  }

  // --- 拓扑一致性（§3.1 那个 502 的根因）---
  const baseUrl = bridgeBaseUrl(cfg);
  let s2Host = '';
  try { s2Host = new URL(cfg.sub2api.base_url).hostname; } catch { /* 未配置 */ }
  const s2Remote = s2Host && !['127.0.0.1', 'localhost', '::1'].includes(s2Host);
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(baseUrl);
  add('拓扑一致性', (s2Remote && loopback) ? 'WARN' : 'OK',
    `sub2api=${s2Host || '?'} · 注册用 base_url=${baseUrl}`,
    (s2Remote && loopback)
      ? '域名不代表远程主机。原生同机部署可以用回环；容器或异机请配置 public_base_url。最终以 sync-upstream 成功为准。'
      : null);

  // --- 输出 ---
  if (args.flags.json) {
    if (checks.some((c) => c.level === 'FAIL')) process.exitCode = 1;
    process.stdout.write(JSON.stringify(checks, null, 2) + '\n');
    return;
  }
  const icon = { OK: '✅', WARN: '⚠️ ', FAIL: '❌' };
  log('');
  for (const c of checks) {
    log(`${icon[c.level]} ${c.name.padEnd(20)} ${c.detail}`);
    if (c.hint) log(`   ↳ ${c.hint}`);
  }
  const fails = checks.filter((c) => c.level === 'FAIL').length;
  const warns = checks.filter((c) => c.level === 'WARN').length;
  log('');
  log(`${checks.length} 项检查：${checks.length - fails - warns} 通过 · ${warns} 警告 · ${fails} 失败`);
  if (fails) {
    log('存在 FAIL 项，先修完再跑 serve。');
    process.exitCode = 1;
  }
}

function cmdHelp() {
  process.stdout.write(`
mirasim-bridge ${VERSION}  —— Claude / GPT / DeepSeek / Kimi（Messages + GPT Responses）

用法：
  node mirasim-bridge.js <子命令> [选项]

已实现：
  observe [--interval 5] [--out timeline.jsonl] [--heartbeat 300]
        长时间轮询端口发现，把「端口出现/消失/形态切换」写成 JSONL 时间线。
        用于 session 后端排查端口生命周期；relay 后端不需要此步骤。
        Ctrl-C 结束，会补一条 observe_stop。

  discover [--json]
        单次扫描：定位 Mirasim 进程 → 列出其回环 LISTEN 端口 → 三态探测。

  models [--family claude|gpt|deepseek|kimi] [--json]
        从桥接器列出模型；列出不代表当前推理可用。
  models --check --model X [--max-tokens 128] [--timeout-sec 30] [--json]
        经桥接器检测一个型号，发送真实请求、消耗额度。失败退出码 1。
  test [--model X] [--max-tokens 128] [--timeout-sec 30] [--protocol messages|responses] [--direct]
        默认经桥接器；--direct 使用所选后端直连。relay GPT 默认 Responses。
        --max-tokens 仅限制 Messages；Codex Responses 会移除输出上限字段。
        打印 HTTP 状态、回复、usage；流错误/无正文也判定失败。

  quota [--direct]
        relay 模式读取剩余百分比/重置时间；--raw 返回原始 limits，不触发模型推理。

  login --profile mira2 --public-base-url http://mirasim-mira2:8787 [--provider google]
        独立 OAuth 登录另一个账号，保存到配置目录 profiles/mira2，不覆盖原凭证。
  accounts
        列出独立 profile（不输出 token）。每个 profile 使用独立进程/容器运行。

  status
        读取桥接器状态与 sub2api 调度状态，不打印凭证，不触发推理。

  serve [--port N] [--host H] [--no-register]
        常驻转发：relay 直连或 session 保活 + sub2api 自动注册
        + 健康循环驱动的自动暂停/恢复 + 优雅退出先摘流量。
        内部端点 /__live（进程存活）、/__health（上游就绪）、/__status。

  groups [--json]
        列出 sub2api 分组，并标出哪些能放 anthropic 账号。

  register [--force]
        幂等注册/更新账号，以 sync-upstream 收尾（不收尾会零流量）。
        需要桥接器正在 listen——sync-upstream 会打回来。

  pause / resume
        手动触发调度暂停 / 恢复组合动作（运维兜底）。

  doctor [--json]
        relay 检查凭证与签名链路；session 检查后端、CLI、进程及凭证采集。
        两者均检查监听端口、sub2api 连通、分组和拓扑。不能代替真机推理验收。

  selftest
        用合成数据验证平台相关的纯函数（/proc/net/tcp 十六进制解码、行解析、
        命令行提取、CC 注入、三态分类）。不需要 Mirasim 在跑，也不需要 Linux 机器。

  help  本帮助

通用选项：
  --config <path>   配置文件（缺省：脚本目录下的 config.json，不存在则用内置默认值）

环境变量：
  SUB2API_BASE_URL / SUB2API_ADMIN_API_KEY / MIRASIM_ACCOUNT_NAME
  MIRASIM_LISTEN_HOST / MIRASIM_LISTEN_PORT

事件类型（JSONL 的 event 字段）：
  observe_start / observe_stop / heartbeat / tick_error
  process_up / process_down          Mirasim 进程增减
  listen_up / listen_down            回环 LISTEN 端口增减
  probe_class_change                 端口还在但形态变了（socket 未关却不再应答）
  proxy_up / proxy_down              目标端点可用/不可用
  proxy_switch                       目标端点换了端口
  models_change                      模型列表长度变化
  agent_spawn / agent_exit           Mirasim 拉起/结束了 agent CLI，
                                     带 base_url、token 指纹、是否为新 token

注意：token 只记 sha256 前 12 位指纹，不记原文——它是活凭证。
      指纹足以回答「是否每会话一换」，这正是 §A 实验 1 的核心问题。
`);
}

// ---------------------------------------------------------------------------
// CLI 分发
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  if (args.flags.version) return process.stdout.write(VERSION + '\n');
  if (cmd === 'help' || args.flags.help) return cmdHelp();

  const cfg = loadConfig(args);

  switch (cmd) {
    case 'login':
      return require('./scripts/account-login').login(cfg, args.flags);
    case 'accounts':
      process.stdout.write(JSON.stringify(require('./lib/login').listProfiles(path.dirname(path.resolve(cfg._config_path || path.join(__dirname, 'config.json')))), null, 2) + '\n');
      return;
    case 'discover':
      return cmdDiscover(cfg, args);
    case 'observe':
      return cmdObserve(cfg, args);
    case 'selftest':
      return cmdSelftest();
    case 'doctor':
      return cmdDoctor(cfg, args);
    case 'test':
      return cmdTest(cfg, args);
    case 'models':
      return cmdModels(cfg, args);
    case 'status': {
      const result = await diagnosticRequest(diagnosticTarget(cfg), '/__status');
      if (result.status !== 200) throw new Error(`桥接器状态 HTTP ${result.status}`);
      process.stdout.write(JSON.stringify(JSON.parse(result.raw), null, 2) + '\n');
      return;
    }
    case 'quota': {
      if (cfg.backend !== 'relay') throw new Error('quota 需要 backend=relay');
      const result = await diagnosticRequest(diagnosticTarget(cfg, Boolean(args.flags.direct)), '/v1/limits');
      if (result.status !== 200) throw new Error(`额度查询 HTTP ${result.status}（未发起推理请求）`);
      process.stdout.write(JSON.stringify(args.flags.raw ? JSON.parse(result.raw) : summarizeLimits(JSON.parse(result.raw)), null, 2) + '\n');
      return;
    }
    case 'serve':
      return cmdServe(cfg, args);
    case 'groups':
      return cmdGroups(cfg, args);
    case 'register':
      return cmdRegister(cfg, args);
    case 'pause':
      return cmdPause(cfg);
    case 'resume':
      return cmdResume(cfg);
    default:
      process.stderr.write(`未知子命令: ${cmd}\n`);
      cmdHelp();
      process.exit(1);
  }
}

if (require.main === module) main().catch((err) => fatal(err && err.stack ? err.stack : String(err)));
module.exports = { DEFAULT_CONFIG, deepMerge, validateConfig, resolveAgentEnv, resolveTarget,
  targetCache, invalidateTarget, createBridgeServer, mergedHeaders, readStreamText,
  requestUpstream, ScheduleState, s2, cmdRegister, cmdDoctor, loadState, saveState,
  modelFamily, isModelAllowed, summarizeModelResponse, diagnosticTarget, diagnosticRequest,
  getDiagnosticCatalog, checkDiagnosticModel, cmdModels, cmdTest, getRelay, relaySettingPath, probeUpstream, createShutdownHandler, syncAccountModels, refreshQuota, sanitizeMessagesRequest };
