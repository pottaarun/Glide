import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CHAT_PROTOCOL_BYTES,
  MAX_CHAT_REQUEST_BODY_BYTES,
  MAX_MODEL_CHAT_HISTORY_BYTES,
  MAX_CHAT_TEXT_CHARS,
  boundedChatHistory,
  chatParticipantNameError,
  clientChatSubmissionError,
  containsCloudflareApiToken,
  interruptedRetryTarget,
  isAuthoritativeRetryTarget,
  isChatTextWithinLimit,
  isJsonStructureWithinLimits,
  isValidChatProtocolId,
  isWithinUtf8ByteLimit,
  isUntrustedChatRole,
  persistedDeliveryStatus,
  redactCloudflareApiTokens,
} from "../src/chat-delivery.ts";

test("allows a maximally escaped bounded request inside its protocol frame", () => {
  const body = `{"messages":["${"\\\"".repeat(2_500_000)}"]}`;
  const frame = JSON.stringify({ type: "chat-request", id: "quote-heavy", init: { method: "POST", body } });

  assert.equal(isWithinUtf8ByteLimit(body, MAX_CHAT_REQUEST_BODY_BYTES), true);
  assert.equal(isWithinUtf8ByteLimit(frame, MAX_CHAT_PROTOCOL_BYTES), true);
  assert.equal(isWithinUtf8ByteLimit("x".repeat(MAX_CHAT_REQUEST_BODY_BYTES + 1), MAX_CHAT_REQUEST_BODY_BYTES), false);
});

test("rejects structurally dense or deeply nested JSON before parsing", () => {
  assert.equal(isJsonStructureWithinLimits('{"text":"[{},{}]"}'), true);
  assert.equal(isJsonStructureWithinLimits(`[${"[] ,".repeat(30_000)}null]`), false);
  assert.equal(isJsonStructureWithinLimits(`${"[".repeat(65)}${"]".repeat(65)}`), false);
  assert.equal(isJsonStructureWithinLimits('{"messages":[]}'), true);
});

test("counts UTF-8 bytes without allocating an encoded copy", () => {
  assert.equal(isWithinUtf8ByteLimit("é", 1), false);
  assert.equal(isWithinUtf8ByteLimit("é", 2), true);
  assert.equal(isWithinUtf8ByteLimit("😀", 4), true);
  assert.equal(isWithinUtf8ByteLimit("😀", 3), false);
});

test("bounds chat prose before server-side inference and prompt assembly", () => {
  assert.equal(isChatTextWithinLimit("a".repeat(MAX_CHAT_TEXT_CHARS)), true);
  assert.equal(isChatTextWithinLimit("a".repeat(MAX_CHAT_TEXT_CHARS + 1)), false);
});

test("participant names use the same bounded validation as chat admission", () => {
  assert.equal(chatParticipantNameError(" Avery "), undefined);
  assert.match(chatParticipantNameError("x".repeat(81)) ?? "", /1-80/);
  assert.match(chatParticipantNameError("bad\u0000name") ?? "", /control/i);
  assert.match(chatParticipantNameError("cfat_abcdefghijklmnopqrstuvwxyz") ?? "", /token/i);
});

test("reports a user message followed by an assistant response as delivered", () => {
  assert.equal(
    persistedDeliveryStatus(
      [
        { id: "user-1", role: "user" },
        { id: "assistant-1", role: "assistant", metadata: { responseTo: "user-1", delivery: "completed" } },
      ],
      "user-1",
    ),
    "delivered",
  );
});

