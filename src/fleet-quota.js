/**
 * Fleet-level quota reporting.
 *
 * The proxy already ROUTES to an account that still has quota. What it never
 * did was fix up the quota figures it hands back: the client sees the raw
 * utilization of whichever single account happened to serve the request. For a
 * client that throttles ITSELF on those numbers that is actively wrong — the
 * pool can be wide open while the one account that answered sits at 100%.
 *
 * Measured failure this was written for: claude-mem's observer aborts and arms
 * a 15-minute cooldown when the reported five_hour utilization crosses 0.95 or
 * seven_day crosses 0.93 (its thresholds are hardcoded, no env knob). The proxy's
 * own switchThreshold is 0.98, so an account at 0.96 is still perfectly
 * selectable here while the client has already given up — and any request that
 * lands on a throttled account during revalidation reports 1.0 outright. The
 * observer stopped recording for 8 hours while the fleet had a healthy account
 * serving every other session with 200s.
 *
 * So: report the FLEET's headroom instead of one account's. Per bucket we take
 * the lowest utilization among the accounts that are actually available for this
 * request, and the reset that belongs to that same account, so "how much room is
 * left" answers for the pool the next request will really be routed to.
 *
 * Off unless TEAMCLAUDE_FLEET_QUOTA=1 — it rewrites data the client trusts, so
 * it stays opt-in and the default path is byte-identical to before.
 *
 * A NARROWER problem remains, and it needs its own switch. Our switchThreshold
 * is 0.98 but claude-mem gives up at 0.95, so between those an account is still
 * perfectly selectable here while the client has already stopped. Reporting the
 * fleet minimum does not close that band — the account really is at 0.96. The
 * band is only closable by deciding that THE PROXY IS THE AUTHORITY on whether
 * the pool can serve: if we are willing to route the request, the client has no
 * business refusing it. TEAMCLAUDE_FLEET_QUOTA_CAP=<0-1> encodes exactly that,
 * capping the reported utilization while an account is available. It is off by
 * default because it deliberately under-reports: set it below the tightest
 * client threshold you care about (0.89 clears claude-mem's 0.95/0.93), and
 * accept that a HUD fed by these numbers will never show the last stretch.
 */

/** Headers carrying the per-bucket figures, keyed by our internal quota field. */
const HEADER_MAP = [
  { util: 'anthropic-ratelimit-unified-5h-utilization', reset: 'anthropic-ratelimit-unified-5h-reset', status: 'anthropic-ratelimit-unified-5h-status', u: 'unified5h', r: 'unified5hReset' },
  { util: 'anthropic-ratelimit-unified-7d-utilization', reset: 'anthropic-ratelimit-unified-7d-reset', status: 'anthropic-ratelimit-unified-7d-status', u: 'unified7d', r: 'unified7dReset' },
  { util: 'anthropic-ratelimit-unified-7d_oi-utilization', reset: 'anthropic-ratelimit-unified-7d_oi-reset', status: 'anthropic-ratelimit-unified-7d_oi-status', u: 'unified7dFable', r: 'unified7dFableReset' },
];

/** Windows as they appear inside a `rate_limit_event`'s unifiedWindows. */
const WINDOW_MAP = [
  { name: 'five_hour', u: 'unified5h', r: 'unified5hReset' },
  { name: 'seven_day', u: 'unified7d', r: 'unified7dReset' },
  { name: 'seven_day_oi', u: 'unified7dFable', r: 'unified7dFableReset' },
  { name: 'seven_day_sonnet', u: 'unified7dSonnet', r: 'unified7dSonnetReset' },
];

// Live config object (the same one reloadAccounts mutates), so this can be
// switched on from ~/.config/teamclaude.json + POST /teamclaude/reload without
// restarting the proxy — a restart tears every MITM tunnel at once, which is a
// real cost to pay for flipping a boolean.
let liveConfig = null;
export function setFleetQuotaConfig(cfg) { liveConfig = cfg; }

export function fleetQuotaEnabled() {
  if (process.env.TEAMCLAUDE_FLEET_QUOTA === '1') return true;
  return liveConfig?.fleetQuota?.enabled === true;
}

/** Ceiling for reported utilization, or null when un-capped (the default). */
export function fleetQuotaCap() {
  const raw = process.env.TEAMCLAUDE_FLEET_QUOTA_CAP ?? liveConfig?.fleetQuota?.cap;
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : null;
}

/**
 * Lowest utilization per bucket across the accounts that could serve this
 * request, with each bucket's reset taken from the account that supplied that
 * minimum. Returns null when nothing is available (caller then leaves the
 * upstream figures alone — a genuinely exhausted fleet must still read as
 * exhausted).
 */
