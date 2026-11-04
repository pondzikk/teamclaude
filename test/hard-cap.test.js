import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager, normalizeCap } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { Warmer } from '../src/warmer.js';

// An account lent by someone else: never take it past 80% of its 5h window or
// 85% of its weekly quota — on ANY path, including the ones that deliberately
// cross switchThreshold (last resort, probes) or bypass selection (pins, warm).

const CAP = { fiveHour: 0.8, weekly: 0.85 };

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function fleet() {
  // 'lent' is preferred (priority 0) and capped; 'own' is the fallback.
  const am = new AccountManager([
    oauth('lent', { priority: 0, maxUtilization: CAP }),
    oauth('own', { priority: 1 }),
  ], 0.98);
  return { am, lent: am.accounts[0], own: am.accounts[1] };
}

// ── normalizeCap ─────────────────────────────────────────────────────────────

test('normalizeCap accepts fractions, percentages and the common key aliases', () => {
  assert.deepEqual(normalizeCap({ fiveHour: 0.8, weekly: 0.85 }), { fiveHour: 0.8, weekly: 0.85 });
  assert.deepEqual(normalizeCap({ fiveHour: '0.5' }), { fiveHour: 0.5 });
  assert.deepEqual(normalizeCap({ fiveHour: 80, weekly: 85 }), { fiveHour: 0.8, weekly: 0.85 });
  assert.deepEqual(normalizeCap({ five_hour: 0.8, seven_day: 0.85 }), { fiveHour: 0.8, weekly: 0.85 });
  assert.deepEqual(normalizeCap({ '5h': 0.8, '7d': 0.85 }), { fiveHour: 0.8, weekly: 0.85 });
  assert.equal(normalizeCap(null), null);
  assert.equal(normalizeCap(undefined), null);
});

test('an unreadable cap fails closed instead of leaving the account uncapped', () => {
  for (const bad of [0.8, 'x', [], {}, { fiveHour: 0 }, { fiveHour: 150 }, { fiveHour: 'x' }, { fivehour: 0.8 }]) {
    assert.deepEqual(normalizeCap(bad), { invalid: true }, JSON.stringify(bad));
  }
  const am = new AccountManager([oauth('lent', { maxUtilization: { five_hr: 0.8 } }), oauth('own')], 0.98);
  assert.equal(am.isOverHardCap(am.accounts[0]), true, 'blocked even with no usage known');
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'own');
});

test('a trip is latched for the window: a later lower reading does not reopen the account', () => {
  const { am, lent } = fleet();
  lent.quota.unified5hReset = Date.now() + 3600_000;
  lent.quota.unified5h = 0.80;
  assert.equal(am.isOverHardCap(lent), true);
  lent.quota.unified5h = 0.78; // out-of-order header / lagging prober read
  assert.equal(am.isOverHardCap(lent), true, 'still capped inside the same window');
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'own');
  lent.quota.unified5hReset = Date.now() - 1; // the window rolls over
  lent.capLatch.until = Date.now() - 1;
  assert.equal(am.isOverHardCap(lent), false, 'released once the window resets');
});

test('the advisor-degrade fallbacks never land on an account over its cap for the advisor', () => {
  const { am, lent, own } = fleet();
  lent.quota.unified5h = 0.1; lent.quota.unified7d = 0.2; lent.quota.unified7dFable = 0.9;
  own.quota.unified7dFable = 0.99; // nobody has Fable headroom → degrade path
  assert.equal(am.getAccountForSession('s1', null, 'claude-opus-5').name, 'lent');
  assert.notEqual(am.getAccountForSession('s1', null, 'claude-opus-5', 'claude-fable-5-1')?.name, 'lent');
  assert.notEqual(am.getActiveAccount(null, 'claude-opus-5', 'claude-fable-5-1')?.name, 'lent');
});

test("_selectNext's all-unavailable fallback skips an account over its cap", () => {
  const { am, lent, own } = fleet();
  own.disabled = true;
  lent.quota.unified7d = 0.95;
  lent.quota.unified5hReset = Date.now() - 1000; // "a window reset" — just not the capped one
  assert.equal(am._selectNext(null, 'claude-opus-5'), null);
});

// ── the predicate ────────────────────────────────────────────────────────────

test('isOverHardCap trips at the 5h cap and at the shared weekly cap', () => {
  const { am, lent } = fleet();
  lent.quota.unified5h = 0.79; lent.quota.unified7d = 0.84;
  assert.equal(am.isOverHardCap(lent), false);
  lent.quota.unified5h = 0.80;
  assert.equal(am.isOverHardCap(lent), true, '5h at exactly the cap is over');
  lent.quota.unified5h = 0.10; lent.quota.unified7d = 0.85;
  assert.equal(am.isOverHardCap(lent), true, 'weekly at exactly the cap is over');
});

test('the weekly cap also covers the family bucket that governs the model', () => {
  const { am, lent } = fleet();
  lent.quota.unified5h = 0.1; lent.quota.unified7d = 0.2; lent.quota.unified7dFable = 0.9;
  assert.equal(am.isOverHardCap(lent, 'claude-fable-5-1'), true, 'Fable bucket over cap bars Fable');
  assert.equal(am.isOverHardCap(lent, 'claude-opus-5'), false, 'but not Opus');
});