test("correlates interleaved assistant responses to their user turns", () => {
  const messages = [
    { id: "user-a", role: "user" },
    { id: "user-b", role: "user" },
    { id: "assistant-a", role: "assistant", metadata: { responseTo: "user-a", delivery: "completed" } },
    { id: "assistant-b", role: "assistant", metadata: { responseTo: "user-b", delivery: "completed" } },
  ];
  assert.equal(persistedDeliveryStatus(messages, "user-a"), "delivered");
  assert.equal(persistedDeliveryStatus(messages, "user-b"), "delivered");
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

test("partial correlated assistant output remains interrupted", () => {
  assert.equal(
    persistedDeliveryStatus(
      [
        { id: "user-1", role: "user" },
        { id: "assistant-1", role: "assistant", metadata: { responseTo: "user-1" } },
      ],
      "user-1",
    ),
    "response_interrupted",
  );
});

test("server retries only a latest unanswered or registered interrupted user turn", () => {
  const authoritative = [
    { id: "user-a", role: "user" },
    { id: "assistant-a", role: "assistant" },
    { id: "user-b", role: "user" },
  ];
  assert.equal(isAuthoritativeRetryTarget(authoritative, "user-b"), true);
  assert.equal(isAuthoritativeRetryTarget(authoritative, "user-a"), false);
  assert.equal(isAuthoritativeRetryTarget([...authoritative, { id: "assistant-b", role: "assistant" }], "user-b"), false);
  const interrupted = [
    ...authoritative,
    {
      id: "assistant-b",
      role: "assistant",
      metadata: { responseTo: "user-b", delivery: "interrupted" },
    },
  ];
  assert.equal(isAuthoritativeRetryTarget(interrupted, "user-b", "assistant-b"), true);
  assert.equal(isAuthoritativeRetryTarget(interrupted, "user-a", "assistant-b"), false);
  assert.equal(
    isAuthoritativeRetryTarget(
      [...authoritative, { id: "assistant-b", role: "assistant", metadata: { responseTo: "user-b", delivery: "completed" } }],
      "user-b",
      "assistant-b",
    ),
    false,
  );
  const partial = [
    ...authoritative,
    { id: "assistant-b", role: "assistant", metadata: { responseTo: "user-b" } },
  ];
  assert.deepEqual(interruptedRetryTarget(partial), {
    messageId: "user-b",
    interruptedAssistantId: "assistant-b",
  });
  assert.equal(isAuthoritativeRetryTarget(partial, "user-b", "assistant-b"), true);
});

test("chat protocol ids reject JavaScript coercion", () => {
  assert.equal(isValidChatProtocolId("request_01"), true);
  for (const value of [undefined, null, 123, ["request_01"], {}, "", "request/01"]) {
    assert.equal(isValidChatProtocolId(value), false);
  }
});

test("client-authored system roles are treated as untrusted user input", () => {
  assert.equal(isUntrustedChatRole("user"), true);
  assert.equal(isUntrustedChatRole("system"), true);
  assert.equal(isUntrustedChatRole("assistant"), false);
});

test("chat submissions append exactly one plain user message to authoritative history", () => {
  const history = [{ id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Hi" }] }];
  const user = {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "Hello" }],
    metadata: { name: "Avery" },
  };
  assert.equal(clientChatSubmissionError(history, [...history, user]), undefined);
  assert.match(
    clientChatSubmissionError(history, [...history, user], (id) => id === "user-1") ?? "",
    /already been accepted/i,
  );
  assert.match(clientChatSubmissionError(history, [user]) ?? "", /stale/i);
  assert.match(
    clientChatSubmissionError(history, [...history, { ...user, role: "assistant" }]) ?? "",
    /malformed/i,
  );
  assert.match(
    clientChatSubmissionError(history, [...history, user, { ...user, id: "user-2" }]) ?? "",
    /stale/i,
  );
  assert.match(
    clientChatSubmissionError(history, [
      ...history,
      { ...user, parts: [{ type: "text", text: `token cfat_${"a".repeat(40)}` }] },
    ]) ?? "",
    /token/i,
  );
});

test("chat history windows retain only the newest messages within a byte budget", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: "x".repeat(100) }));
  const bounded = boundedChatHistory(messages, 5, 500);
  assert.ok(bounded.length <= 5);
  assert.equal(bounded.at(-1)?.id, "9");
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= 500);
  assert.deepEqual(boundedChatHistory(messages, 80, MAX_MODEL_CHAT_HISTORY_BYTES), messages);
});

test("chat history bounds never retain an assistant without its correlated user turn", () => {
  const user = { id: "user-1", role: "user", parts: [{ type: "text", text: "Question" }] };
  const assistant = {
    id: "assistant-1",
    role: "assistant",
    metadata: { responseTo: "user-1", delivery: "completed" },
    parts: [{ type: "text", text: "Answer" }],
  };
  assert.deepEqual(boundedChatHistory([user, assistant], 1, 10_000), []);
  assert.deepEqual(boundedChatHistory([user, assistant], 2, 10_000), [user, assistant]);
  assert.deepEqual(
    boundedChatHistory([{ ...assistant, metadata: undefined }], 2, 10_000),
    [],
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
