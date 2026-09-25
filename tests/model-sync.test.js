'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('../mirasim-bridge');

test('stock sub2api catalog fetch must be followed by mapping save and exact readback', async (t) => {
  const original = { ...b.s2 };
  const cfg = b.deepMerge({}, b.DEFAULT_CONFIG);
  cfg.constraints.disabled_models = []; // protocol support remains configurable
  const ids = ['claude-haiku-4-5', 'gpt-5.6-luna', 'deepseek-v4-flash', 'kimi-k3'];
  let catalog, account, ignoreWrite, events;
  function reset() {
    catalog = { models: [...ids], warnings: [{ code: 'upstream_model_metadata_incomplete' }] };
    account = { id: 103, name: cfg.sub2api.account_name, platform: 'anthropic', type: 'apikey',
      credentials: { base_url: 'http://mirasim-bridge:8787', header_overrides: { 'x-test': 'keep' } } };
    ignoreWrite = false; events = [];
  }
  b.s2.syncModels = async () => { events.push('fetch'); return catalog; };
  b.s2.getAccount = async () => account;
  b.s2.updateAccount = async (_, id, patch) => {
    assert.equal(id, 103); assert.deepEqual(Object.keys(patch), ['credentials']);
    assert.equal(patch.credentials.base_url, 'http://mirasim-bridge:8787');
    assert.deepEqual(patch.credentials.header_overrides, { 'x-test': 'keep' });
    assert.equal(patch.credentials.api_key, undefined); // redacted field must not be overwritten
    events.push('save'); if (!ignoreWrite) account.credentials = patch.credentials;
  };
  b.s2.listModels = async () => {
    events.push('readback');
    return Object.keys(account.credentials.model_mapping || { 'claude-default': 'claude-default' }).map((id) => ({ id }));
  };
  const pause = async () => { events.push('pause'); return true; };
  try {
    await t.test('persists all four families despite nonempty platform defaults', async () => {
      reset();
      const result = await b.syncAccountModels(cfg, 103, { beforeWrite: pause });
      assert.deepEqual(result.models, [...ids].sort()); assert.equal(result.changed, true);
      assert.deepEqual(events, ['fetch', 'pause', 'save', 'readback']);
      assert.deepEqual(account.credentials.model_mapping, Object.fromEntries([...ids].sort().map((id) => [id, id])));
    });
    await t.test('no repeated writes or pauses for an unchanged exact mapping', async () => {
      reset(); account.credentials.model_mapping = Object.fromEntries(ids.map((id) => [id, id]));
      assert.equal((await b.syncAccountModels(cfg, 103, { beforeWrite: pause })).changed, false);
      assert.deepEqual(events, ['fetch', 'readback']);
    });
    await t.test('an ignored PUT cannot be hidden by a nonempty default model list', async () => {
      reset(); ignoreWrite = true;
      await assert.rejects(b.syncAccountModels(cfg, 103, { beforeWrite: pause }), /模型映射未成功保存/);
    });
    await t.test('even an identical platform default list cannot conceal an ignored mapping save', async () => {
      reset(); ignoreWrite = true; catalog.models = ['claude-default'];
      await assert.rejects(b.syncAccountModels(cfg, 103, { beforeWrite: pause }), /模型映射未成功保存/);
    });
    await t.test('empty or fully blocked catalog cannot resume or clear mapping', async () => {
      for (const models of [[], ['claude-fable-5']]) {
        reset(); catalog.models = models;
        await assert.rejects(b.syncAccountModels(cfg, 103), /没有允许的模型/);
        assert.deepEqual(events, ['fetch']);
      }
    });
    await t.test('pause failure prevents saving', async () => {
      reset();
      await assert.rejects(b.syncAccountModels(cfg, 103, { beforeWrite: async () => false }), /无法暂停/);
      assert.ok(!events.includes('save'));
    });
    await t.test('wrong account identity cannot be modified', async () => {
      reset(); account.name = 'another-account';
      await assert.rejects(b.syncAccountModels(cfg, 103, { beforeWrite: pause }), /受管账号不一致/);
      assert.ok(!events.includes('save'));
    });
    await t.test('retired models and aliases are replaced with current identities', async () => {
      reset(); account.credentials.model_mapping = { 'claude-retired': 'claude-retired', 'gpt-5.6-luna': 'claude-haiku-4-5' };
      await b.syncAccountModels(cfg, 103, { beforeWrite: pause });
      assert.equal(account.credentials.model_mapping['claude-retired'], undefined);
      assert.equal(account.credentials.model_mapping['gpt-5.6-luna'], 'gpt-5.6-luna');
    });
  } finally { Object.assign(b.s2, original); }
});
