export type DeliveryMessage = { id?: string; role?: string };

export type DeliveryStatus = "delivered" | "not_delivered" | "response_interrupted";

export function containsCloudflareApiToken(text: string): boolean {
  return /\bcfat_[A-Za-z0-9_-]{20,}\b/.test(text);
}

export function redactCloudflareApiTokens(text: string): string {
  return text.replace(/\bcfat_[A-Za-z0-9_-]{20,}\b/g, "[Cloudflare API token redacted]");
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