export function fleetQuota(accountManager, model = null, advisorModel = null) {
  const accounts = accountManager?.accounts;
  if (!Array.isArray(accounts) || !accounts.length) return null;

  const out = {};
  let any = false;

  for (const account of accounts) {
    // Reuse the very predicate that decides routing, so the numbers we report
    // describe exactly the pool the next request can actually land on.
    let usable = false;
    try { usable = accountManager._isAvailable(account, model, advisorModel); } catch { usable = false; }
    if (!usable) continue;

    const q = account.quota;
    if (!q) continue;
    any = true;

    for (const { u, r } of WINDOW_MAP) {
      const v = q[u];
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      if (out[u] == null || v < out[u]) {
        out[u] = v;
        out[r] = typeof q[r] === 'number' ? q[r] : null;
      }
    }
  }

  if (!any) return null;

  // Cap AFTER the minimum is known, so the cap applies to the pool's best
  // figure rather than to each account on the way in.
  const cap = fleetQuotaCap();
  if (cap != null) {
    for (const { u } of WINDOW_MAP) {
      if (typeof out[u] === 'number' && out[u] > cap) out[u] = cap;
    }
  }
  return out;
}

/** allowed / allowed_warning — never 'rejected', since an available account answered. */
function statusFor(util) {
  return util >= 0.9 ? 'allowed_warning' : 'allowed';
}

/**
 * Overwrite the quota headers in-place with fleet figures. Only touches headers
 * the upstream actually sent, so nothing new is invented for a response that
 * never carried quota information.
 */
export function rewriteQuotaHeaders(responseHeaders, fq) {
  if (!fq || !responseHeaders) return responseHeaders;
  for (const h of HEADER_MAP) {
    const util = fq[h.u];
    if (typeof util !== 'number') continue;
    if (h.util in responseHeaders) responseHeaders[h.util] = String(util);
    if (h.reset in responseHeaders && typeof fq[h.r] === 'number' && fq[h.r] > 0) {
      responseHeaders[h.reset] = String(Math.floor(fq[h.r] / 1000));
    }
    if (h.status in responseHeaders) responseHeaders[h.status] = statusFor(util);
  }
  return responseHeaders;
}

/**
 * Rewrite one `rate_limit_event` payload. Mutates and returns the object; a
 * payload of any other shape is returned untouched. The top-level utilization /
 * rateLimitType pair names the bucket closest to its limit, so it is recomputed
 * from the rewritten windows rather than copied.
 */
export function rewriteRateLimitPayload(payload, fq) {
  if (!fq || !payload || typeof payload !== 'object') return payload;
  const info = payload.rate_limit_info;
  if (!info || typeof info !== 'object') return payload;

  const windows = info.unifiedWindows;
  let worst = null;

  if (windows && typeof windows === 'object') {
    for (const w of WINDOW_MAP) {
      const win = windows[w.name];
      if (!win || typeof win !== 'object') continue;
      const util = fq[w.u];
      if (typeof util !== 'number') continue;
      win.utilization = util;
      if (typeof fq[w.r] === 'number' && fq[w.r] > 0) win.resetsAt = Math.floor(fq[w.r] / 1000);
      if ('status' in win) win.status = statusFor(util);
      if (!worst || util > worst.util) worst = { util, name: w.name, resetsAt: win.resetsAt };
    }
  }

  // Fall back to the bucket named at the top level when there are no windows.
  if (!worst) {
    const byName = WINDOW_MAP.find(w => w.name === info.rateLimitType);
    const util = byName ? fq[byName.u] : fq.unified7d;
    if (typeof util === 'number') {
      worst = { util, name: info.rateLimitType, resetsAt: byName && typeof fq[byName.r] === 'number' ? Math.floor(fq[byName.r] / 1000) : info.resetsAt };
    }
  }

  if (worst) {
    info.utilization = worst.util;
    if (worst.name) info.rateLimitType = worst.name;
    if (typeof worst.resetsAt === 'number') info.resetsAt = worst.resetsAt;
    info.status = statusFor(worst.util);
    // An available account answered, so the pool is not in overage.
    if ('isUsingOverage' in info) info.isUsingOverage = false;
  }
  return payload;
}

/**
 * Rewrite the `data:` line of one complete SSE event when it carries a
 * rate_limit_event. Returns the event text unchanged for everything else, which
 * is the overwhelming majority of frames — the cheap `includes` guard keeps the
 * hot path free of JSON parsing.
 */
export function rewriteSSEEvent(eventText, fq) {
  if (!fq || !eventText || !eventText.includes('rate_limit_event')) return eventText;

  const lines = eventText.split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]' || !raw.includes('rate_limit_event')) continue;
    try {
      const payload = JSON.parse(raw);
      if (payload?.type !== 'rate_limit_event') continue;
      lines[i] = `data: ${JSON.stringify(rewriteRateLimitPayload(payload, fq))}`;
      changed = true;
    } catch {
      // Not valid JSON (or a partial frame that slipped through) — leave it be.
      // Relaying the original is always safe; inventing one is not.
    }
  }

  return changed ? lines.join('\n') : eventText;
}
