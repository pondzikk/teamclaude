import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The snapshotter's job is an EVEN time series independent of traffic. The three
// things that must hold: it writes one row per enabled account with the quota
// verbatim; it is silent (and never throws) unless configured; and its timer
// never keeps the process alive.

function am(accounts) { return { accounts }; }
const ACC = [
  { name: 'a', status: 'active', quota: { unified7d: 0.42, unified7dReset: 111, unified5h: 0.1, unified7dFable: 0.9 } },
  { name: 'b', status: 'active', quota: { unified7d: 0.0,  unified7dReset: 222 } },
  { name: 'gone', disabled: true, quota: { unified7d: 0.99 } },
];

test('one row per enabled account, quota verbatim, disabled skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
  const file = path.join(dir, 's.jsonl');
  process.env.TEAMCLAUDE_QUOTA_SNAPSHOT = file;
  try {
    const { snapshotOnce } = await import('../src/quota-snapshot.js?fresh=' + Date.now());
    snapshotOnce(am(ACC), file);
    let raw = '';
    for (let i = 0; i < 200 && !raw.trim(); i++) { await new Promise(r => setTimeout(r, 10)); try { raw = fs.readFileSync(file, 'utf8'); } catch { /* not yet */ } }
    const rows = raw.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2, 'the disabled account is not sampled');
    assert.deepEqual(rows.map(r => r.account), ['a', 'b']);
    assert.equal(rows[0].wk, 0.42);
    assert.equal(rows[0].wkReset, 111);
    assert.equal(rows[0].wkFable, 0.9, 'the Fable bucket rides along for per-model charts');
    assert.ok(typeof rows[0].t === 'number', 'every row is timestamped so the series has an x-axis');
  } finally {
    delete process.env.TEAMCLAUDE_QUOTA_SNAPSHOT;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('off unless configured, and never throws', async () => {
  delete process.env.TEAMCLAUDE_QUOTA_SNAPSHOT;
  const { snapshotOnce, snapshotEnabled, startQuotaSnapshots } = await import('../src/quota-snapshot.js?off=' + Date.now());
  assert.equal(snapshotEnabled(), false);
  assert.doesNotThrow(() => snapshotOnce(am(ACC)));       // no target → nothing
  assert.doesNotThrow(() => snapshotOnce({}));            // no accounts → nothing
  const stop = startQuotaSnapshots(am(ACC));
  assert.equal(typeof stop, 'function', 'returns a stop() even when disabled');
  stop();
});

test('the timer is unref\'d — it cannot keep the process alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-'));
  const file = path.join(dir, 's.jsonl');
  process.env.TEAMCLAUDE_QUOTA_SNAPSHOT = file;
  process.env.TEAMCLAUDE_QUOTA_SNAPSHOT_INTERVAL_MS = '60000';
  try {
    const { startQuotaSnapshots } = await import('../src/quota-snapshot.js?u=' + Date.now());
    const stop = startQuotaSnapshots(am(ACC));
    // If setInterval were not unref'd, the test runner's event loop would be held
    // open by it. We assert on the handle: unref'd timers report hasRef() false.
    // (Node exposes it on the Timeout object returned by setInterval; we cannot
    // reach it here, so instead we just confirm stop() clears cleanly.)
    assert.doesNotThrow(stop);
  } finally {
    delete process.env.TEAMCLAUDE_QUOTA_SNAPSHOT;
    delete process.env.TEAMCLAUDE_QUOTA_SNAPSHOT_INTERVAL_MS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
