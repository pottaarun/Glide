/**
 * Glide — React chat client.
 *
 * A room is one `GlideAgent` instance (named by the URL hash). Everyone who
 * opens the same room shares the same live chat + the same pending-action
 * queue, synced over the Agents SDK WebSocket.
 *
 * - `useAgent` gives us the live {@link GlideState} (memory, pending actions,
 *   results) and the RPC `call()` used to Apply/Reject.
 * - `useAgentChat` gives us the streaming transcript and `sendMessage`.
 */

import {
  Component,
  Fragment,
  StrictMode,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";

// Build-time snapshot of the project's Markdown docs (README + fix-progress log
// + docs/*.md), injected by the `glide-docs-manifest` Vite plugin. Powers the
// Admin page's "Dev docs updates" tracker.
import type { GlideDocsManifest } from "virtual:glide-docs";
import type { AccessSession } from "../access-auth";

import "./index.css";

import {
  isSupportedRoomId,
  isCloudflareDocsUrl,
  LEGACY_CHAT_RECOVERY_CONFIRMATION,
  MAX_LEGACY_ROOM_ID_CHARS,
  MAX_ROOM_NAME_CHARS,
  normalizeRoomName,
  ROOM_DELETE_CONFIRMATION,
  roomStorageName,
  type ActionResult,
  type BusinessProfile,
  type DocLink,
  type GlideMessageMetadata,
  type GlideState,
  type GuidanceDoc,
  type LegacyChatMigrationStatus,
  type LiveZoneFacts,
  type MigrationPlan,
  type OnboardingPath,
  type OnboardingState,
  type PendingAction,
  type PendingRollback,
  type PostureDriftView,
  type RoomAccessStatus,
  type RoomAuditEntry,
  type RoomMember,
  type RoomSummary,
  type SecurityPostureCheckView,
  type SecurityPostureReport,
  type SetupType,
  type TerraformArtifact,
} from "../shared";
import {
  hasCanonicalActionResultParts,
  isActionApplying,
  isActionOutcomeUncertain,
  isSnapshotRestoreAction,
  pendingActionStatus,
} from "../action-lifecycle";
import { invertibleSetting } from "../rollback";
import { requiresSecondApproval } from "../change-risk";
import type { GovernanceEvent } from "../notify";
import {
  MAX_CHAT_DELIVERY_STATUS_IDS,
  MAX_CHAT_HISTORY_BYTES,
  MAX_CHAT_TEXT_CHARS,
  containsCloudflareApiToken,
  interruptedRetryTarget,
  isChatTextWithinLimit,
  persistedDeliveryStatus,
  type DeliveryStatus,
} from "../chat-delivery";
import {
  readPendingDelivery,
  readRecoverableDrafts,
  type PendingDelivery,
} from "../chat-delivery-storage";
import { MAX_CONFIG_BYTES, MAX_CONFIG_FILENAME_BYTES, MAX_CONFIG_FILES } from "../migration";
import { MAX_ONBOARDING_DOMAIN_CHARS } from "../input-validation";
import {
  isRecommendationQueueable,
  recommendConfigurations,
  recommendationToPending,
  type Recommendation,
} from "../recommendations";
import type { BlastRadiusEstimate } from "../blast-radius";

const CHAT_CONNECTION_ERROR = "Glide's live connection closed before the message was sent.";
const AGENT_MESSAGES_TIMEOUT_MS = 10_000;
const MAX_MIGRATION_STATUS_BYTES = 16_000;
const MAX_ACCESS_RESPONSE_BYTES = 128_000;
const ACCESS_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RECOVERABLE_DRAFTS = MAX_CHAT_DELIVERY_STATUS_IDS;

type ReconciledDeliveryStatus = DeliveryStatus | "accepted_pruned";

function reconciledDeliveryStatus(
  messages: readonly UIMessage[],
  messageId: string,
  acceptedAbsentIds: ReadonlySet<string>,
): ReconciledDeliveryStatus {
  const status = persistedDeliveryStatus(messages, messageId);
  return status === "not_delivered" && acceptedAbsentIds.has(messageId) ? "accepted_pruned" : status;
}

interface StoredDraft {
  text: string;
  revision: string;
  recoveryId?: string;
}

function parsedLegacyChatMigrationStatus(value: unknown): LegacyChatMigrationStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as {
    status?: unknown;
    message?: unknown;
    recoveryConfirmation?: unknown;
  };
  if (
    !["ready", "migrating", "recovery_required", "discarding"].includes(String(candidate.status)) ||
    typeof candidate.message !== "string" ||
    !candidate.message ||
    candidate.message.length > 500
  ) return undefined;
  if (
    candidate.status === "recovery_required" &&
    candidate.recoveryConfirmation !== LEGACY_CHAT_RECOVERY_CONFIRMATION
  ) return undefined;
  if (
    candidate.recoveryConfirmation !== undefined &&
    candidate.recoveryConfirmation !== LEGACY_CHAT_RECOVERY_CONFIRMATION
  ) return undefined;
  return candidate as LegacyChatMigrationStatus;
}

function roomSessionKey(kind: "draft" | "pending" | "recoverable", room: string): string {
  return `glide:${kind}:${encodeURIComponent(room)}`;
}

function readSessionValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function readStoredDraft(key: string): StoredDraft | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readSessionValue(key) ?? "null");
  } catch {
    value = undefined;
  }
  const draft = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<StoredDraft>
    : undefined;
  if (draft && typeof draft.text === "string" && containsCloudflareApiToken(draft.text)) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // The secret is still excluded from React state even if storage is unavailable.
    }
    return undefined;
  }
  if (
    !draft ||
    typeof draft.text !== "string" ||
    !draft.text ||
    !isChatTextWithinLimit(draft.text) ||
    typeof draft.revision !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(draft.revision) ||
    (draft.recoveryId !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(draft.recoveryId))
  ) return undefined;
  return draft as StoredDraft;
}

function writeSessionValue(key: string, value: string | undefined): boolean {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function writeStoredDraft(key: string, draft: StoredDraft | undefined): boolean {
  return writeSessionValue(key, draft ? JSON.stringify(draft) : undefined);
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Response exceeds the ${maxBytes.toLocaleString()} byte safety limit.`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response exceeds the ${maxBytes.toLocaleString()} byte safety limit.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchAgentMessages(
  agentUrl: string,
  timeoutMs = AGENT_MESSAGES_TIMEOUT_MS,
  allowPendingMigration = false,
): Promise<UIMessage[]> {
  const url = new URL(agentUrl, location.origin);
  url.searchParams.delete("_pk");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/get-messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await readBoundedResponseText(response, MAX_MIGRATION_STATUS_BYTES);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = undefined;
      }
      const migration = payload && typeof payload === "object" && !Array.isArray(payload) &&
          (payload as { code?: unknown }).code === "legacy_chat_migration_incomplete"
        ? parsedLegacyChatMigrationStatus(payload)
        : undefined;
      if (response.status === 503 && migration) {
        if (allowPendingMigration) return [];
        throw new Error(migration.message);
      }
      const rateLimitMessage = payload && typeof payload === "object" && !Array.isArray(payload) &&
          ((payload as { code?: unknown }).code === "rate_limit_exceeded" ||
            (payload as { code?: unknown }).code === "rate_limit_unavailable") &&
          typeof (payload as { message?: unknown }).message === "string" &&
          (payload as { message: string }).message.length <= 300
        ? (payload as { message: string }).message
        : undefined;
      if ((response.status === 429 || response.status === 503) && rateLimitMessage) {
        throw new Error(rateLimitMessage);
      }
      throw new Error(`Loading room history returned HTTP ${response.status}.`);
    }
    const value: unknown = JSON.parse(await readBoundedResponseText(response, MAX_CHAT_HISTORY_BYTES));
    if (
      !Array.isArray(value) ||
      value.some(
        (message) =>
          !message ||
          typeof message !== "object" ||
          typeof (message as { id?: unknown }).id !== "string" ||
          !Array.isArray((message as { parts?: unknown }).parts),
      )
    ) {
      throw new Error("Glide returned malformed room history.");
    }
    return value as UIMessage[];
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Loading room history timed out. Reload to try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadInitialAgentMessages({ url }: { url?: string }): Promise<UIMessage[]> {
  if (!url) throw new Error("Glide could not determine the room history URL.");
  return fetchAgentMessages(url, AGENT_MESSAGES_TIMEOUT_MS, true);
}

// ---------------------------------------------------------------------------
// Room + identity helpers
// ---------------------------------------------------------------------------

function readRoomFromHash(): string {
  try {
    const raw = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
    const room = raw.replace(/^room=/, "").trim();
    return isSupportedRoomId(room) ? room : "";
  } catch {
    return "";
  }
}

function newRoomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function requiredRoomStorageName(room: string): string {
  const storageName = roomStorageName(room);
  if (!storageName) throw new Error("Glide could not map this room id to durable storage.");
  return storageName;
}

function parsedAccessSession(value: unknown): AccessSession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const session = value as { email?: unknown; isEmployee?: unknown };
  return typeof session.email === "string" &&
    session.email.length > 0 &&
    session.email.length <= 254 &&
    typeof session.isEmployee === "boolean"
    ? { email: session.email, isEmployee: session.isEmployee }
    : undefined;
}

/** Parse the `GET /api/rooms` payload into a bounded, sanitized room list. */
function parsedRoomSummaries(value: unknown): RoomSummary[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rooms = (value as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return [];
  const out: RoomSummary[] = [];
  for (const raw of rooms.slice(0, 1000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const room = raw as Record<string, unknown>;
    if (typeof room.id !== "string" || !room.id) continue;
    out.push({
      id: room.id,
      ...(typeof room.name === "string" && room.name ? { name: room.name } : {}),
      ...(typeof room.owner === "string" && room.owner ? { owner: room.owner } : {}),
      memberCount: typeof room.memberCount === "number" && Number.isFinite(room.memberCount) ? room.memberCount : 0,
      createdAt: typeof room.createdAt === "number" && Number.isFinite(room.createdAt) ? room.createdAt : 0,
      lastActiveAt: typeof room.lastActiveAt === "number" && Number.isFinite(room.lastActiveAt) ? room.lastActiveAt : 0,
    });
  }
  return out;
}

function parsedRoomAccessStatus(value: unknown): (RoomAccessStatus & { message?: string }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const access = value as Record<string, unknown>;
  if (
    typeof access.email !== "string" ||
    typeof access.isEmployee !== "boolean" ||
    !["owner", "member", "viewer", "inspector"].includes(String(access.role)) ||
    !["member", "created", "claimed", "inspect"].includes(String(access.entry)) ||
    !Array.isArray(access.members) ||
    access.members.length > 100
  ) return undefined;
  const members: RoomMember[] = [];
  for (const raw of access.members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const member = raw as Record<string, unknown>;
    if (
      typeof member.email !== "string" ||
      member.email.length === 0 ||
      member.email.length > 254 ||
      !["owner", "member", "viewer"].includes(String(member.role)) ||
      (member.invitedBy !== undefined && typeof member.invitedBy !== "string") ||
      typeof member.joinedAt !== "number" ||
      !Number.isFinite(member.joinedAt)
    ) return undefined;
    members.push({
      email: member.email,
      role: member.role as RoomMember["role"],
      ...(typeof member.invitedBy === "string" ? { invitedBy: member.invitedBy } : {}),
      joinedAt: member.joinedAt,
    });
  }
  return {
    email: access.email,
    isEmployee: access.isEmployee,
    role: access.role as RoomMember["role"],
    members,
    entry: access.entry as RoomAccessStatus["entry"],
    ...(typeof access.message === "string" && access.message.length <= 500 ? { message: access.message } : {}),
  };
}

async function fetchAccessJson(
  url: string,
  signal?: AbortSignal,
  method: "GET" | "POST" = "GET",
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ACCESS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      method,
      signal: controller.signal,
    });
    const text = await readBoundedResponseText(response, MAX_ACCESS_RESPONSE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const payload = value && typeof value === "object" && !Array.isArray(value)
        ? value as { code?: unknown; message?: unknown }
        : undefined;
      const message = typeof payload?.message === "string"
        ? payload.message
        : `Glide access check returned HTTP ${response.status}.`;
      const retryAfter = Number(response.headers.get("Retry-After"));
      throw new AccessRequestError(
        message,
        response.status,
        typeof payload?.code === "string" ? payload.code : undefined,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return value;
  } catch (reason) {
    if (timedOut && !signal?.aborted) {
      throw new AccessRequestError("Glide's access check timed out. Try again.", 0, "access_timeout");
    }
    throw reason;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

class AccessRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AccessRequestError";
  }
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

const METHOD_COLORS: Record<string, string> = {
  POST: "#16a34a",
  PUT: "#0891b2",
  PATCH: "#ca8a04",
  DELETE: "#dc2626",
  GET: "#6b7280",
};

const STATUS_COLORS: Record<ActionResult["status"], string> = {
  applied: "#16a34a",
  failed: "#dc2626",
  rejected: "#9ca3af",
};

const NOTIFY_META: Record<GovernanceEvent["kind"], { icon: string; color: string }> = {
  change_applied: { icon: "✅", color: "#16a34a" },
  change_failed: { icon: "⚠️", color: "#dc2626" },
  approval_recorded: { icon: "🖊️", color: "#a78bfa" },
  auto_revert: { icon: "↩️", color: "#f59e0b" },
  drift_detected: { icon: "📉", color: "#fb7185" },
  test: { icon: "🔔", color: "#38bdf8" },
};

/** Includes snapshot reads, one retried write, and transport overhead. */
const APPLY_RPC_TIMEOUT_MS = 6 * 60 * 1_000;

type RenderedToolStatus = "unknown" | "running" | "waiting" | "complete" | "failed";

interface RenderedTool {
  id: string;
  name: string;
  status: RenderedToolStatus;
}

/** Trigger a client-side download of a text file (used for Terraform export). */
function downloadText(filename: string, content: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Compact relative time, e.g. "just now", "3m ago", "2h ago", "5d ago". */
function relTime(ms?: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Absolute local timestamp for tooltips / precise reads. */
function fmtWhen(ms?: number): string {
  return ms ? new Date(ms).toLocaleString() : "";
}

/** Format a ms epoch as a `datetime-local` input value (local `YYYY-MM-DDTHH:mm`). */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human-readable byte size. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Onboarding wizard options (provider keys mirror the migration tool)
// ---------------------------------------------------------------------------

const PROVIDER_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "akamai", label: "Akamai" },
  { key: "fastly", label: "Fastly" },
  { key: "imperva", label: "Imperva (Incapsula)" },
  { key: "zscaler_zia", label: "Zscaler ZIA" },
  { key: "zscaler_zpa", label: "Zscaler ZPA" },
  { key: "prisma_access", label: "Prisma Access" },
  { key: "cisco_umbrella", label: "Cisco Umbrella" },
  { key: "akamai_eaa", label: "Akamai EAA" },
  { key: "proofpoint", label: "Proofpoint" },
];

const MIGRATE_GOALS: Array<{ id: string; label: string }> = [
  { id: "dns", label: "DNS records" },
  { id: "waf", label: "WAF / security rules" },
  { id: "cache", label: "Cache / performance" },
  { id: "rate_limiting", label: "Rate limiting" },
  { id: "load_balancing", label: "Load balancing" },
  { id: "zero_trust", label: "Zero Trust (Gateway / Access)" },
];

const FRESH_GOALS: Array<{ id: string; label: string }> = [
  { id: "dns", label: "DNS records" },
  { id: "waf", label: "WAF / security" },
  { id: "cache", label: "Cache / performance" },
  { id: "rate_limiting", label: "Rate limiting" },
  { id: "redirects", label: "Redirects" },
  { id: "zero_trust", label: "Zero Trust (Gateway / Access)" },
];

const SETUP_OPTIONS: Array<{ id: SetupType; label: string; desc: string }> = [
  {
    id: "full",
    label: "Full (primary)",
    desc: "Cloudflare is your authoritative DNS. Most common; the only option on Free/Pro. Recommended.",
  },
  {
    id: "partial",
    label: "Partial (CNAME)",
    desc: "Keep your current DNS provider and proxy only specific subdomains. Business/Enterprise only.",
  },
  { id: "unsure", label: "Not sure yet", desc: "We'll recommend Full setup unless you have a reason not to." },
];

function goalLabel(id: string): string {
  return (
    [...MIGRATE_GOALS, ...FRESH_GOALS].find((g) => g.id === id)?.label ?? id.replace(/_/g, " ")
  );
}

function setupLabel(s?: SetupType): string {
  return s === "full" ? "Full (primary)" : s === "partial" ? "Partial (CNAME)" : "to be decided";
}

/** Compact one-line summary of the live zone facts read from Cloudflare. */
function liveZoneSummary(live: LiveZoneFacts): string {
  const parts: string[] = [];
  if (live.status) parts.push(live.status);
  if (live.sslMode) parts.push(`SSL ${live.sslMode}`);
  if (typeof live.wafManaged === "boolean") parts.push(`WAF ${live.wafManaged ? "on" : "off"}`);
  if (typeof live.proxiableRecords === "number")
    parts.push(`proxied ${live.proxiedRecords ?? 0}/${live.proxiableRecords}`);
  return parts.join(" · ") || "—";
}

// ---------------------------------------------------------------------------
// Business profile — the "nature of the business" discovery answers that drive
// Glide's tailored recommendations. Option keys mirror recommendations.ts and
// the update_business_profile tool schema on the server.
// ---------------------------------------------------------------------------

interface Opt {
  id: string;
  label: string;
}

const INDUSTRY_OPTIONS: Opt[] = [
  { id: "ecommerce", label: "E-commerce" },
  { id: "saas", label: "SaaS" },
  { id: "fintech", label: "Fintech / finance" },
  { id: "healthcare", label: "Healthcare" },
  { id: "media", label: "Media / publishing" },
  { id: "gaming", label: "Gaming" },
  { id: "government", label: "Government" },
  { id: "education", label: "Education" },
  { id: "nonprofit", label: "Nonprofit" },
  { id: "marketing", label: "Marketing site" },
  { id: "api_platform", label: "API platform" },
  { id: "other", label: "Other" },
];

const APP_TYPE_OPTIONS: Opt[] = [
  { id: "website", label: "Website" },
  { id: "web_app", label: "Web app" },
  { id: "api", label: "API" },
  { id: "mobile_backend", label: "Mobile backend" },
  { id: "static_site", label: "Static site" },
  { id: "ugc", label: "User content / community" },
];

const AUDIENCE_OPTIONS: Opt[] = [
  { id: "global", label: "Global" },
  { id: "regional", label: "Regional" },
  { id: "internal", label: "Internal / employees" },
];

const TRAFFIC_OPTIONS: Opt[] = [
  { id: "low", label: "Low" },
  { id: "steady", label: "Steady" },
  { id: "spiky", label: "Spiky (launches/sales)" },
  { id: "high_volume", label: "High volume" },
];

const SENSITIVE_OPTIONS: Opt[] = [
  { id: "pii", label: "Personal data (PII)" },
  { id: "payments", label: "Payments / cards" },
  { id: "health", label: "Health data (PHI)" },
  { id: "credentials", label: "Credentials" },
  { id: "financial", label: "Financial data" },
];

const COMPLIANCE_OPTIONS: Opt[] = [
  { id: "pci_dss", label: "PCI DSS" },
  { id: "hipaa", label: "HIPAA" },
  { id: "gdpr", label: "GDPR" },
  { id: "soc2", label: "SOC 2" },
  { id: "iso27001", label: "ISO 27001" },
  { id: "fedramp", label: "FedRAMP" },
];

const CONCERN_OPTIONS: Opt[] = [
  { id: "bots", label: "Bots" },
  { id: "ddos", label: "DDoS" },
  { id: "scraping", label: "Scraping" },
  { id: "credential_stuffing", label: "Account takeover" },
  { id: "card_testing", label: "Card testing" },
  { id: "fraud", label: "Fraud / abuse" },
  { id: "latency", label: "Latency" },
  { id: "downtime", label: "Downtime" },
  { id: "cost", label: "Origin cost" },
];

function optLabel(options: Opt[], id: string): string {
  return options.find((o) => o.id === id)?.label ?? id.replace(/_/g, " ");
}

/** Whether a profile has any captured signal worth showing. */
function hasProfileSignal(p?: BusinessProfile): boolean {
  if (!p) return false;
  return Boolean(
    p.industry ||
      p.appTypes.length ||
      p.audience ||
      p.trafficProfile ||
      p.hasLogin !== undefined ||
      p.hasApi !== undefined ||
      p.sensitiveData.length ||
      p.compliance.length ||
      p.concerns.length ||
      p.notes,
  );
}

/** Infer the migration tool's config format from an uploaded file's name. */
function formatFromName(filename: string): "json" | "xml" | "terraform" | "panos" | "auto" {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "json") return "json";
  if (ext === "xml") return "xml";
  if (ext === "tf" || ext === "tfvars" || ext === "hcl") return "terraform";
  if (ext === "conf" || ext === "set" || ext === "cfg") return "panos";
  return "auto";
}

// Llama-family models sometimes emit a tool call as *literal assistant text*
// (e.g. `<|python_tag|>{"type":"function","name":"find_zone",...}`) instead of
// a structured tool part. Left alone it renders as raw JSON in the bubble — and
// when a real tool part also exists it shows a duplicate chip. We strip the
// serialized call out of the text and surface just the tool name.

const LLAMA_TOKENS =
  /<\|(?:python_tag|eom_id|eot_id|start_header_id|end_header_id|begin_of_text)\|>/g;

/** Index just past the balanced `{…}` starting at `start`, or -1 if unbalanced. */
function scanJsonObject(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Tool name if `obj` looks like a serialized tool call, else null. */
function toolCallName(obj: string): string | null {
  if (!/"(?:type|name|function|parameters|arguments)"\s*:/.test(obj)) return null;
  const isToolShape =
    /"type"\s*:\s*"function"/.test(obj) ||
    (/"name"\s*:/.test(obj) && /"(?:parameters|arguments)"\s*:/.test(obj));
  if (!isToolShape) return null;
  try {
    const parsed = JSON.parse(obj) as Record<string, unknown>;
    const fn = (parsed.function ?? parsed) as Record<string, unknown>;
    const name = fn?.name ?? parsed.name;
    return typeof name === "string" ? name : "tool";
  } catch {
    const m = obj.match(/"name"\s*:\s*"([^"]+)"/);
    return m ? m[1] : "tool";
  }
}

/** Remove serialized tool calls from assistant text, capturing their names. */
function stripToolCalls(raw: string): { text: string; tools: string[] } {
  const tools: string[] = [];
  const s = raw
    .replace(LLAMA_TOKENS, "")
    .replace(/<\/?(?:tool_call|function_call)>/g, "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const brace = s.indexOf("{", i);
    if (brace === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, brace);
    const end = scanJsonObject(s, brace);
    if (end === -1) {
      out += s.slice(brace);
      break;
    }
    const candidate = s.slice(brace, end);
    const name = toolCallName(candidate);
    if (name) tools.push(name);
    else out += candidate;
    i = end;
  }
  // Llama sometimes wraps the leaked call in a ```json fence; once the JSON
  // object above is removed the fence is empty, so drop those scars too.
  const text = out
    .replace(/```[a-zA-Z0-9]*\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, tools };
}

function renderedToolStatus(state: unknown): RenderedToolStatus {
  const value = typeof state === "string" ? state : "";
  if (value === "output-error" || value === "output-denied") return "failed";
  if (value === "output-available") return "complete";
  if (value === "approval-requested") return "waiting";
  if (value === "input-streaming" || value === "input-available") return "running";
  return "unknown";
}

function safeMessageMetadata(message: UIMessage): GlideMessageMetadata | undefined {
  return message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
    ? message.metadata as GlideMessageMetadata
    : undefined;
}

function isTrustedAssistantMessage(message: UIMessage): boolean {
  return message.role === "assistant" && typeof safeMessageMetadata(message)?.responseTo === "string";
}

function messageAuthor(message: UIMessage): { who: string; userStyle: boolean; role: string } {
  if (message.role === "user") {
    const rawName = safeMessageMetadata(message)?.name;
    const who = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 80) : "teammate";
    return { who, userStyle: true, role: "user" };
  }
  return isTrustedAssistantMessage(message)
    ? { who: "Glide", userStyle: false, role: "assistant" }
    : { who: "Unverified history", userStyle: true, role: "unverified" };
}

function messageText(m: UIMessage): { text: string; tools: RenderedTool[] } {
  let text = "";
  const tools = new Map<string, RenderedTool>();
  const trustedToolParts = isTrustedAssistantMessage(m);
  const priority: Record<RenderedToolStatus, number> = {
    unknown: 0,
    complete: 1,
    waiting: 2,
    running: 3,
    failed: 4,
  };
  const addTool = (id: string, name: string, status: RenderedToolStatus) => {
    const current = tools.get(id);
    if (!current || priority[status] > priority[current.status]) tools.set(id, { id, name, status });
  };
  const parts: unknown[] = Array.isArray(m.parts) ? m.parts : [];
  for (const candidate of parts) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const part = candidate as Record<string, unknown>;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text") {
      if (typeof part.text === "string") text += part.text;
    } else if (trustedToolParts && type === "dynamic-tool") {
      const name = String(part.toolName ?? "tool");
      addTool(String(part.toolCallId ?? name), name, renderedToolStatus(part.state));
    } else if (trustedToolParts && type.startsWith("tool-")) {
      const name = type.slice("tool-".length);
      addTool(String(part.toolCallId ?? name), name, renderedToolStatus(part.state));
    }
  }
  // Only sanitize assistant output; never rewrite what a teammate typed.
  const cleaned =
    m.role === "user" ? { text, tools: [] as string[] } : stripToolCalls(text);
  for (const name of cleaned.tools) {
    if (![...tools.values()].some((rendered) => rendered.name === name)) {
      addTool(`leaked-${name}`, name, "unknown");
    }
  }
  // Real tool parts win; leaked duplicates collapse away.
  return { text: cleaned.text, tools: [...tools.values()] };
}

interface ActionResultEventCandidate {
  id: string;
  text: string;
}

function actionResultEventCandidate(message: UIMessage): ActionResultEventCandidate | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  if (
    message.role !== "user" ||
    metadata?.systemEvent !== "action_result" ||
    metadata.name !== "Glide system" ||
    Object.keys(metadata).some((key) => key !== "name" && key !== "systemEvent")
  ) {
    return undefined;
  }
  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part) &&
        (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
  return hasCanonicalActionResultParts(parts, text) ? { id: message.id, text } : undefined;
}

function actionResultEventKey(candidate: ActionResultEventCandidate): string {
  return JSON.stringify([candidate.id, candidate.text]);
}

/** Hide only exact server-registered events; unverified metadata stays visible. */
function useVerifiedActionResultEvents(
  agent: { call: <T = unknown>(method: string, args?: unknown[]) => Promise<T>; readyState: number },
  messages: UIMessage[],
): Set<string> {
  const [verified, setVerified] = useState<Set<string>>(() => new Set());
  const candidates = [
    ...new Map(
      messages
        .map(actionResultEventCandidate)
        .filter((candidate): candidate is ActionResultEventCandidate => candidate !== undefined)
        .map((candidate) => [actionResultEventKey(candidate), candidate]),
    ).values(),
  ];
  const signature = candidates.map(actionResultEventKey).join("\n");

  useEffect(() => {
    if (!signature || agent.readyState !== WebSocket.OPEN) return;
    let active = true;
    const batches = Array.from(
      { length: Math.ceil(candidates.length / 100) },
      (_, index) => candidates.slice(index * 100, (index + 1) * 100),
    );
    void Promise.all(
      batches.map((batch) =>
        agent.call<Array<{ id: string; text: string }>>("verifyActionResultEvents", [batch]),
      ),
    )
      .then((responses) => {
        if (!active) return;
        const items = responses.flat().filter((item) => item && typeof item === "object");
        setVerified(new Set(items.map(actionResultEventKey)));
      })
      .catch(() => {
        // Safe default: a verification failure leaves reserved-looking text visible.
      });
    return () => {
      active = false;
    };
  }, [agent, agent.readyState, signature]);

  return verified;
}

/** A subtle, non-interactive light bloom that follows fine pointers only. */
function PointerGlow() {
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const glow = glowRef.current;
    if (
      !glow ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let frame: number | null = null;
    let currentX = 0;
    let currentY = 0;
    let targetX = 0;
    let targetY = 0;
    let started = false;

    const draw = () => {
      currentX += (targetX - currentX) * 0.24;
      currentY += (targetY - currentY) * 0.24;
      glow.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      if (Math.abs(targetX - currentX) > 0.1 || Math.abs(targetY - currentY) > 0.1) {
        frame = requestAnimationFrame(draw);
      } else {
        frame = null;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") {
        hide();
        return;
      }
      targetX = event.clientX;
      targetY = event.clientY;
      if (!started) {
        currentX = targetX;
        currentY = targetY;
        started = true;
      }
      if (glow.dataset.visible !== "true") glow.dataset.visible = "true";
      const interactive = String(
        event.target instanceof Element &&
          Boolean(event.target.closest("button, a, input, textarea, select, summary, [role='button']")),
      );
      if (glow.dataset.interactive !== interactive) glow.dataset.interactive = interactive;
      if (frame === null) frame = requestAnimationFrame(draw);
    };

    const hide = () => {
      glow.dataset.visible = "false";
      glow.dataset.interactive = "false";
    };

    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", hide);
      window.removeEventListener("blur", hide);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={glowRef} className="glide-pointer-glow" data-visible="false" aria-hidden="true">
      <span className="glide-pointer-glow__core" />
    </div>
  );
}

function ToolChip({ tool: rendered }: { tool: RenderedTool }) {
  const display: Record<RenderedToolStatus, { icon: string; label: string; color?: string }> = {
    unknown: { icon: "⚙", label: "Tool call" },
    running: { icon: "↻", label: "Running", color: "#fbbf24" },
    waiting: { icon: "○", label: "Waiting", color: "#fbbf24" },
    complete: { icon: "✓", label: "Completed", color: "#86efac" },
    failed: { icon: "×", label: "Failed", color: "#fda4af" },
  };
  const item = display[rendered.status];
  return (
    <span style={{ ...S.toolChip, ...(item.color ? { color: item.color } : null) }} title={item.label}>
      {item.icon} {rendered.name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main room
// ---------------------------------------------------------------------------

function AccessCard({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div style={S.joinWrap} className="glide-join">
      <div style={S.joinCard} className="glide-glass glide-join-card">
        <img src="/cloudflare-logo-white.png" alt="Cloudflare" style={S.cfLogoJoin} />
        <h1 style={{ ...S.brand, fontSize: 30 }} className="glide-brand">{title}</h1>
        <p style={S.tagline}>{message}</p>
        {action}
      </div>
    </div>
  );
}

function useRoomConnectionAccess(room: string, onAccessLost: () => void) {
  const recheckController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => recheckController.current?.abort(), []);

  const onClose = useCallback((event: CloseEvent) => {
    if (event.code === 1008) {
      recheckController.current?.abort();
      onAccessLost();
      return;
    }
    if (event.code !== 1006 || recheckController.current) return;

    const controller = new AbortController();
    recheckController.current = controller;
    void fetchAccessJson(
      `/api/room-access?room=${encodeURIComponent(room)}&intent=inspect`,
      controller.signal,
      "POST",
    )
      .catch((reason: unknown) => {
        if (
          !controller.signal.aborted &&
          reason instanceof AccessRequestError &&
          [401, 403, 404].includes(reason.status)
        ) {
          onAccessLost();
        }
      })
      .finally(() => {
        if (recheckController.current === controller) recheckController.current = undefined;
      });
  }, [onAccessLost, room]);

  const shouldReconnectOnClose = useCallback((event: CloseEvent) => event.code !== 1008, []);
  return { onClose, shouldReconnectOnClose };
}

function RoomAccessGate({
  room,
  mode,
  children,
}: {
  room: string;
  mode: "activate" | "inspect";
  children: (
    access: RoomAccessStatus & { message?: string },
    recheckAccess: () => void,
  ) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState<RoomAccessStatus & { message?: string }>();
  const [error, setError] = useState<string>();
  const recheckAccess = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setAccess(undefined);
    setError(undefined);
    const intent = mode === "inspect" ? "&intent=inspect" : "";
    void fetchAccessJson(`/api/room-access?room=${encodeURIComponent(room)}${intent}`, controller.signal, "POST")
      .then((value) => {
        const parsed = parsedRoomAccessStatus(value);
        if (!parsed) throw new Error("Glide returned a malformed room-access response.");
        setAccess(parsed);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Glide could not check room access.");
        }
      });
    return () => controller.abort();
  }, [attempt, mode, room]);

  if (error) {
    return (
      <AccessCard
        title="Room access required"
        message={error}
        action={<button style={S.primaryBtn} onClick={() => setAttempt((value) => value + 1)}>Try again</button>}
      />
    );
  }
  if (!access) return <AccessCard title="Checking room access" message="Verifying your membership…" />;
  return children(access, recheckAccess);
}

function Room({ session }: { session: AccessSession }) {
  const [room, setRoom] = useState<string>(() => readRoomFromHash());

  useEffect(() => {
    const onHash = () => {
      setRoom(readRoomFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const changeRoom = useCallback((next: string) => {
    if (!session.isEmployee) return;
    const normalized = next.trim();
    if (!isSupportedRoomId(normalized)) return;
    location.hash = encodeURIComponent(normalized);
  }, [session.isEmployee]);

  if (!room) {
    return session.isEmployee ? (
      <AccessCard
        title="Create a private room"
        message={`Signed in as ${session.email}. New Glide rooms can be created by Cloudflare employees.`}
        action={
          <button
            style={S.primaryBtn}
            onClick={() => {
              location.hash = encodeURIComponent(newRoomId());
            }}
          >
            Create room
          </button>
        }
      />
    ) : (
      <AccessCard
        title="Open an invitation"
        message={`Signed in as ${session.email}. Open the room link from a member's invitation; external users cannot create rooms.`}
      />
    );
  }

  return (
    <RoomAccessGate key={room} mode="activate" room={room}>
      {(access, recheckAccess) => (
        <RoomSession
          access={access}
          key={room}
          name={access.email}
          onAccessLost={recheckAccess}
          room={room}
          onRoomChange={changeRoom}
        />
      )}
    </RoomAccessGate>
  );
}

