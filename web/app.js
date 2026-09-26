'use strict';
const $ = (id) => document.getElementById(id);
const host = document.body.dataset.mode === 'host';
let key = '', loginSession = null, timer = null, polling = false, noticeTimer = null;
let selected = { target: 'main', account: 'main' };
let fleetRows = [], bridgeVersion = null, modelRows = [];
const titles = { overview: '运行概览', accounts: '账号管理', models: '模型目录', release: '版本与升级' };
const FAMILIES = ['claude', 'gpt', 'deepseek', 'kimi'];
const FAMILY_NAMES = { claude: 'Claude', gpt: 'GPT', deepseek: 'DeepSeek', kimi: 'Kimi' };
const ACTIONS = { deploy: '升级', rollback: '回退', start: '启动容器', stop: '停止容器', attach: '启动独立容器', 'account/host': '托管账号', 'account/unhost': '移出托管', 'account/pause': '暂停调度', 'account/resume': '恢复调度', model: '模型启停', 'models/family': '系列启停', settings: '并发设置', test: '模型测试', 'login/start': '发起登录', 'login/complete': '完成登录' };
const SCHED = { on: ['已入池', 'ok'], off: ['已暂停', 'warn'], unmanaged: ['未接管', ''], unknown: ['等待确认', 'warn'] };

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
  const [n, unit] = abs < 3600e3 ? [Math.max(1, Math.round(abs / 60e3)), '分钟'] : abs < 86400e3 ? [Math.round(abs / 3600e3), '小时'] : [Math.round(abs / 86400e3), '天'];
  return future ? `${n} ${unit}后` : `${n} ${unit}前`;
}
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
const scoped = (data = {}) => ({ account: selected.account, ...data });   // account-scoped call on the selected account
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

/** Every Mira account across every target: hosted accounts (0.8.0) plus separate containers. */
async function fleet() {
  const targets = host ? await api('targets') : [{ name: 'main' }];
  const rows = [];
  for (const t of targets) {
    try {
      const s = await api('status', { account: 'main' }, t.name);
      const list = Array.isArray(s.accounts) && s.accounts.length ? s.accounts : [{ key: 'main', account_name: '?', sub2api: s.sub2api, quota: s.quota, inflight: s.inflight, counters: s.counters, hold: s.hold }];
      for (const a of list) rows.push({ target: t.name, account: a.key, version: s.version, hosting: Boolean(s.hosting), summary: a });
    } catch (e) { rows.push({ target: t.name, account: 'main', error: e.message, summary: {} }); }
  }
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
      if (a.sub2api_codex?.managed) state.append(pill(`Codex ${SCHED[a.sub2api_codex.schedulable]?.[0] || '等待'}`, a.sub2api_codex.schedulable === 'on' ? 'info' : ''));
    }
    const load = node('div', '', 'fleet-load'); const c = a.counters || {};
    load.append(node('b', a.inflight == null ? '—' : String(a.inflight)), node('span', `在途 · 成功 ${c.ok ?? '—'} · 失败 ${c.err ?? '—'}`, 'hint'));
    row.append(name, state, quotaMini(a.quota), load);
    row.addEventListener('click', guarded(async () => { selected = { target: r.target, account: r.account }; $('target').value = `${r.target}|${r.account}`; await refresh(); }));
    $('fleet').append(row);
  }
}

