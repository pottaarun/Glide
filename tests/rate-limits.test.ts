import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_RATE_LIMIT,
  CHAT_RATE_LIMIT,
  clientRateLimitKey,
  consumeRateLimit,
  isClientRateLimitKey,
  opaqueRateLimitKey,
  rateLimitResponse,
} from "../src/rate-limits.ts";

test("rate-limit policy exposes the deployed thresholds", () => {
  assert.deepEqual(AGENT_RATE_LIMIT, { limit: 120, period: 60 });
  assert.deepEqual(CHAT_RATE_LIMIT, { limit: 20, period: 60 });
});

test("client keys are stable, opaque, and ignore spoofable forwarding headers", async () => {
  const first = await clientRateLimitKey(new Request("https://example.com", {
    headers: { "CF-Connecting-IP": "203.0.113.10" },
  }));
  const same = await clientRateLimitKey(new Request("https://example.com", {
    headers: { "CF-Connecting-IP": "203.0.113.10" },
  }));
  const different = await clientRateLimitKey(new Request("https://example.com", {
    headers: { "CF-Connecting-IP": "203.0.113.11" },
  }));
  const untrustedA = await clientRateLimitKey(new Request("https://example.com", {
    headers: { "X-Forwarded-For": "198.51.100.1" },
  }));
  const untrustedB = await clientRateLimitKey(new Request("https://example.com", {
    headers: { "X-Forwarded-For": "198.51.100.2" },
  }));

  assert.equal(first, same);
  assert.notEqual(first, different);
  assert.equal(untrustedA, untrustedB);
  assert.equal(first.includes("203.0.113.10"), false);
  assert.match(first, /^client:[a-f0-9]{64}$/);
});

test("opaque keys separate scopes", async () => {
  assert.notEqual(await opaqueRateLimitKey("client", "same"), await opaqueRateLimitKey("room", "same"));
  assert.equal(isClientRateLimitKey(await opaqueRateLimitKey("client", "same")), true);
  assert.equal(isClientRateLimitKey(await opaqueRateLimitKey("room", "same")), false);
  assert.equal(isClientRateLimitKey("client:attacker-controlled"), false);
});

test("binding outcomes distinguish allowance, exhaustion, and unavailability", async () => {
  assert.equal(await consumeRateLimit({ limit: async () => ({ success: true }) }, "key"), "allowed");
  assert.equal(await consumeRateLimit({ limit: async () => ({ success: false }) }, "key"), "limited");
  assert.equal(await consumeRateLimit({ limit: async () => { throw new Error("offline"); } }, "key"), "unavailable");
});

test("rate-limit responses are retryable and never cache", async () => {
  const limited = rateLimitResponse("limited");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(limited.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await limited.json(), {
    code: "rate_limit_exceeded",
    message: "Too many Glide requests. Wait about a minute and try again.",
  });

  const unavailable = rateLimitResponse("unavailable");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("Retry-After"), "10");
  assert.equal(unavailable.headers.get("Cache-Control"), "no-store");
});
