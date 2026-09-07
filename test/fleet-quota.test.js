import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import {
  fleetQuotaEnabled, fleetQuotaCap, fleetQuota, rewriteQuotaHeaders, rewriteRateLimitPayload, rewriteSSEEvent,
} from '../src/fleet-quota.js';

// Fleet-level quota reporting: the figures upstream returns describe the ONE
// account that served the request. A client that throttles itself on them reads
// a single spent account as a spent pool. These report the headroom of the
// accounts that can actually serve the next request instead.

function oauth(name, quota = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...quota };
}

// Reset timestamps must be in the FUTURE: _isAvailable clears a window whose
// reset has passed (that is its job), so a past timestamp would wipe the very
// quota under test before fleetQuota ever reads it.
const T = Date.now() + 3600_000;

function fleet(specs) {
  const am = new AccountManager(specs.map(s => oauth(s.name)), 0.98);
  for (const a of am.accounts) a.probing = false;
  specs.forEach((s, i) => Object.assign(am.accounts[i].quota, s.quota));
  return am;
}

test('off unless TEAMCLAUDE_FLEET_QUOTA=1', () => {
  delete process.env.TEAMCLAUDE_FLEET_QUOTA;
  assert.equal(fleetQuotaEnabled(), false);
  process.env.TEAMCLAUDE_FLEET_QUOTA = '1';
  try { assert.equal(fleetQuotaEnabled(), true); }
  finally { delete process.env.TEAMCLAUDE_FLEET_QUOTA; }
});

test('reports the LOWEST utilization per bucket across available accounts', () => {
  const am = fleet([
    { name: 'busy', quota: { unified5h: 0.90, unified7d: 0.80, unified5hReset: T + 1000, unified7dReset: T + 2000 } },
    { name: 'fresh', quota: { unified5h: 0.10, unified7d: 0.95, unified5hReset: T + 3000, unified7dReset: T + 4000 } },
  ]);
  const fq = fleetQuota(am);
  assert.equal(fq.unified5h, 0.10, 'five-hour headroom comes from the fresher account');
  assert.equal(fq.unified7d, 0.80, 'weekly headroom comes from the other one — buckets are independent');
  assert.equal(fq.unified5hReset, T + 3000, 'reset belongs to the account that supplied the minimum');
  assert.equal(fq.unified7dReset, T + 2000);
});

test('a spent account is excluded — its 100% never becomes the fleet figure', () => {
  const am = fleet([
    { name: 'spent', quota: { unified5h: 0.0, unified7d: 1.0, unified5hReset: T, unified7dReset: T } },   // weekly maxed → benched
    { name: 'healthy', quota: { unified5h: 0.5, unified7d: 0.5, unified5hReset: T, unified7dReset: T } },
  ]);
  const fq = fleetQuota(am);
  assert.equal(fq.unified7d, 0.5, 'the exhausted account contributes nothing');
  assert.equal(fq.unified5h, 0.5, 'not even its idle 5h window, which is real but unusable');
});

test('genuinely exhausted fleet returns null, so exhaustion still reads as exhaustion', () => {
  const am = fleet([
    { name: 'a', quota: { unified5h: 0.1, unified7d: 1.0, unified5hReset: T, unified7dReset: T } },
    { name: 'b', quota: { unified5h: 0.1, unified7d: 0.99, unified5hReset: T, unified7dReset: T } },
  ]);
  assert.equal(fleetQuota(am), null);
});

test('headers: only those the upstream actually sent are rewritten', () => {
  const fq = { unified5h: 0.2, unified5hReset: 60_000, unified7d: 0.3, unified7dReset: 120_000 };
  const headers = {
    'anthropic-ratelimit-unified-5h-utilization': '0.97',
    'anthropic-ratelimit-unified-5h-reset': '999',
    'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
    'content-type': 'text/event-stream',
  };
  rewriteQuotaHeaders(headers, fq);
  assert.equal(headers['anthropic-ratelimit-unified-5h-utilization'], '0.2');
  assert.equal(headers['anthropic-ratelimit-unified-5h-reset'], '60', 'ms → unix seconds');
  assert.equal(headers['anthropic-ratelimit-unified-5h-status'], 'allowed');
  assert.equal(headers['content-type'], 'text/event-stream', 'unrelated headers untouched');
  assert.ok(!('anthropic-ratelimit-unified-7d-utilization' in headers), 'absent header is not invented');
});

