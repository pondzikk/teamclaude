import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Expiry priority (first-expire-first-out): quota that resets soon is perishable —
// unburned at reset it is lost — so a near-reset account should burn BEFORE its
// configured spare-priority would otherwise let it.

test('off by default: a spared account is NOT preferred just because it resets soon', () => {
  const am = new AccountManager([oauth('fast', { priority: 0 }), oauth('spared', { priority: 5 })], 0.98);
  const now = Date.now();
  am.accounts[1].quota.unified7dReset = now + 6 * 3600_000;    // spared resets in 6h
  am.accounts[0].quota.unified7dReset = now + 200 * 3600_000;  // fast resets in 200h
  assert.equal(am._selectNext().name, 'fast', 'expiryHours 0 → priority order stands');
});

test('enabled: a spared account resetting within expiryHours drops to drain-first', () => {
  const am = new AccountManager([oauth('fast', { priority: 0 }), oauth('spared', { priority: 5 })], 0.98,
    { affinity: { expiryHours: 48 } });
  const now = Date.now();
  am.accounts[1].quota.unified7dReset = now + 6 * 3600_000;    // spared: <48h → eff prio 0
  am.accounts[0].quota.unified7dReset = now + 200 * 3600_000;  // fast: >48h → prio 0
  // Both effective priority 0 now; the sooner-resetting one wins the tiebreak.
  assert.equal(am._selectNext().name, 'spared', 'perishable quota burns first');
});

test('enabled: an account resetting beyond the window keeps its spare-priority', () => {
  const am = new AccountManager([oauth('fast', { priority: 0 }), oauth('spared', { priority: 5 })], 0.98,
    { affinity: { expiryHours: 48 } });
  const now = Date.now();
  am.accounts[1].quota.unified7dReset = now + 100 * 3600_000;  // spared: 100h > 48h → stays prio 5
  am.accounts[0].quota.unified7dReset = now + 200 * 3600_000;
  assert.equal(am._selectNext().name, 'fast', 'not imminent → still spared');
});

test('the same rule drives session placement (_pickForNewSession), not only _selectNext', () => {
  const am = new AccountManager([oauth('fast', { priority: 0 }), oauth('spared', { priority: 5 })], 0.98,
    { affinity: { expiryHours: 48 } });
  const now = Date.now();
  am.accounts[1].quota.unified7dReset = now + 6 * 3600_000;
  am.accounts[0].quota.unified7dReset = now + 200 * 3600_000;
  assert.equal(am._pickForNewSession().name, 'spared', 'both selection paths agree');
});

test('env TEAMCLAUDE_EXPIRY_HOURS enables it too', () => {
  process.env.TEAMCLAUDE_EXPIRY_HOURS = '48';
  try {
    const am = new AccountManager([oauth('fast', { priority: 0 }), oauth('spared', { priority: 5 })], 0.98);
    const now = Date.now();
    am.accounts[1].quota.unified7dReset = now + 6 * 3600_000;
    am.accounts[0].quota.unified7dReset = now + 200 * 3600_000;
    assert.equal(am._selectNext().name, 'spared');
  } finally {
    delete process.env.TEAMCLAUDE_EXPIRY_HOURS;
  }
});
