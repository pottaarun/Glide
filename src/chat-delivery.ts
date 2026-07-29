export type DeliveryMessage = {
  id?: string;
  role?: string;
  metadata?: unknown;
};

export type DeliveryStatus = "delivered" | "not_delivered" | "response_interrupted";

/** Bound user/assistant prose before persistence, inference, and prompt assembly. */
export const MAX_CHAT_TEXT_CHARS = 20_000;
export const MAX_CHAT_PARTICIPANT_NAME_CHARS = 80;
/** Bound browser buffering for the persisted transcript endpoint. */
export const MAX_CHAT_HISTORY_BYTES = 5_000_000;
/** Bound the decoded request body before parsing client-submitted history. */
export const MAX_CHAT_REQUEST_BODY_BYTES = MAX_CHAT_HISTORY_BYTES + 100_000;
/** A JSON-stringified request body can nearly double when nested in the protocol frame. */
export const MAX_CHAT_PROTOCOL_BYTES = MAX_CHAT_REQUEST_BODY_BYTES * 2 + 100_000;
export const MAX_CHAT_JSON_DEPTH = 64;
export const MAX_CHAT_JSON_STRUCTURAL_TOKENS = 50_000;
/** Keep storage and initial-history work finite for long-lived rooms. */
export const MAX_PERSISTED_CHAT_MESSAGES = 200;
/** Stay below the browser limit and Durable Object row aggregate with headroom. */
export const MAX_PERSISTED_CHAT_HISTORY_BYTES = 4_000_000;
/** Leave ample room in the model context for the system prompt, RAG, and output. */
export const MAX_MODEL_CHAT_HISTORY_BYTES = 160_000;
export const MAX_MODEL_CHAT_MESSAGES = 80;
/** Bound one delivery-ledger lookup from reconnecting clients. */
export const MAX_CHAT_DELIVERY_STATUS_IDS = 100;

export function isChatTextWithinLimit(text: string): boolean {
  return text.length <= MAX_CHAT_TEXT_CHARS;
}

export function isWithinUtf8ByteLimit(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maxBytes) return false;
  }
  return true;
}

/** Reject deeply nested or token-dense JSON before JSON.parse allocates its object graph. */
export function isJsonStructureWithinLimits(
  value: string,
  maxDepth = MAX_CHAT_JSON_DEPTH,
  maxStructuralTokens = MAX_CHAT_JSON_STRUCTURAL_TOKENS,
): boolean {
  let depth = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      tokens += 1;
      if (depth > maxDepth || tokens > maxStructuralTokens) return false;
    } else if (char === "}" || char === "]") {
      if (depth === 0) return false;
      depth -= 1;
      tokens += 1;
    } else if (char === "," || char === ":") {
      tokens += 1;
    }
    if (tokens > maxStructuralTokens) return false;
  }
  return !inString && depth === 0;
}

export function isValidChatProtocolId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

