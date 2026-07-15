import { test } from 'node:test';
import assert from 'node:assert';
import { AccountManager } from '../src/account-manager.js';
import { SessionIdFinder, extractSessionId } from '../src/session-id.js';

const noRefresh = async () => { throw new Error('no refresh in tests'); };

function makeManager(n = 3, opts = {}) {
  const accounts = Array.from({ length: n }, (_, i) => ({
    name: `acct-${i}`, type: 'api', apiKey: `key-${i}`, priority: opts.priorities?.[i] ?? 0,
  }));
  return new AccountManager(accounts, 0.98, { refreshFn: noRefresh, affinity: opts.affinity });
}

// Realistic Claude Code body: metadata.user_id is a STRINGIFIED JSON.
function body(sessionId, extra = {}) {
  return Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'hi' }],
    metadata: {
      user_id: JSON.stringify({
        device_id: 'ea4523d5310bec3c8b87a4d1739363248a5382a313cd49b8b207904860744299',
        account_uuid: 'f39a408f-7e0e-41f1-b59b-269a46e8da5f',
        session_id: sessionId,
      }),
    },
    ...extra,
  }));
}

const SID = 'a1ac895b-c2a9-4c4a-8e48-9fcbc246a49a';
const SID2 = 'b2bd996c-d3ba-5d5b-9f59-0acbd357b5ab';

// --- SessionIdFinder ---

test('extracts session_id from a realistic body', () => {
  assert.strictEqual(extractSessionId(body(SID)), SID);
});

test('extracts across arbitrary chunk boundaries', () => {
  const buf = body(SID);
  for (const size of [1, 3, 7, 64]) {
    const f = new SessionIdFinder();
    for (let i = 0; i < buf.length; i += size) f.push(buf.subarray(i, i + size));
    assert.strictEqual(f.value, SID, `chunk size ${size}`);
  }
});

test('ignores decoy session_id patterns in message content', () => {
  const decoy = JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: `paste: {"user_id":"{\\"session_id\\":\\"${SID2}\\"}"}` }],
    metadata: { user_id: JSON.stringify({ account_uuid: 'f39a408f-7e0e-41f1-b59b-269a46e8da5f', session_id: SID }) },
  });
  assert.strictEqual(extractSessionId(Buffer.from(decoy)), SID);
});

test('returns null when no metadata.user_id present', () => {
  assert.strictEqual(extractSessionId(Buffer.from(JSON.stringify({ model: 'x', messages: [] }))), null);
});

test('overlapping partial match cannot skip the real key (KMP)', () => {
  // user_id value where a "ses" fragment immediately precedes the real key
  const uid = JSON.stringify({ x: 'sessession', session_id: SID });
  const b = Buffer.from(JSON.stringify({ metadata: { user_id: uid }, messages: [] }));
  assert.strictEqual(extractSessionId(b), SID);
});

// --- Affinity routing ---

test('same session sticks to the same account across requests', () => {
  const m = makeManager(3);
  const a1 = m.getAccountForSession(SID);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(m.getAccountForSession(SID).index, a1.index);
  }
});

test('distinct sessions spread within a priority tier by load', () => {
  const m = makeManager(3);
  const seen = new Map();
  for (let i = 0; i < 6; i++) {
    const a = m.getAccountForSession(`00000000-0000-4000-8000-00000000000${i}`);
    seen.set(a.name, (seen.get(a.name) || 0) + 1);
  }
  // 6 sessions over 3 same-priority accounts → 2 each
  assert.deepStrictEqual([...seen.values()].sort(), [2, 2, 2]);
});

test('priority tiers fill to the cap before spilling to the next tier', () => {
  const m = makeManager(2, { priorities: [0, 1], affinity: { maxPerAccount: 2 } });
  const picks = [];
  for (let i = 0; i < 4; i++) {
    picks.push(m.getAccountForSession(`00000000-0000-4000-8000-00000000000${i}`).name);
  }
  // first 2 → priority-0 account (drain order), next 2 → priority-1
  assert.deepStrictEqual(picks, ['acct-0', 'acct-0', 'acct-1', 'acct-1']);
});

