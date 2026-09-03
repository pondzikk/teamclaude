/**
 * Per-model circuit breaker for PROVIDER-SIDE outages.
 *
 * When Anthropic degrades one model family (observed 2026-09-03: "Elevated
 * errors ... Mythos/Fable 5.1, Opus 5, Opus 4.8, Opus 4.6" while Haiku served
 * normally), every account fails the same way. The proxy cannot tell that from
 * a single failure, so each attempt waits out the full headers timeout and the
 * client retries into the same wall — and the surfaced error points at the
 * proxy ("check your inference gateway"), not at the provider.
 *
 * THE HARD CONSTRAINT: this must never misfire on a bad LOCAL connection —
 * a train, a tunnel, hotel wifi. There, failing fast is exactly wrong: the
 * request should keep its long timeout and be retried, because the next
 * attempt may well succeed.
 *
 * Three independent guards keep the two cases apart:
 *
 *   1. LOCAL-FAULT CODES NEVER COUNT. DNS and connect-phase failures
 *      (ENOTFOUND, EAI_AGAIN, ECONNREFUSED, ENETUNREACH, EHOSTUNREACH,
 *      connect timeouts) mean *we* could not reach the provider. Those are the
 *      signature of no signal, and they are ignored outright.
 *
 *   2. PROOF THE NETWORK WORKS. The breaker only arms while some upstream
 *      request — ANY model, ANY account — succeeded within the last
 *      `healthWindowMs`. With no signal nothing succeeds, so that proof
 *      expires and the breaker can never trip. This is the guard that makes
 *      the train case safe: silence disarms it.
 *
 *   3. TWO DISTINCT ACCOUNTS. One account failing is that account's problem
 *      (its own rate limit, a poisoned socket). The same model failing on two
 *      different credentials, while other traffic is flowing, is the provider.
 *
 * A trip is short (`openMs`) and self-healing: any success for the model clears
 * it immediately, so a recovering provider is picked up on the next request
 * rather than waiting out a timer.
 */

// Failures that mean "we could not reach them" — local network, never the model.
const LOCAL_FAULT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN',              // DNS: no resolver, no signal
  'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',             // TCP never established
  'ECONNABORTED', 'EPIPE',
]);

/** True when this error says the local network failed, not the provider. */
export function isLocalFault(err) {
  if (!err) return false;
  if (LOCAL_FAULT_CODES.has(err.code)) return true;
  // undici wraps connect-phase failures; the cause carries the real code.
  const cause = err.cause;
  if (cause && LOCAL_FAULT_CODES.has(cause.code)) return true;
  // A bare "fetch failed" with no post-connect marker is a connect-phase
  // failure in practice — treat it as local and never count it.
  if (!err.code && typeof err.message === 'string' && err.message.includes('fetch failed')) return true;
  return false;
}

export class ModelHealth {
  /**
   * @param {object} opts
   * @param {boolean} opts.enabled          master switch (default true)
   * @param {number}  opts.minAccounts      distinct accounts that must fail (default 2)
   * @param {number}  opts.healthWindowMs   how recently something must have succeeded (default 120s)
   * @param {number}  opts.openMs           how long a trip lasts (default 60s)
   * @param {() => number} opts.now         injectable clock for tests
   */
  constructor({ enabled = true, minAccounts = 2, healthWindowMs = 120_000, openMs = 60_000, now = () => Date.now() } = {}) {
    this.enabled = enabled;
    this.minAccounts = Math.max(2, minAccounts);
    this.healthWindowMs = healthWindowMs;
    this.openMs = openMs;
    this._now = now;
    /** Last time ANY upstream request succeeded — the network-is-up proof. */
    this.lastSuccessAt = 0;
    /** model → { accounts:Set<number>, firstFailAt:number, openUntil:number, reason:string } */
    this.models = new Map();
  }

  _entry(model) {
    let e = this.models.get(model);
    if (!e) { e = { accounts: new Set(), firstFailAt: 0, openUntil: 0, reason: '' }; this.models.set(model, e); }
    return e;
  }

  /** Any upstream success: proves the network works and clears this model. */
  recordSuccess(model) {
    const t = this._now();
    this.lastSuccessAt = t;
    if (!model) return;
    const e = this.models.get(model);
    if (e) this.models.delete(model);
  }

  /**
   * A provider-side failure: connected and spoke to them, but got a headers
   * timeout or a 5xx. Callers must NOT pass local faults (see isLocalFault) —
   * `record()` re-checks anyway so a mistake cannot arm the breaker.
   * @returns {boolean} true if this failure tripped the model open
   */
  recordFailure(model, accountIndex, err = null) {
    if (!this.enabled || !model || accountIndex == null) return false;
    if (isLocalFault(err)) return false;              // guard 1
    const t = this._now();
    // guard 2 — no recent success anywhere means we have no proof the network
    // is up, so we cannot attribute anything to the provider. This is the
    // train case: everything fails, nothing succeeds, breaker stays disarmed.
    if (t - this.lastSuccessAt > this.healthWindowMs) return false;

    const e = this._entry(model);
    if (!e.firstFailAt) e.firstFailAt = t;
    e.accounts.add(accountIndex);
    if (e.accounts.size < this.minAccounts) return false;   // guard 3
    if (e.openUntil > t) return false;                       // already open
    e.openUntil = t + this.openMs;
    e.reason = `${e.accounts.size} accounts failed the same way`;
    return true;
  }

  /** Is this model currently short-circuited? */
  isOpen(model) {
    if (!this.enabled || !model) return false;
    const e = this.models.get(model);
    if (!e) return false;
    if (e.openUntil <= this._now()) {
      // Window elapsed — forget everything so the next request probes for real.
      this.models.delete(model);
      return false;
    }
    return true;
  }

  /** Seconds until an open model is probed again (for Retry-After). */
  retryAfterSeconds(model) {
    const e = this.models.get(model);
    if (!e) return 0;
    return Math.max(1, Math.ceil((e.openUntil - this._now()) / 1000));
  }

  /** Diagnostics for /teamclaude/status. */
  getStatus() {
    const t = this._now();
    const open = [];
    for (const [model, e] of this.models) {
      if (e.openUntil > t) open.push({ model, retryAfter: Math.ceil((e.openUntil - t) / 1000), accounts: e.accounts.size });
    }
    return {
      enabled: this.enabled,
      networkHealthy: this.lastSuccessAt > 0 && (t - this.lastSuccessAt) <= this.healthWindowMs,
      lastSuccessAgoMs: this.lastSuccessAt ? t - this.lastSuccessAt : null,
      openModels: open,
    };
  }
}
