import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { createProxyServer, forgetRecovered } from '../src/server.js';
import { Warmer } from '../src/warmer.js';
import { applyAccountPolicy } from '../src/disk-policy.js';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';

// A fallback-only account (here "roka", lent by someone else, with a hard cap)
// must take traffic ONLY once every own account that could serve the request
// is unusable — exhausted, over switchThreshold, errored, disabled, or already
// tried for this request. No FEFO / flattening / weighted share may pull it in
// earlier, and work that landed on it moves back as soon as an own account can
// take it. Explicit pins still reach it (subject to its hard cap).

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';
const CAP = { fiveHour: 0.8, weekly: 0.75 };
const OWN = ['a', 'b', 'c', 'd'];

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Mirrors the live shape: own accounts at priorities 0..3, roka at 100 with a
// cap, a kimi backend on its own route, switchThreshold raised to 1.0, weighted
// placement, FEFO 48h and overload flattening above 8 sessions.
function fleet({ affinity = {}, rokaExtra = {}, opts = {} } = {}) {
  const am = new AccountManager([
    ...OWN.map((n, i) => oauth(n, { priority: i })),
    oauth('roka', { priority: 100, maxUtilization: CAP, fallbackOnly: true, ...rokaExtra }),
    { name: 'kimi', type: 'apikey', apiKey: 'k-kimi', upstream: 'http://127.0.0.1:1', priority: 100 },
  ], 1.0, {
    routes: [
      { name: 'kimi', match: ['kimi*', 'k3*'], accounts: ['kimi'] },
      { name: 'lent-only', match: ['lent-*'], accounts: ['roka'] },
      { name: 'claude', match: ['claude-*'], accounts: [...OWN, 'roka'] },
    ],
    affinity: { enabled: true, maxPerAccount: 2, overCapOrder: 'weighted', expiryHours: 48, flattenAbove: 8, flattenKeepPriority: 3, ...affinity },
    ...opts,
  });
  const now = Date.now();
  for (const a of am.accounts) {
    a.probing = false;
    a.quota.unified7dReset = now + 150 * 3600_000; // FEFO off unless a test says so
  }
  const by = Object.fromEntries(am.accounts.map(a => [a.name, a]));
  return { am, by, own: OWN.map(n => by[n]), roka: by.roka };
}

const spend = (accts) => { for (const a of accts) a.quota.unified5h = 1.0; };

// ── demotions never touch it ─────────────────────────────────────────────────

test('FEFO within 48h does not demote a fallback-only account', () => {
  const { am, roka, own } = fleet();
  roka.quota.unified7dReset = Date.now() + 6 * 3600_000; // perishable
  assert.equal(am._effectivePriority(roka, OPUS, Date.now(), false).prio, 100);
  // Same reset on an own account at priority 3 IS demoted — FEFO itself still works.
  own[3].quota.unified7dReset = Date.now() + 6 * 3600_000;
  assert.equal(am._effectivePriority(own[3], OPUS, Date.now(), false).prio, 0);
  assert.notEqual(am._pickForNewSession(null, OPUS).name, 'roka');
  assert.notEqual(am._selectNext(null, OPUS).name, 'roka');
  assert.notEqual(am.getAccountForSession('s-fefo', null, OPUS).name, 'roka');
});

test('FEFO does not pull roka in even when it has the best configured priority', () => {
  const { am, roka } = fleet({ rokaExtra: { priority: 0 } });
  roka.quota.unified7dReset = Date.now() + 1 * 3600_000; // soonest reset of all
  for (let i = 0; i < 20; i++) assert.notEqual(am.getAccountForSession('p' + i, null, OPUS).name, 'roka');
  assert.notEqual(am._selectNext(null, OPUS).name, 'roka');
});

