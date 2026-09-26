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
