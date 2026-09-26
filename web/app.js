'use strict';
const $ = (id) => document.getElementById(id);
const host = document.body.dataset.mode === 'host';
let key = '', loginSession = null, timer = null, polling = false, noticeTimer = null, view = 'overview';
let selected = { target: 'main', account: 'main' };
let fleetRows = [], bridgeVersion = null, modelRows = [], modelsFor = '', groupsCache = null;
const titles = { overview: '运行概览', accounts: '账号管理', models: '模型目录', logs: '运行日志', release: '版本与升级' };
const KNOWN = ['claude', 'gpt', 'deepseek', 'kimi'];
const FAMILY_NAMES = { claude: 'Claude', gpt: 'GPT', deepseek: 'DeepSeek', kimi: 'Kimi', glm: 'GLM', other: '其他' };
const familyName = (f) => FAMILY_NAMES[f] || (f ? f.charAt(0).toUpperCase() + f.slice(1) : '其他');
const familyOrder = (f) => (KNOWN.includes(f) ? KNOWN.indexOf(f) : 10);
const ACTIONS = { deploy: '升级', rollback: '回退', start: '启动容器', stop: '停止容器', attach: '启动独立容器', 'account/host': '托管账号', 'account/unhost': '移出托管', 'account/pause': '暂停调度', 'account/resume': '恢复调度', model: '模型启停', 'models/family': '系列启停', settings: '运行设置', codex: 'Codex 账号', test: '模型测试', 'login/start': '发起登录', 'login/complete': '完成登录' };
const SCHED = { on: ['已入池', 'ok'], off: ['已暂停', 'warn'], unmanaged: ['未接管', ''], unknown: ['等待确认', 'warn'] };
async function groups() { if (!groupsCache) groupsCache = await api('groups', {}, 'main'); return groupsCache; }
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
const scoped = (data = {}) => ({ account: selected.account, ...data });
function guarded(fn) {
  return async (event) => {
    event?.preventDefault();
    const btn = event?.submitter || (event?.currentTarget?.tagName === 'BUTTON' ? event.currentTarget : null);
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try { await fn(event); } catch (e) { notice(e.message, true); if ($('account-dialog').open) $('login-message').textContent = e.message; }
    finally { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
  };
}
function stat(id, value, tone) { $(id).querySelector('strong').textContent = value; if (tone) $(id).dataset.tone = tone; else delete $(id).dataset.tone; }
function quotaLevel(pct) { return pct == null ? '' : pct < 10 ? 'bad' : pct < 30 ? 'warn' : 'ok'; }
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
  const targets = host ? await api('targets') : [{ name: 'main' }];
  const rows = (await Promise.all(targets.map(async (t) => {
    try {
      const s = await api('status', { account: 'main' }, t.name);
      const list = Array.isArray(s.accounts) && s.accounts.length ? s.accounts : [{ key: 'main', account_name: '?', sub2api: s.sub2api, quota: s.quota, inflight: s.inflight, counters: s.counters, hold: s.hold }];
      return list.map((a) => ({ target: t.name, account: a.key, version: s.version, hosting: Boolean(s.hosting), summary: a }));
    } catch (e) { return [{ target: t.name, account: 'main', error: e.message, summary: {} }]; }
  }))).flat();
  fleetRows = rows;
  if (!rows.some((r) => r.target === selected.target && r.account === selected.account)) selected = { target: rows[0]?.target || 'main', account: rows[0]?.account || 'main' };
  $('target').replaceChildren(...rows.map((r) => { const o = node('option', label(r)); o.value = `${r.target}|${r.account}`; return o; }));
  $('target').value = `${selected.target}|${selected.account}`;
  $('fleet').replaceChildren();
  const on = rows.filter((r) => r.summary.sub2api?.schedulable === 'on').length;
  $('fleet-summary').textContent = `${rows.length} 个账号 · ${on} 个在池中`;
  for (const r of rows) {
    const a = r.summary, row = node('button', '', 'fleet-row'); row.type = 'button';
    if (r.target === selected.target && r.account === selected.account) row.classList.add('current');
    const name = node('div', '', 'fleet-name'); name.append(node('b', label(r)), node('span', a.account_name ? `sub2: ${a.account_name}` : r.error || '', 'hint'));
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
    row.append(name, state, quotaMini(a.quota), load);
    row.addEventListener('click', guarded(async () => { selected = { target: r.target, account: r.account }; $('target').value = `${r.target}|${r.account}`; await refresh(); }));
    $('fleet').append(row);
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
  bridgeVersion = null; $('current-version').textContent = '—';
  const s = await api('summary', scoped()), runtime = await api('status', scoped());
  const sub = runtime.sub2api || {};
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
  for (const id of ['connection', 'account-info']) { $(id).replaceChildren(); for (const [k, v] of Object.entries(info)) $(id).append(node('dt', k), node('dd', v)); }
  $('selected-title').textContent = label(selected);
  $('selected-sub').textContent = `${sched[0]} · sub2 账号 ${s.account_name || '—'}`;
  const container = selected.account === 'main' && host;
  $('start-account').hidden = !container; $('stop-account').hidden = !container;
  $('pause-account').hidden = Boolean(runtime.hold); $('resume-account').hidden = !runtime.hold;
  if (document.activeElement?.form !== $('settings-form')) {
    if (s.max_concurrency) $('max-concurrency').value = s.max_concurrency;
    if (s.kimi_max_concurrency) $('kimi-concurrency').value = s.kimi_max_concurrency;
    if (s.model_fallback) $('model-fallback').value = s.model_fallback;
    if (s.kimi_default_effort !== undefined) $('kimi-effort').value = s.kimi_default_effort;
  }
  await codexCard();

  renderTrend(runtime.history); renderLatency(runtime.latency);
  const quota = runtime.quota || {};
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

  const c = runtime.counters || {};
  $('traffic').replaceChildren();
  for (const [name, value, tone] of [['总请求', c.total], ['成功', c.ok, 'ok'], ['失败', c.err, c.err ? 'bad' : ''], ['被拒绝', c.rejected, c.rejected ? 'warn' : ''], ['模型被替换', c.fallback, c.fallback ? 'warn' : '']]) {
    const m = node('div', '', 'metric'); if (tone) m.dataset.tone = tone;
    m.append(node('label', name), node('strong', value == null ? '—' : Number(value).toLocaleString())); $('traffic').append(m);
  }
  $('backoff').hidden = !runtime.backoff_sec_left; $('backoff').textContent = `上游限流退避中 · ${runtime.backoff_sec_left}s`;
  const fb = runtime.last_fallback;
  $('fallback-note').hidden = !fb;
  if (fb) $('fallback-note').textContent = `最近一次模型替换：请求 ${fb.requested}，实际由 ${fb.served} 回复 · ${relative(Date.parse(fb.at))}`;
  const se = runtime.last_stream_error;
  $('stream-error').hidden = !se;
  if (se) $('stream-error').textContent = `最近一次流异常：${se.code || '未知'} · ${se.model || '未知模型'} · ${se.at ? relative(Date.parse(se.at)) : ''}`;
  $('refreshed').hidden = false; $('refreshed').textContent = '更新于 ' + new Date().toLocaleTimeString();
}

async function codexCard() {
  let cx;
  try { cx = await api('codex', scoped()); } catch { $('codex-card').hidden = true; return; }
  $('codex-card').hidden = false;
  const st = cx.sub2api_codex || {};
  const pillEl = $('codex-state'); pillEl.hidden = false;
  const [text, tone] = !cx.enabled ? ['未启用', ''] : st.managed ? [SCHED[st.schedulable]?.[0] || '等待确认', st.schedulable === 'on' ? 'ok' : 'warn'] : ['已启用 · 等待注册', 'warn'];
  pillEl.className = 'pill' + (tone ? ' ' + tone : ''); pillEl.textContent = `${text}${cx.enabled ? ' · ' + cx.account_name : ''}`;
  if (document.activeElement?.form !== $('codex-form')) {
    $('codex-enabled').checked = cx.enabled; $('codex-name').value = cx.custom_name || '';
    try { await groups(); } catch { /* 无管理连接时只保留手动输入 */ }
    fillGroups($('codex-group'), ['openai', 'composite'], cx.group_ids?.[0], '选择分组…');
  }
}
async function profiles() {
  const rows = await api('profiles', {}, 'main'); $('profiles').replaceChildren();
  if (!rows.length) $('profiles').append(empty('还没有独立 profile。点击“新增账号”开始。'));
  const containers = new Set(fleetRows.filter((r) => r.account === 'main' && r.target !== 'main').map((r) => r.target));
  const hostingSupported = fleetRows.some((r) => r.target === 'main' && r.hosting);
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
}

function renderFamilies() {
  $('families').replaceChildren();
  const families = [...new Set(modelRows.map((m) => m.family))].sort((a, b) => familyOrder(a) - familyOrder(b) || a.localeCompare(b));
  for (const family of families) {
    const rows = modelRows.filter((m) => m.family === family);
    const on = rows.filter((m) => m.enabled).length, box = node('div', '', 'family'), text = node('div');
    text.append(node('b', familyName(family)), node('span', `已启用 ${on} / ${rows.length}`));
    const enable = on < rows.length, button = node('button', enable ? '全部启用' : '全部停用', enable ? 'secondary small' : 'danger small');
    button.addEventListener('click', guarded(async () => {
      if (!confirm(`${enable ? '启用' : '停用'} ${familyName(family)} 系列的全部模型？`)) return;
      const r = await api('models/family', scoped({ family, enabled: enable })); notice(`已${enable ? '启用' : '停用'} ${r.changed} 个 ${familyName(family)} 模型，sub2 映射将在下一次健康检查同步。`); await models();
    }));
    box.append(text, button); $('families').append(box);
  }
  $('family-card').hidden = !$('families').children.length;
}
async function models() {
  const wanted = `${selected.target}|${selected.account}`;
  $('models').replaceChildren((() => { const tr = document.createElement('tr'), td = node('td'); td.colSpan = 6; td.append(empty('正在读取上游目录…')); tr.append(td); return tr; })());
  modelRows = await api('models', scoped()); modelsFor = wanted; $('models').replaceChildren();
  modelRows.sort((a, b) => familyOrder(a.family) - familyOrder(b.family) || a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
  if (!modelRows.length) { const tr = document.createElement('tr'), td = node('td'); td.colSpan = 6; td.append(empty('上游目录为空')); tr.append(td); $('models').append(tr); }
  for (const m of modelRows) {
    const tr = document.createElement('tr'); if (!m.enabled) tr.className = 'off';
    tr.append(node('td', m.id, 'model-id'));
    const fam = node('td'); fam.append(node('span', familyName(m.family), 'chip')); tr.append(fam);
    const st = node('td'); st.append(m.enabled ? pill('已启用', 'ok') : m.blocked ? pill('已屏蔽', 'bad') : m.filtered ? pill('未放行', '') : pill('已停用')); tr.append(st);
    const lat = node('td', '', 'lat-cell');
    if (m.latency) { lat.append(node('b', ms(m.latency.total_p50_ms)), node('span', ` · 首字节 ${ms(m.latency.ttfb_p50_ms)} · ${m.latency.count} 次`, 'hint')); if (m.latency.last_ok === false) lat.append(pill('最近失败', 'bad')); }
    else lat.append(node('span', '尚无样本', 'hint'));
    tr.append(lat);
    tr.append(node('td', m.note, 'note'));
    const actions = node('td', '', 'actions');
    if (m.enabled) {
      const test = node('button', '测试', 'secondary small');
      test.addEventListener('click', guarded(async () => { if (!confirm(`测试 ${m.id} 会发送真实请求、消耗额度，是否继续？`)) return; const result = await api('test', scoped({ id: m.id })); notice(`${result.model}：${result.message} · HTTP ${result.status} · ${result.elapsed_ms ?? '?'} ms`, !result.ok); }));
      actions.append(test);
    }
    if (!m.blocked && !m.filtered) {
      const toggle = node('button', m.enabled ? '停用' : '启用', m.enabled ? 'quiet small' : 'secondary small');
      toggle.addEventListener('click', guarded(async () => { await api('model', scoped({ id: m.id, enabled: !m.enabled })); notice('配置已保存，sub2 模型映射会在下一次健康检查同步。'); await models(); }));
      actions.append(toggle);
    }
    tr.append(actions); $('models').append(tr);
  }
  const on = modelRows.filter((m) => m.enabled).length;
  $('model-summary').replaceChildren(pill(`已启用 ${on}`, 'ok'), pill(`共 ${modelRows.length}`), pill(`${new Set(modelRows.map((m) => m.family)).size} 个系列`, 'info'));
  renderFamilies();
}

async function logs() {
  const r = await api('logs', { limit: 400 });
  const filter = $('log-filter').value.trim().toLowerCase();
  const lines = (r.lines || []).filter((l) => !filter || l.toLowerCase().includes(filter));
  const pre = $('logs'), atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = lines.length ? lines.join('\n') : (filter ? '没有匹配的日志行' : '暂无日志');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

const phases = { idle: ['等待操作', ''], checking: ['检查发布', 'info'], pulling: ['拉取并验证镜像', 'info'], activating: ['重建容器并验证服务', 'info'], succeeded: ['升级成功', 'ok'], failed: ['准备失败，运行中的容器未改变', 'bad'], rolling_back: ['正在回退', 'warn'], rolled_back: ['已回退', 'warn'], rollback_failed: ['回退未完成，需要排查', 'bad'] };
const steps = { fetch_manifest: '获取发布清单', pull_image: '拉取镜像', verify_image: '验证镜像', stage_host: '准备宿主机文件', snapshot: '记录原容器', activate_image: '切换镜像', stop_container: '停止旧容器', start_container: '启动新容器', check_health: '检查服务', install_host: '更新后台', restore_host: '恢复后台', restore_image: '恢复镜像', restore_container: '恢复容器', restore_health: '检查恢复后的服务', restore_tag: '恢复镜像标签' };
const errors = { command_timeout: '命令超时', command_unavailable: '命令不可执行', docker_operation_failed: 'Docker 操作失败', container_not_running: '容器未运行', container_missing: '容器不存在', image_missing: '镜像不存在', disk_full: '磁盘空间不足', permission_denied: '权限不足', docker_unavailable: 'Docker 服务不可用', bridge_unresponsive: '桥接器未正常响应', operation_failed: '操作失败' };
async function deployment() {
  if (!host) return;
  const s = await api('deployment'), [text, tone] = phases[s.phase] || [s.phase, ''];
  const box = $('deploy-state'); box.replaceChildren(node('strong', text));
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
  const events = (await api('events')).slice().reverse();
  $('events').replaceChildren(...(events.length ? events.map((e) => {
    const row = node('div', '', 'event'), when = node('time', relative(e.at * 1000)); when.title = new Date(e.at * 1000).toLocaleString();
    const requested = e.action.endsWith('/requested') || ['deploy', 'rollback'].includes(e.action);
    const action = e.action.replace(/\/requested$/, '');
    const what = node('div'); what.append(node('b', ACTIONS[action] || action), document.createTextNode(' · ' + e.target));
    row.append(when, what, e.ok ? pill(requested ? '已接受任务' : '完成', requested ? 'info' : 'ok') : pill(requested ? '未接受任务' : '失败', 'bad')); return row;
  }) : [empty('还没有管理操作记录')]));
}
async function checkRelease() {
  const r = await api('release/check'); $('latest-version').textContent = r.latest;
  if (!bridgeVersion) {
    $('update-pill').hidden = false; $('update-pill').className = 'pill warn';
    $('update-pill').textContent = '运行版本未知，请检查桥接器状态'; return;
  }
  const newer = bridgeVersion && versionNewer(r.latest, bridgeVersion);
  $('update-pill').hidden = false;
  $('update-pill').className = 'pill ' + (newer ? 'info' : 'ok');
  $('update-pill').textContent = newer ? `可升级到 ${r.latest}` : '已是最新版本';
}
async function refresh() {
  groupsCache = null;
  // Keep recovery controls available when account reads fail.
  try { await fleet(); await overview(); await profiles(); } finally { await deployment(); }
  if (view === 'models') await models(); if (view === 'logs') await logs();
}
async function showView(next) {
  view = next; $('page-title').textContent = titles[next];
  for (const el of document.querySelectorAll('[data-section]')) el.hidden = el.dataset.section !== next;
  for (const el of document.querySelectorAll('[data-view]')) el.classList.toggle('selected', el.dataset.view === next);
  if (next === 'release' && host && $('latest-version').textContent === '—') checkRelease().catch(() => {});
  if (next === 'models' && key && modelsFor !== `${selected.target}|${selected.account}`) models().catch((e) => notice(e.message, true));
  if (next === 'logs' && key) logs().catch((e) => notice(e.message, true));
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
$('login-form').addEventListener('submit', guarded(async () => {
  key = $('key').value.trim(); if (!/^[a-f0-9]{64}$/.test(key)) throw Error('请输入有效的 64 位管理密钥');
  if (host) await api('targets'); else await api('summary');
  $('key').value = ''; $('login-box').hidden = true; $('workspace').hidden = false; notice('已连接后台');
  try { await refresh(); } catch (err) { notice(err.message, true); }
  clearInterval(timer);
  timer = setInterval(async () => { if (!key || polling || document.hidden) return; polling = true; try { try { await fleet(); await overview(); } finally { await deployment(); } if (view === 'logs') await logs(); } catch {} finally { polling = false; } }, 15000);
}));
$('logout').addEventListener('click', () => { key = ''; clearInterval(timer); location.reload(); });
$('refresh').addEventListener('click', guarded(refresh)); $('load-models').addEventListener('click', guarded(models)); $('load-logs').addEventListener('click', guarded(logs));
$('log-filter').addEventListener('input', () => { logs().catch(() => {}); });
$('check-release').addEventListener('click', guarded(checkRelease));
$('settings-form').addEventListener('submit', guarded(async () => {
  const data = scoped({ max_concurrency: Number($('max-concurrency').value), kimi_max_concurrency: Number($('kimi-concurrency').value), model_fallback: $('model-fallback').value, kimi_default_effort: $('kimi-effort').value });
  const r = await api('settings', data); notice(`${label(selected)}：并发 总 ${r.max_concurrency} · Kimi ${r.kimi_max_concurrency} · Kimi 推理档 ${r.kimi_default_effort === undefined ? '（旧版 bridge 未支持）' : (r.kimi_default_effort || '不干预')}；模型被替换时${r.model_fallback === 'forbid' ? '中断本轮' : '照常回复并记录'}。已立即生效。`); await overview();
}));
$('codex-form').addEventListener('submit', guarded(async () => {
  const enabled = $('codex-enabled').checked, group_id = Number($('codex-group').value) || undefined;
  if (enabled && !group_id) throw Error('请选择一个 openai 或 composite 平台分组');
  const r = await api('codex', scoped({ enabled, group_id, account_name: $('codex-name').value.trim() }));
  notice(enabled ? (r.registered ? `Codex 账号 ${r.account_name} 已注册，进入调度后即可在 Codex 里使用。` : '已保存，Codex 账号将在健康检查中注册。') : 'Codex 账号已关闭并暂停。');
  await overview();
}));
$('target').addEventListener('change', guarded(async () => {
  const [target, account] = $('target').value.split('|'); selected = { target, account };
  modelRows = []; modelsFor = ''; $('models').replaceChildren(); $('family-card').hidden = true; $('model-summary').replaceChildren();
  await refresh(); notice(`已选择 ${label(selected)}。`);
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
}));
$('complete-form').addEventListener('submit', guarded(async () => {
  if (!loginSession) throw Error('请先发起登录');
  const data = { id: loginSession.id }; data[loginSession.provider === 'email' ? 'code' : 'callback'] = $('code').value.trim();
  const r = await api('login/complete', data, 'main'); $('code').value = ''; const session = loginSession; loginSession = null; $('complete-box').hidden = true; $('account-dialog').close();
  if (session.hosted) {
    try { const h = await api('account/host', { profile: r.profile }, 'main'); notice(`账号 ${r.profile} 已保存并托管${h.registered ? `，sub2 账号 ${h.account_name} 已注册` : '，sub2 注册将在健康检查中完成'}。`); }
    catch (e) { notice(`账号 ${r.profile} 已保存，但托管失败：${e.message}。可在 profiles 列表重试。`, true); }
  } else notice(`账号 ${r.profile} 已独立保存。${host ? '点击 profiles 列表中的“独立容器”。' : '请启动对应 profile 容器。'}`);
  await refresh();
}));
$('mode').textContent = host ? '宿主机管理' : '单 bridge 管理';
for (const id of ['start-account', 'stop-account', 'deploy', 'rollback', 'deploy-status', 'check-release']) $(id).disabled = !host;
$('release-note').textContent = host ? '升级失败会自动尝试回退。这里显示服务器的真实进度，操作记录不包含凭证。' : '当前为单 bridge 页面；完整的升级、回退和容器启停请使用宿主机后台（8790）。';
