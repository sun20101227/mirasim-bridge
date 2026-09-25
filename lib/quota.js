'use strict';
// Mirasim budgets use provider units, not USD and not sub2api billing quotas.
const BEGIN = '[mirasim-quota]';
const END = '[/mirasim-quota]';

function summarizeLimits(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.windows)) throw Error('Invalid Mirasim limits response');
  const windows = raw.windows.filter((w) => w && typeof w.name === 'string'
    && /^[a-zA-Z0-9_-]{1,64}$/.test(w.name) && Number.isFinite(w.used) && w.used >= 0
    && Number.isFinite(w.budget) && w.budget >= 0).map((w) => {
    const reset = typeof w.reset_at === 'number' ? (w.reset_at < 1e12 ? w.reset_at * 1000 : w.reset_at) : Date.parse(w.reset_at);
    const remaining = w.budget > 0 ? Math.max(0, w.budget - w.used) : null;
    return { name: w.name, model_scoped: w.model_scoped === true,
      used: w.used, budget: w.budget, remaining,
      remaining_percent: remaining === null ? null : Math.round(remaining / w.budget * 1000) / 10,
      reset_at: Number.isFinite(reset) && reset > 0 ? new Date(reset).toISOString() : null,
      exhausted: w.budget > 0 && w.used >= w.budget };
  });
  return { source: 'Mirasim /v1/limits', observed_at: new Date(now).toISOString(),
    available: windows.length > 0 || raw.unmetered === true, unmetered: raw.unmetered === true,
    suspended: raw.suspended === true, degraded: raw.degraded === true,
    account_exhausted: windows.some((w) => !w.model_scoped && w.exhausted), windows };
}

function quotaNote(snapshot, { stale = false, now = Date.now() } = {}) {
  const rows = [BEGIN, 'Mirasim 上游额度（非美元/非 sub2 计费余额）'];
  if (stale || !snapshot?.available) rows.push('当前查询失败或额度未知；请勿把旧值当作实时剩余额度。');
  if (snapshot?.observed_at) {
    rows.push(`采样时间: ${snapshot.observed_at}`);
    if (snapshot.unmetered) rows.push('上游标记: 不计量');
    if (snapshot.suspended) rows.push('上游标记: 账号暂停');
    if (snapshot.degraded) rows.push('上游标记: 服务降级');
    if (!stale) for (const w of snapshot.windows) {
      rows.push(`${w.name}${w.model_scoped ? '（模型专用）' : ''}: `
        + (w.remaining === null ? '上限未知' : `剩余 ${w.remaining_percent}% (${Math.round(w.remaining * 100) / 100}/${w.budget} 上游单位)`)
        + (w.reset_at ? `；重置 ${w.reset_at}` : ''));
    }
  } else rows.push(`检查时间: ${new Date(now).toISOString()}`);
  rows.push(END);
  return rows.join('\n');
}

function mergeQuotaNote(notes, block) {
  const text = typeof notes === 'string' ? notes : '';
  const begin = text.indexOf(BEGIN), end = text.indexOf(END, begin);
  if (begin >= 0 && end >= begin) return text.slice(0, begin) + block + text.slice(end + END.length);
  if (begin >= 0 || text.includes(END)) throw Error('Incomplete mirasim quota note markers; preserve manual notes and repair markers first');
  return text + (text && !text.endsWith('\n') ? '\n' : '') + block;
}

module.exports = { summarizeLimits, quotaNote, mergeQuotaNote };
