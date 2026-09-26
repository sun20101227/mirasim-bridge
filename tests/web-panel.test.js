'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function page(reply) {
  const elements = new Map();
  const make = () => ({ value: '', checked: false, textContent: '', hidden: false, dataset: {}, children: [], events: {}, classList: { toggle() {} },
    get firstChild() { return this.children[0]; },
    addEventListener(event, fn) { this.events[event] = fn; },
    close() { this.open = false; },
    setAttribute() {}, removeAttribute() {}, append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; } });
  const get = (id) => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); };
  const calls = [];
  const context = vm.createContext({ URL, AbortSignal, crypto, Event, setTimeout: () => 0, clearTimeout() {},
    document: { body: { dataset: { mode: 'host' } }, addEventListener() {}, getElementById: get, querySelectorAll: () => [], createElement: make, createTextNode: (text) => ({ textContent: text }) },
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      const body = await reply(request);
      return { ok: true, json: async () => body };
    } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8'), context);
  return { get, calls, run: (s) => vm.runInContext(s, context) };
}

function usageFixture(overrides = {}) {
  const total = { requests: 2, ok: 1, failed: 1, complete: 1, partial: 0, unknown: 1, priced: 0, estimated_usd: 0,
    input_tokens: 110, output_tokens: 20, cache_read_tokens: 10, cache_write_tokens: 0, reasoning_tokens: 0, elapsed_ms: 20, attempts: 2 };
  return { days: 7, model: '', timezone: 'UTC', generated_at: '2026-09-26T08:00:00Z', persistent: true,
    total, daily: [{ day: '2026-09-26', ...total }], models: [{ model: 'claude-test', protocol: 'messages', ...total }],
    recent: [], model_options: ['claude-test'], prices: { 'claude-test': { input: 3, output: 15, cache_read: 0.3, cache_write: null } }, ...overrides };
}
test('usage polling reads only local usage, keeps stable tables and unsaved prices', async () => {
  const p = page(() => usageFixture());
  p.run("view = 'usage'"); p.get('usage-days').value = '7';
  await p.run('refreshVisible()'); const row = p.get('usage-models').children[0];
  assert.equal(p.get('usage-cost').textContent, '未估算');
  assert.match(p.get('usage-success').textContent, /失败 1/);
  p.get('price-model').value = 'claude-test'; p.run('fillPrice()');
  assert.equal(p.get('price-input').value, 3);
  p.get('price-input').value = '99'; p.get('pricing-form').events.input();
  await p.run('refreshVisible()');
  assert.equal(p.get('price-input').value, '99'); assert.equal(p.get('usage-models').children[0], row);
  assert.deepEqual(p.calls.map(r => r.operation), ['usage', 'usage']);
});
test('late usage response is discarded after filter/account change; failed read exposes stale snapshot', async () => {
  let release, fail = false;
  const p = page(() => fail ? Promise.reject(Error('offline')) : new Promise(r => { release = r; }));
  p.get('usage-days').value = '7';
  const pending = p.run('usagePage()'); p.get('usage-days').value = '30'; release(usageFixture()); await pending;
  assert.equal(p.run('usageData'), null);
  const next = p.run('usagePage()'); p.run("selected.account = 'second'"); release(usageFixture()); await next;
  assert.equal(p.run('usageData'), null);
  const good = p.run('usagePage()'); release(usageFixture()); await good;
  fail = true; await assert.rejects(p.run('usagePage()'), /offline/);
  assert.match(p.get('usage-state').textContent, /保留上次快照/);
});
test('CSV export is local, leaves unknown costs blank and neutralizes spreadsheet formulas', async () => {
  const data = usageFixture(); data.models[0].model = '=DANGEROUS()';
  const p = page(() => data); await p.run('usagePage()');
  const csv = p.run('usageCsv()'); assert.match(csv, /'=DANGEROUS\(\)/);
  assert.match(csv, /,"0",""\r\n$/); assert.equal(p.calls.length, 1);
  p.run("selected.account = 'second'"); assert.throws(() => p.run('usageCsv()'), /当前账号/);
});
test('saving price is scoped to the selected account, null stays distinct from a free price', async () => {
  const p = page(({ operation }) => operation === 'usage' ? usageFixture() : { saved: true });
  p.run("selected.account = 'second'");
  p.get('price-model').value = 'claude-test'; p.get('price-input').value = '0'; p.get('price-output').value = '15';
  await p.get('pricing-form').events.submit({ preventDefault() {} });
  assert.equal(p.calls[0].operation, 'usage/pricing'); assert.equal(p.calls[0].data.account, 'second');
  assert.deepEqual(p.calls[0].data.rates, { input: 0, output: 15, cache_read: null, cache_write: null });
});

test('unknown running version never appears as latest; a later status failure clears the old value', async () => {
  const p = page(({ operation }) => {
    if (operation === 'release/check') return { latest: '0.8.3' };
    throw Error('unavailable');
  });
  await p.run('checkRelease()');
  assert.match(p.get('update-pill').textContent, /未知/);
  p.run("bridgeVersion = '0.8.3'");
  await p.run('checkRelease()');
  assert.equal(p.get('update-pill').textContent, '已是最新版本');
  await assert.rejects(p.run('overview()'), /unavailable/);
  await p.run('checkRelease()');
  assert.match(p.get('update-pill').textContent, /未知/);
});

test('manual release check bypasses cache and exposes pinned source instead of claiming latest', async () => {
  const p = page(() => ({ latest: '0.8.2', source: { kind: 'github_pinned', pinned_version: '0.8.2' }, checked_at: 1 }));
  p.run("bridgeVersion = '0.8.2'");
  await p.get('check-release').events.click({ preventDefault() {} });
  assert.equal(p.calls[0].data.force, true);
  assert.match(p.get('release-source').textContent, /固定在 0.8.2/);
  assert.equal(p.get('follow-latest').hidden, false);
  assert.ok(!p.get('update-pill').textContent.includes('已是最新版本'));
  p.run("bridgeVersion = '0.8.4'"); await p.run('checkRelease()');
  assert.match(p.get('update-pill').textContent, /高于发布源/);
});

test('failed update check clears previous version rather than leaving a false latest result', async () => {
  const p = page(() => { throw Error('network unavailable'); });
  p.get('latest-version').textContent = '0.8.2';
  await assert.rejects(p.run('checkRelease(true)'), /network/);
  assert.equal(p.get('latest-version').textContent, '—');
  assert.match(p.get('update-pill').textContent, /不能确认/);
});

for (const provider of ['google', 'github']) test(`browser shows ${provider} link and submits normalized independent profile`, async () => {
  const p = page(() => ({ id: 'login-id', provider, url: `https://auth.mirasim.ai/auth/oauth/${provider}/login?state=test` }));
  p.get('profile').value = provider === 'github' ? 'name@example.com' : '';
  p.get('provider').value = provider;
  p.get('account-name').value = 'new account';
  p.get('hosted').checked = true;
  p.get('group-select').value = '15';
  p.run('providerChanged()');
  assert.match(p.get('begin-login').textContent, new RegExp(provider === 'github' ? 'GitHub' : 'Google'));
  await p.get('account-form').events.submit({ preventDefault() {} });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].operation, 'login/start');
  assert.equal(p.calls[0].data.provider, provider);
  assert.match(p.calls[0].data.profile, /^[a-z][a-z0-9_-]{0,39}$/);
  assert.equal(p.get('oauth-link').hidden, false);
  assert.equal(new URL(p.get('oauth-link').href).pathname, `/auth/oauth/${provider}/login`);
  assert.match(p.get('login-hint').textContent, /127\.0\.0\.1/);
});

