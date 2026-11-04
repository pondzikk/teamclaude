// Quota reader for Kimi (Moonshot) subscription accounts.
//
// Kimi's Anthropic-compatible coding endpoint (api.kimi.com/coding) returns NO
// `anthropic-ratelimit-*` headers and exposes no quota route, so the normal
// header path in account-manager.updateQuota() can never learn anything about a
// Kimi account — it would sit at "?" forever. The numbers the web console shows
// come from a separate Connect-RPC gateway on www.kimi.ai, which answers with a
// plain bearer token (no cookies needed).
//
// Two windows come back, and they line up with the fleet's own model closely
// enough to reuse it verbatim:
//   ratelimitCode5h → the 5-hour window  → quota.unified5h
//   ratelimitCode7d → the weekly window  → quota.unified7d
// `ratio` is already a 0-1 utilization, which is exactly what applyUsageData()
// expects, so the shape returned here is the same one oauth.fetchUsage() returns
// and the prober needs no special case beyond picking this function.
//
// The token is a SHORT-LIVED web access token (15 minutes). This module does not
// refresh it — it reports 401 as an error so the caller can surface "stale"
// rather than silently showing quota frozen at whatever it last saw.

const STATS_URL = 'https://www.kimi.ai/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';

/** Go-style RFC3339 with nanoseconds — Date can't parse 9 fractional digits. */
function parseResetTime(value) {
  if (!value) return null;
  const ms = Date.parse(String(value).replace(/\.(\d{3})\d+Z$/, '.$1Z'));
  return Number.isNaN(ms) ? null : ms;
}

function windowOf(node) {
  if (!node || node.enabled === false) return null;
  const utilization = typeof node.ratio === 'number' ? node.ratio : null;
  if (utilization == null) return null;
  return { utilization, resetAt: parseResetTime(node.resetTime) };
}

/**
 * Read a Kimi account's quota. Returns the applyUsageData() shape, or
 * `{ error }` — never throws, so a probe cycle can't take the proxy down.
 */
export async function fetchKimiUsage(webToken, { fetchImpl = fetch, url = STATS_URL } = {}) {
  if (!webToken) return { error: 'no web token configured' };
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${webToken}`,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-msh-platform': 'web',
      },
      body: '{}',
    });
  } catch (err) {
    return { error: `kimi quota request failed: ${err?.message || err}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { error: 'kimi web token expired (re-capture it from the console)', status: res.status };
  }
  if (!res.ok) return { error: `kimi quota HTTP ${res.status}`, status: res.status };

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { error: `kimi quota returned non-JSON: ${err?.message || err}` };
  }

  const fiveHour = windowOf(body.ratelimitCode5h);
  const sevenDay = windowOf(body.ratelimitCode7d);
  // A 200 carrying neither window means the response shape moved; say so rather
  // than reporting a successful probe that learned nothing.
  if (!fiveHour && !sevenDay) return { error: 'kimi quota response had no rate-limit windows' };

  const usage = {};
  if (fiveHour) usage.fiveHour = fiveHour;
  if (sevenDay) usage.sevenDay = sevenDay;
  return usage;
}
