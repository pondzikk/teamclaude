/**
 * Periodic, traffic-independent snapshot of every account's quota state.
 *
 * Why this exists alongside quota-journal.js: the journal records a row only
 * when a response flows, so its time axis is as bursty as the traffic — long
 * idle gaps, and the exact moment a weekly window RESETS (or is topped up by a
 * provider-side credit) lands wherever the next request happens to fall, which
 * can be hours late. Charting "what the limits actually do over time" needs an
 * EVEN series: the same fields sampled on a fixed interval whether or not
 * anything is being served. That is all this does — read accountManager's
 * in-memory quota (already populated from `anthropic-ratelimit-*` response
 * headers) and append one row per account per tick.
 *
 * Enabled by TEAMCLAUDE_QUOTA_SNAPSHOT=<path>; interval via
 * TEAMCLAUDE_QUOTA_SNAPSHOT_INTERVAL_MS (default 20 min, floor 60 s). Off by
 * default and fire-and-forget on purpose, exactly like the journal: this is
 * measurement and must never be able to fail — or even slow — a served request.
 * The timer is unref'd so it never keeps the process alive on its own.
 */

import fs from 'node:fs';
import path from 'node:path';

let stream = null;
let failed = false;
let timer = null;

function open(target) {
  if (stream || failed) return stream;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    stream = fs.createWriteStream(target, { flags: 'a' });
    stream.on('error', () => { failed = true; stream = null; });
  } catch {
    failed = true;
  }
  return stream;
}

/** True when snapshotting is configured. */
export function snapshotEnabled() {
  return !failed && !!process.env.TEAMCLAUDE_QUOTA_SNAPSHOT;
}

/**
 * Append one row per (enabled) account: current utilization fractions and the
 * reset moment of each window, verbatim from account.quota. Never throws.
 */
export function snapshotOnce(accountManager, target = process.env.TEAMCLAUDE_QUOTA_SNAPSHOT) {
  if (!target) return;
  const s = open(target);
  if (!s) return;
  const now = Date.now();
  try {
    for (const a of accountManager?.accounts || []) {
      if (a.disabled) continue;
      const q = a.quota || {};
      s.write(JSON.stringify({
        t: now,
        account: a.name,
        status: a.status ?? null,
        // Utilizations 0-1, as the provider reported them.
        wk: q.unified7d ?? null,
        wkReset: q.unified7dReset ?? null,
        h5: q.unified5h ?? null,
        h5Reset: q.unified5hReset ?? null,
        wkSonnet: q.unified7dSonnet ?? null,
        wkSonnetReset: q.unified7dSonnetReset ?? null,
        wkFable: q.unified7dFable ?? null,
        wkFableReset: q.unified7dFableReset ?? null,
      }) + '\n');
    }
  } catch {
    // never surface
  }
}

/**
 * Start the periodic snapshotter. No-op (returns a no-op stop) when unconfigured
 * or already running. Writes one row set immediately so a restart is visible in
 * the series, then every interval. Returns a stop() that clears the timer.
 */
export function startQuotaSnapshots(accountManager) {
  const target = process.env.TEAMCLAUDE_QUOTA_SNAPSHOT;
  if (!target || timer) return () => {};
  const intervalMs = Math.max(60_000, Number(process.env.TEAMCLAUDE_QUOTA_SNAPSHOT_INTERVAL_MS) || 1_200_000);
  snapshotOnce(accountManager, target);
  timer = setInterval(() => snapshotOnce(accountManager, target), intervalMs);
  timer.unref();
  return () => { if (timer) { clearInterval(timer); timer = null; } };
}
