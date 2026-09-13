// Cloudflare Access JWT verification.
//
// Access in front of the route is the gate, but the Worker verifies the token
// itself instead of trusting a header: a header can be forged by anything that
// reaches the Worker without passing through Access (a misconfigured route, a
// preview URL). Fails closed on every doubt.

const enc = new TextEncoder();
let certCache = { team: null, keys: null, fetchedAt: 0 };

const b64urlBytes = (s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

export const normaliseTeam = (team) => {
  const t = String(team || "").trim().replace(/\/+$/, "");
  return t.startsWith("https://") ? t : `https://${t}`;
};

async function loadKeys(team, fetchCerts) {
  const fresh = Date.now() - certCache.fetchedAt < 3600_000;
  if (certCache.team === team && certCache.keys && fresh) return certCache.keys;
  const jwks = await fetchCerts(team);
  certCache = { team, keys: jwks.keys || [], fetchedAt: Date.now() };
  return certCache.keys;
}

async function defaultFetchCerts(team) {
  const res = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs HTTP ${res.status}`);
  return res.json();
}

/** For tests: forget cached signing keys. */
export function resetCertCache() {
  certCache = { team: null, keys: null, fetchedAt: 0 };
}

/**
 * Returns { ok: true, email } or { ok: false, status, message }.
 * opts.fetchCerts and opts.nowS exist for tests.
 */
export async function verifyAccess(request, env, opts = {}) {
  const missing = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ALLOWED_EMAIL"].filter((k) => !env[k]);
  if (missing.length) {
    return { ok: false, status: 503, message: `Access is not configured: set ${missing.join(", ")}. Nothing is served until it is.` };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, status: 403, message: "Forbidden: no Cloudflare Access token on this request." };

  const parts = token.split(".");
  if (parts.length !== 3) return deny("malformed token");
  let header, claims;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return deny("unreadable token"); }
  if (header.alg !== "RS256") return deny(`unsupported alg ${header.alg}`);

  const team = normaliseTeam(env.ACCESS_TEAM_DOMAIN);
  let keys;
  try { keys = await loadKeys(team, opts.fetchCerts || defaultFetchCerts); } catch (err) { return { ok: false, status: 503, message: `Cannot load Access keys: ${err.message}` }; }
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Keys rotate; refetch once before refusing.
    resetCertCache();
    try { keys = await loadKeys(team, opts.fetchCerts || defaultFetchCerts); } catch { keys = []; }
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return deny("unknown signing key");

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch { valid = false; }
  if (!valid) return deny("bad signature");

  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return deny("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp < now - 30) return deny("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) return deny("not yet valid");
  if (claims.iss && normaliseTeam(claims.iss) !== team) return deny("wrong issuer");
  const email = String(claims.email || "").toLowerCase();
  if (email !== String(env.ALLOWED_EMAIL).toLowerCase()) return deny("email not allowed");
  return { ok: true, email };
}

const deny = (why) => ({ ok: false, status: 403, message: `Forbidden: ${why}.` });
