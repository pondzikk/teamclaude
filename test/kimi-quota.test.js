import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchKimiUsage } from '../src/kimi-quota.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

const STATS = {
  ratelimitCode5h: { ratio: 0.6482, enabled: true, resetTime: '2026-09-16T13:31:08.202739052Z' },
  ratelimitCode7d: { ratio: 0.0052, enabled: true, resetTime: '2026-09-23T08:31:08.202739052Z' },
};
const ok = body => async () => ({ ok: true, status: 200, json: async () => body });

// ── fetchKimiUsage ────────────────────────────────────────────

test('fetchKimiUsage maps both windows to the applyUsageData shape', async () => {
  const usage = await fetchKimiUsage('tok', { fetchImpl: ok(STATS) });
  assert.equal(usage.fiveHour.utilization, 0.6482);
  assert.equal(usage.sevenDay.utilization, 0.0052);
  // Go emits 9 fractional digits; Date can only parse 3.
  assert.equal(usage.fiveHour.resetAt, Date.parse('2026-09-16T13:31:08.202Z'));
  assert.equal(usage.sevenDay.resetAt, Date.parse('2026-09-23T08:31:08.202Z'));
});

test('fetchKimiUsage skips a window the gateway reports as disabled', async () => {
  const usage = await fetchKimiUsage('tok', {
    fetchImpl: ok({ ...STATS, ratelimitCode5h: { ratio: 0.9, enabled: false } }),
  });
  assert.equal(usage.fiveHour, undefined);
  assert.equal(usage.sevenDay.utilization, 0.0052);
});

test('fetchKimiUsage reports an expired token instead of throwing', async () => {
  const res = await fetchKimiUsage('tok', { fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.match(res.error, /expired/);
  assert.equal(res.status, 401);
});

test('fetchKimiUsage reports a 200 whose shape no longer carries windows', async () => {
  const res = await fetchKimiUsage('tok', { fetchImpl: ok({ somethingElse: true }) });
  assert.match(res.error, /no rate-limit windows/);
});

test('fetchKimiUsage never throws on a transport failure', async () => {
  const res = await fetchKimiUsage('tok', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.match(res.error, /ECONNRESET/);
});

test('fetchKimiUsage refuses to probe without a token', async () => {
  const res = await fetchKimiUsage('', { fetchImpl: ok(STATS) });
  assert.match(res.error, /no web token/);
});

// ── Prober integration ────────────────────────────────────────

function managerWithKimi() {
  return new AccountManager([
    { name: 'anth', type: 'oauth', accessToken: 't', expiresAt: Date.now() + 3600_000 },
    { name: 'kimi', type: 'apikey', apiKey: 'k', quotaProvider: 'kimi', webToken: 'web-tok' },
    { name: 'plain', type: 'apikey', apiKey: 'p' },
  ]);
}

test('prober probes a kimi account and applies its quota', async () => {
  const am = managerWithKimi();
  let sawToken = null;
  const prober = new Prober(am, {
    probeFn: async () => ({}),
    kimiProbeFn: async token => { sawToken = token; return fetchKimiUsage(token, { fetchImpl: ok(STATS) }); },
  });
  await prober.probeAll();

  assert.equal(sawToken, 'web-tok', 'the configured web token is what gets used');
  const kimi = am.accounts.find(a => a.name === 'kimi');
  assert.equal(kimi.quota.unified5h, 0.6482);
  assert.equal(kimi.quota.unified7d, 0.0052);
  assert.equal(prober.getStatus().accounts.find(a => a.name === 'kimi').status, 'ok');
});

test('prober leaves a plain apikey account unprobed', async () => {
  const am = managerWithKimi();
  const prober = new Prober(am, {
    probeFn: async () => ({}),
    kimiProbeFn: async () => { throw new Error('must not be called for a plain apikey account'); },
  });
  await prober.probeAll();

  const plain = am.accounts.find(a => a.name === 'plain');
  assert.equal(plain.quota.unified5h, null);
  assert.equal(prober.getStatus().accounts.find(a => a.name === 'plain').status, 'not-applicable');
});

test('a kimi account with no web token is not probed at all', async () => {
  const am = new AccountManager([{ name: 'kimi', type: 'apikey', apiKey: 'k', quotaProvider: 'kimi' }]);
  const prober = new Prober(am, {
    kimiProbeFn: async () => { throw new Error('must not be called without a token'); },
  });
  await prober.probeAll();
  assert.equal(prober.getStatus().accounts.find(a => a.name === 'kimi').status, 'not-applicable');
});

test('an expired kimi token surfaces as a probe error, not stale quota', async () => {
  const am = managerWithKimi();
  const prober = new Prober(am, {
    probeFn: async () => ({}),
    kimiProbeFn: async token => fetchKimiUsage(token, { fetchImpl: async () => ({ ok: false, status: 401 }) }),
  });
  await prober.probeAll();

  const status = prober.getStatus().accounts.find(a => a.name === 'kimi');
  assert.equal(status.status, 'error');
  assert.match(status.error, /expired/);
  assert.equal(am.accounts.find(a => a.name === 'kimi').quota.unified5h, null);
});