test('overload flattening does not flatten a fallback-only account', () => {
  // flattenKeepPriority null = flatten the WHOLE fleet; roka must still be spared.
  const { am, roka } = fleet({ affinity: { flattenKeepPriority: null } });
  for (let i = 0; i < 4; i++) am._sessionCounts[i] = 50;
  assert.equal(am._isOverloaded(), true);
  assert.equal(am._effectivePriority(roka, OPUS, Date.now(), true).prio, 100);
  assert.notEqual(am._pickForNewSession(null, OPUS).name, 'roka');
});

test('weighted placement never picks roka while an own account is available, however loaded', () => {
  const { am, own } = fleet();
  own.forEach((a, i) => { am._sessionCounts[a.index] = 10_000 + i; });
  for (let i = 0; i < 200; i++) {
    const a = am.getAccountForSession('w' + i, new Set(), OPUS);
    assert.notEqual(a.name, 'roka', `placement ${i}`);
  }
  // Every own account but one spent: the last one carries everything.
  spend(own.slice(1));
  for (let i = 0; i < 50; i++) assert.equal(am.getAccountForSession('x' + i, new Set(), OPUS).name, 'a');
});

test('legacy (no session) selection and distributeSessions never pick roka while own accounts serve', () => {
  const { am, roka } = fleet({ opts: { distributeSessions: true } });
  am.currentIndex = roka.index; // e.g. a manual switch, or left over from an outage
  assert.notEqual(am.getActiveAccount(null, OPUS).name, 'roka');
  am.currentIndex = roka.index;
  am.sessionTracker.touch('dist', roka.index);
  assert.notEqual(am.getActiveAccount(null, OPUS, null, 'dist').name, 'roka');
  assert.notEqual(am._pickLeastLoaded(null, OPUS)?.name, 'roka');
  assert.notEqual(am.previewRouteIndex(OPUS), roka.index);
});

test('the same paths hold roka back on the gate alone, even at the best priority', () => {
  // priority 0 = no priority preemption to push it off: only the gate can.
  const { am, roka, own } = fleet({ rokaExtra: { priority: 0 }, opts: { distributeSessions: true } });
  am.currentIndex = roka.index;
  assert.notEqual(am.getActiveAccount(null, OPUS).name, 'roka', 'current-account branch');
  am.currentIndex = roka.index;
  assert.notEqual(am.previewRouteIndex(OPUS), roka.index, 'previewRouteIndex current branch');
  am.sessionTracker.touch('dist', roka.index);
  assert.notEqual(am._selectForSession('dist', null, OPUS, null)?.name, 'roka', 'distributeSessions pinned branch');
  // roka would be least loaded: same priority as a, own accounts all busy.
  const f = fleet({ rokaExtra: { priority: 0 }, opts: { distributeSessions: true } });
  for (const a of f.own) a.inFlight = 5;
  assert.notEqual(f.am._pickLeastLoaded(null, OPUS)?.name, 'roka', '_pickLeastLoaded');
});

test('a held roka at a better priority does not preempt own accounts', () => {
  const { am, roka, own } = fleet({ rokaExtra: { priority: 0 }, opts: { distributeSessions: true } });
  // c and d share priority 3 (a, b spent). Re-selection would prefer c (sooner
  // reset, fewer in flight), so a spurious preemption by roka shows up as a
  // move d → c; staying on d means roka outranked nobody.
  spend(own.slice(0, 2));
  const [c, d] = [own[2], own[3]];
  c.priority = 3;
  c.quota.unified7dReset = Date.now() + 100 * 3600_000;
  d.inFlight = 5;
  assert.equal(am._preemptedBy(d, OPUS), null);
  assert.equal(am.eligibility(d.index).eligible, true);
  am.currentIndex = d.index;
  assert.equal(am.previewRouteIndex(OPUS), d.index);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'd');
  am.sessionTracker.touch('dd', d.index);
  assert.equal(am._selectForSession('dd', null, OPUS, null)?.name, 'd');
  assert.equal(am._fallbackHeld(roka, OPUS), true);
});

// ── it IS used once our own fleet is spent ───────────────────────────────────

