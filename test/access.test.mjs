import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetCertCache, verifyAccess } from "../src/access.js";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAIL: "owner@example.com" };
const NOW = 1_790_000_000;

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function keypair(kid) {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kp, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

async function sign(kp, kid, claims, header = { alg: "RS256", kid, typ: "JWT" }) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const req = (token) => new Request("https://health.example/", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
const good = () => ({ aud: [AUD], email: "owner@example.com", exp: NOW + 600, iat: NOW - 10, iss: TEAM });

let signer, other;
beforeEach(async () => {
  resetCertCache();
  signer ??= await keypair("k1");
  other ??= await keypair("k2");
});
const opts = () => ({ nowS: NOW, fetchCerts: async () => ({ keys: [signer.jwk] }) });

test("accepts a valid token for the allowed email", async () => {
  const r = await verifyAccess(req(await sign(signer.kp, "k1", good())), env, opts());
  assert.deepEqual(r, { ok: true, email: "owner@example.com" });
});

test("fails closed when Access is not configured", async () => {
  const r = await verifyAccess(req("x.y.z"), { ...env, ACCESS_AUD: "" }, opts());
  assert.equal(r.status, 503);
  assert.match(r.message, /ACCESS_AUD/);
});

test("rejects missing, unsigned, wrongly signed, wrong aud, expired and wrong email", async () => {
  assert.equal((await verifyAccess(req(null), env, opts())).status, 403);

  const unsigned = await sign(signer.kp, "k1", good(), { alg: "none", kid: "k1" });
  assert.equal((await verifyAccess(req(unsigned.split(".").slice(0, 2).join(".") + "."), env, opts())).status, 403);
  assert.equal((await verifyAccess(req(unsigned), env, opts())).status, 403);

  // Signed by a key Access never published, but claiming its kid.
  const forged = await sign(other.kp, "k1", good());
  const f = await verifyAccess(req(forged), env, opts());
  assert.equal(f.ok, false);
  assert.match(f.message, /signature/);

  const wrongAud = await verifyAccess(req(await sign(signer.kp, "k1", { ...good(), aud: ["someone-else"] })), env, opts());
  assert.match(wrongAud.message, /audience/);

  const expired = await verifyAccess(req(await sign(signer.kp, "k1", { ...good(), exp: NOW - 3600 })), env, opts());
  assert.match(expired.message, /expired/);

  const stranger = await verifyAccess(req(await sign(signer.kp, "k1", { ...good(), email: "stranger@example.com" })), env, opts());
  assert.match(stranger.message, /email/);

  // Tampered payload with the original signature.
  const t = (await sign(signer.kp, "k1", good())).split(".");
  t[1] = b64url(JSON.stringify({ ...good(), email: "owner@example.com", exp: NOW + 999999 }));
  assert.equal((await verifyAccess(req(t.join(".")), env, opts())).ok, false);
});