test('HTML offers Google and GitHub and disables unavailable email; profile validation does not preempt normalization', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  assert.match(html, /<option value="github">GitHub/);
  assert.match(html, /<option value="email" disabled>/);
  const field = html.match(/<input id="profile"[^>]*>/)[0];
  assert.ok(!field.includes('required') && !field.includes('pattern='));
});

test('accepted deployment is not labelled completed and detailed recovery failures stay visible', async () => {
  const p = page(({ operation }) => operation === 'deployment'
    ? { phase: 'rollback_failed', recovery_errors: [{ step: 'restore_health', code: 'bridge_unresponsive', target: 'main' }] }
    : [{ action: 'deploy', ok: true, at: 1, target: 'all' }]);
  await p.run('deployment()');
  const event = p.get('events').children[0];
  assert.equal(event.children.at(-1).textContent, '已接受任务');
  assert.match(p.get('deploy-state').children.at(-1).textContent, /main.*检查恢复后的服务.*桥接器未正常响应/);
});

test('account key is fetched only on demand and cleared when hidden or account changes', async () => {
  const p = page(() => ({ account: 'main', base_url: 'http://bridge:8787', api_key: 'only-this-account' }));
  assert.equal(p.calls.length, 0);
  await p.run('revealAccess()');
  assert.equal(p.calls[0].operation, 'account/access'); assert.equal(p.calls[0].data.reveal, true);
  assert.equal(p.get('access-key').value, 'only-this-account');
  p.run('hideAccess()');
  assert.equal(p.get('access-key').value, ''); assert.equal(p.get('access-info').hidden, true);
});

