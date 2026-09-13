// Google Health API v4, read-only. Shared by the Worker and tools/backfill.mjs.
//
// Heart rate is only ever read through rollUp (15-minute buckets computed by
// Google). Raw minute samples would blow the free plan's 10 ms CPU budget on
// JSON parsing alone.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API = "https://health.googleapis.com/v4/users/me/dataTypes";
const UA = "health-monitor/1.0";

export class AuthError extends Error {}
export class ApiError extends Error {}

/** Counts outbound requests so a run can stay well under the 50-subrequest cap. */
export function makeCounter(limit = 30) {
  return {
    n: 0,
    tick() {
      if (++this.n > limit) throw new ApiError(`subrequest budget of ${limit} exhausted`);
    },
  };
}

export async function accessToken({ clientId, clientSecret, refreshToken }, counter) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new AuthError("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or GOOGLE_REFRESH_TOKEN is not set");
  }
  counter?.tick();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant is the "access lost" case: revoked, password change, or the
    // 7-day expiry of a consent app still in Testing status.
    if (body.error === "invalid_grant" || res.status === 401) {
      throw new AuthError(`token refresh rejected: ${body.error || res.status} ${body.error_description || ""}`.trim());
    }
    throw new ApiError(`token refresh HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.access_token;
}

async function call(url, token, counter, init = {}) {
  counter?.tick();
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "user-agent": UA, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  if (res.status === 401) throw new AuthError(`API rejected token: ${text.slice(0, 200)}`);
  if (!res.ok) throw new ApiError(`${init.method || "GET"} ${url.split("?")[0]} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

/**
 * List data points, newest first, following pages.
 * stopWhen(point) returning true ends paging after the current page (used for
 * exercise, which rejects every date filter).
 */
export async function listPoints(token, type, { filter, pageSize = 1000, maxPages = 5, stopWhen } = {}, counter) {
  const out = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ pageSize: String(pageSize) });
    if (filter) q.set("filter", filter);
    if (pageToken) q.set("pageToken", pageToken);
    const body = await call(`${API}/${type}/dataPoints?${q}`, token, counter);
    const pts = body.dataPoints || [];
    out.push(...pts);
    pageToken = body.nextPageToken;
    if (!pageToken || (stopWhen && pts.some(stopWhen))) break;
  }
  return out;
}

/**
 * 15-minute (or other) buckets. For heart-rate both the range AND
 * windowSize * pageSize must stay within 14 days (a 900 s window allows at most
 * 1344 per page); the API answers a violation with INVALID_ROLLUP_QUERY_DURATION.
 */
export async function rollUp(token, type, startIso, endIso, windowSize = "900s", counter) {
  const windowS = Number(String(windowSize).replace(/s$/, "")) || 900;
  const pageSize = Math.max(1, Math.min(1344, Math.floor((14 * 86400) / windowS)));
  const out = [];
  let pageToken;
  for (let page = 0; page < 5; page++) {
    const body = await call(`${API}/${type}/dataPoints:rollUp`, token, counter, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        range: { startTime: startIso, endTime: endIso },
        windowSize, pageSize, ...(pageToken ? { pageToken } : {}),
      }),
    });
    out.push(...(body.rollupDataPoints || []));
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}
