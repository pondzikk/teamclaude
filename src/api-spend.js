// Spend ledger for pay-as-you-go Anthropic API key accounts.
//
// An API key account has no quota of its own to read: the Messages API sends
// only per-minute rate-limit headers, and the cost/usage reports need an Admin
// API credential that individual-plan orgs cannot get. So the proxy prices
// every response it relays on such an account itself and keeps a running
// monthly total. With `monthlyBudget` set on the account, that total becomes the
// account's weekly-bucket utilization (spent / budget), so the normal selection,
// weighted burn order and `maxUtilization` cap all work on it unchanged.
//
// The figure is an estimate: traffic that bypasses the proxy is invisible, and
// prices come from the table below (USD per million tokens).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// [input, output, cacheRead] per MTok. Cache writes are priced from input:
// 1.25x for the 5-minute TTL, 2x for the 1-hour TTL.
const PRICES = [
  [/^claude-fable-5-1|^claude-mythos-5-1/, [10, 50, 0.25]],
  [/^claude-fable-5|^claude-mythos-5/, [10, 50, 1]],
  [/^claude-opus-5-5/, [4, 20, 0.20]],
  [/^claude-opus-(5|4-[5-9])/, [5, 25, 0.5]],
  [/^claude-sonnet-5/, [2, 10, 0.20]],
  [/^claude-sonnet-4/, [3, 15, 0.3]],
  [/^claude-haiku-4/, [1, 5, 0.1]],
];
// Unknown model: price at the top tier so the budget errs on the safe side.
const FALLBACK = [10, 50, 1];
// Haiku 5.5 has two rate cards, picked by prompt length.
const HAIKU55_SMALL = [0.10, 0.50, 0.01];
const HAIKU55_LARGE = [0.50, 2.50, 0.05];
const HAIKU55_THRESHOLD = 100_000;

const num = (v) => Number(v) || 0;

/** USD cost of one exchange's `usage` object on `model`. */
export function costOf(model, usage) {
  if (!usage) return 0;
  const id = String(model || '').replace(/\[.*\]$/, '');
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreate = num(usage.cache_creation_input_tokens);
  const c1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  const c5m = usage.cache_creation ? num(usage.cache_creation.ephemeral_5m_input_tokens) : cacheCreate - c1h;

  let price;
  if (/^claude-haiku-5-5/.test(id)) {
    price = input + cacheRead + cacheCreate > HAIKU55_THRESHOLD ? HAIKU55_LARGE : HAIKU55_SMALL;
  } else {
    price = PRICES.find(([re]) => re.test(id))?.[1] || FALLBACK;
  }
  const [pin, pout, pread] = price;
  let usd = (input * pin + output * pout + cacheRead * pread
    + c5m * pin * 1.25 + c1h * pin * 2) / 1e6;
  if (usage.speed === 'fast') usd *= 2;
  return usd;
}

/** 'YYYY-MM' of `ms` (UTC) — the ledger's period key. */
export function monthKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** Start of the next UTC month after `ms`. */
export function nextMonthStart(ms = Date.now()) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function defaultLedgerPath() {
  return process.env.TEAMCLAUDE_APISPEND_FILE || join(homedir(), '.config', 'teamclaude-apispend.json');
}

/**
 * Persistent per-account monthly spend. Writes are debounced; the in-memory
 * copy is authoritative while the proxy runs.
 */
export class SpendLedger {
  constructor(path = defaultLedgerPath(), { flushMs = 5000 } = {}) {
    this.path = path;
    this.flushMs = flushMs;
    this.timer = null;
    try { this.data = JSON.parse(readFileSync(path, 'utf8')); } catch { this.data = {}; }
  }

  /** This month's entry for `name` (a fresh one when the month rolled over). */
  get(name, now = Date.now()) {
    const month = monthKey(now);
    const e = this.data[name];
    if (!e || e.month !== month) return { month, usd: 0, requests: 0, exhaustedAt: null };
    return e;
  }

  add(name, usd, now = Date.now()) {
    const e = { ...this.get(name, now) };
    e.usd += usd;
    e.requests += 1;
    this.data[name] = e;
    this._schedule();
    return e;
  }

  /** Upstream said the credit is gone: remember it until the month rolls over. */
  markExhausted(name, now = Date.now()) {
    const e = { ...this.get(name, now), exhaustedAt: new Date(now).toISOString() };
    this.data[name] = e;
    this._schedule();
    return e;
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  flush() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error(`[TeamClaude] cannot write API spend ledger ${this.path}: ${err.message}`);
    }
  }
}

/**
 * A credit-exhaustion rejection from the Messages API. Anthropic has answered
 * this both as 402 billing_error and as 400 "Your credit balance is too low".
 */
export function isCreditExhausted(status, bodyText) {
  if (status === 402) return true;
  if (status !== 400) return false;
  // Match the structured error only: a 400 can echo client-supplied text, and a
  // loose match on the raw body would let a request bench the account for a month.
  let err;
  try { err = JSON.parse(bodyText || '')?.error; } catch { return false; }
  return err?.type === 'billing_error'
    || (typeof err?.message === 'string' && err.message.startsWith('Your credit balance is too low'));
}