test('roka is picked once every own account is at quota', () => {
  const { am, own } = fleet();
  spend(own);
  assert.equal(am.getAccountForSession('s1', new Set(), OPUS).name, 'roka');
  assert.equal(am.sessions.get('s1')?.index, am.accounts[4].index);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'roka');
});

test('roka is picked once every own account is exhausted / errored / disabled / throttled (mixed)', () => {
  const { am, own } = fleet();
  own[0].status = 'exhausted';
  own[1].status = 'error';
  own[2].disabled = true;
  own[3].status = 'throttled'; own[3].rateLimitedUntil = Date.now() + 600_000; own[3].throttledAt = Date.now();
  const roka = am.accounts[4];
  assert.equal(am._fallbackHeld(roka, OPUS), false, 'the gate opens');
  assert.equal(am._pickForNewSession(new Set(), OPUS)?.name, 'roka', 'via normal placement, not last resort');
  assert.equal(am.getAccountForSession('s1', new Set(), OPUS).name, 'roka');
  assert.equal(am.sessions.get('s1')?.index, roka.index, 'session bound to roka');
});

test('roka takes a request whose own candidates were all tried already (exclude set)', () => {
  const { am, own } = fleet();
  const tried = new Set(own.map(a => a.index));
  const roka = am.accounts[4];
  assert.equal(am._fallbackHeld(roka, OPUS, null, tried), false, 'exclude set opens the gate');
  assert.equal(am._fallbackHeld(roka, OPUS, null, new Set([own[0].index])), true);
  assert.equal(am._pickForNewSession(tried, OPUS)?.name, 'roka');
  assert.equal(am.getAccountForSession('s1', tried, OPUS).name, 'roka');
  assert.equal(am.sessions.get('s1')?.index, roka.index, 'placed by the normal path');
  // Only some tried → stay on the remaining own account.
  assert.equal(am.getAccountForSession('s2', new Set([own[0].index, own[1].index]), OPUS).name, 'c');
});

test('roka still respects its hard cap when it is the only candidate', () => {
  const { am, own, roka } = fleet();
  spend(own);
  roka.quota.unified5h = 0.8; // at its 5h cap
  am._nextProbeAt = 0;
  assert.notEqual(am.getAccountForSession('s1', new Set(), OPUS)?.name, 'roka');
  assert.notEqual(am.getActiveAccount(null, OPUS)?.name, 'roka');
  assert.notEqual(am._selectLastResort(null, OPUS)?.name, 'roka');
});

test('last resort drains own accounts\' last band before a fallback-only one', () => {
  const { am, own, roka } = fleet({ opts: {} });
  am.switchThreshold = 0.98;
  for (const a of own) a.quota.unified5h = 0.99; // over threshold, not empty
  roka.quota.unified5h = 0.10; // far emptier, but lent
  assert.equal(am._selectLastResort(null, OPUS).name, 'a');
});

test('revalidation probes target own accounts before a fallback-only one', () => {
  // Uncapped and emptier than every own account, at the best priority: only the
  // own-first key keeps the probe off it.
  const { am, own, roka } = fleet({ rokaExtra: { priority: 0, maxUtilization: undefined } });
  am.switchThreshold = 0.98;
  for (const a of own) a.quota.unified5h = 0.995;
  roka.quota.unified5h = 0.985;
  am._nextProbeAt = 0;
  assert.equal(am._isProbeable(roka), true);
  assert.equal(am._selectProbe(null, OPUS).name, 'a');
});

test('a due reset picks an own account before a fallback-only one, even if roka reset earlier', () => {
  const { am, own, roka } = fleet({ rokaExtra: { priority: 0, maxUtilization: undefined } });
  for (const a of [...own, roka]) a.status = 'exhausted';
  const now = Date.now();
  for (const a of own) a.quota.unified5hReset = now + 3600_000;
  roka.quota.unified5hReset = now - 120_000;
  own[2].quota.unified5hReset = now - 60_000; // c's reset is due too, but later than roka's
  assert.equal(am._pickBestAvailable(null, OPUS), null);
  assert.equal(am._selectNext(null, OPUS).name, 'c');
});

