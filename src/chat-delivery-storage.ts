import {
  MAX_CHAT_DELIVERY_STATUS_IDS,
  containsCloudflareApiToken,
  isChatTextWithinLimit,
} from "./chat-delivery.ts";

export interface DeliveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingDelivery {
  id: string;
  text: string;
  acceptedDraftRevision?: string;
}

function isPendingDelivery(value: unknown): value is PendingDelivery {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as PendingDelivery).id === "string" &&
    /^[A-Za-z0-9_-]{1,200}$/.test((value as PendingDelivery).id) &&
    typeof (value as PendingDelivery).text === "string" &&
    isChatTextWithinLimit((value as PendingDelivery).text) &&
    ((value as PendingDelivery).acceptedDraftRevision === undefined ||
      (typeof (value as PendingDelivery).acceptedDraftRevision === "string" &&
        /^[A-Za-z0-9_-]{1,200}$/.test((value as PendingDelivery).acceptedDraftRevision!)))
  );
}

export function readPendingDelivery(
  storage: DeliveryStorage,
  key: string,
): PendingDelivery | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!isPendingDelivery(value)) return undefined;
    if (!containsCloudflareApiToken(value.text)) return value;
    try {
      storage.removeItem(key);
    } catch {
      // Exclude the secret from memory even when browser storage is unavailable.
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function readRecoverableDrafts(
  storage: DeliveryStorage,
  key: string,
): PendingDelivery[] {
  let value: unknown;
  try {
    value = JSON.parse(storage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_CHAT_DELIVERY_STATUS_IDS ||
    !value.every(isPendingDelivery)
  ) {
    return [];
  }

  const safe = value.filter((delivery) => !containsCloudflareApiToken(delivery.text));
  if (safe.length === value.length) return safe;
  try {
    if (safe.length) storage.setItem(key, JSON.stringify(safe));
    else storage.removeItem(key);
  } catch {
    // Unsafe records remain excluded from memory even if cleanup fails.
  }
  return safe;
}
