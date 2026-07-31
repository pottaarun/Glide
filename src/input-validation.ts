import type { BusinessProfile, OnboardingPath, SetupType } from "./shared.ts";

export const MAX_ACTOR_CHARS = 80;
export const MAX_ONBOARDING_DOMAIN_CHARS = 500;
export const MAX_PROFILE_NOTES_CHARS = 1_000;
/** Leave headroom below Durable Object SQLite's 2 MB per-state-row ceiling. */
export const MAX_SYNCED_STATE_BYTES = 1_700_000;

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface ValidatedOnboardingPatch {
  path?: OnboardingPath;
  domain?: string;
  setupType?: SetupType;
  migratingFrom?: string;
  migratingFromLabel?: string;
  goals?: string[];
  configProvided?: boolean;
  dnsReviewed?: boolean;
  completed?: boolean;
  checkOff?: string[];
}

const ONBOARDING_KEYS = new Set([
  "path",
  "domain",
  "setupType",
  "migratingFrom",
  "migratingFromLabel",
  "goals",
  "configProvided",
  "dnsReviewed",
  "completed",
  "checkOff",
]);
const CHECKLIST_IDS = new Set([
  "domain",
  "setup",
  "preview",
  "scan",
  "migrate",
  "ssl",
  "ttl",
  "nameservers",
  "verify",
  "dnssec",
  "dns",
  "proxy",
  "security",
]);
const PROFILE_KEYS = new Set([
  "industry",
  "appTypes",
  "audience",
  "trafficProfile",
  "hasLogin",
  "hasApi",
  "cacheableContent",
  "sensitiveData",
  "compliance",
  "concerns",
  "notes",
  "completed",
]);
const APP_TYPES = new Set(["website", "web_app", "api", "mobile_backend", "static_site", "ugc"]);
const AUDIENCES = new Set(["global", "regional", "internal"]);
const TRAFFIC_PROFILES = new Set(["low", "steady", "spiky", "high_volume"]);
const SENSITIVE_DATA = new Set(["pii", "payments", "health", "credentials", "financial"]);
const COMPLIANCE = new Set(["pci_dss", "hipaa", "gdpr", "soc2", "iso27001", "fedramp"]);
const CONCERNS = new Set([
  "bots",
  "ddos",
  "scraping",
  "credential_stuffing",
  "card_testing",
  "fraud",
  "latency",
  "downtime",
  "cost",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function syncedStateSizeError(
  value: unknown,
  maxBytes = MAX_SYNCED_STATE_BYTES,
): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return "Room state is not JSON-serializable.";
    const bytes = new TextEncoder().encode(json).byteLength;
    return bytes > maxBytes
      ? `Room state would exceed its safe storage budget (${bytes} bytes; max ${maxBytes}). Remove or regenerate a large artifact first.`
      : undefined;
  } catch {
    return "Room state is not JSON-serializable.";
  }
}

/** Return the exact serialized size used by the state budget, or infinity for invalid JSON. */
export function syncedStateBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(json).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Legacy oversized rooms may make progress only when a server mutation strictly shrinks state. */
export function isSafeSyncedStateTransition(current: unknown, next: unknown): boolean {
  const nextBytes = syncedStateBytes(next);
  if (nextBytes <= MAX_SYNCED_STATE_BYTES) return true;
  const currentBytes = syncedStateBytes(current);
  return currentBytes > MAX_SYNCED_STATE_BYTES && nextBytes < currentBytes;
}

function cleanText(value: unknown, label: string, max: number): ValidationResult<string> {
  if (typeof value !== "string") return { ok: false, message: `${label} must be text.` };
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (text.length > max) return { ok: false, message: `${label} must be at most ${max} characters.` };
  return { ok: true, value: text };
}

function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): ValidationResult<boolean | undefined> {
  const value = input[key];
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false, message: `${key} must be true or false.` };
}

function stringList(
  value: unknown,
  label: string,
  options: { maxItems: number; maxChars: number; allowed?: Set<string> },
): ValidationResult<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, message: `${label} must be a list.` };
  if (value.length > options.maxItems) {
    return { ok: false, message: `${label} can contain at most ${options.maxItems} values.` };
  }
  const out: string[] = [];
  for (const item of value) {
    const parsed = cleanText(item, `${label} value`, options.maxChars);
    if (!parsed.ok) return parsed;
    if (!parsed.value) continue;
    if (options.allowed && !options.allowed.has(parsed.value)) {
      return { ok: false, message: `${label} contains an unsupported value: ${parsed.value}.` };
    }
    if (!out.includes(parsed.value)) out.push(parsed.value);
  }
  return { ok: true, value: out };
}

/** Bound display-only actor names before they enter durable state or model-facing text. */
export function normalizeActor(value: unknown, fallback = "someone"): string {
  if (typeof value !== "string") return fallback;
  const actor = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ACTOR_CHARS);
  return actor || fallback;
}

