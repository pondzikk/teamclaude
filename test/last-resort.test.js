import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// switchThreshold stops draining an account while a fresher one exists. Once
// none exists it buys nothing, and the band between the threshold and a full
// bucket would sit unused behind a 429 the proxy invents itself. _selectLastResort
// spends that band and lets the provider's real 429 be the authority.

const H = 3600_000;

function oauth(name, priority = 0) {
  return { name, priority, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H };
}

function mgr(names, opts = {}) {
  const am = new AccountManager(names.map((n) => oauth(n)), 0.98, opts);
  for (const a of am.accounts) a.probing = false;
  return am;
}

/** Put an account's shared weekly bucket at `used` (0..1). */
function weekly(am, index, used) {
  const q = am.accounts[index].quota;
  q.unified7d = used;
  q.unified7dReset = Date.now() + 50 * H;
}

// Burn the one allowed revalidation probe so the tests exercise the path that
// used to end in a synthetic 429.
function spendProbe(am) {
  am._nextProbeAt = Date.now() + 60_000;
}

test('everything over the threshold: the least-used account still serves', () => {
  const am = mgr(['a', 'b', 'c']);
  weekly(am, 0, 0.995);
  weekly(am, 1, 0.985);   // least used of the three
  weekly(am, 2, 0.99);
  spendProbe(am);
  const acc = am.getActiveAccount(null, 'claude-opus-5');
  assert.ok(acc, 'must not refuse locally while any account has room left');
  assert.equal(acc.name, 'b', 'picks the least-utilized');
});

test('a genuinely full bucket (>= 1.0) is not used', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 1);
  weekly(am, 1, 1);
  spendProbe(am);
  assert.equal(am.getActiveAccount(null, 'claude-opus-5'), null, 'the provider says empty — believe it');
});

test('below the threshold nothing changes: a healthy account still wins', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.995);
  weekly(am, 1, 0.20);
  const acc = am.getActiveAccount(null, 'claude-opus-5');
  assert.equal(acc.name, 'b', 'last resort must not preempt a healthy account');
});

test('hard-unavailable accounts stay out: disabled, error, rate-limited', () => {
  const am = mgr(['disabled', 'errored', 'ratelimited', 'usable']);
  for (let i = 0; i < 4; i++) weekly(am, i, 0.99);
  am.accounts[0].disabled = true;
  am.accounts[1].status = 'error';
  // A LIVE upstream hold — markRateLimited sets status/rateLimitedUntil. This is
  // the provider naming a wait; last resort must respect it.
  am.markRateLimited(2, 300);
  spendProbe(am);
  const acc = am.getActiveAccount(null, 'claude-opus-5');
  assert.equal(acc.name, 'usable');
});

test('the SOFT admission pause does not disqualify — only a real rate-limit does', () => {
  // pausedUntil is teamclaude's own back-pressure (storm ramp / absorb); unlike
  // rateLimitedUntil it deliberately leaves an account available, so a fleet
  // where everything is merely paused must still be served rather than refused.
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.99);
  weekly(am, 1, 0.99);
  am.accounts[0].pausedUntil = Date.now() + 30_000;
  am.accounts[1].pausedUntil = Date.now() + 30_000;
  spendProbe(am);
  assert.ok(am.getActiveAccount(null, 'claude-opus-5'), 'a soft pause is not a refusal');
});

test('an account excluded for this request is not resurrected by last resort', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.99);
  weekly(am, 1, 0.99);
  spendProbe(am);
  const acc = am.getActiveAccount(new Set([0]), 'claude-opus-5');
  assert.equal(acc.name, 'b');
  assert.equal(am.getActiveAccount(new Set([0, 1]), 'claude-opus-5'), null, 'nothing left to try');
});

test('can be turned off, restoring the old refuse-locally behaviour', () => {
  const am = mgr(['a', 'b'], { affinity: { lastResort: false } });
  weekly(am, 0, 0.99);
  weekly(am, 1, 0.99);
  spendProbe(am);
  assert.equal(am.getActiveAccount(null, 'claude-opus-5'), null);
});

test('TEAMCLAUDE_LAST_RESORT=0 turns it off too', () => {
  process.env.TEAMCLAUDE_LAST_RESORT = '0';
  try {
    const am = mgr(['a']);
    weekly(am, 0, 0.99);
    spendProbe(am);
    assert.equal(am.getActiveAccount(null, 'claude-opus-5'), null);
  } finally {
    delete process.env.TEAMCLAUDE_LAST_RESORT;
  }
});

test('the revalidation probe still gets first refusal', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.99);
  weekly(am, 1, 0.99);
  am._nextProbeAt = 0;                 // probe is due
  const acc = am.getActiveAccount(null, 'claude-opus-5');
  assert.ok(acc, 'probe path serves the request');
  assert.ok(am._nextProbeAt > Date.now(), 'and the probe was consumed, not bypassed');
});
