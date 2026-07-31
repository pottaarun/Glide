import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WEBHOOK_URL_CHARS,
  buildWebhookPayload,
  validateWebhookUrl,
  webhookHostLabel,
  type GovernanceEvent,
} from "../src/notify.ts";

test("accepts public https webhook URLs and returns a canonical form", () => {
  const ok = validateWebhookUrl("https://hooks.slack.com/services/T000/B000/xyz");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.url, "https://hooks.slack.com/services/T000/B000/xyz");
  assert.equal(validateWebhookUrl("https://example.com/webhook?token=abc").ok, true);
});

test("rejects non-https, credentialed, over-long, and malformed URLs", () => {
  assert.equal(validateWebhookUrl("http://hooks.slack.com/x").ok, false);
  assert.equal(validateWebhookUrl("ftp://example.com/x").ok, false);
  assert.equal(validateWebhookUrl("https://user:pass@example.com/x").ok, false);
  assert.equal(validateWebhookUrl("not a url").ok, false);
  assert.equal(validateWebhookUrl("").ok, false);
  assert.equal(validateWebhookUrl(42).ok, false);
  assert.equal(validateWebhookUrl(`https://example.com/${"a".repeat(MAX_WEBHOOK_URL_CHARS)}`).ok, false);
});

test("SSRF guard blocks IP literals, loopback, and internal hosts", () => {
  assert.equal(validateWebhookUrl("https://127.0.0.1/x").ok, false);
  assert.equal(validateWebhookUrl("https://10.0.0.5/x").ok, false);
  assert.equal(validateWebhookUrl("https://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(validateWebhookUrl("https://[::1]/x").ok, false);
  assert.equal(validateWebhookUrl("https://localhost/x").ok, false);
  assert.equal(validateWebhookUrl("https://metadata.google.internal/x").ok, false);
  assert.equal(validateWebhookUrl("https://svc.internal/x").ok, false);
  assert.equal(validateWebhookUrl("https://box.local/x").ok, false);
  // A bare (non-dotted) host is rejected as not fully-qualified.
  assert.equal(validateWebhookUrl("https://intranet/x").ok, false);
});

test("webhookHostLabel exposes only the hostname (never the secret path)", () => {
  assert.equal(webhookHostLabel("https://hooks.slack.com/services/T/B/secret"), "hooks.slack.com");
  assert.equal(webhookHostLabel("not a url"), undefined);
});

test("buildWebhookPayload is Slack-compatible and carries structured fields", () => {
  const event: GovernanceEvent = {
    id: "evt-1",
    kind: "change_applied",
    title: "Change applied",
    detail: "Enable Always Use HTTPS",
    by: "member@example.com",
    zone: "example.com",
    ts: 1_700_000_000_000,
  };
  const payload = buildWebhookPayload(event, "arubhe.com go-live");
  // Slack renders the top-level text.
  assert.equal(typeof payload.text, "string");
  assert.match(payload.text as string, /Glide \[arubhe\.com go-live\]/);
  assert.match(payload.text as string, /Change applied — Enable Always Use HTTPS/);
  assert.match(payload.text as string, /by member@example\.com · example\.com/);
  assert.equal(payload.source, "Glide");
  // Generic consumers read the structured event.
  assert.deepEqual(payload.event, {
    kind: "change_applied",
    title: "Change applied",
    detail: "Enable Always Use HTTPS",
    by: "member@example.com",
    zone: "example.com",
    ts: 1_700_000_000_000,
  });
});

test("buildWebhookPayload omits optional fields cleanly", () => {
  const payload = buildWebhookPayload({
    id: "evt-2",
    kind: "test",
    title: "Test notification",
    detail: "If you can read this, Glide can reach your webhook.",
    ts: 1,
  });
  assert.equal("room" in payload, false);
  assert.equal((payload.event as Record<string, unknown>).by, undefined);
  assert.match(payload.text as string, /^🔔 Glide: Test notification/);
});
