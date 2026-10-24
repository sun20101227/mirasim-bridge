'use strict';
// Mirasim /v1/model-roster (roster 2026-10-24.v3): the relay's own description of
// what it can route. It answers 200 even while /v1/models is refused with
// credit_exhausted_shared, so it doubles as a liveness signal.
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const stringList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s && s.length <= 256) : []);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
// The official client only honours 0 < autoCompactRatio <= 1; anything else is noise.
const ratio = (v) => Number.isFinite(v) && v > 0 && v <= 1;
// Roster prices are camelCase. usage accounting wants snake_case, so it gets its own
// view instead of guessing at rename time.
const PRICING_KEYS = {
  input: 'input', output: 'output', cacheRead: 'cache_read',
  cacheWrite5m: 'cache_write_5m', cacheWrite1h: 'cache_write_1h',
};
// Desktop-client `xQ()`: `[1m]` selects a context window, it is not part of the id.
const bareId = (id) => String(id ?? '').replace(/\[1m\]$/i, '');

function pricingView(pricing) {
  const usd = {};
  for (const [from, to] of Object.entries(PRICING_KEYS)) if (Number.isFinite(pricing[from])) usd[to] = pricing[from];
  return Object.keys(usd).length ? usd : null;
}

function modelEntry(raw) {
  const entry = {};
  const effort = stringList(raw.effort);
  if (effort.length) entry.effort = effort;
  if (typeof raw.label === 'string' && raw.label) entry.label = raw.label.slice(0, 64);
  for (const key of ['contextWindow', 'maxOutput']) {
    if (positive(raw[key])) entry[key === 'contextWindow' ? 'context_window' : 'max_output'] = raw[key];
  }
  if (Number.isFinite(raw.quotaFactor)) entry.quota_factor = raw.quotaFactor;
  if (Array.isArray(raw.inputModalities)) entry.input_modalities = stringList(raw.inputModalities);
  if (isObject(raw.pricing)) {
    const pricing = {};
    for (const [k, v] of Object.entries(raw.pricing)) if (Number.isFinite(v)) pricing[k] = v;
    if (Object.keys(pricing).length) {
      entry.pricing = pricing;
      const usd = pricingView(pricing);
      if (usd) entry.pricing_usd = usd;
    }
  }
  return entry;
}

/** One agents[] row. The relay sends objects; older shapes sent bare id strings. */
function agentEntry(raw) {
  const source = isObject(raw) ? raw : {};
  const entry = { id: typeof raw === 'string' ? raw : source.id, ...modelEntry(source) };
  if (ratio(source.autoCompactRatio)) entry.auto_compact_ratio = source.autoCompactRatio;
  // Only a literal true counts: a string "true" would silently change the wire form.
  if (source.adaptive === true) entry.adaptive = true;
  if (source.default === true) entry.default = true;
  return entry;
}

/** Roster → a stable snapshot. Unknown fields are dropped, never trusted blindly. */
function summarizeRoster(raw, now = Date.now()) {
  if (!isObject(raw)) throw Error('Invalid Mirasim model roster');
  const agents = {};
  if (isObject(raw.agents)) {
    for (const [agent, rows] of Object.entries(raw.agents)) {
      if (!/^[a-z][a-z0-9]{0,15}$/.test(agent)) continue;
      const out = [], seen = new Set();
      for (const row of Array.isArray(rows) ? rows : []) {
        const entry = agentEntry(row);
        if (!isId(entry.id) || seen.has(entry.id)) continue;
        seen.add(entry.id); out.push(entry);
      }
      if (out.length) agents[agent] = out;
    }
  }
  const models = {};
  if (isObject(raw.models)) {
    for (const [id, row] of Object.entries(raw.models)) {
      if (!isId(id) || !isObject(row)) continue;
      models[id] = modelEntry(row);
    }
  }
  const served = [...new Set(stringList(raw.served))];
  if (!served.length && !Object.keys(agents).length && !Object.keys(models).length) throw Error('Mirasim model roster is empty');
  const cli = {};
  if (isObject(raw.cli)) {
    for (const [agent, row] of Object.entries(raw.cli)) {
      if (/^[a-z][a-z0-9]{0,15}$/.test(agent) && isObject(row) && typeof row.minVersion === 'string'
          && /^\d+(\.\d+){1,3}([-+][\w.-]{1,32})?$/.test(row.minVersion)) cli[agent] = row.minVersion;
    }
  }
  return {
    fetched_at: new Date(now).toISOString(),
    version: typeof raw.version === 'string' && raw.version.length <= 128 ? raw.version : null,
    cli_min_versions: cli,
    served,
    withdrawn: [...new Set(stringList(raw.withdrawn))],
    agents, models,
  };
}

/** The ids this roster can route: `served` plus every per-agent list (objects or strings). */
function rosterIds(roster) {
  const ids = new Set(roster?.served || []);
  for (const list of Object.values(roster?.agents || {})) {
    for (const entry of Array.isArray(list) ? list : []) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (isId(id)) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Everything the roster knows about one model: the `models[]` row merged under the
 * matching `agents[agent]` row (the agent row wins, it is the more specific one).
 * Pass `agent: null` to search every agent list. A bare id and its `[1m]` form are
 * the same row — the suffix only picks a context window.
 */
function modelInfo(roster, agent, id) {
  const bare = bareId(id);
  if (!bare) return null;
  let row = null;
  for (const list of agent ? [roster?.agents?.[agent]] : Object.values(roster?.agents || {})) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (bareId(typeof entry === 'string' ? entry : entry?.id) !== bare) continue;
      row = entry; break;
    }
    if (row) break;
  }
  const base = isObject(roster?.models?.[bare]) ? roster.models[bare] : null;
  if (!base && !row) return null;
  return { ...(base || {}), ...(isObject(row) ? row : {}), id: bare };
}

module.exports = { summarizeRoster, rosterIds, modelInfo, bareId };
