'use strict';
// Passive accounting. Never retain prompts, completions, headers or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const DAY = 86400000, RETENTION = 30, MAX_BYTES = 8 * 1024 * 1024;
const TOKENS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'];
const RATES = ['input', 'output', 'cache_read', 'cache_write'];
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const modelId = v => typeof v === 'string' && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v) ? v : '';
const dayOf = at => new Date(at).toISOString().slice(0, 10);
const publicError = message => Object.assign(Error(message), { publicMessage: message });

class UsageObservation {
  constructor(protocol) { this.protocol = protocol; this.raw = {}; this.served = null; this.terminal = false; this.finalUsage = false; }
  accept(e, type = e?.type) {
    if (!e || typeof e !== 'object') return;
    const response = e.message || e.response || e;
    if (modelId(response.model)) this.served = modelId(response.model);
    const usage = response.usage || e.usage;
    if (usage && ['message_delta', 'response.completed', 'response.incomplete'].includes(type) && integer(usage.output_tokens) !== null) this.finalUsage = true;
    if (usage && typeof usage === 'object') {
      // Streaming usage is cumulative: later values replace earlier snapshots.
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (Object.hasOwn(usage, k)) this.raw[k] = integer(usage[k]);
      }
      for (const [source, key] of [['input_tokens_details', 'cached_tokens'], ['output_tokens_details', 'reasoning_tokens']]) {
        if (usage[source] && Object.hasOwn(usage[source], key)) this.raw[key] = integer(usage[source][key]);
      }
    }
    if (['message_stop', 'response.completed', 'response.incomplete'].includes(type)
        || !type && usage && ['message', 'response', 'response.compaction'].includes(e.object || e.type)) this.terminal = true;
  }
  json(value) { this.accept(value); this.terminal = Boolean(value?.usage) && !value.error && value.status !== 'failed'; this.finalUsage = this.terminal; }
  snapshot() {
    const r = this.raw, messages = this.protocol === 'messages';
    const read = r[messages ? 'cache_read_input_tokens' : 'cached_tokens'] ?? 0;
    const write = messages ? r.cache_creation_input_tokens ?? 0 : 0;
    const input = integer(r.input_tokens), output = integer(r.output_tokens);
    const totalInput = input === null ? null : integer(input + (messages ? read + write : 0));
    const consistent = totalInput !== null && read + write <= totalInput && (r.reasoning_tokens ?? 0) <= (output ?? Infinity);
    const invalid = Object.values(r).some(v => v === null);
    return { input_tokens: totalInput, output_tokens: output, cache_read_tokens: read, cache_write_tokens: write,
      reasoning_tokens: r.reasoning_tokens ?? null,
      usage_state: !Object.keys(r).length ? 'unknown' : this.terminal && this.finalUsage && output !== null && consistent && !invalid ? 'complete' : 'partial' };
  }
}
function estimate(row, rates) {
  if (!rates || row.usage_state !== 'complete') return null;
  const counts = [row.input_tokens - row.cache_read_tokens - row.cache_write_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens];
  let cost = 0;
  for (let i = 0; i < counts.length; i++) {
    const rate = rates[RATES[i]];
    if (counts[i] > 0 && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return null;
    cost += counts[i] * (rate || 0) / 1000000;
  }
  return Number.isFinite(cost) ? cost : null;
}
function blank() {
  return { requests: 0, ok: 0, failed: 0, complete: 0, partial: 0, unknown: 0, priced: 0, estimated_usd: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, elapsed_ms: 0, attempts: 0 };
}
function add(total, row) {
  total.requests++; total[row.ok ? 'ok' : 'failed']++; total[row.usage_state]++;
  for (const k of TOKENS) total[k] += row[k] || 0;
  total.elapsed_ms += row.elapsed_ms; total.attempts += row.attempts;
  if (row.estimated_usd !== null) { total.priced++; total.estimated_usd += row.estimated_usd; }
}
function merge(total, other) { for (const key of Object.keys(blank())) total[key] += other[key]; }
function validRow(row, day) {
  return row?.schema === 1 && dayOf(row.at) === day && modelId(row.model) && (!row.served_model || modelId(row.served_model))
    && ['messages', 'responses', 'compact'].includes(row.protocol) && typeof row.ok === 'boolean'
    && ['complete', 'partial', 'unknown'].includes(row.usage_state) && TOKENS.every(k => row[k] === null || integer(row[k]) !== null)
    && integer(row.elapsed_ms) !== null && integer(row.attempts) !== null
    && (row.estimated_usd === null || typeof row.estimated_usd === 'number' && Number.isFinite(row.estimated_usd) && row.estimated_usd >= 0);
}

class UsageStore {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = directory; this.now = now; this.queue = Promise.resolve(); this.cache = new Map();
    this.prices = null; this.lastPrune = ''; this.dropped = 0; this.storageError = false; this.pending = 0;
  }
  serial(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  async loadPrices() {
    if (this.prices) return this.prices;
    try {
      if (!this.directory) return this.prices = Object.create(null);
      const file = path.join(this.directory, 'prices.json');
      if ((await fs.promises.stat(file)).size > 256000) throw Error('price file too large');
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 512) throw Error('invalid price file');
      for (const [id, rates] of Object.entries(data)) this.validatePrice(id, rates);
      return this.prices = Object.assign(Object.create(null), data);
    } catch (err) { if (err.code === 'ENOENT') return this.prices = Object.create(null); throw err; }
  }
  validatePrice(model, rates) {
    if (!modelId(model) || !rates || typeof rates !== 'object' || Array.isArray(rates)
        || Object.keys(rates).some(k => !RATES.includes(k))
        || RATES.some(k => rates[k] !== null && (typeof rates[k] !== 'number' || !Number.isFinite(rates[k]) || rates[k] < 0 || rates[k] > 1000000))) {
      throw publicError('单价格式无效：填写每百万 Token 的美元价格，未知项留空');
    }
  }
  setPrice(model, rates) {
    this.validatePrice(model, rates);
    return this.serial(async () => {
      const prices = Object.assign(Object.create(null), await this.loadPrices());
      if (RATES.every(k => rates[k] === null)) delete prices[model]; else prices[model] = rates;
      if (Object.keys(prices).length > 512) throw publicError('最多配置 512 个模型的单价');
      if (this.directory) {
        await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = path.join(this.directory, 'prices.json'), temp = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try { await fs.promises.writeFile(temp, JSON.stringify(prices) + '\n', { flag: 'wx', mode: 0o600 }); await fs.promises.rename(temp, target); }
        finally { await fs.promises.unlink(temp).catch(() => {}); }
      }
      this.prices = prices; return { saved: true };
    });
  }
  async prune() {
    const today = dayOf(this.now()), first = dayOf(this.now() - (RETENTION - 1) * DAY);
    if (this.lastPrune === today) return;
    if (this.directory) {
      await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const file of await fs.promises.readdir(this.directory)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < first) await fs.promises.unlink(path.join(this.directory, file));
      }
    }
    for (const day of this.cache.keys()) if (day < first) this.cache.delete(day);
    this.lastPrune = today;
  }
  ingest(day, row) {
    const key = JSON.stringify([row.model, row.served_model, row.protocol]);
    if (!day.groups.has(key)) {
      if (day.groups.size >= 1024) { day.invalid++; return; }
      day.groups.set(key, { model: row.model, served_model: row.served_model, protocol: row.protocol, ...blank() });
    }
    add(day.groups.get(key), row);
    day.recent.push(row); if (day.recent.length > 100) day.recent.shift();
  }
  async readDay(date) {
    let day = this.cache.get(date);
    if (!day) { day = { size: 0, groups: new Map(), recent: [], invalid: 0 }; this.cache.set(date, day); }
    if (!this.directory) return day;
    const file = path.join(this.directory, date + '.jsonl');
    let size;
    try { size = (await fs.promises.stat(file)).size; } catch (e) {
      if (e.code === 'ENOENT') { if (day.size) { this.cache.delete(date); return this.readDay(date); } return day; } throw e;
    }
    if (size > MAX_BYTES) throw Error('usage file too large');
    if (size < day.size) { this.cache.delete(date); return this.readDay(date); }
    if (size === day.size) return day;
    const stream = fs.createReadStream(file, { start: day.size, end: size - 1 });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try { const row = JSON.parse(line); if (!validRow(row, date)) throw Error('invalid row'); this.ingest(day, row); }
        catch { day.invalid++; }
      }
    } finally { lines.close(); stream.destroy(); }
    day.size = size; return day;
  }
  record(data) {
    if (this.pending >= 512) { this.dropped++; return Promise.resolve(); }
    this.pending++;
    return this.serial(async () => {
      const at = this.now(), date = dayOf(at);
      await this.prune();
      const row = { schema: 1, at: new Date(at).toISOString(), model: modelId(data.model) || '(unknown)',
        served_model: modelId(data.served_model) || null, protocol: data.protocol,
        ok: Boolean(data.ok), status: integer(data.status), elapsed_ms: integer(data.elapsed_ms) ?? 0,
        attempts: integer(data.attempts) ?? 1, usage_state: data.usage_state,
        ...Object.fromEntries(TOKENS.map(k => [k, integer(data[k])])), estimated_usd: null };
      try { const prices = await this.loadPrices(); row.estimated_usd = estimate(row, prices[row.served_model || row.model]); }
      catch { this.storageError = true; }
      if (!validRow(row, date)) throw Error('invalid usage');
      const day = await this.readDay(date);
      // Leading newline also isolates a partial final line left by a killed process.
      const line = '\n' + JSON.stringify(row) + '\n', bytes = Buffer.byteLength(line);
      if (day.size + bytes > MAX_BYTES) throw Error('daily usage limit');
      if (this.directory) await fs.promises.appendFile(path.join(this.directory, date + '.jsonl'), line, { mode: 0o600 });
      day.size += bytes; this.ingest(day, row);
    }).catch(() => { this.dropped++; this.storageError = true; }).finally(() => { this.pending--; });
  }
  query({ days = 7, model = '' } = {}) {
    if (![1, 7, 30].includes(days) || typeof model !== 'string' || model && !modelId(model)) throw publicError('用量筛选参数无效');
    return this.serial(async () => {
      const total = blank(), models = new Map(), daily = [], recent = [], options = new Set();
      let invalid = 0, unavailable = false, prices = {};
      try { await this.prune(); prices = await this.loadPrices(); } catch { unavailable = true; }
      for (let i = days - 1; i >= 0; i--) {
        const date = dayOf(this.now() - i * DAY), sum = { day: date, ...blank() };
        let day;
        try { day = await this.readDay(date); } catch { unavailable = true; daily.push(sum); continue; }
        invalid += day.invalid;
        for (const [key, group] of day.groups) {
          options.add(group.model); if (group.served_model) options.add(group.served_model);
          if (model && group.model !== model && group.served_model !== model) continue;
          merge(sum, group); merge(total, group);
          if (!models.has(key)) models.set(key, { model: group.model, served_model: group.served_model, protocol: group.protocol, ...blank() });
          merge(models.get(key), group);
        }
        daily.push(sum);
        recent.push(...day.recent.filter(r => !model || r.model === model || r.served_model === model));
      }
      return { days, model, timezone: 'UTC', retention_days: RETENTION, generated_at: new Date(this.now()).toISOString(),
        persistent: Boolean(this.directory), storage_error: unavailable || this.storageError, dropped: this.dropped, invalid_lines: invalid,
        total, daily, models: [...models.values()].sort((a,b) => b.input_tokens + b.output_tokens - a.input_tokens - a.output_tokens).slice(0, 1024),
        models_truncated: models.size > 1024, model_options: [...options].sort().slice(0, 1024), recent: recent.sort((a,b) => b.at.localeCompare(a.at)).slice(0, 100), prices };
    });
  }
}
function storeFor(cfg, ctx) {
  if (!ctx.usageStore) ctx.usageStore = new UsageStore(cfg._config_path ? path.join(path.dirname(path.resolve(cfg._config_path)), 'usage') : null);
  return ctx.usageStore;
}
module.exports = { UsageObservation, UsageStore, storeFor, estimate };
