import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { costOf, SpendLedger, isCreditExhausted, monthKey, nextMonthStart } from '../src/api-spend.js';

const HOUR = 3600_000;
const near = (a, b) => Math.abs(a - b) < 1e-9;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function ledger() {
  return new SpendLedger(join(mkdtempSync(join(tmpdir(), 'tc-spend-')), 'spend.json'), { flushMs: 1 });
}

test('costOf prices input, output, cache reads and both cache-write TTLs', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read; writes 1.25x / 2x input.
  const usd = costOf('claude-opus-5-5', {
    input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  });
  assert.ok(near(usd, 4 + 20 + 0.20 + 5 + 8), `got ${usd}`);
});

test('costOf: cache writes without a TTL split count as 5-minute writes', () => {
  assert.ok(near(costOf('claude-sonnet-5-5', { cache_creation_input_tokens: 1_000_000 }), 2.5));
});

test('costOf: Haiku 5.5 switches rate card above 100K prompt tokens', () => {
  assert.ok(near(costOf('claude-haiku-5-5', { input_tokens: 100_000 }), 0.01));
  assert.ok(near(costOf('claude-haiku-5-5', { input_tokens: 200_000 }), 0.10));
});

test('costOf: [1m] suffix, fast mode, and unknown models', () => {
  assert.ok(near(costOf('claude-opus-5-5[1m]', { output_tokens: 1_000_000 }), 20));
  assert.ok(near(costOf('claude-opus-5-5', { output_tokens: 1_000_000, speed: 'fast' }), 40));
  // Unknown ids are priced at the top tier so a budget is never under-counted.
  assert.ok(near(costOf('mystery-model', { output_tokens: 1_000_000 }), 50));
});

test('isCreditExhausted recognises 402 and the 400 credit-balance message only', () => {
  assert.equal(isCreditExhausted(402, ''), true);
  assert.equal(isCreditExhausted(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), true);
  assert.equal(isCreditExhausted(400, '{"error":{"message":"messages: field required"}}'), false);
  assert.equal(isCreditExhausted(500, 'credit balance is too low'), false);
  assert.equal(isCreditExhausted(400, '{"type":"error","error":{"type":"billing_error","message":"x"}}'), true);
  // Client text echoed back inside an ordinary validation error must not count.
  assert.equal(isCreditExhausted(400, '{"error":{"type":"invalid_request_error","message":"bad value: Your credit balance is too low"}}'), false);
  assert.equal(isCreditExhausted(400, 'credit balance is too low'), false);
});

test('ledger keeps a per-month total and persists it', () => {
  const l = ledger();
  const t = Date.UTC(2026, 10, 15);
  l.add('a', 1.5, t);
  l.add('a', 0.5, t);
  assert.equal(l.get('a', t).usd, 2);
  assert.equal(l.get('a', t).requests, 2);
  assert.equal(l.get('a', Date.UTC(2026, 11, 1)).usd, 0);   // new month starts at zero
  l.flush();
  assert.equal(JSON.parse(readFileSync(l.path, 'utf8')).a.usd, 2);
  assert.equal(monthKey(t), '2026-11');
  assert.equal(nextMonthStart(t), Date.UTC(2026, 11, 1));
});

test('a budgeted API key account reports spend / budget as its weekly utilization', () => {
  const l = ledger();
  const am = new AccountManager(
    [{ name: 'api', type: 'apikey', apiKey: 'k', monthlyBudget: 200 },
     { name: 'plain', type: 'apikey', apiKey: 'k2' }],
    0.98, { spendLedger: l },
  );
  am.recordSpend(0, 'claude-opus-5-5', { output_tokens: 5_000_000 });   // $100
  const a = am.accounts[0];
  assert.ok(near(a.quota.unified7d, 0.5));
  assert.equal(a.quota.unified7dReset, nextMonthStart());
  assert.equal(a.apiSpend.budget, 200);
  assert.ok(near(a.apiSpend.usd, 100));
  // No budget: no tracking, quota untouched.
  am.recordSpend(1, 'claude-opus-5-5', { output_tokens: 5_000_000 });
  assert.equal(am.accounts[1].apiSpend, null);
  assert.equal(am.accounts[1].quota.unified7d, null);
  const st = am.getStatus().accounts[0];
  assert.ok(near(st.apiSpend.usd, 100));
});

