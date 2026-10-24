'use strict';
// Latest-Mirasim compatibility: ultra effort rung, roster parsing, quota refusal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeResponses } = require('../lib/responses');
const { summarizeRoster, rosterIds } = require('../lib/roster');
const bridge = require('../mirasim-bridge');

const rosterFile = path.join(__dirname, '..', 'private', 'latest-probe', 'roster.json');
const live = fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile, 'utf8')) : null;

test('ultra is passed through as a real effort rung, not downgraded to max', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const out = normalizeResponses({ model: 'gpt-6-astra', input: 'hi', reasoning: { effort } });
    assert.equal(out.body.reasoning.effort, effort, `${effort} must survive normalization unchanged`);
  }
  // Unsupported rungs still fail loudly instead of being silently rewritten.
  // `off` is a real roster rung (deepseek/dsh), so it must now pass through.
  for (const effort of ['ultracode', 'ULTRА', 'super']) {
    assert.throws(() => normalizeResponses({ model: 'gpt-6-astra', input: 'hi', reasoning: { effort } }), /reasoning\.effort/);
  }
  const off = normalizeResponses({ model: 'gpt-6-astra', input: 'hi', reasoning: { effort: 'off' } });
  assert.equal(off.body.reasoning.effort, 'off', 'the deepseek `off` rung is a real roster value and must not be rejected by the shared validator');
  // An explicit ultra must not be replaced by the account default.
  const explicit = normalizeResponses({ model: 'gpt-6-astra', input: 'hi', reasoning: { effort: 'ultra' } }, { defaultEffort: 'high' });
  assert.equal(explicit.body.reasoning.effort, 'ultra');
  // The default itself may be ultra.
  const byDefault = normalizeResponses({ model: 'gpt-6-astra', input: 'hi' }, { defaultEffort: 'ultra' });
  assert.equal(byDefault.body.reasoning.effort, 'ultra');
});

test('gpt_default_effort accepts ultra in config validation and panel settings', async () => {
  for (const effort of ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const cfg = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
    cfg.constraints.gpt_default_effort = effort;
    assert.doesNotThrow(() => bridge.validateConfig(cfg), `gpt_default_effort=${effort}`);
  }
  const bad = bridge.deepMerge({}, bridge.DEFAULT_CONFIG);
  bad.constraints.gpt_default_effort = 'ultracode';
  assert.throws(() => bridge.validateConfig(bad), /gpt_default_effort/);
});

test('quota refusals are classified from machine fields, not the prose body', () => {
  const headers = {
    'retry-after': '3600', 'x-mirasim-error': 'mirasim-router:quota_exhausted',
    'x-router-failure': 'quota; scope=account', 'x-should-retry': 'false',
  };
  const body = JSON.stringify({ error: { message: '平台的共享额度已用尽，请在设置里接入你自己的 Claude / Codex 账号继续。', type: 'credit_exhausted_shared' } });
  const failure = bridge.classifyUpstreamFailure(429, headers, body);
  assert.equal(failure.kind, 'quota'); assert.equal(failure.detail, 'credit_exhausted_shared');
  assert.equal(failure.retry_after_sec, 3600); assert.equal(failure.should_retry, false);
  assert.equal(failure.scope, 'quota; scope=account'); assert.equal(failure.error_code, 'mirasim-router:quota_exhausted');

  assert.equal(bridge.classifyUpstreamFailure(429, { 'retry-after': '30' }, '{"error":{"type":"rate_limited"}}').kind, 'rate_limit');
  assert.equal(bridge.classifyUpstreamFailure(429, {}, '{"error":{"type":"shared_quota_unavailable"}}').detail, 'shared_quota_unavailable');
  assert.equal(bridge.classifyUpstreamFailure(401, {}, '').kind, 'auth');
  assert.equal(bridge.classifyUpstreamFailure(503, {}, '').kind, 'server');
  // An HTTP-date Retry-After is converted to seconds left, never NaN.
  const dated = bridge.classifyUpstreamFailure(429, { 'retry-after': new Date(Date.now() + 120000).toUTCString() }, '');
  assert.ok(dated.retry_after_sec > 100 && dated.retry_after_sec <= 120);
});