const CLOUDFLARE_API_TOKEN = /\bcf(?:at|ut|k)_[A-Za-z0-9_-]{20,}\b/g;
const LEGACY_TOKEN_CONTEXT = /(\b(?:(?:cloudflare|cf)\s+)?(?:api\s+)?(?:token|key|credential)\b\s*(?:(?:is)\s+|[=:]\s*)?["'`]?)([A-Za-z0-9]{40})(?=$|[\s"'`,.;)\]}])/gi;
const LEGACY_BEARER_TOKEN = /(\b(?:authorization\s*:\s*)?bearer\s+)([A-Za-z0-9]{40})(?=$|[\s"'`,.;)\]}])/gi;
const STANDALONE_LEGACY_TOKEN = /^(\s*)([A-Za-z0-9]{40})(\s*)$/;
const TOKEN_REDACTION = "[Cloudflare API token redacted]";

export function containsCloudflareApiToken(text: string, knownToken?: string): boolean {
  return redactCloudflareApiTokens(text, knownToken) !== text;
}

export function chatParticipantNameError(value: string, knownToken?: string): string | undefined {
  const name = value.trim();
  if (!name || name.length > MAX_CHAT_PARTICIPANT_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(name)) {
    return `Display name must be 1-${MAX_CHAT_PARTICIPANT_NAME_CHARS} characters without control characters.`;
  }
  if (containsCloudflareApiToken(name, knownToken)) {
    return "Display name cannot contain a Cloudflare API token.";
  }
  return undefined;
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
  messages: readonly DeliveryMessage[],
  messageId: string,
): DeliveryStatus {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return "not_delivered";
  const metadata = (message: DeliveryMessage): { responseTo?: unknown; delivery?: unknown } =>
    message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? message.metadata as { responseTo?: unknown; delivery?: unknown }
      : {};
  const correlated = messages
    .slice(index + 1)
    .find(
      (message) =>
        message.role === "assistant" &&
        metadata(message).responseTo === messageId &&
        metadata(message).delivery === "completed",
    );
  if (correlated) return "delivered";
  return "response_interrupted";
}

export interface InterruptedRetryTarget {
  messageId: string;
  interruptedAssistantId?: string;
}

/** Identify a latest user turn or its correlated assistant when completion was never recorded. */
export function interruptedRetryTarget(
  messages: readonly DeliveryMessage[],
): InterruptedRetryTarget | undefined {
  const latest = messages[messages.length - 1];
  if (latest?.role === "user" && typeof latest.id === "string") return { messageId: latest.id };
  const previous = messages[messages.length - 2];
  const metadata = latest?.metadata && typeof latest.metadata === "object" && !Array.isArray(latest.metadata)
    ? latest.metadata as { responseTo?: unknown; delivery?: unknown }
    : {};
  if (
    latest?.role === "assistant" &&
    typeof latest.id === "string" &&
    typeof metadata.responseTo === "string" &&
    metadata.delivery !== "completed" &&
    previous?.role === "user" &&
    previous.id === metadata.responseTo
  ) {
    return { messageId: metadata.responseTo, interruptedAssistantId: latest.id };
  }
  return undefined;
}

/** Retry only when the caller's proposal matches the authoritative latest target. */
export function isAuthoritativeRetryTarget(
  messages: readonly DeliveryMessage[],
  messageId: string,
  interruptedAssistantId?: string,
): boolean {
  const target = interruptedRetryTarget(messages);
  return target?.messageId === messageId && target.interruptedAssistantId === interruptedAssistantId;
}

/** Browser-authored system roles have no authority and follow user sanitization. */
export function isUntrustedChatRole(role: string): boolean {
  return role === "user" || role === "system";
}

function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(json).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Keep a chronological suffix within both count and serialized UTF-8 budgets. */
export function boundedChatHistory<T>(
  messages: readonly T[],
  maxMessages: number,
  maxBytes: number,
): T[] {
  const out: T[] = [];
  let bytes = 2;
  for (let index = messages.length - 1; index >= 0 && out.length < maxMessages; index -= 1) {
    const item = messages[index];
    const itemBytes = jsonBytes(item) + (out.length ? 1 : 0);
    if (!Number.isFinite(itemBytes) || bytes + itemBytes > maxBytes) break;
    out.push(item);
    bytes += itemBytes;
  }
  out.reverse();
  const retainedIds = new Set(
    out.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    }),
  );
  return out.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const message = item as { role?: unknown; metadata?: unknown };
    if (message.role !== "assistant") return true;
    const metadata = message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? message.metadata as { responseTo?: unknown }
      : undefined;
    return typeof metadata?.responseTo === "string" && retainedIds.has(metadata.responseTo);
  });
}

function exactJsonMatch(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Accept one new plain-text user turn only when the submitted prefix exactly
 * matches server history. This blocks forged assistant/system rows and stale
 * clients from deleting or resurrecting authoritative messages.
 */
export function clientChatSubmissionError(
  authoritative: readonly unknown[],
  submitted: unknown,
  wasPreviouslyAccepted?: (messageId: string) => boolean,
): string | undefined {
  if (!Array.isArray(submitted) || submitted.length !== authoritative.length + 1) {
    return "Chat history is stale or malformed.";
  }
  for (let index = 0; index < authoritative.length; index += 1) {
    if (!exactJsonMatch(submitted[index], authoritative[index])) return "Chat history is stale or malformed.";
  }
  const candidate = submitted[submitted.length - 1];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return "New chat message is malformed.";
  const message = candidate as Record<string, unknown>;
  if (
    Object.keys(message).some((key) => !["id", "role", "parts", "metadata"].includes(key)) ||
    typeof message.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(message.id) ||
    authoritative.some(
      (item) => item && typeof item === "object" && !Array.isArray(item) && (item as { id?: unknown }).id === message.id,
    ) ||
    message.role !== "user" ||
    !Array.isArray(message.parts) ||
    message.parts.length !== 1
  ) {
    return "New chat message is malformed.";
  }
  if (wasPreviouslyAccepted?.(message.id)) return "New chat message has already been accepted.";
  const part = message.parts[0];
  if (!part || typeof part !== "object" || Array.isArray(part)) return "New chat message is malformed.";
  const textPart = part as Record<string, unknown>;
  if (
    Object.keys(textPart).some((key) => key !== "type" && key !== "text") ||
    textPart.type !== "text" ||
    typeof textPart.text !== "string" ||
    !textPart.text.trim() ||
    textPart.text.length > MAX_CHAT_TEXT_CHARS
  ) {
    return "New chat message must contain one bounded text part.";
  }
  if (containsCloudflareApiToken(textPart.text)) {
    return "Cloudflare API tokens must be added through the encrypted Connection form, not chat.";
  }
  if (message.metadata !== undefined) {
    if (!message.metadata || typeof message.metadata !== "object" || Array.isArray(message.metadata)) {
      return "New chat metadata is malformed.";
    }
    const metadata = message.metadata as Record<string, unknown>;
    if (
      Object.keys(metadata).some((key) => key !== "name") ||
      (metadata.name !== undefined &&
        (typeof metadata.name !== "string" ||
          metadata.name.length > 80 ||
          /[\u0000-\u001f\u007f]/.test(metadata.name) ||
          containsCloudflareApiToken(metadata.name)))
    ) {
      return "New chat metadata is malformed.";
    }
  }
  return undefined;
}
