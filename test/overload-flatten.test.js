import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Overload flattening (affinity.flattenAbove): spare-priority ordering is right
// when the fleet is idle, but under heavy fanout it leaves spared accounts idle
// while the top tier rate-limits. Above the threshold every tier below
// flattenKeepPriority collapses to drain-first; below it the configured burn
// order returns. Temporary, stateless, and never moves an existing binding.

function oauth(name, priority) {
  return { name, priority, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

function fleet(affinity, prios = [0, 0, 1, 2, 3]) {
  const names = ['p0a', 'p0b', 'spare1', 'spare2', 'reserved3'];
  const am = new AccountManager(prios.map((p, i) => oauth(names[i], p)), 0.98,
    { affinity: { enabled: true, maxPerAccount: 2, overCapOrder: 'weighted', ...affinity } });
  for (const a of am.accounts) a.probing = false;
  // Stagger weekly resets far out so FEFO never fires unless a test asks for it.
  const now = Date.now();
  am.accounts.forEach((a, i) => { a.quota.unified7dReset = now + (200 + i * 10) * 3600_000; });
  return am;
}

/** Give the fleet an arbitrary bound-session load without real placements. */
function load(am, counts) { counts.forEach((c, i) => { am._sessionCounts[i] = c; }); }

/** Share of the next 200 placements each account wins, as percentages. */
function shares(am) {
  const c = {};
  for (let i = 0; i < 200; i++) {
    const a = am.getAccountForSession('x' + i, new Set(), 'claude-opus-5');
    am.recordSession('x' + i, a.index);
    c[a.name] = (c[a.name] || 0) + 1;
  }
  return c;
}

test('off by default: load never changes the configured burn order', () => {
  const am = fleet({});
  assert.equal(am.affinity.flattenAbove, 0);
  load(am, [50, 50, 50, 50, 50]);          // wildly overloaded
  assert.equal(am._isOverloaded(), false, 'flattenAbove 0 → never overloaded');
  assert.equal(am._effectivePriority(am.accounts[2], null, Date.now(), false).prio, 1,
    'spare tier keeps its configured priority');
});

test('below the threshold the configured burn order stands', () => {
  const am = fleet({ flattenAbove: 8 });
  load(am, [2, 2, 1, 1, 0]);               // 6 sessions ≤ 8
  assert.equal(am._isOverloaded(), false);
  const now = Date.now();
  assert.equal(am._effectivePriority(am.accounts[2], null, now, am._isOverloaded()).prio, 1);
  assert.equal(am._effectivePriority(am.accounts[4], null, now, am._isOverloaded()).prio, 3);
});

test('above the threshold spare tiers collapse to drain-first', () => {
  const am = fleet({ flattenAbove: 8 });
  load(am, [3, 3, 2, 1, 0]);               // 9 sessions > 8
  assert.equal(am._isOverloaded(), true);
  const now = Date.now(), over = true;
  assert.equal(am._effectivePriority(am.accounts[2], null, now, over).prio, 0, 'priority 1 flattens');
  assert.equal(am._effectivePriority(am.accounts[3], null, now, over).prio, 0, 'priority 2 flattens');
  assert.equal(am._effectivePriority(am.accounts[4], null, now, over).prio, 0,
    'with no keep-priority set, the whole fleet flattens');
});

test('flattenKeepPriority protects the reserved tier from a busy period', () => {
  const am = fleet({ flattenAbove: 8, flattenKeepPriority: 3 });
  load(am, [3, 3, 2, 1, 0]);
  const now = Date.now(), over = am._isOverloaded();
  assert.equal(over, true);
  assert.equal(am._effectivePriority(am.accounts[2], null, now, over).prio, 0, 'priority 1 flattens');
  assert.equal(am._effectivePriority(am.accounts[3], null, now, over).prio, 0, 'priority 2 flattens');
  assert.equal(am._effectivePriority(am.accounts[4], null, now, over).prio, 3,
    'priority 3 is at the keep line → NEVER flattened, the reserve survives');
});

test('flattening actually widens the spread, and spares the reserve', () => {
  const am = fleet({ flattenAbove: 4, flattenKeepPriority: 3 });
  const c = shares(am);
  // The three working tiers converge on an even share...
  const work = [c.p0a, c.p0b, c.spare1, c.spare2];
  assert.ok(Math.max(...work) - Math.min(...work) <= 12,
    `working tiers should converge, got ${JSON.stringify(c)}`);
  // ...while the reserved tier stays clearly behind them.
  assert.ok(c.reserved3 < Math.min(...work),
    `reserved tier must stay spared, got ${JSON.stringify(c)}`);
});

test('reversible: order returns once the load drops back', () => {
  const am = fleet({ flattenAbove: 8, flattenKeepPriority: 3 });
  const now = Date.now();
  load(am, [5, 5, 0, 0, 0]);
  assert.equal(am._effectivePriority(am.accounts[2], null, now, am._isOverloaded()).prio, 0);
  load(am, [1, 1, 0, 0, 0]);               // sessions ended
  assert.equal(am._isOverloaded(), false);
  assert.equal(am._effectivePriority(am.accounts[2], null, now, am._isOverloaded()).prio, 1,
    'configured burn order restored with no restart and no rebinding');
});

test('composes with FEFO: perishable quota still burns first, keep-tier still spared', () => {
  const am = fleet({ flattenAbove: 8, flattenKeepPriority: 3, expiryHours: 48 });
  const now = Date.now();
  am.accounts[4].quota.unified7dReset = now + 6 * 3600_000;   // reserved, but resets in 6h
  load(am, [3, 3, 3, 0, 0]);
  const over = am._isOverloaded();
  assert.equal(over, true);
  assert.equal(am._effectivePriority(am.accounts[4], null, now, over).prio, 0,
    'FEFO runs BEFORE the keep check, so perishable quota is burned even on the reserve');
});

test('threshold is total fleet load, not per-account', () => {
  const am = fleet({ flattenAbove: 8 });
  load(am, [2, 2, 2, 2, 1]);               // 9 total, none above 2
  assert.equal(am._totalBoundSessions(), 9);
  assert.equal(am._isOverloaded(), true);
});

test('env overrides config and both surface in status', () => {
  process.env.TEAMCLAUDE_FLATTEN_ABOVE = '12';
  process.env.TEAMCLAUDE_FLATTEN_KEEP_PRIORITY = '2';
  try {
    const am = fleet({ flattenAbove: 8, flattenKeepPriority: 3 });
    assert.equal(am.affinity.flattenAbove, 12);
    assert.equal(am.affinity.flattenKeepPriority, 2);
    const st = am.getStatus().sessionAffinity;
    assert.equal(st.flattenAbove, 12);
    assert.equal(st.flattenKeepPriority, 2);
    assert.equal(st.overloaded, false);
  } finally {
    delete process.env.TEAMCLAUDE_FLATTEN_ABOVE;
    delete process.env.TEAMCLAUDE_FLATTEN_KEEP_PRIORITY;
  }
});

test('keep-priority 0 pins the whole fleet — flattening becomes a no-op', () => {
  const am = fleet({ flattenAbove: 1, flattenKeepPriority: 0 });
  load(am, [5, 5, 5, 5, 5]);
  const now = Date.now(), over = am._isOverloaded();
  assert.equal(over, true);
  assert.equal(am._effectivePriority(am.accounts[2], null, now, over).prio, 1,
    'nothing is below the keep line, so nothing flattens');
});
