'use strict';
const $ = (id) => document.getElementById(id);
const host = document.body.dataset.mode === 'host';
let key = '', selected = 'main', loginSession = null, timer = null, polling = false, noticeTimer = null;
let bridgeVersion = null, modelRows = [];
const titles = { overview: '运行概览', accounts: '账号管理', models: '模型目录', release: '版本与升级' };
const FAMILIES = ['claude', 'gpt', 'deepseek', 'kimi'];
const FAMILY_NAMES = { claude: 'Claude', gpt: 'GPT', deepseek: 'DeepSeek', kimi: 'Kimi' };
const ACTIONS = { deploy: '升级', rollback: '回退', start: '启动账号', stop: '停止账号', attach: '启动并注册', model: '模型启停', 'models/family': '系列启停', settings: '并发设置', test: '模型测试', 'login/start': '发起登录', 'login/complete': '完成登录' };

function notice(text, error = false) {
  clearTimeout(noticeTimer);
  $('notice-text').textContent = text; $('notice').hidden = false; $('notice').classList.toggle('error', error);
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
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
async function api(operation, data = {}, target = selected) {
  const response = await fetch(host ? '/panel/api' : '/__panel/' + operation, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-key': key },
    body: JSON.stringify(host ? { operation, target, data } : data), signal: AbortSignal.timeout(operation === 'stop' ? 230000 : 60000) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || `HTTP ${response.status}`); return result;
}
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

async function overview() {
  const s = await api('summary'), runtime = await api('status');
  const sub = runtime.sub2api || {};
  bridgeVersion = runtime.version || null;
  stat('stat-version', runtime.version || '未知');
  $('current-version').textContent = runtime.version || '—';
  const scheduling = sub.schedulable || runtime.schedulable;
  const sched = { on: ['已入池', 'ok'], off: ['已暂停', 'warn'], unmanaged: ['未接管', ''], unknown: ['等待确认', 'warn'] }[scheduling] || ['等待确认', 'warn'];
  stat('stat-schedule', sched[0], sched[1]);
  $('reach').textContent = (sub.reachable ?? runtime.reachable) ? 'sub2 → bridge 可达' : '反向连接待确认';
  stat('stat-inflight', String(runtime.inflight ?? '—'));
  $('stat-inflight').querySelector('span').textContent = runtime.kimi_inflight ? `其中 Kimi ${runtime.kimi_inflight} 个` : `上限 ${s.max_concurrency ?? '—'}`;
  const up = runtime.uptime_sec;
  stat('stat-uptime', Number.isFinite(up) ? (up >= 86400 ? `${Math.floor(up / 86400)}天 ${Math.floor(up % 86400 / 3600)}时` : `${Math.floor(up / 3600)}h ${Math.floor(up % 3600 / 60)}m`) : '—');

  $('connection').replaceChildren();
  const codex = runtime.sub2api_codex || {};
  const codexText = codex.managed ? `${({ on: '已入池', off: '已暂停' })[codex.schedulable] || '等待确认'}${codex.reachable ? '' : ' · 反向连接待确认'}` : '未启用（见 CODEX.md）';
  for (const [name, value] of Object.entries({ '所选账号': selected, 'sub2 账号名': s.account_name, '配置分组': (s.group_ids || []).join(', ') || '未设置', '上游地址': s.public_base_url, '并发上限': `总 ${s.max_concurrency ?? '—'} · Kimi ${s.kimi_max_concurrency ?? '—'}`, 'Codex 账号': codexText, '模型被替换时': s.model_fallback === 'forbid' ? '中断本轮' : '照常回复并记录' })) $('connection').append(node('dt', name), node('dd', value));
  if (document.activeElement?.form !== $('settings-form')) {
    if (s.max_concurrency) $('max-concurrency').value = s.max_concurrency;
    if (s.kimi_max_concurrency) $('kimi-concurrency').value = s.kimi_max_concurrency;
    if (s.model_fallback) $('model-fallback').value = s.model_fallback;
  }

  const quota = runtime.quota || {};
  $('quota').replaceChildren();
  $('quota-time').textContent = quota.observed_at ? `采样于 ${relative(quota.observed_at)}${quota.stale ? ' · 已过期' : ''}` : '等待首次采样';
  if (!quota.available || quota.stale) $('quota').append(empty('当前额度未知或快照已过期，请勿把旧值当作实时余额。'));
  else if (quota.unmetered) $('quota').append(empty('上游标记为不计量'));
  if (quota.available && !quota.stale) for (const w of quota.windows || []) {
    const pct = w.remaining_percent, box = node('div', '', 'quota-window');
    box.dataset.level = pct == null ? '' : pct < 10 ? 'bad' : pct < 30 ? 'warn' : 'ok';
    const head = node('div', '', 'quota-head'); head.append(node('span', w.name));
    if (w.model_scoped) head.append(node('span', '模型专用', 'chip'));
    box.append(head, node('strong', pct == null ? '未知' : `剩余 ${pct}%`));
    if (pct != null) { const meter = node('div', '', 'meter'), fill = document.createElement('i'); fill.style.width = Math.max(0, Math.min(100, pct)) + '%'; meter.append(fill); box.append(meter); }
    const reset = node('p', w.reset_at ? `${relative(w.reset_at)}重置` : '重置时间未知', 'hint');
    if (w.reset_at) reset.title = new Date(w.reset_at).toLocaleString();
    box.append(reset); $('quota').append(box);
  }

  const c = runtime.counters || {};
  $('traffic').replaceChildren();
  for (const [label, value, tone] of [['总请求', c.total], ['成功', c.ok, 'ok'], ['失败', c.err, c.err ? 'bad' : ''], ['被拒绝', c.rejected, c.rejected ? 'warn' : ''], ['模型被替换', c.fallback, c.fallback ? 'warn' : '']]) {
    const m = node('div', '', 'metric'); if (tone) m.dataset.tone = tone;
    m.append(node('label', label), node('strong', value == null ? '—' : Number(value).toLocaleString())); $('traffic').append(m);
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
  if (host) {
    const targets = await api('targets'); $('target').replaceChildren(...targets.map((t) => { const o = node('option', t.name); o.value = t.name; return o; })); $('target').value = selected;
  }
  const rows = await api('profiles', {}, 'main'); $('profiles').replaceChildren();
  if (!rows.length) $('profiles').append(empty('还没有独立 profile。点击“新增账号”开始。'));
  const existing = new Set([...$('target').options].map((o) => o.value));
  for (const p of rows) {
    const row = node('div', '', 'profile-row'), label = node('div', '', 'profile-name');
    label.append(node('span', p.profile));
    const managed = existing.has(p.profile);
    label.append(p.configured ? pill(managed ? '已纳入管理' : '凭证已保存', managed ? 'ok' : 'info') : pill('配置未完成', 'warn'));
    row.append(label);
    if (host && p.configured && !managed) {
      const button = node('button', '启动并注册到 sub2', 'secondary small');
      button.addEventListener('click', guarded(async () => { await api('attach', { profile: p.profile }); notice('容器已启动，账号会自动注册。请切换账号检查调度状态。'); await profiles(); })); row.append(button);
    } else if (!host) row.append(node('span', '独立容器需在宿主机启动', 'hint'));
    $('profiles').append(row);
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
      const r = await api('models/family', { family, enabled: enable }); notice(`已${enable ? '启用' : '停用'} ${r.changed} 个 ${FAMILY_NAMES[family]} 模型，sub2 映射将在下一次健康检查同步。`); await models();
    }));
    box.append(text, button); $('families').append(box);
  }
  $('family-card').hidden = !$('families').children.length;
}
async function models() {
  modelRows = await api('models'); $('models').replaceChildren();
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
      test.addEventListener('click', guarded(async () => { if (!confirm(`测试 ${m.id} 会发送真实请求、消耗额度，是否继续？`)) return; const result = await api('test', { id: m.id }); notice(`${result.model}：${result.message} · HTTP ${result.status} · ${result.elapsed_ms ?? '?'} ms`, !result.ok); }));
      actions.append(test);
    }
    const toggle = node('button', m.enabled ? '停用' : '启用', m.enabled ? 'quiet small' : 'secondary small');
    toggle.addEventListener('click', guarded(async () => { await api('model', { id: m.id, enabled: !m.enabled }); notice('配置已保存，sub2 模型映射会在下一次健康检查同步。'); await models(); }));
    actions.append(toggle); tr.append(actions); $('models').append(tr);
  }
  const on = modelRows.filter((m) => m.enabled).length;
  $('model-summary').replaceChildren(pill(`已启用 ${on}`, 'ok'), pill(`共 ${modelRows.length}`));
  renderFamilies();
}

