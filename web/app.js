'use strict';
const $ = (id) => document.getElementById(id);
const host = document.body.dataset.mode === 'host';
let key = '', selected = 'main', loginSession = null, timer = null, polling = false;
const titles = { overview: '运行概览', accounts: '账号管理', models: '模型目录', release: '版本与升级' };
function notice(text, error = false) { $('notice').textContent = text; $('notice').hidden = false; $('notice').classList.toggle('error', error); }
function node(tag, text, cls) { const n = document.createElement(tag); n.textContent = text ?? ''; if (cls) n.className = cls; return n; }
async function api(operation, data = {}, target = selected) {
  const response = await fetch(host ? '/panel/api' : '/__panel/' + operation, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-key': key },
    body: JSON.stringify(host ? { operation, target, data } : data), signal: AbortSignal.timeout(operation === 'stop' ? 230000 : 60000) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || `HTTP ${response.status}`); return result;
}
function guarded(fn) { return async (event) => { event?.preventDefault(); const btn = event?.submitter || (event?.currentTarget?.tagName === 'BUTTON' ? event.currentTarget : null); if (btn) btn.disabled = true; try { await fn(event); } catch (e) { notice(e.message, true); if ($('account-dialog').open) $('login-message').textContent = e.message; } finally { if (btn) btn.disabled = false; } }; }
async function overview() {
  const s = await api('summary'), runtime = await api('status');
  const sub = runtime.sub2api || {};
  $('version').textContent = runtime.version || '未知';
  const scheduling = sub.schedulable || runtime.schedulable;
  $('schedule').textContent = ({ on: '已入池', off: '已暂停', unmanaged: '未接管', unknown: '等待确认' })[scheduling] || '等待确认';
  $('reach').textContent = (sub.reachable ?? runtime.reachable) ? 'sub2 → bridge 可达' : '反向连接待确认';
  $('inflight').textContent = runtime.inflight ?? '—';
  $('uptime').textContent = Number.isFinite(runtime.uptime_sec) ? `${Math.floor(runtime.uptime_sec / 3600)}h ${Math.floor(runtime.uptime_sec % 3600 / 60)}m` : '—';
  $('connection').replaceChildren();
  for (const [name, value] of Object.entries({ '所选账号': selected, 'sub2 账号名': s.account_name, '配置分组': (s.group_ids || []).join(', '), '上游地址': s.public_base_url, '最大并发': s.max_concurrency })) $('connection').append(node('dt', name), node('dd', value));
  $('quota').replaceChildren(); const quota = runtime.quota || {};
  $('quota-time').textContent = quota.observed_at ? `采样 ${new Date(quota.observed_at).toLocaleString()}${quota.stale ? ' · 已过期' : ''}` : '等待首次采样';
  if (!quota.available || quota.stale) $('quota').append(node('p', '当前额度未知或快照过期，请勿将旧值当作实时余额。'));
  else if (quota.unmetered) $('quota').append(node('p', '上游标记为不计量'));
  if (quota.available && !quota.stale) for (const w of quota.windows || []) {
    const box = node('div', '', 'quota-window'); box.append(node('span', w.name + (w.model_scoped ? ' · 模型专用' : '')));
    box.append(node('strong', w.remaining_percent == null ? '未知' : `${w.remaining_percent}%`));
    if (w.remaining_percent != null) { const bar = document.createElement('progress'); bar.max = 100; bar.value = w.remaining_percent; box.append(bar); }
    box.append(node('p', w.reset_at ? `重置 ${new Date(w.reset_at).toLocaleString()}` : '重置时间未知', 'hint')); $('quota').append(box);
  }
}
async function profiles() {
  if (host) {
    const targets = await api('targets'); $('target').replaceChildren(...targets.map((t) => { const o = node('option', t.name); o.value = t.name; return o; })); $('target').value = selected;
  }
  const rows = await api('profiles', {}, 'main'); $('profiles').replaceChildren();
  if (!rows.length) $('profiles').append(node('p', '还没有独立 profile。点击“新增账号”开始。'));
  const existing = new Set([...$('target').options].map((o) => o.value));
  for (const p of rows) {
    const row = node('div', '', 'profile-row'), label = node('div', p.profile);
    label.append(node('span', p.configured ? '凭证与配置已保存' : '配置未完成')); row.append(label);
    if (host && p.configured && !existing.has(p.profile)) {
      const button = node('button', '启动并注册到 sub2', 'secondary');
      button.addEventListener('click', guarded(async () => { await api('attach', { profile: p.profile }); notice('容器已启动，账号会自动注册。请切换账号检查调度状态。'); await profiles(); })); row.append(button);
    } else row.append(node('span', host ? '已纳入管理' : '独立容器需在宿主机启动', 'hint'));
    $('profiles').append(row);
  }
}
async function models() {
  const rows = await api('models'); $('models').replaceChildren();
  for (const m of rows) {
    const tr = document.createElement('tr'); for (const value of [m.id, m.family, m.enabled ? '已启用' : '已停用', m.note]) tr.append(node('td', value));
    const actions = document.createElement('td'), toggle = node('button', m.enabled ? '停用' : '启用', 'secondary');
    toggle.addEventListener('click', guarded(async () => { await api('model', { id: m.id, enabled: !m.enabled }); notice('配置已保存，sub2 模型映射会在下一次健康检查同步。'); await models(); })); actions.append(toggle);
    if (m.enabled) { const test = node('button', '测试', 'secondary'); test.addEventListener('click', guarded(async () => { if (!confirm(`测试 ${m.id} 会发送真实请求、消耗额度，是否继续？`)) return; const result = await api('test', { id: m.id }); notice(`${result.model}: ${result.message} · HTTP ${result.status} · ${result.elapsed_ms ?? '?'} ms`, !result.ok); })); actions.append(test); }
    tr.append(actions); $('models').append(tr);
  }
}
const phases = { idle: '等待操作', checking: '检查发布', pulling: '拉取并验证镜像', activating: '重建容器并验证调度', succeeded: '升级成功', failed: '准备失败，运行容器未改变', rolling_back: '正在回退', rolled_back: '已回退', rollback_failed: '回退未完成，需要排查' };
async function deployment() {
  if (!host) return;
  const s = await api('deployment'); $('deploy-state').textContent = `${phases[s.phase] || s.phase}\n版本：${s.version || '—'}\n${s.error || ''}`;
  $('events').replaceChildren(...(await api('events')).slice().reverse().map((e) => node('div', `${new Date(e.at * 1000).toLocaleString()} · ${e.action} · ${e.target} · ${e.ok ? '完成/已接受' : '失败'}`, 'event')));
}
async function refresh() { await overview(); await profiles(); await deployment(); }
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  const view = button.dataset.view; $('page-title').textContent = titles[view];
  for (const el of document.querySelectorAll('[data-section]')) el.hidden = el.dataset.section !== view;
  for (const el of document.querySelectorAll('[data-view]')) el.classList.toggle('selected', el === button);
});
$('login-form').addEventListener('submit', guarded(async () => {
  key = $('key').value.trim(); if (!/^[a-f0-9]{64}$/.test(key)) throw Error('请输入有效的 64 位管理密钥');
  if (host) await api('targets'); else await api('summary');
  $('key').value = ''; $('login-box').hidden = true; $('workspace').hidden = false; notice('已连接后台');
  await refresh();
  clearInterval(timer); if (host) timer = setInterval(async () => { if (!key || polling) return; polling = true; try { await deployment(); } catch {} finally { polling = false; } }, 10000);
}));
$('logout').addEventListener('click', () => { key = ''; clearInterval(timer); location.reload(); });
$('refresh').addEventListener('click', guarded(refresh)); $('load-models').addEventListener('click', guarded(models));
$('target').addEventListener('change', guarded(async () => { selected = $('target').value; await overview(); notice(`已选择 ${selected}，模型目录请重新加载。`); $('models').replaceChildren(); }));
for (const action of ['start', 'stop']) $(`${action}-account`).addEventListener('click', guarded(async () => { if (!confirm(`${action === 'stop' ? '停止' : '启动'} ${selected}？`)) return; await api(action); notice('操作完成。首次启动可能需要等待数轮健康检查。'); }));
for (const action of ['deploy', 'rollback']) $(action).addEventListener('click', guarded(async () => { if (!confirm(action === 'deploy' ? '升级所有受管且运行中的 bridge？切换时短暂停服。' : '将所有快照账号恢复到上一次镜像？')) return; const r = await api(action); notice(r.accepted ? '任务已接受，以下进度来自服务器实际状态。' : '未接受：任务正在运行或没有可用回退。', !r.accepted); await deployment(); }));
$('deploy-status').addEventListener('click', guarded(deployment));
$('new-account').addEventListener('click', () => { if (loginSession) { $('account-dialog').showModal(); return; } $('account-form').reset(); $('complete-box').hidden = true; $('begin-login').disabled = false; providerChanged(); $('account-dialog').showModal(); });
$('close-dialog').addEventListener('click', () => $('account-dialog').close());
function providerChanged() { const email = $('provider').value === 'email'; $('email-field').hidden = !email; $('email').required = email; $('base-field').hidden = host; $('begin-login').textContent = email ? '发送验证码' : '生成 Google 授权链接'; }
$('provider').addEventListener('change', providerChanged); providerChanged();
$('account-form').addEventListener('submit', guarded(async () => {
  if (loginSession) throw Error('请先完成当前登录，或等待过期后刷新页面');
  const data = { profile: $('profile').value, account_name: $('account-name').value, group_id: Number($('group-id').value), provider: $('provider').value, email: $('email').value.trim(), port: Number($('port').value), public_base_url: $('base-url').value };
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
for (const id of ['start-account', 'stop-account', 'deploy', 'rollback', 'deploy-status']) $(id).disabled = !host;
$('release-note').textContent = host ? '升级失败自动尝试回退。这里显示服务器真实进度；操作记录不包含凭证。' : '当前为单 bridge 页面；完整升级、回退、账号启动请使用宿主机后台（8790）。';