function RoomSession({
  access,
  name,
  onAccessLost,
  room,
  onRoomChange,
}: {
  access: RoomAccessStatus & { message?: string };
  name: string;
  onAccessLost: () => void;
  room: string;
  onRoomChange: (room: string) => void;
}) {
  const agentRoom = requiredRoomStorageName(room);
  const draftStorageKey = roomSessionKey("draft", room);
  const pendingStorageKey = roomSessionKey("pending", room);
  const recoverableStorageKey = roomSessionKey("recoverable", room);
  const initialDraft = useMemo(() => readStoredDraft(draftStorageKey), [draftStorageKey]);
  const [state, setState] = useState<GlideState>();
  const [notice, setNotice] = useState<string>();
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  /** Per-action opt-in for the auto-rollback safety window (invertible changes only). */
  const [autoRevertIds, setAutoRevertIds] = useState<Set<string>>(new Set());
  /** Rollback windows the user is actively keeping/reverting, to disable their buttons. */
  const [rollbackBusyIds, setRollbackBusyIds] = useState<Set<string>>(new Set());
  /** Pending action whose "Schedule apply" form is open, and its datetime-local draft. */
  const [schedulingId, setSchedulingId] = useState<string | undefined>();
  const [scheduleDraft, setScheduleDraft] = useState("");
  /** Draft outgoing-webhook URL in the owner's notifications config. */
  const [webhookInput, setWebhookInput] = useState("");
  const [draft, setDraft] = useState(() => initialDraft?.text ?? "");
  const [recoverableDrafts, setRecoverableDrafts] = useState<PendingDelivery[]>(() =>
    readRecoverableDrafts(sessionStorage, recoverableStorageKey));
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "viewer">("member");
  const [members, setMembers] = useState<RoomMember[]>(access.members);
  // The caller's live role: prefer the synced members list (so an owner's role
  // change takes effect without a reconnect), falling back to the role captured
  // at connect. Viewers are read-only: they may read + chat + propose (queue)
  // changes, but cannot apply/reject, invite, manage the token, or rename.
  const myRole: RoomAccessStatus["role"] =
    members.find((m) => m.email === name)?.role ?? access.role;
  const isViewer = myRole === "viewer";
  const canWrite = myRole === "owner" || myRole === "member";
  // The guided FORM is opt-in now; onboarding is chat-led by default.
  const [formOpen, setFormOpen] = useState(false);
  const [migBusy, setMigBusy] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);
  const [hydrationRetry, setHydrationRetry] = useState(0);
  const [deliverySyncing, setDeliverySyncing] = useState(false);
  const [deliveryIssue, setDeliveryIssue] = useState<{ message: string; retryable: boolean }>();
  const [legacyChatMigration, setLegacyChatMigration] = useState<LegacyChatMigrationStatus>();
  const [legacyRecoveryConfirmation, setLegacyRecoveryConfirmation] = useState("");
  const [legacyRecoveryBusy, setLegacyRecoveryBusy] = useState(false);
  const [roomDraft, setRoomDraft] = useState(room);
  const [roomNameDraft, setRoomNameDraft] = useState("");
  const roomNameFocused = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const guidedStartInFlight = useRef(false);
  const reverifiedToken = useRef(false);
  const connectionEpoch = useRef(0);
  const hydratedEpoch = useRef(0);
  const hydratingEpoch = useRef(0);
  const hydrationFailures = useRef(0);
  const hydrationRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busyRef = useRef(false);
  const historyReadyRef = useRef(historyReady);
  const deliverySyncingRef = useRef(false);
  const submissionInFlightRef = useRef(false);
  const deliverySyncSequence = useRef(0);
  const pendingDeliveryRef = useRef<PendingDelivery | undefined>(
    readPendingDelivery(sessionStorage, pendingStorageKey),
  );
  const pendingRetryRef = useRef<{ messageId: string; interruptedAssistantId?: string } | undefined>(undefined);
  const draftRef = useRef(draft);
  const draftRecoveryIdRef = useRef<string | undefined>(initialDraft?.recoveryId);
  const draftRevisionRef = useRef<string | undefined>(initialDraft?.revision);
  const recoverableCountRef = useRef(recoverableDrafts.length);
  const recoverableDraftsRef = useRef(recoverableDrafts);
  const messagesRef = useRef<UIMessage[]>([]);
  const legacyChatMigrationRef = useRef<LegacyChatMigrationStatus | undefined>(undefined);
  draftRef.current = draft;
  historyReadyRef.current = historyReady;
  recoverableCountRef.current = recoverableDrafts.length;
  recoverableDraftsRef.current = recoverableDrafts;

  const updateHistoryReady = useCallback((ready: boolean) => {
    historyReadyRef.current = ready;
    setHistoryReady(ready);
  }, []);

  const scheduleHydrationRetry = useCallback(() => {
    if (hydrationRetryTimer.current) return;
    hydrationFailures.current = Math.min(hydrationFailures.current + 1, 6);
    const delay = Math.min(250 * 2 ** (hydrationFailures.current - 1), 5_000);
    hydrationRetryTimer.current = setTimeout(() => {
      hydrationRetryTimer.current = undefined;
      setHydrationRetry((current) => current + 1);
    }, delay);
  }, []);

  useEffect(() => () => {
    if (hydrationRetryTimer.current) clearTimeout(hydrationRetryTimer.current);
  }, []);

  const updateDraft = useCallback((value: string, recoveryId?: string): boolean => {
    if (containsCloudflareApiToken(value)) {
      writeStoredDraft(draftStorageKey, undefined);
      draftRef.current = value;
      draftRecoveryIdRef.current = undefined;
      draftRevisionRef.current = value ? crypto.randomUUID() : undefined;
      setDraft(value);
      setDeliveryIssue({
        message: "Token-like text is kept only in memory and cannot be sent in chat. Use Connection > Set token instead.",
        retryable: false,
      });
      return false;
    }
    const stored = value
      ? { text: value, revision: crypto.randomUUID(), ...(recoveryId ? { recoveryId } : {}) }
      : undefined;
    const persisted = writeStoredDraft(draftStorageKey, stored);
    draftRef.current = value;
    draftRecoveryIdRef.current = stored?.recoveryId;
    draftRevisionRef.current = stored?.revision;
    setDraft(value);
    if (!persisted) {
      setDeliveryIssue({
        message: "Browser session storage is unavailable. Keep this tab open; drafts will not survive a reload.",
        retryable: false,
      });
    }
    return persisted;
  }, [draftStorageKey]);

  const clearDeliveryDraft = useCallback((delivery: PendingDelivery): boolean => {
    const matchesRecovery =
      draftRecoveryIdRef.current === delivery.id && draftRef.current === delivery.text;
    const matchesAccepted =
      delivery.acceptedDraftRevision !== undefined &&
      draftRevisionRef.current === delivery.acceptedDraftRevision &&
      draftRef.current.trim() === delivery.text;
    if (!matchesRecovery && !matchesAccepted) return true;
    if (!writeStoredDraft(draftStorageKey, undefined)) {
      setDeliveryIssue({
        message: "Browser session storage could not finish delivery cleanup. Keep this tab open while Glide retries.",
        retryable: false,
      });
      return false;
    }
    draftRef.current = "";
    draftRecoveryIdRef.current = undefined;
    draftRevisionRef.current = undefined;
    setDraft("");
    return true;
  }, [draftStorageKey]);

  const clearPendingDelivery = useCallback((expectedId?: string): boolean => {
    if (expectedId && pendingDeliveryRef.current?.id !== expectedId) return false;
    if (!writeSessionValue(pendingStorageKey, undefined)) {
      setDeliveryIssue({
        message: "Browser session storage could not finish delivery cleanup. Keep this tab open while Glide retries.",
        retryable: false,
      });
      return false;
    }
    pendingDeliveryRef.current = undefined;
    return true;
  }, [pendingStorageKey]);

  const removeRecoverableDraft = useCallback((id: string): boolean => {
    const drafts = recoverableDraftsRef.current;
    const next = drafts.filter((draft) => draft.id !== id);
    if (next.length === drafts.length) return true;
    const persisted = writeSessionValue(recoverableStorageKey, next.length ? JSON.stringify(next) : undefined);
    if (!persisted) {
      setDeliveryIssue({
        message: "Browser session storage could not update saved undelivered messages. Keep this tab open and reload only after recovery.",
        retryable: false,
      });
      return false;
    }
    recoverableDraftsRef.current = next;
    recoverableCountRef.current = next.length;
    setRecoverableDrafts(next);
    return true;
  }, [recoverableStorageKey]);

  const preserveUndeliveredDraft = useCallback((pending: PendingDelivery): {
    location: "restored" | "existing" | "queued";
    persisted: boolean;
  } => {
    const { text } = pending;
    const drafts = recoverableDraftsRef.current;
    if (!drafts.some((draft) => draft.id === pending.id)) {
      const next = [...drafts, pending];
      if (!writeSessionValue(recoverableStorageKey, JSON.stringify(next))) {
        setDeliveryIssue({
          message: "Browser session storage could not save the undelivered message. Keep this tab open and do not reload.",
          retryable: false,
        });
        return { location: "queued", persisted: false };
      }
      recoverableDraftsRef.current = next;
      recoverableCountRef.current = next.length;
      setRecoverableDrafts(next);
    }
    const current = draftRef.current;
    if (!current.trim()) {
      return { location: "restored", persisted: updateDraft(text, pending.id) };
    }
    if (
      current === text &&
      (draftRecoveryIdRef.current === pending.id ||
        draftRevisionRef.current === pending.acceptedDraftRevision)
    ) {
      return { location: "existing", persisted: updateDraft(text, pending.id) };
    }
    return { location: "queued", persisted: true };
  }, [recoverableStorageKey, updateDraft]);

  const roomLink = `${location.origin}/#${encodeURIComponent(room)}`;
  const connectionAccess = useRoomConnectionAccess(room, onAccessLost);

  // Keep the room-name field in sync with the live synced value (e.g. when a
  // teammate renames the room), but never clobber what someone is mid-typing.
  useEffect(() => {
    if (!roomNameFocused.current) setRoomNameDraft(state?.roomName ?? "");
  }, [state?.roomName]);

  const agent = useAgent<GlideState>({
    agent: "GlideAgent",
    name: agentRoom,
    onStateUpdate: (s) => setState(s),
    ...connectionAccess,
  });

  const acceptedChatMessageIds = useCallback(async (ids: readonly string[]): Promise<Set<string>> => {
    if (!ids.length) return new Set();
    const requested = Array.from(new Set(ids));
    const value = await agent.call("acceptedChatMessageIds", [requested], { timeout: AGENT_MESSAGES_TIMEOUT_MS }) as {
      ok?: unknown;
      accepted?: unknown;
    };
    if (
      value?.ok !== true ||
      !Array.isArray(value.accepted) ||
      value.accepted.some((id) => typeof id !== "string" || !requested.includes(id))
    ) {
      throw new Error("Glide returned a malformed delivery-ledger response.");
    }
    return new Set(value.accepted as string[]);
  }, [agent]);

  const applyLegacyChatMigrationStatus = useCallback((next: LegacyChatMigrationStatus) => {
    const wasReady = legacyChatMigrationRef.current?.status === "ready";
    legacyChatMigrationRef.current = next;
    setLegacyChatMigration(next);
    if (next.status !== "ready") {
      hydratedEpoch.current = 0;
      hydratingEpoch.current = 0;
      updateHistoryReady(false);
    } else if (!wasReady) {
      hydratedEpoch.current = 0;
      hydratingEpoch.current = 0;
      updateHistoryReady(false);
      setHydrationRetry((current) => current + 1);
    }
  }, [updateHistoryReady]);

  const refreshLegacyChatMigrationStatus = useCallback(async (): Promise<LegacyChatMigrationStatus> => {
    const value = await agent.call("legacyChatMigrationStatus", [], { timeout: AGENT_MESSAGES_TIMEOUT_MS });
    const parsed = parsedLegacyChatMigrationStatus(value);
    if (!parsed) throw new Error("Glide returned a malformed room-migration status.");
    applyLegacyChatMigrationStatus(parsed);
    return parsed;
  }, [agent, applyLegacyChatMigrationStatus]);

  useEffect(() => {
    let open = false;
    const update = () => setConnected(agent.readyState === WebSocket.OPEN);
    const onOpen = () => {
      if (!open) {
        open = true;
        connectionEpoch.current += 1;
        hydratedEpoch.current = 0;
        updateHistoryReady(false);
      }
      update();
    };
    const onClose = () => {
      open = false;
      connectionEpoch.current += 1;
      updateHistoryReady(false);
      update();
    };
    agent.addEventListener("open", onOpen);
    agent.addEventListener("close", onClose);
    agent.addEventListener("error", update);
    if (agent.readyState === WebSocket.OPEN) onOpen();
    else update();
    return () => {
      agent.removeEventListener("open", onOpen);
      agent.removeEventListener("close", onClose);
      agent.removeEventListener("error", update);
    };
  }, [agent, room, updateHistoryReady]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const migration = await refreshLegacyChatMigrationStatus();
        if (cancelled || migration.status === "ready") return;
      } catch {
        if (cancelled) return;
      }
      timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connected, refreshLegacyChatMigrationStatus]);

  // `WebSocketChatTransport` treats AgentConnection.send() as void, while the
  // underlying PartySocket returns false when it only buffered the frame. Do
  // the readiness check at the actual transport send, not merely on button
  // click: prepareBody awaits before send, so the socket can close in between.
  const chatAgent = useMemo(
    () => ({
      agent: agent.agent,
      name: agent.name,
      path: agent.path,
      get connectionError() {
        return agent.connectionError;
      },
      getHttpUrl: () => agent.getHttpUrl(),
      send: (data: string) => {
        if (agent.readyState !== WebSocket.OPEN || !agent.send(data)) {
          throw new TypeError(CHAT_CONNECTION_ERROR);
        }
      },
      addEventListener: agent.addEventListener.bind(agent),
      removeEventListener: agent.removeEventListener.bind(agent),
    }),
    [agent],
  );

  const chat = useAgentChat({
    agent: chatAgent,
    // A bounded loader prevents both an endless Suspense fallback and retries
    // from submitting an incomplete transcript that omits persisted history.
    getInitialMessages: loadInitialAgentMessages,
    // Coalesce fast stream bursts so per-chunk store updates cannot trip
    // React's nested-update guard (minified error #185).
    experimental_throttle: 100,
    cancelOnClientAbort: true,
    // Local hydration must never replace the server's authoritative transcript.
    syncMessagesToServer: false,
    body: () => ({ name }),
    onError: (error) => {
      setDeliveryIssue({
        message:
          error.message === CHAT_CONNECTION_ERROR
            ? "The live connection dropped before Glide received your message. Checking delivery…"
            : `Glide could not complete that response: ${error.message}`,
        retryable: false,
      });
    },
  });
  const setChatMessagesRef = useRef(chat.setMessages);
  setChatMessagesRef.current = chat.setMessages;

  const messages = chat.messages;
  messagesRef.current = messages;
  const verifiedActionResultEvents = useVerifiedActionResultEvents(agent, messages);
  const visibleMessages = messages.filter((message) => {
    const candidate = actionResultEventCandidate(message);
    return !candidate || !verifiedActionResultEvents.has(actionResultEventKey(candidate));
  });
  const busy =
    chat.status === "submitted" ||
    chat.status === "streaming" ||
    chat.isStreaming ||
    chat.isServerStreaming ||
    chat.isToolContinuation ||
    chat.isRecovering;
  const legacyMigrationReady = legacyChatMigration?.status === "ready";
  busyRef.current = busy;

  // A frame classified as absent can still arrive after the bounded delivery
  // check. Keep its original id as a tombstone and reconcile any later
  // authoritative broadcast before the saved text can be resent.
  useEffect(() => {
    if (!historyReady || deliverySyncing || busy || submissionInFlightRef.current) return;
    let reconciled = false;
    for (const recovery of [...recoverableDraftsRef.current]) {
      if (persistedDeliveryStatus(messages, recovery.id) === "not_delivered") continue;
      if (!clearDeliveryDraft(recovery) || !removeRecoverableDraft(recovery.id)) {
        hydratedEpoch.current = 0;
        updateHistoryReady(false);
        scheduleHydrationRetry();
        return;
      }
      reconciled = true;
    }
    if (!reconciled) return;
    const retryTarget = interruptedRetryTarget(messages);
    setDeliveryIssue(
      retryTarget
        ? { message: "The delayed message arrived, but the assistant response was interrupted.", retryable: true }
        : undefined,
    );
  }, [busy, clearDeliveryDraft, deliverySyncing, historyReady, messages, removeRecoverableDraft, scheduleHydrationRetry, updateHistoryReady]);

  // A reconnect can miss turns posted by another teammate. Rehydrate only
  // while idle, and only if local history stays unchanged during the fetch, so
  // a slow response cannot overwrite newer streamed chunks.
  useEffect(() => {
    const epoch = connectionEpoch.current;
    if (
      !connected ||
      !legacyMigrationReady ||
      busy ||
      epoch === 0 ||
      hydratedEpoch.current === epoch ||
      hydratingEpoch.current === epoch
    ) return;
    hydratingEpoch.current = epoch;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const revision = JSON.stringify(messagesRef.current);
        const persisted = await fetchAgentMessages(agent.getHttpUrl());
        if (cancelled || connectionEpoch.current !== epoch || busyRef.current) return;
        if (revision !== JSON.stringify(messagesRef.current)) continue;
        const recoveries = [...recoverableDraftsRef.current];
        const pending = pendingDeliveryRef.current;
        const deliveryRevision = JSON.stringify({ recoveries, pending });
        const absentIds = Array.from(new Set(
          [...recoveries.map((recovery) => recovery.id), ...(pending ? [pending.id] : [])]
            .filter((id) => persistedDeliveryStatus(persisted, id) === "not_delivered"),
        ));
        const acceptedAbsentIds = await acceptedChatMessageIds(absentIds);
        if (cancelled || connectionEpoch.current !== epoch || busyRef.current) return;
        if (
          revision !== JSON.stringify(messagesRef.current) ||
          deliveryRevision !== JSON.stringify({
            recoveries: recoverableDraftsRef.current,
            pending: pendingDeliveryRef.current,
          })
        ) continue;
        let applied = false;
        setChatMessagesRef.current((current) => {
          if (busyRef.current || revision !== JSON.stringify(current)) return current;
          applied = true;
          return persisted;
        });
        await Promise.resolve();
        if (!applied) continue;
        let acceptedPrunedRecovery = false;
        for (const recovery of recoveries) {
          const recoveryStatus = reconciledDeliveryStatus(persisted, recovery.id, acceptedAbsentIds);
          if (recoveryStatus === "not_delivered") continue;
          if (recoveryStatus === "accepted_pruned") acceptedPrunedRecovery = true;
          if (!clearDeliveryDraft(recovery) || !removeRecoverableDraft(recovery.id)) {
            hydratedEpoch.current = 0;
            hydratingEpoch.current = 0;
            updateHistoryReady(false);
            scheduleHydrationRetry();
            return;
          }
        }
        if (pending) {
          const status = reconciledDeliveryStatus(persisted, pending.id, acceptedAbsentIds);
          let recoveryPersisted = true;
          if (status === "delivered") {
            recoveryPersisted = clearDeliveryDraft(pending);
            recoveryPersisted = removeRecoverableDraft(pending.id) && recoveryPersisted;
            if (recoveryPersisted) setDeliveryIssue(undefined);
          } else if (status === "not_delivered") {
            const recovery = preserveUndeliveredDraft(pending);
            recoveryPersisted = recovery.persisted;
            if (recoveryPersisted) {
              setDeliveryIssue({
                message: recovery.location !== "queued"
                  ? "That message was not delivered. It has been restored to the composer; press Send again when ready."
                  : "That message was not delivered. It is saved separately below so your newer draft remains intact.",
                retryable: false,
              });
            }
          } else {
            recoveryPersisted = clearDeliveryDraft(pending);
            recoveryPersisted = removeRecoverableDraft(pending.id) && recoveryPersisted;
            if (recoveryPersisted) {
              setDeliveryIssue({
                message: status === "accepted_pruned"
                  ? "That message reached Glide and is older than the retained room history. It will not be sent again."
                  : "Your message reached Glide, but the assistant response was interrupted.",
                retryable: status !== "accepted_pruned",
              });
            }
          }
          if (!recoveryPersisted) {
            hydratedEpoch.current = 0;
            hydratingEpoch.current = 0;
            updateHistoryReady(false);
            scheduleHydrationRetry();
            return;
          }
          if (!clearPendingDelivery(pending.id)) {
            hydratedEpoch.current = 0;
            hydratingEpoch.current = 0;
            updateHistoryReady(false);
            scheduleHydrationRetry();
            return;
          }
        } else {
          const retryWasPending = Boolean(pendingRetryRef.current);
          pendingRetryRef.current = undefined;
          const retryTarget = interruptedRetryTarget(persisted);
          if (acceptedPrunedRecovery) {
            setDeliveryIssue({
              message: "A delayed message reached Glide and is older than the retained room history. It will not be sent again.",
              retryable: false,
            });
          } else if (retryTarget) {
            setDeliveryIssue({ message: "The assistant response is interrupted and can be retried.", retryable: true });
          } else if (retryWasPending) {
            setDeliveryIssue(undefined);
          }
        }
        deliverySyncSequence.current += 1;
        deliverySyncingRef.current = false;
        setDeliverySyncing(false);
        hydrationFailures.current = 0;
        if (hydrationRetryTimer.current) {
          clearTimeout(hydrationRetryTimer.current);
          hydrationRetryTimer.current = undefined;
        }
        hydratedEpoch.current = epoch;
        hydratingEpoch.current = 0;
        updateHistoryReady(true);
        return;
      }
      throw new Error("room history changed while synchronizing");
    })().catch((error: unknown) => {
      if (cancelled || connectionEpoch.current !== epoch) return;
      hydratingEpoch.current = 0;
      hydratedEpoch.current = 0;
      scheduleHydrationRetry();
      setDeliveryIssue({
        message:
          error instanceof Error
            ? `Glide could not synchronize room history: ${error.message} Retrying automatically.`
            : "Glide could not synchronize room history. Retrying automatically; reload if it persists.",
        retryable: false,
      });
    });
    return () => {
      cancelled = true;
      if (hydratingEpoch.current === epoch) hydratingEpoch.current = 0;
    };
  }, [acceptedChatMessageIds, agent, busy, clearDeliveryDraft, clearPendingDelivery, connected, historyReady, hydrationRetry, legacyMigrationReady, preserveUndeliveredDraft, removeRecoverableDraft, room, scheduleHydrationRetry, updateHistoryReady]);

  // Escape hatch for a wedged turn. A chat stream can stop terminalizing —
  // e.g. the Durable Object was evicted mid-response (a deploy), the WebSocket
  // dropped, or a non-streaming model hung — leaving `busy` stuck true with no
  // final `finish`. `GlideAgent` runs with the stall watchdog + durable
  // recovery off, so nothing server-side kills the spinner. Without a client
  // out, the composer's Send stays disabled forever and the room looks frozen
  // ("won't let me send more messages"). So: (a) always offer a Stop button
  // while busy, and (b) if the turn goes quiet for STALL_MS, mark it `stalled`
  // — that re-enables Send and shows a hint, so the user can always recover.
  const STALL_MS = 20000;
  const [stalled, setStalled] = useState(false);
  const stalledRef = useRef(stalled);
  stalledRef.current = stalled;
  const lastMessage = messages[messages.length - 1];
  // A signature that grows as tokens/parts stream in; used to restart the
  // stall timer so a genuinely-progressing turn never trips it.
  const progressSig = `${messages.length}:${lastMessage ? JSON.stringify(lastMessage.parts ?? "").length : 0}`;
  useEffect(() => {
    if (!busy) {
      setStalled(false);
      return;
    }
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [busy, progressSig]);

  const stop = useCallback(() => {
    // Cancel the active/wedged turn. Belt-and-suspenders: even if the library's
    // streaming flags lag behind, `stalled` unblocks the composer immediately.
    try {
      chat.stop?.();
    } catch {
      /* already stopped / nothing to abort */
    }
    setStalled(true);
  }, [chat]);

  // Autoscroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [visibleMessages.length, busy]);

  const reportClientChatIssue = useCallback(
    (kind: Exclude<ReconciledDeliveryStatus, "delivered">, messageId: string, epoch: number) => {
      void agent
        .call(
          "reportClientChatIssue",
          [{ kind, messageId, connectionEpoch: epoch }],
          { timeout: 5000 },
        )
        .catch(() => undefined);
    },
    [agent],
  );

  const verifyDelivery = useCallback(
    async (messageId: string, text: string, epoch: number) => {
      const syncId = ++deliverySyncSequence.current;
      deliverySyncingRef.current = true;
      setDeliverySyncing(true);
      let settled = false;
      try {
        let status: ReconciledDeliveryStatus = "not_delivered";
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const revision = JSON.stringify(messagesRef.current);
          const persisted = await fetchAgentMessages(agent.getHttpUrl());
          if (deliverySyncSequence.current !== syncId) return;
          const baseStatus = persistedDeliveryStatus(persisted, messageId);
          const acceptedAbsentIds = baseStatus === "not_delivered"
            ? await acceptedChatMessageIds([messageId])
            : new Set<string>();
          if (deliverySyncSequence.current !== syncId) return;
          const fetchedStatus = reconciledDeliveryStatus(persisted, messageId, acceptedAbsentIds);
          if (fetchedStatus !== "delivered" && fetchedStatus !== "accepted_pruned" && attempt < 2) {
            if (revision !== JSON.stringify(messagesRef.current)) continue;
            await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
            continue;
          }
          let replaced = false;
          setChatMessagesRef.current((current) => {
            if (revision !== JSON.stringify(current)) return current;
            replaced = true;
            return persisted;
          });
          await Promise.resolve();
          if (!replaced) continue;
          status = fetchedStatus;
          settled = true;
          break;
        }
        if (!settled) throw new Error("room history changed while confirming delivery");
        const pending = pendingDeliveryRef.current?.id === messageId
          ? pendingDeliveryRef.current
          : { id: messageId, text };
        if (status === "delivered") {
          let persisted = clearDeliveryDraft(pending);
          persisted = removeRecoverableDraft(messageId) && persisted;
          if (!persisted) {
            settled = false;
            hydratedEpoch.current = 0;
            updateHistoryReady(false);
            scheduleHydrationRetry();
            return;
          }
          if (!clearPendingDelivery(messageId)) {
            settled = false;
            hydratedEpoch.current = 0;
            updateHistoryReady(false);
            scheduleHydrationRetry();
            return;
          }
          setDeliveryIssue(undefined);
          return;
        }

        reportClientChatIssue(status, messageId, epoch);
        if (status === "not_delivered") {
          const recovery = preserveUndeliveredDraft(pending);
          if (!recovery.persisted) {
            settled = false;
            hydratedEpoch.current = 0;
            updateHistoryReady(false);
            scheduleHydrationRetry();
            return;
          }
          if (!clearPendingDelivery(messageId)) {
            settled = false;
            hydratedEpoch.current = 0;
            updateHistoryReady(false);
            scheduleHydrationRetry();
            return;
          }
          setDeliveryIssue({
            message: recovery.location !== "queued"
              ? "That message was not delivered. It has been restored to the composer; press Send again when ready."
              : "That message was not delivered. It is saved separately below so your newer draft remains intact.",
            retryable: false,
          });
          return;
        }

        let persisted = clearDeliveryDraft(pending);
        persisted = removeRecoverableDraft(messageId) && persisted;
        if (!persisted) {
          settled = false;
          hydratedEpoch.current = 0;
          updateHistoryReady(false);
          scheduleHydrationRetry();
          return;
        }
        if (!clearPendingDelivery(messageId)) {
          settled = false;
          hydratedEpoch.current = 0;
          updateHistoryReady(false);
          scheduleHydrationRetry();
          return;
        }
        setDeliveryIssue({
          message: status === "accepted_pruned"
            ? "That message reached Glide and is older than the retained room history. It will not be sent again."
            : "Your message reached Glide, but the assistant response was interrupted.",
          retryable: status !== "accepted_pruned",
        });
      } catch {
        if (deliverySyncSequence.current !== syncId) return;
        const pending = pendingDeliveryRef.current?.id === messageId
          ? pendingDeliveryRef.current
          : { id: messageId, text };
        const recovery = preserveUndeliveredDraft(pending);
        hydratedEpoch.current = 0;
        hydratingEpoch.current = 0;
        updateHistoryReady(false);
        scheduleHydrationRetry();
        setDeliveryIssue({
          message: recovery.location === "queued"
            ? "Delivery could not be confirmed. The submission is saved separately below; reconnect or reload before sending."
            : "Delivery could not be confirmed against authoritative history. Your draft is preserved; reconnect or reload before sending.",
          retryable: false,
        });
      } finally {
        if (settled && deliverySyncSequence.current === syncId) {
          deliverySyncingRef.current = false;
          setDeliverySyncing(false);
        }
      }
    },
    [acceptedChatMessageIds, agent, clearDeliveryDraft, clearPendingDelivery, pendingStorageKey, preserveUndeliveredDraft, removeRecoverableDraft, reportClientChatIssue, scheduleHydrationRetry, updateHistoryReady],
  );

  const finishDeliveryCheck = useCallback(
    async (messageId: string, text: string, epoch: number) => {
      await verifyDelivery(messageId, text, epoch);
    },
    [verifyDelivery],
  );

  const sendChatText = useCallback(
    async (rawText: string, clearComposer = false): Promise<boolean> => {
      const text = rawText.trim();
      if (!text) return false;
      if (!isChatTextWithinLimit(text)) {
        setDeliveryIssue({
          message: `Messages can contain at most ${MAX_CHAT_TEXT_CHARS.toLocaleString()} characters.`,
          retryable: false,
        });
        return false;
      }
      if (containsCloudflareApiToken(text)) {
        setDeliveryIssue({
          message: "For safety, API tokens cannot be sent in chat. Add it under Connection → Set token instead.",
          retryable: false,
        });
        return false;
      }
      const retryRecovery =
        recoverableDraftsRef.current.find(
          (recovery) => recovery.id === draftRecoveryIdRef.current && recovery.text === text,
        ) ?? recoverableDraftsRef.current.find((recovery) => recovery.text === text);
      if (!retryRecovery && recoverableCountRef.current >= MAX_RECOVERABLE_DRAFTS) {
        setDeliveryIssue({
          message: "Restore or remove a saved undelivered message before sending another one.",
          retryable: false,
        });
        return false;
      }
      if (
        agent.readyState !== WebSocket.OPEN ||
        legacyChatMigrationRef.current?.status !== "ready" ||
        !historyReadyRef.current ||
        deliverySyncingRef.current ||
        pendingDeliveryRef.current
      ) {
        setDeliveryIssue({
          message: "Glide is synchronizing authoritative history. Your message was not sent; try again when synchronization finishes.",
          retryable: false,
        });
        return false;
      }
      if (submissionInFlightRef.current) {
        setDeliveryIssue({ message: "Another message is still being submitted. Wait for delivery confirmation.", retryable: false });
        return false;
      }
      if (busyRef.current && !stalledRef.current) {
        setDeliveryIssue({ message: "Wait for Glide's current response, or stop it before sending another message.", retryable: false });
        return false;
      }
      if (busyRef.current) {
        stop();
        setDeliveryIssue({ message: "Stopping the current response. Send again after Glide becomes idle.", retryable: false });
        return false;
      }
      submissionInFlightRef.current = true;
      const messageId = retryRecovery?.id ?? crypto.randomUUID();
      const epoch = connectionEpoch.current;
      chat.clearError();
      setDeliveryIssue(undefined);
      const acceptedDraftRevision =
        clearComposer && draftRef.current.trim() === text ? draftRevisionRef.current : undefined;
      const pending: PendingDelivery = {
        id: messageId,
        text,
        ...(acceptedDraftRevision ? { acceptedDraftRevision } : {}),
      };
      if (!writeSessionValue(pendingStorageKey, JSON.stringify(pending))) {
        preserveUndeliveredDraft(pending);
        setDeliveryIssue({
          message: "The message was not sent because browser session storage is unavailable. It remains in this tab; do not reload.",
          retryable: false,
        });
        submissionInFlightRef.current = false;
        return false;
      }
      pendingDeliveryRef.current = pending;
      try {
        if (clearComposer) clearDeliveryDraft(pending);
        try {
          await chat.sendMessage({
            id: messageId,
            role: "user",
            parts: [{ type: "text", text }],
            metadata: { name } satisfies GlideMessageMetadata,
          });
          await finishDeliveryCheck(messageId, text, epoch);
          return true;
        } catch {
          await verifyDelivery(messageId, text, epoch);
          return false;
        }
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [agent, clearDeliveryDraft, stop, chat, name, finishDeliveryCheck, pendingStorageKey, preserveUndeliveredDraft, verifyDelivery],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    void sendChatText(text, true);
  }, [draft, sendChatText]);

  const retryInterruptedResponse = useCallback(() => {
    const target = interruptedRetryTarget(messagesRef.current);
    if (!target) {
      setDeliveryIssue({ message: "There is no interrupted user turn to retry.", retryable: false });
      return;
    }
    if (
      agent.readyState !== WebSocket.OPEN ||
      legacyChatMigrationRef.current?.status !== "ready" ||
      !historyReadyRef.current ||
      deliverySyncingRef.current
    ) {
      setDeliveryIssue({ message: "Glide is still reconnecting. Retry when the Live badge returns.", retryable: true });
      return;
    }
    const syncId = ++deliverySyncSequence.current;
    deliverySyncingRef.current = true;
    setDeliverySyncing(true);
    pendingRetryRef.current = target;
    let settled = false;
    chat.clearError();
    setDeliveryIssue(undefined);
    void agent
      .call("retryInterruptedResponse", [target.messageId, target.interruptedAssistantId], { timeout: 120_000 })
      .then(async (value) => {
        const result = value as { ok?: boolean; message?: string };
        let persisted: UIMessage[] | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const revision = JSON.stringify(messagesRef.current);
          const fetched = await fetchAgentMessages(agent.getHttpUrl());
          if (deliverySyncSequence.current !== syncId) return;
          let replaced = false;
          setChatMessagesRef.current((current) => {
            if (revision !== JSON.stringify(current)) return current;
            replaced = true;
            return fetched;
          });
          await Promise.resolve();
          if (replaced) {
            persisted = fetched;
            break;
          }
        }
        if (!persisted) throw new Error("room history changed while confirming the retry");
        settled = true;
        pendingRetryRef.current = undefined;
        const retryTarget = interruptedRetryTarget(persisted);
        if (result.ok && !retryTarget) {
          setDeliveryIssue(undefined);
        } else {
          setDeliveryIssue({
            message: result.ok
              ? "The retried assistant response was interrupted again."
              : result.message || "Glide could not retry that response.",
            retryable: Boolean(retryTarget),
          });
        }
      })
      .catch((error: unknown) => {
        if (deliverySyncSequence.current !== syncId) return;
        hydratedEpoch.current = 0;
        hydratingEpoch.current = 0;
        updateHistoryReady(false);
        scheduleHydrationRetry();
        setDeliveryIssue({
          message: error instanceof Error ? `Glide could not retry that response: ${error.message}` : "Glide could not retry that response.",
          retryable: false,
        });
      })
      .finally(() => {
        if (settled && deliverySyncSequence.current === syncId) {
          deliverySyncingRef.current = false;
          setDeliverySyncing(false);
        }
      });
  }, [agent, chat, scheduleHydrationRetry, updateHistoryReady]);

  const runRpc = useCallback(
    async <T = unknown>(
      method: string,
      args: unknown[],
      options?: { timeout?: number },
    ): Promise<T | undefined> => {
      if (agent.readyState !== WebSocket.OPEN) {
        setNotice("Glide is reconnecting. Try again when the Live badge returns.");
        return undefined;
      }
      try {
        setNotice(undefined);
        return (await agent.call(method, args, options)) as T;
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [agent],
  );

  const discardLegacyChatArchive = useCallback(async () => {
    if (
      legacyChatMigration?.status !== "recovery_required" ||
      legacyRecoveryConfirmation !== LEGACY_CHAT_RECOVERY_CONFIRMATION
    ) return;
    setLegacyRecoveryBusy(true);
    try {
      const result = await runRpc<{ ok: boolean; message: string }>(
        "discardLegacyChatArchiveForRecovery",
        [legacyRecoveryConfirmation],
        { timeout: AGENT_MESSAGES_TIMEOUT_MS },
      );
      if (!result) return;
      setNotice(result.message);
      if (!result.ok) return;
      setLegacyRecoveryConfirmation("");
      await refreshLegacyChatMigrationStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Glide could not refresh migration status.");
    } finally {
      setLegacyRecoveryBusy(false);
    }
  }, [legacyChatMigration?.status, legacyRecoveryConfirmation, refreshLegacyChatMigrationStatus, runRpc]);

  // A token stored by an older build — or one whose `/user/tokens/verify` call
  // 401'd despite the token being perfectly usable — can get stuck showing
  // "token unverified" forever, since validity was only ever checked at save
  // time. Re-check the stored token once per mount whenever the badge says
  // unverified so it self-corrects (via the read-based fallback) without the
  // user having to re-enter it. The ref guard prevents a loop if it stays bad.
  useEffect(() => {
    if (reverifiedToken.current) return;
    if (connected && state?.tokenConfigured && state.tokenValid === false) {
      reverifiedToken.current = true;
      void runRpc("reverifyToken", []);
    }
  }, [connected, state?.tokenConfigured, state?.tokenValid, runRpc]);

  const saveToken = useCallback(async () => {
    const value = tokenInput.trim();
    if (!value) return;
    const res = await runRpc<{ ok: boolean; message: string }>("setCloudflareToken", [value]);
    setTokenInput("");
    setShowTokenForm(false);
    if (res) setNotice(res.message);
  }, [tokenInput, runRpc]);

  // Commit a room-name edit. Normalizes locally (so the field shows exactly what
  // the server stores), no-ops when unchanged, and reverts on a failed send.
  const commitRoomName = useCallback(async () => {
    roomNameFocused.current = false;
    const next = normalizeRoomName(roomNameDraft) ?? "";
    const current = state?.roomName ?? "";
    setRoomNameDraft(next);
    if (next === current) return;
    const res = await runRpc<{ ok: boolean; roomName?: string }>("setRoomName", [next, name]);
    if (res?.ok) setRoomNameDraft(res.roomName ?? "");
    else setRoomNameDraft(current);
  }, [roomNameDraft, state?.roomName, runRpc, name]);

  const invite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    const res = await runRpc<{ ok: boolean; message: string; members?: RoomMember[] }>("inviteTeammate", [
      email,
      name,
      roomLink,
      inviteRole,
    ]);
    if (res?.ok !== true) {
      if (res) setNotice(res.message);
      return;
    }
    if (res?.members) setMembers(res.members);
    setInviteEmail("");
    // Open the user's mail client with a prefilled invite (works for anyone).
    const roomLabel = state?.roomName ? `"${state.roomName}" (#${room})` : `#${room}`;
    const subject = encodeURIComponent(`Join me in the Glide room ${roomLabel}`);
    const lines = [
      `${name} invited you to the Glide room ${roomLabel}.`,
      "",
      `Open it here: ${roomLink}`,
      "",
      `Sign in to Cloudflare Access as ${email}; membership is checked against that verified address.`,
      "Glide is a shared room that drives Cloudflare configuration via chat.",
    ];
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(
      lines.join("\n"),
    )}`;
  }, [inviteEmail, inviteRole, name, room, roomLink, runRpc, state?.roomName]);

  const removeMember = useCallback(async (email: string) => {
    if (!window.confirm(`Remove ${email} from this room? Their active connections will close immediately.`)) return;
    const res = await runRpc<{ ok: boolean; message: string; members?: RoomMember[] }>(
      "removeRoomMember",
      [email],
    );
    if (res?.members) setMembers(res.members);
    if (res) setNotice(res.message);
  }, [runRpc]);

  // Owner-only: switch a member between "member" and "viewer" (read-only).
  const setRole = useCallback(async (email: string, role: "member" | "viewer") => {
    const res = await runRpc<{ ok: boolean; message: string; members?: RoomMember[] }>(
      "setMemberRole",
      [email, role],
    );
    if (res?.members) setMembers(res.members);
    if (res && res.ok !== true) setNotice(res.message);
  }, [runRpc]);

  // Owner-only: permanently delete this room, then navigate back to the lobby.
  const deleteRoom = useCallback(async () => {
    const label = state?.roomName ? `"${state.roomName}" (#${room})` : `#${room}`;
    if (
      !window.confirm(
        `Permanently delete room ${label}?\n\nThis erases the chat history, pending approvals, memory, business profile, invites, and the stored Cloudflare token for EVERYONE in the room. This cannot be undone.`,
      )
    ) return;
    const res = await runRpc<{ ok: boolean; message: string }>(
      "destroyRoom",
      [ROOM_DELETE_CONFIRMATION, name],
      { timeout: APPLY_RPC_TIMEOUT_MS },
    );
    if (res?.ok) {
      // The room is gone; drop the hash so the lobby (create screen) renders.
      location.hash = "";
    } else if (res) {
      setNotice(res.message);
    }
  }, [room, name, runRpc, state?.roomName]);

  useEffect(() => {
    if (!connected || agent.readyState !== WebSocket.OPEN) return;
    void agent.call("roomAccessStatus", [], { timeout: AGENT_MESSAGES_TIMEOUT_MS })
      .then((value) => {
        const parsed = parsedRoomAccessStatus(value);
        if (parsed) setMembers(parsed.members);
      })
      .catch(() => undefined);
  }, [agent, connected, state?.invites.length]);

  const apply = useCallback(
    async (id: string, confirmUncertain = false, autoRevert = false) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const result = await runRpc<ActionResult>(
          "applyAction",
          [id, name, confirmUncertain, autoRevert],
          { timeout: APPLY_RPC_TIMEOUT_MS },
        );
        if (result?.status === "failed") {
          setNotice(
            result.detail.startsWith("Outcome uncertain:")
              ? result.detail
              : `${result.detail} The action is still queued so you can retry it.`,
          );
        }
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [runRpc, name],
  );

  // Auto-rollback safety window: Keep (close the window, change stays) or Revert
  // now (restore the prior value immediately). Both take only the window id.
  const keepAppliedChange = useCallback(
    (rollbackId: string) =>
      runRpc<{ ok: boolean; message: string }>("keepAppliedChange", [rollbackId, name]),
    [runRpc, name],
  );
  const revertAppliedChange = useCallback(
    (rollbackId: string) =>
      runRpc<ActionResult>("revertAppliedChange", [rollbackId, name], { timeout: APPLY_RPC_TIMEOUT_MS }),
    [runRpc, name],
  );

  // Maintenance-window Apply: defer a pending action to a future time, or cancel
  // a pending schedule. The action stays in Pending approvals until it fires.
  const scheduleApply = useCallback(
    async (id: string, whenTs: number) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const res = await runRpc<{ ok: boolean; message: string }>("scheduleApply", [id, whenTs, name]);
        if (res?.message) setNotice(res.message);
        if (res?.ok) {
          setSchedulingId(undefined);
          setScheduleDraft("");
        }
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [runRpc, name],
  );
  const cancelScheduledApply = useCallback(
    async (id: string) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const res = await runRpc<{ ok: boolean; message: string }>("cancelScheduledApply", [id, name]);
        if (res?.message) setNotice(res.message);
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [runRpc, name],
  );

  // ---- Onboarding wizard callbacks ----
  const patchOnboarding = useCallback(
    (patch: Record<string, unknown>) =>
      runRpc<{ ok: boolean; message?: string }>("updateOnboarding", [patch, name]),
    [runRpc, name],
  );
  const previewMigration = useCallback(
    (args: {
      provider: string;
      config?: string;
      configFiles?: Array<{ filename: string; content: string }>;
      format?: string;
    }) => runRpc<{ ok: boolean; message: string; totalRules?: number }>("previewMigration", [args, name]),
    [runRpc, name],
  );
  const finishOnboarding = useCallback(
    async (kickoff: string) => {
      const completed = await runRpc<{ ok: boolean; message?: string }>("completeOnboarding", [name]);
      if (!completed?.ok) return;
      setFormOpen(false);
      if (kickoff.trim()) await sendChatText(kickoff);
    },
    [runRpc, name, sendChatText],
  );

  // Kick off the chat-led guided setup: start onboarding, optionally pin the
  // branch so the sidebar updates instantly, then let Glide ask the next
  // question. The checklist on the right auto-fills as answers come in.
  const startGuided = useCallback(
    async (path?: OnboardingPath) => {
      if (guidedStartInFlight.current) return;
      guidedStartInFlight.current = true;
      setFormOpen(false);
      try {
        const started = await runRpc<{ ok: boolean }>("startOnboarding", [name]);
        if (!started?.ok) return;
        if (path) {
          const updated = await runRpc<{ ok: boolean }>("updateOnboarding", [{ path }, name]);
          if (!updated?.ok) return;
        }
        const text =
          path === "migrate"
            ? "I'm migrating to Cloudflare from another provider — walk me through it one step at a time."
            : path === "fresh"
              ? "I'm setting up Cloudflare fresh — walk me through it one step at a time."
              : "Help me get set up on Cloudflare — ask me what you need, one question at a time.";
        await sendChatText(text);
      } finally {
        guidedStartInFlight.current = false;
      }
    },
    [runRpc, name, sendChatText],
  );

  // Wipe this room's onboarding so the guided flow starts over. The room is
  // durable and keyed by the URL hash, so a hard refresh keeps prior progress;
  // this is the intended "start fresh" without opening a new room. Pending
  // approvals and chat history are kept.
  const resetOnboarding = useCallback(() => {
    if (
      !window.confirm(
        "Reset onboarding for this room? This clears the path, domain, DNS setup, goals, and checklist so the guided flow starts over. Pending approvals and chat history are kept.",
      )
    )
      return;
    void runRpc("resetOnboarding", [name]);
    setFormOpen(false);
  }, [runRpc, name]);

  // Persist "nature of the business" answers from the opt-in wizard step.
  const patchBusinessProfile = useCallback(
    (patch: Partial<BusinessProfile>) =>
      runRpc<{ ok: boolean; message?: string }>("updateBusinessProfile", [patch, name]),
    [runRpc, name],
  );

  // Clear the captured business profile so discovery can start over.
  const resetBusinessProfile = useCallback(() => {
    if (
      !window.confirm(
        "Clear the captured business profile for this room? Glide will re-ask the discovery questions. Pending approvals and chat history are kept.",
      )
    )
      return;
    void runRpc("resetBusinessProfile", [name]);
  }, [runRpc, name]);

  // Clear the running "Cloudflare docs from this chat" reading list.
  const clearDocLinks = useCallback(() => {
    void runRpc("clearDocLinks", [name]);
  }, [runRpc, name]);

  // One-click queue a tailored recommendation. The server rebuilds the exact API
  // call from its own catalog, targeting the room's default zone.
  const queueRecommendation = useCallback(
    (recId: string) =>
      runRpc<{ ok: boolean; message: string; id?: string }>("queueRecommendation", [
        recId,
        state?.defaultZone?.id ?? "",
        name,
      ]),
    [runRpc, name, state?.defaultZone?.id],
  );

  // Hand a recommendation that needs setup (discovery, a plan, or a dashboard
  // step) to Glide in chat rather than queuing a half-formed action.
  const askAboutRecommendation = useCallback(
    (rec: Recommendation) => {
      const text = `Help me set up this Cloudflare recommendation: "${rec.title}". ${rec.rationale} Walk me through it one step at a time and queue what's needed for me to Apply.`;
      void sendChatText(text);
    },
    [sendChatText],
  );

  // Security posture scorecard: (re)grade the live zone, and queue a single
  // one-click fix. The server rebuilds the exact call from its posture catalog
  // (never from client input), so we only ever send the check id + zone id.
  const refreshSecurityPosture = useCallback(
    () => runRpc<{ ok: boolean; message: string; grade?: string; score?: number }>("refreshSecurityPosture", [name]),
    [runRpc, name],
  );
  const queuePostureFix = useCallback(
    (checkId: string) =>
      runRpc<{ ok: boolean; message: string; id?: string }>("queuePostureFix", [
        checkId,
        state?.defaultZone?.id ?? "",
        name,
      ]),
    [runRpc, name, state?.defaultZone?.id],
  );
  const askPostureFix = useCallback(
    (ask: string) => {
      void sendChatText(ask);
    },
    [sendChatText],
  );
  // Configuration-drift watch: bless the zone's current live state as the
  // known-good baseline, and toggle the weekly drift check. Both are member+
  // config changes; the server re-reads live state to build the baseline.
  const setPostureBaseline = useCallback(
    () => runRpc<{ ok: boolean; message: string; grade?: string; score?: number }>("setPostureBaseline", [name]),
    [runRpc, name],
  );
  const setDriftWatch = useCallback(
    (enabled: boolean) =>
      runRpc<{ ok: boolean; message: string; enabled: boolean }>("setDriftWatch", [enabled, name]),
    [runRpc, name],
  );
  // Four-eyes (dual-approval) change control.
  const setFourEyes = useCallback(
    async (enabled: boolean) => {
      const res = await runRpc<{ ok: boolean; message: string; enabled: boolean }>("setFourEyes", [enabled, name]);
      if (res?.message) setNotice(res.message);
    },
    [runRpc, name],
  );
  const approveAction = useCallback(
    async (id: string) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const res = await runRpc<{ ok: boolean; message: string; applied: boolean }>(
          "approveAction",
          [id, name],
          { timeout: APPLY_RPC_TIMEOUT_MS },
        );
        if (res?.message) setNotice(res.message);
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [runRpc, name],
  );
  const withdrawApproval = useCallback(
    async (id: string) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        const res = await runRpc<{ ok: boolean; message: string }>("withdrawApproval", [id, name]);
        if (res?.message) setNotice(res.message);
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [runRpc, name],
  );
  // Governance notifications: owner-set outgoing webhook (secret stored server-side).
  const setNotifyWebhook = useCallback(
    async (url: string) => {
      const res = await runRpc<{ ok: boolean; message: string; host?: string }>("setNotifyWebhook", [url, name]);
      if (res?.message) setNotice(res.message);
      return res;
    },
    [runRpc, name],
  );
  const testNotifyWebhook = useCallback(async () => {
    const res = await runRpc<{ ok: boolean; message: string }>("testNotifyWebhook", [name]);
    if (res?.message) setNotice(res.message);
  }, [runRpc, name]);

  // Blast-radius preview: per-pending-action impact estimate, loaded on demand.
  const [impacts, setImpacts] = useState<
    Record<string, { loading?: boolean; estimate?: BlastRadiusEstimate; error?: string }>
  >({});
  const previewImpact = useCallback(
    async (actionId: string) => {
      setImpacts((m) => ({ ...m, [actionId]: { ...m[actionId], loading: true, error: undefined } }));
      const res = await runRpc<{ ok: boolean; message: string; estimate?: BlastRadiusEstimate }>(
        "estimateActionImpact",
        [actionId, name],
      );
      setImpacts((m) => ({
        ...m,
        [actionId]: res?.ok
          ? { loading: false, estimate: res.estimate }
          : { loading: false, error: res?.message ?? "Couldn't estimate impact." },
      }));
    },
    [runRpc, name],
  );

  const onboarding = state?.onboarding;
  // Form is opt-in: only show when the user explicitly opens it.
  const showWizard = !!state && formOpen && !onboarding?.completed;

  const pending = state?.pendingActions ?? [];
  const memory = useMemo(() => Object.entries(state?.memory ?? {}), [state?.memory]);
  // The most recent assistant turn that ran `recommend_configuration` gets an
  // inline, actionable recommendations card rendered right under it — same
  // engine, same one-click Queue RPC as the sidebar panel, but surfaced where
  // the advice actually appears in the conversation.
  let lastRecommendMsgId: string | undefined;
  for (const m of visibleMessages) {
    if (
      m.role !== "user" &&
      messageText(m).tools.some(
        (tool) => tool.name === "recommend_configuration" && tool.status === "complete",
      )
    )
      lastRecommendMsgId = m.id;
  }
  const anyActionApplying = pending.some(
    (action) => busyIds.has(action.id) || isActionApplying(action),
  );

  const applyAll = useCallback(async () => {
    if (!state?.tokenConfigured) {
      setShowTokenForm(true);
      setNotice("Add a Cloudflare API token before applying queued changes.");
      return;
    }
    const restoreCount = pending.filter(isSnapshotRestoreAction).length;
    const uncertainCount = pending.filter(
      (action) => !isSnapshotRestoreAction(action) && isActionOutcomeUncertain(action),
    ).length;
    // Four-eyes-gated changes still awaiting a second approval can't be applied in
    // bulk (the server fails them closed) — approve them individually instead.
    const awaitingApproval = (action: PendingAction) =>
      state?.fourEyes?.enabled === true &&
      requiresSecondApproval(action).required &&
      new Set((action.approvals ?? []).map((ap) => ap.by)).size < 2;
    const ids = pending
      .filter(
        (action) =>
          !isSnapshotRestoreAction(action) &&
          !isActionApplying(action) &&
          !isActionOutcomeUncertain(action) &&
          !awaitingApproval(action),
      )
      .map((action) => action.id);
    if (!ids.length) {
      if (uncertainCount) {
        setNotice("Apply all skipped changes with uncertain outcomes. Verify each live configuration before retrying it individually.");
      } else if (restoreCount) {
        setNotice("Snapshot restore is disabled. Reject the legacy restore approval to remove it.");
      }
      return;
    }
    if (!window.confirm(`Apply ${ids.length} reviewed change${ids.length === 1 ? "" : "s"}?`)) return;
    setBusyIds((prev) => new Set([...prev, ...ids]));
    try {
      const results = await runRpc<ActionResult[]>(
        "applyAll",
        [ids, name],
        { timeout: APPLY_RPC_TIMEOUT_MS * ids.length },
      );
      if (!results) {
        setNotice(
          "Glide could not confirm the bulk Apply outcome. Verify the live configuration and pending queue before retrying.",
        );
        return;
      }
      const failures = results.filter((result) => result.status === "failed");
      const serverSkipped = Math.max(0, ids.length - results.length);
      if (failures.length || uncertainCount || restoreCount || serverSkipped) {
        const skipped = uncertainCount
          ? ` ${uncertainCount} uncertain action${uncertainCount === 1 ? " was" : "s were"} skipped pending live verification.`
          : "";
        const changed = serverSkipped
          ? ` ${serverSkipped} reviewed action${serverSkipped === 1 ? " was" : "s were"} skipped because the queue changed before Apply.`
          : "";
        const restores = restoreCount
          ? ` ${restoreCount} disabled snapshot restore approval${restoreCount === 1 ? " was" : "s were"} skipped; reject ${restoreCount === 1 ? "it" : "them"}.`
          : "";
        setNotice(
          `${failures.length ? `${failures.length} action${failures.length === 1 ? "" : "s"} failed and remain queued for retry.` : ""}${skipped}${restores}${changed}`.trim(),
        );
      }
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }, [name, pending, runRpc, state?.tokenConfigured]);

  return (
    <div style={S.shell} className="glide-shell">
      <header style={S.header} className="glide-header glide-glass">
        <div style={S.headerLeft} className="glide-header-left">
          <img src="/cloudflare-mark.png" alt="Cloudflare" style={S.cfMark} />
          <span style={S.brandSm} className="glide-brand">Glide</span>
          <input
            value={roomNameDraft}
            maxLength={MAX_ROOM_NAME_CHARS}
            placeholder="Name this room"
            readOnly={isViewer}
            onFocus={() => { roomNameFocused.current = true; }}
            onChange={(e) => setRoomNameDraft(e.target.value)}
            onBlur={() => { if (!isViewer) void commitRoomName(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setRoomNameDraft(state?.roomName ?? "");
                roomNameFocused.current = false;
                event.currentTarget.blur();
              }
            }}
            style={S.roomNameInput}
            className="glide-room-name"
            aria-label="Room name"
            title={isViewer ? "Viewers have read-only access" : "Give this room a name everyone in it will see"}
          />
          <span style={S.roomPill} className="glide-room-pill">
            #
            <input
              value={roomDraft}
              maxLength={MAX_LEGACY_ROOM_ID_CHARS}
              readOnly={!access.isEmployee}
              onChange={(e) => setRoomDraft(e.target.value)}
              onBlur={() => {
                const next = roomDraft.trim();
                if (isSupportedRoomId(next)) onRoomChange(next);
                else setRoomDraft(room);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  setRoomDraft(room);
                  event.currentTarget.blur();
                }
              }}
              style={S.roomInput}
              aria-label="Room ID"
              title={access.isEmployee ? "Open or create another room by ID" : "External members open rooms from invitation links"}
            />
          </span>
          <span
            style={S.safetyPill}
            className="glide-safety-pill"
            title="Reads run automatically. Writes always wait for your approval."
            aria-label="Reads run automatically; writes require approval."
          >
            <span style={S.safetyDotRead} className="glide-safety-read-dot" />
            <span className="glide-safety-read">reads run</span>
            <span style={S.safetyDivider} className="glide-safety-divider">·</span>
            <span style={S.safetyDotWrite} />
            <span>writes wait</span>
          </span>
        </div>
        <div style={S.headerRight} className="glide-header-right">
          <span
            style={{
              ...S.badge,
              background: connected && historyReady && legacyMigrationReady ? "rgba(34,197,94,.16)" : "rgba(245,158,11,.14)",
              color: connected && historyReady && legacyMigrationReady ? "#6ee7b7" : "#fcd34d",
              border: connected && historyReady && legacyMigrationReady ? "1px solid rgba(34,197,94,.4)" : "1px solid rgba(245,158,11,.4)",
            }}
          >
            {connected && historyReady && legacyMigrationReady
              ? "live"
              : connected && legacyChatMigration?.status !== undefined && legacyChatMigration.status !== "ready"
                ? "migration"
                : connected
                  ? "syncing"
                  : "reconnecting"}
          </span>
          {state ? (
            state.tokenValid === false ? (
              <span style={{ ...S.badge, background: "rgba(202,138,4,.16)", color: "#fde68a", border: "1px solid rgba(202,138,4,.5)" }}>token unverified</span>
            ) : state.tokenConfigured ? (
              <span style={{ ...S.badge, background: "rgba(34,197,94,.16)", color: "#6ee7b7", border: "1px solid rgba(34,197,94,.4)" }}>token ✓</span>
            ) : (
              <span style={{ ...S.badge, background: "rgba(244,63,94,.16)", color: "#fda4af", border: "1px solid rgba(244,63,94,.4)" }}>no token</span>
            )
          ) : (
            <span style={{ ...S.badge, background: "rgba(148,163,184,.14)", color: "#cbd5e1", border: "1px solid rgba(148,163,184,.28)" }}>connecting…</span>
          )}
          <a href={`/admin#${encodeURIComponent(room)}`} style={S.headerLink} title="Open the read-only admin dashboard for this room">
            Admin →
          </a>
          <span style={S.you} className="glide-user">{name}</span>
        </div>
      </header>

      {access.entry === "claimed" ? (
        <div style={S.warnBar} className="glide-warn-bar">
          <strong>Legacy room claimed.</strong> Verified membership now protects this room. Re-invite any legacy guests before they can return.
        </div>
      ) : connected && legacyChatMigration && legacyChatMigration.status !== "ready" ? (
        <div style={S.warnBar} className="glide-warn-bar">
          <strong>Room history is locked.</strong> {legacyChatMigration.message}
          {legacyChatMigration.status === "recovery_required" && (
            <> Use the explicit recovery control under <strong>Connection</strong> only if the old archive may be permanently deleted.</>
          )}
        </div>
      ) : state &&
        (state.tokenValid === false ? (
          <div style={S.warnBar} className="glide-warn-bar">
            The saved Cloudflare API token failed verification. Review or replace it in{" "}
            <strong>Connection → Change</strong> before account discovery or Apply.
          </div>
        ) : !state.tokenConfigured ? (
          <div style={S.warnBar} className="glide-warn-bar">
            No Cloudflare API token yet. You can chat and queue changes, but Apply is blocked until you
            add one in <strong>Connection → Set token</strong> (right sidebar). It’s stored encrypted.
          </div>
        ) : null)}

      <div style={S.body} className="glide-workspace">
        {/* Chat column */}
        <main style={S.chatCol} className="glide-chat glide-glass">
          {showWizard && (
            <div style={S.wizPane}>
              <OnboardingWizard
                onboarding={onboarding}
                businessProfile={state?.businessProfile}
                tokenConfigured={!!state?.tokenConfigured}
                migrationToolConfigured={state?.migrationToolConfigured}
                migrationPlan={state?.migrationPlan}
                onPatch={patchOnboarding}
                onProfile={patchBusinessProfile}
                onPreview={previewMigration}
                onSaveToken={(t) => runRpc<{ ok: boolean; message: string }>("setCloudflareToken", [t])}
                onFinish={finishOnboarding}
                onDismiss={() => setFormOpen(false)}
              />
            </div>
          )}

          <div ref={scrollRef} style={S.messages} className="glide-messages">
            {visibleMessages.length === 0 &&
              (showWizard ? (
                <div style={S.empty}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Ask Glide while you configure</p>
                  <p style={{ marginTop: 6, color: "#9ca3af" }}>
                    The guided form is above — or just chat. Ask things like “what's the difference between
                    Full and Partial DNS?” or “what token permissions do I need?”.
                  </p>
                </div>
              ) : onboarding?.completed ? (
                <div style={S.empty}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Start a conversation</p>
                  <p style={{ marginTop: 6, color: "#9ca3af" }}>
                    Try: “find the zone example.com and list its DNS records”, or “block traffic from RU on
                    example.com”. Reads run instantly; changes wait for someone to Apply.
                  </p>
                </div>
              ) : onboarding?.active ? (
                // Onboarding was already started (e.g. via the guided form) but there
                // are no chat messages yet — resume, don't re-ask the first question.
                // The checklist/progress on the right reflects what's captured; offer
                // to continue in chat or Reset to truly start over.
                <div style={S.empty}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Onboarding in progress</p>
                  <p style={{ marginTop: 6, color: "#9ca3af" }}>
                    Your answers so far are in the checklist on the right. Ask Glide “what's next?” to
                    continue, open <strong>Use form</strong> to edit answers, or hit <strong>Reset</strong>{" "}
                    in the Onboarding panel to start over.
                  </p>
                </div>
              ) : (
                <GuidedIntro onChoose={(p) => startGuided(p)} onUseForm={() => setFormOpen(true)} />
              ))}
            {visibleMessages.map((m) => {
              const { text, tools } = messageText(m);
              const { who, userStyle } = messageAuthor(m);
              const mine = m.role === "user" && who === name;
              return (
                <Fragment key={m.id}>
                <div style={{ ...S.msgRow, justifyContent: mine ? "flex-end" : "flex-start" }}>
                  {!mine && (
                    <div style={{ ...S.avatar, ...(userStyle ? S.avatarUser : S.avatarAi) }}>
                      {userStyle ? who.charAt(0).toUpperCase() : "G"}
                    </div>
                  )}
                  <div className="glide-bubble" style={{ ...S.bubble, ...(userStyle ? S.userBubble : S.aiBubble), ...(mine ? S.mineBubble : null) }}>
                    <div style={S.msgWho}>{who}</div>
                    {text && <div style={S.msgText}>{text}</div>}
                    {tools.map((tool) => (
                      <ToolChip key={tool.id} tool={tool} />
                    ))}
                    {!text &&
                      tools.some((tool) =>
                        ["unknown", "running", "waiting"].includes(tool.status),
                      ) &&
                      m.role !== "user" && (
                      <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic", marginTop: 6 }}>
                        Working on that… say “continue” if this pauses.
                      </div>
                    )}
                    {!text &&
                      tools.length > 0 &&
                      tools.every((tool) => tool.status === "complete" || tool.status === "failed") &&
                      m.role !== "user" && (
                        <div style={{ fontSize: 12, color: "#94a3b8", fontStyle: "italic", marginTop: 6 }}>
                          {tools.some((tool) => tool.status === "failed")
                            ? "The tool reported an error. See the next message for the recovery step."
                            : "Tool completed."}
                        </div>
                      )}
                  </div>
                  {mine && (
                    <div style={{ ...S.avatar, ...S.avatarMine }}>{who.charAt(0).toUpperCase()}</div>
                  )}
                </div>
                {m.id === lastRecommendMsgId && hasProfileSignal(state?.businessProfile) && (
                  <div style={{ ...S.msgRow, justifyContent: "flex-start" }}>
                    <div style={{ ...S.avatar, ...S.avatarAi, visibility: "hidden" }} aria-hidden>
                      G
                    </div>
                    <div
                      className="glide-bubble"
                      style={{ ...S.bubble, ...S.aiBubble, maxWidth: "min(94%, 560px)", width: "100%" }}
                    >
                      <div style={S.msgWho}>Recommended for you</div>
                      <RecommendationsPanel
                        profile={state!.businessProfile!}
                        goals={onboarding?.goals}
                        setupType={onboarding?.setupType}
                        zoneId={state?.defaultZone?.id}
                        pending={pending}
                        results={state?.recentResults ?? []}
                        onQueue={queueRecommendation}
                        onAsk={askAboutRecommendation}
                      />
                    </div>
                  </div>
                )}
                </Fragment>
              );
            })}
            {busy && (
              <div style={{ ...S.msgRow, justifyContent: "flex-start" }}>
                <div style={{ ...S.avatar, ...S.avatarAi }}>G</div>
                <div className="glide-bubble" style={{ ...S.bubble, ...S.aiBubble }}>
                  <div style={S.msgWho}>Glide</div>
                  {stalled ? (
                    <div style={S.stallHint}>
                      Still working on the last step. If it looks stuck, press <strong>Stop</strong>{" "}
                      and send your message again.
                    </div>
                  ) : (
                    <div style={S.typing} className="glide-dots" aria-label="Glide is thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {(!connected || !historyReady) && (
            <div style={S.connectionNotice}>
              Reconnecting to this room. Drafts remain local and Send is paused until the connection is live.
            </div>
          )}
          {deliveryIssue && (
            <div style={S.deliveryNotice}>
              <span>{deliveryIssue.message}</span>
              {deliveryIssue.retryable && (
                <button
                  style={S.deliveryRetryBtn}
                  disabled={!connected || !historyReady || deliverySyncing}
                  onClick={retryInterruptedResponse}
                >
                  Retry response
                </button>
              )}
            </div>
          )}
          {recoverableDrafts.length > 0 && (
            <div style={S.deliveryNotice}>
              <span>
                {recoverableDrafts.length} undelivered {recoverableDrafts.length === 1 ? "message is" : "messages are"} saved in this tab.
              </span>
              <button
                style={S.deliveryRetryBtn}
                disabled={Boolean(draft.trim())}
                title={draft.trim() ? "Clear or send the current draft first" : "Restore the oldest undelivered message"}
                onClick={() => {
                  const recovery = recoverableDrafts[0];
                  updateDraft(recovery.text, recovery.id);
                }}
              >
                Restore saved message
              </button>
            </div>
          )}

          <div style={S.composer} className="glide-composer glide-glass-card">
            <textarea
              value={draft}
              maxLength={MAX_CHAT_TEXT_CHARS}
              onChange={(e) => updateDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                !connected || !historyReady || !legacyMigrationReady || deliverySyncing
                  ? "Reconnecting and syncing... your draft is safe"
                  : showWizard
                  ? "Ask Glide a question while you set up…  (Enter to send)"
                  : `Message #${room}…  (Enter to send, Shift+Enter for newline)`
              }
              rows={2}
              style={S.textarea}
            />
            {busy && (
              <button onClick={stop} style={S.stopBtn} title="Stop the current response">
                Stop
              </button>
            )}
            <button
              onClick={send}
              disabled={!connected || !historyReady || !legacyMigrationReady || deliverySyncing || !draft.trim() || (busy && !stalled)}
              style={S.sendBtn}
            >
              Send
            </button>
          </div>
        </main>

        {/* Sidebar */}
        <aside style={S.sidebar} className="glide-sidebar glide-glass">
          {notice && <div style={S.errorBox}>{notice}</div>}

          <Section title="Connection">
            {legacyChatMigration?.status !== "ready" ? (
              <div style={S.migrationRecovery}>
                <div style={{ fontSize: 13, color: "#f8fafc", fontWeight: 700 }}>
                  {legacyChatMigration?.status === "recovery_required"
                    ? "Legacy archive recovery required"
                    : legacyChatMigration?.status === "discarding"
                      ? "Discarding legacy archive"
                      : "Checking legacy room history"}
                </div>
                <p style={{ ...S.hint, color: "#cbd5e1" }}>
                  {legacyChatMigration?.message ?? "Glide is checking the room migration state."}
                </p>
                {legacyChatMigration?.status === "recovery_required" && (
                  <>
                    <p style={{ ...S.hint, color: "#fda4af" }}>
                      This permanently deletes only the unrecoverable legacy transcript archive. Current retained history and permanent replay protection are preserved.
                    </p>
                    <label style={{ ...S.label, marginTop: 10 }}>
                      Type <code>{LEGACY_CHAT_RECOVERY_CONFIRMATION}</code>
                    </label>
                    <input
                      value={legacyRecoveryConfirmation}
                      maxLength={LEGACY_CHAT_RECOVERY_CONFIRMATION.length}
                      onChange={(event) => setLegacyRecoveryConfirmation(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      style={{ ...S.input, marginBottom: 8 }}
                    />
                    <button
                      style={S.dangerBtn}
                      disabled={
                        !connected ||
                        legacyRecoveryBusy ||
                        legacyRecoveryConfirmation !== LEGACY_CHAT_RECOVERY_CONFIRMATION
                      }
                      onClick={() => void discardLegacyChatArchive()}
                    >
                      {legacyRecoveryBusy ? "Starting recovery..." : "Discard legacy archive"}
                    </button>
                  </>
                )}
              </div>
            ) : state?.tokenConfigured && !showTokenForm ? (
              <>
                <div style={S.tokenStatus}>
                  <span
                    style={{ ...S.dot, marginTop: 0, background: state.tokenValid === false ? "#ca8a04" : "#16a34a" }}
                  />
                  <span style={{ fontSize: 13 }}>
                    Token set{state.tokenLast4 ? ` ••••${state.tokenLast4}` : ""}
                    {state.tokenValid === false
                      ? " · unverified"
                      : state.tokenValid
                        ? " · verified"
                        : ""}
                  </span>
                </div>
                {canWrite && (
                  <div style={S.actionBtns}>
                    <button
                      style={S.rejectBtn}
                      onClick={() => {
                        setTokenInput("");
                        setShowTokenForm(true);
                      }}
                    >
                      Change
                    </button>
                    <button style={S.rejectBtn} onClick={() => runRpc("clearCloudflareToken", [])}>
                      Remove
                    </button>
                  </div>
                )}
              </>
            ) : !canWrite ? (
              <p style={S.hint}>
                No Cloudflare API token is connected. Viewers have read-only access — ask a room member or
                owner to add one under Connection → Set token.
              </p>
            ) : (
              <>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveToken();
                  }}
                  placeholder="Cloudflare API token"
                  autoComplete="off"
                  spellCheck={false}
                  style={{ ...S.input, marginBottom: 8 }}
                />
                <div style={S.actionBtns}>
                  <button style={S.applyBtn} disabled={!tokenInput.trim()} onClick={() => void saveToken()}>
                    Save securely
                  </button>
                  {state?.tokenConfigured && (
                    <button style={S.rejectBtn} onClick={() => setShowTokenForm(false)}>
                      Cancel
                    </button>
                  )}
                </div>
                <p style={S.hint}>
                  Stored AES-256-GCM encrypted at rest; never shown again. Create one at
                  dash.cloudflare.com/profile/api-tokens.
                </p>
              </>
            )}
          </Section>

          <Section
            title="Onboarding"
            action={
              onboarding?.completed ? (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button
                    style={S.miniBtn}
                    onClick={() => {
                      void runRpc("updateOnboarding", [{ completed: false }, name]);
                      setFormOpen(false);
                    }}
                  >
                    Re-run
                  </button>
                  <button style={S.miniBtn} onClick={resetOnboarding} title="Clear onboarding and start over">
                    Reset
                  </button>
                </span>
              ) : onboarding?.active ? (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <button style={S.miniBtn} onClick={() => setFormOpen(true)}>
                    Use form
                  </button>
                  <button style={S.miniBtn} onClick={resetOnboarding} title="Clear onboarding and start over">
                    Reset
                  </button>
                </span>
              ) : undefined
            }
          >
            {!onboarding?.active ? (
              <>
                <Muted>
                  Guided, Cloudflare-grounded setup. Chat with Glide one question at a time — this checklist
                  fills itself in as you answer — or click through a form.
                </Muted>
                <div style={{ ...S.actionBtns, marginTop: 10 }}>
                  <button style={S.applyBtn} onClick={() => startGuided()}>
                    Start in chat
                  </button>
                  <button style={S.rejectBtn} onClick={() => setFormOpen(true)}>
                    Use form
                  </button>
                </div>
              </>
            ) : (
              <OnboardingPanel
                onboarding={onboarding}
                onToggle={(id, done) => runRpc("toggleOnboardingStep", [id, done, name])}
              />
            )}
          </Section>

          {hasProfileSignal(state?.businessProfile) ? (
            <Section
              title="Business profile"
              action={
                <button style={S.miniBtn} onClick={resetBusinessProfile} title="Clear the captured business profile">
                  Reset
                </button>
              }
            >
              <BusinessProfilePanel profile={state!.businessProfile!} />
              <p style={{ margin: "10px 0 0", color: "#6b7280", fontSize: 12.5 }}>
                Ask Glide for <b>tailored recommendations</b> based on this — it proposes settings you Apply.
              </p>
            </Section>
          ) : (
            <Section title="Business profile">
              <Muted>
                Glide asks about your business — industry, logins/API, data sensitivity, compliance, and top
                concerns — to recommend the right performance & security settings. Answer in chat and it shows here.
              </Muted>
            </Section>
          )}

          {hasProfileSignal(state?.businessProfile) && (
            <Section title="Recommendations">
              <RecommendationsPanel
                profile={state!.businessProfile!}
                goals={onboarding?.goals}
                setupType={onboarding?.setupType}
                zoneId={state?.defaultZone?.id}
                pending={pending}
                results={state?.recentResults ?? []}
                onQueue={queueRecommendation}
                onAsk={askAboutRecommendation}
              />
            </Section>
          )}

          {(state?.defaultZone || state?.securityPosture) && (
            <Section title="Security posture">
              <SecurityPosturePanel
                report={state?.securityPosture}
                zoneId={state?.defaultZone?.id}
                baseline={state?.postureBaseline}
                drift={state?.postureDrift}
                driftWatch={state?.driftWatch}
                canWrite={canWrite}
                onRefresh={refreshSecurityPosture}
                onQueueFix={queuePostureFix}
                onAsk={askPostureFix}
                onSetBaseline={setPostureBaseline}
                onSetDriftWatch={setDriftWatch}
              />
            </Section>
          )}

          {!!state?.docLinks?.length && (
            <Section
              title="Cloudflare docs"
              action={
                <button style={S.miniBtn} onClick={clearDocLinks} title="Clear this chat's docs reading list">
                  Clear
                </button>
              }
            >
              <DocLinksPanel links={state.docLinks} />
            </Section>
          )}

          {(state?.defaultAccountId || state?.defaultZone) && (
            <Section title="Defaults">
              {state?.defaultAccountId && <KV k="account" v={state.defaultAccountId} />}
              {state?.defaultZone && <KV k="zone" v={`${state.defaultZone.name} (${state.defaultZone.id})`} />}
              {state?.liveZone && state.liveZone.zoneId === state?.defaultZone?.id && (
                <KV k="live" v={liveZoneSummary(state.liveZone)} />
              )}
            </Section>
          )}

          <Section title={`Pending approvals${pending.length ? ` · ${pending.length}` : ""}`}>
            {pending.length === 0 && <Muted>Nothing queued. Ask Glide to make a change.</Muted>}
            {pending.map((a: PendingAction) => {
              const status = pendingActionStatus(a);
              const disabledRestore = isSnapshotRestoreAction(a);
              const applying = busyIds.has(a.id) || isActionApplying(a);
              const failed = status === "failed" || (status === "applying" && !applying);
              const uncertain = isActionOutcomeUncertain(a);
              const impact = impacts[a.id];
              // Offer the auto-rollback safety window only when the change has a
              // clean one-call inverse (an invertible zone-setting PATCH).
              const invertible = !disabledRestore && invertibleSetting(a) !== null;
              const autoRevert = invertible && autoRevertIds.has(a.id);
              // Maintenance-window schedule: the action auto-applies at this time.
              const scheduledFor = typeof a.scheduledFor === "number" ? a.scheduledFor : undefined;
              const scheduling = schedulingId === a.id;
              // Four-eyes: gated changes need two distinct members to approve
              // before they apply (mirrors REQUIRED_APPROVALS on the server).
              const risk = state?.fourEyes?.enabled && !disabledRestore
                ? requiresSecondApproval(a)
                : { required: false as const };
              const gated = risk.required;
              const approvers = [...new Set((a.approvals ?? []).map((ap) => ap.by))];
              const approvedByMe = approvers.includes(name);
              const awaitingApproval = gated && approvers.length < 2;
              const statusLabel = disabledRestore
                ? "restore disabled"
                : applying
                ? "applying"
                : uncertain
                  ? "outcome uncertain"
                  : failed
                    ? "failed - retryable"
                    : "pending";
              const statusColor = disabledRestore ? "#fda4af" : applying ? "#fbbf24" : failed ? "#fda4af" : "#fdba74";
              return (
                <div
                  key={a.id}
                  style={S.actionCard}
                  className={`glide-pending glide-pending--${applying ? "applying" : failed ? "failed" : "waiting"} glide-lift`}
                >
                  <div style={S.actionTop}>
                    <span style={{ ...S.method, background: METHOD_COLORS[a.method] ?? "#6b7280" }}>{a.method}</span>
                    <span style={S.product}>{a.product}</span>
                    <span style={{ ...S.listMeta, marginLeft: "auto", color: statusColor }}>{statusLabel}</span>
                  </div>
                  <div style={S.actionSummary}>{a.summary}</div>
                  <code style={S.path}>{a.path}</code>
                  {disabledRestore && (
                    <div style={{ ...S.errorBox, marginTop: 8 }}>
                      Snapshot restore is disabled because the migration service cannot guarantee complete, fail-safe recovery. Reject this legacy approval.
                    </div>
                  )}
                  {failed && a.error && <div style={{ ...S.errorBox, marginTop: 8 }}>{a.error}</div>}
                  <div style={S.actionMeta}>by {a.createdBy}</div>
                  {a.body !== undefined && (
                    <details style={S.bodyDetails}>
                      <summary style={S.bodySummary}>Request body</summary>
                      <pre style={S.bodyPre}>{JSON.stringify(a.body, null, 2)}</pre>
                      {a.mergeEntrypoint && (
                        <div style={S.bodyNote}>
                          Preview only — on Apply, Glide re-reads this ruleset's current rules and appends
                          the {a.mergeEntrypoint.newRules.length} new rule(s), so existing rules aren't dropped.
                        </div>
                      )}
                    </details>
                  )}
                  {!disabledRestore && (
                    <div style={S.impactRow}>
                      {impact?.estimate ? (
                        <div style={{ ...S.impactBox, borderColor: BLAST_COLORS[impact.estimate.level] }}>
                          <span
                            style={{
                              ...S.impactChip,
                              background: BLAST_COLORS[impact.estimate.level],
                              color: impact.estimate.level === "medium" ? "#1a1008" : "#f8fafc",
                            }}
                          >
                            {impact.estimate.level === "unknown" ? "impact ?" : `${impact.estimate.level} impact`}
                          </span>
                          <span style={S.impactText}>{impact.estimate.summary}</span>
                        </div>
                      ) : impact?.error ? (
                        <span style={S.impactErr}>{impact.error}</span>
                      ) : (
                        <button
                          style={S.miniBtn}
                          disabled={impact?.loading}
                          onClick={() => void previewImpact(a.id)}
                          title="Estimate how much live traffic this change would touch before Apply"
                        >
                          {impact?.loading ? "Checking impact…" : "◎ Preview impact"}
                        </button>
                      )}
                    </div>
                  )}
                  {gated && (
                    <div style={S.approvalBox}>
                      <div style={S.approvalHead}>
                        <span style={S.approvalBadge}>◇ needs 2 approvals</span>
                        <span style={S.approvalCount}>{approvers.length}/2 approved</span>
                      </div>
                      {risk.reason && <div style={S.approvalReason}>{risk.reason}</div>}
                      {approvers.length > 0 && (
                        <div style={S.approvalWho}>Approved by {approvers.join(", ")}</div>
                      )}
                    </div>
                  )}
                  {scheduledFor !== undefined && (
                    <div style={S.scheduledRow} title={`Auto-applies at ${fmtWhen(scheduledFor)}`}>
                      <span style={S.scheduledBadge}>⏰ scheduled</span>
                      <span style={S.scheduledText}>
                        Applies {fmtWhen(scheduledFor)}
                        {a.scheduledBy ? ` · set by ${a.scheduledBy}` : ""}
                      </span>
                      {canWrite && (
                        <button
                          style={S.scheduledCancel}
                          disabled={busyIds.has(a.id)}
                          onClick={() => void cancelScheduledApply(a.id)}
                        >
                          Cancel schedule
                        </button>
                      )}
                    </div>
                  )}
                  {canWrite ? (
                    awaitingApproval ? (
                      <div style={S.actionBtns}>
                        {approvedByMe ? (
                          <>
                            <span style={S.approvedByMe}>✓ You approved</span>
                            <button
                              style={S.rejectBtn}
                              disabled={applying}
                              onClick={() => void withdrawApproval(a.id)}
                            >
                              Withdraw
                            </button>
                          </>
                        ) : (
                          <button
                            style={{ ...S.approveBtn, opacity: applying ? 0.6 : 1 }}
                            disabled={applying}
                            onClick={() => {
                              if (!state?.tokenConfigured) {
                                setShowTokenForm(true);
                                setNotice("Add a Cloudflare API token before approving this change.");
                                return;
                              }
                              void approveAction(a.id);
                            }}
                          >
                            {applying ? "Working…" : `Approve (${approvers.length}/2)`}
                          </button>
                        )}
                        <button
                          style={S.rejectBtn}
                          disabled={applying}
                          onClick={() => void runRpc("rejectAction", [a.id, name])}
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <div style={S.actionBtns}>
                        <button
                          style={{ ...S.applyBtn, opacity: applying ? 0.6 : 1 }}
                          disabled={applying || disabledRestore}
                          onClick={() => {
                            if (!state?.tokenConfigured) {
                              setShowTokenForm(true);
                              setNotice("Add a Cloudflare API token before applying this change.");
                              return;
                            }
                            if (
                              uncertain &&
                              !window.confirm(
                                "Cloudflare may already have applied this change. Verify the live configuration first. Retry anyway?",
                              )
                            ) {
                              return;
                            }
                            void apply(a.id, uncertain, autoRevert);
                          }}
                        >
                          {applying
                            ? "Applying…"
                            : disabledRestore
                              ? "Disabled"
                            : !state?.tokenConfigured
                              ? "Set token first"
                              : uncertain
                                ? "Retry anyway"
                                : failed
                                  ? "Retry"
                                  : "Apply"}
                        </button>
                        <button
                          style={S.rejectBtn}
                          disabled={applying}
                          onClick={() => void runRpc("rejectAction", [a.id, name])}
                        >
                          Reject
                        </button>
                      </div>
                    )
                  ) : (
                    <div style={S.hint}>
                      {awaitingApproval
                        ? "Read-only — this change needs two room members or owners to approve."
                        : "Read-only — ask a room member or owner to apply or reject this."}
                    </div>
                  )}
                  {canWrite && invertible && !failed && !uncertain && !scheduling && !awaitingApproval && scheduledFor === undefined && (
                    <label style={S.autoRevertRow} title="After Apply, Glide restores the previous value in 15 minutes unless you click Keep — a safety net for changes that might break traffic.">
                      <input
                        type="checkbox"
                        checked={autoRevert}
                        disabled={applying}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setAutoRevertIds((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(a.id);
                            else next.delete(a.id);
                            return next;
                          });
                        }}
                      />
                      <span>Auto-revert in 15 min unless I Keep it</span>
                    </label>
                  )}
                  {canWrite && !disabledRestore && !applying && !uncertain && !awaitingApproval && scheduledFor === undefined && (
                    scheduling ? (
                      <div style={S.scheduleForm}>
                        <input
                          type="datetime-local"
                          style={S.scheduleInput}
                          value={scheduleDraft}
                          min={toLocalInputValue(Date.now() + 60_000)}
                          onChange={(e) => setScheduleDraft(e.target.value)}
                        />
                        <button
                          style={S.miniBtn}
                          disabled={busyIds.has(a.id) || !scheduleDraft}
                          onClick={() => {
                            const whenTs = new Date(scheduleDraft).getTime();
                            if (!Number.isFinite(whenTs)) {
                              setNotice("Pick a valid date and time to schedule this apply.");
                              return;
                            }
                            if (whenTs < Date.now() + 60_000) {
                              setNotice("Schedule the apply at least a minute in the future.");
                              return;
                            }
                            if (!state?.tokenConfigured) {
                              setShowTokenForm(true);
                              setNotice("Add a Cloudflare API token before scheduling this change.");
                              return;
                            }
                            void scheduleApply(a.id, whenTs);
                          }}
                        >
                          Schedule
                        </button>
                        <button
                          style={S.scheduleCancelForm}
                          title="Close"
                          onClick={() => {
                            setSchedulingId(undefined);
                            setScheduleDraft("");
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <button
                        style={S.scheduleToggle}
                        onClick={() => {
                          setSchedulingId(a.id);
                          setScheduleDraft(toLocalInputValue(Date.now() + 60 * 60_000));
                        }}
                        title="Defer this change to a future maintenance window — Glide applies it automatically at the time you pick."
                      >
                        ⏰ Schedule apply…
                      </button>
                    )
                  )}
                </div>
              );
            })}
            {canWrite && pending.length > 1 && (
              <div style={{ ...S.actionBtns, marginTop: 10 }}>
                <button style={S.miniBtn} disabled={anyActionApplying} onClick={() => void applyAll()}>
                  {anyActionApplying
                    ? "Applying…"
                    : state?.tokenConfigured
                      ? "Apply reviewed changes"
                      : "Set token first"}
                </button>
              </div>
            )}
          </Section>

          {!!state?.pendingRollbacks?.length && (
            <Section title={`Safety window · ${state.pendingRollbacks.length}`}>
              <Muted>
                These changes auto-revert unless you Keep them — a safety net for changes that might break
                traffic.
              </Muted>
              {state.pendingRollbacks.map((rb: PendingRollback) => {
                const busy = rollbackBusyIds.has(rb.id);
                const keep = async () => {
                  setRollbackBusyIds((prev) => new Set(prev).add(rb.id));
                  const res = await keepAppliedChange(rb.id);
                  if (res && !res.ok) setNotice(res.message);
                  setRollbackBusyIds((prev) => {
                    const next = new Set(prev);
                    next.delete(rb.id);
                    return next;
                  });
                };
                const revert = async () => {
                  setRollbackBusyIds((prev) => new Set(prev).add(rb.id));
                  const res = await revertAppliedChange(rb.id);
                  if (res?.status === "failed") setNotice(res.detail);
                  setRollbackBusyIds((prev) => {
                    const next = new Set(prev);
                    next.delete(rb.id);
                    return next;
                  });
                };
                return (
                  <div key={rb.id} style={S.rollbackCard} className="glide-lift">
                    <div style={S.actionSummary}>{rb.summary}</div>
                    <div style={S.rollbackMeta}>
                      <RollbackCountdown expiresTs={rb.expiresTs} /> · applied by {rb.by}
                    </div>
                    <div style={S.rollbackRevert}>{rb.revertSummary}</div>
                    {canWrite ? (
                      <div style={S.actionBtns}>
                        <button style={S.applyBtn} disabled={busy} onClick={() => void keep()}>
                          {busy ? "…" : "Keep"}
                        </button>
                        <button style={S.rejectBtn} disabled={busy} onClick={() => void revert()}>
                          {busy ? "…" : "Revert now"}
                        </button>
                      </div>
                    ) : (
                      <div style={S.hint}>Read-only — a room member or owner can Keep or revert this.</div>
                    )}
                  </div>
                );
              })}
            </Section>
          )}

          {state?.migrationPlan && (
            <Section title="Migration plan">
              <MigrationPlanPanel plan={state.migrationPlan} />
              <div style={{ ...S.actionBtns, marginTop: 10, flexWrap: "wrap" }}>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("preflight");
                    await runRpc("runPreflight", [state?.defaultZone?.id, name]);
                    setMigBusy(undefined);
                  }}
                >
                  {migBusy === "preflight" ? "Checking…" : "Pre-flight"}
                </button>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("diff");
                    await runRpc("runDiffReport", [state?.defaultZone?.id, name]);
                    setMigBusy(undefined);
                  }}
                >
                  {migBusy === "diff" ? "Diffing…" : "Diff zone"}
                </button>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("validate");
                    await runRpc("runValidate", [state?.defaultZone?.id, name]);
                    setMigBusy(undefined);
                  }}
                  title="Confirm the planned rules are present in the target zone (presence check)"
                >
                  {migBusy === "validate" ? "Verifying…" : "Verify"}
                </button>
                <button
                  style={S.miniBtn}
                  disabled={!!migBusy}
                  onClick={async () => {
                    setMigBusy("csv");
                    await runRpc("exportMigrationCsv", [name]);
                    setMigBusy(undefined);
                  }}
                >
                  {migBusy === "csv" ? "Exporting…" : "Export CSV"}
                </button>
              </div>
              {state.migrationCheck && (
                <div
                  style={{
                    ...S.checkBox,
                    borderColor: state.migrationCheck.ok ? "#14532d" : "#7c2d12",
                    background: state.migrationCheck.ok ? "#052e16" : "#422006",
                    color: state.migrationCheck.ok ? "#86efac" : "#fed7aa",
                  }}
                >
                  <b>
                    {state.migrationCheck.kind === "preflight"
                      ? "Pre-flight"
                      : state.migrationCheck.kind === "diff"
                        ? "Diff"
                        : "Verify"}
                    :
                  </b>{" "}
                  {state.migrationCheck.summary}
                  <MigrationCheckMeta
                    check={state.migrationCheck}
                    plan={state.migrationPlan}
                    defaultAccountId={state.defaultAccountId}
                    defaultZoneId={state.defaultZone?.id}
                  />
                </div>
              )}
            </Section>
          )}

          {state?.csv && state.csv.files.length > 0 && (
            <Section title={`CSV export · ${state.csv.files.length}`}>
              <MigrationArtifactMeta
                artifact={state.csv}
                plan={state.migrationPlan}
                defaultAccountId={state.defaultAccountId}
                defaultZoneId={state.defaultZone?.id}
                targetless
              />
              {state.csv.files.map((f) => (
                <div key={f.filename} style={S.tfRow}>
                  <code style={S.tfName}>{f.filename}</code>
                  <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                    Download
                  </button>
                </div>
              ))}
            </Section>
          )}

          {state?.terraform && state.terraform.files.length > 0 && (
            <Section title={`Terraform export · ${state.terraform.files.length}`}>
              <MigrationArtifactMeta
                artifact={state.terraform}
                plan={state.migrationPlan}
                defaultAccountId={state.defaultAccountId}
                defaultZoneId={state.defaultZone?.id}
              />
              {state.terraform.files.map((f) => (
                <div key={f.filename} style={S.tfRow}>
                  <code style={S.tfName}>{f.filename}</code>
                  <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                    Download
                  </button>
                </div>
              ))}
              {state.terraform.files.length > 1 && (
                <button
                  style={{ ...S.miniBtn, marginTop: 8 }}
                  onClick={() =>
                    downloadText(
                      `${state!.terraform!.provider}-cloudflare.tf`,
                      state!.terraform!.files.map((f) => `# ${f.filename}\n${f.content}`).join("\n\n"),
                    )
                  }
                >
                  Download all (.tf)
                </button>
              )}
            </Section>
          )}

          {myRole === "owner" && (
            <Section title="Change controls">
              <label
                style={S.autoRevertRow}
                title="Require two distinct members to approve destructive or traffic-affecting changes before they apply."
              >
                <input
                  type="checkbox"
                  checked={state?.fourEyes?.enabled === true}
                  onChange={(e) => void setFourEyes(e.target.checked)}
                />
                <span>Require two approvals for risky changes (four-eyes)</span>
              </label>
              <p style={S.hint}>
                When on, destructive or traffic-affecting changes (resource deletions, firewall/WAF rules,
                TLS settings) need a second room member to approve before they apply. Routine changes still
                apply with one click.
                {state?.fourEyes?.enabled && members.filter((m) => m.role !== "viewer").length < 2
                  ? " This room has fewer than two members who can approve — invite a teammate."
                  : ""}
              </p>
              <div style={S.kvKeyStandalone}>Notifications webhook</div>
              {state?.notifyWebhook?.configured ? (
                <>
                  <p style={S.hint}>
                    Sending governance events to <strong>{state.notifyWebhook.host ?? "your webhook"}</strong>
                    {state.notifyWebhook.by ? ` · set by ${state.notifyWebhook.by}` : ""}.
                  </p>
                  <div style={S.actionBtns}>
                    <button style={S.miniBtn} onClick={() => void testNotifyWebhook()}>
                      Send test
                    </button>
                    <button style={S.rejectBtn} onClick={() => void setNotifyWebhook("")}>
                      Remove
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={S.hint}>
                    POST governance events (changes applied/failed, approvals, auto-reverts, drift) to a Slack or
                    generic https webhook. The URL is stored encrypted and never shown again.
                  </p>
                  <input
                    type="url"
                    value={webhookInput}
                    onChange={(e) => setWebhookInput(e.target.value)}
                    placeholder="https://hooks.slack.com/services/…"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...S.input, marginBottom: 8 }}
                  />
                  <button
                    style={S.miniBtn}
                    disabled={!webhookInput.trim()}
                    onClick={async () => {
                      const res = await setNotifyWebhook(webhookInput.trim());
                      if (res?.ok) setWebhookInput("");
                    }}
                  >
                    Save webhook
                  </button>
                </>
              )}
            </Section>
          )}

          <Section title={`Room members · ${members.length}`}>
            {members.map((member) => (
              <div key={member.email} style={S.inviteItem}>
                <span style={{ fontSize: 13, wordBreak: "break-all" }}>{member.email}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  {myRole === "owner" && member.role !== "owner" ? (
                    <select
                      value={member.role}
                      aria-label={`Role for ${member.email}`}
                      style={S.roleSelect}
                      onChange={(e) => void setRole(member.email, e.target.value as "member" | "viewer")}
                    >
                      <option value="member">member</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    <span style={member.role === "viewer" ? S.roleViewerBadge : S.inviteBy}>
                      {member.role}
                    </span>
                  )}
                  {member.email === name && <span style={S.inviteBy}>· you</span>}
                  {myRole === "owner" && member.role !== "owner" && (
                    <button
                      style={{ ...S.miniBtn, color: "#fca5a5" }}
                      onClick={() => void removeMember(member.email)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))}
          </Section>

          <Section
            title={`Invite teammates${(state?.invites?.length ?? 0) ? ` · ${state!.invites.length}` : ""}`}
          >
            {canWrite ? (
              <>
                <div style={S.inviteRow}>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void invite();
                    }}
                    placeholder="name@company.com"
                    autoComplete="off"
                    style={{ ...S.input, marginBottom: 0 }}
                  />
                  {myRole === "owner" && (
                    <select
                      value={inviteRole}
                      aria-label="Invite role"
                      style={S.roleSelect}
                      onChange={(e) => setInviteRole(e.target.value as "member" | "viewer")}
                    >
                      <option value="member">member</option>
                      <option value="viewer">viewer</option>
                    </select>
                  )}
                  <button style={S.miniPrimary} disabled={!inviteEmail.trim()} onClick={() => void invite()}>
                    Invite
                  </button>
                </div>
                <p style={S.hint}>
                  The invitation grants this verified email room membership
                  {myRole === "owner" ? " with the selected role" : " as a member"}. Viewers get read-only
                  access (read + chat + propose, but cannot apply). The recipient must authenticate through
                  Cloudflare Access before the link opens. Send the prefilled email, or copy the link:
                </p>
              </>
            ) : (
              <p style={S.hint}>
                You have read-only (viewer) access, so you can't invite teammates. Ask a room member or owner.
                Share the link if they're already a member:
              </p>
            )}
            <div style={S.linkRow}>
              <code style={S.linkCode}>{roomLink}</code>
              <button style={S.miniBtn} onClick={() => navigator.clipboard?.writeText(roomLink)}>
                Copy
              </button>
            </div>
            {(state?.invites ?? []).map((inv) => (
              <div key={inv.email} style={S.inviteItem}>
                <span style={{ fontSize: 13, wordBreak: "break-all" }}>{inv.email}</span>
                <span style={S.inviteBy}>by {inv.invitedBy}</span>
              </div>
            ))}
          </Section>

          {memory.length > 0 && (
            <Section title="Room memory">
              {memory.map(([k, v]) => (
                <KV key={k} k={k} v={v} />
              ))}
            </Section>
          )}

          {(state?.notifications?.length ?? 0) > 0 && (
            <Section title={`Notifications · ${state!.notifications!.length}`}>
              {state!.notifications!.map((n: GovernanceEvent) => {
                const meta = NOTIFY_META[n.kind] ?? { icon: "•", color: "#64748b" };
                return (
                  <div key={n.id} style={S.resultRow}>
                    <span style={{ ...S.dot, background: meta.color }} />
                    <div style={{ flex: 1 }}>
                      <div style={S.resultSummary}>
                        {meta.icon} {n.title}
                      </div>
                      <div style={S.resultDetail}>{n.detail}</div>
                      <div style={S.listMeta}>{[n.by, n.zone, relTime(n.ts)].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                );
              })}
            </Section>
          )}

          {(state?.recentResults?.length ?? 0) > 0 && (
            <Section title="Recent results">
              {state!.recentResults.map((r) => (
                <div key={`${r.id}-${r.ts}`} style={S.resultRow}>
                  <span style={{ ...S.dot, background: STATUS_COLORS[r.status] }} />
                   <div style={{ flex: 1 }}>
                     <div style={S.resultSummary}>{r.summary}</div>
                     <div style={S.resultDetail}>{r.detail}</div>
                     <div style={S.listMeta}>
                       {r.status} · by {r.by} · {relTime(r.ts)}
                     </div>
                   </div>
                </div>
              ))}
            </Section>
          )}

          {myRole === "owner" && (
            <Section title="Danger zone">
              <p style={S.hint}>
                Permanently delete this room for everyone — chat history, pending approvals, memory,
                business profile, invites, and the stored Cloudflare token. This cannot be undone.
              </p>
              <button
                style={{ ...S.dangerBtn, marginTop: 8 }}
                disabled={!connected}
                onClick={() => void deleteRoom()}
                title={connected ? "Permanently delete this room" : "Reconnect before deleting the room"}
              >
                Delete this room
              </button>
            </Section>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny sidebar building blocks
// ---------------------------------------------------------------------------

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={S.section} className="glide-lift glide-glass-card">
      <div style={S.sectionHead}>
        <h3 style={S.sectionTitle}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={S.kv}>
      <span style={S.kvKey}>{k}</span>
      <span style={S.kvVal}>{v}</span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>{children}</p>;
}

/**
 * Sidebar / admin panel: the running list of Cloudflare docs pages the RAG
 * retriever surfaced while answering this room's questions (`state.docLinks`).
 * A "further reading" list built automatically from the actual conversation.
 * Read-only; links open in a new tab.
 */
function DocLinksPanel({ links }: { links: DocLink[] }) {
  const safeLinks = links.filter((link) => isCloudflareDocsUrl(link.url));
  if (!safeLinks.length) return <Muted>No official Cloudflare documentation referenced yet.</Muted>;

  return (
    <>
      <p style={S.docLinksHint}>
        Pages Glide referenced while answering — a reading list from your conversation.
      </p>
      <ul style={S.docLinkList}>
        {safeLinks.map((d) => (
          <li key={d.url}>
            <a
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              style={S.docLink}
              className="glide-doclink glide-lift"
              title={d.url}
            >
              <span style={S.docLinkTitle}>{d.title}</span>
              {d.product ? <span style={S.docLinkTag}>{d.product}</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Chat-led onboarding opener. Renders a Glide-styled greeting that asks the
 * first branching question with one-tap quick replies; answering hands the
 * conversation to Glide, which keeps asking one question at a time while the
 * sidebar checklist auto-fills. A form remains available as an opt-in.
 */
function GuidedIntro({
  onChoose,
  onUseForm,
}: {
  onChoose: (path: OnboardingPath) => void;
  onUseForm: () => void;
}) {
  return (
    <div style={S.introWrap}>
      <div style={S.introBubble} className="glide-glass-card glide-intro-card">
        <div style={S.msgWho}>Glide</div>
        <div style={S.introTitle}>Set up Cloudflare with Glide.</div>
        <div style={S.introText}>
          I'll guide you one question at a time and tick off the checklist on the right as we go. To start —
          are you <b>migrating from another provider</b>, or <b>starting fresh</b>?
        </div>
        <div style={S.introChoices}>
          <button style={S.introChoice} onClick={() => onChoose("migrate")}>
            Migrating from a provider
          </button>
          <button style={S.introChoice} onClick={() => onChoose("fresh")}>
            Starting fresh
          </button>
        </div>
        <div style={S.introFoot}>
          Prefer clicking through a form?{" "}
          <button style={S.introLink} onClick={onUseForm}>
            Use the guided form
          </button>{" "}
          · or just type your answer below.
        </div>
      </div>
    </div>
  );
}

function OnboardingPanel({
  onboarding,
  onToggle,
}: {
  onboarding: OnboardingState;
  onToggle: (id: string, done: boolean) => void;
}) {
  const complete = onboarding.checklist.filter((s) => s.done || s.na).length;
  const total = onboarding.checklist.length;
  const pct = total ? Math.round((100 * complete) / total) : 0;
  return (
    <>
      {onboarding.path && (
        <KV
          k="path"
          v={`${onboarding.path === "migrate" ? "Migrate" : "Start fresh"}${onboarding.completed ? " · done ✓" : ""}`}
        />
      )}
      {onboarding.domain && <KV k="domain" v={onboarding.domain} />}
      {onboarding.setupType && <KV k="setup" v={setupLabel(onboarding.setupType)} />}
      {(onboarding.migratingFromLabel || onboarding.migratingFrom) && (
        <KV k="from" v={onboarding.migratingFromLabel ?? onboarding.migratingFrom ?? ""} />
      )}
      {onboarding.goals.length > 0 && <KV k="goals" v={onboarding.goals.map(goalLabel).join(", ")} />}
      <div style={S.progressWrap} title={`${complete}/${total} steps`}>
        <div style={{ ...S.progressBar, width: `${pct}%` }} />
      </div>
      <div style={S.checklist}>
        {onboarding.checklist.map((s) => {
          const na = Boolean(s.na) && !s.done;
          return (
            <label key={s.id} style={S.checkItem}>
              <input
                type="checkbox"
                checked={s.done}
                disabled={na}
                onChange={(e) => onToggle(s.id, e.target.checked)}
              />
              <span
                style={{
                  textDecoration: s.done ? "line-through" : "none",
                  color: s.done ? "#6b7280" : na ? "#9aa4b2" : "#e5e7eb",
                }}
              >
                {s.label}
              </span>
              {na && <span style={S.naBadge} title="Not applicable for this zone's current state">N/A</span>}
            </label>
          );
        })}
      </div>
    </>
  );
}

/**
 * Read-only summary of the captured "nature of the business" profile. Shown in
 * the sidebar and admin so the team can see what Glide learned and used to shape
 * its recommendations. Chat is where the profile is captured and recommendations
 * are proposed; this just reflects the synced state.
 */
function BusinessProfilePanel({ profile }: { profile: BusinessProfile }) {
  const tags = (options: Opt[], ids: string[]) =>
    ids.length ? (
      <div style={S.phaseTags}>
        {ids.map((id) => (
          <span key={id} style={S.phaseTag}>
            {optLabel(options, id)}
          </span>
        ))}
      </div>
    ) : null;
  return (
    <>
      {(profile.industryLabel || profile.industry) && (
        <KV k="industry" v={profile.industryLabel ?? optLabel(INDUSTRY_OPTIONS, profile.industry!)} />
      )}
      {profile.audience && <KV k="audience" v={optLabel(AUDIENCE_OPTIONS, profile.audience)} />}
      {profile.trafficProfile && <KV k="traffic" v={optLabel(TRAFFIC_OPTIONS, profile.trafficProfile)} />}
      {profile.hasLogin !== undefined && <KV k="logins" v={profile.hasLogin ? "yes" : "no"} />}
      {profile.hasApi !== undefined && <KV k="API" v={profile.hasApi ? "yes" : "no"} />}
      {profile.appTypes.length > 0 && (
        <>
          <div style={S.kvKeyStandalone}>app</div>
          {tags(APP_TYPE_OPTIONS, profile.appTypes)}
        </>
      )}
      {profile.sensitiveData.length > 0 && (
        <>
          <div style={S.kvKeyStandalone}>sensitive data</div>
          {tags(SENSITIVE_OPTIONS, profile.sensitiveData)}
        </>
      )}
      {profile.compliance.length > 0 && (
        <>
          <div style={S.kvKeyStandalone}>compliance</div>
          {tags(COMPLIANCE_OPTIONS, profile.compliance)}
        </>
      )}
      {profile.concerns.length > 0 && (
        <>
          <div style={S.kvKeyStandalone}>concerns</div>
          {tags(CONCERN_OPTIONS, profile.concerns)}
        </>
      )}
    </>
  );
}

function priColor(pri: Recommendation["priority"]): string {
  return pri === "high" ? "#fb923c" : pri === "medium" ? "#fbbf24" : "#94a3b8";
}

const BLAST_COLORS: Record<BlastRadiusEstimate["level"], string> = {
  low: "#22c55e",
  medium: "#eab308",
  high: "#ef4444",
  unknown: "#6b7280",
};

const GRADE_COLORS: Record<SecurityPostureReport["grade"], string> = {
  A: "#22c55e",
  B: "#84cc16",
  C: "#eab308",
  D: "#fb923c",
  F: "#ef4444",
};

const POSTURE_STATUS_COLORS: Record<SecurityPostureCheckView["status"], string> = {
  pass: "#22c55e",
  warn: "#eab308",
  fail: "#ef4444",
  unknown: "#6b7280",
};

const POSTURE_STATUS_RANK: Record<SecurityPostureCheckView["status"], number> = {
  fail: 0,
  warn: 1,
  pass: 2,
  unknown: 3,
};

/**
 * Live, self-ticking countdown to an auto-rollback safety window's expiry. Kept
 * as its own component so only the countdown re-renders each second, not the
 * whole room. Shows "reverting now…" once the window has closed.
 */
function RollbackCountdown({ expiresTs }: { expiresTs: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => (n + 1) % 60), 1000);
    return () => clearInterval(t);
  }, []);
  const diff = expiresTs - Date.now();
  if (diff <= 0) return <>reverting now…</>;
  const s = Math.floor(diff / 1000);
  return <>auto-reverts in {s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</>;
}

/**
 * Security-posture scorecard panel. Renders the room's graded scorecard (A–F)
 * for its default zone, read from the zone's LIVE Cloudflare configuration by the
 * server. Failing / to-improve checks come first; concrete gaps get a one-click
 * **Queue fix** button (routed through the `queuePostureFix` RPC, which re-reads
 * the zone and rebuilds the call server-side), while checks that need a short
 * setup offer **Ask Glide**. A **Check now / Refresh** button (re)grades on
 * demand. When `onRefresh`/`onQueueFix` are omitted the panel is read-only
 * (used in the /admin dashboard).
 */
function SecurityPosturePanel({
  report,
  zoneId,
  baseline,
  drift,
  driftWatch,
  canWrite,
  onRefresh,
  onQueueFix,
  onAsk,
  onSetBaseline,
  onSetDriftWatch,
}: {
  report?: SecurityPostureReport;
  zoneId?: string;
  baseline?: SecurityPostureReport;
  drift?: PostureDriftView;
  driftWatch?: { enabled: boolean; by?: string; ts: number; lastCheckedTs?: number };
  /** Member-or-owner: gates the baseline/drift-watch config controls (viewers can still read). */
  canWrite?: boolean;
  onRefresh?: () => Promise<{ ok: boolean; message: string } | undefined>;
  onQueueFix?: (checkId: string) => Promise<{ ok: boolean; message: string; id?: string } | undefined>;
  onAsk?: (ask: string) => void;
  onSetBaseline?: () => Promise<{ ok: boolean; message: string } | undefined>;
  onSetDriftWatch?: (enabled: boolean) => Promise<{ ok: boolean; message: string; enabled: boolean } | undefined>;
}) {
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const readOnly = !onRefresh;

  const refresh = async () => {
    if (!onRefresh) return;
    setBusy("__refresh");
    setMsg(undefined);
    const res = await onRefresh();
    setBusy(undefined);
    if (res && !res.ok) setMsg(res.message);
  };

  const queueFix = async (checkId: string) => {
    if (!onQueueFix) return;
    setBusy(checkId);
    setMsg(undefined);
    const res = await onQueueFix(checkId);
    setBusy(undefined);
    if (res && !res.ok) setMsg(res.message);
  };

  const setBaseline = async () => {
    if (!onSetBaseline) return;
    setBusy("__baseline");
    setMsg(undefined);
    const res = await onSetBaseline();
    setBusy(undefined);
    if (res) setMsg(res.message);
  };

  const toggleWatch = async () => {
    if (!onSetDriftWatch) return;
    setBusy("__watch");
    setMsg(undefined);
    const res = await onSetDriftWatch(!driftWatch?.enabled);
    setBusy(undefined);
    if (res && !res.ok) setMsg(res.message);
  };

  if (!report) {
    return (
      <>
        <Muted>
          Grade this zone's live security configuration (SSL/TLS, HSTS, WAF, DNSSEC, proxy coverage) into an
          A–F scorecard with one-click fixes.
        </Muted>
        {!readOnly &&
          (zoneId ? (
            <button style={{ ...S.recQueueBtn, marginTop: 10 }} disabled={busy === "__refresh"} onClick={() => void refresh()}>
              {busy === "__refresh" ? "Checking…" : "Check now"}
            </button>
          ) : (
            <div style={S.recNote}>Set a target zone first (ask Glide to find your zone) to grade it.</div>
          ))}
        {msg && <div style={S.recMsg}>{msg}</div>}
      </>
    );
  }

  const checks = [...report.checks].sort(
    (a, b) => POSTURE_STATUS_RANK[a.status] - POSTURE_STATUS_RANK[b.status],
  );

  return (
    <>
      <div style={S.postureHead}>
        <span style={{ ...S.postureGrade, color: GRADE_COLORS[report.grade], borderColor: GRADE_COLORS[report.grade] }}>
          {report.grade}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{report.score}/100</div>
          <div style={S.listMeta}>
            {report.tally.pass} pass · {report.tally.warn} improve · {report.tally.fail} fail
            {report.tally.unknown ? ` · ${report.tally.unknown} n/a` : ""}
          </div>
          <div style={S.listMeta}>
            checked {relTime(report.ts)}
            {report.by ? ` · by ${report.by}` : ""}
          </div>
        </div>
        {!readOnly && (
          <button style={S.miniBtn} disabled={busy === "__refresh"} onClick={() => void refresh()} title="Re-grade the live zone">
            {busy === "__refresh" ? "…" : "Refresh"}
          </button>
        )}
      </div>
      {!readOnly && canWrite && (onSetBaseline || onSetDriftWatch) && (
        <div style={S.driftControls}>
          {onSetBaseline && (
            <button
              style={{ ...S.miniBtn, ...(!zoneId || busy === "__baseline" ? S.recBtnDisabled : null) }}
              disabled={!zoneId || busy === "__baseline"}
              onClick={() => void setBaseline()}
              title="Bless the zone's current live configuration as the known-good baseline to watch for drift against"
            >
              {busy === "__baseline" ? "Setting…" : baseline ? "Reset baseline" : "Set baseline"}
            </button>
          )}
          {onSetDriftWatch && (
            <button
              style={{
                ...S.miniBtn,
                ...(driftWatch?.enabled ? S.driftWatchOn : null),
                ...(!zoneId || busy === "__watch" ? S.recBtnDisabled : null),
              }}
              disabled={!zoneId || busy === "__watch"}
              onClick={() => void toggleWatch()}
              title="Re-check this zone's posture about every 7 days and flag any drift from the baseline"
            >
              {busy === "__watch" ? "…" : driftWatch?.enabled ? "Watching weekly ✓" : "Watch weekly"}
            </button>
          )}
        </div>
      )}
      {baseline && (
        <div style={S.postureBaselineMeta}>
          Baseline grade {baseline.grade} ({baseline.score}/100) · set {relTime(baseline.ts)}
          {driftWatch?.enabled && driftWatch.lastCheckedTs ? ` · last watch ${relTime(driftWatch.lastCheckedTs)}` : ""}
        </div>
      )}
      {drift?.drifted && (
        <div style={S.driftBanner}>
          <div style={S.driftBannerHead}>⚠ Drift from baseline — {drift.summary}</div>
          {drift.regressions.map((d) => (
            <div key={d.id} style={S.driftRow}>
              <span style={S.driftText}>
                [{d.area}] {d.title}: {d.from} → <b>{d.to}</b>
              </span>
              {!readOnly && d.queueable && (
                <button
                  style={{ ...S.recQueueBtn, ...(!zoneId || busy === d.id ? S.recBtnDisabled : null) }}
                  disabled={!zoneId || busy === d.id}
                  onClick={() => void queueFix(d.id)}
                  title="Queue the fix to restore this check to the baseline"
                >
                  {busy === d.id ? "Queuing…" : "Queue fix"}
                </button>
              )}
            </div>
          ))}
          {drift.improvements.length > 0 && (
            <div style={S.driftImproved}>
              {drift.improvements.length} check{drift.improvements.length === 1 ? "" : "s"} recovered since the baseline.
            </div>
          )}
        </div>
      )}
      {msg && <div style={S.recMsg}>{msg}</div>}
      {checks.map((c) => (
        <div key={c.id} style={S.recRow} className="glide-lift">
          <div style={S.recTitleRow}>
            <span style={{ ...S.recDot, background: POSTURE_STATUS_COLORS[c.status] }} />
            <span style={S.recTitle}>{c.title}</span>
          </div>
          <div style={S.recMeta}>
            {c.area} · {c.status}
          </div>
          <div style={S.recWhy}>{c.detail}</div>
          <div style={S.recActionRow}>
            {c.status === "pass" ? (
              <span style={S.recApplied}>Pass ✓</span>
            ) : c.status === "unknown" ? (
              <span style={S.recProposal}>not readable</span>
            ) : readOnly ? (
              <span style={S.recProposal}>{c.queueable ? "one-click in the room" : "Glide-guided"}</span>
            ) : c.queueable ? (
              <button
                style={{ ...S.recQueueBtn, ...(!zoneId || busy === c.id ? S.recBtnDisabled : null) }}
                disabled={!zoneId || busy === c.id}
                onClick={() => void queueFix(c.id)}
                title={zoneId ? "Queue this fix for a human to Apply" : "Set a target zone first"}
              >
                {busy === c.id ? "Queuing…" : "Queue fix"}
              </button>
            ) : c.ask ? (
              <button style={S.recAskBtn} onClick={() => onAsk?.(c.ask!)} title="Have Glide set this up in chat">
                Ask Glide
              </button>
            ) : null}
            {c.reviewRequired && c.queueable && (c.status === "fail" || c.status === "warn") && (
              <span style={S.recFlag} title="Review the queued change before you Apply it">
                review
              </span>
            )}
            {c.doc && (
              <a href={c.doc} target="_blank" rel="noreferrer" style={S.recDoc}>
                Docs ↗
              </a>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Tailored-recommendations panel. Runs the (pure, client-safe) recommendation
 * engine against the room's synced business profile and renders the results
 * grouped by priority. Concrete zone-setting / cf_write items get a one-click
 * **Queue** button (routed through the `queueRecommendation` RPC, which rebuilds
 * the call server-side); everything else offers **Ask Glide**, which hands the
 * setup to chat so the model can do the required discovery first. Items already
 * queued or applied are shown as such. When `onQueue` is omitted the panel is
 * read-only (used in the /admin dashboard).
 */
function RecommendationsPanel({
  profile,
  goals,
  setupType,
  zoneId,
  pending,
  results,
  onQueue,
  onAsk,
}: {
  profile: BusinessProfile;
  goals?: string[];
  setupType?: SetupType;
  zoneId?: string;
  pending: PendingAction[];
  results: ActionResult[];
  onQueue?: (recId: string) => Promise<{ ok: boolean; message: string; id?: string } | undefined>;
  onAsk?: (rec: Recommendation) => void;
}) {
  const set = useMemo(
    () => recommendConfigurations(profile, { goals, setupType }),
    [profile, goals, setupType],
  );
  const [busyId, setBusyId] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const readOnly = !onQueue;

  const statusOf = (rec: Recommendation): "applied" | "queued" | "open" => {
    const target = zoneId ? recommendationToPending(rec, zoneId) : null;
    if (target) {
      if (results.some((r) => r.status === "applied" && r.summary === target.summary)) return "applied";
      if (pending.some((p) => p.method === target.method && p.path === target.path)) return "queued";
    }
    return "open";
  };

  const handleQueue = async (rec: Recommendation) => {
    if (!onQueue) return;
    setBusyId(rec.id);
    setMsg(undefined);
    const res = await onQueue(rec.id);
    setBusyId(undefined);
    if (res && !res.ok) setMsg(res.message);
  };

  const order: Array<Recommendation["priority"]> = ["high", "medium", "low"];
  return (
    <>
      <Muted>
        Tailored to your business profile — each is a proposal Glide queues for you to Apply, never an automatic
        change.
      </Muted>
      {!readOnly && !zoneId && (
        <div style={S.recNote}>Set a target zone (ask Glide to find your zone) to one-click queue these.</div>
      )}
      {msg && <div style={S.recMsg}>{msg}</div>}
      {order.map((pri) => {
        const items = set.recommendations.filter((r) => r.priority === pri);
        if (!items.length) return null;
        return (
          <div key={pri} style={{ marginTop: 10 }}>
            <div style={S.recGroupLabel}>
              {pri} priority · {items.length}
            </div>
            {items.map((rec) => {
              const st = statusOf(rec);
              const queueable = isRecommendationQueueable(rec);
              return (
                <div key={rec.id} style={S.recRow} className="glide-lift">
                  <div style={S.recTitleRow}>
                    <span style={{ ...S.recDot, background: priColor(pri) }} />
                    <span style={S.recTitle}>{rec.title}</span>
                  </div>
                  <div style={S.recMeta}>
                    {rec.product} · {rec.category}
                  </div>
                  <div style={S.recWhy}>{rec.rationale}</div>
                  <div style={S.recActionRow}>
                    {st === "applied" ? (
                      <span style={S.recApplied}>Applied ✓</span>
                    ) : st === "queued" ? (
                      <span style={S.recQueued}>Queued ✓</span>
                    ) : readOnly ? (
                      <span style={S.recProposal}>{queueable ? "one-click in the room" : "Glide-guided"}</span>
                    ) : queueable ? (
                      <button
                        style={{ ...S.recQueueBtn, ...(!zoneId || busyId === rec.id ? S.recBtnDisabled : null) }}
                        disabled={!zoneId || busyId === rec.id}
                        onClick={() => void handleQueue(rec)}
                        title={zoneId ? "Queue this change for a human to Apply" : "Set a target zone first"}
                      >
                        {busyId === rec.id ? "Queuing…" : "Queue"}
                      </button>
                    ) : (
                      <button style={S.recAskBtn} onClick={() => onAsk?.(rec)} title="Have Glide set this up in chat">
                        Ask Glide
                      </button>
                    )}
                    {rec.action.reviewRequired && queueable && st === "open" && (
                      <span style={S.recFlag} title="Review the queued change before you Apply it">
                        review
                      </span>
                    )}
                    {rec.docs[0] && (
                      <a href={rec.docs[0]} target="_blank" rel="noreferrer" style={S.recDoc}>
                        Docs ↗
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function MigrationPlanPanel({ plan }: { plan: MigrationPlan }) {
  const queued = plan.rules.filter((r) => r.queued).length;
  const retainedByPhase = new Map<string, number>();
  for (const rule of plan.rules) retainedByPhase.set(rule.phase, (retainedByPhase.get(rule.phase) ?? 0) + 1);
  return (
    <>
      <KV k="provider" v={plan.providerLabel} />
      <KV
        k="rules"
        v={`${plan.totalRules} total${plan.truncated ? ` · ${plan.rules.length} retained` : ""} · ${queued} queued`}
      />
      <div style={S.phaseTags}>
        {plan.phases.map((ph) => (
          <span key={ph.key} style={S.phaseTag}>
            {ph.label}: {plan.truncated ? `${retainedByPhase.get(ph.key) ?? 0} retained of ${ph.count}` : ph.count}
          </span>
        ))}
      </div>
    </>
  );
}

function shortRevision(value: string | undefined): string {
  if (!value) return "unknown source";
  return value.startsWith("sha256:") ? `SHA-256 ${value.slice(7, 19)}...` : `revision ${value.slice(0, 12)}...`;
}

function MigrationArtifactMeta({
  artifact,
  plan,
  defaultAccountId,
  defaultZoneId,
  targetless = false,
}: {
  artifact: TerraformArtifact;
  plan?: MigrationPlan;
  defaultAccountId?: string;
  defaultZoneId?: string;
  targetless?: boolean;
}) {
  const staleSource = Boolean(artifact.sourceRevision && plan?.sourceRevision && artifact.sourceRevision !== plan.sourceRevision);
  const sameId = (left: string | undefined, right: string | undefined) =>
    Boolean(left && right && left.toLowerCase() === right.toLowerCase());
  const targetScope = artifact.targetScope ?? (artifact.zoneId ? "zone" : "account");
  const staleTarget = !targetless && Boolean(
    (defaultAccountId && !sameId(artifact.accountId, defaultAccountId)) ||
    (targetScope === "zone" && defaultZoneId && !sameId(artifact.zoneId, defaultZoneId)),
  );
  const target = artifact.zoneName || artifact.zoneId;
  const targetText = targetScope === "zone"
    ? target
      ? ` · zone ${target}`
      : " · placeholder zone"
    : "";
  return (
    <div style={{ ...S.hint, color: staleSource || staleTarget ? "#fbbf24" : S.hint.color }}>
      {artifact.provider} · {shortRevision(artifact.sourceRevision)}
      {!targetless ? targetText : ""}
      {!targetless && artifact.accountId ? ` · account ${artifact.accountId.slice(0, 8)}...` : ""}
      {!targetless && !artifact.accountId ? " · placeholder account" : ""}
      {staleSource ? " · stale source" : ""}
      {staleTarget ? " · stale target" : ""}
    </div>
  );
}

function MigrationCheckMeta({
  check,
  plan,
  defaultAccountId,
  defaultZoneId,
}: {
  check: NonNullable<GlideState["migrationCheck"]>;
  plan?: MigrationPlan;
  defaultAccountId?: string;
  defaultZoneId?: string;
}) {
  const stale = Boolean(
    (check.sourceRevision && plan?.sourceRevision && check.sourceRevision !== plan.sourceRevision) ||
    (check.accountId && defaultAccountId && check.accountId.toLowerCase() !== defaultAccountId.toLowerCase()) ||
    (check.zoneId && defaultZoneId && check.zoneId.toLowerCase() !== defaultZoneId.toLowerCase()),
  );
  return (
    <div style={{ marginTop: 4, fontSize: 11, opacity: 0.85 }}>
      {check.provider ?? "legacy check"} · {shortRevision(check.sourceRevision)}
      {check.accountId ? ` · account ${check.accountId.slice(0, 8)}...` : ""}
      {check.zoneId ? ` · zone ${check.zoneId}` : ""}
      {stale ? " · stale result" : ""}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding wizard — a guided, branching setup flow.
// ---------------------------------------------------------------------------

interface WizardRpcResult {
  ok: boolean;
  message?: string;
}

interface WizardProps {
  onboarding?: OnboardingState;
  businessProfile?: BusinessProfile;
  tokenConfigured: boolean;
  migrationToolConfigured?: boolean;
  migrationPlan?: MigrationPlan;
  onPatch: (patch: Record<string, unknown>) => Promise<WizardRpcResult | undefined>;
  onProfile: (patch: Partial<BusinessProfile>) => Promise<WizardRpcResult | undefined>;
  onPreview: (args: {
    provider: string;
    config?: string;
    configFiles?: Array<{ filename: string; content: string }>;
    format?: string;
  }) => Promise<{ ok: boolean; message: string; totalRules?: number } | undefined>;
  onSaveToken: (token: string) => Promise<{ ok: boolean; message: string } | undefined>;
  onFinish: (kickoff: string) => void;
  onDismiss: () => void;
}

const WIZARD_COPY: Record<string, { title: string; why: string }> = {
  branch: {
    title: "How are you setting up Cloudflare?",
    why: "This tailors every step. Migrating pulls your existing WAF/CDN/DNS config into Cloudflare equivalents; starting fresh sets you up cleanly from scratch.",
  },
  provider: {
    title: "Which provider are you migrating from?",
    why: "We translate that provider's rules into Cloudflare's — read-only, so nothing changes until you approve it.",
  },
  scope: {
    title: "What do you want to bring over?",
    why: "We'll focus the plan on what you pick and skip the rest. You can always add more later.",
  },
  scopeFresh: {
    title: "What do you want to set up?",
    why: "Pick the products to configure first. Glide will queue each change for you to review and Apply.",
  },
  domain: {
    title: "What's your domain?",
    why: "Used to find or onboard your zone and to target rules. When you add a site, Cloudflare scans your existing DNS records so you can review them before cutover.",
  },
  config: {
    title: "Share your provider config",
    why: "We parse it read-only and show exactly what will move to Cloudflare. Upload or paste an export — JSON, XML, Terraform, and PAN-OS are supported. You can skip and do this later.",
  },
  setup: {
    title: "Choose your DNS setup",
    why: "Full setup makes Cloudflare your authoritative DNS (recommended, required on Free/Pro). Partial (CNAME) keeps your current DNS and proxies select subdomains (Business/Enterprise).",
  },
  profile: {
    title: "Tell Glide about your business",
    why: "This is optional but powerful: it lets Glide recommend the performance & security settings that actually fit you — e.g. PCI-aware TLS for payments, rate limits for logins, caching for a global audience. You can also just answer these in chat.",
  },
  token: {
    title: "Connect a Cloudflare API token",
    why: "Needed to read your account and to Apply queued changes. It's stored AES-256-GCM encrypted at rest and never shown again. You can skip for now and add it later.",
  },
  review: {
    title: "You're all set",
    why: "Here's what we captured. Finishing hands off to Glide in chat, which will continue with this context — proposing changes you approve before anything goes live.",
  },
};

function ChoiceCard({
  selected,
  title,
  desc,
  onClick,
}: {
  selected: boolean;
  title: string;
  desc?: string;
  onClick: () => void;
}) {
  return (
    <button style={{ ...S.choiceCard, ...(selected ? S.choiceCardOn : null) }} onClick={onClick} className="glide-lift">
      <span style={S.choiceTitle}>{title}</span>
      {desc && <span style={S.choiceDesc}>{desc}</span>}
    </button>
  );
}

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button style={{ ...S.chip, ...(on ? S.chipOn : null) }} onClick={onClick}>
      {on ? "✓ " : ""}
      {label}
    </button>
  );
}

function OnboardingWizard({
  onboarding,
  businessProfile,
  tokenConfigured,
  migrationToolConfigured,
  migrationPlan,
  onPatch,
  onProfile,
  onPreview,
  onSaveToken,
  onFinish,
  onDismiss,
}: WizardProps) {
  const [path, setPath] = useState<OnboardingPath | undefined>(onboarding?.path);
  const [providerKey, setProviderKey] = useState(onboarding?.migratingFrom ?? "");
  const [goals, setGoals] = useState<string[]>(onboarding?.goals ?? []);
  const [domain, setDomain] = useState(onboarding?.domain ?? "");
  const [setupType, setSetupType] = useState<SetupType | undefined>(onboarding?.setupType);
  // Optional business-profile answers (drive Glide's tailored recommendations).
  const [industry, setIndustry] = useState<string | undefined>(businessProfile?.industry);
  const [appTypes, setAppTypes] = useState<string[]>(businessProfile?.appTypes ?? []);
  const [audience, setAudience] = useState<string | undefined>(businessProfile?.audience);
  const [trafficProfile, setTrafficProfile] = useState<string | undefined>(businessProfile?.trafficProfile);
  const [hasLogin, setHasLogin] = useState<boolean | undefined>(businessProfile?.hasLogin);
  const [hasApi, setHasApi] = useState<boolean | undefined>(businessProfile?.hasApi);
  const [sensitiveData, setSensitiveData] = useState<string[]>(businessProfile?.sensitiveData ?? []);
  const [compliance, setCompliance] = useState<string[]>(businessProfile?.compliance ?? []);
  const [concerns, setConcerns] = useState<string[]>(businessProfile?.concerns ?? []);
  const [configText, setConfigText] = useState("");
  const [configFiles, setConfigFiles] = useState<Array<{ filename: string; content: string }>>([]);
  const [fileLabel, setFileLabel] = useState<string>();
  const [configFormat, setConfigFormat] = useState<string>("auto");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileReadVersion = useRef(0);
  const [tokenInput, setTokenInput] = useState("");
  const [step, setStep] = useState(onboarding?.path ? 1 : 0);
  const [busy, setBusy] = useState(false);
  const [previewMsg, setPreviewMsg] = useState<string>();
  const [tokenMsg, setTokenMsg] = useState<string>();
  const [saveMsg, setSaveMsg] = useState<string>();

  const stepKeys = useMemo(() => {
    if (!path) return ["branch"];
    if (path === "migrate") {
      const keys = ["branch", "provider", "scope", "domain", "config", "profile"];
      if (!tokenConfigured) keys.push("token");
      keys.push("review");
      return keys;
    }
    const keys = ["branch", "scope", "domain", "setup", "profile"];
    if (!tokenConfigured) keys.push("token");
    keys.push("review");
    return keys;
  }, [path, tokenConfigured]);

  const idx = Math.min(step, stepKeys.length - 1);
  const key = stepKeys[idx];
  const pct = Math.round((100 * idx) / Math.max(1, stepKeys.length - 1));
  const copy = key === "scope" && path === "fresh" ? WIZARD_COPY.scopeFresh : WIZARD_COPY[key];
  const goalSet = path === "migrate" ? MIGRATE_GOALS : FRESH_GOALS;

  const valid = (): boolean => {
    switch (key) {
      case "branch":
        return !!path;
      case "provider":
        return !!providerKey;
      case "scope":
        return goals.length > 0;
      case "domain":
        return domain.trim().length > 0;
      case "setup":
        return !!setupType;
      default:
        return true;
    }
  };

  const choosePath = async (p: OnboardingPath) => {
    if (busy) return;
    setBusy(true);
    setSaveMsg(undefined);
    const result = await onPatch({ path: p });
    setBusy(false);
    if (!result?.ok) {
      setSaveMsg(result?.message ?? "Glide could not save that choice. Reconnect and try again.");
      return;
    }
    setPath(p);
    setStep(1);
  };

  const toggleGoal = (id: string) =>
    setGoals((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  const toggleIn = (setter: React.Dispatch<React.SetStateAction<string[]>>, id: string) =>
    setter((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const clearFiles = () => {
    fileReadVersion.current += 1;
    setConfigFiles([]);
    setConfigText("");
    setFileLabel(undefined);
    setConfigFormat("auto");
    setPreviewMsg(undefined);
  };

  const handleFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    const readVersion = ++fileReadVersion.current;
    const offered = Array.from(list);
    const allTf = offered.every((f) => /\.(tf|tfvars|hcl)$/i.test(f.name));
    const selected = offered.length > 1 && allTf ? offered : offered.slice(0, 1);
    const filenameBytes = selected.map((file) => new TextEncoder().encode(file.name).byteLength);
    const totalBytes = selected.reduce((sum, file, index) => sum + file.size + filenameBytes[index], 0);
    const filenameTooLong = filenameBytes.some((bytes) => bytes > MAX_CONFIG_FILENAME_BYTES);
    if (selected.length > MAX_CONFIG_FILES || filenameTooLong || totalBytes > MAX_CONFIG_BYTES) {
      clearFiles();
      setPreviewMsg(
        selected.length > MAX_CONFIG_FILES
          ? `Choose at most ${MAX_CONFIG_FILES} Terraform files.`
          : filenameTooLong
            ? `Each config filename must be at most ${MAX_CONFIG_FILENAME_BYTES} bytes.`
          : `Config files must total at most ${MAX_CONFIG_BYTES} bytes.`,
      );
      return;
    }
    let read: Array<{ filename: string; content: string }>;
    try {
      read = await Promise.all(selected.map(async (f) => ({ filename: f.name, content: await f.text() })));
    } catch {
      if (readVersion === fileReadVersion.current) {
        clearFiles();
        setPreviewMsg("That config file could not be read. Choose it again or paste the contents.");
      }
      return;
    }
    if (readVersion !== fileReadVersion.current) return;
    if (read.length > 1 && allTf) {
      // A whole Terraform directory — the tool merges them.
      setConfigFiles(read);
      setConfigText("");
      setConfigFormat("terraform");
      setFileLabel(`${read.length} Terraform files`);
    } else {
      const f = read[0];
      setConfigFiles([]);
      setConfigText(f.content);
      setConfigFormat(formatFromName(f.filename));
      setFileLabel(
        offered.length > 1
          ? `${f.filename} (+${offered.length - 1} ignored — only multiple .tf files are merged)`
          : f.filename,
      );
    }
    setPreviewMsg(undefined);
  };

  const advance = () => {
    setSaveMsg(undefined);
    setStep((s) => Math.min(s + 1, stepKeys.length - 1));
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const commitAndNext = async () => {
    if (busy) return;
    setSaveMsg(undefined);
    let saved: WizardRpcResult | undefined;
    if (["provider", "scope", "domain", "setup", "profile"].includes(key)) setBusy(true);
    if (key === "provider") saved = await onPatch({ migratingFrom: providerKey });
    else if (key === "scope") saved = await onPatch({ goals });
    else if (key === "domain") saved = await onPatch({ domain: domain.trim() });
    else if (key === "setup") saved = await onPatch({ setupType });
    else if (key === "profile")
      saved = await onProfile({
        industry,
        appTypes,
        audience: audience as BusinessProfile["audience"],
        trafficProfile: trafficProfile as BusinessProfile["trafficProfile"],
        hasLogin,
        hasApi,
        sensitiveData,
        compliance,
        concerns,
      });
    else if (key === "config") {
      const hasConfig = !!(configText.trim() || configFiles.length);
      if (hasConfig && providerKey) {
        if (!migrationToolConfigured) {
          setPreviewMsg(
            "Migration import isn't configured here. Ask a workspace admin to configure it, or continue with DNS-first setup.",
          );
        } else {
          setBusy(true);
          setPreviewMsg("Parsing your config (read-only)…");
          const res = await onPreview({
            provider: providerKey,
            config: configText.trim() || undefined,
            configFiles: configFiles.length ? configFiles : undefined,
            format: configFormat,
          });
          setBusy(false);
          if (res?.ok) {
            setPreviewMsg(`Parsed ${res.totalRules ?? 0} item(s). ${res.message}`);
          } else {
            setPreviewMsg(res?.message ?? "Preview failed — fix the config or skip for now.");
            return; // stay so the user can correct it
          }
        }
      }
    }
    if (["provider", "scope", "domain", "setup", "profile"].includes(key)) {
      setBusy(false);
      if (!saved?.ok) {
        setSaveMsg(saved?.message ?? "Glide could not save this step. Reconnect and try again.");
        return;
      }
    }
    advance();
  };

  const saveTokenInline = async () => {
    if (!tokenInput.trim() || busy) return;
    setBusy(true);
    const res = await onSaveToken(tokenInput.trim());
    setBusy(false);
    if (res?.ok) setTokenInput("");
    setTokenMsg(res?.message);
  };

  const finish = () => {
    let kickoff: string;
    const goalsTxt = goals.map(goalLabel).join(", ");
    if (path === "migrate") {
      const prov = PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? "my current provider";
      const previewed = Boolean(onboarding?.configProvided && migrationPlan?.provider === providerKey);
      kickoff =
        `I'm migrating from ${prov} to Cloudflare for ${domain || "my domain"}. ` +
        `I want to migrate: ${goalsTxt || "my configuration"}. DNS setup: ${setupLabel(setupType)}. ` +
        (previewed
          ? "I've previewed my config — please summarize the plan, then queue the supported rules (ask me for the zone id if you need it) and offer a Terraform export."
          : "Help me export my provider config and build the migration plan.");
    } else {
      kickoff =
        `I'm setting up ${domain || "my domain"} fresh on Cloudflare with a ${setupLabel(setupType)} DNS setup. ` +
        `I want to set up: ${goalsTxt || "the basics"}. Walk me through it step by step and queue changes for me to Apply.`;
    }
    const profileFilled = Boolean(
      industry ||
        appTypes.length ||
        audience ||
        trafficProfile ||
        hasLogin ||
        hasApi ||
        sensitiveData.length ||
        compliance.length ||
        concerns.length,
    );
    if (profileFilled) {
      kickoff +=
        " I've shared details about our business — please recommend the Cloudflare performance and security settings that fit us and offer to queue the important ones.";
    }
    onFinish(kickoff);
  };

  const summaryChips: Array<{ k: string; v: string }> = [];
  if (path) summaryChips.push({ k: "path", v: path === "migrate" ? "Migrate" : "Start fresh" });
  if (providerKey) summaryChips.push({ k: "from", v: PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? providerKey });
  if (goals.length) summaryChips.push({ k: "scope", v: `${goals.length} selected` });
  if (domain.trim()) summaryChips.push({ k: "domain", v: domain.trim() });
  if (setupType) summaryChips.push({ k: "DNS", v: setupLabel(setupType) });
  if (industry) summaryChips.push({ k: "industry", v: optLabel(INDUSTRY_OPTIONS, industry) });
  if (tokenConfigured) summaryChips.push({ k: "token", v: "connected ✓" });

  return (
    <div style={S.wizWrap}>
      <div style={S.wizCard} className="glide-glass glide-wizard-card">
        <div style={S.wizHead}>
          <div>
            <div style={S.wizBrand}>Guided setup</div>
            <div style={S.wizStepMeta}>
              Step {idx + 1} of {stepKeys.length}
            </div>
          </div>
          <button style={S.wizSkip} onClick={onDismiss}>
            Hide setup ↓
          </button>
        </div>
        <div style={S.wizProgress}>
          <div style={{ ...S.wizProgressBar, width: `${pct}%` }} />
        </div>

        <h2 style={S.wizTitle}>{copy?.title}</h2>
        <div style={S.wizWhy}>
          <span style={S.wizWhyIcon}>ℹ</span>
          <span>{copy?.why}</span>
        </div>

        <div style={S.wizBody}>
          {key === "branch" && (
            <div style={S.choiceGrid}>
              <ChoiceCard
                selected={path === "migrate"}
                title="Migrate from another provider"
                desc="Akamai, Fastly, Imperva, Zscaler, Prisma Access, and more → Cloudflare."
                onClick={() => void choosePath("migrate")}
              />
              <ChoiceCard
                selected={path === "fresh"}
                title="Start fresh on Cloudflare"
                desc="Set up DNS, security, and performance from scratch."
                onClick={() => void choosePath("fresh")}
              />
            </div>
          )}

          {key === "provider" && (
            <div style={S.chipWrap}>
              {PROVIDER_OPTIONS.map((p) => (
                <Chip
                  key={p.key}
                  on={providerKey === p.key}
                  label={p.label}
                  onClick={() => {
                    setProviderKey(p.key);
                    setPreviewMsg(undefined);
                  }}
                />
              ))}
              <Chip
                on={providerKey === "other"}
                label="Other / not sure"
                onClick={() => {
                  setProviderKey("other");
                  setPreviewMsg(undefined);
                }}
              />
            </div>
          )}

          {key === "scope" && (
            <div style={S.chipWrap}>
              {goalSet.map((g) => (
                <Chip key={g.id} on={goals.includes(g.id)} label={g.label} onClick={() => toggleGoal(g.id)} />
              ))}
            </div>
          )}

          {key === "domain" && (
            <input
              autoFocus
              value={domain}
              maxLength={MAX_ONBOARDING_DOMAIN_CHARS}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid()) void commitAndNext();
              }}
              placeholder="example.com"
              style={S.wizInput}
            />
          )}

          {key === "config" && (
            <div>
              {migrationToolConfigured === false && (
                <div style={S.wizNote}>
                  Migration import isn't configured in this environment. Ask a workspace admin to configure it,
                  or skip this step and continue with DNS-first setup.
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".json,.xml,.tf,.tfvars,.hcl,.conf,.set,.cfg,application/json,text/xml,text/plain"
                style={{ display: "none" }}
                onChange={(e) => {
                  void handleFiles(e.target.files);
                  e.currentTarget.value = "";
                }}
              />
              <div style={S.uploadRow}>
                <button style={S.uploadBtn} onClick={() => fileInputRef.current?.click()}>
                  ⬆ Upload config file(s)
                </button>
                {fileLabel && (
                  <span style={S.fileLabel}>
                    {fileLabel}
                    <button style={S.clearFile} onClick={clearFiles}>
                      clear
                    </button>
                  </span>
                )}
              </div>
              <div style={S.formatHint}>
                Supported: <b>JSON</b> · <b>XML</b> · <b>Terraform</b> (.tf — select multiple to merge a whole
                directory) · <b>PAN-OS</b>. Format is auto-detected from the file.
              </div>

              {configFiles.length === 0 && (
                <>
                  <div style={{ ...S.wizMutedRow, margin: "12px 0 8px" }}>— or paste it —</div>
                  <textarea
                    value={configText}
                    onChange={(e) => {
                      fileReadVersion.current += 1;
                      setConfigText(e.target.value);
                      setFileLabel(undefined);
                      setConfigFormat("auto");
                    }}
                    placeholder={`Paste your ${
                      PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? "provider"
                    } export here (JSON / XML / Terraform / PAN-OS)…`}
                    rows={6}
                    style={{ ...S.wizInput, resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                  />
                </>
              )}

              {previewMsg && <div style={S.wizPreviewMsg}>{previewMsg}</div>}
              {migrationPlan && (
                <div style={{ marginTop: 10 }}>
                  <MigrationPlanPanel plan={migrationPlan} />
                </div>
              )}
              <div style={S.wizHintRow}>Optional — leave blank to skip and preview later in chat.</div>
            </div>
          )}

          {key === "setup" && (
            <div style={S.choiceGrid}>
              {SETUP_OPTIONS.map((o) => (
                <ChoiceCard
                  key={o.id}
                  selected={setupType === o.id}
                  title={o.label}
                  desc={o.desc}
                  onClick={() => setSetupType(o.id)}
                />
              ))}
            </div>
          )}

          {key === "profile" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={S.wizGroupLabel}>Industry</div>
                <div style={S.chipWrap}>
                  {INDUSTRY_OPTIONS.map((o) => (
                    <Chip
                      key={o.id}
                      on={industry === o.id}
                      label={o.label}
                      onClick={() => setIndustry(industry === o.id ? undefined : o.id)}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div style={S.wizGroupLabel}>
                  What kind of app? <span style={S.wizGroupHint}>(select all that apply)</span>
                </div>
                <div style={S.chipWrap}>
                  {APP_TYPE_OPTIONS.map((o) => (
                    <Chip key={o.id} on={appTypes.includes(o.id)} label={o.label} onClick={() => toggleIn(setAppTypes, o.id)} />
                  ))}
                </div>
              </div>
              <div>
                <div style={S.wizGroupLabel}>Access patterns</div>
                <div style={S.chipWrap}>
                  <Chip on={hasLogin === true} label="Users log in" onClick={() => setHasLogin(hasLogin ? undefined : true)} />
                  <Chip on={hasApi === true} label="Exposes an API" onClick={() => setHasApi(hasApi ? undefined : true)} />
                </div>
              </div>
              <div>
                <div style={S.wizGroupLabel}>Audience</div>
                <div style={S.chipWrap}>
                  {AUDIENCE_OPTIONS.map((o) => (
                    <Chip
                      key={o.id}
                      on={audience === o.id}
                      label={o.label}
                      onClick={() => setAudience(audience === o.id ? undefined : o.id)}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div style={S.wizGroupLabel}>Traffic</div>
                <div style={S.chipWrap}>
                  {TRAFFIC_OPTIONS.map((o) => (
                    <Chip
                      key={o.id}
                      on={trafficProfile === o.id}
                      label={o.label}
                      onClick={() => setTrafficProfile(trafficProfile === o.id ? undefined : o.id)}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div style={S.wizGroupLabel}>
                  Sensitive data <span style={S.wizGroupHint}>(select all that apply)</span>
                </div>
                <div style={S.chipWrap}>
                  {SENSITIVE_OPTIONS.map((o) => (
                    <Chip key={o.id} on={sensitiveData.includes(o.id)} label={o.label} onClick={() => toggleIn(setSensitiveData, o.id)} />
                  ))}
                </div>
              </div>
              <div>
                <div style={S.wizGroupLabel}>
                  Compliance <span style={S.wizGroupHint}>(if any)</span>
                </div>
                <div style={S.chipWrap}>
                  {COMPLIANCE_OPTIONS.map((o) => (
                    <Chip key={o.id} on={compliance.includes(o.id)} label={o.label} onClick={() => toggleIn(setCompliance, o.id)} />
                  ))}
                </div>
              </div>
              <div>
                <div style={S.wizGroupLabel}>
                  Top concerns <span style={S.wizGroupHint}>(select all that apply)</span>
                </div>
                <div style={S.chipWrap}>
                  {CONCERN_OPTIONS.map((o) => (
                    <Chip key={o.id} on={concerns.includes(o.id)} label={o.label} onClick={() => toggleIn(setConcerns, o.id)} />
                  ))}
                </div>
              </div>
              <div style={S.wizHintRow}>
                All optional — skip anything you're unsure about. Glide uses this to tailor which settings it
                recommends, and you can refine it anytime in chat.
              </div>
            </div>
          )}

          {key === "token" && (
            <div>
              {tokenConfigured ? (
                <div style={S.wizNote}>A token is already connected ✓ — you can continue.</div>
              ) : (
                <>
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveTokenInline();
                    }}
                    placeholder="Cloudflare API token"
                    autoComplete="off"
                    spellCheck={false}
                    style={S.wizInput}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                    <button style={S.wizPrimarySm} disabled={!tokenInput.trim() || busy} onClick={() => void saveTokenInline()}>
                      Save securely
                    </button>
                    <span style={S.wizHintRow}>Create one at dash.cloudflare.com/profile/api-tokens</span>
                  </div>
                  {tokenMsg && <div style={S.wizPreviewMsg}>{tokenMsg}</div>}
                </>
              )}
            </div>
          )}

          {key === "review" && (
            <div>
              <div style={S.reviewList}>
                <KV k="Path" v={path === "migrate" ? "Migrate from a provider" : "Start fresh"} />
                {providerKey && (
                  <KV k="Provider" v={PROVIDER_OPTIONS.find((p) => p.key === providerKey)?.label ?? providerKey} />
                )}
                {goals.length > 0 && <KV k="Scope" v={goals.map(goalLabel).join(", ")} />}
                {domain.trim() && <KV k="Domain" v={domain.trim()} />}
                {setupType && <KV k="DNS setup" v={setupLabel(setupType)} />}
                {industry && <KV k="Industry" v={optLabel(INDUSTRY_OPTIONS, industry)} />}
                {(sensitiveData.length > 0 || compliance.length > 0 || concerns.length > 0) && (
                  <KV
                    k="Profile"
                    v={[
                      sensitiveData.length ? `${sensitiveData.length} data type(s)` : "",
                      compliance.length ? compliance.map((c) => optLabel(COMPLIANCE_OPTIONS, c)).join(", ") : "",
                      concerns.length ? `${concerns.length} concern(s)` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                )}
                <KV k="Token" v={tokenConfigured ? "connected ✓" : "not set (add later to Apply)"} />
                {migrationPlan && <KV k="Migration plan" v={`${migrationPlan.totalRules} item(s) parsed`} />}
              </div>
              <div style={S.wizNote}>
                Glide never changes anything on its own — it queues each change for a human to <b>Apply</b>.
              </div>
            </div>
          )}
        </div>

        {saveMsg && <div style={S.wizPreviewMsg}>{saveMsg}</div>}

        {summaryChips.length > 0 && (
          <div style={S.wizSummary}>
            {summaryChips.map((c) => (
              <span key={c.k} style={S.wizSummaryChip}>
                <b style={{ color: "#9ca3af" }}>{c.k}:</b> {c.v}
              </span>
            ))}
          </div>
        )}

        <div style={S.wizFooter}>
          <button style={S.wizBack} disabled={idx === 0 || busy} onClick={back}>
            Back
          </button>
          <div style={{ flex: 1 }} />
          {key === "review" ? (
            <button style={S.wizPrimary} disabled={busy} onClick={finish}>
              Finish & open chat
            </button>
          ) : (
            <button style={S.wizPrimary} disabled={!valid() || busy} onClick={() => void commitAndNext()}>
              {busy ? "Working…" : "Continue"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin view (/admin) — a read-only operations dashboard for one room.
// ---------------------------------------------------------------------------

/** True when the current path is the admin route (`/admin`). */
function isAdminPath(): boolean {
  return /^\/admin\/?$/i.test(location.pathname);
}

let adminDocsPromise: Promise<GlideDocsManifest> | undefined;

function loadAdminDocs(): Promise<GlideDocsManifest> {
  adminDocsPromise ??= import("virtual:glide-docs").then((module) => module.docsManifest);
  return adminDocsPromise;
}

// --- Minimal, dependency-free Markdown renderer (dev-docs viewer) -----------

/** Render inline markdown (code, links, bold, italic) to React nodes. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(<code key={key} style={S.mdCodeInline}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" style={S.mdA}>
            {link[1]}
          </a>,
        );
      } else nodes.push(tok);
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
function isTableSeparator(line: string): boolean {
  return line.includes("-") && /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/.test(line);
}

/** Render a Markdown string into styled React nodes (headings, lists, code, tables). */
function DocMarkdown({ src }: { src: string }) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let k = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(
      <p key={`p-${k++}`} style={S.mdP}>
        {renderInline(para.join(" "), `p${k}`)}
      </p>,
    );
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block
    if (/^```/.test(trimmed)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      blocks.push(
        <pre key={`code-${k++}`} style={S.mdPre}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (!trimmed) {
      flushPara();
      continue;
    }

    // Headings
    const h = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (h) {
      flushPara();
      const level = h[1].length;
      const style = level <= 1 ? S.mdH1 : level === 2 ? S.mdH2 : S.mdH3;
      blocks.push(
        <div key={`h-${k++}`} style={style}>
          {renderInline(h[2], `h${k}`)}
        </div>,
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push(<hr key={`hr-${k++}`} style={S.mdHr} />);
      continue;
    }

    // Blockquote (collapse consecutive `>` lines)
    if (/^>\s?/.test(trimmed)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      blocks.push(
        <blockquote key={`q-${k++}`} style={S.mdQuote}>
          {renderInline(buf.join(" "), `q${k}`)}
        </blockquote>,
      );
      continue;
    }

    // Table (pipe syntax with a header separator row)
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(trimmed);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i].trim()));
        i++;
      }
      i--;
      blocks.push(
        <div key={`tbl-${k++}`} style={S.mdTableWrap}>
          <table style={S.mdTable}>
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci} style={S.mdTh}>{renderInline(c, `th${k}-${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={S.mdTd}>{renderInline(c, `td${k}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lists (unordered / ordered) — group consecutive items
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      flushPara();
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length && /^([-*+]|\d+\.)\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      i--;
      const inner = items.map((it, ii) => (
        <li key={ii} style={S.mdLi}>{renderInline(it, `li${k}-${ii}`)}</li>
      ));
      blocks.push(
        ordered ? (
          <ol key={`ol-${k++}`} style={S.mdList}>{inner}</ol>
        ) : (
          <ul key={`ul-${k++}`} style={S.mdList}>{inner}</ul>
        ),
      );
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return <div style={S.mdRoot}>{blocks}</div>;
}

// --- Admin building blocks --------------------------------------------------

type AdminTab = "comms" | "actions" | "guidance" | "docs" | "onboarding" | "audit";

/** Escape a single CSV field per RFC 4180 (quote when it contains ,"\n or \r). */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Defensively parse a `getAuditLog` RPC payload into a bounded, sanitized list. */
function parsedAuditEntries(value: unknown): RoomAuditEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RoomAuditEntry[] = [];
  for (const raw of value.slice(0, 5_000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.actor !== "string" || typeof e.action !== "string") continue;
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) continue;
    out.push({
      id: e.id,
      ts: e.ts,
      actor: e.actor,
      action: e.action as RoomAuditEntry["action"],
      ...(typeof e.target === "string" ? { target: e.target } : {}),
      ...(typeof e.detail === "string" ? { detail: e.detail } : {}),
    });
  }
  return out;
}

/** A read-only room snapshot returned to a non-member employee by /api/room-inspect. */
interface InspectionSnapshot {
  state: GlideState;
  messages: UIMessage[];
  audit: RoomAuditEntry[];
}

/** Defensively parse the `/api/room-inspect` snapshot payload. */
function parsedInspectionSnapshot(value: unknown): InspectionSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snap = (value as { snapshot?: unknown }).snapshot;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return undefined;
  const s = snap as { state?: unknown; messages?: unknown; audit?: unknown };
  if (!s.state || typeof s.state !== "object" || Array.isArray(s.state)) return undefined;
  const messages = (Array.isArray(s.messages) ? s.messages : []).filter(
    (m): m is UIMessage =>
      !!m &&
      typeof m === "object" &&
      typeof (m as { id?: unknown }).id === "string" &&
      Array.isArray((m as { parts?: unknown }).parts),
  );
  return { state: s.state as GlideState, messages, audit: parsedAuditEntries(s.audit) };
}

/** Accent color for an audit action verb, to aid scanning the trail. */
function auditActionColor(action: string): string {
  switch (action) {
    case "apply":
      return "#4ade80";
    case "reject":
    case "remove":
    case "destroy":
      return "#fb7185";
    case "queue":
      return "#fbbf24";
    case "invite":
    case "role_change":
      return "#38bdf8";
    case "inspect":
      return "#c4b5fd";
    default:
      return "#cbd5e1";
  }
}

/** Render an audit log to CSV text for download. */
function auditToCsv(entries: RoomAuditEntry[]): string {
  const header = ["timestamp", "iso", "actor", "action", "target", "detail"];
  const rows = entries.map((e) =>
    [
      String(e.ts),
      new Date(e.ts).toISOString(),
      e.actor ?? "",
      e.action ?? "",
      e.target ?? "",
      e.detail ?? "",
    ]
      .map(csvField)
      .join(","),
  );
  return [header.join(","), ...rows].join("\r\n");
}

function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={S.panel} className="glide-panel glide-glass-card">
      <div style={S.panelHead}>
        <h3 style={S.panelTitle}>{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  const numStyle = tone ? { ...S.statNum, color: tone } : { ...S.statNum, ...brandText };
  return (
    <div style={S.statCard} className="glide-lift glide-glass-card glide-stat-card">
      <div style={numStyle} className={tone ? undefined : "glide-brand"}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

type GuidanceDraft = { id?: string; title: string; body: string; enabled: boolean };

/**
 * Admin "Guidance" tab: add/edit/enable/delete the room's guidance docs. Enabled
 * docs are injected into Glide's system prompt (server-side), so editing here
 * changes which onboarding questions Glide asks — live, no redeploy.
 */
function GuidanceTab({
  docs,
  onSave,
  onDelete,
  onReindex,
  readOnly = false,
}: {
  docs: GuidanceDoc[];
  onSave?: (doc: GuidanceDraft) => Promise<unknown>;
  onDelete?: (id: string) => Promise<unknown>;
  onReindex?: () => Promise<unknown>;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState<GuidanceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [notice, setNotice] = useState<string>();

  const reindex = async () => {
    if (reindexing || !onReindex) return;
    setReindexing(true);
    try {
      const res = (await onReindex()) as { ok?: boolean; message?: string } | undefined;
      setNotice(res?.message ?? "Reindex requested.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Guidance reindex failed.");
    } finally {
      setReindexing(false);
    }
  };

  const save = async () => {
    if (!draft || busy || !onSave) return;
    setBusy(true);
    try {
      const res = (await onSave(draft)) as { ok?: boolean; message?: string } | undefined;
      if (res?.message) setNotice(res.message);
      if (res?.ok !== false) setDraft(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Guidance save failed.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (d: GuidanceDoc) =>
    void onSave?.({ id: d.id, title: d.title, body: d.body, enabled: !d.enabled });

  const remove = (d: GuidanceDoc) => {
    if (onDelete && window.confirm(`Delete guidance "${d.title}"? This can't be undone.`)) void onDelete(d.id);
  };

  return (
    <Panel
      title={`Guidance · ${docs.length}`}
      meta={<span style={S.panelMeta}>steers Glide's questions · {readOnly ? "read-only" : "live"}</span>}
    >
      <p style={S.hint}>
        Notes {readOnly ? "the team added here are" : "you add here are"} injected into Glide's brain for
        this room, so it asks relevant, team-specific onboarding questions — and skips what's already
        been answered. Enabled docs take effect immediately; no rebuild or redeploy needed. With many
        docs, Glide semantically retrieves only the most relevant ones per message (RAG).
      </p>

      {!readOnly && docs.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px" }}>
          <button style={S.miniBtn} disabled={reindexing} onClick={reindex}>
            {reindexing ? "Reindexing…" : "Reindex for search"}
          </button>
          <span style={S.listMeta}>Re-embed all guidance so semantic retrieval is current.</span>
        </div>
      )}

      {notice && <div style={S.guidanceNotice}>{notice}</div>}

      {!readOnly && (draft ? (
        <div style={S.guidanceEditor} className="glide-glass-card">
          <label style={S.label}>Title</label>
          <input
            autoFocus
            style={S.input}
            value={draft.title}
            maxLength={120}
            placeholder="e.g. Our stack, Compliance, Preferred DNS setup"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <label style={{ ...S.label, marginTop: 12 }}>Guidance for Glide</label>
          <textarea
            style={S.guidanceTextarea}
            value={draft.body}
            maxLength={4_000}
            placeholder={
              "What should Glide know about this team so it asks the right questions?\n\ne.g. We're migrating from Akamai; we only care about WAF + rate limiting. DNS stays at Route 53 (partial/CNAME setup), so don't ask about nameserver changes. Always ask about PCI scope."
            }
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <label style={S.guidanceCheck}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            Enabled — inject into Glide's prompt
          </label>
          <div style={S.guidanceBtnRow}>
            <button style={S.guidanceSaveBtn} disabled={busy} onClick={save}>
              {busy ? "Saving…" : draft.id ? "Save changes" : "Add guidance"}
            </button>
            <button style={{ ...S.rejectBtn, flex: "0 0 auto", padding: "10px 16px" }} disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          style={S.guidanceSaveBtn}
          onClick={() => setDraft({ title: "", body: "", enabled: true })}
        >
          + Add guidance
        </button>
      ))}

      <div style={{ marginTop: 16 }}>
        {docs.length === 0 && (
          <Muted>
            {readOnly
              ? "No guidance in this room yet."
              : "No guidance yet. Add a note above to steer Glide's questions."}
          </Muted>
        )}
        {docs.map((d) => (
          <div key={d.id} style={S.docRow} className="glide-glass-card">
            <div style={{ padding: "12px 16px" }}>
              <div style={S.guidanceRowTop}>
                <span style={S.docTitle}>{d.title}</span>
                <span
                  style={{
                    ...S.badge,
                    background: d.enabled ? "#064e3b" : "#374151",
                    color: d.enabled ? "#6ee7b7" : "#cbd5e1",
                  }}
                >
                  {d.enabled ? "active" : "off"}
                </span>
              </div>
              {d.body && <div style={S.guidanceBody}>{d.body}</div>}
              <div style={S.guidanceActions}>
                {!readOnly && (
                  <>
                    <button style={S.miniBtn} onClick={() => setDraft({ id: d.id, title: d.title, body: d.body, enabled: d.enabled })}>
                      Edit
                    </button>
                    <button style={S.miniBtn} onClick={() => toggle(d)}>
                      {d.enabled ? "Disable" : "Enable"}
                    </button>
                    <button style={S.rejectBtnSm} onClick={() => remove(d)}>
                      Delete
                    </button>
                  </>
                )}
                {d.updatedBy && (
                  <span style={{ ...S.listMeta, marginLeft: "auto" }}>
                    by {d.updatedBy} · {relTime(d.ts)}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Prompt for a room id when `/admin` is opened without one in the hash. */
function AdminPickRoom({ isEmployee, onPick }: { isEmployee: boolean; onPick: (room: string) => void }) {
  const [value, setValue] = useState("");
  const [rooms, setRooms] = useState<RoomSummary[]>();
  const [roomsError, setRoomsError] = useState<string>();
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isEmployee) return;
    const controller = new AbortController();
    setLoadingRooms(true);
    setRoomsError(undefined);
    void fetchAccessJson("/api/rooms", controller.signal, "GET")
      .then((v) => {
        if (!controller.signal.aborted) setRooms(parsedRoomSummaries(v));
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setRoomsError(reason instanceof Error ? reason.message : "Glide could not load the room list.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRooms(false);
      });
    return () => controller.abort();
  }, [isEmployee, attempt]);

  return (
    <div style={S.joinWrap} className="glide-join">
      <div style={{ ...S.joinCard, width: 520, maxHeight: "88dvh", overflowY: "auto" }} className="glide-glass glide-join-card">
        <img src="/cloudflare-logo-white.png" alt="Cloudflare" style={S.cfLogoJoin} />
        <h1 style={{ ...S.brand, fontSize: 30 }} className="glide-brand">Glide · Admin</h1>
        <p style={S.tagline}>
          Enter a room id to inspect its comms, actions, docs, and status. The room id is the value
          after <code>#</code> in a room link.
        </p>
        <label style={S.label}>Room id</label>
        <input
          autoFocus
          value={value}
          maxLength={MAX_LEGACY_ROOM_ID_CHARS}
          onChange={(e) => setValue(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onPick(value.trim());
          }}
          placeholder="e.g. 6f3a9c…"
          style={S.input}
        />
        <button style={S.primaryBtn} disabled={!value.trim()} onClick={() => value.trim() && onPick(value.trim())}>
          Open admin
        </button>

        {isEmployee && (
          <div style={S.adminRoomsWrap}>
            <div style={S.adminRoomsHead}>
              <span style={S.label}>All rooms{rooms ? ` · ${rooms.length}` : ""}</span>
              <button
                style={S.miniBtn}
                disabled={loadingRooms}
                onClick={() => setAttempt((a) => a + 1)}
                title="Refresh the room list"
              >
                {loadingRooms ? "Loading…" : "Refresh"}
              </button>
            </div>
            {roomsError ? (
              <p style={{ ...S.hint, color: "#fda4af" }}>{roomsError}</p>
            ) : loadingRooms && !rooms ? (
              <p style={S.hint}>Loading rooms…</p>
            ) : rooms && rooms.length === 0 ? (
              <p style={S.hint}>
                No rooms are registered yet. Rooms appear here once they’re created or next active
                after this update.
              </p>
            ) : (
              <div style={S.adminRoomsList}>
                {(rooms ?? []).map((r) => (
                  <button
                    key={r.id}
                    style={S.adminRoomRow}
                    className="glide-room-row"
                    onClick={() => onPick(r.id)}
                    title={`Open admin for ${r.name ? `${r.name} (#${r.id})` : `#${r.id}`}`}
                  >
                    <span style={S.adminRoomName}>{r.name || `#${r.id}`}</span>
                    <span style={S.adminRoomMeta}>
                      {r.name ? `#${r.id} · ` : ""}
                      {r.memberCount} member{r.memberCount === 1 ? "" : "s"}
                      {r.owner ? ` · ${r.owner}` : ""}
                      {r.lastActiveAt ? ` · active ${relTime(r.lastActiveAt)}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Admin entry: resolve the room (from the hash) and mount the dashboard. */
function AdminGate({ session }: { session: AccessSession }) {
  const [room, setRoom] = useState(() => readRoomFromHash());
  useEffect(() => {
    const onHash = () => setRoom(readRoomFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!room) {
    return (
      <AdminPickRoom
        isEmployee={session.isEmployee}
        onPick={(r) => {
          const normalized = r.trim();
          if (!isSupportedRoomId(normalized)) return;
          location.hash = encodeURIComponent(normalized);
          setRoom(normalized);
        }}
      />
    );
  }
  return <AdminRoomLoader key={room} room={room} />;
}

/**
 * Resolve /admin access via `/api/room-inspect`, then mount the right dashboard:
 * a member gets the LIVE dashboard (WebSocket); a verified Cloudflare employee
 * who isn't a member gets the read-only INSPECTOR dashboard fed by an audited
 * HTTP snapshot (no socket, zero mutation surface).
 */
function AdminRoomLoader({ room }: { room: string }) {
  const [attempt, setAttempt] = useState(0);
  const [payload, setPayload] = useState<{
    access: RoomAccessStatus & { message?: string };
    snapshot?: InspectionSnapshot;
  }>();
  const [error, setError] = useState<string>();
  const recheck = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setPayload(undefined);
    setError(undefined);
    void fetchAccessJson(`/api/room-inspect?room=${encodeURIComponent(room)}`, controller.signal, "POST")
      .then((value) => {
        const access = parsedRoomAccessStatus(value);
        if (!access) throw new Error("Glide returned a malformed inspection response.");
        const snapshot = access.entry === "inspect" ? parsedInspectionSnapshot(value) : undefined;
        if (access.entry === "inspect" && !snapshot) {
          throw new Error("Glide returned an incomplete inspection snapshot.");
        }
        setPayload({ access, snapshot });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Glide could not open this room.");
        }
      });
    return () => controller.abort();
  }, [room, attempt]);

  if (error) {
    return (
      <AccessCard
        title="Room access required"
        message={error}
        action={<button style={S.primaryBtn} onClick={recheck}>Try again</button>}
      />
    );
  }
  if (!payload) return <AccessCard title="Opening room" message="Checking your access…" />;

  const { access, snapshot } = payload;
  return (
    <Suspense
      fallback={
        <div style={{ ...S.shell, alignItems: "center", justifyContent: "center" }} className="glide-shell">
          <span style={{ color: "#9ca3af", fontSize: 15 }}>Loading admin…</span>
        </div>
      }
    >
      {access.entry === "inspect" && snapshot ? (
        <InspectorAdminRoom access={access} room={room} name={access.email} snapshot={snapshot} />
      ) : (
        <LiveAdminRoom access={access} room={room} name={access.email} onAccessLost={recheck} />
      )}
    </Suspense>
  );
}

/** Members' admin dashboard: live WebSocket, editable guidance, on-demand audit. */
function LiveAdminRoom({
  access,
  room,
  name,
  onAccessLost,
}: {
  access: RoomAccessStatus;
  room: string;
  name: string;
  onAccessLost: () => void;
}) {
  const agentRoom = requiredRoomStorageName(room);
  const [state, setState] = useState<GlideState>();
  const [members, setMembers] = useState(access.members);
  const [audit, setAudit] = useState<RoomAuditEntry[]>();
  const [auditError, setAuditError] = useState<string>();
  const [auditLoading, setAuditLoading] = useState(false);
  const connectionAccess = useRoomConnectionAccess(room, onAccessLost);

  const agent = useAgent<GlideState>({
    agent: "GlideAgent",
    name: agentRoom,
    onStateUpdate: (s) => setState(s),
    ...connectionAccess,
  });
  const chat = useAgentChat({
    agent,
    getInitialMessages: loadInitialAgentMessages,
    body: () => ({ name }),
    experimental_throttle: 100,
  });
  const verifiedActionResultEvents = useVerifiedActionResultEvents(agent, chat.messages);
  const messages = chat.messages.filter((message) => {
    const candidate = actionResultEventCandidate(message);
    return !candidate || !verifiedActionResultEvents.has(actionResultEventKey(candidate));
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void agent.call("roomAccessStatus", [], { timeout: AGENT_MESSAGES_TIMEOUT_MS })
        .then((value) => {
          const parsed = parsedRoomAccessStatus(value);
          if (!cancelled && parsed) setMembers(parsed.members);
        })
        .catch(() => undefined);
    };
    agent.addEventListener("open", refresh);
    if (agent.readyState === WebSocket.OPEN) refresh();
    return () => {
      cancelled = true;
      agent.removeEventListener("open", refresh);
    };
  }, [agent, state?.invites.length]);

  // Audit is owner-gated on the server; load it on demand when the tab is opened.
  const loadAudit = useCallback(() => {
    if (agent.readyState !== WebSocket.OPEN) return;
    setAuditLoading(true);
    setAuditError(undefined);
    void agent.call("getAuditLog", [1_000], { timeout: AGENT_MESSAGES_TIMEOUT_MS })
      .then((value) => setAudit(parsedAuditEntries(value)))
      .catch((reason: unknown) =>
        setAuditError(reason instanceof Error ? reason.message : "Could not load the audit log."))
      .finally(() => setAuditLoading(false));
  }, [agent]);

  return (
    <AdminDashboard
      mode="live"
      room={room}
      name={name}
      state={state}
      messages={messages}
      members={members}
      audit={audit}
      auditError={auditError}
      auditLoading={auditLoading}
      onRefreshAudit={loadAudit}
      canManageGuidance
      onGuidanceSave={(doc) => agent.call("upsertGuidanceDoc", [doc, name])}
      onGuidanceDelete={(id) => agent.call("deleteGuidanceDoc", [id])}
      onGuidanceReindex={() => agent.call("reindexGuidance")}
    />
  );
}

/** Non-member employee's read-only inspector: rendered from an audited HTTP snapshot. */
function InspectorAdminRoom({
  access,
  room,
  name,
  snapshot,
}: {
  access: RoomAccessStatus;
  room: string;
  name: string;
  snapshot: InspectionSnapshot;
}) {
  // The snapshot is server-authoritative, so reserved action-result events are
  // trusted and simply filtered out of the transcript (they surface under Actions).
  const messages = snapshot.messages.filter((m) => !actionResultEventCandidate(m));
  return (
    <AdminDashboard
      mode="inspect"
      room={room}
      name={name}
      state={snapshot.state}
      messages={messages}
      members={access.members}
      audit={snapshot.audit}
      canManageGuidance={false}
    />
  );
}

/** The room-scoped admin dashboard: comms, actions, dev docs, onboarding & migration. */
function AdminDashboard({
  mode,
  room,
  name,
  state,
  messages,
  members,
  audit,
  auditError,
  auditLoading = false,
  onRefreshAudit,
  canManageGuidance,
  onGuidanceSave,
  onGuidanceDelete,
  onGuidanceReindex,
}: {
  mode: "live" | "inspect";
  room: string;
  name: string;
  state: GlideState | undefined;
  messages: UIMessage[];
  members: RoomMember[];
  audit: RoomAuditEntry[] | undefined;
  auditError?: string;
  auditLoading?: boolean;
  onRefreshAudit?: () => void;
  canManageGuidance: boolean;
  onGuidanceSave?: (doc: GuidanceDraft) => Promise<unknown>;
  onGuidanceDelete?: (id: string) => Promise<unknown>;
  onGuidanceReindex?: () => Promise<unknown>;
}) {
  const docsManifest = use(loadAdminDocs());
  const [tab, setTab] = useState<AdminTab>("comms");
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const inspecting = mode === "inspect";

  const chatLink = `/#${encodeURIComponent(room)}`;
  const pending = state?.pendingActions ?? [];
  const results = state?.recentResults ?? [];
  const invites = state?.invites ?? [];
  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  const onboarding = state?.onboarding;
  const plan = state?.migrationPlan;
  const guidance = state?.guidance ?? [];
  const guidanceActive = guidance.filter((d) => d.enabled).length;

  useEffect(() => {
    if (tab === "audit") onRefreshAudit?.();
  }, [tab, onRefreshAudit]);

  const tabs: Array<{ id: AdminTab; label: string; count?: number }> = [
    { id: "comms", label: "Comms", count: messages.length },
    { id: "actions", label: "Actions", count: pending.length },
    { id: "guidance", label: "Guidance", count: guidance.length },
    { id: "docs", label: "Dev docs", count: docsManifest.docs.length },
    { id: "onboarding", label: "Onboarding & migration" },
    { id: "audit", label: "Audit" },
  ];

  return (
    <div style={S.shell} className="glide-shell glide-admin-shell">
      <header style={S.header} className="glide-header glide-glass">
        <div style={S.headerLeft} className="glide-header-left">
          <img src="/cloudflare-mark.png" alt="Cloudflare" style={S.cfMark} />
          <span style={S.brandSm} className="glide-brand">Glide</span>
          <span style={S.adminTag}>Admin</span>
          {inspecting && (
            <span style={S.adminTag} title="You are not a member of this room — read-only inspection, and this visit is audited.">
              inspecting · read-only
            </span>
          )}
          {state?.roomName && <span style={S.roomNameTag} title="Room name">{state.roomName}</span>}
          <span style={S.roomPill} className="glide-room-pill">#{room}</span>
        </div>
        <div style={S.headerRight} className="glide-header-right">
          {state ? (
            state.tokenConfigured ? (
              <span style={{ ...S.badge, background: "#064e3b", color: "#6ee7b7" }}>token ✓</span>
            ) : (
              <span style={{ ...S.badge, background: "#7f1d1d", color: "#fecaca" }}>no token</span>
            )
          ) : (
            <span style={{ ...S.badge, background: "#374151", color: "#d1d5db" }}>connecting…</span>
          )}
          <a href={chatLink} style={S.headerLink}>← Chat</a>
          <span style={S.you} className="glide-user">{name}</span>
        </div>
      </header>

      <div style={S.adminStats} className="glide-admin-stats glide-glass">
        <StatCard label="Messages" value={messages.length} />
        <StatCard label="Pending" value={pending.length} tone={pending.length ? "#fbbf24" : undefined} />
        <StatCard label="Applied" value={applied} tone={applied ? "#4ade80" : undefined} />
        <StatCard label="Failed" value={failed} tone={failed ? "#fb7185" : undefined} />
        <StatCard label="Rejected" value={rejected} />
        <StatCard label="Invites" value={invites.length} />
        <StatCard label="Guidance" value={guidanceActive} tone={guidanceActive ? "#38bdf8" : undefined} />
        <StatCard label="Docs" value={docsManifest.docs.length} />
      </div>

      <div style={S.tabBar} className="glide-tab-bar glide-glass">
        {tabs.map((t) => (
          <button
            key={t.id}
            style={{ ...S.tab, ...(tab === t.id ? S.tabOn : null) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {typeof t.count === "number" ? ` · ${t.count}` : ""}
          </button>
        ))}
      </div>

      <div style={S.adminContent} className="glide-admin-content">
        {!state && <div style={S.adminLoading}>Connecting to room #{room}…</div>}

        {tab === "comms" && (
          <>
            <Panel title={`Transcript · ${messages.length}`} meta={<span style={S.panelMeta}>read-only</span>}>
              {messages.length === 0 && <Muted>No messages in this room yet.</Muted>}
              <div style={S.transcript}>
                {messages.map((m) => {
                  const { text, tools } = messageText(m);
                  const { who, userStyle, role } = messageAuthor(m);
                  return (
                    <div key={m.id} style={S.commRow}>
                      <div style={{ ...S.avatar, ...(userStyle ? S.avatarUser : S.avatarAi) }}>
                        {userStyle ? who.charAt(0).toUpperCase() : "G"}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={S.commWho}>
                          {who} <span style={S.commRole}>{role}</span>
                        </div>
                        {text && <div style={S.commText}>{text}</div>}
                        {tools.length > 0 && (
                          <div>
                            {tools.map((tool) => (
                              <ToolChip key={tool.id} tool={tool} />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>

            <Panel title={`Invites · ${invites.length}`}>
              {invites.length === 0 && <Muted>No invites recorded.</Muted>}
              {invites.map((inv) => (
                <div key={`${inv.email}-${inv.ts}`} style={S.listRow}>
                  <span style={{ fontSize: 13, wordBreak: "break-all" }}>{inv.email}</span>
                  <span style={S.listMeta}>
                    by {inv.invitedBy} · {relTime(inv.ts)}
                  </span>
                </div>
              ))}
            </Panel>

            <Panel title={`Members · ${members.length}`}>
              {members.map((member) => (
                <div key={member.email} style={S.listRow}>
                  <span style={{ fontSize: 13, wordBreak: "break-all" }}>{member.email}</span>
                  <span style={S.listMeta}>{member.role}{member.email === name ? " · you" : ""}</span>
                </div>
              ))}
            </Panel>
          </>
        )}

        {tab === "actions" && (
          <>
            <Panel
              title={`Pending approvals · ${pending.length}`}
              meta={<span style={S.panelMeta}>view-only — Apply from the chat room</span>}
            >
              {pending.length === 0 && <Muted>Nothing queued.</Muted>}
              {pending.map((a) => (
                <div key={a.id} style={S.actionCard}>
                  <div style={S.actionTop}>
                    <span style={{ ...S.method, background: METHOD_COLORS[a.method] ?? "#6b7280" }}>{a.method}</span>
                    <span style={S.product}>{a.product}</span>
                    <span style={{ ...S.listMeta, marginLeft: "auto" }}>
                      {isActionApplying(a) ? "applying" : pendingActionStatus(a)} · {relTime(a.ts)}
                    </span>
                  </div>
                  <div style={S.actionSummary}>{a.summary}</div>
                  <code style={S.path}>{a.path}</code>
                  {a.body !== undefined && (
                    <details style={S.bodyDetails}>
                      <summary style={S.bodySummary}>Request body</summary>
                      <pre style={S.bodyPre}>{JSON.stringify(a.body, null, 2)}</pre>
                    </details>
                  )}
                  {a.error && <div style={{ ...S.resultDetail, color: "#fda4af" }}>{a.error}</div>}
                  <div style={S.actionMeta}>by {a.createdBy}</div>
                </div>
              ))}
            </Panel>

            <Panel title={`Recent results · ${results.length}`}>
              {results.length === 0 && <Muted>No results yet.</Muted>}
              {results.map((r) => (
                <div key={`${r.id}-${r.ts}`} style={S.resultRow}>
                  <span style={{ ...S.dot, background: STATUS_COLORS[r.status] }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={S.resultSummary}>{r.summary}</div>
                    <div style={S.resultDetail}>{r.detail}</div>
                    <div style={S.listMeta}>
                      {r.status} · by {r.by} · {relTime(r.ts)}
                    </div>
                  </div>
                </div>
              ))}
            </Panel>
          </>
        )}

        {tab === "guidance" && (
          <GuidanceTab
            docs={guidance}
            readOnly={!canManageGuidance}
            onSave={onGuidanceSave}
            onDelete={onGuidanceDelete}
            onReindex={onGuidanceReindex}
          />
        )}

        {tab === "docs" && (
          <Panel
            title={`Dev docs · ${docsManifest.docs.length}`}
            meta={<span style={S.panelMeta}>snapshot built {relTime(Date.parse(docsManifest.generatedAt))}</span>}
          >
            <p style={S.hint}>
              Documentation captured at build time. “Modified” is each file's last change on disk when Glide
              was last built — rebuild &amp; redeploy to refresh this tracker.
            </p>
            {docsManifest.docs.map((d) => {
              const open = openDoc === d.id;
              return (
                <div key={d.id} style={S.docRow} className="glide-glass-card">
                  <div style={S.docHeadRow} onClick={() => setOpenDoc(open ? null : d.id)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={S.docTitle}>{d.title}</div>
                      <code style={S.docPath}>{d.path}</code>
                      {d.summary && <div style={S.docSummary}>{d.summary}</div>}
                    </div>
                    <div style={S.docMetaCol}>
                      <span style={S.docWhen} title={fmtWhen(d.mtimeMs)}>{relTime(d.mtimeMs)}</span>
                      <span style={S.docSize}>
                        {fmtBytes(d.bytes)} · {d.lines} lines
                      </span>
                      <span style={S.docToggle}>{open ? "Hide ▲" : "View ▼"}</span>
                    </div>
                  </div>
                  {open && (
                    <div style={S.docBody}>
                      <DocMarkdown src={d.content} />
                    </div>
                  )}
                </div>
              );
            })}
          </Panel>
        )}

        {tab === "onboarding" && (
          <>
            <Panel title="Onboarding">
              {!onboarding?.active && !onboarding?.completed ? (
                <Muted>Onboarding hasn't been started in this room.</Muted>
              ) : (
                <>
                  <KV
                    k="status"
                    v={onboarding?.completed ? "completed ✓" : onboarding?.active ? "in progress" : "—"}
                  />
                  {onboarding?.path && (
                    <KV k="path" v={onboarding.path === "migrate" ? "Migrate from a provider" : "Start fresh"} />
                  )}
                  {onboarding?.domain && <KV k="domain" v={onboarding.domain} />}
                  {onboarding?.setupType && <KV k="DNS setup" v={setupLabel(onboarding.setupType)} />}
                  {(onboarding?.migratingFromLabel || onboarding?.migratingFrom) && (
                    <KV k="from" v={onboarding.migratingFromLabel ?? onboarding.migratingFrom ?? ""} />
                  )}
                  {onboarding && onboarding.goals.length > 0 && (
                    <KV k="goals" v={onboarding.goals.map(goalLabel).join(", ")} />
                  )}
                  {state?.liveZone && state.liveZone.zoneId === state?.defaultZone?.id && (
                    <KV k="live zone" v={liveZoneSummary(state.liveZone)} />
                  )}
                  {onboarding && onboarding.checklist.length > 0 && (
                    <>
                      <div style={{ ...S.progressWrap, marginTop: 12 }}>
                        <div
                          style={{
                            ...S.progressBar,
                            width: `${Math.round(
                              (100 * onboarding.checklist.filter((s) => s.done || s.na).length) /
                                onboarding.checklist.length,
                            )}%`,
                          }}
                        />
                      </div>
                      <div style={S.checklist}>
                        {onboarding.checklist.map((s) => {
                          const na = Boolean(s.na) && !s.done;
                          return (
                            <div key={s.id} style={S.checkItem}>
                              <span style={{ color: s.done ? "#6ee7b7" : na ? "#9aa4b2" : "#64748b" }}>
                                {s.done ? "✓" : na ? "–" : "○"}
                              </span>
                              <span
                                style={{
                                  textDecoration: s.done ? "line-through" : "none",
                                  color: s.done ? "#6b7280" : na ? "#9aa4b2" : "#e5e7eb",
                                }}
                              >
                                {s.label}
                              </span>
                              {na && <span style={S.naBadge} title="Not applicable for this zone's current state">N/A</span>}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}
            </Panel>

            <Panel title="Business profile">
              {hasProfileSignal(state?.businessProfile) ? (
                <>
                  <BusinessProfilePanel profile={state!.businessProfile!} />
                  <div style={{ marginTop: 14 }}>
                    <div style={S.recGroupLabel}>Tailored recommendations</div>
                    <RecommendationsPanel
                      profile={state!.businessProfile!}
                      goals={onboarding?.goals}
                      setupType={onboarding?.setupType}
                      zoneId={state?.defaultZone?.id}
                      pending={state?.pendingActions ?? []}
                      results={state?.recentResults ?? []}
                    />
                  </div>
                </>
              ) : (
                <Muted>
                  No business profile captured yet. Glide asks about the team's industry, app type, data
                  sensitivity, compliance, and concerns in chat, then recommends tailored settings.
                </Muted>
              )}
            </Panel>

            <Panel title="Cloudflare docs">
              {state?.docLinks?.length ? (
                <DocLinksPanel links={state.docLinks} />
              ) : (
                <Muted>No documentation referenced in this room yet.</Muted>
              )}
            </Panel>

            <Panel title="Migration">
              {!plan ? (
                <Muted>
                  No migration plan in this room
                  {state?.migrationToolConfigured === false ? " (migration import not configured)." : "."}
                </Muted>
              ) : (
                <>
                  <MigrationPlanPanel plan={plan} />
                  {state?.migrationCheck && state.migrationCheck.kind !== "validate" && (
                    <div
                      style={{
                        ...S.checkBox,
                        borderColor: state.migrationCheck.ok ? "#14532d" : "#7c2d12",
                        background: state.migrationCheck.ok ? "#052e16" : "#422006",
                        color: state.migrationCheck.ok ? "#86efac" : "#fed7aa",
                      }}
                    >
                      <b>{state.migrationCheck.kind}:</b> {state.migrationCheck.summary}
                      <MigrationCheckMeta
                        check={state.migrationCheck}
                        plan={plan}
                        defaultAccountId={state.defaultAccountId}
                        defaultZoneId={state.defaultZone?.id}
                      />
                    </div>
                  )}
                </>
              )}
            </Panel>

            {(state?.terraform || state?.csv) && (
              <Panel title="Exports">
                {state?.terraform && (
                  <MigrationArtifactMeta
                    artifact={state.terraform}
                    plan={plan}
                    defaultAccountId={state.defaultAccountId}
                    defaultZoneId={state.defaultZone?.id}
                  />
                )}
                {state?.terraform?.files.map((f) => (
                  <div key={`tf-${f.filename}`} style={S.tfRow}>
                    <code style={S.tfName}>{f.filename}</code>
                    <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                      Download
                    </button>
                  </div>
                ))}
                {state?.csv && (
                  <MigrationArtifactMeta
                    artifact={state.csv}
                    plan={plan}
                    defaultAccountId={state.defaultAccountId}
                    defaultZoneId={state.defaultZone?.id}
                    targetless
                  />
                )}
                {state?.csv?.files.map((f) => (
                  <div key={`csv-${f.filename}`} style={S.tfRow}>
                    <code style={S.tfName}>{f.filename}</code>
                    <button style={S.miniBtn} onClick={() => downloadText(f.filename, f.content)}>
                      Download
                    </button>
                  </div>
                ))}
              </Panel>
            )}
          </>
        )}

        {tab === "audit" && (
          <Panel
            title={`Audit trail${audit ? ` · ${audit.length}` : ""}`}
            meta={
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={S.panelMeta}>{inspecting ? "read-only" : "owner-only"}</span>
                {onRefreshAudit && (
                  <button style={S.miniBtn} disabled={auditLoading} onClick={() => onRefreshAudit()}>
                    {auditLoading ? "Loading…" : "Refresh"}
                  </button>
                )}
                <button
                  style={S.miniBtn}
                  disabled={!audit || audit.length === 0}
                  onClick={() => audit && downloadText(`glide-audit-${room}.csv`, auditToCsv(audit), "text/csv")}
                >
                  Export CSV
                </button>
                <button
                  style={S.miniBtn}
                  disabled={!audit || audit.length === 0}
                  onClick={() =>
                    audit &&
                    downloadText(`glide-audit-${room}.json`, JSON.stringify(audit, null, 2), "application/json")}
                >
                  Export JSON
                </button>
              </div>
            }
          >
            <p style={S.hint}>
              Append-only record of who queued, applied, rejected, invited, and changed settings in this room.
              {inspecting
                ? " Shown here for your read-only inspection; this visit was itself recorded."
                : " Visible to the room owner only."}
            </p>
            {auditError ? (
              <Muted>{auditError}</Muted>
            ) : !audit ? (
              <Muted>{auditLoading ? "Loading audit trail…" : "Open the tab to load the audit trail."}</Muted>
            ) : audit.length === 0 ? (
              <Muted>No audit entries recorded yet.</Muted>
            ) : (
              <div style={S.transcript}>
                {audit.map((e) => (
                  <div key={e.id} style={S.listRow}>
                    <span style={{ ...S.auditBadge, color: auditActionColor(e.action) }}>{e.action}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={S.commText}>{e.detail || e.target || "—"}</div>
                      <div style={S.listMeta}>
                        {e.actor} · {relTime(e.ts)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

/**
 * Catches render-phase errors (e.g. inside {@link Room}'s Agents SDK hooks) so
 * a single throw surfaces a readable message instead of a silent blank page.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Glide render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={S.joinWrap} className="glide-join">
        <div style={{ ...S.joinCard, width: 520 }} className="glide-glass glide-join-card">
          <h1 style={{ ...S.brand, fontSize: 28 }}>Glide hit an error</h1>
          <p style={S.tagline}>The chat client failed to render. Details below.</p>
          <pre style={S.bodyPre}>{error.message}</pre>
          {error.stack ? (
            <details style={S.bodyDetails}>
              <summary style={S.bodySummary}>Stack trace</summary>
              <pre style={S.bodyPre}>{error.stack}</pre>
            </details>
          ) : null}
          <button
            style={S.primaryBtn}
            onClick={() => {
              this.setState({ error: null });
              location.reload();
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

function App({ session }: { session: AccessSession }) {
  // The bounded history loader suspends this route while the complete persisted
  // transcript is fetched, preventing partial-history sends and destructive retries.
  return (
    <Suspense
      fallback={
        <div style={{ ...S.shell, alignItems: "center", justifyContent: "center" }} className="glide-shell">
          <span style={{ color: "#9ca3af", fontSize: 15 }}>Loading room…</span>
        </div>
      }
    >
      <Room session={session} />
    </Suspense>
  );
}

/**
 * Top-level router. `/admin` renders the read-only ops dashboard; every other
 * path is the chat app. There's no history API navigation between them (each is
 * a full page load / link), but we still listen for `popstate` so back/forward
 * between the two routes re-renders the right view without a hard reload.
 */
function Root() {
  const [admin, setAdmin] = useState(() => isAdminPath());
  const [session, setSession] = useState<AccessSession>();
  const [sessionError, setSessionError] = useState<string>();
  const [sessionAttempt, setSessionAttempt] = useState(0);
  useEffect(() => {
    const onNav = () => setAdmin(isAdminPath());
    window.addEventListener("popstate", onNav);
    return () => window.removeEventListener("popstate", onNav);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSession(undefined);
    setSessionError(undefined);
    void fetchAccessJson("/api/session", controller.signal)
      .then((value) => {
        const parsed = parsedAccessSession(value);
        if (!parsed) throw new Error("Glide returned a malformed Access identity response.");
        setSession(parsed);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setSessionError(reason instanceof Error ? reason.message : "Glide could not verify your identity.");
        }
      });
    return () => controller.abort();
  }, [sessionAttempt]);

  const content = sessionError ? (
    <AccessCard
      title="Authentication required"
      message={sessionError}
      action={<button style={S.primaryBtn} onClick={() => setSessionAttempt((value) => value + 1)}>Try again</button>}
    />
  ) : !session ? (
    <AccessCard title="Verifying identity" message="Checking your Cloudflare Access session…" />
  ) : admin ? (
    <AdminGate session={session} />
  ) : (
    <App session={session} />
  );
  return (
    <>
      <PointerGlow />
      {content}
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Cloudflare orange is reserved for identity and actions. Operational state
// uses semantic colors; surfaces stay neutral so the data remains dominant.
const GRAD_BRAND = "linear-gradient(110deg,#fdba74 0%,#f6821f 64%,#d96b12 100%)";
const GRAD_CTA = "#f6821f";
const DISPLAY = '"Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// Restrained gradient text recipe for product identity.
const brandText: React.CSSProperties = {
  background: GRAD_BRAND,
  backgroundSize: "100% auto",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  WebkitTextFillColor: "transparent",
  fontFamily: DISPLAY,
};

const S: Record<string, React.CSSProperties> = {
  joinWrap: { minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20, position: "relative" },
  joinCard: { width: 410, maxWidth: "100%", padding: 36, borderRadius: 16, background: "rgba(17,23,34,.88)", border: "1px solid rgba(148,163,184,.2)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", boxShadow: "0 24px 64px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.055)" },
  brand: { ...brandText, margin: 0, fontSize: 42, fontWeight: 700, letterSpacing: -1.2 },
  cfLogoJoin: { height: 32, width: "auto", display: "block", marginBottom: 18 },
  cfMark: { height: 22, width: "auto", display: "block", flexShrink: 0 },
  tagline: { marginTop: 8, marginBottom: 28, color: "#94a3b8", fontSize: 14, lineHeight: 1.55 },
  label: { display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 7, fontWeight: 600 },
  input: { width: "100%", boxSizing: "border-box", padding: "12px 13px", borderRadius: 8, border: "1px solid rgba(148,163,184,.24)", background: "rgba(9,12,17,.72)", color: "#f8fafc", fontSize: 15, outline: "none", boxShadow: "inset 0 1px 0 rgba(255,255,255,.025)" },
  primaryBtn: { marginTop: 18, width: "100%", padding: "13px", borderRadius: 8, border: "1px solid #f6821f", background: GRAD_CTA, color: "#1a1008", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.1, boxShadow: "0 6px 16px rgba(0,0,0,.22)" },

  shell: { display: "flex", flexDirection: "column", height: "100dvh", background: "transparent", color: "#e5e7eb", fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", overflow: "hidden" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", margin: "10px 12px 0", border: "1px solid rgba(148,163,184,.16)", borderRadius: 12, background: "rgba(17,23,34,.82)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: "0 10px 30px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.04)", zIndex: 10 },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  brandSm: { ...brandText, fontWeight: 700, fontSize: 19, letterSpacing: -0.45 },
  safetyPill: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: "#cbd5e1", background: "rgba(148,163,184,.055)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 6, padding: "4px 9px", letterSpacing: 0.15, whiteSpace: "nowrap" },
  safetyDotRead: { width: 6, height: 6, borderRadius: 999, background: "#22c55e" },
  safetyDotWrite: { width: 6, height: 6, borderRadius: 999, background: "#d6a84b" },
  safetyDivider: { color: "#475569", margin: "0 1px" },
  roomPill: { display: "inline-flex", alignItems: "center", gap: 2, background: "rgba(9,12,17,.55)", border: "1px solid rgba(148,163,184,.16)", borderRadius: 7, padding: "4px 10px", color: "#94a3b8", fontSize: 14 },
  roomInput: { background: "transparent", border: 0, color: "#f8fafc", fontSize: 14, width: 92, outline: "none", fontWeight: 600 },
  roomNameInput: { background: "rgba(9,12,17,.55)", border: "1px solid rgba(148,163,184,.16)", borderRadius: 7, padding: "4px 10px", color: "#f8fafc", fontSize: 14, width: 150, outline: "none", fontWeight: 600 },
  badge: { fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 5, textTransform: "uppercase", letterSpacing: 0.55 },
  you: { fontSize: 13, color: "#cbd5e1", fontWeight: 600 },
  warnBar: { padding: "9px 14px", margin: "8px 12px 0", background: "rgba(246,130,31,.09)", color: "#fed7aa", fontSize: 13, border: "1px solid rgba(246,130,31,.24)", borderRadius: 8, backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" },

  body: { display: "flex", flex: 1, minHeight: 0, gap: 10, padding: 10, overflow: "hidden" },
  chatCol: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden", borderRadius: 14, border: "1px solid rgba(148,163,184,.15)", background: "rgba(17,23,34,.68)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: "0 14px 36px rgba(0,0,0,.24), inset 0 1px 0 rgba(255,255,255,.035)" },
  messages: { flex: "2 1 0", minHeight: 0, overflowY: "auto", padding: "22px 22px 10px", display: "flex", flexDirection: "column", gap: 14 },
  empty: { margin: "auto", maxWidth: 480, textAlign: "center", color: "#cbd5e1", fontSize: 14, lineHeight: 1.6 },
  msgRow: { display: "flex", alignItems: "flex-start", gap: 10 },
  avatar: { width: 30, height: 30, borderRadius: 7, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800, flexShrink: 0, color: "#f8fafc", border: "1px solid rgba(148,163,184,.2)", boxShadow: "0 3px 10px rgba(0,0,0,.25)", userSelect: "none", fontFamily: DISPLAY },
  avatarAi: { background: GRAD_CTA, color: "#1a1008", borderColor: "rgba(246,130,31,.55)" },
  avatarUser: { background: "#263244", color: "#e2e8f0" },
  avatarMine: { background: "#9a4b13", color: "#fff7ed", borderColor: "rgba(246,130,31,.38)" },
  bubble: { maxWidth: "78%", padding: "10px 14px", borderRadius: 10, fontSize: 14, lineHeight: 1.55, boxShadow: "0 5px 18px rgba(0,0,0,.18)", animation: "glideIn .22s ease-out" },
  aiBubble: { background: "rgba(23,31,44,.88)", border: "1px solid rgba(148,163,184,.14)", borderTopLeftRadius: 3, borderLeft: "2px solid rgba(246,130,31,.8)" },
  userBubble: { background: "rgba(29,39,55,.88)", border: "1px solid rgba(148,163,184,.17)", borderTopRightRadius: 3 },
  mineBubble: { background: "rgba(74,42,23,.78)", border: "1px solid rgba(246,130,31,.26)" },
  msgWho: { fontSize: 11, fontWeight: 700, color: "#93a3b8", marginBottom: 4, letterSpacing: 0.3, textTransform: "uppercase" },
  msgText: { whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#f1f5f9" },
  toolChip: { marginTop: 8, marginRight: 6, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#93c5fd", background: "rgba(96,165,250,.08)", border: "1px solid rgba(96,165,250,.2)", borderRadius: 6, padding: "3px 8px" },
  typing: { display: "inline-flex", alignItems: "center", height: 14 },

  // Chat-led onboarding opener (GuidedIntro)
  introWrap: { margin: "auto 0", width: "100%", maxWidth: 580, display: "flex", justifyContent: "flex-start" },
  introBubble: { width: "100%", boxSizing: "border-box", background: "rgba(23,31,44,.86)", border: "1px solid rgba(148,163,184,.15)", borderLeft: "2px solid #f6821f", borderRadius: 12, borderTopLeftRadius: 4, padding: "20px 22px", boxShadow: "0 12px 34px rgba(0,0,0,.22)" },
  introTitle: { fontSize: 19, fontWeight: 700, color: "#f8fafc", marginBottom: 8, fontFamily: DISPLAY, letterSpacing: -0.2 },
  introText: { fontSize: 14.5, lineHeight: 1.6, color: "#cbd5e1", marginBottom: 16 },
  introChoices: { display: "flex", gap: 10, flexWrap: "wrap" },
  introChoice: { padding: "10px 16px", borderRadius: 8, border: "1px solid #f6821f", background: GRAD_CTA, color: "#1a1008", fontWeight: 700, fontSize: 14, cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,.2)", fontFamily: DISPLAY },
  introFoot: { marginTop: 16, fontSize: 12, color: "#64748b", lineHeight: 1.5 },
  introLink: { background: "transparent", border: 0, color: "#60a5fa", fontSize: 12, cursor: "pointer", textDecoration: "underline", padding: 0 },

  composer: { display: "flex", gap: 9, padding: 9, margin: "7px 8px 8px", border: "1px solid rgba(148,163,184,.16)", borderRadius: 11, background: "rgba(17,23,34,.9)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", boxShadow: "0 8px 24px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.035)" },
  connectionNotice: { padding: "8px 14px", background: "rgba(245,158,11,.10)", borderTop: "1px solid rgba(245,158,11,.25)", color: "#fcd34d", fontSize: 12.5 },
  deliveryNotice: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "9px 14px", background: "rgba(244,63,94,.10)", borderTop: "1px solid rgba(244,63,94,.28)", color: "#fecdd3", fontSize: 12.5 },
  deliveryRetryBtn: { flexShrink: 0, border: "1px solid rgba(244,63,94,.45)", background: "rgba(244,63,94,.16)", color: "#fff", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontWeight: 700 },
  textarea: { flex: 1, resize: "none", padding: "11px 13px", borderRadius: 8, border: "1px solid rgba(148,163,184,.18)", background: "rgba(9,12,17,.62)", color: "#f8fafc", fontSize: 14, lineHeight: 1.5, fontFamily: "inherit", outline: "none" },
  sendBtn: { alignSelf: "stretch", padding: "0 22px", borderRadius: 8, border: "1px solid #f6821f", background: GRAD_CTA, color: "#1a1008", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.2, boxShadow: "0 4px 12px rgba(0,0,0,.2)" },
  stopBtn: { alignSelf: "stretch", padding: "0 18px", borderRadius: 8, border: "1px solid rgba(244,63,94,.45)", background: "rgba(244,63,94,.1)", color: "#fecdd3", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.2 },
  stallHint: { fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 },

  sidebar: { width: 356, flexShrink: 0, border: "1px solid rgba(148,163,184,.15)", borderRadius: 14, background: "rgba(17,23,34,.68)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: "0 14px 36px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.035)", overflowY: "auto", padding: 11, display: "flex", flexDirection: "column", gap: 10 },
  errorBox: { background: "rgba(244,63,94,.14)", border: "1px solid rgba(244,63,94,.5)", color: "#fecdd3", padding: "9px 12px", borderRadius: 10, fontSize: 13 },
  migrationRecovery: { padding: 11, borderRadius: 8, border: "1px solid rgba(244,63,94,.35)", background: "rgba(127,29,29,.14)" },
  section: { flexShrink: 0, background: "rgba(23,31,44,.68)", border: "1px solid rgba(148,163,184,.13)", borderRadius: 9, padding: "12px 13px", boxShadow: "inset 0 1px 0 rgba(255,255,255,.025)" },
  sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  sectionTitle: { margin: 0, fontSize: 11.5, fontWeight: 700, color: "#a5b4c9", textTransform: "uppercase", letterSpacing: 0.8, fontFamily: DISPLAY },
  miniBtn: { fontSize: 12, fontWeight: 600, border: "1px solid rgba(148,163,184,.22)", background: "rgba(148,163,184,.07)", color: "#cbd5e1", borderRadius: 6, padding: "3px 9px", cursor: "pointer" },

  actionCard: { position: "relative", background: "rgba(20,27,39,.88)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 8, padding: 12, marginBottom: 9, boxShadow: "inset 2px 0 0 rgba(214,168,75,.78)", overflow: "hidden", animation: "glidePop .2s ease-out" },
  actionTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  method: { fontSize: 10, fontWeight: 800, color: "#fff", padding: "2px 7px", borderRadius: 5, letterSpacing: 0.5, boxShadow: "0 1px 6px rgba(0,0,0,.35)" },
  product: { fontSize: 12, color: "#a5b4c9", fontWeight: 600 },
  actionSummary: { fontSize: 14, marginBottom: 6, color: "#f1f5f9" },
  path: { display: "block", fontSize: 11, color: "#7dd3fc", background: "rgba(7,11,22,.7)", borderRadius: 6, padding: "5px 7px", wordBreak: "break-all", border: "1px solid rgba(56,189,248,.14)" },
  bodyDetails: { marginTop: 6 },
  bodySummary: { fontSize: 11, color: "#93a3b8", cursor: "pointer", userSelect: "none" },
  bodyPre: { margin: "6px 0 0", maxHeight: 220, overflow: "auto", fontSize: 11, lineHeight: 1.45, color: "#e5e7eb", background: "rgba(7,11,22,.7)", border: "1px solid rgba(148,163,184,.12)", borderRadius: 6, padding: "6px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  bodyNote: { marginTop: 6, fontSize: 11, color: "#fbbf24", lineHeight: 1.45 },
  actionMeta: { fontSize: 11, color: "#64748b", margin: "6px 0" },
  actionBtns: { display: "flex", gap: 8 },
  applyBtn: { flex: 1, padding: "8px 0", borderRadius: 6, border: "1px solid #f6821f", background: "#f6821f", color: "#1a1008", fontWeight: 800, cursor: "pointer" },
  dangerBtn: { width: "100%", padding: "9px 10px", borderRadius: 6, border: "1px solid rgba(244,63,94,.62)", background: "rgba(190,24,93,.22)", color: "#fecdd3", fontWeight: 800, cursor: "pointer" },
  rejectBtn: { flex: 1, padding: "8px 0", borderRadius: 6, border: "1px solid rgba(148,163,184,.2)", background: "rgba(148,163,184,.055)", color: "#cbd5e1", cursor: "pointer" },
  autoRevertRow: { display: "flex", alignItems: "center", gap: 7, marginTop: 9, fontSize: 12, color: "#9aa7b8", cursor: "pointer", lineHeight: 1.35 },
  rollbackCard: { background: "rgba(20,27,39,.88)", border: "1px solid rgba(251,191,36,.24)", borderRadius: 8, padding: 12, marginBottom: 9, boxShadow: "inset 2px 0 0 rgba(251,191,36,.7)" },
  rollbackMeta: { fontSize: 11, color: "#fbbf24", margin: "2px 0 6px" },
  rollbackRevert: { fontSize: 12, color: "#9aa7b8", marginBottom: 9, lineHeight: 1.4 },
  scheduledRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 9, padding: "6px 9px", background: "rgba(56,189,248,.08)", border: "1px solid rgba(56,189,248,.24)", borderRadius: 7 },
  scheduledBadge: { fontSize: 11, fontWeight: 700, color: "#0b1220", background: "#38bdf8", borderRadius: 5, padding: "2px 7px", whiteSpace: "nowrap" },
  scheduledText: { fontSize: 12, color: "#bae6fd", flex: "1 1 140px", lineHeight: 1.35 },
  scheduledCancel: { fontSize: 12, fontWeight: 600, border: "1px solid rgba(56,189,248,.4)", background: "transparent", color: "#7dd3fc", borderRadius: 6, padding: "3px 9px", cursor: "pointer" },
  scheduleForm: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7, marginTop: 9 },
  scheduleInput: { fontSize: 12, color: "#e2e8f0", background: "rgba(15,20,30,.85)", border: "1px solid rgba(148,163,184,.28)", borderRadius: 6, padding: "4px 8px", colorScheme: "dark" },
  scheduleToggle: { fontSize: 12, fontWeight: 600, border: "1px dashed rgba(56,189,248,.35)", background: "transparent", color: "#7dd3fc", borderRadius: 6, padding: "4px 10px", cursor: "pointer", marginTop: 9 },
  scheduleCancelForm: { fontSize: 15, lineHeight: 1, color: "#9aa7b8", background: "transparent", border: "none", cursor: "pointer", padding: "0 4px" },
  approvalBox: { marginTop: 9, padding: "7px 10px", background: "rgba(167,139,250,.08)", border: "1px solid rgba(167,139,250,.28)", borderRadius: 7 },
  approvalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  approvalBadge: { fontSize: 11, fontWeight: 700, color: "#0b1220", background: "#a78bfa", borderRadius: 5, padding: "2px 7px", whiteSpace: "nowrap" },
  approvalCount: { fontSize: 12, fontWeight: 600, color: "#c4b5fd" },
  approvalReason: { fontSize: 12, color: "#d6ccf7", marginTop: 5, lineHeight: 1.4 },
  approvalWho: { fontSize: 11, color: "#a99fc4", marginTop: 4, wordBreak: "break-all" },
  approveBtn: { flex: 1, fontSize: 13, fontWeight: 700, border: "none", background: "#a78bfa", color: "#0b1220", borderRadius: 7, padding: "8px 12px", cursor: "pointer" },
  approvedByMe: { flex: 1, fontSize: 13, fontWeight: 600, color: "#c4b5fd", display: "flex", alignItems: "center", padding: "8px 4px" },

  kv: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, padding: "5px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  kvKey: { color: "#93a3b8" },
  kvKeyStandalone: { color: "#93a3b8", fontSize: 13, margin: "8px 0 5px" },
  kvVal: { color: "#f1f5f9", textAlign: "right", wordBreak: "break-all", fontWeight: 500 },

  resultRow: { display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0" },
  dot: { width: 9, height: 9, borderRadius: 999, marginTop: 5, flexShrink: 0, boxShadow: "0 0 8px currentColor" },
  resultSummary: { fontSize: 13, color: "#e5e7eb" },
  resultDetail: { fontSize: 12, color: "#93a3b8" },

  tokenStatus: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 },
  hint: { margin: "8px 0 0", fontSize: 11, color: "#64748b", lineHeight: 1.5 },
  guidanceNotice: { margin: "10px 0", padding: "9px 12px", borderRadius: 9, background: "rgba(9,13,24,.55)", border: "1px solid rgba(148,163,184,.14)", color: "#cbd5e1", fontSize: 12 },
  guidanceEditor: { border: "1px solid rgba(148,163,184,.14)", borderRadius: 9, padding: 14, background: "rgba(9,12,17,.5)", margin: "8px 0" },
  guidanceTextarea: { width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 150, padding: "12px 14px", borderRadius: 8, border: "1px solid #2a3442", background: "rgba(9,12,17,.72)", color: "#f8fafc", fontSize: 14, lineHeight: 1.5, fontFamily: "inherit", outline: "none" },
  guidanceCheck: { display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, color: "#cbd5e1", cursor: "pointer" },
  guidanceBtnRow: { display: "flex", gap: 10, marginTop: 16, alignItems: "center" },
  guidanceSaveBtn: { padding: "10px 18px", borderRadius: 7, border: "1px solid #f6821f", background: GRAD_CTA, color: "#1a1008", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: DISPLAY },
  guidanceRowTop: { display: "flex", alignItems: "center", gap: 10 },
  guidanceBody: { marginTop: 6, fontSize: 13, color: "#cbd5e1", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  guidanceActions: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 },
  rejectBtnSm: { fontSize: 12, border: "1px solid #7f1d1d", background: "transparent", color: "#fca5a5", borderRadius: 6, padding: "2px 8px", cursor: "pointer" },
  inviteRow: { display: "flex", gap: 8 },
  miniPrimary: { flexShrink: 0, padding: "0 15px", borderRadius: 7, border: "1px solid #f6821f", background: GRAD_CTA, color: "#1a1008", fontWeight: 800, cursor: "pointer", fontFamily: DISPLAY },
  linkRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 6 },
  linkCode: { flex: 1, fontSize: 11, color: "#7dd3fc", background: "rgba(7,11,22,.7)", borderRadius: 6, padding: "6px 8px", wordBreak: "break-all", border: "1px solid rgba(56,189,248,.14)" },
  inviteItem: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  inviteBy: { fontSize: 11, color: "#64748b", flexShrink: 0 },
  roleSelect: { fontSize: 11, fontWeight: 600, border: "1px solid rgba(148,163,184,.22)", background: "rgba(9,12,17,.55)", color: "#cbd5e1", borderRadius: 6, padding: "2px 6px", cursor: "pointer", outline: "none" },
  roleViewerBadge: { fontSize: 11, fontWeight: 600, color: "#38bdf8", flexShrink: 0 },
  auditBadge: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", flexShrink: 0, minWidth: 74, marginTop: 1 },

  progressWrap: { position: "relative", height: 7, borderRadius: 999, background: "rgba(148,163,184,.16)", overflow: "hidden", margin: "10px 0 12px" },
  progressBar: { height: "100%", borderRadius: 999, background: "#f6821f", transition: "width .3s ease-out" },
  checklist: { display: "flex", flexDirection: "column", gap: 7 },
  checkItem: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, cursor: "pointer", lineHeight: 1.4 },
  naBadge: { fontSize: 10, fontWeight: 700, color: "#9aa4b2", border: "1px solid #3a4253", borderRadius: 5, padding: "0 5px", lineHeight: "16px", flexShrink: 0, letterSpacing: ".04em" },

  phaseTags: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 },
  phaseTag: { fontSize: 11, color: "#93c5fd", background: "rgba(96,165,250,.08)", border: "1px solid rgba(96,165,250,.2)", borderRadius: 5, padding: "2px 7px", fontWeight: 600 },
  recNote: { marginTop: 8, fontSize: 12, color: "#fcd34d", background: "rgba(251,191,36,.06)", border: "1px solid rgba(251,191,36,.18)", borderRadius: 8, padding: "7px 10px", lineHeight: 1.45 },
  recMsg: { marginTop: 8, fontSize: 12.5, color: "#7dd3fc", background: "rgba(56,189,248,.07)", border: "1px solid rgba(56,189,248,.2)", borderRadius: 8, padding: "8px 10px", whiteSpace: "pre-wrap" },
  recGroupLabel: { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "#93a3b8", margin: "2px 0 6px" },
  recRow: { border: "1px solid rgba(148,163,184,.14)", borderRadius: 9, padding: "9px 11px", marginBottom: 8, background: "rgba(9,12,17,.4)" },
  impactRow: { margin: "8px 0 0" },
  impactBox: { display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 9px", border: "1px solid", borderRadius: 8, background: "rgba(9,12,17,.4)" },
  impactChip: { fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 },
  impactText: { fontSize: 12, color: "#cbd5e1", lineHeight: 1.45 },
  impactErr: { fontSize: 12, color: "#fca5a5" },
  postureHead: { display: "flex", alignItems: "center", gap: 11, marginBottom: 10 },
  postureGrade: { fontSize: 26, fontWeight: 800, lineHeight: 1, width: 44, height: 44, display: "grid", placeItems: "center", borderRadius: 10, border: "2px solid", background: "rgba(9,12,17,.5)", fontFamily: DISPLAY, flexShrink: 0 },
  driftControls: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" },
  driftWatchOn: { borderColor: "rgba(52,211,153,.4)", background: "rgba(52,211,153,.1)", color: "#6ee7b7" },
  postureBaselineMeta: { fontSize: 11, color: "#8595a8", marginBottom: 8 },
  driftBanner: { border: "1px solid rgba(251,191,36,.3)", background: "rgba(251,191,36,.06)", borderRadius: 8, padding: "9px 11px", marginBottom: 10 },
  driftBannerHead: { fontSize: 12.5, fontWeight: 700, color: "#fbbf24", lineHeight: 1.4, marginBottom: 7 },
  driftRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "5px 0", flexWrap: "wrap" },
  driftText: { fontSize: 12, color: "#cbd5e1", lineHeight: 1.4 },
  driftImproved: { fontSize: 11, color: "#6ee7b7", marginTop: 6 },
  recTitleRow: { display: "flex", alignItems: "center", gap: 8 },
  recDot: { width: 8, height: 8, borderRadius: 999, flexShrink: 0 },
  recTitle: { fontSize: 13.5, fontWeight: 600, color: "#f1f5f9", lineHeight: 1.35 },
  recMeta: { fontSize: 11, color: "#8595a8", margin: "3px 0 0 16px", textTransform: "capitalize" },
  recWhy: { fontSize: 12, color: "#9aa7b8", lineHeight: 1.45, margin: "6px 0 0 16px" },
  recActionRow: { display: "flex", alignItems: "center", gap: 10, margin: "9px 0 0 16px", flexWrap: "wrap" },
  recQueueBtn: { padding: "5px 14px", borderRadius: 6, border: "1px solid #f6821f", background: "#f6821f", color: "#1a1008", fontWeight: 800, fontSize: 12.5, cursor: "pointer" },
  recAskBtn: { padding: "5px 12px", borderRadius: 6, border: "1px solid rgba(148,163,184,.24)", background: "rgba(148,163,184,.07)", color: "#cbd5e1", fontWeight: 600, fontSize: 12.5, cursor: "pointer" },
  recBtnDisabled: { opacity: 0.5, cursor: "not-allowed" },
  recApplied: { fontSize: 12.5, fontWeight: 700, color: "#6ee7b7" },
  recQueued: { fontSize: 12.5, fontWeight: 700, color: "#fbbf24" },
  recProposal: { fontSize: 12, color: "#8595a8", fontStyle: "italic" },
  recFlag: { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "#fca5a5", background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.22)", borderRadius: 4, padding: "1px 6px" },
  recDoc: { fontSize: 12, color: "#7dd3fc", textDecoration: "none", fontWeight: 600 },
  docLinksHint: { margin: "0 0 8px", fontSize: 12, color: "#8595a8", lineHeight: 1.45 },
  docLinkList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 },
  docLink: { display: "flex", alignItems: "center", gap: 8, textDecoration: "none", border: "1px solid rgba(148,163,184,.14)", borderRadius: 8, padding: "8px 10px", background: "rgba(9,12,17,.4)" },
  docLinkTitle: { flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "#7dd3fc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  docLinkTag: { flexShrink: 0, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "#fdba74", background: "rgba(246,130,31,.08)", border: "1px solid rgba(246,130,31,.22)", borderRadius: 4, padding: "1px 6px" },
  checkBox: { marginTop: 10, fontSize: 12, lineHeight: 1.5, border: "1px solid rgba(148,163,184,.14)", borderRadius: 8, padding: "8px 10px", whiteSpace: "pre-wrap" },
  snapRow: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  snapZone: { fontSize: 13, color: "#e5e7eb", wordBreak: "break-all" },
  snapMeta: { fontSize: 11, color: "#64748b" },
  snapRestore: { flexShrink: 0, padding: "6px 13px", borderRadius: 8, border: "1px solid rgba(244,63,94,.45)", background: "rgba(244,63,94,.14)", color: "#fecdd3", fontSize: 12, fontWeight: 700, cursor: "pointer" },

  tfRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  tfName: { fontSize: 11, color: "#7dd3fc", wordBreak: "break-all" },

  // Onboarding wizard
  // Split layout: the wizard lives in a bounded top pane; the chat sits below it.
  wizPane: { display: "flex", flexDirection: "column", flex: "3 1 0", minHeight: 0, borderBottom: "1px solid rgba(148,163,184,.12)" },
  wizWrap: { flex: 1, overflowY: "auto", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "28px 20px" },
  wizCard: { width: "100%", maxWidth: 640, background: "rgba(17,23,34,.92)", border: "1px solid rgba(148,163,184,.18)", borderRadius: 14, padding: 24, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", boxShadow: "0 20px 54px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.045)" },
  wizHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 },
  wizBrand: { ...brandText, fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" },
  wizStepMeta: { fontSize: 12, color: "#93a3b8", marginTop: 3 },
  wizSkip: { background: "transparent", border: 0, color: "#64748b", fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  wizProgress: { height: 7, borderRadius: 999, background: "rgba(148,163,184,.16)", overflow: "hidden", marginBottom: 18 },
  wizProgressBar: { height: "100%", background: "#f6821f", transition: "width .3s ease-out" },
  wizTitle: { margin: "0 0 10px", fontSize: 24, fontWeight: 700, color: "#f8fafc", lineHeight: 1.22, fontFamily: DISPLAY, letterSpacing: -0.4 },
  wizWhy: { display: "flex", gap: 9, alignItems: "flex-start", background: "rgba(56,189,248,.07)", border: "1px solid rgba(56,189,248,.2)", borderRadius: 11, padding: "11px 13px", fontSize: 13, color: "#cbd5e1", lineHeight: 1.5, marginBottom: 18 },
  wizWhyIcon: { color: "#38bdf8", fontWeight: 800, flexShrink: 0 },
  wizBody: { minHeight: 120, marginBottom: 16 },
  wizInput: { width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 8, border: "1px solid #2a3442", background: "rgba(9,12,17,.72)", color: "#f8fafc", fontSize: 15, outline: "none" },
  wizNote: { fontSize: 13, color: "#fed7aa", background: "rgba(120,53,15,.4)", border: "1px solid rgba(249,115,22,.35)", borderRadius: 9, padding: "9px 12px", marginBottom: 10 },
  wizMutedRow: { textAlign: "center", color: "#64748b", fontSize: 12 },
  wizHintRow: { fontSize: 12, color: "#64748b", marginTop: 8 },
  wizGroupLabel: { fontSize: 13, fontWeight: 600, color: "#cbd5e1", marginBottom: 8 },
  wizGroupHint: { fontSize: 12, fontWeight: 400, color: "#64748b" },
  wizPreviewMsg: { marginTop: 10, fontSize: 13, color: "#7dd3fc", background: "rgba(56,189,248,.07)", border: "1px solid rgba(56,189,248,.2)", borderRadius: 9, padding: "9px 12px", whiteSpace: "pre-wrap" },
  uploadRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  uploadBtn: { padding: "12px 18px", borderRadius: 8, border: "1px dashed rgba(96,165,250,.35)", background: "rgba(96,165,250,.06)", color: "#93c5fd", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  fileLabel: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "#e5e7eb", background: "rgba(7,11,22,.7)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 8, padding: "6px 10px", wordBreak: "break-all" },
  clearFile: { background: "transparent", border: 0, color: "#64748b", fontSize: 12, cursor: "pointer", textDecoration: "underline" },
  formatHint: { fontSize: 12, color: "#93a3b8", marginTop: 8, lineHeight: 1.5 },

  choiceGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 12 },
  choiceCard: { textAlign: "left", display: "flex", flexDirection: "column", gap: 6, padding: "15px 17px", borderRadius: 9, border: "1px solid rgba(148,163,184,.17)", background: "rgba(23,31,44,.7)", color: "#e5e7eb", cursor: "pointer", transition: "border-color .18s, background .18s, box-shadow .18s", boxShadow: "inset 0 1px 0 rgba(255,255,255,.025)" },
  choiceCardOn: { borderColor: "rgba(246,130,31,.72)", background: "rgba(246,130,31,.09)", boxShadow: "inset 3px 0 0 #f6821f" },
  choiceTitle: { fontSize: 16, fontWeight: 700, color: "#f8fafc", fontFamily: DISPLAY, letterSpacing: -0.2 },
  choiceDesc: { fontSize: 13, color: "#93a3b8", lineHeight: 1.45 },

  chipWrap: { display: "flex", flexWrap: "wrap", gap: 10 },
  chip: { padding: "8px 13px", borderRadius: 7, border: "1px solid #2a3442", background: "rgba(9,12,17,.5)", color: "#e5e7eb", fontSize: 14, cursor: "pointer", transition: "border-color .18s, background .18s, color .18s" },
  chipOn: { borderColor: "rgba(246,130,31,.7)", background: "rgba(246,130,31,.1)", color: "#fed7aa", fontWeight: 700 },

  reviewList: { display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 },

  wizSummary: { display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 0", borderTop: "1px solid rgba(148,163,184,.12)", marginBottom: 4 },
  wizSummaryChip: { fontSize: 12, color: "#e5e7eb", background: "rgba(9,12,17,.58)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 6, padding: "4px 9px" },

  wizFooter: { display: "flex", alignItems: "center", gap: 10, paddingTop: 8 },
  wizBack: { padding: "11px 20px", borderRadius: 7, border: "1px solid rgba(148,163,184,.2)", background: "rgba(148,163,184,.055)", color: "#cbd5e1", fontWeight: 600, cursor: "pointer" },
  wizPrimary: { padding: "11px 24px", borderRadius: 7, border: "1px solid #f6821f", background: GRAD_CTA, color: "#1a1008", fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: DISPLAY, letterSpacing: 0.1 },
  wizPrimarySm: { padding: "9px 17px", borderRadius: 7, border: "1px solid #16a34a", background: "#15803d", color: "#fff", fontWeight: 700, cursor: "pointer" },

  // Admin dashboard (/admin)
  adminTag: { fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.7, color: "#fed7aa", background: "rgba(246,130,31,.1)", border: "1px solid rgba(246,130,31,.28)", borderRadius: 5, padding: "3px 8px", fontFamily: DISPLAY },
  roomNameTag: { fontSize: 14, fontWeight: 600, color: "#f8fafc", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  adminRoomsWrap: { marginTop: 22, borderTop: "1px solid rgba(148,163,184,.16)", paddingTop: 16 },
  adminRoomsHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  adminRoomsList: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" },
  adminRoomRow: { display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start", textAlign: "left", width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 8, border: "1px solid rgba(148,163,184,.16)", background: "rgba(9,12,17,.5)", color: "#e5e7eb", cursor: "pointer" },
  adminRoomName: { fontSize: 14, fontWeight: 700, color: "#f8fafc", wordBreak: "break-all" },
  adminRoomMeta: { fontSize: 11.5, color: "#94a3b8", wordBreak: "break-all" },
  headerLink: { fontSize: 13, fontWeight: 700, color: "#fed7aa", textDecoration: "none", border: "1px solid rgba(246,130,31,.26)", background: "rgba(246,130,31,.075)", borderRadius: 6, padding: "5px 10px" },

  adminStats: { display: "flex", flexWrap: "wrap", gap: 9, padding: 10, margin: "10px 12px 0", border: "1px solid rgba(148,163,184,.14)", borderRadius: 12, background: "rgba(17,23,34,.68)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: "0 10px 30px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.03)" },
  statCard: { flex: "1 1 120px", minWidth: 110, background: "rgba(23,31,44,.72)", border: "1px solid rgba(148,163,184,.13)", borderRadius: 8, padding: "13px 15px", boxShadow: "inset 0 1px 0 rgba(255,255,255,.025)", animation: "glidePop .2s ease-out" },
  statNum: { fontSize: 30, fontWeight: 700, lineHeight: 1.05, letterSpacing: -1, fontFamily: DISPLAY },
  statLabel: { marginTop: 5, fontSize: 11, fontWeight: 700, color: "#93a3b8", textTransform: "uppercase", letterSpacing: 0.6 },

  tabBar: { display: "flex", gap: 5, padding: 6, margin: "10px 12px 0", border: "1px solid rgba(148,163,184,.14)", borderRadius: 10, background: "rgba(17,23,34,.7)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", boxShadow: "0 8px 24px rgba(0,0,0,.18)", flexWrap: "wrap" },
  tab: { padding: "7px 12px", borderRadius: 5, border: "1px solid transparent", background: "transparent", color: "#94a3b8", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  tabOn: { background: "rgba(246,130,31,.09)", border: "1px solid rgba(246,130,31,.26)", color: "#fed7aa", boxShadow: "inset 0 -2px 0 #f6821f" },

  adminContent: { flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px 32px", display: "flex", flexDirection: "column", gap: 14 },
  adminLoading: { color: "#9ca3af", fontSize: 14, textAlign: "center", padding: "20px 0" },

  panel: { background: "rgba(20,27,39,.76)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 10, padding: 17, boxShadow: "0 8px 26px rgba(0,0,0,.16), inset 0 1px 0 rgba(255,255,255,.025)" },
  panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 },
  panelTitle: { margin: 0, fontSize: 14, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.2, fontFamily: DISPLAY },
  panelMeta: { fontSize: 11, color: "#64748b", fontWeight: 600 },

  transcript: { display: "flex", flexDirection: "column", gap: 14 },
  commRow: { display: "flex", alignItems: "flex-start", gap: 10 },
  commWho: { fontSize: 12, fontWeight: 700, color: "#e5e7eb", marginBottom: 3 },
  commRole: { fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 },
  commText: { fontSize: 13, lineHeight: 1.55, color: "#cbd5e1", whiteSpace: "pre-wrap", wordBreak: "break-word" },

  listRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(148,163,184,.1)" },
  listMeta: { fontSize: 11, color: "#64748b", flexShrink: 0 },

  docRow: { border: "1px solid rgba(148,163,184,.13)", borderRadius: 8, marginBottom: 9, overflow: "hidden", background: "rgba(23,31,44,.62)", boxShadow: "inset 0 1px 0 rgba(255,255,255,.02)" },
  docHeadRow: { display: "flex", alignItems: "flex-start", gap: 12, padding: "13px 15px", cursor: "pointer" },
  docTitle: { fontSize: 14, fontWeight: 700, color: "#f8fafc" },
  docPath: { fontSize: 11, color: "#7dd3fc", wordBreak: "break-all" },
  docSummary: { fontSize: 12, color: "#93a3b8", marginTop: 4, lineHeight: 1.45 },
  docMetaCol: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0, textAlign: "right" },
  docWhen: { fontSize: 12, color: "#e5e7eb", fontWeight: 600 },
  docSize: { fontSize: 11, color: "#64748b" },
  docToggle: { fontSize: 11, fontWeight: 700, color: "#fdba74", marginTop: 2 },
  docBody: { borderTop: "1px solid rgba(148,163,184,.12)", padding: "6px 16px 16px", background: "rgba(7,11,22,.5)", maxHeight: 520, overflowY: "auto" },

  // Minimal Markdown renderer (dev-docs viewer)
  mdRoot: { fontSize: 13, lineHeight: 1.6, color: "#cbd5e1" },
  mdH1: { fontSize: 20, fontWeight: 700, color: "#f8fafc", margin: "18px 0 10px", lineHeight: 1.25, fontFamily: DISPLAY, letterSpacing: -0.3 },
  mdH2: { fontSize: 16, fontWeight: 700, color: "#f8fafc", margin: "16px 0 8px", lineHeight: 1.3, fontFamily: DISPLAY, letterSpacing: -0.2 },
  mdH3: { fontSize: 14, fontWeight: 700, color: "#e5e7eb", margin: "14px 0 6px", fontFamily: DISPLAY },
  mdP: { margin: "0 0 10px" },
  mdCodeInline: { fontFamily: MONO, fontSize: 12, color: "#fdba74", background: "rgba(246,130,31,.075)", border: "1px solid rgba(246,130,31,.18)", borderRadius: 4, padding: "1px 5px" },
  mdPre: { margin: "0 0 12px", padding: "11px 13px", background: "rgba(7,11,22,.7)", border: "1px solid rgba(148,163,184,.14)", borderRadius: 9, overflowX: "auto", fontFamily: MONO, fontSize: 12, lineHeight: 1.5, color: "#e5e7eb", whiteSpace: "pre" },
  mdList: { margin: "0 0 12px", paddingLeft: 22 },
  mdLi: { margin: "3px 0" },
  mdQuote: { margin: "0 0 12px", padding: "6px 14px", borderLeft: "3px solid #f6821f", background: "rgba(246,130,31,.055)", color: "#cbd5e1", borderRadius: "0 6px 6px 0" },
  mdHr: { border: 0, borderTop: "1px solid rgba(148,163,184,.14)", margin: "16px 0" },
  mdA: { color: "#7dd3fc", textDecoration: "underline" },
  mdTableWrap: { overflowX: "auto", margin: "0 0 12px" },
  mdTable: { borderCollapse: "collapse", width: "100%", fontSize: 12 },
  mdTh: { border: "1px solid rgba(148,163,184,.14)", padding: "6px 10px", textAlign: "left", background: "rgba(17,26,46,.6)", color: "#e5e7eb", fontWeight: 700 },
  mdTd: { border: "1px solid rgba(148,163,184,.14)", padding: "6px 10px", color: "#cbd5e1", verticalAlign: "top" },
};

const rootEl = document.getElementById("root")!;
try {
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (err) {
  // Synchronous mount/import failures can't be caught by <ErrorBoundary>;
  // surface them instead of leaving a blank page.
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  rootEl.textContent = `Glide failed to start:\n\n${msg}`;
  rootEl.setAttribute(
    "style",
    "white-space:pre-wrap;word-break:break-word;padding:24px;font:13px ui-monospace,monospace;color:#fecaca;background:#0b1020;min-height:100vh",
  );
  console.error("Glide mount error:", err);
}
