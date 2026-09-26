'use strict';
// Mirasim budgets use provider units, not USD and not sub2api billing quotas.
const BEGIN = '[mirasim-quota]';
const END = '[/mirasim-quota]';

function finite(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function percent(value) {
  const n = finite(value);
  return n === null ? null : Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function resetIso(value) {
  const n = finite(value);
  const date = n !== null ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toISOString() : null;
}

function summarizeLimits(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') throw Error('Invalid Mirasim limits response');
  if (!Array.isArray(raw.windows) && !Array.isArray(raw.limits)) throw Error('Invalid Mirasim limits response');
  const rows = Array.isArray(raw.windows) ? raw.windows : raw.limits;
  const windows = rows.filter((w) => w && typeof w.name === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(w.name)).map((w) => {
    const budget = finite(w.budget);
    const used = finite(w.used);
    const usedPercent = percent(w.used_percent ?? w.usedPercentage);
    const reportedRemaining = percent(w.remaining_percent ?? w.remainingPercentage);
    const derivedUsed = usedPercent ?? (budget !== null && budget > 0 && used !== null ? percent(used / budget * 100) : null);
    const remainingPercent = reportedRemaining ?? (derivedUsed === null ? null : percent(100 - derivedUsed));
    const remaining = budget !== null && budget > 0 && used !== null ? Math.max(0, budget - used) : null;
    const exhausted = remainingPercent !== null ? remainingPercent <= 0 : Boolean(budget > 0 && used !== null && used >= budget);
    const status = typeof w.status === 'string' ? w.status : exhausted ? 'limit_reached' : null;
    return { name: w.name, model_scoped: w.model_scoped === true,
      used, budget, remaining, used_percent: derivedUsed, remaining_percent: remainingPercent,
      reset_at: resetIso(w.reset_at), status, exhausted };
  });
  return { source: 'Mirasim /v1/limits', observed_at: new Date(now).toISOString(),
    available: windows.length > 0 || raw.unmetered === true, unmetered: raw.unmetered === true,
    paid: typeof raw.paid === 'boolean' ? raw.paid : null,
    suspended: raw.suspended === true, degraded: raw.degraded === true, status: raw.status || null,
    account_exhausted: windows.some((w) => !w.model_scoped && w.exhausted), windows };
}

function quotaNote(snapshot, { stale = false, now = Date.now(), membership } = {}) {
  const rows = [BEGIN, 'Mirasim 上游额度（非美元/非 sub2 计费余额）'];
  if (membership?.available && !membership.stale) rows.push(`会员: ${membership.plan}；到期 ${membership.expires_at || '上游未提供到期时间'}`);
  if (stale || !snapshot?.available) rows.push('当前查询失败或额度未知；请勿把旧值当作实时剩余额度。');
  if (snapshot?.observed_at) {
    rows.push(`采样时间: ${snapshot.observed_at}`);
    if (snapshot.paid === true) rows.push('上游方案: paid');
    if (snapshot.paid === false) rows.push('上游方案: free');
    if (snapshot.unmetered) rows.push('上游标记: 不计量');
    if (snapshot.suspended) rows.push('上游标记: 账号暂停');
    if (snapshot.degraded) rows.push('上游标记: 服务降级');
    if (!stale) for (const w of snapshot.windows) {
      const value = w.remaining_percent === null
        ? (w.remaining === null ? '上限未知' : `剩余 ${Math.round(w.remaining * 100) / 100} 上游单位`)
        : `剩余 ${w.remaining_percent}%${w.remaining !== null && w.budget !== null ? ` (${Math.round(w.remaining * 100) / 100}/${w.budget} 上游单位)` : ''}`;
      rows.push(`${w.name}${w.model_scoped ? '（模型专用）' : ''}: `
        + value
        + (w.status ? `；状态 ${w.status}` : '')
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