test('a session-quota reset never switches the current account to a held roka', () => {
  const { am, roka } = fleet({ rokaExtra: { priority: 0 } });
  am.currentIndex = 0;
  am.accounts[0].quota.unified7dReset = Date.now() + 100 * 3600_000;
  roka.quota.unified7dReset = Date.now() + 2 * 3600_000; // sooner weekly → would win
  am._switchOnSessionReset([roka]);
  assert.equal(am.currentIndex, 0);
  // Once no own account is usable it may.
  spend(am.accounts.slice(0, 4));
  am._switchOnSessionReset([roka]);
  assert.equal(am.currentIndex, roka.index);
});

// ── moving back ──────────────────────────────────────────────────────────────

test('a session bound to roka moves back as soon as an own account recovers', () => {
  const { am, own, roka } = fleet();
  spend(own);
  assert.equal(am.getAccountForSession('s1', new Set(), OPUS).name, 'roka');
  assert.equal(am.sessions.get('s1').index, roka.index);
  own[2].quota.unified5h = 0.3; // c's window reset
  const back = am.getAccountForSession('s1', new Set(), OPUS);
  assert.equal(back.name, 'c');
  assert.equal(am.sessions.get('s1').index, own[2].index, 'rebound, not a one-off detour');
  assert.equal(am._sessionCount(roka.index), 0);
});

test('an advisor session bound to roka moves back too (executor-only degrade)', () => {
  const { am, own, roka } = fleet();
  spend(own);
  assert.equal(am.getAccountForSession('adv', new Set(), OPUS, 'claude-fable-5-1').name, 'roka');
  // An own account recovers for the executor but has no Fable headroom.
  own[0].quota.unified5h = 0.2; own[0].quota.unified7dFable = 1.0;
  roka.quota.unified7dFable = 0.99; // roka cannot serve the advisor either now
  assert.equal(am.getAccountForSession('adv', new Set(), OPUS, 'claude-fable-5-1').name, 'a');
});

test('an advisor session bound to roka moves back when an own account fully recovers (roka still has Fable)', () => {
  const { am, own, roka } = fleet();
  spend(own);
  roka.quota.unified7dFable = 0.3; // under its cap: roka could keep serving the advisor
  assert.equal(am.getAccountForSession('adv', new Set(), OPUS, FABLE).name, 'roka');
  own[0].quota.unified5h = 0.2; // a recovers, Fable headroom included
  assert.equal(am.getAccountForSession('adv', new Set(), OPUS, FABLE).name, 'a');
  assert.equal(am.sessions.get('adv').index, own[0].index, 'rebound');
});

test('an advisor session bound to roka moves back even when own Fable is spent (advisor degrade on own)', () => {
  const { am, own, roka } = fleet();
  spend(own);
  roka.quota.unified7dFable = 0.3;
  assert.equal(am.getAccountForSession('adv2', new Set(), OPUS, FABLE).name, 'roka');
  own[0].quota.unified5h = 0.2; own[0].quota.unified7dFable = 1.0;
  assert.equal(am.getAccountForSession('adv2', new Set(), OPUS, FABLE).name, 'a');
  assert.equal(am.sessions.get('adv2').index, own[0].index);
});

test('advisor requests never go to roka while an own account serves the executor (own Fable spent)', () => {
  const { am, own, roka } = fleet();
  for (const a of own) { a.quota.unified5h = 0.2; a.quota.unified7d = 0.3; a.quota.unified7dFable = 1.0; }
  roka.quota.unified7dFable = 0.1;
  // The gate is executor-wise: own accounts that can serve Opus hold roka back.
  assert.equal(am._fallbackHeld(roka, OPUS, FABLE), true);
  for (let i = 0; i < 5; i++) {
    assert.notEqual(am.getAccountForSession('adv-new' + i, new Set(), OPUS, FABLE).name, 'roka', `session ${i}`);
  }
  assert.notEqual(am.getActiveAccount(new Set(), OPUS, FABLE).name, 'roka', 'legacy path');
  assert.notEqual(am.currentIndex, roka.index);
});