async function overview() {
  const s = await api('summary', scoped()), runtime = await api('status', scoped());
  const sub = runtime.sub2api || {};
  bridgeVersion = runtime.version || null;
  stat('stat-version', runtime.version || '未知');
  $('current-version').textContent = runtime.version || '—';
  const scheduling = sub.schedulable || runtime.schedulable;
  const sched = runtime.hold ? ['手动暂停', 'warn'] : SCHED[scheduling] || SCHED.unknown;
  stat('stat-schedule', sched[0], sched[1]);
  $('reach').textContent = (sub.reachable ?? runtime.reachable) ? 'sub2 → bridge 可达' : '反向连接待确认';
  stat('stat-inflight', String(runtime.inflight ?? '—'));
  $('stat-inflight').querySelector('span').textContent = runtime.kimi_inflight ? `其中 Kimi ${runtime.kimi_inflight} 个` : `上限 ${s.max_concurrency ?? '—'}`;
  const up = runtime.uptime_sec;
  stat('stat-uptime', Number.isFinite(up) ? (up >= 86400 ? `${Math.floor(up / 86400)}天 ${Math.floor(up % 86400 / 3600)}时` : `${Math.floor(up / 3600)}h ${Math.floor(up % 3600 / 60)}m`) : '—');

  const codex = runtime.sub2api_codex || {};
  const codexText = codex.managed ? `${SCHED[codex.schedulable]?.[0] || '等待确认'}${codex.reachable ? '' : ' · 反向连接待确认'}` : '未启用（见 CODEX.md）';
  const kind = selected.account !== 'main' ? '托管账号（与主账号同一地址，按密钥区分）' : runtime.hosting ? '主账号（本 bridge）' : '独立 bridge';
  const info = { '当前账号': label({ target: selected.target, account: selected.account }), '类型': kind, 'sub2 账号名': s.account_name, '配置分组': (s.group_ids || []).join(', ') || '未设置', '上游地址': s.public_base_url || '（本机端口）', '并发上限': `总 ${s.max_concurrency ?? '—'} · Kimi ${s.kimi_max_concurrency ?? '—'}`, 'Codex 账号': codexText, '模型被替换时': s.model_fallback === 'forbid' ? '中断本轮' : '照常回复并记录' };
  for (const id of ['connection', 'account-info']) { $(id).replaceChildren(); for (const [k, v] of Object.entries(info)) $(id).append(node('dt', k), node('dd', v)); }
  $('selected-title').textContent = label({ target: selected.target, account: selected.account });
  $('selected-sub').textContent = `${sched[0]} · sub2 账号 ${s.account_name || '—'}`;
  const container = selected.account === 'main' && host;
  $('start-account').hidden = !container; $('stop-account').hidden = !container;
  $('pause-account').hidden = Boolean(runtime.hold); $('resume-account').hidden = !runtime.hold;
  if (document.activeElement?.form !== $('settings-form')) {
    if (s.max_concurrency) $('max-concurrency').value = s.max_concurrency;
    if (s.kimi_max_concurrency) $('kimi-concurrency').value = s.kimi_max_concurrency;
    if (s.model_fallback) $('model-fallback').value = s.model_fallback;
  }

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
        b.addEventListener('click', guarded(async () => { const r = await api('account/host', { profile: p.profile }, 'main'); notice(r.registered ? `已托管并注册 sub2 账号 ${r.account_name}${r.reachable ? '' : '（反向连接待确认）'}` : `已托管，sub2 注册将在健康检查中完成`); await refresh(); }));
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
  for (const family of FAMILIES) {
    const rows = modelRows.filter((m) => m.family === family || m.id.startsWith(family + '-'));
    if (!rows.length) continue;
    const on = rows.filter((m) => m.enabled).length, box = node('div', '', 'family'), text = node('div');
    text.append(node('b', FAMILY_NAMES[family]), node('span', `已启用 ${on} / ${rows.length}`));
    const enable = on < rows.length, button = node('button', enable ? '全部启用' : '全部停用', enable ? 'secondary small' : 'danger small');
    button.addEventListener('click', guarded(async () => {
      if (!confirm(`${enable ? '启用' : '停用'} ${FAMILY_NAMES[family]} 系列的全部模型？`)) return;
      const r = await api('models/family', scoped({ family, enabled: enable })); notice(`已${enable ? '启用' : '停用'} ${r.changed} 个 ${FAMILY_NAMES[family]} 模型，sub2 映射将在下一次健康检查同步。`); await models();
    }));
    box.append(text, button); $('families').append(box);
  }
  $('family-card').hidden = !$('families').children.length;
}
async function models() {
  modelRows = await api('models', scoped()); $('models').replaceChildren();
  modelRows.sort((a, b) => FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family) || a.id.localeCompare(b.id));
  if (!modelRows.length) { const tr = document.createElement('tr'), td = node('td'); td.colSpan = 5; td.append(empty('上游目录为空')); tr.append(td); $('models').append(tr); }
  for (const m of modelRows) {
    const tr = document.createElement('tr'); if (!m.enabled) tr.className = 'off';
    tr.append(node('td', m.id, 'model-id'));
    const fam = node('td'); fam.append(node('span', FAMILY_NAMES[m.family] || m.family, 'chip')); tr.append(fam);
    const st = node('td'); st.append(m.enabled ? pill('已启用', 'ok') : pill('已停用')); tr.append(st);
    tr.append(node('td', m.note, 'note'));
    const actions = node('td', '', 'actions');
    if (m.enabled) {
      const test = node('button', '测试', 'secondary small');
      test.addEventListener('click', guarded(async () => { if (!confirm(`测试 ${m.id} 会发送真实请求、消耗额度，是否继续？`)) return; const result = await api('test', scoped({ id: m.id })); notice(`${result.model}：${result.message} · HTTP ${result.status} · ${result.elapsed_ms ?? '?'} ms`, !result.ok); }));
      actions.append(test);
    }
    const toggle = node('button', m.enabled ? '停用' : '启用', m.enabled ? 'quiet small' : 'secondary small');
    toggle.addEventListener('click', guarded(async () => { await api('model', scoped({ id: m.id, enabled: !m.enabled })); notice('配置已保存，sub2 模型映射会在下一次健康检查同步。'); await models(); }));
    actions.append(toggle); tr.append(actions); $('models').append(tr);
  }
  const on = modelRows.filter((m) => m.enabled).length;
  $('model-summary').replaceChildren(pill(`已启用 ${on}`, 'ok'), pill(`共 ${modelRows.length}`));
  renderFamilies();
}

