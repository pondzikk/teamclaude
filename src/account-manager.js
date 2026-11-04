import { SpendLedger, costOf, nextMonthStart } from './api-spend.js';
import { refreshAccessToken, isTokenExpiringSoon, isTokenExpired } from './oauth.js';
import { sameIdentity } from './identity.js';
import { weeklyBucketForModel, modelGlobMatches, isFableModel } from './model.js';
import { SessionTracker } from './session-tracker.js';

// Re-exported for callers that import these model helpers from here.
export { isFableModel, parseRequestModel, parseAdvisorModel } from './model.js';

// How long after a successful token refresh a forced (post-401) refresh is
// suppressed. Long enough to cover the 401s from requests already in flight
// when the token turned over, short enough that a genuinely bad new token
// recovers on the next request rather than staying stuck.
const FORCED_REFRESH_FLOOR_MS = 10_000;

// Quota fields that survive a restart: utilization levels and their reset
// windows, learned passively from upstream responses. Transient/derived state
// (probing, requalify, rateLimitedUntil) is intentionally excluded.
const PERSISTED_QUOTA_FIELDS = [
  'unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable',
  'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset', 'unifiedStatus',
  'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt',
];

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,            // utilization 0-1
    unified7d: null,            // utilization 0-1
    unified7dSonnet: null,      // utilization 0-1 (Sonnet-specific weekly bucket)
    unified7dFable: null,       // utilization 0-1 (Fable-specific weekly bucket)
    unified5hReset: null,       // ms timestamp
    unified7dReset: null,       // ms timestamp
    unified7dSonnetReset: null, // ms timestamp
    unified7dFableReset: null,  // ms timestamp
    unifiedStatus: null,        // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

/**
 * Per-account hard ceiling on the subscription buckets, from config
 * `maxUtilization: { fiveHour, weekly }` as fractions (e.g. 0.8). Meant for an
 * account lent by someone else ("never take more than 80% of her 5h window"):
 * unlike switchThreshold it is never crossed on purpose — see isOverHardCap.
 * Values may be fractions (0.8) or percentages (80). It FAILS CLOSED: a cap
 * that is present but unreadable (typo'd key, bad value) blocks the account
 * with { invalid: true } instead of silently leaving it uncapped.
 */
const CAP_KEYS = { fiveHour: 'fiveHour', five_hour: 'fiveHour', '5h': 'fiveHour', weekly: 'weekly', seven_day: 'weekly', '7d': 'weekly' };

export function normalizeCap(cap, name = '?') {
  if (cap == null) return null;
  const invalid = (why) => {
    console.error(`[TeamClaude] maxUtilization on "${name}" is invalid (${why}) — the account is BLOCKED until it is fixed. Expected e.g. {"fiveHour":0.8,"weekly":0.85}`);
    return { invalid: true };
  };
  if (typeof cap !== 'object' || Array.isArray(cap)) return invalid(`got ${JSON.stringify(cap)}`);
  const out = {};
  for (const [k, raw] of Object.entries(cap)) {
    const key = CAP_KEYS[k];
    if (!key) return invalid(`unknown key "${k}"`);
    let v = Number(raw);
    if (Number.isFinite(v) && v > 1 && v <= 100) v /= 100; // 80 means 80%
    if (!(Number.isFinite(v) && v > 0 && v <= 1)) return invalid(`${k}=${JSON.stringify(raw)}`);
    out[key] = v;
  }
  return Object.keys(out).length ? out : invalid('no limit given');
}

function budgetOf(acct) {
  const v = Number(acct.monthlyBudget);
  return acct.type === 'apikey' && Number.isFinite(v) && v > 0 ? v : null;
}

const pct = (v) => (v == null ? '?' : `${Math.round(v * 100)}%`);

// Build a fresh in-memory account record from a config/disk account object.
// Shared by the constructor and addAccount() so the field set can never drift
// between startup accounts and runtime-added ones (a divergence here once left
// runtime-added accounts without `inFlight`, hanging every request in admit()).
function makeAccount(acct, index) {
  return {
    index,
    name: acct.name,
    type: acct.type,
    accountUuid: acct.accountUuid || null,
    orgUuid: acct.orgUuid || null,
    orgName: acct.orgName || null,
    priority: acct.priority || 0,
    disabled: acct.disabled || false,
    maxUtilization: normalizeCap(acct.maxUtilization, acct.name),
    // Fallback-only (e.g. an account lent by someone else): never chosen by
    // automatic selection while any non-fallback account can serve the request.
    // See _fallbackHeld. Explicit pins still reach it.
    fallbackOnly: acct.fallbackOnly === true,
    upstream: acct.upstream || null,
    // Wire protocol the upstream speaks. 'openai' routes this account's
    // /v1/messages traffic through the Chat Completions translator
    // (src/openai-translate.js); anything else — including the default null —
    // means the native Anthropic Messages API and behaves exactly as before.
    protocol: acct.protocol === 'openai' ? 'openai' : null,
    // Ask an OpenAI backend for token usage on streaming responses
    // (stream_options.include_usage); set false for a backend that rejects it.
    streamUsage: acct.streamUsage !== false,
    modelMap: acct.modelMap || null,
    // Fields to drop from request bodies for this account (third-party upstreams
    // that reject e.g. `context_management`). See server.js stripBodyFields.
    stripRequestFields: acct.stripRequestFields || null,
    models: acct.models || null,
    // Alternative quota source for a backend that reports none of its own.
    // 'kimi' reads the web console gateway (src/kimi-quota.js) using webToken;
    // null (the default) means quota comes from response headers as usual.
    quotaProvider: acct.quotaProvider || null,
    webToken: acct.webToken || null,
    // Monthly USD credit of a pay-as-you-go API key account (src/api-spend.js).
    // The proxy's own spend estimate against it drives the weekly bucket.
    monthlyBudget: budgetOf(acct),
    credential: acct.accessToken || acct.apiKey,
    refreshToken: acct.refreshToken || null,
    expiresAt: acct.expiresAt || null,
    status: 'active',
    // No quota is known at startup, so start probing: the first response for
    // an account reveals its weekly limit and triggers re-evaluation.
    probing: true,
    quota: emptyQuota(),
    usage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      // Cache tokens are the DOMINANT term in real traffic — measured on a live
      // fleet, cache reads were 54.5B of 57.3B tokens (95%). Counting only
      // input/output measures ~5% of what an account actually delivered, which
      // is useless for any per-account capacity or cost question.
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalRequests: 0,
      // Per-model split. Models do not consume quota at the same rate per
      // token, so a bare token sum is only comparable across accounts that
      // happened to run the same model mix — which they never do.
      byModel: {},
      lastUsed: null,
    },
    rateLimitedUntil: null,
    throttledAt: null,
    // Storm control (see admit/release): in-flight upstream requests and the
    // time this account last became the current one (starts a ramp window).
    inFlight: 0,
    rampStartedAt: null,
    // Rate-limit pause (see pauseAccount): a short window during which new
    // requests wait in admit() rather than flooding — set from a 429's
    // retry-after. Distinct from `throttled`/rateLimitedUntil: it does NOT
    // make the account unavailable, so selection never rotates away from it.
    pausedUntil: null,
    // When this account's token was last successfully refreshed. Gates forced
    // (post-401) refreshes so a burst of stale in-flight requests can't rotate
    // the refresh-token family once per request — see ensureTokenFresh.
    _lastRefreshAt: null,
  };
}

// Does a declared `models` entry name `model`? The declared side may carry a
// trailing [Nm] context-length suffix (e.g. "deepseek-v4-pro[1m]"); we match it
// against a bare request too. Shared by _accountOwnsModel's two lookups so the
// predicate can't drift.
function modelMatches(declared, model) {
  return declared === model || declared.replace(/\[\d+m\]$/, '') === model;
}

// Lexicographic compare for the selection keys _pickForNewSession builds.
function keyLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

// A representative model for a route's own globs, used to report what that route
// does right now (which accounts may serve it, and which one it would pick).
// Taken from the route object rather than looked up by name, so two routes
// sharing a name are still each described by their own globs.
function sampleModelFor(route) {
  return route.match[0].replace(/\*/g, '') || 'model';
}