test('summarizeModelResponse names quota exhaustion instead of "upstream unavailable"', () => {
  const body = JSON.stringify({ error: { message: 'shared quota used up', type: 'credit_exhausted_shared' } });
  const out = bridge.summarizeModelResponse({ status: 429, raw: body, headers: { 'retry-after': '3600' }, elapsed_ms: 5 });
  assert.equal(out.ok, false); assert.equal(out.failure.kind, 'quota');
  assert.match(out.error, /共享额度已用尽/);
  const plain = bridge.summarizeModelResponse({ status: 503, raw: '{"error":{"message":"boom"}}' });
  assert.equal(plain.failure, undefined); assert.equal(plain.error, 'boom');
});

test('roster parses served/withdrawn/agents/models/cli from the 2026-10-24 shape', () => {
  const raw = {
    version: '2026-10-24.v3+qaad272ef+sc5edcdfa',
    cli: { codex: { minVersion: '0.159.3' }, claude: { minVersion: '2.1.293' }, bogus: { minVersion: 'not a version' } },
    agents: { claude: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }], codex: [{ id: 'gpt-6-astra' }] },
    served: ['claude-opus-5-5', 'gpt-6-astra'],
    withdrawn: ['claude-sonnet-5', 'claude-opus-4-8'],
    models: {
      'gpt-6-astra': { effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 0, cacheWrite1h: 0 }, quotaFactor: 0.1 },
      'gpt-6-luna': { effort: ['low', 'medium', 'high', 'xhigh', 'max'], pricing: { input: 0.1 } },
      'claude-opus-5-5': { pricing: { input: 4, output: 20 } },
      'kimi-k3': { effort: ['low', 'high', 'max'], contextWindow: 1048576, maxOutput: 128000, inputModalities: ['text', 'image'] },
    },
  };
  const roster = summarizeRoster(raw, Date.parse('2026-10-24T10:00:00Z'));
  assert.equal(roster.version, '2026-10-24.v3+qaad272ef+sc5edcdfa');
  assert.deepEqual(roster.cli_min_versions, { codex: '0.159.3', claude: '2.1.293' });
  assert.deepEqual(roster.withdrawn, ['claude-sonnet-5', 'claude-opus-4-8']);
  // Agent rows keep their per-model metadata (effort, context, adaptive, default),
  // not just the id — the relay publishes much more than a name list here.
  assert.deepEqual(roster.agents.codex.map((m) => m.id), ['gpt-6-astra']);
  assert.equal(roster.agents.claude[0].id, 'claude-opus-5-5');
  assert.deepEqual(roster.models['gpt-6-astra'].effort.slice(-1), ['ultra']);
  assert.equal(roster.models['gpt-6-astra'].quota_factor, 0.1);
  assert.deepEqual(roster.models['kimi-k3'].input_modalities, ['text', 'image']);
  assert.equal(roster.models['kimi-k3'].context_window, 1048576);
  // gpt-6-luna stops at max: no ultra rung to advertise.
  assert.ok(!roster.models['gpt-6-luna'].effort.includes('ultra'));
  // served ∪ agents is the routable set; withdrawn ids are never added.
  const ids = rosterIds(roster);
  assert.ok(ids.includes('gpt-6-astra') && ids.includes('claude-sonnet-5-5'));
  assert.ok(!ids.includes('claude-opus-4-8'));
  assert.throws(() => summarizeRoster(null), /Invalid/);
  assert.throws(() => summarizeRoster({ unrelated: true }), /empty/);
});

test('live roster snapshot (when present) exposes ultra only where the relay does', { skip: !live }, () => {
  const roster = summarizeRoster(live);
  const ultra = Object.entries(roster.models).filter(([, m]) => m.effort?.includes('ultra')).map(([id]) => id).sort();
  assert.deepEqual(ultra, ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6.1-sol']);
  assert.ok(!roster.models['gpt-6-luna'].effort.includes('ultra'), 'gpt-6-luna stops at max');
  assert.deepEqual(roster.withdrawn.sort(), ['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5']);
  assert.equal(roster.served.length, 24);
  assert.ok(rosterIds(roster).includes('gpt-6-astra'));
  assert.equal(roster.cli_min_versions.codex, '0.159.3');
});