test('an own account over its HARD cap for the advisor does not hold roka back', () => {
  const { am, own, roka } = fleet();
  spend(own.slice(1));
  own[0].maxUtilization = { weekly: 0.5 };
  own[0].quota.unified7dFable = 0.6; // advisor family bucket past a's own hard cap
  assert.equal(am._fallbackHeld(roka, OPUS, null), true, 'a still serves the executor alone');
  assert.equal(am._fallbackHeld(roka, OPUS, FABLE), false, 'but cannot carry the advisor sub-call');
});

test('the legacy current account leaves roka as soon as an own account recovers', () => {
  const { am, own } = fleet();
  spend(own);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'roka');
  own[1].quota.unified5h = 0.1;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'b');
});

test('a retry that excluded the own accounts lands on roka, the next request is back on own', () => {
  const { am, own } = fleet();
  const tried = new Set(own.map(a => a.index));
  assert.equal(am.getAccountForSession('s1', tried, OPUS).name, 'roka');
  assert.notEqual(am.getAccountForSession('s1', new Set(), OPUS).name, 'roka');
});

// ── routes, reload, status, pins ─────────────────────────────────────────────

test('non-claude routes are unaffected', () => {
  const { am, roka } = fleet();
  assert.equal(am.getAccountForSession('k', new Set(), 'kimi').name, 'kimi');
  // A route that only roka may serve is served by roka: no own account is eligible for it.
  assert.equal(am.getAccountForSession('l', new Set(), 'lent-x').name, 'roka');
  assert.equal(am._fallbackHeld(roka, 'lent-x'), false);
  // An own account outside the claude route (kimi) does not hold roka back there.
  const f = fleet();
  spend(f.own);
  assert.equal(f.am._fallbackHeld(f.roka, OPUS), false);
  assert.equal(f.am.getAccountForSession('s', new Set(), OPUS).name, 'roka');
  // Without a model, only own accounts on the same backend count: kimi (third-
  // party upstream) never holds roka back.
  assert.equal(f.am._fallbackHeld(f.roka, null), false);
  assert.equal(f.am.eligibility(f.roka.index).eligible, true);
  f.own[1].quota.unified5h = 0.1;
  assert.equal(f.am._fallbackHeld(f.roka, null), true);
});

test('hot reload toggles the flag', () => {
  const { am, roka } = fleet({ rokaExtra: { fallbackOnly: undefined, priority: 0 } });
  assert.equal(roka.fallbackOnly, false, 'absent in config → off');
  roka.quota.unified7dReset = Date.now() + 1 * 3600_000;
  // Without the flag FEFO + soonest-reset tiebreak put roka first.
  assert.equal(am._pickForNewSession(null, OPUS).name, 'roka');
  assert.equal(am.setFallbackOnly(roka.index, true), true);
  assert.equal(am.setFallbackOnly(roka.index, true), false, 'idempotent');
  assert.notEqual(am._pickForNewSession(null, OPUS).name, 'roka');
  assert.equal(am.getStatus().accounts.find(a => a.name === 'roka').fallbackOnly, true);
  assert.equal(am.setFallbackOnly(roka.index, false), true);
  assert.equal(am._pickForNewSession(null, OPUS).name, 'roka');
  assert.equal(am.getStatus().accounts.find(a => a.name === 'roka').fallbackOnly, false);
  // Runtime-added accounts carry it too.
  const idx = am.addAccount(oauth('late', { fallbackOnly: true }));
  assert.equal(am.accounts[idx].fallbackOnly, true);
});

test('status and eligibility report it', () => {
  const { am, roka } = fleet();
  const st = am.getStatus().accounts;
  assert.equal(st.find(a => a.name === 'roka').fallbackOnly, true);
  assert.equal(st.find(a => a.name === 'a').fallbackOnly, false);
  assert.equal(am.eligibility(roka.index).eligible, false);
  // At the best priority nothing outranks it — the reason is the gate itself.
  const f = fleet({ rokaExtra: { priority: 0 } });
  const el = f.am.eligibility(f.roka.index);
  assert.equal(el.eligible, false);
  assert.match(el.reason, /fallback-only/);
});