test('payload: windows, the top-level pair and status are all recomputed', () => {
  const fq = { unified5h: 0.20, unified5hReset: 60_000, unified7d: 0.91, unified7dReset: 120_000 };
  const payload = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected', rateLimitType: 'five_hour', utilization: 1.0, isUsingOverage: true, resetsAt: 5,
      unifiedWindows: {
        five_hour: { utilization: 1.0, resetsAt: 5 },
        seven_day: { utilization: 1.0, resetsAt: 5 },
      },
    },
  };
  rewriteRateLimitPayload(payload, fq);
  const i = payload.rate_limit_info;
  assert.equal(i.unifiedWindows.five_hour.utilization, 0.20);
  assert.equal(i.unifiedWindows.seven_day.utilization, 0.91);
  assert.equal(i.unifiedWindows.five_hour.resetsAt, 60);
  assert.equal(i.rateLimitType, 'seven_day', 'top level names the bucket closest to its limit');
  assert.equal(i.utilization, 0.91);
  assert.equal(i.status, 'allowed_warning', '>= 0.9 still warns — we report headroom, not comfort');
  assert.equal(i.isUsingOverage, false, 'an available account answered, so the pool is not in overage');
});

test('SSE: a rate_limit_event frame is rewritten', () => {
  const fq = { unified7d: 0.4, unified7dReset: 90_000 };
  const ev = 'event: rate_limit_event\ndata: ' + JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', utilization: 1.0, unifiedWindows: { seven_day: { utilization: 1.0, resetsAt: 1 } } },
  });
  const out = rewriteSSEEvent(ev, fq);
  assert.ok(out.startsWith('event: rate_limit_event\ndata: '), 'framing preserved');
  const parsed = JSON.parse(out.split('data: ')[1]);
  assert.equal(parsed.rate_limit_info.utilization, 0.4);
  assert.equal(parsed.rate_limit_info.status, 'allowed');
  assert.equal(parsed.rate_limit_info.unifiedWindows.seven_day.resetsAt, 90);
});

test('SSE: every other frame is returned byte-identical', () => {
  const fq = { unified7d: 0.4 };
  for (const ev of [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    'data: [DONE]',
    '',
  ]) {
    assert.equal(rewriteSSEEvent(ev, fq), ev);
  }
});

test('SSE: a malformed or partial frame is relayed untouched, never invented', () => {
  const fq = { unified7d: 0.4 };
  const broken = 'event: rate_limit_event\ndata: {"type":"rate_limit_event","rate_limit_i';
  assert.equal(rewriteSSEEvent(broken, fq), broken);
});

test('no fleet figures (null) means no rewriting anywhere', () => {
  const headers = { 'anthropic-ratelimit-unified-5h-utilization': '1.0' };
  rewriteQuotaHeaders(headers, null);
  assert.equal(headers['anthropic-ratelimit-unified-5h-utilization'], '1.0');
  const ev = 'data: {"type":"rate_limit_event","rate_limit_info":{"utilization":1}}';
  assert.equal(rewriteSSEEvent(ev, null), ev);
});

// --- cap: "the proxy is the authority" mode -----------------------------------

test('cap is off by default and only accepts a sane 0-1 value', () => {
  delete process.env.TEAMCLAUDE_FLEET_QUOTA_CAP;
  assert.equal(fleetQuotaCap(), null);
  for (const [raw, want] of [['0.89', 0.89], ['1', 1], ['0', null], ['-1', null], ['2', null], ['abc', null], ['', null]]) {
    process.env.TEAMCLAUDE_FLEET_QUOTA_CAP = raw;
    assert.equal(fleetQuotaCap(), want, `cap "${raw}"`);
  }
  delete process.env.TEAMCLAUDE_FLEET_QUOTA_CAP;
});

test('cap closes the band where the proxy would still serve but a client gives up', () => {
  // The exact shape of the 06:20 outage: one usable account at 0.96 — above
  // claude-mem's 0.95, below our 0.98 — and nothing else left.
  const am = fleet([{ name: 'only', quota: { unified5h: 0.96, unified7d: 0.5, unified5hReset: T, unified7dReset: T } }]);
  assert.equal(fleetQuota(am).unified5h, 0.96, 'uncapped reports the truth');
  process.env.TEAMCLAUDE_FLEET_QUOTA_CAP = '0.89';
  try {
    const fq = fleetQuota(am);
    assert.equal(fq.unified5h, 0.89, 'capped: we route it, so the client must not refuse it');
    assert.equal(fq.unified7d, 0.5, 'a figure already under the cap is left alone');
  } finally { delete process.env.TEAMCLAUDE_FLEET_QUOTA_CAP; }
});

test('cap never resurrects a genuinely exhausted fleet', () => {
  const am = fleet([{ name: 'spent', quota: { unified5h: 0.1, unified7d: 1.0, unified5hReset: T, unified7dReset: T } }]);
  process.env.TEAMCLAUDE_FLEET_QUOTA_CAP = '0.5';
  try { assert.equal(fleetQuota(am), null, 'no available account → nothing to report, cap or not'); }
  finally { delete process.env.TEAMCLAUDE_FLEET_QUOTA_CAP; }
});

