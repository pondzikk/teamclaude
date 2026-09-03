import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountManager } from '../src/account-manager.js';

// The journal exists to make `capacity = work / quota consumed` computable from
// ordinary traffic. Both halves have to be right: the work term must include
// cache tokens (95% of real volume) and carry the model, and the quota term must
// be attributable to a single weekly window.

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 5000,
  cache_read_input_tokens: 90000,
};

test('cache tokens are counted — the whole point', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateUsage(0, USAGE.input_tokens, USAGE.output_tokens, USAGE, 'claude-opus-5');
  const u = am.accounts[0].usage;
  assert.equal(u.totalInputTokens, 1000);
  assert.equal(u.totalOutputTokens, 200);
  assert.equal(u.totalCacheCreationTokens, 5000);
  assert.equal(u.totalCacheReadTokens, 90000);
  // Cache is 95% here, exactly the shape of real traffic. Counting only
  // input+output would report 1,200 of 96,200 tokens actually delivered.
  const all = u.totalInputTokens + u.totalOutputTokens + u.totalCacheCreationTokens + u.totalCacheReadTokens;
  assert.ok((u.totalCacheReadTokens + u.totalCacheCreationTokens) / all > 0.9);
});

test('the per-model split keeps models separable', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateUsage(0, 100, 10, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 }, 'claude-opus-5');
  am.updateUsage(0, 50, 5, { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 400 }, 'claude-haiku-4-5');
  const m = am.accounts[0].usage.byModel;
  assert.equal(m['claude-opus-5'].input, 100);
  assert.equal(m['claude-opus-5'].cacheRead, 900);
  assert.equal(m['claude-haiku-4-5'].input, 50);
  assert.equal(m['claude-haiku-4-5'].cacheRead, 400);
  // Requests count on the output leg so one streamed exchange is not counted twice.
  assert.equal(m['claude-opus-5'].requests, 1);
});

test('old two-arg callers still work and do not corrupt the cache totals', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.updateUsage(0, 500, 0);           // the legacy shape, e.g. the OpenAI translator
  am.updateUsage(0, 0, 70);
  const u = am.accounts[0].usage;
  assert.equal(u.totalInputTokens, 500);
  assert.equal(u.totalOutputTokens, 70);
  assert.equal(u.totalCacheReadTokens, 0, 'no usage object means no cache claim, not a wrong one');
  assert.deepEqual(u.byModel, {}, 'no model means no bucket, rather than an "unknown" one');
});

test('a row carries work AND the quota denominator, with the window it belongs to', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qj-'));
  const file = path.join(dir, 'j.jsonl');
  process.env.TEAMCLAUDE_QUOTA_JOURNAL = file;
  try {
    const { journalResponse } = await import('../src/quota-journal.js?fresh=' + Date.now());
    const reset = Date.now() + 3 * 86400_000;
    journalResponse({
      account: 'metinpondzik',
      model: 'claude-opus-5',
      usage: USAGE,
      quota: { unified7d: 0.42, unified7dReset: reset, unified5h: 0.1 },
      status: 200,
    });
    // Poll for the flush rather than sleeping a fixed interval: the write is
    // async and fire-and-forget, and under a loaded full-suite run a fixed
    // delay is a coin toss.
    let raw = '';
    for (let i = 0; i < 200 && !raw.trim(); i++) {
      await new Promise(r => setTimeout(r, 10));
      try { raw = fs.readFileSync(file, 'utf8'); } catch { /* not created yet */ }
    }
    assert.ok(raw.trim(), 'journal produced no row within 2s');
    const row = JSON.parse(raw.trim().split('\n').pop());
    assert.equal(row.account, 'metinpondzik');
    assert.equal(row.model, 'claude-opus-5');
    assert.equal(row.cr, 90000, 'cache reads are the bulk of the work term');
    assert.equal(row.wk, 0.42, 'the denominator is on the row');
    assert.equal(row.wkReset, reset, 'so rows from different windows are never summed');
  } finally {
    delete process.env.TEAMCLAUDE_QUOTA_JOURNAL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('journalling is off unless configured, and never throws', async () => {
  delete process.env.TEAMCLAUDE_QUOTA_JOURNAL;
  const { journalResponse, journalEnabled } = await import('../src/quota-journal.js?off=' + Date.now());
  assert.equal(journalEnabled(), false);
  // Measurement must never be able to fail a user's request.
  assert.doesNotThrow(() => journalResponse({ account: 'x', usage: USAGE, quota: null }));
  assert.doesNotThrow(() => journalResponse({}));
});
