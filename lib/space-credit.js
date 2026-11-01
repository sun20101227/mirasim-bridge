'use strict';
// Per-space credit. Mirasim keeps TWO ledgers, and only one of them is what
// /v1/limits reports:
//
//   personal — the user's own pool. /v1/limits describes this one (subject=usr_…),
//              and it is exhausted for the account this repo was built against.
//   space    — a shared pool owned by one machine/space. It is NOT in /v1/limits:
//              /v1/limits ignores ?space= and x-mirasim-space entirely (probed
//              2026-10-31). Balances live under /v2/machines/<nodeId>/credit.
//
// "node" is Mirasim's word for both a real machine (`pc-…`) and a managed space
// (`space-…`); both answer the same credit shape. A space that has never been
// funded reports balance 0 with me.reason = "space_empty" and payer "personal",
// which is the honest answer for an attached machine — not an error.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (Number.isFinite(v) ? v : null);
// Mirasim node ids are opaque; accept only the shapes the API itself emits so a
// caller cannot turn the bridge into an arbitrary-path proxy. Managed spaces look
// like `space-316be` (hyphen), machines like `pc-58bc…`, allocations like `alloc_…`.
// Percent-decoding happens BEFORE this test: `a%2F..%2Fb` must not slip through as
// a single opaque segment and then be decoded by the upstream.
const NODE_ID = /^(?:pc|space|alloc)[-_][A-Za-z0-9_-]{1,64}$/;
function isNodeId(v) {
  if (typeof v !== 'string' || !NODE_ID.test(v)) return false;
  let decoded;
  try { decoded = decodeURIComponent(v); } catch { return false; }
  return decoded === v;   // anything that decodes to something else is not a plain id
}

/** Credit view for one node, normalized. Unknown fields are dropped, never invented. */
function summarizeCredit(raw) {
  if (!isObject(raw)) throw Error('Invalid Mirasim credit response');
  const nodeId = typeof raw.nodeId === 'string' && isNodeId(raw.nodeId) ? raw.nodeId : null;
  if (!nodeId) throw Error('Invalid Mirasim credit response');
  const balance = finite(raw.balance);
  const funded = finite(raw.funded);
  const used = finite(raw.used);
  // A "space" payer with a balance is a real pool; anything else falls back to the
  // user's personal ledger. Reported as the upstream said it, not re-derived.
  const mode = raw.mode === 'space' || raw.mode === 'personal' ? raw.mode : null;
  const me = isObject(raw.me) ? raw.me : {};
  const payer = me.payer === 'space' || me.payer === 'personal' ? me.payer : null;
  const members = Array.isArray(raw.members) ? raw.members.filter(isObject).map((m) => ({
    user_id: typeof m.userId === 'string' ? m.userId : null,
    name: typeof m.name === 'string' ? m.name.slice(0, 128) : null,
    email: typeof m.email === 'string' ? m.email.slice(0, 256) : null,
    role: typeof m.role === 'string' ? m.role.slice(0, 32) : null,
    used: finite(m.used),
    contributed: finite(m.contributed),
    cap: finite(m.cap),
    override: m.override === true,
  })) : [];
  return {
    node_id: nodeId,
    space_key: typeof raw.spaceKey === 'string' ? raw.spaceKey.slice(0, 128) : null,
    mode,
    balance, funded, used,
    bonus_pct: finite(raw.bonusPct),
    cap_mode: typeof raw.capMode === 'string' ? raw.capMode.slice(0, 32) : null,
    // True only when a space pool actually holds credit. This is the field a caller
    // should branch on — `balance > 0` alone would also be true of a funded machine.
    space_funded: payer === 'space' && Number.isFinite(balance) && balance > 0,
    payer,
    full: balance !== null && funded !== null && balance >= funded,
    empty_reason: typeof me.reason === 'string' ? me.reason.slice(0, 64) : null,
    me: {
      cap: finite(me.cap), used: finite(me.used), remaining: finite(me.remaining),
      prefer: typeof me.prefer === 'string' ? me.prefer.slice(0, 32) : null,
    },
    members,
    can: isObject(raw.can) ? {
      toggle: raw.can.toggle === true, set_caps: raw.can.setCaps === true, transfer: raw.can.transfer === true,
    } : null,
  };
}

/** One row per node from /v2/machines/member-seats: the spaces this account can see. */
function summarizeNodes(raw) {
  // The relay answers {spaces:[…]} today; accept a bare array too so a shape change
  // degrades to "empty" rather than throwing at the caller.
  const rows = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.spaces) ? raw.spaces : [];
  return rows.filter(isObject).filter((s) => typeof s.nodeId === 'string' && isNodeId(s.nodeId)).map((s) => {
    const seats = isObject(s.seats) ? s.seats : {};
    return {
      node_id: s.nodeId,
      space_key: typeof s.spaceKey === 'string' ? s.spaceKey.slice(0, 128) : null,
      name: typeof s.name === 'string' ? s.name.slice(0, 128) : null,
      kind: typeof s.kind === 'string' ? s.kind.slice(0, 32) : null,
      owner: s.owner === true,
      seats: { used: finite(seats.used), limit: finite(seats.limit), base: finite(seats.base), extra: finite(seats.extra) },
    };
  });
}

module.exports = { summarizeCredit, summarizeNodes, isNodeId, NODE_ID };
