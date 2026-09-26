'use strict';
const $ = (id) => document.getElementById(id);
const host = document.body.dataset.mode === 'host';
let key = '', loginSession = null, timer = null, polling = false, noticeTimer = null, view = 'overview';
let selected = { target: 'main', account: 'main' };
let fleetRows = [], bridgeVersion = null, modelRows = [], modelsFor = '', groupsCache = null;
let actionsBusy = 0, accessHideTimer = null, accessFor = '', loginFinishing = false;
const connectionResults = new Map();
let keeperModelsFor = '';
const renderCache = new WeakMap(), readVersions = new Map(), dirtyForms = new Map();
const connectionFlights = new Map(), connectionBusy = new Set(), connectionErrors = new Map(), testResults = new Map();
const keeperRunning = new Set();
const fleetNodes = new Map();
let deploymentRunning = false, modelsUpdatedAt = 0;
let releaseCheckedAt = 0, lastRegularPoll = 0;
let groupsReadAt = 0, groupsFlight = null;
let fleetLoadedAt = null, batchCheck = null;
let usageData = null, usageFor = '';
const PRICE_FIELDS = { input: 'price-input', output: 'price-output', cache_read: 'price-cache-read', cache_write: 'price-cache-write' };
const FLAG_LABELS = { unavailable: '状态读取失败', expired: '会员已到期', expiring: '会员三天内到期', low_quota: '账号额度不超过 10%',
  cooldown: '上游退避中', unreachable: 'sub2 反向未通', upstream: '上游未就绪', membership_unknown: '会员状态未知' };