test('soft cap: all tiers full still routes (least-loaded wins)', () => {
  const m = makeManager(2, { affinity: { maxPerAccount: 1 } });
  for (let i = 0; i < 4; i++) {
    assert.ok(m.getAccountForSession(`00000000-0000-4000-8000-00000000000${i}`));
  }
  assert.strictEqual(m.sessions.size, 4);
});

test('rebinds when the bound account becomes unavailable, sticky afterwards', () => {
  const m = makeManager(2);
  const first = m.getAccountForSession(SID);
  m.setDisabled(first.index, true);
  const second = m.getAccountForSession(SID);
  assert.notStrictEqual(second.index, first.index);
  // sticky on the new account even after the old one comes back
  m.setDisabled(first.index, false);
  assert.strictEqual(m.getAccountForSession(SID).index, second.index);
});

test('excluded (already-tried) bound account is not returned again this request', () => {
  const m = makeManager(2);
  const first = m.getAccountForSession(SID);
  const retry = m.getAccountForSession(SID, new Set([first.index]));
  assert.notStrictEqual(retry.index, first.index);
});

test('no session id falls back to legacy selection', () => {
  const m = makeManager(2);
  const a = m.getAccountForSession(null);
  assert.ok(a);
  assert.strictEqual(m.sessions.size, 0);
});

test('affinity disabled falls back to legacy selection', () => {
  const m = makeManager(2, { affinity: { enabled: false } });
  const a = m.getAccountForSession(SID);
  assert.ok(a);
  assert.strictEqual(m.sessions.size, 0);
});

test('idle bindings expire after the TTL and rebind freely', () => {
  const m = makeManager(2, { affinity: { ttlMinutes: 1 } });
  m.getAccountForSession(SID);
  assert.strictEqual(m.sessions.size, 1);
  m.sessions.get(SID).lastSeen = Date.now() - 2 * 60_000;
  m._sweepSessions();
  assert.strictEqual(m.sessions.size, 0);
});

test('removeAccount unbinds its sessions and shifts higher indices', () => {
  const m = makeManager(3);
  // bind three sessions, one per account (same tier spreads by load)
  const sids = ['00000000-0000-4000-8000-000000000001',
                '00000000-0000-4000-8000-000000000002',
                '00000000-0000-4000-8000-000000000003'];
  for (const s of sids) m.getAccountForSession(s);
  const bound = sids.map(s => m.sessions.get(s).index).sort();
  assert.deepStrictEqual(bound, [0, 1, 2]);
  m.removeAccount(1);
  const left = sids.filter(s => m.sessions.has(s));
  assert.strictEqual(left.length, 2);
  for (const s of left) {
    const idx = m.sessions.get(s).index;
    assert.ok(idx >= 0 && idx < 2);
    // binding still points at the SAME account object it was bound to
  }
});

test('getStatus reports per-account session counts and affinity settings', () => {
  const m = makeManager(2, { affinity: { maxPerAccount: 5 } });
  m.getAccountForSession(SID);
  m.getAccountForSession(SID2);
  const st = m.getStatus();
  assert.strictEqual(st.sessionAffinity.enabled, true);
  assert.strictEqual(st.sessionAffinity.maxPerAccount, 5);
  assert.strictEqual(st.sessionAffinity.activeSessions, 2);
  const total = st.accounts.reduce((n, a) => n + a.sessions, 0);
  assert.strictEqual(total, 2);
});

test('quota-exhausted bound account rebinds session to a healthy one', () => {
  const m = makeManager(2, { priorities: [0, 1] });
  const first = m.getAccountForSession(SID);
  assert.strictEqual(first.name, 'acct-0');
  // simulate learned quota over threshold on the bound account
  m.updateQuota(first.index, { 'anthropic-ratelimit-unified-5h-utilization': '0.99' });
  const second = m.getAccountForSession(SID);
  assert.strictEqual(second.name, 'acct-1');
  assert.strictEqual(m.getAccountForSession(SID).name, 'acct-1'); // sticky
});