test('config reload applies, clears and mirrors fallbackOnly / maxUtilization (applyAccountPolicy)', () => {
  const { am, roka } = fleet({ rokaExtra: { fallbackOnly: undefined, maxUtilization: undefined } });
  const mem = { name: 'roka', type: 'oauth' };
  // absent → true
  applyAccountPolicy(am, roka.index, { name: 'roka', fallbackOnly: true, maxUtilization: CAP }, mem);
  assert.equal(roka.fallbackOnly, true);
  assert.deepEqual(roka.maxUtilization, CAP);
  assert.equal(mem.fallbackOnly, true);
  assert.deepEqual(mem.maxUtilization, CAP);
  // true → absent (key removed on disk): cleared, and the mirror drops it so a
  // TUI save cannot write it back.
  applyAccountPolicy(am, roka.index, { name: 'roka' }, mem);
  assert.equal(roka.fallbackOnly, false);
  assert.equal(roka.maxUtilization, null);
  assert.equal('fallbackOnly' in mem, false);
  assert.equal('maxUtilization' in mem, false);
  // → true again, then explicit false
  applyAccountPolicy(am, roka.index, { name: 'roka', fallbackOnly: true }, mem);
  assert.equal(roka.fallbackOnly, true);
  applyAccountPolicy(am, roka.index, { name: 'roka', fallbackOnly: false }, mem);
  assert.equal(roka.fallbackOnly, false);
  assert.equal(mem.fallbackOnly, false);
  // An invalid cap never loosens a working one.
  applyAccountPolicy(am, roka.index, { name: 'roka', maxUtilization: CAP }, mem);
  applyAccountPolicy(am, roka.index, { name: 'roka', maxUtilization: { bogus: 1 } }, mem);
  assert.deepEqual(roka.maxUtilization, CAP);
});

test('the hot-reload wiring calls applyAccountPolicy with the matching memConfig entry', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function syncAccountsFromDisk'));
  assert.match(body.slice(0, 4000), /applyAccountPolicy\(accountManager, mgrIdx, diskAcct, memAcct/);
});

test('keep-warm skips a fallback-only account', () => {
  const { am, roka, own } = fleet();
  const warmer = new Warmer(am, { intervalMs: 0 });
  assert.equal(warmer._isWarmTarget(roka), false);
  assert.equal(warmer._isWarmTarget(own[0]), true);
});

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
  const f = fleet();
  const proxy = createProxyServer(f.am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    return await run({ proxyPort, seen, ...f });
  } finally {
    proxy.close();
    upstream.close();
  }
}

const post = (url) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: OPUS, messages: [] }),
});

test('an explicit pin to roka still works while own accounts are available', async () => {
  await withProxy(async ({ proxyPort, seen }) => {
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/roka/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[0].auth, 'Bearer t-roka');
  });
});

test('an explicit pin to roka is still refused at its hard cap', async () => {
  await withProxy(async ({ proxyPort, seen, roka }) => {
    roka.quota.unified7d = 0.75;
    const res = await post(`http://127.0.0.1:${proxyPort}/tc-acct/roka/v1/messages`);
    await res.text();
    assert.equal(res.status, 429);
    assert.equal(seen.length, 0);
  });
});

test('unpinned proxy traffic goes to an own account, and to roka only once they are spent', async () => {
  await withProxy(async ({ proxyPort, seen, own }) => {
    let res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.notEqual(seen[0].auth, 'Bearer t-roka');
    spend(own);
    res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen[1].auth, 'Bearer t-roka');
  });
});

