/**
 * Governance-notification helpers (pure).
 *
 * Glide can push governance events (changes applied/failed, drift detected,
 * approvals, auto-reverts) to an owner-configured outgoing webhook AND to an
 * in-app notifications feed. This module is the pure, node-tested core: it
 * validates the webhook URL (with an SSRF guard), builds the Slack-compatible /
 * generic JSON payload, and renders a compact host label — no network I/O, which
 * the server layer performs. Mirrors the pure-engine pattern used by
 * {@link ./posture}, {@link ./blast-radius}, and {@link ./change-risk}.
 */

/** Kinds of governance event Glide can notify about. */
export type GovernanceEventKind =
  | "change_applied"
  | "change_failed"
  | "approval_recorded"
  | "auto_revert"
  | "drift_detected"
  | "test";

/** One governance event, shared by the in-app feed and the webhook payload. */
export interface GovernanceEvent {
  id: string;
  kind: GovernanceEventKind;
  /** Short headline, e.g. "Change applied". */
  title: string;
  /** One-line detail (the change summary, drift count, etc.). */
  detail: string;
  /** Verified actor email, when the event has one. */
  by?: string;
  /** Zone name for context, when relevant. */
  zone?: string;
  ts: number;
}

/** Max characters accepted for a webhook URL. */
export const MAX_WEBHOOK_URL_CHARS = 2048;

type UrlResult = { ok: true; url: string } | { ok: false; message: string };

/** Private/loopback/link-local/metadata hosts a webhook must never target. */
const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localdomain"];
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
]);

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Validate an owner-supplied webhook URL for outbound delivery. Enforces https,
 * rejects embedded credentials, and blocks IP literals and internal/loopback/
 * metadata hostnames (SSRF guard) so the URL can only reach a public endpoint.
 * Returns the canonical URL string on success.
 */
export function validateWebhookUrl(raw: unknown): UrlResult {
  if (typeof raw !== "string") return { ok: false, message: "Webhook URL must be text." };
  const value = raw.trim();
  if (!value) return { ok: false, message: "Webhook URL was empty." };
  if (value.length > MAX_WEBHOOK_URL_CHARS) {
    return { ok: false, message: `Webhook URL must be ${MAX_WEBHOOK_URL_CHARS} characters or fewer.` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "That doesn't look like a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "Webhook URL must start with https://." };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Webhook URL must not embed a username or password." };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, message: "Webhook URL is missing a host." };
  // Block IPv4 literals and any bracketed IPv6 literal; webhooks use DNS names.
  if (isIpv4Literal(host) || host.includes(":") || value.includes("[")) {
    return { ok: false, message: "Use a public hostname, not an IP address." };
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, message: "That host is not reachable for webhooks." };
  }
  if (!host.includes(".")) {
    return { ok: false, message: "Use a fully-qualified public hostname." };
  }
  return { ok: true, url: url.toString() };
}

/** Hostname for a non-sensitive display of the configured webhook (never the secret path). */
export function webhookHostLabel(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const KIND_EMOJI: Record<GovernanceEventKind, string> = {
  change_applied: "✅",
  change_failed: "⚠️",
  approval_recorded: "🖊️",
  auto_revert: "↩️",
  drift_detected: "📉",
  test: "🔔",
};

/**
 * Build the webhook request body. Slack incoming webhooks render the top-level
 * `text`; generic consumers can read the structured `event` object. Kept small
 * and free of secrets.
 */
export function buildWebhookPayload(
  event: GovernanceEvent,
  roomName?: string,
): Record<string, unknown> {
  const emoji = KIND_EMOJI[event.kind] ?? "🔔";
  const room = roomName ? ` [${roomName}]` : "";
  const headline = [event.title, event.detail].filter(Boolean).join(" — ");
  const suffix = [event.by ? `by ${event.by}` : "", event.zone ?? ""].filter(Boolean).join(" · ");
  const text = `${emoji} Glide${room}: ${headline}${suffix ? ` (${suffix})` : ""}`;
  return {
    text,
    source: "Glide",
    ...(roomName ? { room: roomName } : {}),
    event: {
      kind: event.kind,
      title: event.title,
      detail: event.detail,
      ...(event.by ? { by: event.by } : {}),
      ...(event.zone ? { zone: event.zone } : {}),
      ts: event.ts,
    },
  };
}