test('an advisor model whose bucket is over the cap bars the account too', () => {
  const { am, lent } = fleet();
  lent.quota.unified5h = 0.1; lent.quota.unified7d = 0.2; lent.quota.unified7dFable = 0.9;
  assert.equal(am._isAvailable(lent, 'claude-opus-5'), true);
  assert.equal(am._isAvailable(lent, 'claude-opus-5', 'claude-fable-5-1'), false);
});

test('an account without a cap is never over it', () => {
  const { am, own } = fleet();
  own.quota.unified5h = 0.97; own.quota.unified7d = 0.97;
  assert.equal(am.isOverHardCap(own), false);
});

test('the cap lifts when the window resets', () => {
  const { am, lent } = fleet();
  lent.quota.unified5h = 0.9;
  lent.quota.unified5hReset = Date.now() - 1000; // window already rolled over
  assert.equal(am.isOverHardCap(lent), false);
  assert.equal(lent.quota.unified5h, null);
});

// ── every path that can put a request on an account ─────────────────────────

test('normal selection skips a capped account below switchThreshold', () => {
  const { am, lent, own } = fleet();
  lent.quota.unified5h = 0.5;
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'lent', 'preferred while under the cap');
  lent.quota.unified5h = 0.81; // far below the 0.98 switchThreshold
  assert.equal(am._isAvailable(lent, 'claude-opus-5'), false);
  assert.equal(am.getActiveAccount(null, 'claude-opus-5').name, 'own');
  assert.equal(own.quota.unified5h, null);
});

test('a session bound to the capped account is rebound once it hits the cap', () => {
  const { am, lent } = fleet();
  lent.quota.unified5h = 0.5;
  assert.equal(am.getAccountForSession('s1', null, 'claude-opus-5').name, 'lent');
  lent.quota.unified7d = 0.86;
  assert.equal(am.getAccountForSession('s1', null, 'claude-opus-5').name, 'own');
});

test('last resort never drains a capped account past its cap', () => {
  const { am, lent, own } = fleet();
  // Everyone is over switchThreshold; without the cap, last resort would pick
  // the least-utilized account — the capped one.
  lent.quota.unified5h = 0.985;
  own.quota.unified5h = 0.99;
  assert.equal(am._selectLastResort(null, 'claude-opus-5')?.name, 'own');
  own.disabled = true;
  assert.equal(am._selectLastResort(null, 'claude-opus-5'), null, 'refuses rather than cross the cap');
});

test('a revalidation probe never targets an account over its cap', () => {
  const { am, lent, own } = fleet();
  lent.quota.unified5h = 0.985;
  own.quota.unified5h = 0.99;
  am._nextProbeAt = 0;
  assert.equal(am._isProbeable(lent), false);
  assert.equal(am._selectProbe(null, 'claude-opus-5')?.name, 'own');
});

test('keep-warm skips an account over its cap', () => {
  const { am, lent } = fleet();
  const warmer = new Warmer(am, { intervalMs: 0 });
  assert.equal(warmer._isWarmTarget(lent), true, 'idle and under the cap: warmable');
  lent.quota.unified7d = 0.9;
  assert.equal(warmer._isWarmTarget(lent), false);
});

test('status reports the cap and whether it is reached', () => {
  const { am, lent } = fleet();
  lent.quota.unified5h = 0.8;
  const a = am.getStatus().accounts.find(x => x.name === 'lent');
  assert.deepEqual(a.maxUtilization, CAP);
  assert.equal(a.overHardCap, true);
  assert.equal(am.getStatus().accounts.find(x => x.name === 'own').maxUtilization, null);
});

// ── explicit pins (x-tc-account / TC_ACCT / keep-warm's /tc-acct/ path) ─────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withProxy(run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const { am, lent } = fleet();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    return await run({ proxyPort, seen, lent });
  } finally {
    proxy.close();
    upstream.close();
  }
}

const post = (url) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
});

test('a pin to a capped account is refused with 429 and never reaches upstream', async () => {
  await withProxy(async ({ proxyPort, seen, lent }) => {
    lent.quota.unified5h = 0.8;
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/lent/v1/messages`);
    const body = await res.json();
    assert.equal(res.status, 429);
    assert.match(body.error.message, /usage cap/);
    assert.equal(seen.length, 0);
  });
});

test('a pin to a capped account under its cap still goes through', async () => {
  await withProxy(async ({ proxyPort, seen, lent }) => {
    lent.quota.unified5h = 0.5;
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/lent/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer t-lent');
  });
});

test('a request queued in admit() is re-checked and re-routed if the cap trips while it waits', async () => {
  await withProxy(async ({ proxyPort, seen, lent }) => {
    lent.quota.unified5h = 0.5;
    const am = lent; // closure over the account record
    // Hold everything on 'lent' in admit() (a 429 pause), then trip the cap
    // before the pause lifts — as another response's headers would.
    am.pausedUntil = Date.now() + 300;
    setTimeout(() => { am.quota.unified5h = 0.81; }, 100);
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.ok(seen.length >= 1);
    assert.ok(seen.every(s => s.auth !== 'Bearer t-lent'), `lent must get no upstream request, saw ${JSON.stringify(seen)}`);
  });
});

test('an unpinned request routes around a capped account instead of failing', async () => {
  await withProxy(async ({ proxyPort, seen, lent }) => {
    lent.quota.unified7d = 0.9;
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer t-own');
  });
});
