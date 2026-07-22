import { test } from 'node:test';
import assert from 'node:assert';
import { AccountManager } from '../src/account-manager.js';

const noRefresh = async () => { throw new Error('no refresh in tests'); };
const OPUS = 'claude-opus-4-8';
const FABLE = 'claude-fable-5';
const sid = (n) => `00000000-0000-4000-8000-00000000000${n}`;

// fable = array of unified7dFable utilization per account (null = unknown).
// All accounts are otherwise fresh (5h/weekly null → available for any model).
function mgr(reserve, fable, priorities) {
  const accounts = fable.map((_, i) => ({
    name: `a${i}`, type: 'api', apiKey: `k${i}`, priority: priorities?.[i] ?? 0,
  }));
  const m = new AccountManager(accounts, 0.98, {
    refreshFn: noRefresh, reserveFableAccounts: reserve, affinity: { maxPerAccount: 100 },
  });
  fable.forEach((f, i) => { if (f != null) m.accounts[i].quota.unified7dFable = f; });
  return m;
}

test('reserve on: a non-Fable request prefers the Fable-SPENT account', () => {
  const m = mgr(true, [0.99, 0.30]); // a0 Fable spent, a1 Fable has room
  assert.strictEqual(m.getAccountForSession(sid(1), null, OPUS).name, 'a0',
    'general traffic should burn the Fable-spent account, sparing the Fable-capable one');
});

test('reserve steers by Fable bucket, not account order (off=a0, on=a1)', () => {
  // a0 has Fable ROOM, a1 is Fable SPENT.
  const off = mgr(false, [0.30, 0.99]);
  assert.strictEqual(off.getAccountForSession(sid(2), null, OPUS).name, 'a0',
    'with reserve OFF the Fable bucket is ignored (normal pick = a0)');
  const on = mgr(true, [0.30, 0.99]);
  assert.strictEqual(on.getAccountForSession(sid(2), null, OPUS).name, 'a1',
    'with reserve ON, non-Fable is steered to the Fable-spent a1');
});

test('reserve on: a FABLE request still uses the Fable-capable account', () => {
  const m = mgr(true, [0.99, 0.30]); // a0 spent (can't serve Fable), a1 room
  assert.strictEqual(m.getAccountForSession(sid(3), null, FABLE).name, 'a1',
    'Fable requests must land on the account that can still serve Fable');
});

test('reserve on but SOFT: when the Fable-spent account is unavailable, non-Fable falls through', () => {
  const m = mgr(true, [0.99, 0.30]);
  m.setDisabled(0, true); // a0 (the Fable-spent, preferred-for-general) taken out
  assert.strictEqual(m.getAccountForSession(sid(4), null, OPUS).name, 'a1',
    'reserve is a preference, not a block — general traffic still gets served');
});

test('reserve on: a non-Fable executor with a Fable ADVISOR is NOT reserved away from Fable capacity', () => {
  const m = mgr(true, [0.99, 0.30]); // only a1 can serve Fable
  // executor Opus + advisor Fable → the account must serve Fable; a0 can't.
  assert.strictEqual(m.getAccountForSession(sid(5), null, OPUS, FABLE).name, 'a1',
    'a Fable advisor needs a Fable-capable account; the reserve must not steer it away');
});

test('reserve on: an account with UNKNOWN Fable utilization is not penalized', () => {
  const m = mgr(true, [null, 0.30]); // a0 Fable unknown, a1 Fable room
  assert.strictEqual(m.getAccountForSession(sid(6), null, OPUS).name, 'a0',
    'null Fable bucket → not treated as reservable (we have not learned it yet)');
});

test('reserve respects priority WITHIN the same reserve tier', () => {
  // both Fable-spent (reserve tier 0 for non-Fable); priority should still order them.
  const m = mgr(true, [0.99, 0.99], [1, 0]); // a1 higher priority
  assert.strictEqual(m.getAccountForSession(sid(7), null, OPUS).name, 'a1',
    'among equally-reserved accounts, operator priority still wins');
});

test('reserve on: legacy _pickBestAvailable path also steers non-Fable to Fable-spent', () => {
  const m = mgr(true, [0.99, 0.30]);
  assert.strictEqual(m._pickBestAvailable(null, OPUS).name, 'a0');
  assert.strictEqual(m._pickBestAvailable(null, FABLE).name, 'a1', 'Fable via legacy path picks the capable account');
});

test('reserve off is the default (no reserveFableAccounts option)', () => {
  const accounts = [{ name: 'x', type: 'api', apiKey: 'k' }];
  const m = new AccountManager(accounts, 0.98, { refreshFn: noRefresh });
  assert.strictEqual(m.reserveFable, false);
});

test('env TEAMCLAUDE_RESERVE_FABLE overrides the config option', () => {
  const accounts = [{ name: 'x', type: 'api', apiKey: 'k' }];
  const prev = process.env.TEAMCLAUDE_RESERVE_FABLE;
  try {
    process.env.TEAMCLAUDE_RESERVE_FABLE = '1';
    assert.strictEqual(new AccountManager(accounts, 0.98, { refreshFn: noRefresh, reserveFableAccounts: false }).reserveFable, true);
    process.env.TEAMCLAUDE_RESERVE_FABLE = '0';
    assert.strictEqual(new AccountManager(accounts, 0.98, { refreshFn: noRefresh, reserveFableAccounts: true }).reserveFable, false);
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_RESERVE_FABLE;
    else process.env.TEAMCLAUDE_RESERVE_FABLE = prev;
  }
});
