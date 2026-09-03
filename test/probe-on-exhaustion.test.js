import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Drive an account to a "soft" exhausted state: utilization at/above the switch
// threshold with a reset still in the future (so it isn't cleared as stale).
function exhaust(account, utilization) {
  account.quota.unified7d = utilization;
  account.quota.unified7dReset = Date.now() + 3600_000;
}

test('when every account is over threshold, getActiveAccount probes instead of refusing', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  exhaust(am.accounts[0], 0.99);
  exhaust(am.accounts[1], 0.985);

  const picked = am.getActiveAccount();
  assert.ok(picked, 'expected a probe account, not null');
  // Least-utilized is the better probe target (most likely to still have headroom).
  assert.equal(picked.name, 'b');
});

test('probing is throttled to one account per probe interval', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  exhaust(am.accounts[0], 0.99);
  exhaust(am.accounts[1], 0.99);

  assert.ok(am.getActiveAccount(), 'first call probes');
  const probeAt = am._nextProbeAt;
  // A second request inside the interval must not probe AGAIN — but it is still
  // served, by the last-resort path: both accounts read 0.99, and the band
  // between switchThreshold and a full bucket exists to be spent once nothing
  // fresher is available. The probe throttle is unchanged; only the fallback
  // behind it is (a synthetic 429 used to stand here).
  assert.ok(am.getActiveAccount(), 'last resort serves while the probe is throttled');
  assert.equal(am._nextProbeAt, probeAt, 'and it did not consume another probe');

  // With last resort off, the historical refuse-locally behaviour is intact.
  const strict = new AccountManager([oauth('a'), oauth('b')], 0.98, { affinity: { lastResort: false } });
  exhaust(strict.accounts[0], 0.99);
  exhaust(strict.accounts[1], 0.99);
  assert.ok(strict.getActiveAccount(), 'first call probes');
  assert.equal(strict.getActiveAccount(), null, 'then refuses, as before');

  // Once the interval elapses, a probe is allowed again.
  am._nextProbeAt = Date.now() - 1;
  assert.ok(am.getActiveAccount(), 'probe allowed after the interval');
});

test('a hard upstream rate-limit is respected — no probe, synthetic 429 stands', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.markRateLimited(0, 300);
  am.markRateLimited(1, 300);
  assert.equal(am.getActiveAccount(), null);
});

test('disabled accounts are never used as a probe target', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  exhaust(am.accounts[0], 0.99);
  exhaust(am.accounts[1], 0.99);
  am.accounts[0].disabled = true;
  am.accounts[1].disabled = true;
  assert.equal(am.getActiveAccount(), null);
});

test('a probe refreshing healthy quota restores normal (non-throttled) selection', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  exhaust(am.accounts[0], 0.99);

  const probe = am.getActiveAccount();
  assert.ok(probe, 'probe issued');
  // Simulate the upstream response showing real headroom.
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.10' });

  // Now the account is available the normal way, with no throttle gating.
  assert.equal(am.getActiveAccount().name, 'a');
});