for (const stage of ['saved', 'validating']) test(`lost callback response is reconciled with login/status (${stage})`, async () => {
  const p = page(({ operation }) => {
    if (operation === 'login/complete') throw Error('connection lost');
    if (operation === 'login/status') return { stage, saved: stage === 'saved', profile: 'second' };
    if (operation === 'account/host') return { registered: true, account_name: 'mira-second' };
    throw Error('unexpected operation');
  });
  p.run("loginSession = { id: 'session-1', provider: 'github', hosted: true }; refresh = async () => {};");
  p.get('code').value = 'http://127.0.0.1/callback?state=mock';
  await p.get('complete-form').events.submit({ preventDefault() {} });
  assert.deepEqual(p.calls.slice(0, 2).map((c) => c.operation), ['login/complete', 'login/status']);
  if (stage === 'saved') {
    assert.equal(p.run('loginSession'), null); assert.equal(p.get('code').value, '');
    assert.equal(p.run('selected.account'), 'second');
    assert.match(p.get('notice-text').textContent, /回调已收到/);
  } else {
    assert.match(p.get('login-message').textContent, /回调已收到/);
    assert.equal(p.calls.length, 2);
  }
});

test('membership card displays expired, unknown and stale plan expiry without implying token expiry', () => {
  const p = page(() => ({}));
  p.run("renderMembership({available:true,plan:'plus',expires_at:'2020-01-01T00:00:00Z'})");
  assert.match(p.get('membership').children[0].textContent, /已到期/);
  p.run("renderMembership({available:true,plan:'basic',expires_at:null})");
  assert.match(p.get('membership').children[0].textContent, /未提供/);
  p.run("renderMembership({available:true,stale:true,plan:'plus',expires_at:'2099-01-01T00:00:00Z'})");
  assert.match(p.get('membership').children[0].textContent, /待查询/);
});

test('models keep existing nodes during polling and late responses cannot replace another account', async () => {
  let release, delayed = false;
  const a = [{ id: 'claude-a', family: 'claude', enabled: true }], b = [{ id: 'kimi-b', family: 'kimi', enabled: true }];
  const p = page(({ data }) => delayed && data.account === 'main' ? new Promise(r => { release = r; }) : data.account === 'main' ? a : b);
  await p.run('models()'); const old = p.get('models').children[0];
  await p.run('models()'); assert.equal(p.get('models').children[0], old, 'unchanged rows retain their DOM nodes');
  delayed = true; const pending = p.run('models()');
  assert.equal(p.get('models').children[0], old, 'no blank table while waiting');
  p.run("selected = { target: 'main', account: 'second' }"); await p.run('models()');
  const second = p.get('models').children[0];
  release(a); await pending;
  assert.equal(p.get('models').children[0], second); assert.equal(p.run('modelRows[0].id'), 'kimi-b');
});

test('model test updates its own result without refetching a catalog or other page sections', async () => {
  let finish;
  const p = page(({ operation }) => operation === 'models' ? [{ id: 'claude-a', family: 'claude', enabled: true }, { id: 'claude-b', family: 'claude', enabled: true }]
    : new Promise(r => { finish = r; }));
  await p.run('models()'); const other = p.get('models').children[1];
  const pending = p.run("runModelTest({target:'main',account:'main'}, 'claude-a')");
  assert.equal(p.get('models').children[1], other);
  finish({ ok: true, message: 'completed', status: 200, elapsed_ms: 10 }); await pending;
  assert.deepEqual(p.calls.map(c => c.operation), ['models', 'test']);
  assert.equal(p.get('models').children[1], other);
  assert.equal(p.run("testResults.get('main|main|claude-a').result.ok"), true);
});

test('keeper polling preserves unsaved form values after focus leaves, while history updates', async () => {
  let count = 0;
  const p = page(({ operation }) => operation === 'models' ? [{ id: 'claude-a', enabled: true }] : {
    enabled: true, model: 'claude-a', windows: ['5h','7d'], max_per_day: 6, reason: count ? 'confirmed' : 'checking',
    running: !count, sent_last_24h: count, attempts: [] });
  await p.run('keeperCard()');
  p.get('keeper-cap').value = '3'; p.get('keeper-form').events.input(); count = 1;
  await p.run('keeperCard()');
  assert.equal(p.get('keeper-cap').value, '3');
  assert.equal(p.get('keeper-status').children[0].textContent, '复查确认窗口已在计时');
  assert.equal(p.calls.filter(c => c.operation === 'models').length, 1);
  assert.ok(!p.calls.some(c => c.operation === 'window-keeper/check'), 'passive polling never triggers inference');
});

