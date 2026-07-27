import assert from "node:assert/strict";
import test from "node:test";

import {
  containsCloudflareApiToken,
  persistedDeliveryStatus,
  redactCloudflareApiTokens,
} from "../src/chat-delivery.ts";

test("reports a user message followed by an assistant response as delivered", () => {
  assert.equal(
    persistedDeliveryStatus(
      [
        { id: "user-1", role: "user" },
        { id: "assistant-1", role: "assistant" },
      ],
      "user-1",
    ),
    "delivered",
  );
});

test("reports an optimistic message missing from server history as not delivered", () => {
  assert.equal(
    persistedDeliveryStatus([{ id: "older", role: "assistant" }], "user-1"),
    "not_delivered",
  );
});

test("reports a persisted user turn with no assistant response as interrupted", () => {
  assert.equal(
    persistedDeliveryStatus([{ id: "user-1", role: "user" }], "user-1"),
    "response_interrupted",
  );
});

test("detects and redacts Cloudflare API tokens without retaining the secret", () => {
  for (const prefix of ["cfat_", "cfut_", "cfk_"]) {
    const secret = `${prefix}${"a".repeat(40)}`;
    assert.equal(containsCloudflareApiToken(`use ${secret}`), true);
    const redacted = redactCloudflareApiTokens(`use ${secret} now`);
    assert.equal(redacted, "use [Cloudflare API token redacted] now");
    assert.equal(redacted.includes(secret), false);
  }
  assert.equal(containsCloudflareApiToken("cfat_too-short"), false);
});

test("redacts legacy unprefixed tokens only when the context is credential-like", () => {
  const legacy = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
  assert.equal(legacy.length, 40);
  assert.equal(containsCloudflareApiToken(legacy), true);
  assert.equal(containsCloudflareApiToken(`Cloudflare API token: ${legacy}`), true);
  assert.equal(containsCloudflareApiToken(`Authorization: Bearer ${legacy}`), true);
  assert.equal(redactCloudflareApiTokens(`token=${legacy}`), "token=[Cloudflare API token redacted]");
  assert.equal(containsCloudflareApiToken(`Build identifier ${legacy}`), false);
});

test("redacts the room's exact stored token regardless of format or context", () => {
  const token = "legacy-room-token-with-unusual-format-123";
  assert.equal(
    redactCloudflareApiTokens(`Accidentally pasted ${token} here`, token),
    "Accidentally pasted [Cloudflare API token redacted] here",
  );
});
