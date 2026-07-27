export type DeliveryMessage = { id?: string; role?: string };

export type DeliveryStatus = "delivered" | "not_delivered" | "response_interrupted";

const CLOUDFLARE_API_TOKEN = /\bcf(?:at|ut|k)_[A-Za-z0-9_-]{20,}\b/g;
const LEGACY_TOKEN_CONTEXT = /(\b(?:(?:cloudflare|cf)\s+)?(?:api\s+)?(?:token|key|credential)\b\s*(?:(?:is)\s+|[=:]\s*)?["'`]?)([A-Za-z0-9]{40})(?=$|[\s"'`,.;)\]}])/gi;
const LEGACY_BEARER_TOKEN = /(\b(?:authorization\s*:\s*)?bearer\s+)([A-Za-z0-9]{40})(?=$|[\s"'`,.;)\]}])/gi;
const STANDALONE_LEGACY_TOKEN = /^(\s*)([A-Za-z0-9]{40})(\s*)$/;
const TOKEN_REDACTION = "[Cloudflare API token redacted]";

export function containsCloudflareApiToken(text: string, knownToken?: string): boolean {
  return redactCloudflareApiTokens(text, knownToken) !== text;
}

export function redactCloudflareApiTokens(text: string, knownToken?: string): string {
  let redacted = text
    .replace(CLOUDFLARE_API_TOKEN, TOKEN_REDACTION)
    .replace(LEGACY_TOKEN_CONTEXT, `$1${TOKEN_REDACTION}`)
    .replace(LEGACY_BEARER_TOKEN, `$1${TOKEN_REDACTION}`)
    .replace(STANDALONE_LEGACY_TOKEN, `$1${TOKEN_REDACTION}$3`);
  const exactToken = knownToken?.trim();
  if (exactToken && exactToken.length >= 20) {
    redacted = redacted.split(exactToken).join(TOKEN_REDACTION);
  }
  return redacted;
}

/** Classify a submitted user message against the server-authoritative transcript. */
export function persistedDeliveryStatus(
  messages: DeliveryMessage[],
  messageId: string,
): DeliveryStatus {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return "not_delivered";
  return messages[index + 1]?.role === "assistant" ? "delivered" : "response_interrupted";
}