test('fast account polling reads only keeper and stored connection status', async () => {
  const p = page(({ operation }) => operation === 'window-keeper'
    ? { enabled: true, model: '', windows: ['5h'], max_per_day: 6, reason: 'checking', running: true, attempts: [] }
    : { running: false, result: null });
  p.run("view='accounts'; keeperModelsFor='main|main'; dirtyForms.set('keeper-form', 'main|main')");
  await p.run('refreshVisible({fast:true})');
  assert.deepEqual(p.calls.map(c => c.operation).sort(), ['account/check/status','window-keeper']);
});

test('normal polling is scoped to the visible view and deployment survives a failed runtime read', async () => {
  const p = page(({ operation }) => { if (operation === 'status') throw Error('bridge restarting'); return operation === 'events' ? [] : { phase: 'activating' }; });
  p.run("view='release'");
  await assert.rejects(p.run('refreshVisible()'), /restarting/);
  assert.ok(p.calls.some(c => c.operation === 'deployment'));
  assert.ok(!p.calls.some(c => ['summary','models','profiles','groups'].includes(c.operation)));
  assert.equal(p.get('deploy-state').children[0].textContent, '重建容器并验证服务');
});

test('connection result is coalesced and read-only status cannot replace a locally running check', async () => {
  let finish;
  const p = page(() => new Promise(r => { finish = r; }));
  const a = p.run("checkConnection('main', 'main')"), b = p.run("checkConnection('main', 'main')");
  await p.run('connectionStatus()');
  assert.equal(p.calls.length, 1);
  assert.match(p.get('connection-check').children[0].textContent, /自动更新/);
  finish({ ok: true, checked_at: new Date().toISOString(), bridge: {ok:true, elapsed_ms:1, message:'bridge'}, sub2api:{ok:true,message:'sub2'} });
  await Promise.all([a,b]); assert.equal(p.get('connection-check').children[0].textContent, '两段连接均通过');
});

test('slow keeper response cannot overwrite a newly selected account or its settings', async () => {
  let finish;
  const p = page(({ data }) => data.account === 'main' ? new Promise(r => { finish = r; })
    : { enabled: false, model: '', windows: ['7d'], max_per_day: 2, reason: 'disabled', attempts: [] });
  p.run("keeperModelsFor='main|main'");
  const pending = p.run('keeperCard()');
  p.run("selected={target:'main',account:'second'};keeperModelsFor='main|second'");
  await p.run('keeperCard()');
  finish({ enabled: true, model: '', windows: ['5h'], max_per_day: 8, reason: 'checking', running: true, attempts: [] });
  await pending;
  assert.equal(p.get('keeper-enabled').checked, false); assert.equal(p.get('keeper-cap').value, 2);
  assert.equal(p.get('keeper-status').children[0].textContent, '已关闭');
});

test('failed check stays local and does not leave the card stuck at checking', async () => {
  const p = page(() => { throw Error('temporary failure'); });
  await assert.rejects(p.run("checkConnection('main','main')"), /temporary/);
  assert.equal(p.get('connection-check').children[0].textContent, '检测暂未完成');
  assert.equal(p.run("connectionBusy.has('main|main')"), false);
});

test('group list can discover later additions without resetting the whole page cache', async () => {
  let count = 0;
  const p = page(() => [{ id: ++count, name: 'group', platform: 'anthropic' }]);
  await p.run('groups()'); await p.run('groups()'); assert.equal(p.calls.length, 1);
  p.run('groupsReadAt = Date.now() - 61000');
  await p.run('groups()'); assert.equal(p.calls.length, 2);
  assert.equal(p.run('groupsCache[0].id'), 2);
});