test('a request waiting in admit() on roka moves to an own account that recovered meanwhile', async () => {
  await withProxy(async ({ proxyPort, seen, own, am, roka }) => {
    spend(own);
    assert.equal(am.getActiveAccount(null, OPUS).name, 'roka');
    am.pauseAccount(roka.index, 0.4); // e.g. a rate-limit pause on roka
    setTimeout(() => { own[0].quota.unified5h = 0.2; }, 100);
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, 'Bearer t-a');
    assert.equal(roka.inFlight, 0, 'slot released');
  });
});

test('with switchThreshold 1.0 a rejected 429 at 99% benches the own account instead of retrying it forever', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t-a') {
      res.writeHead(429, {
        'retry-after': '60',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '0.99',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const upstreamPort = await listen(upstream);
  const { am, own } = fleet();
  assert.equal(am.switchThreshold, 1.0);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await post(`http://127.0.0.1:${proxyPort}/v1/messages`);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(own[0].status, 'throttled', 'genuine rejection benched');
    assert.equal(seen.at(-1), 'Bearer t-b', 'moved on to the next own account, not roka');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('a hold / inline-wait retry forgets tried accounts that recovered, but not refused ones', () => {
  const { am, own, roka } = fleet();
  spend(own.slice(1));
  // a, b, c tried this request; a recovered since, b refused its credential,
  // c was refused the model (400 after modelMap), d is still spent.
  const ctx = { model: OPUS, tried: new Set([own[0].index, own[1].index, own[2].index, own[3].index]),
    credentialRejected: new Set(['b']), modelRefused: new Set([own[2].index]) };
  own[1].quota.unified5h = 0.1; own[2].quota.unified5h = 0.1;
  forgetRecovered(ctx, am);
  assert.deepEqual([...ctx.tried].sort(), [own[1].index, own[2].index, own[3].index].sort());
  // The retry now goes to the recovered own account, not roka.
  assert.equal(am._fallbackHeld(roka, OPUS, null, ctx.tried), true);
  assert.equal(am.getAccountForSession('hold', ctx.tried, OPUS).name, 'a');
});

// ── MITM pin (TC_ACCT → CONNECT Proxy-Authorization) ─────────────────────────

const basic = (str) => 'Basic ' + Buffer.from(str).toString('base64');

function connectThroughProxy(proxyPort, target, caCertPem, proxyAuth) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${proxyAuth}\r\n\r\n`,
    ));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (!buf.includes('\r\n\r\n')) return;
      raw.removeListener('data', onData);
      const status = buf.toString('utf8').split('\r\n')[0];
      if (!/ 200 /.test(status)) { raw.destroy(); reject(new Error(status)); return; }
      const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['h2'] }, () => resolve(sock));
      sock.once('error', reject);
    };
    raw.on('data', onData);
  });
}

async function postOverTunnel(tlsSock) {
  const client = http2.connect('https://localhost', { createConnection: () => tlsSock });
  const req = client.request({ ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json' });
  let resp;
  req.on('response', (h) => { resp = h; });
  req.resume(); req.end(JSON.stringify({ model: OPUS, messages: [] }));
  await once(req, 'close');
  client.close();
  return resp;
}

test('a TC_ACCT (MITM CONNECT) pin to roka works while own accounts serve, and is refused at its cap', { timeout: 30000 }, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'x-saw-auth': req.headers.authorization || 'none', 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const upPort = await listen(upstream);
  const { am, roka } = fleet();
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    config: { upstream: `http://127.0.0.1:${upPort}` },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: () => {},
  }));
  const proxyPort = await listen(proxy);
  const socks = [];
  try {
    let sock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, basic('roka:'));
    socks.push(sock);
    let resp = await postOverTunnel(sock);
    assert.equal(resp[':status'], 200);
    assert.equal(resp['x-saw-auth'], 'Bearer t-roka');
    roka.quota.unified7d = 0.75; // at its weekly cap
    sock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem, basic('roka:'));
    socks.push(sock);
    resp = await postOverTunnel(sock);
    assert.equal(resp[':status'], 429);
  } finally {
    for (const x of socks) x.destroy();
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});
