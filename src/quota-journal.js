/**
 * Append-only per-response journal pairing WORK DELIVERED with QUOTA CONSUMED.
 *
 * Why this exists: the obvious way to compare two subscription tiers — look at
 * how full each account's weekly bucket is — cannot work on a real fleet.
 * Accounts receive wildly unequal traffic (measured: 1189 to 5125 sessions,
 * a 4.3x spread), their weekly windows are not synchronised (2.1 to 5.8 days
 * elapsed at one reading), and the utilization figure is an integer percentage
 * of an absolute limit the provider never discloses.
 *
 * The way out is a ratio. If both the numerator and the denominator are
 * recorded per account,
 *
 *     capacity  =  work delivered  /  quota fraction consumed
 *
 * then unequal traffic cancels: an account that served twice the work also
 * burned twice the quota, and the ratio is unchanged. That makes the answer
 * extractable from ORDINARY traffic — no synthetic load, no accounts taken out
 * of rotation, no deadline.
 *
 * Two things have to be true for the numerator to be meaningful, and both are
 * why this file exists rather than a one-line counter:
 *
 *   Cache tokens dominate. Measured on this fleet, cache reads were 54.5B of
 *   57.3B tokens — 95%. A journal that logs only input/output describes 5% of
 *   what an account actually did.
 *
 *   Models are not interchangeable. A token of Opus and a token of Haiku do not
 *   cost the provider's meter the same, so every row carries its model and the
 *   analysis weights by it. Without that, a difference in model mix between two
 *   accounts reads as a difference in tier.
 *
 * Enabled by TEAMCLAUDE_QUOTA_JOURNAL=<path>. Off by default and fire-and-forget
 * on purpose: this is measurement, and measurement must never be able to fail a
 * user's request. Every error is swallowed; a full disk or a bad path costs
 * data, never traffic.
 */

import fs from 'node:fs';
import path from 'node:path';

let stream = null;
let failed = false;

function open() {
  if (stream || failed) return stream;
  const target = process.env.TEAMCLAUDE_QUOTA_JOURNAL;
  if (!target) { failed = true; return null; }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    stream = fs.createWriteStream(target, { flags: 'a' });
    // A journal that dies mid-run must not take the proxy with it, and must not
    // retry forever either — one failure disables it for the process lifetime.
    stream.on('error', () => { failed = true; stream = null; });
  } catch {
    failed = true;
  }
  return stream;
}

/** True when journalling is configured (cheap enough to call per request). */
export function journalEnabled() {
  return !failed && (stream !== null || !!process.env.TEAMCLAUDE_QUOTA_JOURNAL);
}

/**
 * Record one served response.
 *
 * @param {object} row
 * @param {string} row.account   account name (the unit of analysis)
 * @param {string|null} row.model
 * @param {object|null} row.usage  the provider's usage object, verbatim
 * @param {object|null} row.quota  the account's quota snapshot AFTER this response
 * @param {number|null} row.status HTTP status
 */
export function journalResponse({ account, model = null, usage = null, quota = null, status = null }) {
  const s = open();
  if (!s) return;
  try {
    const u = usage || {};
    s.write(JSON.stringify({
      t: Date.now(),
      account,
      model,
      status,
      // Verbatim token counts — no derived totals, so the analysis can reweight
      // later without a re-run.
      in: Number(u.input_tokens) || 0,
      out: Number(u.output_tokens) || 0,
      cc: Number(u.cache_creation_input_tokens) || 0,
      cr: Number(u.cache_read_input_tokens) || 0,
      // The denominator. Fractions as the provider reported them, plus the
      // window reset so a row can be attributed to the right weekly window —
      // rows either side of a reset describe different buckets and must never
      // be summed together.
      wk: quota?.unified7d ?? null,
      wkReset: quota?.unified7dReset ?? null,
      h5: quota?.unified5h ?? null,
      h5Reset: quota?.unified5hReset ?? null,
      wkFable: quota?.unified7dFable ?? null,
    }) + '\n');
  } catch {
    // never surface
  }
}
