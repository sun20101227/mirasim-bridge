'use strict';
const crypto = require('node:crypto');

function summarizeMembership(profile, now = Date.now()) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || typeof profile.plan !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(profile.plan)) throw Error('Invalid Mirasim membership profile');
  const value = profile.plan_exp;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const expiry = Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  const validExpiry = expiry !== null && Number.isFinite(new Date(expiry).getTime()) ? expiry : null;
  return { source: 'Mirasim /auth/me', available: true, stale: false, observed_at: new Date(now).toISOString(),
    plan: profile.plan, expires_at: validExpiry === null ? null : new Date(validExpiry).toISOString(),
    status: validExpiry === null ? 'expiry_unknown' : validExpiry <= now ? 'expired' : 'active',
    // Used only to bind persisted automation history to the actual Mira identity.
    account_ref: typeof profile.id === 'string' && profile.id ? crypto.createHash('sha256').update(profile.id).digest('hex') : null };
}

module.exports = { summarizeMembership };