// --- end to end, through the real proxy and a real SSE stream ----------------

import http from 'node:http';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const RESET_S = Math.floor((Date.now() + 3600_000) / 1000);

/** Frames a real stream carries: a rate_limit_event among ordinary content. */
function sseBody() {
  const rl = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected', rateLimitType: 'five_hour', utilization: 1.0, isUsingOverage: true, resetsAt: 1,
      unifiedWindows: { five_hour: { utilization: 1.0, resetsAt: 1 } },
    },
  };
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    `event: rate_limit_event\ndata: ${JSON.stringify(rl)}`,
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join('\n\n') + '\n\n';
}

async function throughProxy() {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      // The serving account's own figure — deliberately worse than the pool's.
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': String(RESET_S),
      'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
    });
    res.end(sseBody());
  });
  const am = new AccountManager(
    [oauth('a'), oauth('b')],
    0.98,
  );
  for (const acc of am.accounts) {
    acc.probing = false;
    Object.assign(acc.quota, { unified5h: 0.2, unified5hReset: T, unified7d: 0.2, unified7dReset: T });
  }
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}` });
  const proxyPort = await listen(proxy);
  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await res.text();
  const util = res.headers.get('anthropic-ratelimit-unified-5h-utilization');
  upstream.close(); proxy.close();
  return { text, util };
}

test('e2e: with the feature OFF the stream and headers pass through untouched', { timeout: 20000 }, async () => {
  delete process.env.TEAMCLAUDE_FLEET_QUOTA;
  const { text, util } = await throughProxy();
  assert.equal(util, '0.5', "the serving account's own figure is relayed as-is");
  assert.equal(text, sseBody(), 'byte-identical stream — the default path is untouched');
});

test('e2e: with the feature ON the pool figure replaces it, everything else survives', { timeout: 20000 }, async () => {
  process.env.TEAMCLAUDE_FLEET_QUOTA = '1';
  try {
    const { text, util } = await throughProxy();
    assert.equal(util, '0.2', 'header now reports the pool, not the account that answered');

    const frames = text.split('\n\n').filter(Boolean);
    const original = sseBody().split('\n\n').filter(Boolean);
    assert.equal(frames.length, original.length, 'no frame gained or lost');

    // Every non-quota frame is preserved exactly.
    for (const i of [0, 1, 3]) assert.equal(frames[i], original[i], `frame ${i} unchanged`);

    const rl = JSON.parse(frames[2].split('data: ')[1]);
    assert.equal(rl.type, 'rate_limit_event');
    assert.equal(rl.rate_limit_info.utilization, 0.2, '1.0 → the pool has room');
    assert.equal(rl.rate_limit_info.unifiedWindows.five_hour.utilization, 0.2);
    assert.equal(rl.rate_limit_info.status, 'allowed', "no longer 'rejected'");
    assert.equal(rl.rate_limit_info.isUsingOverage, false);
  } finally { delete process.env.TEAMCLAUDE_FLEET_QUOTA; }
});

// --- enabling from config (hot-reloadable, no restart) ------------------------

import { setFleetQuotaConfig } from '../src/fleet-quota.js';

test('config turns it on without env, and reload picks up a mutated object', () => {
  delete process.env.TEAMCLAUDE_FLEET_QUOTA;
  delete process.env.TEAMCLAUDE_FLEET_QUOTA_CAP;
  const cfg = {};
  setFleetQuotaConfig(cfg);
  try {
    assert.equal(fleetQuotaEnabled(), false, 'absent config → off');

    // reloadAccounts mutates the SAME object, which is what makes POST
    // /teamclaude/reload enough — no restart, no torn MITM tunnels.
    cfg.fleetQuota = { enabled: true, cap: 0.89 };
    assert.equal(fleetQuotaEnabled(), true);
    assert.equal(fleetQuotaCap(), 0.89);

    cfg.fleetQuota = { enabled: false };
    assert.equal(fleetQuotaEnabled(), false, 'and it switches back off just as live');
    assert.equal(fleetQuotaCap(), null);
  } finally { setFleetQuotaConfig(null); }
});

test('env still wins over config', () => {
  const cfg = { fleetQuota: { enabled: false, cap: 0.5 } };
  setFleetQuotaConfig(cfg);
  process.env.TEAMCLAUDE_FLEET_QUOTA = '1';
  process.env.TEAMCLAUDE_FLEET_QUOTA_CAP = '0.7';
  try {
    assert.equal(fleetQuotaEnabled(), true, 'env forces it on despite config off');
    assert.equal(fleetQuotaCap(), 0.7, 'env cap overrides the config cap');
  } finally {
    delete process.env.TEAMCLAUDE_FLEET_QUOTA;
    delete process.env.TEAMCLAUDE_FLEET_QUOTA_CAP;
    setFleetQuotaConfig(null);
  }
});