test('maxUtilization caps a budgeted API key account on its spend', () => {
  const am = new AccountManager(
    [{ name: 'api', type: 'apikey', apiKey: 'k', monthlyBudget: 200, maxUtilization: { weekly: 0.9 } }],
    0.98, { spendLedger: ledger() },
  );
  am.recordSpend(0, 'claude-opus-5-5', { output_tokens: 8_000_000 });   // $160 = 80%
  assert.equal(am.isOverHardCap(am.accounts[0]), false);
  am.recordSpend(0, 'claude-opus-5-5', { output_tokens: 1_000_000 });   // $180 = 90%
  assert.equal(am.isOverHardCap(am.accounts[0]), true);
});

test('spend survives a restart through the ledger file', () => {
  const l = ledger();
  new AccountManager([{ name: 'api', type: 'apikey', apiKey: 'k', monthlyBudget: 100 }], 0.98, { spendLedger: l })
    .recordSpend(0, 'claude-opus-5-5', { output_tokens: 1_000_000 });   // $20
  l.flush();
  const am = new AccountManager([{ name: 'api', type: 'apikey', apiKey: 'k', monthlyBudget: 100 }], 0.98,
    { spendLedger: new SpendLedger(l.path) });
  assert.ok(near(am.accounts[0].quota.unified7d, 0.2));
});

test('setMonthlyBudget applies a reload-time budget change', () => {
  const am = new AccountManager([{ name: 'api', type: 'apikey', apiKey: 'k' }], 0.98, { spendLedger: ledger() });
  assert.equal(am.accounts[0].monthlyBudget, null);
  am.setMonthlyBudget(0, { type: 'apikey', monthlyBudget: 50 });
  assert.equal(am.accounts[0].monthlyBudget, 50);
  assert.equal(am.accounts[0].quota.unified7d, 0);
  am.setMonthlyBudget(0, { type: 'apikey' });
  assert.equal(am.accounts[0].monthlyBudget, null);
  assert.equal(am.accounts[0].quota.unified7d, null);
});

// Upstream that records the auth headers of each call and answers per key.
function keyedUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ key: req.headers['x-api-key'], auth: req.headers.authorization, beta: req.headers['anthropic-beta'] });
      handler(req, res, body);
    });
  });
  return { server, seen };
}

const okBody = (model = 'claude-opus-5-5') => JSON.stringify({
  id: 'm', type: 'message', model, content: [], usage: { input_tokens: 1_000_000, output_tokens: 0 },
});

test('an API key account sends x-api-key only: client Authorization and OAuth beta are dropped', async () => {
  const { server: upstream, seen } = keyedUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(okBody());
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'api', type: 'apikey', apiKey: 'sk-test', monthlyBudget: 200 }], 0.98,
    { spendLedger: ledger() });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer someone-elses-oauth-token',
        'anthropic-beta': 'oauth-2025-04-20,context-1m-2025-08-07',
      },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(seen[0].key, 'sk-test');
    assert.equal(seen[0].auth, undefined);
    assert.equal(seen[0].beta, 'context-1m-2025-08-07');
    assert.ok(near(am.accounts[0].apiSpend.usd, 4));               // 1M input on Opus 5.5
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an API key account out of credit is skipped for the month and the request fails over', async () => {
  const { server: upstream, seen } = keyedUpstream((req, res) => {
    if (req.headers['x-api-key'] === 'broke') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(okBody());
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'broke', type: 'apikey', apiKey: 'broke', monthlyBudget: 200, priority: 0 },
    { name: 'rich', type: 'apikey', apiKey: 'rich', monthlyBudget: 200, priority: 5 },
  ], 0.98, { spendLedger: ledger() });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(seen.map(s => s.key), ['broke', 'rich']);
    assert.equal(am.accounts[0].quota.unified7d, 1);
    assert.ok(am.accounts[0].apiSpend.exhaustedAt);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('an ordinary 400 on an API key account still reaches the client unchanged', async () => {
  const { server: upstream, seen } = keyedUpstream((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'api', type: 'apikey', apiKey: 'k1', monthlyBudget: 200 }], 0.98,
    { spendLedger: ledger() });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /field required/);
    assert.equal(seen.length, 1);
    assert.equal(am.accounts[0].apiSpend.exhaustedAt, null);
  } finally {
    proxy.close();
    upstream.close();
  }
});
