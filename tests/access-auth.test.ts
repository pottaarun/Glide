import assert from "node:assert/strict";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  accessAuthErrorResponse,
  authenticateAccessRequest,
  canonicalizeEmail,
  isCloudflareEmployeeEmail,
  verifyAccessToken,
} from "../src/access-auth.ts";

const ISSUER = "https://glide-test.cloudflareaccess.com";
const AUDIENCE = "glide-test-audience";

test("Access email identities are canonical and employee checks are exact", () => {
  assert.equal(canonicalizeEmail("  Avery@Cloudflare.com "), "avery@cloudflare.com");
  assert.equal(isCloudflareEmployeeEmail("Avery@Cloudflare.com"), true);
  assert.equal(isCloudflareEmployeeEmail("avery@cloudflare.com.example"), false);
  assert.equal(canonicalizeEmail("not-an-email"), undefined);
});

test("Access authentication fails closed when configuration or assertions are missing", async () => {
  const request = new Request("https://example.com/api/session");
  assert.deepEqual(
    await authenticateAccessRequest(request, {}),
    {
      ok: false,
      status: 503,
      code: "access_not_configured",
      message: "Glide authentication is not configured. Ask the operator to finish the Cloudflare Access setup.",
    },
  );
  assert.deepEqual(
    await authenticateAccessRequest(request, { TEAM_DOMAIN: ISSUER, POLICY_AUD: AUDIENCE }),
    {
      ok: false,
      status: 401,
      code: "access_token_missing",
      message: "Authenticate with Cloudflare Access before opening Glide.",
    },
  );
});

test("the explicit development identity works only on loopback URLs", async () => {
  const env = { GLIDE_DEV_ACCESS_EMAIL: " Developer@Cloudflare.com " };
  const local = await authenticateAccessRequest(new Request("http://localhost:8787/api/session"), env);
  assert.equal(local.ok, true);
  if (local.ok) {
    assert.equal(local.identity.email, "developer@cloudflare.com");
    assert.equal(local.identity.subject, "local-dev:developer@cloudflare.com");
  }

  assert.deepEqual(
    await authenticateAccessRequest(new Request("https://glide.example.com/api/session"), env),
    {
      ok: false,
      status: 503,
      code: "access_not_configured",
      message: "Glide authentication is not configured. Ask the operator to finish the Cloudflare Access setup.",
    },
  );
});

test("Access JWT verification requires a signed identity app token", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1_000);
  const token = await new SignJWT({ email: "Member@Example.com", type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setAudience(AUDIENCE)
    .setExpirationTime(now + 300)
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setNotBefore(now - 1)
    .setSubject("member-subject")
    .sign(privateKey);

  assert.deepEqual(
    await verifyAccessToken(token, ISSUER, AUDIENCE, publicKey),
    {
      email: "member@example.com",
      subject: "member-subject",
      expiresAt: now + 300,
    },
  );
  await assert.rejects(() => verifyAccessToken(token, ISSUER, "wrong-audience", publicKey));
});

test("Access JWT verification rejects service and incomplete identity tokens", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1_000);
  const serviceToken = await new SignJWT({ type: "app", common_name: "service.access" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setAudience(AUDIENCE)
    .setExpirationTime(now + 300)
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setSubject("")
    .sign(privateKey);

  await assert.rejects(() => verifyAccessToken(serviceToken, ISSUER, AUDIENCE, publicKey));
});

test("remote Access keys are cached while key-service failures remain retryable", async () => {
  async function fixture(issuer: string, kid: string) {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const now = Math.floor(Date.now() / 1_000);
    return {
      jwk: { ...await exportJWK(publicKey), alg: "RS256", kid, use: "sig" },
      token: await new SignJWT({ email: "member@example.com", type: "app" })
        .setProtectedHeader({ alg: "RS256", kid })
        .setAudience(AUDIENCE)
        .setExpirationTime(now + 300)
        .setIssuedAt(now)
        .setIssuer(issuer)
        .setSubject("member-subject")
        .sign(privateKey),
    };
  }

  const cacheIssuer = "https://cache-test.cloudflareaccess.com";
  const unavailableIssuer = "https://unavailable-test.cloudflareaccess.com";
  const unknownKeyIssuer = "https://unknown-key-test.cloudflareaccess.com";
  const [cached, unavailable, unknown] = await Promise.all([
    fixture(cacheIssuer, "cached-key"),
    fixture(unavailableIssuer, "unavailable-key"),
    fixture(unknownKeyIssuer, "unknown-key"),
  ]);
  const fetches = new Map<string, number>();
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    fetches.set(url, (fetches.get(url) ?? 0) + 1);
    if (url === `${cacheIssuer}/cdn-cgi/access/certs`) return Response.json({ keys: [cached.jwk] });
    if (url === `${unavailableIssuer}/cdn-cgi/access/certs`) return new Response(null, { status: 503 });
    if (url === `${unknownKeyIssuer}/cdn-cgi/access/certs`) return Response.json({ keys: [] });
    throw new Error(`Unexpected JWKS request: ${url}`);
  }) as typeof fetch;
  console.error = () => {};

  try {
    await verifyAccessToken(cached.token, cacheIssuer, AUDIENCE);
    await verifyAccessToken(cached.token, cacheIssuer, AUDIENCE);
    assert.equal(fetches.get(`${cacheIssuer}/cdn-cgi/access/certs`), 1);

    const unavailableResult = await authenticateAccessRequest(
      new Request("https://example.com/api/session", {
        headers: { "Cf-Access-Jwt-Assertion": unavailable.token },
      }),
      { TEAM_DOMAIN: unavailableIssuer, POLICY_AUD: AUDIENCE },
    );
    assert.deepEqual(unavailableResult, {
      ok: false,
      status: 503,
      code: "access_keys_unavailable",
      message: "Glide could not retrieve Cloudflare Access signing keys. Retry shortly.",
    });
    if (!unavailableResult.ok) {
      assert.equal(accessAuthErrorResponse(unavailableResult).headers.get("retry-after"), "10");
    }

    const unknownKeyResult = await authenticateAccessRequest(
      new Request("https://example.com/api/session", {
        headers: { "Cf-Access-Jwt-Assertion": unknown.token },
      }),
      { TEAM_DOMAIN: unknownKeyIssuer, POLICY_AUD: AUDIENCE },
    );
    assert.equal(unknownKeyResult.ok, false);
    if (!unknownKeyResult.ok) {
      assert.equal(unknownKeyResult.status, 403);
      assert.equal(unknownKeyResult.code, "access_token_invalid");
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