// Same upstream backend: both native Anthropic (no `upstream`), or the same
// third-party upstream speaking the same protocol.
function sameBackend(a, b) {
  return (a.upstream || null) === (b.upstream || null) && (a.protocol || null) === (b.protocol || null);
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, { refreshFn = refreshAccessToken, throttleProbeFloorMs, forcedRefreshFloorMs = FORCED_REFRESH_FLOOR_MS, routes, ramp, affinity, reserveFableAccounts, distributeSessions = false, sessionTracker, spendLedger } = {}) {
    // How long a just-minted token is trusted against a forced refresh.
    this._forcedRefreshFloorMs = forcedRefreshFloorMs;
    // Injectable for tests (mirrors Prober's probeFn); defaults to the real
    // OAuth token refresh.
    this._refreshFn = refreshFn;
    this.accounts = accounts.map((acct, index) => makeAccount(acct, index));
    this.spendLedger = spendLedger || new SpendLedger();
    for (const a of this.accounts) this._applySpend(a);
    this.currentIndex = 0;
    // Session awareness (issue #109). The tracker is always on (passive — it just
    // observes the x-claude-code-session-id header for the status readout).
    // `distributeSessions` gates the behavioural change: keep each session on its
    // account for cache reuse, but spread NEW sessions across equal-priority
    // accounts by load instead of funnelling them all onto the current one.
    this.sessionTracker = sessionTracker || new SessionTracker();
    this.distributeSessions = !!distributeSessions;
    // Ephemeral per-route manual pins (routeName → account index). Not persisted:
    // like the global manual switch (currentIndex) these are runtime overrides that
    // bias selection for a route's models and reset on restart. A pinned account
    // that becomes ineligible is skipped — routing falls back to best-available.
    this.routePins = new Map();
    this.switchThreshold = switchThreshold;
    this.setRoutes(routes);
    // Storm control: when rotation switches to a fresh account, a burst of
    // in-flight requests (e.g. dozens of agents failing over together) would all
    // hit it at once and instantly throttle it — cascading down the fleet
    // (issue #84). admit() caps concurrent requests to a just-switched account
    // and ramps the cap up over a short window, so the first few reveal whether
    // it's also near-exhausted before the whole herd commits.
    this.ramp = {
      enabled: true,
      startConc: 1,       // concurrent requests allowed at the instant of a switch
      stepConc: 1,        // cap increase per stepMs
      stepMs: 250,        // → +stepConc every 250ms (default ramps ~4 req/s)
      windowMs: 30_000,   // after this, pacing stops entirely (cap = Infinity)
      pollMs: 50,         // how often a waiting request re-checks the cap
      ...ramp,
    };
    // When every account reads as over-quota we would otherwise refuse locally
    // forever (a stale cached utilization is never re-validated because no
    // request is ever sent). Instead, allow one real upstream probe at most this
    // often to refresh the cached quota. See _selectProbe.
    this.probeIntervalMs = 60_000;
    this._nextProbeAt = 0;
    // Minimum time a 429 hold is respected verbatim before a throttled account
    // becomes probe-eligible (see _isProbeable). Long enough to honor a genuine
    // retry-after, short enough that a stale hold cannot pin the fleet.
    this.throttleProbeFloorMs = throttleProbeFloorMs
      ?? (Number(process.env.TEAMCLAUDE_THROTTLE_PROBE_FLOOR_MS) || 60_000);
    // Session affinity: cache-preserving load spreading. Anthropic's prompt
    // cache is PER-ACCOUNT, so a session that hops accounts re-reads its whole
    // context cold on every hop (10× input cost, huge TTFT). Affinity keeps
    // each Claude Code session (keyed by metadata.user_id's session_id) pinned
    // to ONE account for its lifetime and only rebinds when that account can no
    // longer serve it (quota/disabled) — one unavoidable cold read, then warm
    // again. Load is spread by placing NEW sessions (no cache anywhere yet) on
    // the least-loaded account of the best priority tier, so concurrent
    // sessions stop funneling onto the single global current account.
    // `sessions` maps sessionId → { index, lastSeen }. Bindings idle past the
    // TTL are swept: the upstream cache (≤1h) is cold by then anyway, so a
    // returning session rebinds for free.
    const aff = affinity || {};
    this.affinity = {
      enabled: process.env.TEAMCLAUDE_SESSION_AFFINITY === '0' ? false : aff.enabled !== false,
      maxPerAccount: Number(process.env.TEAMCLAUDE_MAX_SESSIONS_PER_ACCOUNT) || aff.maxPerAccount || 8,
      ttlMs: (Number(process.env.TEAMCLAUDE_SESSION_TTL_MINUTES) || aff.ttlMinutes || 60) * 60_000,
      // Hard size cap: session ids are client-supplied (every one-shot
      // `claude -p` is a fresh id), so TTL alone can't bound the map.
      maxTracked: Number(process.env.TEAMCLAUDE_MAX_TRACKED_SESSIONS) || aff.maxTracked || 5000,
      // How a NEW session is placed once every eligible account is at/over the
      // soft cap (fleet saturated — the normal state for an operator running
      // dozens of sessions):
      //   'load'     — balance by load; priority is only a late tiebreak. Default.
      //                Right for a fleet of interchangeable accounts.
      //   'priority' — balance by load WITHIN the best available priority tier;
      //                spill to the next tier only when the whole tier is
      //                unavailable (exhausted / paused / excluded). A strict burn
      //                order — but a tier that is down to one usable account
      //                carries the entire fleet, which is a real cost: measured
      //                85 sessions on one account once its tier partner crossed
      //                switchThreshold.
      //   'weighted' — EVERY available account takes work, but a share inversely
      //                proportional to its priority: the placer minimises
      //                (load+1) × (priority+1), so priority 0 takes ~2× the
      //                sessions of priority 1, ~3× of priority 2, ~4× of
      //                priority 3. Nothing is starved and nothing is a
      //                bottleneck — for "the shared account should still be
      //                used, just more slowly" rather than "not at all".
      overCapOrder: ['load', 'priority', 'weighted'].includes(process.env.TEAMCLAUDE_OVER_CAP_ORDER)
        ? process.env.TEAMCLAUDE_OVER_CAP_ORDER
        : (['load', 'priority', 'weighted'].includes(aff.overCapOrder) ? aff.overCapOrder : 'load'),
      // Expiry priority (first-expire-first-out): an account whose governing weekly
      // window resets within this many hours has PERISHABLE quota — anything unburned
      // at reset is lost — so it temporarily drops to the drain-first tier regardless
      // of its configured spare-priority (see _pickForNewSession). 0 = off (default).
      expiryHours: Number(process.env.TEAMCLAUDE_EXPIRY_HOURS) || aff.expiryHours || 0,
      // Overload flattening. Spare-priority ordering is right when the fleet is
      // idle — it protects the accounts the operator wants held back. Under heavy
      // fanout it is the wrong shape: the top tier absorbs most of the work and
      // rate-limits while spared accounts sit idle. So above this many TOTAL bound
      // sessions, every account below `flattenKeepPriority` collapses to the
      // drain-first tier and the fleet spreads evenly; the configured burn order
      // returns as soon as the load drops. Temporary and stateless — it is
      // recomputed per placement, and existing bindings are never moved.
      // 0 = off (default).
      flattenAbove: Number(process.env.TEAMCLAUDE_FLATTEN_ABOVE) || aff.flattenAbove || 0,
      // Priorities at or above this are NEVER flattened: the reserve that must
      // survive a busy period (e.g. an account approved for a specific class of
      // work and deliberately kept out of general rotation — flattening it would
      // drain exactly the capacity it is being held for). null = nothing is
      // protected, i.e. flattening applies to the whole fleet.
      flattenKeepPriority: process.env.TEAMCLAUDE_FLATTEN_KEEP_PRIORITY != null
        ? Number(process.env.TEAMCLAUDE_FLATTEN_KEEP_PRIORITY)
        : (aff.flattenKeepPriority ?? null),
    };
    // Spend the band between switchThreshold and a genuinely full bucket, but
    // only once nothing else can serve the request (see _selectLastResort).
    this.lastResort = process.env.TEAMCLAUDE_LAST_RESORT === '0' ? false : (aff.lastResort !== false);
    // Fable-reserve: Fable meters its OWN small weekly bucket, separate from the
    // shared 5h/weekly. Once most accounts' Fable bucket is spent, only the few
    // accounts that still have Fable headroom can serve Fable — but nothing stops
    // ordinary Opus/Sonnet traffic from landing on exactly those accounts and
    // burning their SHARED 5h/weekly quota to zero, which takes them out for
    // EVERYTHING including Fable. With this on, a NON-Fable request de-prioritizes
    // any account that still has Fable headroom, steering general traffic onto
    // accounts whose Fable is already exhausted (they can't serve Fable anyway).
    // Soft: it's only a ranking preference — when the Fable-spent accounts are
    // themselves unavailable, non-Fable traffic still falls through to a
    // Fable-capable one rather than being blocked.
    this.reserveFable = process.env.TEAMCLAUDE_RESERVE_FABLE === '1' ? true
      : process.env.TEAMCLAUDE_RESERVE_FABLE === '0' ? false
      : !!reserveFableAccounts;
    this.sessions = new Map();
    // Bound-session count per account index, maintained incrementally by
    // _bindSession/_sweepSessions so placement never scans the whole map.
    this._sessionCounts = new Array(this.accounts.length).fill(0);
    this._nextSweepAt = 0;
  }

  /** Sessions currently bound to account `index` (the affinity load metric). */
  _sessionCount(index) {
    return this._sessionCounts[index] || 0;
  }

  /** Sessions bound across the whole fleet — the overload signal for
   *  affinity.flattenAbove. */
  _totalBoundSessions() {
    let n = 0;
    for (const c of this._sessionCounts) n += c || 0;
    return n;
  }

  /** True while the fleet carries more than affinity.flattenAbove sessions. */
  _isOverloaded() {
    return this.affinity.flattenAbove > 0
      && this._totalBoundSessions() > this.affinity.flattenAbove;
  }

  /**
   * Effective placement priority for `account` (lower = drained first). Two
   * TEMPORARY demotions stack on top of the configured priority:
   *   FEFO (affinity.expiryHours) — quota resetting within the window is
   *     perishable, so it burns first whatever spare-priority it carries.
   *   Overload flattening (affinity.flattenAbove) — while the fleet is loaded,
   *     spare tiers below flattenKeepPriority collapse to 0 so every usable
   *     account takes a full share. Tiers at/above flattenKeepPriority are left
   *     alone, so a deliberately reserved account is not drained by a busy spell.
   * Both are recomputed per placement and never move an existing binding.
   * `resetAt` is returned too because callers reuse it as the fine tiebreak.
   */
  _effectivePriority(account, model, now, overloaded) {
    const resetAt = this._governingWeeklyReset(account, model);
    // A fallback-only account is never demoted into the drain-first tier — it
    // is held back entirely while own accounts can serve (see _fallbackHeld),
    // and once they cannot its configured priority is all that matters.
    if (account.fallbackOnly) return { prio: account.priority || 0, resetAt };
    let prio = (this.affinity.expiryHours > 0 && resetAt
      && resetAt - now <= this.affinity.expiryHours * 3600_000) ? 0 : (account.priority || 0);
    const keep = this.affinity.flattenKeepPriority;
    if (overloaded && (keep == null || prio < keep)) prio = 0;
    return { prio, resetAt };
  }

  /**
   * The fallback-only gate, shared by EVERY automatic selection path: true when
   * `account` is fallbackOnly and at least one non-fallback account can serve
   * this request right now — available for `model` under the usual _isAvailable
   * rules (status, quota/switchThreshold, hard cap, route membership) and not in
   * the request's `exclude` set. Only once every own account is unusable does a
   * fallback-only account become eligible, and then still subject to its own
   * hard cap. Explicit pins never consult this.
   *
   * Decided on the EXECUTOR model only. An own account that can serve the
   * executor but has no headroom in the advisor's family bucket still holds the
   * fallback account back: the request takes the usual advisor degrade on the
   * own account (losing at most the advisor sub-call) instead of moving the
   * whole session — and its shared quota — onto a lent account. Only an own
   * account over its HARD cap for the advisor is treated as unusable, exactly
   * as the advisor-degrade passes do (_withAdvisorCapExcluded).
   *
   * With no model (status/eligibility, the switch endpoint, session-reset
   * switching) route membership cannot be checked, so only own accounts on the
   * same backend count — a kimi/OpenAI-protocol account never holds back a
   * native Claude account.
   */
  _fallbackHeld(account, model = null, advisorModel = null, exclude = null) {
    if (!account?.fallbackOnly) return false;
    const skip = this._withAdvisorCapExcluded(exclude, advisorModel);
    return this.accounts.some(a => !a.fallbackOnly && !skip?.has(a.index)
      && (model || sameBackend(a, account))
      && this._isAvailable(a, model));
  }

  /** Whether `account` can take an automatic request for `model` right now
   * (status, holds, quota/switchThreshold, hard cap, route membership). */
  isUsable(account, model = null) {
    return this._isAvailable(account, model);
  }

  /** Whether a request already headed to `account` should give it up for an
   * own account that became usable meanwhile (e.g. while it waited in admit()).
   * False when `account` is the operator's manual route pin for this model —
   * the pin is an explicit choice and re-selection would return it anyway. */
  shouldLeaveFallback(account, model = null, advisorModel = null, exclude = null) {
    if (!account?.fallbackOnly) return false;
    if (this._pinnedAccountForModel(model, advisorModel)?.index === account.index) return false;
    return this._fallbackHeld(account, model, advisorModel, exclude);
  }

  /** Toggle `fallbackOnly` at runtime (config hot reload). Returns true when it
   * changed. */
  setFallbackOnly(accountIndex, on) {
    const account = this.accounts[accountIndex];
    if (!account || account.fallbackOnly === !!on) return false;
    account.fallbackOnly = !!on;
    console.log(`[TeamClaude] "${account.name}" is ${on ? 'now fallback-only (used only once every own account is unusable)' : 'no longer fallback-only'}`);
    return true;
  }

  /** Drop session bindings idle past the TTL. */
  _sweepSessions(now = Date.now()) {
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.affinity.ttlMs) {
        this._sessionCounts[s.index] = Math.max(0, this._sessionCount(s.index) - 1);
        this.sessions.delete(id);
      }
    }
  }

  /** Sweep at most every 30s — the request path calls this per request and a
   * full-map walk per request is wasted work (expiry precision is irrelevant
   * next to a 60-minute TTL). */
  _maybeSweepSessions(now = Date.now()) {
    if (now < this._nextSweepAt) return;
    this._nextSweepAt = now + 30_000;
    this._sweepSessions(now);
  }

  /** Record (or move) a session binding, keeping the per-account counts and the
   * size cap: at maxTracked the stalest binding is evicted so client-supplied
   * session ids can't grow the map without bound. */
  _bindSession(sessionId, index) {
    const prev = this.sessions.get(sessionId);
    if (prev) {
      this._sessionCounts[prev.index] = Math.max(0, this._sessionCount(prev.index) - 1);
    } else if (this.sessions.size >= this.affinity.maxTracked) {
      let oldestId = null;
      let oldestSeen = Infinity;
      for (const [id, s] of this.sessions) {
        if (s.lastSeen < oldestSeen) { oldestSeen = s.lastSeen; oldestId = id; }
      }
      if (oldestId != null) {
        const s = this.sessions.get(oldestId);
        this._sessionCounts[s.index] = Math.max(0, this._sessionCount(s.index) - 1);
        this.sessions.delete(oldestId);
      }
    }
    this.sessions.set(sessionId, { index, lastSeen: Date.now() });
    this._sessionCounts[index] = this._sessionCount(index) + 1;
  }

  /**
   * Session-affine account selection — the cache-preserving entry point used
   * for every request that carries a session id. Sticky: the session's bound
   * account is returned for as long as it can serve the request (rate-limit
   * pauses do NOT unbind — admit() waits them out on the same account, keeping
   * the cache). The binding is REBOUND only when the bound account is truly
   * unavailable (disabled/error/throttled/shared quota spent). Everything
   * transient or model-scoped is a DETOUR instead: the request is served by
   * another account while the binding — and the warm cache behind it — stays
   * put. Requests with no session id, and fleets with affinity disabled, take
   * the legacy getActiveAccount walk unchanged.
   */
  getAccountForSession(sessionId, exclude = null, model = null, advisorModel = null) {
    if (!sessionId || !this.affinity.enabled) {
      return this.getActiveAccount(exclude, model, advisorModel);
    }
    this.refreshExpiredQuotas();
    this._maybeSweepSessions();

    // A manual route pin is an operator override and outranks affinity, exactly
    // as it outranks the legacy current account. The binding is not rewritten:
    // pins are ephemeral, so when the pin lifts the session returns to its own
    // account (whose cache may still be live).
    const pinned = this._pinnedAccountForModel(model, advisorModel);
    if (pinned && this._isAvailable(pinned, model, advisorModel) && !exclude?.has(pinned.index)) {
      return pinned;
    }

    const bound = this.sessions.get(sessionId);
    let heldBack = false;
    if (bound) {
      const acct = this.accounts[bound.index];
      if (acct) {
        const excluded = exclude?.has(acct.index);
        // Fallback-only bound account: as soon as an own account can serve this
        // request (executor-wise — the same set the advisor-degrade pass below
        // would choose from), the session moves back for good: rebind, never
        // stay or detour. One cold cache read beats draining a lent account.
        heldBack = this._fallbackHeld(acct, model, advisorModel, exclude);
        if (!excluded && !heldBack && this._isAvailable(acct, model, advisorModel)) {
          bound.lastSeen = Date.now();
          return acct;
        }
        // Advisor degrade (soft, mirrors getActiveAccount): when the bound
        // account can serve the executor but not the advisor model, staying
        // put loses one advisor sub-call while moving would go cache-cold on
        // the session's entire context — stay put.
        if (!excluded && !heldBack && advisorModel && this._isAvailable(acct, model) && !this.isOverHardCap(acct, advisorModel)) {
          bound.lastSeen = Date.now();
          return acct;
        }
        // DETOUR, not rebind: `exclude` is per-request transient (an account
        // already tried this request is healthy for the next one — see
        // forwardRequest), and a route/family-bucket bar is per-model (the
        // account still serves the session's other models warm). In both cases
        // the binding stays; only this request is served elsewhere. The detour
        // target is deterministic (same selection key), so repeated detours
        // land on the same account and warm it as a de-facto secondary.
        if (!heldBack && (excluded || this._isAvailable(acct))) {
          bound.lastSeen = Date.now();
          const detour = this._pickForNewSession(exclude, model, advisorModel)
            || (advisorModel ? this._pickForNewSession(this._withAdvisorCapExcluded(exclude, advisorModel), model, null) : null);
          if (detour) return detour;
          return this.getActiveAccount(exclude, model, advisorModel);
        }
        // Fall through: the account is truly unavailable → rebind below.
      }
    }

    let pick = this._pickForNewSession(exclude, model, advisorModel);
    // Advisor degrade for placement too: never fail a session's placement over
    // the advisor model when some account can serve the executor.
    if (!pick && advisorModel) pick = this._pickForNewSession(this._withAdvisorCapExcluded(exclude, advisorModel), model, null);
    if (!pick) {
      // Nothing eligible — run the legacy walk for its exhausted-fleet probe /
      // synthetic-429 handling. Deliberately not bound: the next request
      // re-picks once an account frees up.
      return this.getActiveAccount(exclude, model, advisorModel);
    }
    if (bound && bound.index !== pick.index) {
      // Mass-rebind pacing: when an account dies, its whole herd of bound
      // sessions rebinds together — arm the target's ramp (only if one isn't
      // already running) so admit() paces the burst like a legacy switch
      // would (issue #84).
      if (this.ramp.enabled && pick.rampStartedAt == null) this._beginRamp(pick);
      const why = heldBack ? 'own account available again, leaving fallback-only' : 'account unavailable';
      console.log(`[TeamClaude] Session ${sessionId.slice(0, 8)} rebound "${this.accounts[bound.index]?.name ?? '?'}" → "${pick.name}" (${why} — this session's prompt cache starts cold)`);
    } else if (!bound) {
      console.log(`[TeamClaude] Session ${sessionId.slice(0, 8)} → "${pick.name}" (${this._sessionCount(pick.index) + 1} bound, priority ${pick.priority || 0})`);
    }
    this._bindSession(sessionId, pick.index);
    return pick;
  }

  /**
   * True when this account should be de-prioritized for the given request in
   * order to keep its Fable capacity in reserve (see this.reserveFable). Applies
   * ONLY to non-Fable requests: a request that IS Fable (executor OR advisor)
   * must be free to use a Fable-capable account. An account "still has Fable" when
   * its Fable weekly bucket is known and below the switch threshold. Unknown
   * (null) Fable utilization is treated as NOT reserved — we don't penalize an
   * account whose Fable status we haven't learned yet.
   */
  _reservesFable(account, model = null, advisorModel = null) {
    if (!this.reserveFable) return false;
    if (isFableModel(model) || isFableModel(advisorModel)) return false;
    const f = account.quota.unified7dFable;
    return f != null && f < this.switchThreshold;
  }

  /**
   * Place a NEW session (it has no warm cache anywhere, so placement is free).
   * Selection order among available accounts:
   * Two regimes, switched by whether the account is at/over the soft cap:
   *   UNDER cap — drain order: [priority, not-paused, load, inFlight, weeklyReset].
   *     Fill the operator's preferred (low-priority-value) account first.
   *   OVER cap (every eligible account is already full — fleet saturated) — pure
   *     LOAD balancing: [not-paused, load, inFlight, priority, weeklyReset].
   *     Priority deliberately DROPS to a late tiebreak here: otherwise the
   *     priority-0 "drain-first" account wins every overflow placement and becomes
   *     a dumping ground — it collects every session past the cap, gets per-minute
   *     rate-limited, and its sessions stall (a rate-limit 429 pauses+retries the
   *     same account, never rotates) while lightly-loaded accounts sit idle. That
   *     was the "one session 529s, the rest are fine" failure. Under cap the
   *     leading 0 outranks any over-cap account's leading 1, so under-cap accounts
   *     are always filled first and the two regimes never cross-compare by shape.
   */
  _pickForNewSession(exclude = null, model = null, advisorModel = null) {
    let best = null;
    let bestKey = null;
    const now = Date.now();
    const overloaded = this._isOverloaded();
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isAvailable(account, model, advisorModel)) continue;
      if (this._fallbackHeld(account, model, advisorModel, exclude)) continue;
      const load = this._sessionCount(account.index);
      const over = load >= this.affinity.maxPerAccount;
      const paused = account.pausedUntil && account.pausedUntil > now ? 1 : 0;
      const inFlight = account.inFlight || 0;
      // Effective priority = configured priority, temporarily demoted by FEFO
      // (perishable quota burns first) and by overload flattening (spare tiers
      // take a full share while the fleet is busy). See _effectivePriority. The
      // raw `reset` stays the final tiebreak, so among equal-priority accounts
      // the soonest to reset still wins (fine-grained FEFO within a tier).
      const { prio, resetAt } = this._effectivePriority(account, model, now, overloaded);
      const reset = resetAt || -Infinity;
      // Fable-reserve is the PRIMARY discriminator (see _reservesFable): a
      // non-Fable request prefers every Fable-spent account over every
      // Fable-capable one, so general traffic doesn't drain the accounts that are
      // still Fable's only home. Always 0 when the feature is off / for Fable
      // requests, so the ranking is otherwise unchanged.
      const reserve = this._reservesFable(account, model, advisorModel) ? 1 : 0;
      // 'weighted': every available account keeps taking work, but a share
      // inversely proportional to its priority. Minimising (load+1)×(prio+1)
      // makes a priority-1 account accept its next session only once it is
      // roughly half as loaded as a priority-0 one, so the ratios settle at
      // 1 : 1/2 : 1/3 : 1/4 across priorities 0..3. The cap plays no part —
      // this is a continuous share, not a fill-then-spill.
      //
      // 'priority': the tier is the leading key, ABOVE the under/over-cap split.
      // Otherwise a lower tier's still-under-cap account (leading 0) would
      // outrank the preferred tier the moment it crosses the cap (leading 1) —
      // measured: 2 sessions leaked onto each lower tier per fill. Note this
      // STARVES lower tiers entirely while the top tier lives; use 'weighted'
      // when they should still be used, only less.
      const weighted = (load + 1) * (prio + 1);
      const key = this.affinity.overCapOrder === 'weighted'
        ? [reserve, paused, weighted, prio, load, inFlight, reset]      // proportional share
        : this.affinity.overCapOrder === 'priority'
          ? [reserve, prio, over ? 1 : 0, paused, load, inFlight, reset] // tiered burn order
          : (over
            ? [reserve, 1, paused, load, inFlight, prio, reset]   // saturated → balance by load
            : [reserve, 0, prio, paused, load, inFlight, reset]); // normal → drain by priority
      if (!best || keyLess(key, bestKey)) { best = account; bestKey = key; }
    }
    return best;
  }

  /** Start (or restart) the ramp window for an account that just became current,
   * so a failover burst is paced onto it rather than all landing at once. */
  _beginRamp(account) {
    if (account && this.ramp.enabled) account.rampStartedAt = Date.now();
  }

  /** Max concurrent upstream requests allowed to `account` right now. Infinity
   * once the ramp window has elapsed (or ramping is off / never started). */
  _rampCap(account, now = Date.now()) {
    if (!this.ramp.enabled || account.rampStartedAt == null) return Infinity;
    // Clamp to 0: pauseAccount arms rampStartedAt in the FUTURE (pause-end), so a
    // call during the pause would otherwise yield a negative elapsed → negative
    // cap. admit()'s pause branch already guards this, but keep _rampCap sound on
    // its own — a future start simply means "cap is at its floor (startConc)".
    const elapsed = Math.max(0, now - account.rampStartedAt);
    if (elapsed >= this.ramp.windowMs) { account.rampStartedAt = null; return Infinity; }
    return this.ramp.startConc + Math.floor(elapsed / this.ramp.stepMs) * this.ramp.stepConc;
  }

  /**
   * Reserve a concurrency slot on `account` before sending upstream. Waits while
   * the account is in a rate-limit pause (a 429's retry-after window) and while
   * it is over its current ramp cap. Fail-open: returns true once a slot is taken
   * (always eventually — the pause ends and the ramp cap grows), or false if
   * `isAborted()` reports the client went away while waiting. Pair every `true`
   * with a `release(index)`.
   */
  async admit(index, isAborted) {
    const account = this.accounts[index];
    if (!account) return true;
    while (true) {
      if (isAborted?.()) return false;
      const now = Date.now();
      // Rate-limit pause: hold new requests off this account until the window
      // passes instead of flooding it (which would deepen the 429). Not a
      // rotation trigger — the account stays selectable the whole time.
      if (account.pausedUntil && now < account.pausedUntil) {
        await new Promise(r => setTimeout(r, Math.min(account.pausedUntil - now, this.ramp.pollMs * 4)));
        continue;
      }
      const cap = this.ramp.enabled ? this._rampCap(account, now) : Infinity;
      if (account.inFlight < cap) { account.inFlight++; return true; }
      await new Promise(r => setTimeout(r, this.ramp.pollMs));
    }
  }

  /** Release a slot taken by admit(). Safe to call once per successful admit. */
  release(index) {
    const account = this.accounts[index];
    if (account && account.inFlight > 0) account.inFlight--;
  }

  /**
   * Pause an account after a rate-limit (non-quota) 429 so concurrent requests
   * wait in admit() instead of piling on. Unlike markRateLimited this does NOT
   * set `throttled`/rateLimitedUntil, so _isAvailable still returns true and
   * selection never rotates away — rotation is reserved for quota exhaustion.
   * When the pause lifts, the held requests are released through a fresh ramp
   * window (storm control) so they trickle out rather than flood. Extends an
   * existing pause rather than shortening it.
   */
  pauseAccount(index, seconds) {
    const account = this.accounts[index];
    if (!account) return;
    const until = Date.now() + Math.max(0, seconds) * 1000;
    account.pausedUntil = Math.max(account.pausedUntil || 0, until);
    // Arm the ramp to begin when the pause ends: while paused, admit() holds on
    // the pause branch; once it lifts, _rampCap counts from here and releases the
    // backlog gradually (startConc, then +stepConc per step).
    if (this.ramp.enabled) account.rampStartedAt = account.pausedUntil;
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   *
   * `advisorModel` is the second model an advisor request carries (Claude Code's
   * advisor tool, nested in tools[] — see parseAdvisorModel): the advisor
   * sub-inference runs on the SAME account and spends that model's family
   * bucket, so the account must be eligible for both models. When no account
   * satisfies both, selection degrades to executor-only routing so the main
   * request keeps flowing (upstream then fails just the advisor call).
   */
  getActiveAccount(exclude = null, model = null, advisorModel = null, sessionId = null) {
    // Clear expired quotas across all accounts and switch proactively if a
    // session reset made a sooner-expiring account the better choice. This runs
    // on every request so the behaviour holds without the TUI render loop.
    this.refreshExpiredQuotas();
    // Session-affinity distribution (opt-in): keep a session on its pinned
    // account for cache reuse, and route a new session to the least-loaded
    // account. Only when enabled, only for a real session, and only outside a
    // manual route pin (which must still win). Falls through to the normal walk
    // if nothing session-eligible is found (e.g. the whole tier is exhausted).
    if (this.distributeSessions && sessionId && !this._pinnedAccountForModel(model, advisorModel)) {
      const acc = this._selectForSession(sessionId, exclude, model, advisorModel);
      if (acc) return acc;
    }
    if (advisorModel) {
      const account = this._select(exclude, model, advisorModel, false);
      if (account) return account;
      // Throttled so a busy advisor session doesn't flood the activity log.
      if (Date.now() >= (this._advisorDegradeLogAt || 0)) {
        this._advisorDegradeLogAt = Date.now() + 60_000;
        console.log(`[TeamClaude] No account eligible for advisor model "${advisorModel}" — routing by request model only`);
      }
    }
    return this._select(this._withAdvisorCapExcluded(exclude, advisorModel), model, null, true);
  }

  /** `exclude` plus every account over its hard cap for `advisorModel`. The
   *  advisor-degrade fallbacks route by the executor model alone, but the
   *  advisor sub-call still spends the chosen account's family bucket. */
  _withAdvisorCapExcluded(exclude, advisorModel) {
    if (!advisorModel) return exclude;
    const capped = this.accounts.filter(a => this.isOverHardCap(a, advisorModel));
    if (!capped.length) return exclude;
    return new Set([...(exclude || []), ...capped.map(a => a.index)]);
  }

  /** The selection walk getActiveAccount runs: manual pin → current account →
   * best-available. `allowProbe` gates the exhausted-fleet probe fallback so the
   * advisor-constrained pass can fail soft (degrade to executor-only) instead of
   * burning the throttled probe slot on the stricter constraint. */
  _select(exclude, model, advisorModel, allowProbe) {
    // A manual per-route pin biases selection for that route's models (independent
    // of the global currentIndex). Honored only while eligible — otherwise we fall
    // through to normal best-available selection so requests keep flowing.
    const pinned = this._pinnedAccountForModel(model, advisorModel);
    if (pinned && this._isAvailable(pinned, model, advisorModel) && !exclude?.has(pinned.index)) return pinned;
    const current = this.accounts[this.currentIndex];
    // `model` scopes availability: an account whose Fable weekly bucket is spent
    // is still fully usable for other models, so it is only excluded when THIS
    // request targets Fable (see _isAvailable).
    // `exclude` is a per-request set of indices already tried this request (e.g.
    // an account that just threw a transport error). It is never a persistent
    // status change — the account stays healthy for the next request.
    // We just learned a probed account's weekly quota — re-evaluate which
    // account is best now that its limit is known.
    if (current && current.requalify) {
      // Consume the flag on the final pass; the advisor-constrained pass leaves
      // it set unless it actually switches, so the requalification isn't lost
      // when that pass comes up empty and selection degrades.
      if (allowProbe) current.requalify = false;
      const next = this._selectNext(exclude, model, advisorModel);
      if (next) { current.requalify = false; return next; }
    }
    // A fallback-only current account is preempted outright while an own
    // account can serve (see _fallbackHeld) — whatever their priorities say.
    if (this._isAvailable(current, model, advisorModel) && !exclude?.has(current.index)
        && !this._fallbackHeld(current, model, advisorModel, exclude)) {
      // Priority preemption via upstream's shared predicate, so _select and
      // eligibility() can never drift apart on the answer.
      const betterExists = this._preemptedBy(current, model, advisorModel, exclude);
      // Fable-reserve on the sticky-current path: if `current` is one we want to
      // spare for Fable (still has Fable headroom, and this is a non-Fable
      // request) AND some non-reserved account can take this request, switch away
      // via _selectNext (whose _pickBestAvailable prefers the Fable-spent account)
      // rather than draining current's shared quota. Without this, a no-session /
      // affinity-off request would pin to whatever currentIndex holds and the
      // reserve would never engage on the legacy path. No-op when reserve is off
      // (_reservesFable → false), so default behaviour is byte-identical.
      const reserveElsewhere = this._reservesFable(current, model, advisorModel)
        && this.accounts.some(a => this._isAvailable(a, model, advisorModel)
          && !exclude?.has(a.index) && !this._reservesFable(a, model, advisorModel));
      return (betterExists || reserveElsewhere) ? this._selectNext(exclude, model, advisorModel) : current;
    }
    const next = this._selectNext(exclude, model, advisorModel);
    if (next) return next;
    // No account is under the switch threshold. Before refusing locally, allow a
    // throttled probe so a stale/poisoned cached quota can't pin us in a
    // permanent "all exhausted" state — the probe's real response refreshes the
    // quota (or upstream's own 429 converts soft exhaustion into a hard
    // rate-limit hold). null here means the caller emits the synthetic 429.
    const probe = allowProbe ? this._selectProbe(exclude, model) : null;
    if (probe) return probe;
    // Still nothing, and the probe is throttled to once a minute. switchThreshold
    // exists to stop draining an account while a fresher one is available — with
    // none available it buys nothing, and the last 2% of every account would sit
    // unused behind a synthetic 429 we invented ourselves. Spend it: let the
    // provider's real 429 be the authority on "exhausted", not our soft bar.
    return this._selectLastResort(exclude, model, advisorModel);
  }

  /** Session-affinity selection (opt-in, issue #109). Honor a known session's
   * pin when that account is still eligible and not preempted by a
   * higher-priority one; otherwise route the session to the least-loaded
   * eligible account. Returns null if nothing is eligible, so the caller falls
   * back to the normal quota-driven walk. Does NOT record the pin — that happens
   * on the actual route (recordSession), so retries/failover re-pin naturally. */
  _selectForSession(sessionId, exclude, model, advisorModel) {
    const pinIdx = this.sessionTracker.pinnedAccount(sessionId);
    if (pinIdx != null) {
      const pinned = this.accounts[pinIdx];
      if (pinned && this._isAvailable(pinned, model, advisorModel) && !exclude?.has(pinIdx)
          && !this._fallbackHeld(pinned, model, advisorModel, exclude)) {
        // Mirror _select's priority preemption so an operator's priority order
        // still wins over a session's stickiness.
        const betterExists = this.accounts.some(a =>
          this._isAvailable(a, model, advisorModel) && !exclude?.has(a.index) && (a.priority || 0) < (pinned.priority || 0)
          && !this._fallbackHeld(a, model, advisorModel, exclude));
        if (!betterExists) return pinned;
      }
    }
    return this._pickLeastLoaded(exclude, model, advisorModel);
  }

  /** Best-available biased toward the fewest active sessions, so new sessions
   * spread across equal-priority accounts instead of funnelling onto one. Order:
   * priority → fewest active sessions → fewest in-flight → soonest weekly reset
   * (the existing tiebreak). */
  _pickLeastLoaded(exclude = null, model = null, advisorModel = null) {
    const now = Date.now();
    let best = null;
    let bestPriority = Infinity;
    let bestSessions = Infinity;
    let bestInFlight = Infinity;
    let bestReset = Infinity;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isAvailable(account, model, advisorModel)) continue;
      if (this._fallbackHeld(account, model, advisorModel, exclude)) continue;
      const priority = account.priority || 0;
      const sessions = this.sessionTracker.activeCountFor(account.index, now);
      const inFlight = account.inFlight || 0;
      const reset = this._governingWeeklyReset(account, model) || -Infinity;
      if (priority < bestPriority
        || (priority === bestPriority && sessions < bestSessions)
        || (priority === bestPriority && sessions === bestSessions && inFlight < bestInFlight)
        || (priority === bestPriority && sessions === bestSessions && inFlight === bestInFlight && reset < bestReset)) {
        best = account;
        bestPriority = priority;
        bestSessions = sessions;
        bestInFlight = inFlight;
        bestReset = reset;
      }
    }
    return best;
  }

  /** Record that a session's request was served by an account (always on, even
   * when distribution is off — the readout is passive). This is what pins a
   * session for future affinity. */
  recordSession(sessionId, accountIndex) {
    if (sessionId) this.sessionTracker.touch(sessionId, accountIndex);
  }

  /** Mark a session request as in flight / finished. Paired around the whole
   * client request (including retries) so a long streaming completion keeps the
   * session counted as active for its full duration. */
  beginSession(sessionId) {
    if (sessionId) this.sessionTracker.beginRequest(sessionId);
  }

  endSession(sessionId) {
    if (sessionId) this.sessionTracker.endRequest(sessionId);
  }

  /** { known, active, perAccount } session counts for status/TUI. */
  sessionStats() {
    return this.sessionTracker.stats();
  }

  /**
   * Like getActiveAccount, but if the selected account's OAuth token has ALREADY
   * expired it blocks on a refresh before returning — so a caller that injects
   * the token immediately (the MITM relay) never sends a dead token and eats a
   * 401. A token that is merely expiring soon (still valid) is left to the
   * caller's opportunistic background refresh; only a hard-expired one blocks.
   */
  async getActiveAccountFresh(exclude = null, model = null, advisorModel = null, sessionId = null) {
    const account = this.getActiveAccount(exclude, model, advisorModel, sessionId);
    if (account && account.type === 'oauth' && account.refreshToken
        && isTokenExpired(account.expiresAt)) {
      await this.ensureTokenFresh(account.index); // coalesces with any in-flight refresh
    }
    return account;
  }

  /**
   * Read-only: the index of the account a request for `model` would be served by
   * right now — the same decision getActiveAccount makes (manual pin → the global
   * current account if it can serve the model → best-available), but WITHOUT
   * mutating currentIndex and without the exhausted-fleet probe fallback. Returns
   * null when nothing can serve `model` at the moment. The TUI uses this to mark
   * the single account each secondary bucket (Fable/Sonnet) currently routes to —
   * the F7/S7 analogue of the ► that marks the default route's current account.
   */
  previewRouteIndex(model) {
    const pinned = this._pinnedAccountForModel(model);
    if (pinned && this._isAvailable(pinned, model)) return pinned.index;
    const current = this.accounts[this.currentIndex];
    if (current && this._isAvailable(current, model) && !this._fallbackHeld(current, model)) {
      // Mirror getActiveAccount's priority preemption: a strictly higher-priority
      // available account wins over a healthy current one; same tier stays put.
      const better = this.accounts.some(a =>
        this._isAvailable(a, model) && (a.priority || 0) < (current.priority || 0)
        && !this._fallbackHeld(a, model));
      if (!better) return current.index;
    }
    const best = this._pickBestAvailable(null, model);
    return best ? best.index : null;
  }

  _isProbeable(account) {
    if (!account) return false;
    // Never probe an account the operator has taken out of rotation or one
    // whose token is broken — those are hard states, not stale guesses.
    if (account.disabled) return false;
    if (account.status === 'error' || account.status === 'exhausted') return false;
    // A probe is a live request: it spends quota like any other.
    if (this.isOverHardCap(account)) return false;
    // A 429 hold is respected verbatim at first, but a hold is a snapshot: the
    // 429 that armed it may itself have been transient (e.g. the retry burst
    // after a network flap), and while it lasts NOTHING revalidates it — so a
    // stale hold pins the fleet in synthetic 429s for up to an hour and only a
    // restart (which wipes the in-memory hold) recovers. After the floor, let
    // the account be probed: the probe's real response either clears the hold
    // (any non-429 → clearRateLimited) or re-arms it with a fresh retry-after.
    if (account.status === 'throttled' && account.rateLimitedUntil
        && Date.now() < account.rateLimitedUntil) {
      return Date.now() >= (account.throttledAt || 0) + this.throttleProbeFloorMs;
    }
    return true;
  }

  /** Highest utilization across the quota dimensions that govern `model` (0-1),
   * used to pick the least-exhausted probe target. Mirrors _isNearQuota: the
   * shared 5-hour bucket plus the model's governing weekly bucket. With no model
   * it falls back to the shared weekly. */
  _maxUtilization(account, model = null) {
    const q = account.quota;
    let max = 0;
    if (q.unified5h != null) max = Math.max(max, q.unified5h);
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null) max = Math.max(max, weeklyVal);
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      max = Math.max(max, 1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      max = Math.max(max, 1 - q.requestsRemaining / q.requestsLimit);
    }
    return max;
  }

  /** Utilization (0-1) of the weekly bucket that governs `model` on this account:
   * unified7dFable for Fable, unified7dSonnet for Sonnet, unified7d otherwise.
   * Falls back to the shared unified7d when a family-specific bucket isn't
   * reported. Returns null when nothing is known. */
  _governingWeekly(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    if (q[key] != null) return q[key];
    return key !== 'unified7d' ? q.unified7d : null;
  }

  /** Reset timestamp (ms) of the weekly bucket that governs `model`, falling back
   * to the shared weekly reset. Used to spend the soonest-expiring quota first. */
  _governingWeeklyReset(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    return q[`${key}Reset`] || q.unified7dReset || null;
  }

  /** True when the family-specific weekly bucket that governs `model` is spent.
   * Unlike _isNearQuota this ignores the shared 5h/weekly caps — it is only used
   * to skip an account for a probe of a model it definitely can't serve. Returns
   * false for families without a dedicated bucket (they share unified7d, already
   * covered by _isNearQuota). */
  _modelWeeklyExhausted(account, model) {
    const q = account.quota;
    const key = this._weeklyBucketFor(model);
    if (key === 'unified7d') return false;
    return q[key] != null && q[key] >= this.switchThreshold;
  }

  /**
   * Last resort: every account reads as over switchThreshold and the revalidation
   * probe is throttled, so the alternative is a synthetic 429 we generate
   * ourselves. Serve the request from the least-utilized account that is not
   * HARD-unavailable and let the provider decide.
   *
   * What still disqualifies an account here — all of them are states where the
   * request would certainly fail, so spending a retry on them helps nobody:
   *   disabled            operator took it out of rotation
   *   status 'error'      credential is rejected; needs re-login
   *   pausedUntil         a real upstream 429 with a retry-after still running
   *   route/ownership     the account cannot serve this model id at all
   *   quota >= 1.0        the provider itself says the bucket is empty
   *
   * Deliberately NOT disqualifying: utilization between switchThreshold and 1.0.
   * That band is exactly what this exists to spend. Enabled by default because
   * it only ever runs where the alternative is failing the request; set
   * `sessionAffinity.lastResort: false` (or TEAMCLAUDE_LAST_RESORT=0) to keep
   * the old behaviour of refusing locally.
   */
  _selectLastResort(exclude = null, model = null, advisorModel = null) {
    if (!this.lastResort) return null;
    const now = Date.now();
    let best = null;
    let bestUsage = Infinity;
    let bestFallback = true;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (account.disabled) continue;
      // A LIVE upstream rate-limit hold. This is the provider telling us to wait
      // a specific time; ignoring it would just burn a request into a wall and
      // is the one thing this must never do. Note the field is rateLimitedUntil
      // (set by markRateLimited) — pausedUntil is the SOFT admission pause and
      // deliberately leaves an account available, so it must not disqualify here.
      if (account.status === 'throttled' && account.rateLimitedUntil && now < account.rateLimitedUntil) continue;
      // Genuinely spent or credential-dead: nothing to drain.
      if (account.status === 'exhausted' || account.status === 'error') continue;
      if (model && !this._routeAllows(account, model)) continue;
      if (advisorModel && !this._routeAllows(account, advisorModel)) continue;
      // The band above switchThreshold is this path's whole purpose — but never
      // past an operator hard cap, which is absolute.
      if (this.isOverHardCap(account, model)) continue;
      if (advisorModel && this.isOverHardCap(account, advisorModel)) continue;
      // Only a bucket the provider reports as genuinely full is out; anything
      // below 1.0 still has something left to give.
      const usage = this._maxUtilization(account, model);
      if (usage >= 1) continue;
      // Own accounts' last band is drained before any fallback-only account is
      // touched, however much headroom the fallback one has.
      const fb = !!account.fallbackOnly;
      if (!best || (fb !== bestFallback ? !fb : usage < bestUsage)) { bestUsage = usage; best = account; bestFallback = fb; }
    }
    if (best) {
      console.log(`[TeamClaude] Last resort: every account is over the ${Math.round(this.switchThreshold * 100)}% switch threshold — draining "${best.name}" at ${Math.round(bestUsage * 100)}% rather than refusing locally`);
    }
    return best;
  }

  /**
   * Pick an account to send a single revalidation probe upstream when every
   * account reads as over the switch threshold. Throttled to one probe per
   * probeIntervalMs so a genuinely-exhausted fleet isn't hammered — between
   * probes this returns null and the caller falls back to the synthetic 429.
   * The chosen account is the least-utilized probeable one (most likely to have
   * stale headroom), so the refreshed quota corrects the cache fastest.
   */
  _selectProbe(exclude = null, model = null) {
    const now = Date.now();
    if (now < this._nextProbeAt) return null;

    let best = null;
    let bestKey = null;
    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      if (!this._isProbeable(account)) continue;
      // A family-exhausted account can't serve that family even as a probe — it
      // would just 429 again — so skip it (Fable/Sonnet) and let the caller emit
      // the synthetic 429 when no other account is available.
      if (model && this._modelWeeklyExhausted(account, model)) continue;
      // Same for routing/ownership: a probe for a routed or owned model must not
      // land on an ineligible account (it would just reject the unknown model id).
      if (model && !this._routeAllows(account, model)) continue;
      // _isProbeable checked the shared buckets; this adds the model's family one.
      if (model && this.isOverHardCap(account, model)) continue;
      // Own accounts are revalidated before any fallback-only one: their stale
      // quota is what should return the fleet to service.
      const key = [account.fallbackOnly ? 1 : 0, account.priority || 0, this._maxUtilization(account, model)];
      if (!best || keyLess(key, bestKey)) { best = account; bestKey = key; }
    }
    if (!best) return null;

    this._nextProbeAt = now + this.probeIntervalMs;
    this.currentIndex = best.index;
    this._beginRamp(best);
    if (best.status === 'throttled') {
      console.log(`[TeamClaude] All accounts unavailable — revalidating throttled "${best.name}" with a live request`);
    } else {
      console.log(`[TeamClaude] All accounts over threshold — probing "${best.name}" to refresh quota`);
    }
    return best;
  }

  _isAvailable(account, model = null, advisorModel = null) {
    if (!account) return false;

    // Manually disabled accounts are skipped entirely until re-enabled.
    if (account.disabled) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      account.throttledAt = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    // Model-scoped: _isNearQuota checks the shared 5h bucket plus only the weekly
    // bucket that governs this model, so a spent Fable/Sonnet bucket bars just
    // that family — the account still serves every other model normally.
    if (this._isNearQuota(account, model)) return false;

    // Route/ownership restriction: a configured route can pin a model pattern to
    // an exclusive set of accounts; failing that, a per-account `models` claim
    // restricts an owned model to its owners. Either way an account not eligible
    // for this model is skipped so the request never lands somewhere it can't run.
    if (model && !this._routeAllows(account, model)) return false;

    // An advisor request additionally needs the account to serve the ADVISOR's
    // model: its family bucket must have headroom (the shared buckets were
    // already checked above for the executor) and any route/ownership rule for
    // it must allow this account.
    if (advisorModel) {
      if (this._modelWeeklyExhausted(account, advisorModel)) return false;
      if (!this._routeAllows(account, advisorModel)) return false;
      // The advisor's family bucket spends this account's quota too.
      if (this.isOverHardCap(account, advisorModel)) return false;
    }

    return true;
  }

  /**
   * The available account that would preempt `account` under the priority rule,
   * or null. A strictly lower priority value wins; within the same tier we stay
   * put, so the common case (every account at the default priority 0) never
   * thrashes. Shared by _select, which enforces it, and eligibility(), which
   * reports it — one predicate so the answer cannot drift from the behaviour.
   */
  _preemptedBy(account, model = null, advisorModel = null, exclude = null) {
    return this.accounts.find(a => this._isAvailable(a, model, advisorModel)
      && !exclude?.has(a.index)
      && (a.priority || 0) < (account.priority || 0)
      // A held-back fallback-only account outranks nobody, whatever its priority.
      && !this._fallbackHeld(a, model, advisorModel, exclude)) || null;
  }

  /**
   * Whether a request right now would actually route to an account, with a short
   * reason when it would not. A caller that records a manual choice (the control
   * plane's switch endpoint) needs to report whether that choice will take
   * effect, not merely that it was stored: selection drops the choice on the very
   * next request both when the account cannot serve traffic and when another
   * available account outranks it on priority. Both are asked here through the
   * same helpers _select uses, so the flag cannot promise more than the selector
   * delivers.
   * @returns {{eligible: boolean, reason?: string}}
   */
  eligibility(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return { eligible: false, reason: 'no such account' };
    // _isAvailable also clears an expired throttle, so the specific reasons below
    // are only consulted once it has actually said no.
    if (!this._isAvailable(account)) {
      if (account.disabled) return { eligible: false, reason: 'disabled' };
      if (account.status === 'error') return { eligible: false, reason: 'in an error state and needs a re-login' };
      if (account.status === 'exhausted') return { eligible: false, reason: 'out of quota' };
      if (account.status === 'throttled') return { eligible: false, reason: 'rate-limited' };
      return { eligible: false, reason: 'at or above the switch threshold' };
    }
    // Healthy, but a higher-priority account preempts it on the next selection.
    // Phrased to read correctly after "<name> is ..." in the caller's message.
    const preemptor = this._preemptedBy(account);
    if (preemptor) {
      return { eligible: false, reason: `outranked by higher-priority account "${preemptor.name}"` };
    }
    if (this._fallbackHeld(account)) {
      return { eligible: false, reason: 'fallback-only and held back while own accounts are available' };
    }
    return { eligible: true };
  }

  /**
   * Normalize and store the configurable routing table. A route pins a set of
   * model globs to an exclusive set of accounts (and may override the governing
   * quota bucket). Called from the constructor and on config reload.
   *   { name, match: string|string[], accounts?: (name|index)[], bucket? }
   */
  setRoutes(routes) {
    this.routes = (Array.isArray(routes) ? routes : []).map((r, i) => ({
      name: r.name || `route-${i + 1}`,
      match: (Array.isArray(r.match) ? r.match : [r.match]).filter(g => typeof g === 'string' && g),
      accounts: Array.isArray(r.accounts) ? r.accounts.map(String) : [],
      bucket: r.bucket || null,
      color: r.color || null, // display-only accent for the route's inline marker
    })).filter(r => r.match.length);
    // Drop pins for routes that no longer exist after a reload.
    if (this.routePins?.size) {
      const names = new Set(this.routes.map(r => r.name));
      for (const name of [...this.routePins.keys()]) {
        if (name !== 'fable' && name !== 'sonnet' && !names.has(name)) this.routePins.delete(name);
      }
    }
  }

  /** The first configured route whose globs match `model`, or null. */
  _routeForModel(model) {
    if (!model || !this.routes?.length) return null;
    return this.routes.find(r => r.match.some(g => modelGlobMatches(g, model))) || null;
  }

  /** The weekly quota bucket that governs `model` — a matching route's `bucket`
   * override wins, otherwise the model family's default bucket. */
  _weeklyBucketFor(model) {
    const route = this._routeForModel(model);
    return route?.bucket || weeklyBucketForModel(model);
  }

  /** Whether `account` may serve `model`. A matching route with an `accounts`
   * list is exclusive (only listed accounts, by name or index). With no matching
   * route — or a route that lists no accounts — it falls back to the per-account
   * `models` ownership claim (deprecated — use `routes` instead). */
  _routeAllows(account, model) {
    const route = this._routeForModel(model);
    if (route && route.accounts.length) {
      return route.accounts.includes(account.name) || route.accounts.includes(String(account.index));
    }
    return this._accountOwnsModel(account, model);
  }

  /** @deprecated Use `routes` with an `accounts` list instead.
   *  Returns true if no account claims model ownership, or this account does. */
  _accountOwnsModel(account, model) {
    for (const a of this.accounts) {
      if (a.models && a.models.some(m => modelMatches(m, model))) {
        // Some other account owns this model — this account must own it too.
        return !!(account.models && account.models.some(m => modelMatches(m, model)));
      }
    }
    return true; // no one claims ownership → any account is fine
  }

  /**
   * The routing table for display: every configured route plus an ephemeral,
   * auto-created route for each model family that some account meters with its
   * own weekly bucket but no configured route already covers. Auto-created routes
   * carry `autocreated: true` and are never persisted — they simply surface the
   * per-model quota the server already respects. Each route lists the accounts it
   * can use with a live eligibility flag, plus `target`: the one account it would
   * pick right now. Everything here is derived for display and thrown away — the
   * entries are fresh objects, never the stored (persisted) route definitions.
   */
  getRoutes() {
    const out = this.routes.map(r => ({
      name: r.name, match: r.match, bucket: r.bucket, color: r.color || null, autocreated: false,
      pinned: this._pinnedName(r.name),
      accounts: this._routeAccountsView(r),
      target: this._routeTarget(sampleModelFor(r)),
    }));

    const detected = [];
    if (this.accounts.some(a => a.quota.unified7dFable != null)) {
      detected.push({ name: 'fable', match: ['*fable*'], sample: 'claude-fable-5' });
    }
    if (this.accounts.some(a => a.quota.unified7dSonnet != null)) {
      detected.push({ name: 'sonnet', match: ['*sonnet*'], sample: 'claude-sonnet-4-6' });
    }
    for (const d of detected) {
      if (this._routeForModel(d.sample)) continue; // already covered by a configured route
      out.push({
        name: d.name, match: d.match, bucket: null, color: null, autocreated: true,
        pinned: this._pinnedName(d.name),
        accounts: this.accounts.map(a => ({ name: a.name, eligible: this._isAvailable(a, d.sample) })),
        target: this._routeTarget(d.sample),
      });
    }
    return out;
  }

  /** The name of the account a request for `model` would land on right now, or
   * null when nothing can serve it (every candidate disabled, spent or excluded). */
  _routeTarget(model) {
    const idx = this.previewRouteIndex(model);
    return idx == null ? null : (this.accounts[idx]?.name ?? null);
  }

  /** The name of the account this route is manually pinned to, or null. */
  _pinnedName(routeName) {
    const idx = this.routePins.get(routeName);
    return idx == null ? null : (this.accounts[idx]?.name ?? null);
  }

  /** Accounts a configured route can use (all accounts when it lists none), each
   * with a live eligibility flag for a representative model of the route. */
  _routeAccountsView(route) {
    const sample = sampleModelFor(route);
    const inRoute = a => !route.accounts.length
      || route.accounts.includes(a.name) || route.accounts.includes(String(a.index));
    return this.accounts.filter(inRoute).map(a => ({ name: a.name, eligible: this._isAvailable(a, sample) }));
  }

  /** A representative model id for a route name (configured or auto fable/sonnet),
   * used to test route-allowance when pinning. Null for an unknown route. */
  _routeSample(routeName) {
    const r = this.routes.find(x => x.name === routeName);
    if (r) return r.match[0]?.replace(/\*/g, '') || 'model';
    if (routeName === 'fable') return 'claude-fable-5';
    if (routeName === 'sonnet') return 'claude-sonnet-4-6';
    return null;
  }

  /**
   * Manually pin a route to an account (ephemeral runtime override). Rejects an
   * account the route's exclusivity/ownership rules disallow. Pinning an account
   * that is merely near-quota/throttled is allowed — it acts as a preference and
   * routing falls back to best-available until the pinned account is eligible.
   * Returns { ok, reason? }.
   */
  setRoutePin(routeName, accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return { ok: false, reason: 'no such account' };
    const sample = this._routeSample(routeName);
    if (sample && !this._routeAllows(account, sample)) {
      return { ok: false, reason: `route "${routeName}" does not allow "${account.name}"` };
    }
    this.routePins.set(routeName, accountIndex);
    return { ok: true };
  }

  clearRoutePin(routeName) { this.routePins.delete(routeName); }

  /** The account a route is pinned to, or null. */
  getRoutePin(routeName) {
    const idx = this.routePins.get(routeName);
    return idx == null ? null : (this.accounts[idx] || null);
  }

  /** The manually-pinned account governing `model`, if any: a configured route's
   * pin wins, else an auto fable/sonnet family pin (only when no configured route
   * covers the model). For an advisor request the executor's pin wins (it is the
   * bulk of the spend); the advisor model's pin applies only when nothing pins
   * the executor. Returns null when nothing is pinned for this model. */
  _pinnedAccountForModel(model, advisorModel = null) {
    return this._pinnedFor(model)
      || (advisorModel ? this._pinnedFor(advisorModel) : null);
  }

  _pinnedFor(model) {
    if (!model || !this.routePins.size) return null;
    const route = this._routeForModel(model);
    if (route) {
      const idx = this.routePins.get(route.name);
      return idx == null ? null : (this.accounts[idx] || null);
    }
    for (const name of ['fable', 'sonnet']) {
      if (this.routePins.has(name) && modelGlobMatches(`*${name}*`, model)) {
        return this.accounts[this.routePins.get(name)] || null;
      }
    }
    return null;
  }

  /**
   * Clear any quota counters whose reset time has passed. Cheap and safe to
   * call frequently (e.g. from the TUI render loop) — once a counter is cleared
   * it stays null until the next upstream response repopulates it, so the
   * "reset" log fires at most once per window.
   * @returns {{changed: boolean, session: boolean}} what was cleared.
   */
  _clearExpiredQuotas(account) {
    const q = account.quota;
    const now = Date.now();
    let changed = false;
    let session = false;

    // Clear expired unified quotas
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
      changed = true;
    }
    if (q.unified7dSonnet != null && q.unified7dSonnetReset && now >= q.unified7dSonnetReset) {
      q.unified7dSonnet = null;
      q.unified7dSonnetReset = null;
      changed = true;
    }
    if (q.unified7dFable != null && q.unified7dFableReset && now >= q.unified7dFableReset) {
      q.unified7dFable = null;
      q.unified7dFableReset = null;
      changed = true;
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
      changed = true;
    }

    return { changed, session };
  }

  /**
   * Clear expired quotas across all accounts. Called from the display loop and
   * the request path so a window expiry (e.g. the 5-hour session quota) resets
   * the view instantly rather than waiting for the next request.
   *
   * When an account's session quota resets, it may have become the better
   * choice — switch to it if its weekly limit expires sooner than the current
   * account's (and it still has weekly quota), so we spend the quota closest to
   * refreshing first.
   */
  refreshExpiredQuotas() {
    let changed = false;
    const sessionReset = [];
    for (const account of this.accounts) {
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      if (r.session) sessionReset.push(account);
    }
    if (sessionReset.length) this._switchOnSessionReset(sessionReset);
    return changed;
  }

  /**
   * Given accounts whose session quota just reset, switch to the one whose
   * weekly limit expires soonest — but only if that is sooner than the current
   * account's weekly limit and the account still has weekly quota to spend.
   */
  _switchOnSessionReset(candidates) {
    const current = this.accounts[this.currentIndex];
    // Need a known weekly reset on the current account to compare against;
    // if it is unknown we are still probing it, so leave it alone.
    if (!current || current.quota.unified7dReset == null) return;

    let best = null;
    let bestWeekly = current.quota.unified7dReset;
    for (const acc of candidates) {
      if (acc.index === this.currentIndex) continue;
      if (!this._isAvailable(acc)) continue; // enough session & weekly quota left
      if (this._fallbackHeld(acc)) continue;
      // Don't demote to a lower-priority (higher value) account on a reset.
      if ((acc.priority || 0) > (current.priority || 0)) continue;
      const weekly = acc.quota.unified7dReset;
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < bestWeekly) {
        bestWeekly = weekly;
        best = acc;
      }
    }

    if (best) {
      this.currentIndex = best.index;
      this._beginRamp(best);
      console.log(`[TeamClaude] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
    }
  }

  /**
   * Whether `account` has reached its operator-set hard ceiling
   * (`maxUtilization`). switchThreshold is a soft line that last-resort draining
   * and revalidation probes deliberately cross; this one is absolute, so every
   * path that can put a request on an account checks it: normal selection (via
   * _isNearQuota), last resort, probes, explicit pins and keep-warm.
   * The weekly cap covers the shared weekly bucket AND the family bucket that
   * governs `model` — "85% of her weekly" must hold whichever one is metered.
   * It is enforced before each request from the latest known utilization, so a
   * request already in flight can still carry a bucket slightly past the cap.
   *
   * A trip is LATCHED until the reset of the bucket that tripped: inside one
   * window utilization only rises, so a later lower reading (an out-of-order
   * header under concurrency, a lagging prober read — both seen live on this
   * account) is stale and must not reopen the account.
   */
  isOverHardCap(account, model = null) {
    const cap = account?.maxUtilization;
    if (!cap) return false;
    if (cap.invalid) return true;
    this._clearExpiredQuotas(account);
    const q = account.quota;
    const now = Date.now();
    if (account.capLatch && now >= account.capLatch.until) account.capLatch = null;
    const over5h = cap.fiveHour != null && q.unified5h != null && q.unified5h >= cap.fiveHour;
    const overWk = cap.weekly != null && q.unified7d != null && q.unified7d >= cap.weekly;
    if (over5h || overWk) {
      const until = Math.max(
        over5h ? (q.unified5hReset || now + 5 * 3600_000) : 0,
        overWk ? (q.unified7dReset || now + 7 * 86400_000) : 0);
      if (!account.capLatch || until > account.capLatch.until) account.capLatch = { until };
    }
    const shared = !!account.capLatch;
    // Logged on the model-independent state only, so a family bucket checked
    // for one request and not the next cannot make the log flap.
    if (shared !== !!account.overHardCap) {
      account.overHardCap = shared;
      console.log(shared
        ? `[TeamClaude] "${account.name}" reached its usage cap (5h ${pct(q.unified5h)}, weekly ${pct(q.unified7d)}; caps 5h ${pct(cap.fiveHour)}, weekly ${pct(cap.weekly)}) — no requests until ${new Date(account.capLatch.until).toISOString()}`
        : `[TeamClaude] "${account.name}" is back under its usage cap — available again`);
    }
    if (shared) return true;
    if (cap.weekly == null) return false;
    const governing = this._governingWeekly(account, model);
    return governing != null && governing >= cap.weekly;
  }

  _isNearQuota(account, model = null) {
    const q = account.quota;
    this._clearExpiredQuotas(account);

    // Operator hard cap first: it can sit below switchThreshold.
    if (this.isOverHardCap(account, model)) return true;

    // Shared 5-hour bucket gates every request regardless of model.
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;

    // Only the weekly bucket that GOVERNS this model is checked: Fable and Sonnet
    // meter their own weekly quota, so a spent Fable bucket must not bar an Opus
    // or Sonnet request (and vice versa). When the family bucket isn't reported
    // (e.g. the plan doesn't expose it), fall back to the shared weekly so an
    // account over its overall cap is still treated as near-quota.
    const weeklyVal = this._governingWeekly(account, model);
    if (weeklyVal != null && weeklyVal >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
  }

  /**
   * Pick the best available account by selection order, WITHOUT mutating state:
   *   1. lowest `priority` value (operator-controlled; default 0, lower = preferred)
   *   2. then the account with no known weekly limit — using it lets us
   *      discover its quota
   *   3. then the account whose weekly limit expires soonest: that quota is
   *      closest to refreshing, so spending it first preserves accounts whose
   *      weekly window resets further out.
   * With all priorities at the default 0, this reduces to the weekly-reset
   * heuristic. Returns the account or null if none are available.
   */
  _pickBestAvailable(exclude = null, model = null, advisorModel = null) {
    let best = null;
    let bestKey = null;
    const now = Date.now();
    const overloaded = this._isOverloaded();

    for (let i = 0; i < this.accounts.length; i++) {
      const account = this.accounts[i];
      if (exclude?.has(account.index)) continue;
      // _isAvailable filters out accounts at/above the switch threshold, so the
      // soonest-expiring pick only ever lands on an account whose 5-hour quota
      // is still below 98%.
      if (!this._isAvailable(account, model, advisorModel)) continue;
      if (this._fallbackHeld(account, model, advisorModel, exclude)) continue;

      // Fable-reserve first (see _reservesFable): for a non-Fable request, an
      // account that still has Fable headroom sorts AFTER every Fable-spent one,
      // so general traffic doesn't drain Fable's last homes. 0 for everyone when
      // the feature is off / for Fable requests → order unchanged below.
      const reserve = this._reservesFable(account, model, advisorModel) ? 1 : 0;
      // Rank by the reset of the weekly bucket that governs THIS model (Fable and
      // Sonnet have their own), so a Fable request spends the account whose Fable
      // window refreshes soonest while preserving accounts that reset later for
      // Opus/Sonnet. Unknown reset sorts first so we probe and fill it in.
      // Effective priority — FEFO + overload flattening, exactly as in
      // _pickForNewSession (see _effectivePriority); weeklyReset stays the tiebreak.
      const { prio: priority, resetAt } = this._effectivePriority(account, model, now, overloaded);
      const weeklyReset = resetAt || -Infinity;
      const key = [reserve, priority, weeklyReset];
      if (!best || keyLess(key, bestKey)) { best = account; bestKey = key; }
    }
    return best;
  }

  /**
   * Select the active account up front (e.g. on daemon launch, once persisted
   * quota has been restored) so we start on the highest-priority / soonest-
   * resetting account instead of blindly on index 0. Mirrors rotation order.
   * Returns the chosen account, or the existing current one if none are
   * available (the server still starts; requests 429 until a window resets).
   */
  selectActiveAccount() {
    this.refreshExpiredQuotas(); // drop any restored windows that already expired
    const best = this._pickBestAvailable();
    if (!best) return this.accounts[this.currentIndex] || null;
    this.currentIndex = best.index;
    this._beginRamp(best);
    best.probing = best.quota.unified7dReset == null;
    const wk = best.quota.unified7d != null
      ? `${(best.quota.unified7d * 100).toFixed(1)}% weekly used`
      : 'weekly quota unknown';
    console.log(`[TeamClaude] Starting on account "${best.name}" (priority ${best.priority || 0}, ${wk})`);
    return best;
  }

  _selectNext(exclude = null, model = null, advisorModel = null) {
    const best = this._pickBestAvailable(exclude, model, advisorModel);
    if (best) {
      const switched = best.index !== this.currentIndex;
      this.currentIndex = best.index;
      // If we switched to an account whose weekly quota is still unknown, flag
      // it so we re-evaluate once that quota is learned (see updateQuota).
      best.probing = best.quota.unified7dReset == null;
      if (switched) {
        this._beginRamp(best);
        console.log(`[TeamClaude] Switched to account "${best.name}"`);
      }
      return best;
    }

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;
    let soonestKey = null;
    const nowMs = Date.now();

    for (const account of this.accounts) {
      if (exclude?.has(account.index)) continue;
      // Never resurrect a hard-state account: `disabled` is an operator decision
      // and `error` means the token is broken (needs re-login). Selecting either
      // here would send a live request on an account that must not be used and,
      // below, silently clear its throttle/error state. (Mirrors _isAvailable.)
      if (account.disabled || account.status === 'error') continue;
      // A routed/owned model must not fall back to an ineligible account —
      // neither the executor's nor an advisor's.
      if (model && !this._routeAllows(account, model)) continue;
      if (advisorModel && !this._routeAllows(account, advisorModel)) continue;
      // A "reset" here only means some window rolled over — not the capped one.
      if (this.isOverHardCap(account, model) || (advisorModel && this.isOverHardCap(account, advisorModel))) continue;
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (!resetTime) continue;
      // Only a DUE reset is ever taken below, and among due ones an own account
      // wins over a fallback-only one; otherwise the soonest reset (unchanged).
      const key = [resetTime <= nowMs ? 0 : 1, account.fallbackOnly ? 1 : 0, resetTime];
      if (!soonestKey || keyLess(key, soonestKey)) {
        soonestKey = key;
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      this._beginRamp(soonestAccount);
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    // Model-scoped weekly bucket — surfaced in headers as `7d_oi` ("7-day,
    // overage included"). On current subscription plans this is the Fable weekly
    // limit (it correlates with the usage endpoint's Fable-scoped weekly bucket).
    // Utilization here is already a 0-1 fraction (can exceed 1 when in overage).
    const u7dOi = parseFloat(headers['anthropic-ratelimit-unified-7d_oi-utilization']);
    if (!isNaN(u7dOi)) account.quota.unified7dFable = u7dOi;
    const r7dOi = headers['anthropic-ratelimit-unified-7d_oi-reset'];
    if (r7dOi) account.quota.unified7dFableReset = parseInt(r7dOi, 10) * 1000;

    // We switched to this account to discover its weekly quota; now that we
    // know it, flag for re-evaluation so selection can pick the best account.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[TeamClaude] Learned weekly quota for "${account.name}", re-evaluating selection`);
    }

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) account.quota.unifiedStatus = uStatus;

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Mirror an API key account's monthly spend into its weekly bucket, so the
   * usual selection and maxUtilization cap treat "spent / budget" like any
   * other utilization. No-op for accounts without a monthlyBudget.
   */
  _applySpend(account) {
    if (!account?.monthlyBudget) { if (account) account.apiSpend = null; return; }
    const e = this.spendLedger.get(account.name);
    const util = e.exhaustedAt ? 1 : e.usd / account.monthlyBudget;
    account.quota.unified7d = util;
    account.quota.unified7dReset = nextMonthStart();
    account.probing = false;
    account.apiSpend = {
      month: e.month, usd: e.usd, budget: account.monthlyBudget,
      requests: e.requests, exhaustedAt: e.exhaustedAt || null,
    };
  }

  /** Price one completed exchange on a budgeted API key account. */
  recordSpend(accountIndex, model, usage) {
    const account = this.accounts[accountIndex];
    if (!account?.monthlyBudget || !usage) return;
    const usd = costOf(model, usage);
    if (usd > 0) this.spendLedger.add(account.name, usd);
    this._applySpend(account);
  }

  /** Upstream refused for lack of credit: out until the month rolls over. */
  markCreditExhausted(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (account.monthlyBudget) {
      this.spendLedger.markExhausted(account.name);
      this._applySpend(account);
    } else {
      account.quota.unified7d = 1;
      account.quota.unified7dReset = nextMonthStart();
    }
    console.error(`[TeamClaude] "${account.name}" has no API credit left — skipped until ${new Date(nextMonthStart()).toISOString().slice(0, 10)}`);
  }

  /** Re-read the budget after a config reload. */
  setMonthlyBudget(accountIndex, acct) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const budget = budgetOf(acct);
    if (budget === account.monthlyBudget) return;
    account.monthlyBudget = budget;
    if (!budget) { account.quota.unified7d = null; account.quota.unified7dReset = null; }
    this._applySpend(account);
    console.log(`[TeamClaude] Monthly API budget for "${account.name}": ${budget ? '$' + budget : 'removed'}`);
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens, usageObj = null, model = null) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const u = account.usage;
    if (inputTokens) u.totalInputTokens += inputTokens;
    if (outputTokens) u.totalOutputTokens += outputTokens;

    // Cache counters and the per-model split only exist when the caller hands
    // over the whole usage object. The two positional args are kept so the
    // older call sites (and the OpenAI translator's onUsage) keep working
    // unchanged — they simply contribute nothing to the cache totals.
    const cc = Number(usageObj?.cache_creation_input_tokens) || 0;
    const cr = Number(usageObj?.cache_read_input_tokens) || 0;
    if (cc) u.totalCacheCreationTokens += cc;
    if (cr) u.totalCacheReadTokens += cr;

    if (model) {
      const m = (u.byModel[model] ||= { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0 });
      if (inputTokens) m.input += inputTokens;
      if (outputTokens) m.output += outputTokens;
      if (cc) m.cacheCreation += cc;
      if (cr) m.cacheRead += cr;
      // One request per terminal usage report: streaming sends input at
      // message_start and output at message_delta, so count on the output leg
      // to avoid double counting a single exchange.
      if (outputTokens) m.requests += 1;
    }
    if (inputTokens || outputTokens || cc || cr) u.lastUsed = Date.now();
  }

  /**
   * Enable or disable an account. A disabled account is skipped by rotation
   * until re-enabled. Re-enabling also clears a stuck 'error' state (and any
   * lingering rate-limit hold) so the account is retried immediately.
   */
  setDisabled(accountIndex, disabled) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.disabled = disabled;
    if (!disabled && account.status === 'error') {
      account.status = 'active';
      account.rateLimitedUntil = null;
      // Operator escape hatch: re-enabling is an explicit "try this again", so
      // drop the dead-token guard too — otherwise the account would come back
      // active but never attempt a refresh (see ensureTokenFresh).
      account._deadRefreshToken = null;
      console.log(`[TeamClaude] Account "${account.name}" re-enabled — clearing error state`);
    }
  }

  /**
   * Apply quota learned from the OAuth usage endpoint (the background probe).
   * Updates utilization/reset for the 5h, 7d, Sonnet-7d, and Fable-7d buckets WITHOUT
   * touching usage counters — a probe is not real client traffic.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;

    if (usage.fiveHour) {
      if (usage.fiveHour.utilization != null) q.unified5h = usage.fiveHour.utilization;
      if (usage.fiveHour.resetAt != null) q.unified5hReset = usage.fiveHour.resetAt;
    }
    if (usage.sevenDay) {
      if (usage.sevenDay.utilization != null) q.unified7d = usage.sevenDay.utilization;
      if (usage.sevenDay.resetAt != null) q.unified7dReset = usage.sevenDay.resetAt;
    }
    if (usage.sevenDaySonnet) {
      if (usage.sevenDaySonnet.utilization != null) q.unified7dSonnet = usage.sevenDaySonnet.utilization;
      if (usage.sevenDaySonnet.resetAt != null) q.unified7dSonnetReset = usage.sevenDaySonnet.resetAt;
    }
    if (usage.sevenDayFable) {
      if (usage.sevenDayFable.utilization != null) q.unified7dFable = usage.sevenDayFable.utilization;
      if (usage.sevenDayFable.resetAt != null) q.unified7dFableReset = usage.sevenDayFable.resetAt;
    }

    // If we just learned this account's weekly window while probing, re-evaluate
    // selection (same path as learning it from a live response).
    if (account.probing && q.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
    }
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    // Marks when the hold was (re-)armed: a revalidation probe is allowed only
    // after throttleProbeFloorMs from here, so a probe that 429s again pushes
    // the next probe out by a full floor rather than hammering upstream.
    account.throttledAt = Date.now();
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Clear a rate-limit hold after live proof it no longer binds: any non-429
   * upstream response on a throttled account (a revalidation probe reaching
   * here, or a hold armed moments before traffic resumed). No-op otherwise.
   */
  clearRateLimited(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account || account.status !== 'throttled') return;
    account.status = 'active';
    account.rateLimitedUntil = null;
    account.throttledAt = null;
    console.log(`[TeamClaude] Account "${account.name}" revalidated — rate limit no longer applies, back in rotation`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    // Dead-token guard: a refresh token upstream already rejected (invalid_grant)
    // will be rejected every time, so retrying it only floods the OAuth endpoint
    // — observed live: 287 identical invalid_grant calls after two accounts' tokens
    // were invalidated (a `/login` elsewhere rotates the token and kills the copy
    // teamclaude holds). Paths that bypass availability checks keep calling this
    // (warmup/probe pin an account by name via /tc-acct, skipping _isAvailable),
    // so marking the account 'error' alone does not stop the retries. Keyed on the
    // token VALUE, not the status: the moment a DIFFERENT refresh token arrives
    // (re-login, config reload, updateAccountTokens) the guard lifts on its own.
    if (account._deadRefreshToken && account._deadRefreshToken === account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // A forced refresh answers a 401, but 401s arrive in bursts: every request
    // already in flight when the token went bad comes back rejected, and each
    // one would force its own refresh. Coalescing only covers refreshes that
    // OVERLAP — these arrive staggered, so they would rotate the refresh-token
    // family once per request and make the proxy the very "other holder
    // rotating the family" that causes this failure in the first place. A 401
    // for a token minted moments ago is stale news from a request sent before
    // the refresh landed, so trust the new token and let the caller retry with
    // it. Only an expiry-driven refresh (force=false) bypasses this — it isn't
    // reacting to a response and can't stampede.
    if (force && account._lastRefreshAt !== null
        && Date.now() - account._lastRefreshAt < this._forcedRefreshFloorMs) {
      return;
    }

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await this._refreshFn(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        account._deadRefreshToken = null; // this token works; clear any stale guard
        account._lastRefreshAt = Date.now();
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Reserve 'error' (which drops the account from rotation until re-login)
        // for a GENUINE auth rejection: the refresh token itself is no longer
        // valid — revoked, or invalidated by an account/plan migration. A
        // transient failure (network, 5xx, timeout) must NOT sideline a healthy
        // account: keep its current token and retry on the next request. This is
        // what kept accounts wrongly "errored" after a momentary refresh blip.
        const isAuthRejection = err.status === 400 || err.status === 401 || err.status === 403;
        if (isAuthRejection) {
          account.status = 'error';
          // Remember WHICH token was rejected so we stop re-sending it (see the
          // dead-token guard above). A transient failure deliberately does not
          // arm this — that token may still be good.
          account._deadRefreshToken = account.refreshToken;
          console.error(`[TeamClaude] Account "${account.name}" needs re-login (refresh token rejected) — run: teamclaude login`);
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (account.status === 'error') account.status = 'active';
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push(makeAccount(acctData, index));
    this._applySpend(this.accounts[index]);
    this._sessionCounts.push(0);
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
    // Keep route pins pointing at the right account after the index shift: drop a
    // pin on the removed account, decrement pins that sat above it.
    for (const [name, idx] of [...this.routePins.entries()]) {
      if (idx === index) this.routePins.delete(name);
      else if (idx > index) this.routePins.set(name, idx - 1);
    }
    // Same for session bindings: unbind sessions on the removed account (they
    // rebind on their next request), shift the ones above it. Counts are
    // rebuilt wholesale — removal is rare and the map is capped.
    for (const [id, s] of [...this.sessions.entries()]) {
      if (s.index === index) this.sessions.delete(id);
      else if (s.index > index) s.index--;
    }
    this._sessionCounts = new Array(this.accounts.length).fill(0);
    for (const s of this.sessions.values()) this._sessionCounts[s.index]++;
  }

  /**
   * Serialize persistable quota state for all accounts (no credentials), keyed
   * by account identity so it can be matched back after a restart.
   */
  exportQuotaState() {
    return this.accounts.map(a => {
      const quota = {};
      for (const f of PERSISTED_QUOTA_FIELDS) quota[f] = a.quota[f];
      return { accountUuid: a.accountUuid, orgUuid: a.orgUuid, orgName: a.orgName, name: a.name, quota };
    });
  }

  /**
   * Restore quota learned in a previous run. Matches saved entries to accounts
   * by identity. Stale windows are not special-cased here — _clearExpiredQuotas
   * wipes any restored window whose reset time has already passed on first use.
   */
  restoreQuotaState(saved) {
    if (!Array.isArray(saved)) return;
    for (const account of this.accounts) {
      const match = saved.find(s => sameIdentity(s, account));
      if (!match || !match.quota) continue;
      for (const f of PERSISTED_QUOTA_FIELDS) {
        if (match.quota[f] != null) account.quota[f] = match.quota[f];
      }
      // We already know this account's weekly window, so it isn't "probing".
      if (account.quota.unified7dReset != null) account.probing = false;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    this._sweepSessions(); // report live bindings, not expired ones
    const sessions = this.sessionTracker.stats();
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      reserveFable: this.reserveFable,
      sessionAffinity: {
        enabled: this.affinity.enabled,
        maxPerAccount: this.affinity.maxPerAccount,
        flattenAbove: this.affinity.flattenAbove,
        flattenKeepPriority: this.affinity.flattenKeepPriority,
        overloaded: this._isOverloaded(),
        ttlMinutes: Math.round(this.affinity.ttlMs / 60_000),
        overCapOrder: this.affinity.overCapOrder,
        activeSessions: this.sessions.size,
      },
      routes: this.getRoutes(),
      sessions: { ...sessions, distribute: this.distributeSessions },
      accounts: this.accounts.map(a => ({
        name: a.name,
        sessions: this._sessionCount(a.index),
        type: a.type,
        orgName: a.orgName || null,
        priority: a.priority || 0,
        disabled: a.disabled || false,
        maxUtilization: a.maxUtilization || null,
        fallbackOnly: !!a.fallbackOnly,
        overHardCap: a.maxUtilization ? this.isOverHardCap(a) : false,
        status: a.status,
        // NOTE: `sessions` above is OURS (affinity bindings, drives placement and
        // tcq's `ses` column). Upstream also emitted `sessions:
        // sessions.perAccount[a.index]` here — a SECOND key of the same name in
        // this literal, which is valid JS where the last one silently wins. Its
        // per-account numbers remain available under `sessions.perAccount`.
        quota: { ...a.quota },
        usage: { ...a.usage },
        apiSpend: a.apiSpend ? { ...a.apiSpend } : null,
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
        pausedUntil: a.pausedUntil && a.pausedUntil > Date.now()
          ? new Date(a.pausedUntil).toISOString()
          : null,
      })),
    };
  }
}