test('account filters use fresh global quota and do not treat missing data or model quota as exhausted', () => {
  const p=page(()=>({}));
  p.run(`fleetRows = [
    {target:'main',account:'first',summary:{account_name:'Work',group_ids:[15],membership:{available:true,plan:'plus',expires_at:new Date(Date.now()+86400000).toISOString()},quota:{available:true,windows:[{name:'5h',remaining_percent:8}]}}},
    {target:'main',account:'second',summary:{account_name:'Spare',hold:true,membership:{available:true,expires_at:null},quota:{available:true,windows:[{name:'7d_fable',model_scoped:true,remaining_percent:0},{name:'5h',remaining_percent:null}]}}},
    {target:'main',account:'third',error:'offline',summary:{membership:{available:true,expires_at:'2000-01-01'},quota:{available:true,windows:[{name:'5h',remaining_percent:0}]}}}
  ];`);
  assert.equal(p.run("filterAccounts(fleetRows,'work','all').length"),1);
  assert.equal(p.run("filterAccounts(fleetRows,'15','low_quota')[0].account"),'first');
  assert.equal(p.run("filterAccounts(fleetRows,'','low_quota').length"),1);
  assert.equal(p.run("filterAccounts(fleetRows,'','expired').length"),0,'old offline data is not a fresh expiry');
  assert.equal(p.run("filterAccounts(fleetRows,'','paused')[0].account"),'second');
  assert.equal(p.run("filterAccounts(fleetRows,'','expiring')[0].account"),'first');
  assert.equal(p.run("filterAccounts(fleetRows,'','all','expiry')[0].account"),'first');
});

test('model filters reuse fetched data and keep failure records scoped to the right account', async () => {
  const p=page(()=>[{id:'claude-a',family:'claude',enabled:true},{id:'kimi-b',family:'kimi',enabled:false}]);
  await p.run('models()');
  p.get('model-search').value='KIMI'; p.get('model-search').events.input();
  assert.equal(p.get('models').children.length,1);
  assert.equal(p.get('models').children[0].children[0].textContent,'kimi-b');
  p.get('model-search').value=''; p.get('model-filter').value='enabled'; p.get('model-filter').events.change();
  assert.equal(p.get('models').children[0].children[0].textContent,'claude-a');
  p.run("testResults.set('main|main|claude-a',{result:{ok:false}})");
  assert.equal(p.run("filterModels(modelRows,'','tested_failed','all').length"),1);
  assert.equal(p.run("filterModels(modelRows,'','tested_failed','all',{target:'main',account:'second'}).length"),0);
  assert.equal(p.calls.length,1,'filtering sends no catalog or inference request');
});

test('batch cancellation stops queued requests; retry selects only failed accounts', async () => {
  let finish;
  const p=page(()=>new Promise(r=>{finish=r;}));
  const work=p.run("runBatch([{target:'main',account:'first'},{target:'main',account:'second'}])");
  p.get('stop-checks').events.click();
  finish({ok:false,bridge:{ok:false},sub2api:{ok:false}}); await work;
  assert.equal(p.calls.length,1);
  assert.equal(p.run('batchCheck.items[0].state'),'failed');
  assert.equal(p.run('batchCheck.items[1].state'),'cancelled');
  const retry=p.get('retry-checks').events.click({preventDefault(){}});
  finish({ok:true,bridge:{ok:true},sub2api:{ok:true}});await retry;
  assert.equal(p.calls.length,2);
  assert.ok(p.calls.every(c=>c.data.account==='first'));
  assert.equal(p.run('batchCheck.items.length'),1);
  assert.equal(p.run('batchCheck.items[0].state'),'passed');
});

test('anonymous report uses an explicit field list and excludes credentials, labels, addresses and raw errors', () => {
  const p=page(()=>{throw Error('report must not make requests');});
  p.run(`bridgeVersion='0.8.6';fleetLoadedAt=new Date().toISOString();fleetRows=[{target:'private-host',account:'private-profile',error:'Bearer private-error',version:'0.8.6',summary:{account_name:'private@example.com',bridge_secret:'private-key',admin_api_key:'private-admin',public_base_url:'https://private-host',membership:{available:true,plan:'private-plan',account_ref:'private-hash',expires_at:'2099-01-01',observed_at:new Date().toISOString()},quota:{available:true,windows:[{name:'5h',remaining_percent:25},{name:'private-window',remaining_percent:10}]},counters:{total:3,secret:'private-counter'},sub2api:{schedulable:'on',reachable:true}}}];
    connectionResults.set('private-host|private-profile',{checked_at:new Date().toISOString(),bridge:{ok:false,status:503,message:'private-message'},sub2api:{ok:'private-value'}});`);
  const report=JSON.parse(p.run('JSON.stringify(diagnosticReport())'));
  assert.equal(report.accounts[0].ref,'account-1');
  assert.equal(report.accounts[0].connection.sub2_ok,null);
  assert.equal(report.accounts[0].quota.windows.length,1);
  assert.ok(!JSON.stringify(report).includes('private-'));
  assert.ok(!JSON.stringify(report).includes('@example.com'));
  assert.equal(p.calls.length,0);
});