export function validateOnboardingPatch(value: unknown): ValidationResult<ValidatedOnboardingPatch> {
  if (!isRecord(value)) return { ok: false, message: "Onboarding update must be an object." };
  const unknownKey = Object.keys(value).find((key) => !ONBOARDING_KEYS.has(key));
  if (unknownKey) return { ok: false, message: `Unsupported onboarding field: ${unknownKey}.` };

  const out: ValidatedOnboardingPatch = {};
  if (value.path !== undefined) {
    if (value.path !== "migrate" && value.path !== "fresh") {
      return { ok: false, message: "path must be migrate or fresh." };
    }
    out.path = value.path;
  }
  if (value.setupType !== undefined) {
    if (!(["full", "partial", "unsure"] as unknown[]).includes(value.setupType)) {
      return { ok: false, message: "setupType must be full, partial, or unsure." };
    }
    out.setupType = value.setupType as SetupType;
  }
  for (const [key, max] of [
    ["domain", MAX_ONBOARDING_DOMAIN_CHARS],
    ["migratingFrom", 80],
    ["migratingFromLabel", 120],
  ] as const) {
    if (value[key] === undefined) continue;
    const parsed = cleanText(value[key], key, max);
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }

  const goals = stringList(value.goals, "goals", { maxItems: 20, maxChars: 64 });
  if (!goals.ok) return goals;
  if (goals.value !== undefined) out.goals = goals.value;
  const checkOff = stringList(value.checkOff, "checkOff", {
    maxItems: CHECKLIST_IDS.size,
    maxChars: 32,
    allowed: CHECKLIST_IDS,
  });
  if (!checkOff.ok) return checkOff;
  if (checkOff.value !== undefined) out.checkOff = checkOff.value;

  for (const key of ["configProvided", "dnsReviewed", "completed"] as const) {
    const parsed = optionalBoolean(value, key);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[key] = parsed.value;
  }
  return { ok: true, value: out };
}

export function validateBusinessProfilePatch(value: unknown): ValidationResult<Partial<BusinessProfile>> {
  if (!isRecord(value)) return { ok: false, message: "Business profile update must be an object." };
  const unknownKey = Object.keys(value).find((key) => !PROFILE_KEYS.has(key));
  if (unknownKey) return { ok: false, message: `Unsupported business profile field: ${unknownKey}.` };

  const out: Partial<BusinessProfile> = {};
  if (value.industry !== undefined) {
    const parsed = cleanText(value.industry, "industry", 80);
    if (!parsed.ok) return parsed;
    out.industry = parsed.value;
  }
  if (value.audience !== undefined) {
    if (typeof value.audience !== "string" || !AUDIENCES.has(value.audience)) {
      return { ok: false, message: "audience must be global, regional, or internal." };
    }
    out.audience = value.audience as BusinessProfile["audience"];
  }
  if (value.trafficProfile !== undefined) {
    if (typeof value.trafficProfile !== "string" || !TRAFFIC_PROFILES.has(value.trafficProfile)) {
      return { ok: false, message: "trafficProfile is unsupported." };
    }
    out.trafficProfile = value.trafficProfile as BusinessProfile["trafficProfile"];
  }

  for (const [key, allowed] of [
    ["appTypes", APP_TYPES],
    ["sensitiveData", SENSITIVE_DATA],
    ["compliance", COMPLIANCE],
    ["concerns", CONCERNS],
  ] as const) {
    const parsed = stringList(value[key], key, { maxItems: allowed.size, maxChars: 64, allowed });
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[key] = parsed.value;
  }

  for (const key of ["hasLogin", "hasApi", "cacheableContent", "completed"] as const) {
    const parsed = optionalBoolean(value, key);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) out[key] = parsed.value;
  }
  if (value.notes !== undefined) {
    const parsed = cleanText(value.notes, "notes", MAX_PROFILE_NOTES_CHARS);
    if (!parsed.ok) return parsed;
    out.notes = parsed.value;
  }
  return { ok: true, value: out };
}

export function validateIdentifier(value: unknown, label: string, max = 200): ValidationResult<string> {
  const parsed = cleanText(value, label, max);
  if (!parsed.ok) return parsed;
  return parsed.value
    ? parsed
    : { ok: false, message: `${label} is required.` };
}

/**
 * Validate a client-supplied future timestamp (ms epoch) for scheduling, e.g. a
 * maintenance-window apply. Rejects non-finite values, times too soon (< now +
 * `minLeadMs`) and times too far out (> now + `maxAheadMs`). Returns the rounded
 * timestamp so callers can derive an integer delay.
 */
export function validateFutureTimestamp(
  value: unknown,
  now: number,
  minLeadMs: number,
  maxAheadMs: number,
  label = "scheduled time",
): ValidationResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, message: `${label} must be a timestamp.` };
  }
  const whenTs = Math.round(value);
  if (whenTs < now + minLeadMs) {
    const mins = Math.max(1, Math.round(minLeadMs / 60_000));
    return { ok: false, message: `${label} must be at least ${mins} minute(s) in the future.` };
  }
  if (whenTs > now + maxAheadMs) {
    const days = Math.max(1, Math.round(maxAheadMs / 86_400_000));
    return { ok: false, message: `${label} must be within ${days} day(s).` };
  }
  return { ok: true, value: whenTs };
}