function accountFlags(row, now = Date.now()) {
  if (row.error) return ['unavailable'];
  const a = row.summary || {}, m = a.membership, q = a.quota, flags = [];
  if (m?.available && !m.stale) {
    const expiry = Date.parse(m.expires_at);
    if (Number.isFinite(expiry)) { if (expiry <= now) flags.push('expired'); else if (expiry - now <= 3 * 86400000) flags.push('expiring'); }
  } else flags.push('membership_unknown');
  if (q?.available && !q.stale && !q.unmetered && (q.windows || []).some(w => !w.model_scoped
    && typeof w.remaining_percent === 'number' && Number.isFinite(w.remaining_percent) && w.remaining_percent <= 10)) flags.push('low_quota');
  if (a.backoff_sec_left > 0) flags.push('cooldown');
  if (a.sub2api?.managed && !a.sub2api.reachable) flags.push('unreachable');
  if (a.relay && !a.relay.ready) flags.push('upstream');
  return flags;
}
function filterAccounts(rows, query = '', filter = 'all', order = 'default') {
  const wanted = query.trim().toLocaleLowerCase();
  const result = rows.filter(r => {
    const a = r.summary || {}, flags = accountFlags(r);
    const text = [r.target, r.account, a.account_name, a.membership?.plan, ...(a.group_ids || [])].join(' ').toLocaleLowerCase();
    return (!wanted || text.includes(wanted)) && (filter === 'all' || !filter || filter === 'issues' && flags.length > 0
      || filter === 'paused' && (a.hold || a.sub2api?.schedulable === 'off') || flags.includes(filter));
  });
  if (order === 'name') result.sort((a,b) => label(a).localeCompare(label(b)));
  if (order === 'expiry') result.sort((a,b) => {
    const expiry = r => r.error || r.summary.membership?.stale ? Infinity : (Date.parse(r.summary.membership?.expires_at) || Infinity);
    return expiry(a) - expiry(b) || label(a).localeCompare(label(b));
  });
  if (order === 'issues') result.sort((a,b) => accountFlags(b).length - accountFlags(a).length || label(a).localeCompare(label(b)));
  return result;
}
function visibleAccounts() { return filterAccounts(fleetRows, $('account-search').value, $('account-filter').value, $('account-sort').value); }
function filterModels(rows, query = '', filter = 'all', family = '', scope = selected) {
  const wanted = query.trim().toLocaleLowerCase();
  return rows.filter(m => {
    const result = testResults.get(identity(scope) + '|' + m.id);
    return (!wanted || m.id.toLocaleLowerCase().includes(wanted)) && (!family || family === 'all' || m.family === family)
      && (filter === 'all' || !filter || filter === 'enabled' && m.enabled || filter === 'disabled' && !m.enabled
        || filter === 'tested_failed' && result && !result.pending && (result.error || result.result?.ok === false));
  });
}
function diagnosticReport(now = Date.now()) {
  const number = v => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null;
  const date = v => { const n = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? new Date(n).toISOString() : null; };
  return { schema: 1, exported_at: new Date(now).toISOString(), snapshot_at: date(fleetLoadedAt),
    version: /^\d+\.\d+\.\d+$/.test(bridgeVersion || '') ? bridgeVersion : null,
    note: 'Cached status only; account names/addresses/keys/tokens/raw logs are excluded. No probes were sent.',
    accounts: fleetRows.map((r, index) => {
      const a = r.summary || {}, q = a.quota || {}, m = a.membership || {}, result = connectionResults.get(identity(r));
      return { ref: 'account-' + (index + 1), current: sameAccount(r), unavailable: Boolean(r.error), flags: accountFlags(r, now),
        schedulable: ['on','off','unknown','unmanaged'].includes(a.sub2api?.schedulable) ? a.sub2api.schedulable : 'unknown',
        hold: Boolean(a.hold), reachable: Boolean(a.sub2api?.reachable), inflight: number(a.inflight),
        membership: { available: Boolean(m.available), stale: Boolean(m.stale), expires_at: date(m.expires_at), observed_at: date(m.observed_at) },
        quota: { available: Boolean(q.available), stale: Boolean(q.stale), observed_at: date(q.observed_at), unmetered: Boolean(q.unmetered),
          windows: (q.windows || []).filter(w => ['5h','7d','7d_claude','7d_fable'].includes(w.name)).map(w => ({ name: w.name, remaining_percent: number(w.remaining_percent), reset_at: date(w.reset_at), model_scoped: Boolean(w.model_scoped) })) },
        counters: Object.fromEntries(['total','ok','err','rejected','fallback'].map(k => [k, number(a.counters?.[k])])),
        connection: result ? { checked_at: date(result.checked_at), bridge_ok: result.bridge?.ok === true, sub2_ok: typeof result.sub2api?.ok === 'boolean' ? result.sub2api.ok : null,
          status: number(result.bridge?.status), elapsed_ms: number(result.bridge?.elapsed_ms), model_count: number(result.bridge?.model_count) } : null };
    }) };
}
const identity = (scope = selected) => `${scope.target}|${scope.account}`;
const sameAccount = (scope) => identity(scope) === identity();
function beginRead(section, scope = { ...selected }) {
  const id = (readVersions.get(section) || 0) + 1; readVersions.set(section, id);
  return { scope, valid: () => readVersions.get(section) === id && sameAccount(scope) };
}
function renderChanged(id, value, draw) {
  const element = typeof id === 'string' ? $(id) : id, signature = JSON.stringify(value);
  if (renderCache.get(element) === signature) return;
  draw(element); renderCache.set(element, signature);
}
function markRefreshed() {
  $('refreshed').hidden = false; $('refreshed').textContent = '自动同步于 ' + new Date().toLocaleTimeString();
}
function formWritable(id, scope = selected) {
  return dirtyForms.get(id) !== identity(scope) && document.activeElement?.form !== $(id);
}
for (const id of ['settings-form', 'codex-form', 'keeper-form', 'pricing-form']) {
  for (const event of ['input', 'change']) $(id).addEventListener(event, () => dirtyForms.set(id, identity()));
}
const titles = { overview: '运行概览', accounts: '账号管理', models: '模型目录', usage: '用量统计', logs: '运行日志', release: '版本与升级' };
const KNOWN = ['claude', 'gpt', 'deepseek', 'kimi'];
const FAMILY_NAMES = { claude: 'Claude', gpt: 'GPT', deepseek: 'DeepSeek', kimi: 'Kimi', glm: 'GLM', other: '其他' };
const familyName = (f) => FAMILY_NAMES[f] || (f ? f.charAt(0).toUpperCase() + f.slice(1) : '其他');
const familyOrder = (f) => (KNOWN.includes(f) ? KNOWN.indexOf(f) : 10);
const ACTIONS = { deploy: '升级', rollback: '回退', start: '启动容器', stop: '停止容器', attach: '启动独立容器', 'account/host': '托管账号', 'account/unhost': '移出托管', 'account/pause': '暂停调度', 'account/resume': '恢复调度', model: '模型启停', 'models/family': '系列启停', settings: '运行设置', codex: 'Codex 账号', test: '模型测试', 'login/start': '发起登录', 'login/complete': '完成登录' };
const SCHED = { on: ['已入池', 'ok'], off: ['已暂停', 'warn'], unmanaged: ['未接管', ''], unknown: ['等待确认', 'warn'] };
Object.assign(ACTIONS, { 'account/access': '查看接入密钥', 'account/check': '检测账号连接' });
Object.assign(ACTIONS, { 'membership/refresh': '查询会员状态', 'window-keeper': '窗口任务设置', 'window-keeper/check': '检查额度窗口' });
async function groups() {
  if (groupsCache && Date.now() - groupsReadAt < 60000) return groupsCache;
  if (!groupsFlight) groupsFlight = api('groups', {}, 'main').then(rows => {
    groupsCache = rows; groupsReadAt = Date.now(); return rows;
  }).finally(() => { groupsFlight = null; });
  return groupsFlight;
}
function fillGroups(select, platforms, current, placeholder) {
  const keep = current ?? select.value;
  select.replaceChildren(node('option', placeholder));
  select.firstChild.value = '';
  for (const g of (groupsCache || []).filter((g) => platforms.includes(g.platform))) { const o = node('option', `${g.id} · ${g.name}（${g.platform}）`); o.value = String(g.id); select.append(o); }
  select.value = keep != null && [...select.options].some((o) => o.value === String(keep)) ? String(keep) : '';
}

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  $('notice-text').textContent = text; $('notice').hidden = false; $('notice').classList.toggle('error', error);
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
function node(tag, text, cls) { const n = document.createElement(tag); n.textContent = text ?? ''; if (cls) n.className = cls; return n; }
function pill(text, tone) { return node('span', text, 'pill' + (tone ? ' ' + tone : '')); }
function empty(text) { return node('p', text, 'empty'); }
function relative(ms) {
  const diff = ms - Date.now(), abs = Math.abs(diff), future = diff > 0;
  const [n, unit] = abs < 60e3 ? [Math.max(1, Math.round(abs / 1e3)), '秒'] : abs < 3600e3 ? [Math.round(abs / 60e3), '分钟'] : abs < 86400e3 ? [Math.round(abs / 3600e3), '小时'] : [Math.round(abs / 86400e3), '天'];
  return future ? `${n} ${unit}后` : `${n} ${unit}前`;
}
const ms = (v) => (v == null ? '—' : v >= 10000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
function versionNewer(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
const label = (row) => row.account === 'main' ? (row.target === 'main' ? 'main' : `${row.target}（容器）`) : `${row.target} › ${row.account}`;
async function api(operation, data = {}, target = selected.target) {
  const response = await fetch(host ? '/panel/api' : '/__panel/' + operation, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-key': key },
    body: JSON.stringify(host ? { operation, target, data } : data), signal: AbortSignal.timeout(operation === 'stop' ? 230000 : 60000) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || `HTTP ${response.status}`); return result;
}
const scoped = (data = {}, scope = selected) => ({ account: scope.account, ...data });
function guarded(fn) {
  return async (event) => {
    event?.preventDefault();
    const btn = event?.submitter || (event?.currentTarget?.tagName === 'BUTTON' ? event.currentTarget : null);
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    actionsBusy++;
    try { await fn(event); } catch (e) { notice(e.message, true); if ($('account-dialog').open) $('login-message').textContent = e.message; }
    finally { actionsBusy--; if (btn) { btn.disabled = btn.id === 'check-keeper' && (keeperRunning.has(identity()) || btn.dataset.policyDisabled === 'true'); btn.removeAttribute('aria-busy'); } }
  };
}
function stat(id, value, tone) { $(id).querySelector('strong').textContent = value; if (tone) $(id).dataset.tone = tone; else delete $(id).dataset.tone; }
function hideAccess() {
  clearTimeout(accessHideTimer); accessFor = '';
  $('access-key').value = ''; $('access-key').type = 'password'; $('access-base').value = ''; $('access-info').hidden = true;
}
async function revealAccess() {
  const identity = `${selected.target}|${selected.account}`;
  const r = await api('account/access', scoped({ reveal: true }));
  if (identity !== `${selected.target}|${selected.account}`) throw Error('当前账号已切换，请重新查看密钥');
  hideAccess(); accessFor = identity;
  $('access-info').hidden = false; $('access-base').value = r.base_url; $('access-key').value = r.api_key; $('access-key').type = 'text';
  accessHideTimer = setTimeout(hideAccess, 60000);
  return r.api_key;
}
function renderConnection() {
  const id = identity(), box = $('connection-check'), r = connectionResults.get(id), pending = connectionBusy.has(id), error = connectionErrors.get(id);
  renderChanged(box, [id, r, pending, error], () => {
  box.replaceChildren();
  if (pending) { box.dataset.tone = 'info'; box.append(node('strong', '正在检测，结果将自动更新…')); return; }
  if (error) { box.dataset.tone = 'bad'; box.append(node('strong', '检测暂未完成'), node('span', error)); return; }
  if (!r) { box.append(node('strong', '尚未检测')); delete box.dataset.tone; return; }
  const complete = r.bridge.ok && r.sub2api.ok === true;
  box.dataset.tone = !r.ok ? 'bad' : complete ? 'ok' : 'warn';
  box.append(node('strong', !r.ok ? '连接检测未通过' : complete ? '两段连接均通过' : '桥接器已连通，sub2 尚未检测'),
    node('span', r.bridge.message + (r.bridge.model_count != null ? ` · ${r.bridge.model_count} 个模型` : '') + ` · ${ms(r.bridge.elapsed_ms)}`),
    node('span', r.sub2api.message), node('span', '检测于 ' + new Date(r.checked_at).toLocaleTimeString()));
  });
}
async function checkConnection(target, account) {
  const scope = { target, account }, id = identity(scope);
  if (connectionFlights.has(id)) return connectionFlights.get(id);
  if (sameAccount(scope)) beginRead('connection-status', scope); // invalidate any older passive snapshot
  connectionBusy.add(id); connectionErrors.delete(id); if (sameAccount(scope)) renderConnection();
  schedulePoll(2000);
  const task = (async () => {
    try { const r = await api('account/check', { account }, target); connectionResults.set(id, r); return r; }
    catch (err) { connectionErrors.set(id, err.message); throw err; }
    finally { connectionBusy.delete(id); connectionFlights.delete(id); if (sameAccount(scope)) renderConnection(); }
  })();
  connectionFlights.set(id, task); return task;
}
async function connectionStatus() {
  const read = beginRead('connection-status'), id = identity(read.scope);
  if (connectionFlights.has(id)) { renderConnection(); return; }
  const data = await api('account/check/status', scoped({}, read.scope), read.scope.target);
  if (!read.valid() || connectionFlights.has(id)) return;
  if (data.result) { connectionResults.set(id, data.result); connectionErrors.delete(id); }
  if (data.running) connectionBusy.add(id); else connectionBusy.delete(id);
  renderConnection();
}
function quotaLevel(pct) { return pct == null ? '' : pct < 10 ? 'bad' : pct < 30 ? 'warn' : 'ok'; }
function membershipLabel(m) {
  if (!m?.available || m.stale) return ['会员状态待查询', 'warn'];
  const expiry = Date.parse(m.expires_at);
  return !Number.isFinite(expiry) ? [`${m.plan} · 未提供到期时间`, ''] : expiry <= Date.now()
    ? [`${m.plan} · 已到期`, 'bad'] : [`${m.plan} · ${relative(expiry)}到期`, expiry - Date.now() < 3 * 86400000 ? 'warn' : 'ok'];
}
function renderMembership(m) {
  const [text, tone] = membershipLabel(m), box = $('membership');
  renderChanged(box, [identity(), m, text], () => {
  box.replaceChildren(node('strong', text)); box.dataset.tone = tone;
  if (m?.expires_at) box.append(node('span', `到期时间：${new Date(m.expires_at).toLocaleString()}${m.stale ? '（历史值）' : ''}`));
  if (m?.observed_at) box.append(node('span', `查询于 ${new Date(m.observed_at).toLocaleString()}`));
  });
}
const KEEPER_REASONS = { disabled: '已关闭', checking: '正在检查窗口', waiting_for_window: '等待窗口到期或空闲证据', window_due: '窗口需要启动',
  quota_unknown: '额度信息未知或已过期', quota_exhausted: '额度暂不可用', unmetered: '账号不计量，无需启动窗口', account_restricted: '上游限制中，已跳过',
  daily_cap: '已达到滚动 24 小时次数上限', minimum_interval: '等待最小请求间隔', account_busy_or_paused: '账号忙碌或已暂停',
  membership_unavailable: '会员未知或已到期，已跳过', another_worker: '另一任务正在处理', model_unavailable: '所选模型当前不可用',
  stale_lock: '存在中断任务的锁，已停止发送；请确认旧任务停止后恢复', duplicate_identity: '同一 Mira 身份配置了重复任务，已暂停发送',
  accepted: '请求成功，等待窗口确认', confirmed: '复查确认窗口已在计时', unverified: '尚未确认窗口，等待完整周期后再检查',
  ambiguous: '请求结果不确定，暂不重发', failed: '请求失败，等待退避', dispatched: '发送记录已保存',
  state_unreadable: '状态文件不可读，已停止发送；请恢复记录', state_or_probe_error: '状态存储或预检失败，本轮已停止' };
async function keeperCard() {
  const read = beginRead('keeper'), id = identity(read.scope);
  const data = await api('window-keeper', scoped({}, read.scope), read.scope.target);
  if (!read.valid()) return;
  if (data.running) keeperRunning.add(id); else keeperRunning.delete(id);
  const box = $('keeper-status');
  renderChanged(box, [id, data], () => {
  box.replaceChildren(node('strong', data.running ? '正在检查，结果将自动更新…' : KEEPER_REASONS[data.reason] || data.reason));
  box.append(node('span', `近 24 小时已发送 ${data.sent_last_24h || 0} / ${data.max_per_day || 6} 次`));
  box.dataset.tone = ['state_unreadable', 'state_or_probe_error', 'failed'].includes(data.reason) ? 'bad' : data.reason === 'confirmed' ? 'ok' : '';
  });
  $('check-keeper').disabled = !data.enabled || Boolean(data.running);
  $('check-keeper').dataset.policyDisabled = String(!data.enabled);
  if (formWritable('keeper-form', read.scope)) {
    if (keeperModelsFor !== id) {
      let options;
      try {
        options = await api('models', scoped({}, read.scope), read.scope.target);
      } catch {
        options = data.model ? [{ id: data.model }] : [];
        if (read.valid()) box.append(node('span', '模型目录暂不可用，保留当前选择；可稍后刷新。'));
      }
      if (!read.valid() || !formWritable('keeper-form', read.scope)) return;
      const placeholder = node('option', '请选择模型…'); placeholder.value = '';
      $('keeper-model').replaceChildren(placeholder, ...options.filter(m => m.enabled || m.id === data.model).map(m => { const o = node('option', m.id); o.value = m.id; return o; }));
      keeperModelsFor = id;
    }
    if (!read.valid() || !formWritable('keeper-form', read.scope)) return;
    $('keeper-enabled').checked = data.enabled; $('keeper-cap').value = data.max_per_day || 6;
    $('keeper-5h').checked = data.windows?.includes('5h'); $('keeper-7d').checked = data.windows?.includes('7d');
    $('keeper-model').value = data.model || '';
  }
  renderChanged('keeper-history', [id, data.attempts], box => box.replaceChildren(...(data.attempts || []).map(a => {
    const line = node('div', '', 'event'); line.append(node('time', new Date(a.at).toLocaleString()),
      node('div', `${a.model} · ${(a.windows || []).join(' / ')}`), pill(KEEPER_REASONS[a.outcome] || a.outcome, a.outcome === 'confirmed' ? 'ok' : 'warn')); return line;
  })));
}
function quotaMini(quota) {
  const box = node('div', '', 'quota-mini');
  if (!quota || !quota.available || quota.stale) { box.append(node('span', quota?.stale ? '额度已过期' : '额度未知', 'hint')); return box; }
  if (quota.unmetered) { box.append(node('span', '不计量', 'hint')); return box; }
  for (const w of (quota.windows || []).filter((w) => !w.model_scoped).slice(0, 2)) {
    const line = node('div', '', 'mini-line'); line.dataset.level = quotaLevel(w.remaining_percent);
    line.append(node('span', w.name), node('b', w.remaining_percent == null ? '?' : `${w.remaining_percent}%`));
    const meter = node('div', '', 'meter'), fill = document.createElement('i'); fill.style.width = Math.max(0, Math.min(100, w.remaining_percent ?? 0)) + '%'; meter.append(fill); line.append(meter);
    box.append(line);
  }
  return box;
}

/** Every Mira account across every target: hosted accounts plus separate containers. */
async function fleet() {
  const read = beginRead('fleet');
  const targets = host ? await api('targets') : [{ name: 'main' }];
  const rows = (await Promise.all(targets.map(async (t) => {
    try {
      const s = await api('status', { account: 'main' }, t.name);
      const list = Array.isArray(s.accounts) && s.accounts.length ? s.accounts : [{ key: 'main', account_name: '?', sub2api: s.sub2api, quota: s.quota, inflight: s.inflight, counters: s.counters, hold: s.hold }];
      return list.map((a) => ({ target: t.name, account: a.key, version: s.version, hosting: Boolean(s.hosting), summary: a }));
    } catch (e) {
      const previous = fleetRows.filter(r => r.target === t.name);
      return previous.length ? previous.map(r => ({ ...r, error: e.message })) : [{ target: t.name, account: 'main', error: e.message, summary: {} }];
    }
  }))).flat();
  if (!read.valid()) return;
  fleetRows = rows;
  fleetLoadedAt = new Date().toISOString();
  if (!rows.some((r) => r.target === selected.target && r.account === selected.account)) setSelectedAccount({ target: rows[0]?.target || 'main', account: rows[0]?.account || 'main' });
  renderChanged('target', rows.map(r => identity(r)), box => box.replaceChildren(...rows.map((r) => { const o = node('option', label(r)); o.value = identity(r); return o; })));
  $('target').value = `${selected.target}|${selected.account}`;
  for (const r of rows) {
    const id = identity(r), a = r.summary;
    if (!fleetNodes.has(id)) {
      const row = node('button', '', 'fleet-row'); row.type = 'button'; fleetNodes.set(id, row);
      row.addEventListener('click', guarded(async () => { await selectAccount({ target: r.target, account: r.account }); }));
    }
    const row = fleetNodes.get(id); row.classList.toggle('current', sameAccount(r));
    renderChanged(row, [a, r.error, membershipLabel(a.membership)], () => {
    const name = node('div', '', 'fleet-name'); name.append(node('b', label(r)), node('span', a.account_name ? `sub2: ${a.account_name}` : r.error || '', 'hint'));
    const [memberText, memberTone] = membershipLabel(a.membership); name.append(pill(memberText, memberTone));
    const state = node('div', '', 'fleet-state');
    if (r.error) state.append(pill('无法连接', 'bad'));
    else {
      const [text, tone] = SCHED[a.sub2api?.schedulable] || SCHED.unknown; state.append(pill(a.hold ? '手动暂停' : text, a.hold ? 'warn' : tone));
      if (a.sub2api?.managed && !a.sub2api.reachable) state.append(pill('反向未通', 'warn'));
      if (a.relay && a.relay.ready === false) state.append(pill('上游未就绪', 'bad'));
      if (a.sub2api_codex?.managed) state.append(pill(`Codex ${SCHED[a.sub2api_codex.schedulable]?.[0] || '等待'}`, a.sub2api_codex.schedulable === 'on' ? 'info' : ''));
    }
    const load = node('div', '', 'fleet-load'); const c = a.counters || {};
    load.append(node('b', a.inflight == null ? '—' : String(a.inflight)), node('span', `在途 · 成功 ${c.ok ?? '—'} · 失败 ${c.err ?? '—'}`, 'hint'));
    row.replaceChildren(name, state, quotaMini(a.quota), load);
    });
  }
  renderFleet(); renderAlerts();
  for (const id of fleetNodes.keys()) if (!rows.some(r => identity(r) === id)) fleetNodes.delete(id);
}

function renderFleet() {
  const rows = visibleAccounts(), on = fleetRows.filter(r => r.summary.sub2api?.schedulable === 'on').length;
  $('fleet-summary').textContent = `显示 ${rows.length} / ${fleetRows.length} 个账号 · ${on} 个在池中`;
  renderChanged('fleet', rows.map(r => identity(r)), box => box.replaceChildren(...(rows.length
    ? rows.map(r => fleetNodes.get(identity(r))) : [empty('没有匹配的账号。可清除搜索或切换筛选条件。')])));
}
function renderAlerts() {
  const rows = fleetRows.map(r => ({ row: r, flags: accountFlags(r) })).filter(r => r.flags.length);
  const counts = { expired:0, expiring:0, low_quota:0, other:0 };
  for (const item of rows) for (const flag of item.flags) { if (flag in counts) counts[flag]++; else counts.other++; }
  renderChanged('account-alerts', [rows.map(r => [identity(r.row), r.row.summary.account_name, r.flags]), counts], box => {
    box.replaceChildren();
    const top = node('div', '', 'alert-summary');
    for (const [name, count, tone] of [['已到期',counts.expired,'bad'],['三天内到期',counts.expiring,'warn'],['额度偏低',counts.low_quota,'warn'],['待检查状态',counts.other,'info']]) top.append(pill(`${name} ${count}`, count ? tone : ''));
    box.append(top);
    if (!rows.length) { box.append(empty('当前已读取的账号没有到期、低额度或连接提醒。')); return; }
    for (const {row,flags} of rows.slice(0,10)) {
      const button = node('button', '', 'account-alert'); button.type = 'button';
      button.append(node('b', row.summary.account_name || label(row)), node('span', flags.map(f => FLAG_LABELS[f]).join(' · '), 'hint'));
      button.addEventListener('click', guarded(async () => { await selectAccount({target:row.target,account:row.account}); await showView('accounts'); }));
      box.append(button);
    }
    if (rows.length > 10) box.append(node('p', `另有 ${rows.length - 10} 个提醒，可在账号列表选择“需要关注”查看。`, 'hint'));
  });
}

function renderBatch() {
  const box = $('fleet-checks'), task = batchCheck;
  $('stop-checks').hidden = !task?.running;
  $('retry-checks').hidden = Boolean(task?.running) || !task?.items.some(i => i.state === 'failed');
  if (!task) return;
  const done = task.items.filter(i => ['passed','partial','failed'].includes(i.state)).length;
  $('batch-progress').textContent = `${task.running ? task.cancelled ? '正在停止' : '正在检测' : task.cancelled ? '已停止' : '检测完成'} · ${done} / ${task.items.length} · 失败 ${task.items.filter(i=>i.state==='failed').length}`;
  renderChanged(box, task.items.map(i => [identity(i), i.state, i.message]), () => {
    box.replaceChildren(...task.items.map(item => {
      const row = node('div', '', 'batch-result');
      row.append(node('b', item.name), node('span', item.message || ({queued:'等待检测',running:'检测中…',cancelled:'未执行'}[item.state] || ''), 'hint'),
        pill(({queued:'等待',running:'检测中',passed:'通过',partial:'部分通过',failed:'未通过',cancelled:'已取消'})[item.state], item.state==='passed'?'ok':item.state==='failed'?'bad':item.state==='partial'?'warn':''));
      return row;
    }));
  });
}
async function runBatch(rows) {
  if (batchCheck?.running) throw Error('批量检测正在进行，请先停止或等待完成');
  if (!rows.length) throw Error('没有匹配的账号可检测');
  const task = {running:true,cancelled:false,items:rows.map(r=>({target:r.target,account:r.account,name:r.summary?.account_name||r.name||label(r),state:'queued'}))};
  batchCheck = task; renderBatch();
  try {
    for (const item of task.items) {
      if (task.cancelled) break;
      item.state = 'running'; renderBatch();
      try {
        const r = await checkConnection(item.target,item.account);
        item.state = !r.ok ? 'failed' : r.sub2api.ok === true ? 'passed' : 'partial';
        item.message = `${r.bridge.ok ? 'bridge 已通' : 'bridge 未通'} · ${r.sub2api.ok === true ? 'sub2 已通' : r.sub2api.ok === false ? 'sub2 未通' : 'sub2 未注册/未测试'}`;
      } catch (err) { item.state='failed'; item.message=err.message; }
      renderBatch();
    }
  } finally {
    task.running=false;
    for (const item of task.items) if (item.state==='queued') item.state='cancelled';
    renderBatch();
  }
}

function renderTrend(history) {
  const box = $('trend'); box.replaceChildren();
  const now = Math.floor(Date.now() / 60000) * 60000, byMinute = new Map((history || []).map((h) => [h.t, h]));
  const minutes = Array.from({ length: 60 }, (_, i) => now - (59 - i) * 60000).map((t) => byMinute.get(t) || { t, ok: 0, err: 0, fallback: 0 });
  const max = Math.max(1, ...minutes.map((m) => (m.ok || 0) + (m.err || 0)));
  let total = 0, okTotal = 0;
  for (const m of minutes) {
    const ok = m.ok || 0, err = m.err || 0, fb = m.fallback || 0; total += ok + err; okTotal += ok;
    const bar = node('div', '', 'bar'); bar.title = `${new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · 成功 ${ok} · 失败 ${err}${fb ? ` · 被替换 ${fb}` : ''}`;
    const okEl = node('i', '', 'ok'), errEl = node('i', '', 'bad'), fbEl = node('i', '', 'warn');
    okEl.style.height = `${(ok / max) * 100}%`; errEl.style.height = `${(err / max) * 100}%`; fbEl.style.height = fb ? '3px' : '0';
    bar.append(errEl, okEl, fbEl); box.append(bar);
  }
  $('trend-summary').textContent = total ? `60 分钟 ${total.toLocaleString()} 次 · 成功率 ${Math.round((okTotal / total) * 100)}%` : '最近 60 分钟没有请求';
}
function renderLatency(latency) {
  const box = $('latency'); box.replaceChildren();
  const rows = Object.entries(latency || {}).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  if (!rows.length) { box.append(empty('还没有请求样本')); return; }
  for (const [model, l] of rows) {
    const row = node('div', '', 'lat-row'), name = node('div', '', 'lat-name');
    name.append(node('b', model), node('span', `${l.count} 次 · 成功 ${l.count ? Math.round((l.ok / l.count) * 100) : 0}% · ${l.last_at ? relative(Date.parse(l.last_at)) : ''}`, 'hint'));
    const nums = node('div', '', 'lat-nums');
    for (const [k, v] of [['首字节', l.ttfb_p50_ms], ['中位', l.total_p50_ms], ['P95', l.total_p95_ms]]) { const m = node('div'); m.append(node('label', k), node('b', ms(v))); if (k === 'P95' && v > 30000) m.dataset.tone = 'warn'; nums.append(m); }
    if (l.last_ok === false) name.append(pill('最近一次失败', 'bad'));
    row.append(name, nums); box.append(row);
  }
}

async function overview() {
  const read = beginRead('overview');
  const memberRead = beginRead('membership', read.scope);
  if (accessFor !== `${selected.target}|${selected.account}`) hideAccess();
  renderConnection();
  let s, runtime;
  try { [s, runtime] = await Promise.all([api('summary', scoped({}, read.scope), read.scope.target), api('status', scoped({}, read.scope), read.scope.target)]); }
  catch (err) { if (read.valid()) { bridgeVersion = null; $('current-version').textContent = '—'; } throw err; }
  if (!read.valid()) return;
  const sub = runtime.sub2api || {};
  if (memberRead.valid()) renderMembership(runtime.membership);
  bridgeVersion = runtime.version || null;
  stat('stat-version', runtime.version || '未知');
  $('current-version').textContent = runtime.version || '—'; $('aside-version').textContent = runtime.version ? `bridge ${runtime.version}` : '';
  const scheduling = sub.schedulable || runtime.schedulable;
  const sched = runtime.hold ? ['手动暂停', 'warn'] : SCHED[scheduling] || SCHED.unknown;
  stat('stat-schedule', sched[0], sched[1]);
  $('reach').textContent = (sub.reachable ?? runtime.reachable) ? 'sub2 → bridge 可达' : '反向连接待确认';
  stat('stat-inflight', String(runtime.inflight ?? '—'));
  $('stat-inflight').querySelector('span').textContent = runtime.kimi_inflight ? `其中 Kimi ${runtime.kimi_inflight} 个` : `上限 ${s.max_concurrency ?? '—'}`;
  const me = (runtime.accounts || []).find((a) => a.key === selected.account) || {};
  const okAt = runtime.last_upstream_ok_at ? Date.parse(runtime.last_upstream_ok_at) : null;
  stat('stat-upstream', okAt ? relative(okAt) : '尚无', okAt && Date.now() - okAt < 3600e3 ? 'ok' : okAt ? 'warn' : '');
  $('upstream-sub').textContent = me.relay ? (me.relay.ready ? 'relay 就绪' : 'relay 未就绪') : runtime.backoff_sec_left ? `退避中 ${runtime.backoff_sec_left}s` : `运行 ${Number.isFinite(runtime.uptime_sec) ? (runtime.uptime_sec >= 86400 ? `${Math.floor(runtime.uptime_sec / 86400)} 天` : `${Math.floor(runtime.uptime_sec / 3600)} 小时`) : '—'}`;
  if (runtime.backoff_sec_left) $('upstream-sub').textContent = `上游限流退避中 ${runtime.backoff_sec_left}s`;

  const codex = runtime.sub2api_codex || {};
  const codexText = codex.managed ? `${SCHED[codex.schedulable]?.[0] || '等待确认'}${codex.reachable ? '' : ' · 反向连接待确认'}` : '未启用';
  const kind = selected.account !== 'main' ? '托管账号（与主账号同一地址，按密钥区分）' : runtime.hosting ? '主账号（本 bridge）' : '独立 bridge';
  const up = runtime.uptime_sec;
  const info = { '当前账号': label(selected), '类型': kind, 'sub2 账号名': s.account_name, '配置分组': (s.group_ids || []).join(', ') || '未设置', '上游地址': s.public_base_url || '（本机端口）', '并发上限': `总 ${s.max_concurrency ?? '—'} · Kimi ${s.kimi_max_concurrency ?? '—'}`, 'Kimi 推理档': s.kimi_default_effort === undefined ? '—' : (s.kimi_default_effort || '不干预'), 'Codex 账号': codexText, '模型被替换时': s.model_fallback === 'forbid' ? '中断本轮' : '照常回复并记录', '进程运行时间': Number.isFinite(up) ? (up >= 86400 ? `${Math.floor(up / 86400)} 天 ${Math.floor(up % 86400 / 3600)} 小时` : `${Math.floor(up / 3600)} 小时 ${Math.floor(up % 3600 / 60)} 分`) : '—' };
  for (const id of ['connection', 'account-info']) renderChanged(id, [identity(read.scope), info], box => { box.replaceChildren(); for (const [k, v] of Object.entries(info)) box.append(node('dt', k), node('dd', v)); });
  $('selected-title').textContent = label(selected);
  $('selected-sub').textContent = `${sched[0]} · sub2 账号 ${s.account_name || '—'}`;
  const container = selected.account === 'main' && host;
  $('start-account').hidden = !container; $('stop-account').hidden = !container;
  $('pause-account').hidden = Boolean(runtime.hold); $('resume-account').hidden = !runtime.hold;
  if (formWritable('settings-form', read.scope)) {
    if (s.max_concurrency) $('max-concurrency').value = s.max_concurrency;
    if (s.kimi_max_concurrency) $('kimi-concurrency').value = s.kimi_max_concurrency;
    if (s.model_fallback) $('model-fallback').value = s.model_fallback;
    if (s.kimi_default_effort !== undefined) $('kimi-effort').value = s.kimi_default_effort;
  }
  if (view !== 'overview') { markRefreshed(); return; }
  renderChanged('trend', [identity(read.scope), runtime.history, Math.floor(Date.now() / 60000)], () => renderTrend(runtime.history));
  renderChanged('latency', [identity(read.scope), runtime.latency], () => renderLatency(runtime.latency));
  const quota = runtime.quota || {};
  renderChanged('quota', [identity(read.scope), quota, Math.floor(Date.now() / 60000)], () => {
  $('quota').replaceChildren();
  $('quota-time').textContent = quota.observed_at ? `采样于 ${relative(Date.parse(quota.observed_at) || quota.observed_at)}${quota.stale ? ' · 已过期' : ''}` : '等待首次采样';
  if (!quota.available || quota.stale) $('quota').append(empty('当前额度未知或快照已过期，请勿把旧值当作实时余额。'));
  else if (quota.unmetered) $('quota').append(empty('上游标记为不计量'));
  if (quota.available && !quota.stale) for (const w of quota.windows || []) {
    const pct = w.remaining_percent, box = node('div', '', 'quota-window');
    box.dataset.level = quotaLevel(pct);
    const head = node('div', '', 'quota-head'); head.append(node('span', w.name));
    if (w.model_scoped) head.append(node('span', '模型专用', 'chip'));
    box.append(head, node('strong', pct == null ? '未知' : `剩余 ${pct}%`));
    if (pct != null) { const meter = node('div', '', 'meter'), fill = document.createElement('i'); fill.style.width = Math.max(0, Math.min(100, pct)) + '%'; meter.append(fill); box.append(meter); }
    const reset = node('p', w.reset_at ? `${relative(Date.parse(w.reset_at) || w.reset_at)}重置` : '重置时间未知', 'hint');
    if (w.reset_at) reset.title = new Date(w.reset_at).toLocaleString();
    box.append(reset); $('quota').append(box);
  }
  });

  const c = runtime.counters || {};
  renderChanged('traffic', [identity(read.scope), c], () => {
  $('traffic').replaceChildren();
  for (const [name, value, tone] of [['总请求', c.total], ['成功', c.ok, 'ok'], ['失败', c.err, c.err ? 'bad' : ''], ['被拒绝', c.rejected, c.rejected ? 'warn' : ''], ['模型被替换', c.fallback, c.fallback ? 'warn' : '']]) {
    const m = node('div', '', 'metric'); if (tone) m.dataset.tone = tone;
    m.append(node('label', name), node('strong', value == null ? '—' : Number(value).toLocaleString())); $('traffic').append(m);
  }
  });
  $('backoff').hidden = !runtime.backoff_sec_left; $('backoff').textContent = `上游限流退避中 · ${runtime.backoff_sec_left}s`;
  const fb = runtime.last_fallback;
  $('fallback-note').hidden = !fb;
  if (fb) $('fallback-note').textContent = `最近一次模型替换：请求 ${fb.requested}，实际由 ${fb.served} 回复 · ${relative(Date.parse(fb.at))}`;
  const se = runtime.last_stream_error;
  $('stream-error').hidden = !se;
  if (se) $('stream-error').textContent = `最近一次流异常：${se.code || '未知'} · ${se.model || '未知模型'} · ${se.at ? relative(Date.parse(se.at)) : ''}`;
  markRefreshed();
}

async function codexCard() {
  const read = beginRead('codex');
  let cx;
  try { cx = await api('codex', scoped({}, read.scope), read.scope.target); } catch { if (read.valid()) $('codex-card').hidden = true; return; }
  if (!read.valid()) return;
  $('codex-card').hidden = false;
  const st = cx.sub2api_codex || {};
  const pillEl = $('codex-state'); pillEl.hidden = false;
  const [text, tone] = !cx.enabled ? ['未启用', ''] : st.managed ? [SCHED[st.schedulable]?.[0] || '等待确认', st.schedulable === 'on' ? 'ok' : 'warn'] : ['已启用 · 等待注册', 'warn'];
  pillEl.className = 'pill' + (tone ? ' ' + tone : ''); pillEl.textContent = `${text}${cx.enabled ? ' · ' + cx.account_name : ''}`;
  if (formWritable('codex-form', read.scope)) {
    try { await groups(); } catch { /* 无管理连接时只保留手动输入 */ }
    if (!read.valid() || !formWritable('codex-form', read.scope)) return;
    $('codex-enabled').checked = cx.enabled; $('codex-name').value = cx.custom_name || '';
    renderChanged('codex-group', [identity(read.scope), groupsCache, cx.group_ids], () => {
    fillGroups($('codex-group'), ['openai', 'composite'], cx.group_ids?.[0], '选择分组…');
    });
  }
}
async function profiles() {
  const read = beginRead('profiles'), rows = await api('profiles', {}, 'main');
  if (!read.valid()) return;
  const containers = new Set(fleetRows.filter((r) => r.account === 'main' && r.target !== 'main').map((r) => r.target));
  const hostingSupported = fleetRows.some((r) => r.target === 'main' && r.hosting);
  renderChanged('profiles', [rows, [...containers], hostingSupported], () => {
  $('profiles').replaceChildren();
  if (!rows.length) $('profiles').append(empty('还没有独立 profile。点击“新增账号”开始。'));
  for (const p of rows) {
    const row = node('div', '', 'profile-row'), name = node('div', '', 'profile-name');
    name.append(node('span', p.profile));
    const managedContainer = containers.has(p.profile);
    name.append(!p.configured ? pill('配置未完成', 'warn') : p.hosted ? pill('已托管', 'ok') : managedContainer ? pill('独立容器', 'info') : pill('凭证已保存', ''));
    row.append(name);
    const actions = node('div', '', 'row');
    if (p.configured && p.hosted) {
      const b = node('button', '移出托管', 'quiet small');
      b.addEventListener('click', guarded(async () => { if (!confirm(`把 ${p.profile} 移出托管？sub2 账号会暂停但保留，凭证不删除。`)) return; const r = await api('account/unhost', { profile: p.profile }, 'main'); notice(r.note || '已移出托管'); await refresh(); }));
      actions.append(b);
    } else if (p.configured && !managedContainer) {
      if (hostingSupported) {
        const b = node('button', '托管到当前 bridge', 'secondary small');
        b.addEventListener('click', guarded(async () => { const r = await api('account/host', { profile: p.profile }, 'main'); notice(r.registered ? `已托管并注册 sub2 账号 ${r.account_name}${r.reachable ? '' : '（反向连接待确认）'}` : '已托管，sub2 注册将在健康检查中完成'); await refresh(); }));
        actions.append(b);
      }
      if (host) {
        const b = node('button', '独立容器', 'quiet small');
        b.addEventListener('click', guarded(async () => { if (!confirm(`为 ${p.profile} 启动独立容器？只有需要与主 bridge 隔离时才建议这样做。`)) return; await api('attach', { profile: p.profile }); notice('容器已启动，账号会自动注册。'); await refresh(); }));
        actions.append(b);
      }
    }
    row.append(actions); $('profiles').append(row);
  }
  });
}

function renderFamilies() {
  const scope = { ...selected };
  $('families').replaceChildren();
  const families = [...new Set(modelRows.map((m) => m.family))].sort((a, b) => familyOrder(a) - familyOrder(b) || a.localeCompare(b));
  for (const family of families) {
    const rows = modelRows.filter((m) => m.family === family);
    const on = rows.filter((m) => m.enabled).length, box = node('div', '', 'family'), text = node('div');
    text.append(node('b', familyName(family)), node('span', `已启用 ${on} / ${rows.length}`));
    const enable = on < rows.length, button = node('button', enable ? '全部启用' : '全部停用', enable ? 'secondary small' : 'danger small');
    button.addEventListener('click', guarded(async () => {
      if (!confirm(`${enable ? '启用' : '停用'} ${familyName(family)} 系列的全部模型？`)) return;
      const r = await api('models/family', scoped({ family, enabled: enable }, scope), scope.target); notice(`已${enable ? '启用' : '停用'} ${r.changed} 个 ${familyName(family)} 模型，sub2 映射将在下一次健康检查同步。`); if (sameAccount(scope)) await models();
    }));
    box.append(text, button); $('families').append(box);
  }
  $('family-card').hidden = !$('families').children.length;
}
const modelNodes = new Map();
function renderModels(scope = { ...selected }) {
  if (!sameAccount(scope) || modelsFor !== identity(scope)) return;
  for (const m of modelRows) {
    const rowKey = identity(scope) + '|' + m.id;
    let tr = modelNodes.get(rowKey);
    if (!tr) { tr = document.createElement('tr'); modelNodes.set(rowKey, tr); }
    const testState = testResults.get(rowKey);
    renderChanged(tr, [m, testState], () => {
      tr.className = m.enabled ? '' : 'off'; tr.replaceChildren();
      tr.append(node('td', m.id, 'model-id'));
      const fam = node('td'); fam.append(node('span', familyName(m.family), 'chip')); tr.append(fam);
      const st = node('td'); st.append(m.enabled ? pill('已启用', 'ok') : m.blocked ? pill('已屏蔽', 'bad') : m.filtered ? pill('未放行', '') : pill('已停用')); tr.append(st);
      const lat = node('td', '', 'lat-cell');
      if (m.latency) lat.append(node('b', ms(m.latency.total_p50_ms)), node('span', ' · 首字节 ' + ms(m.latency.ttfb_p50_ms) + ' · ' + m.latency.count + ' 次', 'hint'));
      else lat.append(node('span', '尚无样本', 'hint'));
      if (testState) {
        const status = testState.pending ? '测试中…' : testState.result?.ok ? '测试通过' : '测试未通过';
        lat.append(node('div', status, 'test-result ' + (testState.pending ? '' : testState.result?.ok ? 'ok-text' : 'warn-text')));
        if (!testState.pending) lat.append(node('span', testState.error || (testState.result.message + ' · HTTP ' + testState.result.status + ' · ' + ms(testState.result.elapsed_ms)), 'hint'));
      }
      tr.append(lat, node('td', m.note, 'note'));
      const actions = node('td', '', 'actions');
      const copy = node('button', '复制 ID', 'quiet small');
      copy.addEventListener('click', guarded(async () => {
        try { await navigator.clipboard.writeText(m.id); notice('模型 ID 已复制'); }
        catch { notice(`无法自动复制，模型 ID：${m.id}`, true); }
      }));
      if (m.enabled) {
        const button = node('button', testState?.pending ? '测试中…' : '测试', 'secondary small'); button.disabled = Boolean(testState?.pending);
        button.addEventListener('click', guarded(async () => {
          if (!confirm('测试 ' + m.id + ' 会发送真实请求、消耗额度，是否继续？')) return;
          await runModelTest(scope, m.id);
        }));
        actions.append(button);
      }
      if (!m.blocked && !m.filtered) {
        const toggle = node('button', m.enabled ? '停用' : '启用', m.enabled ? 'quiet small' : 'secondary small');
        toggle.addEventListener('click', guarded(async () => {
          await api('model', scoped({ id: m.id, enabled: !m.enabled }, scope), scope.target);
          notice('配置已保存，sub2 模型映射会在下一次健康检查同步。');
          if (sameAccount(scope)) await models();
        }));
        actions.append(toggle);
      }
      actions.append(copy); tr.append(actions);
    });
  }
  const families = [...new Set(modelRows.map(m=>m.family || 'other'))];
  renderChanged('model-family', families, box => {
    const before = box.value, all = node('option','全部系列'); all.value='all';
    box.replaceChildren(all,...families.map(f=>{const o=node('option',familyName(f));o.value=f;return o;}));
    box.value=families.includes(before)?before:'all';
  });
  const filtered = filterModels(modelRows, $('model-search').value, $('model-filter').value, $('model-family').value, scope);
  renderChanged('models', [identity(scope), filtered.map(m => m.id)], box => {
    const rows = filtered.map(m => modelNodes.get(identity(scope) + '|' + m.id));
    if (rows.length) box.replaceChildren(...rows);
    else { const tr = document.createElement('tr'), td = node('td'); td.colSpan = 6; td.append(empty(modelRows.length?'没有匹配的模型，可清除搜索或切换筛选条件。':'上游目录为空')); tr.append(td); box.replaceChildren(tr); }
  });
  const on = modelRows.filter(m => m.enabled).length;
  renderChanged('model-summary', [on, modelRows.length, families.length, filtered.length], box => box.replaceChildren(pill('已启用 ' + on, 'ok'), pill(`显示 ${filtered.length} / ${modelRows.length}`), pill(families.length + ' 个系列', 'info')));
  renderChanged('families', [identity(scope), modelRows.map(m => [m.id, m.family, m.enabled])], () => renderFamilies());
  const liveRows = new Set(modelRows.map(m => identity(scope) + '|' + m.id));
  for (const [id] of modelNodes) if (!liveRows.has(id)) modelNodes.delete(id);
}
async function runModelTest(scope, id) {
  const rowKey = identity(scope) + '|' + id;
  if (testResults.get(rowKey)?.pending) return;
  testResults.set(rowKey, { pending: true }); renderModels(scope);
  try {
    const result = await api('test', scoped({ id }, scope), scope.target);
    testResults.set(rowKey, { result, at: Date.now() });
  } catch (err) { testResults.set(rowKey, { error: err.message, at: Date.now() }); }
  if (testResults.size > 200) for (const [key, value] of testResults) { if (!value.pending && key !== rowKey) { testResults.delete(key); break; } }
  renderModels(scope);
}
async function models() {
  const read = beginRead('models');
  const rows = await api('models', scoped({}, read.scope), read.scope.target);
  if (!read.valid()) return;
  modelRows = rows; modelsFor = identity(read.scope); modelsUpdatedAt = Date.now();
  modelRows.sort((a, b) => familyOrder(a.family) - familyOrder(b.family) || (a.family || '').localeCompare(b.family || '') || a.id.localeCompare(b.id));
  renderModels(read.scope); markRefreshed();
}

const tokenCount = v => v == null ? '—' : Number(v).toLocaleString('zh-CN');
const usageMoney = v => v == null ? '未估算' : v > 0 && v < 0.000001 ? '< $0.000001' : '$' + Number(v).toFixed(6);
const USAGE_STATES = { complete: '完整', partial: '不完整', unknown: '未知' };
function usageModelCell(row) {
  const cell = node('td', '', 'model-id'); cell.append(node('div', row.model));
  if (row.served_model && row.served_model !== row.model) cell.append(node('span', '上游返回：' + row.served_model, 'hint'));
  return cell;
}
function usageTable(id, rows, draw) {
  renderChanged(id, [identity(), rows], box => {
    if (rows.length) box.replaceChildren(...rows.map(draw));
    else { const tr = node('tr'), td = node('td'); td.colSpan = 8; td.append(empty('所选范围暂无记录。启用此版本后的推理请求才会开始统计。')); tr.append(td); box.replaceChildren(tr); }
  });
}
function fillPrice() {
  const rates = usageFor === identity() ? usageData?.prices?.[$('price-model').value.trim()] : null;
  for (const [key, id] of Object.entries(PRICE_FIELDS)) $(id).value = rates?.[key] ?? '';
}
function renderUsage() {
  if (usageFor !== identity() || !usageData) return;
  const data = usageData, t = data.total;
  $('usage-content').hidden = false;
  $('usage-requests').textContent = tokenCount(t.requests);
  $('usage-success').textContent = `成功 ${tokenCount(t.ok)} · 失败 ${tokenCount(t.failed)}`;
  $('usage-input').textContent = t.requests && t.unknown === t.requests ? '—' : tokenCount(t.input_tokens);
  $('usage-output').textContent = t.requests && t.unknown === t.requests ? '—' : tokenCount(t.output_tokens);
  $('usage-reasoning').textContent = '已报告推理 Token ' + tokenCount(t.reasoning_tokens);
  $('usage-cost').textContent = usageMoney(t.priced ? t.estimated_usd : null);
  $('usage-priced').textContent = `${t.priced} / ${t.requests} 次已估算 · 仅 Token`;
  const hints = [`${data.daily[0]?.day || ''} 至 ${data.daily.at(-1)?.day || ''}（UTC）`, '读取于 ' + new Date(data.generated_at).toLocaleTimeString()];
  if (!data.persistent) hints.push('仅内存记录，重启会清空');
  if (data.models_truncated) hints.push('模型汇总仅展示消耗最高的 1024 行，总计仍包含全部有效记录');
  if (data.storage_error || data.dropped || data.invalid_lines) hints.push(`统计不完整：存储异常或容量受限，本次进程漏记 ${data.dropped} 条，损坏/超限记录 ${data.invalid_lines} 条`);
  $('usage-state').textContent = hints.join(' · ');
  renderChanged('usage-coverage', t, box => {
    box.replaceChildren();
    for (const [label, value] of [['缓存读取', tokenCount(t.cache_read_tokens)], ['缓存写入', tokenCount(t.cache_write_tokens)],
      ['缓存读取占已知输入', t.input_tokens ? (t.cache_read_tokens / t.input_tokens * 100).toFixed(1) + '%' : '—'],
      ['用量完整 / 不完整 / 未知', `${t.complete} / ${t.partial} / ${t.unknown}`], ['上游尝试次数（含自动重试）', tokenCount(t.attempts)]]) {
      const row = node('div', '', 'usage-metric'); row.append(node('span', label), node('b', value, 'num')); box.append(row);
    }
  });
  renderChanged('usage-trend', data.daily, box => {
    const max = Math.max(1, ...data.daily.map(d => d.input_tokens + d.output_tokens));
    box.replaceChildren(...data.daily.slice().reverse().map(d => {
      const row = node('div', '', 'usage-day'), meter = document.createElement('meter');
      const total = d.input_tokens + d.output_tokens;
      meter.min = 0; meter.max = max; meter.value = total; meter.setAttribute('aria-label', d.day + ' 已知 Token ' + total);
      row.title = `${d.day} · ${d.requests} 次 · 输入 ${d.input_tokens} / 输出 ${d.output_tokens} · 未知 ${d.unknown} 次`;
      row.append(node('time', d.day.slice(5)), meter, node('span', tokenCount(total), 'num')); return row;
    }));
  });
  usageTable('usage-models', data.models, r => {
    const row = node('tr'); row.append(usageModelCell(r), node('td', r.protocol), node('td', `${r.requests} / ${r.failed}`),
      node('td', r.unknown === r.requests ? '—' : tokenCount(r.input_tokens)), node('td', r.unknown === r.requests ? '—' : tokenCount(r.output_tokens)),
      node('td', `${tokenCount(r.cache_read_tokens)} / ${tokenCount(r.cache_write_tokens)}`), node('td', `${r.complete} / ${r.requests}`),
      node('td', usageMoney(r.priced ? r.estimated_usd : null) + ` (${r.priced}/${r.requests})`)); return row;
  });
  usageTable('usage-recent', data.recent, r => {
    const row = node('tr'), status = node('td'); status.append(pill(r.ok ? '成功' : '失败', r.ok ? 'ok' : 'bad'));
    status.append(node('div', (r.status ? 'HTTP ' + r.status : '') + (r.attempts > 1 ? ` · 尝试 ${r.attempts} 次` : ''), 'hint'));
    row.append(node('td', new Date(r.at).toLocaleString(), 'num'), usageModelCell(r), status,
      node('td', `${tokenCount(r.input_tokens)} / ${tokenCount(r.output_tokens)}`), node('td', `${tokenCount(r.cache_read_tokens)} / ${tokenCount(r.cache_write_tokens)}`),
      node('td', ms(r.elapsed_ms)), node('td', USAGE_STATES[r.usage_state]), node('td', usageMoney(r.estimated_usd))); return row;
  });
  const modelOptions = [...new Set([...data.model_options, data.model].filter(Boolean))];
  renderChanged('usage-model', modelOptions, box => {
    const keep = data.model || '', all = node('option', '全部模型'); all.value = '';
    box.replaceChildren(all, ...modelOptions.map(id => { const o = node('option', id); o.value = id; return o; })); box.value = keep;
  });
  const pricedModels = [...new Set([...data.model_options, ...Object.keys(data.prices)])];
  renderChanged('price-model-options', pricedModels, box => box.replaceChildren(...pricedModels.map(id => { const o = node('option'); o.value = id; return o; })));
  if (formWritable('pricing-form')) fillPrice();
}
async function usagePage() {
  const read = beginRead('usage'), days = Number($('usage-days').value || 7), model = $('usage-model').value || '';
  try {
    const data = await api('usage', scoped({ days, model }, read.scope), read.scope.target);
    if (!read.valid() || days !== Number($('usage-days').value || 7) || model !== ($('usage-model').value || '')) return;
    usageData = data; usageFor = identity(read.scope); renderUsage(); markRefreshed();
  } catch (err) {
    if (read.valid()) $('usage-state').textContent = '用量读取失败，稍后自动重试' + (usageFor === identity() ? '；下方保留上次快照。' : '。');
    throw err;
  }
}
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function usageCsv(recent = false) {
  if (!usageData || usageFor !== identity()) throw Error('请先读取当前账号的用量');
  const columns = recent ? ['at', 'model', 'served_model', 'protocol', 'ok', 'status', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'usage_state', 'elapsed_ms', 'attempts', 'estimated_usd']
    : ['model', 'served_model', 'protocol', 'requests', 'failed', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'complete', 'partial', 'unknown', 'priced', 'estimated_usd'];
  const rows = recent ? usageData.recent : usageData.models;
  return '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(k => csvCell(k === 'estimated_usd' && !recent && !row.priced ? null : row[k])).join(','))].join('\r\n') + '\r\n';
}
function downloadUsage(recent) {
  const url = URL.createObjectURL(new Blob([usageCsv(recent)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `mirasim-usage-${recent ? 'recent' : 'models'}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function logs() {
  const read = beginRead('logs'), r = await api('logs', { limit: 400 }, read.scope.target);
  if (!read.valid()) return;
  const filter = $('log-filter').value.trim().toLowerCase();
  const lines = (r.lines || []).filter((l) => !filter || l.toLowerCase().includes(filter));
  const pre = $('logs'), atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const text = lines.length ? lines.join('\n') : (filter ? '没有匹配的日志行' : '暂无日志');
  if (pre.textContent === text) return;
  pre.textContent = text;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

const phases = { idle: ['等待操作', ''], checking: ['检查发布', 'info'], pulling: ['拉取并验证镜像', 'info'], activating: ['重建容器并验证服务', 'info'], succeeded: ['升级成功', 'ok'], failed: ['准备失败，运行中的容器未改变', 'bad'], rolling_back: ['正在回退', 'warn'], rolled_back: ['已回退', 'warn'], rollback_failed: ['回退未完成，需要排查', 'bad'] };
const steps = { fetch_manifest: '获取发布清单', pull_image: '拉取镜像', verify_image: '验证镜像', stage_host: '准备宿主机文件', snapshot: '记录原容器', activate_image: '切换镜像', stop_container: '停止旧容器', start_container: '启动新容器', check_health: '检查服务', install_host: '更新后台', restore_host: '恢复后台', restore_image: '恢复镜像', restore_container: '恢复容器', restore_health: '检查恢复后的服务', restore_tag: '恢复镜像标签' };
const errors = { command_timeout: '命令超时', command_unavailable: '命令不可执行', docker_operation_failed: 'Docker 操作失败', container_not_running: '容器未运行', container_missing: '容器不存在', image_missing: '镜像不存在', disk_full: '磁盘空间不足', permission_denied: '权限不足', docker_unavailable: 'Docker 服务不可用', bridge_unresponsive: '桥接器未正常响应', operation_failed: '操作失败' };
async function deployment() {
  if (!host) return;
  const read = beginRead('deployment'), s = await api('deployment', {}, 'main');
  if (!read.valid()) return;
  deploymentRunning = ['checking', 'pulling', 'activating', 'rolling_back'].includes(s.phase);
  const [text, tone] = phases[s.phase] || [s.phase, ''];
  const box = $('deploy-state');
  renderChanged(box, [s, Math.floor(Date.now() / 60000)], () => {
  box.replaceChildren(node('strong', text));
  if (tone) box.dataset.tone = tone; else delete box.dataset.tone;
  const details = [s.version ? `目标版本 ${s.version}` : '', s.updated_at ? `${relative(s.updated_at * 1000)}更新` : ''].filter(Boolean).join(' · ');
  if (details) box.append(node('span', details));
  if (s.phase === 'succeeded' && s.host_updated) box.append(node('span', s.host_restart ? '宿主机后台已一并更新并重启，请刷新页面后重新登录。' : '网页文件已一并更新，刷新页面即可看到新版。'));
  if (s.host_restored) box.append(node('span', '宿主机后台已回退到上一版本。'));
  if (s.error) box.append(node('span', s.error));
  for (const failure of [s.failure, ...(s.recovery_errors || [])].filter(Boolean)) box.append(node('span', `${failure.target || '后台'} · ${steps[failure.step] || failure.step}：${errors[failure.code] || failure.code}`));
  for (const [name, health] of Object.entries(s.target_health || {})) {
    if (!health.upstream_ready || (health.managed && (!health.reachable || health.schedulable !== 'on'))) box.append(node('span', `${name}：桥接器 ${health.version} 已响应，调度/上游尚未就绪或已手动暂停。请在概览确认。`));
  }
  });
  const events = (await api('events', {}, 'main')).slice().reverse();
  if (!read.valid()) return;
  renderChanged('events', [events, Math.floor(Date.now() / 60000)], box => box.replaceChildren(...(events.length ? events.map((e) => {
    const row = node('div', '', 'event'), when = node('time', relative(e.at * 1000)); when.title = new Date(e.at * 1000).toLocaleString();
    const requested = e.action.endsWith('/requested') || ['deploy', 'rollback'].includes(e.action);
    const action = e.action.replace(/\/requested$/, '');
    const what = node('div'); what.append(node('b', ACTIONS[action] || action), document.createTextNode(' · ' + e.target));
    row.append(when, what, e.ok ? pill(requested ? '已接受任务' : '完成', requested ? 'info' : 'ok') : pill(requested ? '未接受任务' : '失败', 'bad')); return row;
  }) : [empty('还没有管理操作记录')])));
}
async function checkRelease(force = false) {
  let r;
  try { r = await api('release/check', { force: force === true }); }
  catch (err) {
    $('latest-version').textContent = '—'; $('update-pill').hidden = false;
    $('update-pill').className = 'pill warn'; $('update-pill').textContent = '检查失败，不能确认最新版本';
    $('release-source').textContent = '检查失败，未沿用之前的结果。请确认服务器能访问发布源。';
    throw err;
  }
  $('latest-version').textContent = r.latest;
  releaseCheckedAt = Date.now();
  const pinned = r.source?.kind === 'github_pinned';
  $('release-label').textContent = pinned ? '固定发布版本' : '最新发布';
  $('follow-latest').hidden = !pinned;
  const source = pinned ? `发布源固定在 ${r.source.pinned_version}，不会自动发现新版本。`
    : r.source?.kind === 'github_latest' ? `自动跟随 ${r.source.repository} 的正式发布。`
    : r.source?.kind === 'custom' ? '使用自定义发布源；请确认该地址会更新。' : '旧版后台未提供发布源信息。';
  $('release-source').textContent = source + (r.checked_at ? ` 检查时间 ${new Date(r.checked_at * 1000).toLocaleTimeString()}${r.cached ? '（短时缓存）' : '（实时查询）'}` : '')
    + (r.resolved_via === 'github_download_fallback' ? ' GitHub API 暂不可用，本次使用下载地址查询。' : '');
  if (!bridgeVersion) {
    $('update-pill').hidden = false; $('update-pill').className = 'pill warn';
    $('update-pill').textContent = '运行版本未知，请检查桥接器状态'; return;
  }
  const newer = versionNewer(r.latest, bridgeVersion), older = versionNewer(bridgeVersion, r.latest);
  $('update-pill').hidden = false;
  $('update-pill').className = 'pill ' + (newer ? 'info' : older || pinned ? 'warn' : 'ok');
  $('update-pill').textContent = newer ? `可升级到 ${r.latest}` : older ? '当前运行版本高于发布源' : pinned ? '已是固定版本；可切换为跟随最新发布' : '已是最新版本';
}
async function versionStatus() {
  const read = beginRead('version');
  try {
    const runtime = await api('status', scoped({}, read.scope), read.scope.target);
    if (!read.valid()) return;
    bridgeVersion = runtime.version || null; $('current-version').textContent = bridgeVersion || '—';
    $('aside-version').textContent = bridgeVersion ? `bridge ${bridgeVersion}` : '';
  } catch (err) { if (read.valid()) { bridgeVersion = null; $('current-version').textContent = '—'; } throw err; }
}
async function refreshVisible({ fast = false, force = false } = {}) {
  const atView = view, scope = { ...selected }, tasks = [];
  if (view === 'overview') tasks.push(fleet(), overview());
  if (view === 'accounts') {
    tasks.push(keeperCard(), connectionStatus());
    if (!fast) tasks.push(overview(), codexCard(), profiles());
  }
  if (view === 'models' && (force || modelsFor !== identity() || Date.now() - modelsUpdatedAt >= 30000)) tasks.push(models());
  if (view === 'logs') tasks.push(logs());
  if (view === 'usage') tasks.push(usagePage());
  if (view === 'release' && host) {
    // Even if the bridge container is restarting, keep deployment progress live.
    tasks.push(deployment());
    if (!fast) tasks.push((async () => { await versionStatus(); if (force || Date.now() - releaseCheckedAt >= 60000) await checkRelease(); })());
  }
  const results = await Promise.allSettled(tasks);
  if (view !== atView || !sameAccount(scope)) return;
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  if (tasks.length) markRefreshed();
}
function pollingFast() {
  return (view === 'accounts' && (keeperRunning.has(identity()) || connectionBusy.has(identity()))) || (view === 'release' && deploymentRunning) || Boolean(loginSession);
}
function schedulePoll(delay) {
  clearTimeout(timer);
  if (key) timer = setTimeout(pollVisible, delay ?? (pollingFast() ? 2000 : 15000));
}
async function pollVisible() {
  if (!key) return;
  if (document.hidden || polling) { schedulePoll(); return; }
  polling = true;
  try {
    if (loginSession && !loginFinishing && !actionsBusy) await queryLogin();
    const fast = pollingFast() && Date.now() - lastRegularPoll < 15000;
    await refreshVisible({ fast });
    if (!fast) lastRegularPoll = Date.now();
    $('auto-refresh-state').textContent = '自动更新中';
  } catch {
    $('auto-refresh-state').textContent = '连接暂不可用，稍后自动重试';
  } finally { polling = false; schedulePoll(); }
}
async function refresh() {
  if (view !== 'overview') await fleet();
  await refreshVisible({ force: true }); lastRegularPoll = Date.now(); schedulePoll();
}
function setSelectedAccount(scope) {
  const changed = !sameAccount(scope);
  selected = { ...scope }; $('target').value = identity(); hideAccess();
  if (changed) { dirtyForms.clear(); modelsFor = ''; keeperModelsFor = ''; }
  if (changed) {
    usageFor = ''; usageData = null; $('usage-content').hidden = true; $('usage-state').textContent = '正在读取当前账号的用量…';
    $('usage-model').replaceChildren(node('option', '全部模型')); $('usage-model').firstChild.value = ''; $('usage-model').value = '';
    $('price-model').value = ''; fillPrice(); $('price-model-options').replaceChildren();
    renderCache.delete($('usage-model')); renderCache.delete($('price-model-options'));
  }
  if (changed) { bridgeVersion = null; $('current-version').textContent = '—'; }
  renderConnection();
  // Hide stale model data only on an actual account switch, never on polling.
  if (changed) { $('models').replaceChildren(); renderCache.delete($('models')); $('family-card').hidden = true; }
  for (const [id, row] of fleetNodes) row.classList.toggle('current', id === identity());
}
async function selectAccount(scope) {
  setSelectedAccount(scope);
  await refresh();
}
async function showView(next) {
  if (next !== 'accounts') hideAccess();
  view = next; $('page-title').textContent = titles[next];
  for (const el of document.querySelectorAll('[data-section]')) el.hidden = el.dataset.section !== next;
  for (const el of document.querySelectorAll('[data-view]')) el.classList.toggle('selected', el.dataset.view === next);
  if (key) { try { await refreshVisible(); } catch (e) { notice(e.message, true); } schedulePoll(); }
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
$('login-form').addEventListener('submit', guarded(async () => {
  key = $('key').value.trim(); if (!/^[a-f0-9]{64}$/.test(key)) throw Error('请输入有效的 64 位管理密钥');
  if (host) await api('targets'); else await api('summary');
  $('key').value = ''; $('login-box').hidden = true; $('workspace').hidden = false; notice('已连接后台');
  await fleet();
  try { await refresh(); } catch (err) { notice(err.message, true); }
  schedulePoll();
}));
$('logout').addEventListener('click', () => { hideAccess(); key = ''; clearTimeout(timer); location.reload(); });
$('refresh').addEventListener('click', guarded(refresh)); $('load-models').addEventListener('click', guarded(models)); $('load-logs').addEventListener('click', guarded(logs));
$('reveal-key').addEventListener('click', guarded(revealAccess));
$('hide-key').addEventListener('click', hideAccess);
$('copy-key').addEventListener('click', guarded(async () => {
  const value = await revealAccess();
  try { await navigator.clipboard.writeText(value); notice('当前账号的 bridge 密钥已复制。'); }
  catch { notice('浏览器不允许复制，密钥已显示，请手动复制。', true); }
}));
$('check-account').addEventListener('click', guarded(async () => {
  await checkConnection(selected.target, selected.account);
}));
$('refresh-membership').addEventListener('click', guarded(async () => {
  const read = beginRead('membership');
  const data = await api('membership/refresh', scoped({}, read.scope), read.scope.target);
  if (read.valid()) { renderMembership(data); notice('会员状态已查询'); }
}));
$('keeper-form').addEventListener('submit', guarded(async () => {
  const scope = { ...selected };
  const enabled = $('keeper-enabled').checked, windows = ['5h', '7d'].filter(w => $('keeper-' + w).checked);
  if (!windows.length) throw Error('至少选择一个窗口');
  const model = $('keeper-model').value;
  if (enabled && !model) throw Error('请选择短请求模型');
  await api('window-keeper', scoped({ enabled, model, windows, max_per_day: Number($('keeper-cap').value) }, scope), scope.target);
  if (!sameAccount(scope)) return;
  dirtyForms.delete('keeper-form');
  notice(enabled ? '自动窗口已启用。后台将按需发送 hi，会消耗上游额度。' : '自动窗口已关闭，原发送记录保留。');
  await keeperCard();
}));
$('check-keeper').addEventListener('click', guarded(async () => {
  const scope = { ...selected };
  beginRead('keeper', scope);
  const r = await api('window-keeper/check', scoped({}, scope), scope.target);
  if (r.accepted) keeperRunning.add(identity(scope));
  if (!sameAccount(scope)) return;
  notice(r.accepted ? '检查任务已接受，结果将自动更新，无需刷新页面。' : '任务未启用');
  await keeperCard(); schedulePoll(2000);
}));
$('check-all-accounts').addEventListener('click', guarded(async () => {
  await runBatch(fleetRows.slice());
}));
$('check-filtered-accounts').addEventListener('click', guarded(() => runBatch(visibleAccounts())));
$('stop-checks').addEventListener('click', () => { if (batchCheck?.running) { batchCheck.cancelled=true; renderBatch(); } });
$('retry-checks').addEventListener('click', guarded(() => runBatch((batchCheck?.items || []).filter(i=>i.state==='failed'))));
for (const id of ['account-search','account-filter','account-sort']) $(id).addEventListener(id==='account-search'?'input':'change',renderFleet);
$('clear-account-search').addEventListener('click', () => {
  $('account-search').value=''; $('account-filter').value='all'; $('account-sort').value='default'; renderFleet();
});
for (const id of ['model-search','model-filter','model-family']) $(id).addEventListener(id==='model-search'?'input':'change', () => renderModels());
$('clear-model-search').addEventListener('click', () => {
  $('model-search').value=''; $('model-filter').value='all'; $('model-family').value='all'; renderModels();
});
$('export-diagnostics').addEventListener('click', guarded(async () => {
  if (!fleetRows.length) throw Error('请先读取账号状态再导出诊断报告');
  const report=diagnosticReport(), blob=new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}), url=URL.createObjectURL(blob);
  const link=document.createElement('a'); link.href=url; link.download='mirasim-diagnostics-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  notice('诊断快照已导出。账号已匿名化，不含密钥、地址、邮箱和原始日志。');
}));
for (const id of ['usage-days', 'usage-model']) $(id).addEventListener('change', guarded(async () => {
  usageData = null; usageFor = ''; $('usage-content').hidden = true; $('usage-state').textContent = '正在读取所选范围…'; await usagePage();
}));
$('price-model').addEventListener('change', fillPrice);
$('pricing-form').addEventListener('submit', guarded(async () => {
  const scope = { ...selected }, model = $('price-model').value.trim();
  const rates = Object.fromEntries(Object.entries(PRICE_FIELDS).map(([key, id]) => [key, $(id).value.trim() === '' ? null : Number($(id).value)]));
  await api('usage/pricing', scoped({ model, rates }, scope), scope.target);
  if (!sameAccount(scope)) return;
  dirtyForms.delete('pricing-form'); notice('模型单价已保存，仅用于后续请求的费用估算。'); await usagePage();
}));
$('export-usage').addEventListener('click', guarded(() => downloadUsage(false)));
$('export-usage-recent').addEventListener('click', guarded(() => downloadUsage(true)));
document.addEventListener('visibilitychange', () => { if (document.hidden) hideAccess(); else schedulePoll(0); });
$('log-filter').addEventListener('input', () => { logs().catch(() => {}); });
$('check-release').addEventListener('click', guarded(() => checkRelease(true)));
$('follow-latest').addEventListener('click', guarded(async () => {
  if (!confirm('将当前固定版本地址改为同一个 GitHub 仓库的最新正式发布？不会立即升级或改变账号。')) return;
  await api('release/follow-latest', { confirm: true }); await checkRelease(true);
}));
$('settings-form').addEventListener('submit', guarded(async () => {
  const scope = { ...selected };
  const data = scoped({ max_concurrency: Number($('max-concurrency').value), kimi_max_concurrency: Number($('kimi-concurrency').value), model_fallback: $('model-fallback').value, kimi_default_effort: $('kimi-effort').value });
  const r = await api('settings', data, scope.target);
  if (!sameAccount(scope)) return;
  dirtyForms.delete('settings-form');
  notice(`${label(scope)}：并发 总 ${r.max_concurrency} · Kimi ${r.kimi_max_concurrency} · Kimi 推理档 ${r.kimi_default_effort === undefined ? '（旧版 bridge 未支持）' : (r.kimi_default_effort || '不干预')}；模型被替换时${r.model_fallback === 'forbid' ? '中断本轮' : '照常回复并记录'}。已立即生效。`); await overview();
}));
$('codex-form').addEventListener('submit', guarded(async () => {
  const scope = { ...selected };
  const enabled = $('codex-enabled').checked, group_id = Number($('codex-group').value) || undefined;
  if (enabled && !group_id) throw Error('请选择一个 openai 或 composite 平台分组');
  const r = await api('codex', scoped({ enabled, group_id, account_name: $('codex-name').value.trim() }, scope), scope.target);
  if (!sameAccount(scope)) return;
  dirtyForms.delete('codex-form');
  notice(enabled ? (r.registered ? `Codex 账号 ${r.account_name} 已注册，进入调度后即可在 Codex 里使用。` : '已保存，Codex 账号将在健康检查中注册。') : 'Codex 账号已关闭并暂停。');
  await codexCard();
}));
$('target').addEventListener('change', guarded(async () => {
  const [target, account] = $('target').value.split('|');
  await selectAccount({ target, account }); notice(`已选择 ${label(selected)}。`);
}));
$('pause-account').addEventListener('click', guarded(async () => { if (!confirm(`暂停 ${label(selected)} 的调度？它会立即从 sub2 池子里摘出，直到手动恢复。`)) return; const r = await api('account/pause', scoped()); notice(r.paused ? '已暂停调度' : (r.managed ? '暂停请求未完全成功，请到 sub2 后台确认' : '该账号未接入 sub2，已标记为保持暂停'), !r.paused && r.managed); await refresh(); }));
$('resume-account').addEventListener('click', guarded(async () => { const r = await api('account/resume', scoped()); notice(r.note || '已恢复'); await refresh(); }));
for (const action of ['start', 'stop']) $(`${action}-account`).addEventListener('click', guarded(async () => { if (!confirm(`${action === 'stop' ? '停止' : '启动'} ${selected.target} 的容器？`)) return; await api(action); notice('操作完成。首次启动可能需要等待数轮健康检查。'); await refresh(); }));
for (const action of ['deploy', 'rollback']) $(action).addEventListener('click', guarded(async () => { if (!confirm(action === 'deploy' ? '升级所有受管且运行中的 bridge，并同步更新宿主机后台？切换时短暂停服。' : '将所有快照账号和宿主机后台恢复到上一次版本？')) return; const r = await api(action); notice(r.accepted ? '任务已接受，以下进度来自服务器实际状态。' : '未接受：任务正在运行或没有可用回退。', !r.accepted); await deployment(); }));
$('deploy-status').addEventListener('click', guarded(deployment));
$('new-account').addEventListener('click', guarded(async () => {
  if (loginSession) { $('account-dialog').showModal(); return; }
  $('account-form').reset(); $('complete-box').hidden = true; $('begin-login').disabled = false; providerChanged(); $('account-dialog').showModal();
  try { await groups(); } catch { /* 分组读不到时手动输入 */ }
  const first = (groupsCache || []).find((g) => ['anthropic', 'composite'].includes(g.platform));
  fillGroups($('group-select'), ['anthropic', 'composite'], first ? first.id : '', '手动输入 ID…'); groupChanged();
}));
function groupChanged() { $('group-manual').hidden = Boolean($('group-select').value); }
$('group-select').addEventListener('change', groupChanged);
$('close-dialog').addEventListener('click', () => $('account-dialog').close());
function providerChanged() {
  const email = $('provider').value === 'email', hosted = $('hosted').checked;
  $('email-field').hidden = !email; $('email').required = email;
  $('port-field').hidden = hosted || !host; $('base-field').hidden = hosted || host;
  $('begin-login').textContent = email ? '发送验证码' : `生成 ${$('provider').value === 'github' ? 'GitHub' : 'Google'} 授权链接`;
}
$('provider').addEventListener('change', providerChanged); $('hosted').addEventListener('change', providerChanged); providerChanged();
$('email').addEventListener('blur', () => {
  const field = $('profile');
  if (field.value.trim() && /^[a-z][a-z0-9_-]{0,39}$/.test(field.value.trim())) return;
  const email = $('email').value.trim().toLowerCase();
  if (!email) return;
  const local = email.split('@')[0].replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const domain = (email.split('@')[1] || '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let generated = `mira-${local || 'account'}${domain ? '-' + domain : ''}`.replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
  if (!/^[a-z]/.test(generated)) generated = 'mira-' + generated;
  field.value = generated.slice(0, 40);
});
$('account-form').addEventListener('submit', guarded(async () => {
  if (loginSession) throw Error('请先完成当前登录，或等待过期后刷新页面');
  const hosted = $('hosted').checked;
  let profile = $('profile').value.trim().toLowerCase();
  const email = $('email').value.trim();
  if (!profile) profile = 'mira-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  if (profile.includes('@')) profile = ('mira-' + profile.replace(/[^a-z0-9_-]+/g, '-')).slice(0, 40);
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(profile)) {
    if (profile.includes('@')) { $('email').value = email || profile; $('email').dispatchEvent(new Event('blur')); profile = $('profile').value.trim(); }
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(profile)) throw Error('Profile 只能以小写字母开头，并包含小写字母、数字、下划线或短横线，例如 mira-second');
  }
  $('profile').value = profile;
  const data = { profile, account_name: $('account-name').value.trim(), provider: $('provider').value, email, hosted };
  if (!hosted) { data.port = Number($('port').value) || undefined; data.public_base_url = $('base-url').value; }
  const groupId = Number($('group-select').value) || Number($('group-id').value);
  if (!groupId) throw Error('请选择分组，或填写分组 ID');
  data.group_id = groupId;
  const r = await api('login/start', data, 'main'); loginSession = { ...r, profile: data.profile, hosted }; $('complete-box').hidden = false;
  $('oauth-link').hidden = !['google', 'github'].includes(data.provider);
  $('oauth-link').textContent = `打开 ${data.provider === 'github' ? 'GitHub' : 'Google'} 授权页面 ↗`;
  if (r.url) { const u = new URL(r.url); if (u.protocol !== 'https:') throw Error('授权地址不是 HTTPS'); $('oauth-link').href = r.url; }
  $('login-hint').textContent = data.provider === 'email' ? '验证码已发送。输错可重试，最多 5 次；不要重复发送。' : '在无痕窗口打开授权链接。授权后会跳到 127.0.0.1，显示无法访问属于正常情况；复制地址栏完整回调 URL 到下面，不要发送给他人。';
  $('code').type = 'password'; $('code').value = ''; $('code').placeholder = data.provider === 'email' ? '邮箱验证码' : '完整回调 URL'; $('login-message').textContent = '';
  $('complete-prompt').textContent = data.provider === 'email' ? '邮箱验证码' : '完整回调 URL（包含 access_token 与 state）';
}));
async function finishLogin(r, session) {
  if (loginFinishing || loginSession !== session) return;
  loginFinishing = true;
  $('code').value = ''; loginSession = null; $('complete-box').hidden = true; $('account-dialog').close();
  try {
  if (session.hosted) {
    try { const h = await api('account/host', { profile: r.profile }, 'main'); selected = { target: 'main', account: r.profile }; notice(`回调已收到，账号 ${r.profile} 已保存并托管${h.registered ? `，sub2 账号 ${h.account_name} 已注册` : '，sub2 注册将在健康检查中完成'}。`); }
    catch (e) { notice(`账号 ${r.profile} 已保存，但托管失败：${e.message}。可在 profiles 列表重试。`, true); }
  } else notice(`账号 ${r.profile} 已独立保存。${host ? '点击 profiles 列表中的“独立容器”。' : '请启动对应 profile 容器。'}`);
  try { await refresh(); } catch { notice(`账号 ${r.profile} 已保存；页面刷新未完成，请稍后点刷新。`, true); }
  } finally { loginFinishing = false; }
}
async function queryLogin() {
  const session = loginSession;
  if (!session || loginFinishing) return;
  const r = await api('login/status', { id: session.id }, 'main');
  if (r.stage === 'saved') return finishLogin(r, session);
  $('login-message').textContent = { waiting: '本次登录仍在等待回调，请粘贴授权后的完整地址并提交。', validating: '回调已收到，正在验证并保存账号，请勿重复授权。', failed: '回调验证或保存未完成，原账号未修改。' }[r.stage] || '正在查询登录状态';
}
$('login-status').addEventListener('click', guarded(queryLogin));
$('complete-form').addEventListener('submit', guarded(async () => {
  const session = loginSession;
  if (!session) throw Error('请先发起登录');
  const data = { id: session.id }; data[session.provider === 'email' ? 'code' : 'callback'] = $('code').value.trim();
  $('login-message').textContent = '正在提交回调并校验账号…';
  let r;
  try { r = await api('login/complete', data, 'main'); }
  catch (err) {
    // A response can be lost after credentials were saved. Check the same session
    // before asking the user to authorize or submit again.
    const status = await api('login/status', { id: session.id }, 'main').catch(() => null);
    if (status?.stage === 'saved') return finishLogin(status, session);
    if (status?.stage === 'validating') { $('login-message').textContent = '回调已收到，后台仍在校验；请稍后查询登录状态。'; return; }
    throw err;
  }
  await finishLogin(r, session);
}));
$('mode').textContent = host ? '宿主机管理' : '单 bridge 管理';
for (const id of ['start-account', 'stop-account', 'deploy', 'rollback', 'deploy-status', 'check-release', 'follow-latest']) $(id).disabled = !host;
$('release-note').textContent = host ? '升级失败会自动尝试回退。这里显示服务器的真实进度，操作记录不包含凭证。' : '当前为单 bridge 页面；完整的升级、回退和容器启停请使用宿主机后台（8790）。';
