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
  const secret = `cfat_${"a".repeat(40)}`;
  assert.equal(containsCloudflareApiToken(`use ${secret}`), true);
  const redacted = redactCloudflareApiTokens(`use ${secret} now`);
  assert.equal(redacted, "use [Cloudflare API token redacted] now");
  assert.equal(redacted.includes(secret), false);
});
