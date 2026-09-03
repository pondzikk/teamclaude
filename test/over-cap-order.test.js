import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// sessionAffinity.overCapOrder — how a new session is placed once every eligible
// account is at/over the soft cap. 'load' (default) balances the whole fleet;
// 'priority' balances within the best available priority tier and only spills
// to the next tier when that tier is unavailable — a strict burn order.

function oauth(name, priority) {
  return { name, priority, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

function fleet(overCapOrder) {
  // Two accounts at priority 0, one at 1, one at 2. Cap 2 so 30 sessions saturate.
  const am = new AccountManager(
    [oauth('a0', 0), oauth('b0', 0), oauth('c1', 1), oauth('d2', 2)],
    0.98,
    { affinity: { enabled: true, maxPerAccount: 2, overCapOrder } },
  );
  for (const a of am.accounts) a.probing = false;
  return am;
}

function place(am, n, prefix = 's') {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const acc = am.getAccountForSession(`${prefix}${i}`, new Set(), 'claude-opus-5');
    am.recordSession(`${prefix}${i}`, acc.index);
    counts[acc.name] = (counts[acc.name] || 0) + 1;
  }
  return counts;
}

test('default is load: saturated fleet spreads across every tier', () => {
  const am = fleet(undefined);
  assert.equal(am.affinity.overCapOrder, 'load');
  const c = place(am, 30);
  // All four accounts carry load; nothing sits idle while others are over cap.
  assert.ok(c.a0 >= 6 && c.b0 >= 6 && c.c1 >= 6 && c.d2 >= 6, JSON.stringify(c));
});

test('priority: saturated fleet stays inside the best tier, balanced within it', () => {
  const am = fleet('priority');
  const c = place(am, 30);
  assert.equal(c.a0 + c.b0, 30, `all sessions on tier 0, got ${JSON.stringify(c)}`);
  assert.equal(c.c1, undefined, 'tier 1 untouched while tier 0 is available');
  assert.equal(c.d2, undefined, 'tier 2 untouched while tier 0 is available');
  // Balanced within the tier — not a single-account dumping ground.
  assert.ok(Math.abs(c.a0 - c.b0) <= 1, `tier 0 must balance, got ${JSON.stringify(c)}`);
});

test('priority: spills to the next tier only when the whole tier is unavailable', () => {
  const am = fleet('priority');
  place(am, 8);
  // Exhaust tier 0 entirely.
  am.accounts[0].status = 'exhausted';
  am.accounts[1].status = 'exhausted';
  const c = place(am, 10, 'x');
  assert.equal(c.c1, 10, `tier 1 takes everything once tier 0 is gone, got ${JSON.stringify(c)}`);
  assert.equal(c.d2, undefined, 'tier 2 still untouched while tier 1 serves');
  // And tier 2 only once tier 1 is gone too.
  am.accounts[2].status = 'exhausted';
  const c2 = place(am, 3, 'y');
  assert.equal(c2.d2, 3, JSON.stringify(c2));
});

test('priority: under the cap the drain order is unchanged', () => {
  const am = fleet('priority');
  const c = place(am, 4); // 4 sessions, cap 2 × 2 tier-0 accounts → all under cap
  assert.equal(c.a0 + c.b0, 4, JSON.stringify(c));
});

test('env TEAMCLAUDE_OVER_CAP_ORDER overrides config; junk values fall back to load', () => {
  process.env.TEAMCLAUDE_OVER_CAP_ORDER = 'priority';
  try {
    assert.equal(fleet('load').affinity.overCapOrder, 'priority');
  } finally {
    delete process.env.TEAMCLAUDE_OVER_CAP_ORDER;
  }
  assert.equal(fleet('bogus').affinity.overCapOrder, 'load');
});

test('getStatus exposes overCapOrder', () => {
  assert.equal(fleet('priority').getStatus().sessionAffinity.overCapOrder, 'priority');
});

// --- 'weighted': every account works, lower priority just works less ---------

test('weighted: nothing is starved and shares follow 1 : 1/2 : 1/3 : 1/4', () => {
  const am = new AccountManager(
    [oauth('a0', 0), oauth('b1', 1), oauth('c2', 2), oauth('d3', 3)],
    0.98,
    { affinity: { enabled: true, maxPerAccount: 2, overCapOrder: 'weighted' } },
  );
  for (const a of am.accounts) a.probing = false;
  const c = place(am, 100);
  for (const n of ['a0', 'b1', 'c2', 'd3']) {
    assert.ok(c[n] > 0, `${n} must keep taking work, got ${JSON.stringify(c)}`);
  }
  // Monotonic: a lower priority value always carries at least as much.
  assert.ok(c.a0 > c.b1 && c.b1 > c.c2 && c.c2 > c.d3, JSON.stringify(c));
  // Ratios within a session of the ideal 48/24/16/12 for 100 sessions.
  assert.ok(Math.abs(c.a0 / c.b1 - 2) < 0.35, `a0/b1 ≈ 2, got ${c.a0 / c.b1}`);
  assert.ok(Math.abs(c.a0 / c.d3 - 4) < 0.7, `a0/d3 ≈ 4, got ${c.a0 / c.d3}`);
});

test('weighted: same priority still shares evenly', () => {
  const am = new AccountManager(
    [oauth('a0', 0), oauth('b0', 0)],
    0.98,
    { affinity: { enabled: true, maxPerAccount: 2, overCapOrder: 'weighted' } },
  );
  for (const a of am.accounts) a.probing = false;
  const c = place(am, 20);
  assert.equal(Math.abs(c.a0 - c.b0) <= 1, true, JSON.stringify(c));
});

test('weighted: an unavailable account is skipped, the rest keep their ratios', () => {
  const am = new AccountManager(
    [oauth('a0', 0), oauth('b1', 1), oauth('c2', 2)],
    0.98,
    { affinity: { enabled: true, maxPerAccount: 2, overCapOrder: 'weighted' } },
  );
  for (const a of am.accounts) a.probing = false;
  am.accounts[0].status = 'exhausted';
  const c = place(am, 30);
  assert.equal(c.a0, undefined, 'exhausted account takes nothing');
  assert.ok(c.b1 > 0 && c.c2 > 0, 'the others both keep working');
  assert.ok(c.b1 > c.c2, `priority still shapes the split, got ${JSON.stringify(c)}`);
});

test('weighted is accepted from env and config', () => {
  process.env.TEAMCLAUDE_OVER_CAP_ORDER = 'weighted';
  try { assert.equal(fleet('load').affinity.overCapOrder, 'weighted'); }
  finally { delete process.env.TEAMCLAUDE_OVER_CAP_ORDER; }
  assert.equal(fleet('weighted').affinity.overCapOrder, 'weighted');
});