const phases = { idle: ['等待操作', ''], checking: ['检查发布', 'info'], pulling: ['拉取并验证镜像', 'info'], activating: ['重建容器并验证调度', 'info'], succeeded: ['升级成功', 'ok'], failed: ['准备失败，运行中的容器未改变', 'bad'], rolling_back: ['正在回退', 'warn'], rolled_back: ['已回退', 'warn'], rollback_failed: ['回退未完成，需要排查', 'bad'] };
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
  const events = (await api('events')).slice().reverse();
  $('events').replaceChildren(...(events.length ? events.map((e) => {
    const row = node('div', '', 'event'), when = node('time', relative(e.at * 1000)); when.title = new Date(e.at * 1000).toLocaleString();
    const what = node('div'); what.append(node('b', ACTIONS[e.action] || e.action), document.createTextNode(' · ' + e.target));
    row.append(when, what, e.ok ? pill('完成', 'ok') : pill('失败', 'bad')); return row;
  }) : [empty('还没有管理操作记录')]));
}
async function checkRelease() {
  const r = await api('release/check'); $('latest-version').textContent = r.latest;
  const newer = bridgeVersion && versionNewer(r.latest, bridgeVersion);
  $('update-pill').hidden = false;
  $('update-pill').className = 'pill ' + (newer ? 'info' : 'ok');
  $('update-pill').textContent = newer ? `可升级到 ${r.latest}` : '已是最新版本';
}
async function refresh() { await fleet(); await overview(); await profiles(); await deployment(); }

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  const view = button.dataset.view; $('page-title').textContent = titles[view];
  for (const el of document.querySelectorAll('[data-section]')) el.hidden = el.dataset.section !== view;
  for (const el of document.querySelectorAll('[data-view]')) el.classList.toggle('selected', el === button);
  if (view === 'release' && host && $('latest-version').textContent === '—') checkRelease().catch(() => {});
});
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
$('login-form').addEventListener('submit', guarded(async () => {
  key = $('key').value.trim(); if (!/^[a-f0-9]{64}$/.test(key)) throw Error('请输入有效的 64 位管理密钥');
  if (host) await api('targets'); else await api('summary');
  $('key').value = ''; $('login-box').hidden = true; $('workspace').hidden = false; notice('已连接后台');
  await refresh();
  clearInterval(timer);
  timer = setInterval(async () => { if (!key || polling || document.hidden) return; polling = true; try { await fleet(); await overview(); await deployment(); } catch {} finally { polling = false; } }, 15000);
}));
$('logout').addEventListener('click', () => { key = ''; clearInterval(timer); location.reload(); });
$('refresh').addEventListener('click', guarded(refresh)); $('load-models').addEventListener('click', guarded(models));
$('check-release').addEventListener('click', guarded(checkRelease));
$('settings-form').addEventListener('submit', guarded(async () => {
  const data = scoped({ max_concurrency: Number($('max-concurrency').value), kimi_max_concurrency: Number($('kimi-concurrency').value), model_fallback: $('model-fallback').value });
  const r = await api('settings', data); notice(`${label(selected)}：并发 总 ${r.max_concurrency} · Kimi ${r.kimi_max_concurrency}；模型被替换时${r.model_fallback === 'forbid' ? '中断本轮' : '照常回复并记录'}。已立即生效。`); await overview();
}));
$('target').addEventListener('change', guarded(async () => {
  const [target, account] = $('target').value.split('|'); selected = { target, account };
  modelRows = []; $('models').replaceChildren(); $('family-card').hidden = true; $('model-summary').replaceChildren();
  await refresh(); notice(`已选择 ${label(selected)}，模型目录请重新加载。`);
}));
$('pause-account').addEventListener('click', guarded(async () => { if (!confirm(`暂停 ${label(selected)} 的调度？它会立即从 sub2 池子里摘出，直到手动恢复。`)) return; const r = await api('account/pause', scoped()); notice(r.paused ? '已暂停调度' : (r.managed ? '暂停请求未完全成功，请到 sub2 后台确认' : '该账号未接入 sub2，已标记为保持暂停'), !r.paused && r.managed); await refresh(); }));
$('resume-account').addEventListener('click', guarded(async () => { const r = await api('account/resume', scoped()); notice(r.note || '已恢复'); await refresh(); }));
for (const action of ['start', 'stop']) $(`${action}-account`).addEventListener('click', guarded(async () => { if (!confirm(`${action === 'stop' ? '停止' : '启动'} ${selected.target} 的容器？`)) return; await api(action); notice('操作完成。首次启动可能需要等待数轮健康检查。'); await refresh(); }));
for (const action of ['deploy', 'rollback']) $(action).addEventListener('click', guarded(async () => { if (!confirm(action === 'deploy' ? '升级所有受管且运行中的 bridge，并同步更新宿主机后台？切换时短暂停服。' : '将所有快照账号和宿主机后台恢复到上一次版本？')) return; const r = await api(action); notice(r.accepted ? '任务已接受，以下进度来自服务器实际状态。' : '未接受：任务正在运行或没有可用回退。', !r.accepted); await deployment(); }));
$('deploy-status').addEventListener('click', guarded(deployment));
$('new-account').addEventListener('click', () => { if (loginSession) { $('account-dialog').showModal(); return; } $('account-form').reset(); $('complete-box').hidden = true; $('begin-login').disabled = false; providerChanged(); $('account-dialog').showModal(); });
$('close-dialog').addEventListener('click', () => $('account-dialog').close());
function providerChanged() {
  const email = $('provider').value === 'email', hosted = $('hosted').checked;
  $('email-field').hidden = !email; $('email').required = email;
  $('port-field').hidden = hosted || !host; $('base-field').hidden = hosted || host;
  $('begin-login').textContent = email ? '发送验证码' : '生成 Google 授权链接';
}
$('provider').addEventListener('change', providerChanged); $('hosted').addEventListener('change', providerChanged); providerChanged();
$('account-form').addEventListener('submit', guarded(async () => {
  if (loginSession) throw Error('请先完成当前登录，或等待过期后刷新页面');
  const hosted = $('hosted').checked;
  const data = { profile: $('profile').value, account_name: $('account-name').value, provider: $('provider').value, email: $('email').value.trim(), hosted };
  if (!hosted) { data.port = Number($('port').value) || undefined; data.public_base_url = $('base-url').value; }
  if ($('group-id').value) data.group_id = Number($('group-id').value);
  const r = await api('login/start', data, 'main'); loginSession = { ...r, profile: data.profile, hosted }; $('complete-box').hidden = false;
  $('oauth-link').hidden = data.provider !== 'google';
  if (r.url) { const u = new URL(r.url); if (u.protocol !== 'https:') throw Error('授权地址不是 HTTPS'); $('oauth-link').href = r.url; }
  $('login-hint').textContent = data.provider === 'email' ? '验证码已发送。输错可重试，最多 5 次；不要重复发送。' : '在无痕窗口打开授权链接，完成后复制最终回调地址到下面。';
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
