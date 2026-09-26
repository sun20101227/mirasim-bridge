'use strict';
// Optional Codex (openai platform) account: separate name, platform, GPT-only mapping, separate state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const b = require('../mirasim-bridge');

test('managed accounts: Codex account needs explicit opt-in and the relay backend', () => {
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  assert.deepEqual(b.managedAccounts(cfg).map((a) => a.key), ['main']);
  cfg.sub2api.openai_account = { enabled: true, account_name: '', group_ids: [20] };
  cfg.backend = 'session';
  assert.deepEqual(b.managedAccounts(cfg).map((a) => a.key), ['main'], 'Responses needs relay');
  cfg.backend = 'relay';
  const codex = b.managedAccounts(cfg)[1];
  assert.deepEqual([codex.name, codex.platform, codex.family, codex.groupIds], ['mirasim-cloud-codex', 'openai', 'gpt-', [20]]);
  b.validateConfig(cfg);
  cfg.sub2api.openai_account.account_name = cfg.sub2api.account_name;
  assert.throws(() => b.validateConfig(cfg), /不能与主账号相同/);
  cfg.sub2api.openai_account = { enabled: true, account_name: 'x', group_ids: ['20'] };
  assert.throws(() => b.validateConfig(cfg), /openai_account/);
});

test('Codex account registers as openai, maps GPT models only, and keeps main state intact', async () => {
  const original = { ...b.s2 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-'));
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  Object.assign(cfg, { _config_path: path.join(dir, 'config.json'), backend: 'relay', bridge_secret: 'test-only' });
  cfg.sub2api.base_url = 'https://sub2.example'; cfg.sub2api.group_ids = [15];
  cfg.sub2api.openai_account = { enabled: true, account_name: 'mira-codex', group_ids: [20] };
  cfg.constraints.disabled_models = [];
  const codex = b.managedAccounts(cfg).find((a) => a.key === 'codex');
  let created, stored = { id: 77, name: 'mira-codex', platform: 'openai', type: 'apikey', credentials: {} }, searched;
  try {
    b.s2.findAccountByName = async (_, name, platform) => { searched = [name, platform]; return null; };
    b.s2.createAccount = async (_, body) => { created = body; return { id: 77 }; };
    b.s2.setSchedulable = async () => {};
    b.s2.updateAccount = async (_, id, patch) => { if (patch.credentials) stored = { ...stored, credentials: patch.credentials }; };
    b.s2.getAccount = async () => stored;
    b.s2.syncModels = async () => ({ models: ['claude-opus-5', 'gpt-6-astra', 'gpt-6-sol', 'kimi-k3'].map((id) => ({ id })) });
    b.s2.listModels = async () => Object.keys(stored.credentials.model_mapping || {}).map((id) => ({ id }));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ account_id: 103, account_name: 'mirasim-cloud' }));
    const result = await b.cmdRegister(cfg, { flags: {} }, codex);
    assert.deepEqual(searched, ['mira-codex', 'openai']);
    assert.equal(created.platform, 'openai'); assert.equal(created.name, 'mira-codex');
    assert.deepEqual(Object.keys(stored.credentials.model_mapping), ['gpt-6-astra', 'gpt-6-sol']);
    assert.deepEqual(result, { id: 77, reachable: true });
    const state = b.loadState(cfg);
    assert.equal(state.account_id, 103, 'main account record untouched');
    assert.equal(state.codex.account_id, 77);
    // A same-named anthropic account must never be mistaken for the Codex account.
    stored = { ...stored, platform: 'anthropic' };
    await assert.rejects(b.syncAccountModels(cfg, 77, { account: codex }), /不一致/);
  } finally {
    Object.assign(b.s2, original);
    assert.ok(path.basename(dir).startsWith('bridge-codex-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