const phases = { idle: ['等待操作', ''], checking: ['检查发布', 'info'], pulling: ['拉取并验证镜像', 'info'], activating: ['重建容器并验证调度', 'info'], succeeded: ['升级成功', 'ok'], failed: ['准备失败，运行中的容器未改变', 'bad'], rolling_back: ['正在回退', 'warn'], rolled_back: ['已回退', 'warn'], rollback_failed: ['回退未完成，需要排查', 'bad'] };
async function deployment() {
  if (!host) return;
  const s = await api('deployment'), [label, tone] = phases[s.phase] || [s.phase, ''];
  const box = $('deploy-state'); box.replaceChildren(node('strong', label));
  if (tone) box.dataset.tone = tone; else delete box.dataset.tone;
  const details = [s.version ? `目标版本 ${s.version}` : '', s.updated_at ? `${relative(s.updated_at * 1000)}更新` : ''].filter(Boolean).join(' · ');
  if (details) box.append(node('span', details));
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
async function refresh() { await overview(); await profiles(); await deployment(); }

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
  timer = setInterval(async () => { if (!key || polling || document.hidden) return; polling = true; try { await overview(); await deployment(); } catch {} finally { polling = false; } }, 15000);
}));
$('logout').addEventListener('click', () => { key = ''; clearInterval(timer); location.reload(); });
$('refresh').addEventListener('click', guarded(refresh)); $('load-models').addEventListener('click', guarded(models));
$('check-release').addEventListener('click', guarded(checkRelease));
$('settings-form').addEventListener('submit', guarded(async () => {
  const data = { max_concurrency: Number($('max-concurrency').value), kimi_max_concurrency: Number($('kimi-concurrency').value), model_fallback: $('model-fallback').value };
  const r = await api('settings', data); notice(`${selected}：并发 总 ${r.max_concurrency} · Kimi ${r.kimi_max_concurrency}；模型被替换时${r.model_fallback === 'forbid' ? '中断本轮' : '照常回复并记录'}。已立即生效。`); await overview();
}));
$('target').addEventListener('change', guarded(async () => { selected = $('target').value; await overview(); notice(`已选择 ${selected}，模型目录请重新加载。`); modelRows = []; $('models').replaceChildren(); $('family-card').hidden = true; $('model-summary').replaceChildren(); }));
for (const action of ['start', 'stop']) $(`${action}-account`).addEventListener('click', guarded(async () => { if (!confirm(`${action === 'stop' ? '停止' : '启动'} ${selected}？`)) return; await api(action); notice('操作完成。首次启动可能需要等待数轮健康检查。'); }));
for (const action of ['deploy', 'rollback']) $(action).addEventListener('click', guarded(async () => { if (!confirm(action === 'deploy' ? '升级所有受管且运行中的 bridge？切换时短暂停服。' : '将所有快照账号恢复到上一次镜像？')) return; const r = await api(action); notice(r.accepted ? '任务已接受，以下进度来自服务器实际状态。' : '未接受：任务正在运行或没有可用回退。', !r.accepted); await deployment(); }));
$('deploy-status').addEventListener('click', guarded(deployment));
$('new-account').addEventListener('click', () => { if (loginSession) { $('account-dialog').showModal(); return; } $('account-form').reset(); $('complete-box').hidden = true; $('begin-login').disabled = false; providerChanged(); $('account-dialog').showModal(); });
$('close-dialog').addEventListener('click', () => $('account-dialog').close());
function providerChanged() { const email = $('provider').value === 'email'; $('email-field').hidden = !email; $('email').required = email; $('base-field').hidden = host; $('begin-login').textContent = email ? '发送验证码' : '生成 Google 授权链接'; }
$('provider').addEventListener('change', providerChanged); providerChanged();
$('account-form').addEventListener('submit', guarded(async () => {
  if (loginSession) throw Error('请先完成当前登录，或等待过期后刷新页面');
  const data = { profile: $('profile').value, account_name: $('account-name').value, provider: $('provider').value, email: $('email').value.trim(), port: Number($('port').value) || undefined, public_base_url: $('base-url').value };
  if ($('group-id').value) data.group_id = Number($('group-id').value);
  const r = await api('login/start', data, 'main'); loginSession = { ...r, profile: data.profile }; $('complete-box').hidden = false;
  $('oauth-link').hidden = data.provider !== 'google';
  if (r.url) { const u = new URL(r.url); if (u.protocol !== 'https:') throw Error('授权地址不是 HTTPS'); $('oauth-link').href = r.url; }
  $('login-hint').textContent = data.provider === 'email' ? '验证码已发送。输错可重试，最多 5 次；不要重复发送。' : '在无痕窗口打开授权链接，完成后复制最终回调地址到下面。';
  $('code').type = 'password'; $('code').value = ''; $('code').placeholder = data.provider === 'email' ? '邮箱验证码' : '完整回调 URL'; $('login-message').textContent = '';
}));
$('complete-form').addEventListener('submit', guarded(async () => {
  if (!loginSession) throw Error('请先发起登录');
  const data = { id: loginSession.id }; data[loginSession.provider === 'email' ? 'code' : 'callback'] = $('code').value.trim();
  const r = await api('login/complete', data, 'main'); $('code').value = ''; loginSession = null; $('complete-box').hidden = true; $('account-dialog').close();
  notice(`账号 ${r.profile} 已独立保存。${host ? '点击 profiles 列表中的“启动并注册到 sub2”。' : '请启动对应 profile 容器。'}`); await profiles();
}));
$('mode').textContent = host ? '宿主机管理' : '单 bridge 管理';
for (const id of ['start-account', 'stop-account', 'deploy', 'rollback', 'deploy-status', 'check-release']) $(id).disabled = !host;
$('release-note').textContent = host ? '升级失败会自动尝试回退。这里显示服务器的真实进度，操作记录不包含凭证。' : '当前为单 bridge 页面；完整的升级、回退和账号启动请使用宿主机后台（8790）。';
