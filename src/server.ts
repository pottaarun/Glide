/**
 * Glide — the Worker entry point and the `GlideAgent` Durable Object.
 *
 * `GlideAgent` is an {@link AIChatAgent} (so it gets streaming chat + persisted
 * messages + resumable streams) AND carries synced {@link GlideState} (the
 * room's persistent memory + the pending-action approval queue + invites).
 *
 * The safety contract (see `system-prompt.ts`): READ tools run immediately, but
 * every CHANGE tool only QUEUES a {@link PendingAction}. The real Cloudflare API
 * write happens only when a human clicks Apply (the `applyAction` RPC below).
 *
 * The Cloudflare API token is entered in the GUI and stored AES-256-GCM
 * **encrypted at rest** in this DO's SQLite, keyed off the Worker-held
 * `GLIDE_TOKEN_KEY` secret. It is never synced, logged, or returned; only a
 * masked last-4 is exposed for status. There is deliberately no deployment-wide
 * token fallback: a room can use only the credential stored in that room.
 */

import { AIChatAgent } from "@cloudflare/ai-chat";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  callable,
  getAgentByName,
  getCurrentAgent,
  routeAgentRequest,
  type AgentContext,
  type Connection,
  type ConnectionContext,
} from "agents";
import { MessageType, parseProtocolMessage } from "agents/chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  type StreamTextOnFinishCallback,
  type ToolCallRepairFunction,
  type ToolSet,
  type UIMessage,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

import {
  accessAuthErrorResponse,
  accessIdentityFromHeaders,
  authenticateAccessRequest,
  canonicalizeEmail,
  isCloudflareEmployeeEmail,
  requestWithAccessIdentity,
  type AccessIdentity,
  type AccessSession,
} from "./access-auth";
import { canonicalizeApiPath, canonicalizeDomainName, zoneIdFromApiPath } from "./api-path";
import {
  cfGet,
  cfGetAll,
  cfRequest,
  findZoneByName,
  getZoneDnssecStatus,
  getZoneHstsEnabled,
  getZoneManagedWafDeployed,
  getZoneSettingValue,
  getZoneSslMode,
  getZoneTraffic24h,
  listAccounts,
  listZones,
  resolveRulesetEntrypointBaseline,
  resolveTargetAccountId,
  rulesetRuleForPut,
  verifyToken,
  type AccountSummary,
  type ZoneSummary,
} from "./cf-api";
import {
  EMPTY_BUSINESS_PROFILE,
  INITIAL_GLIDE_STATE,
  isValidRoomStorageName,
  isValidRoomId,
  LEGACY_CHAT_RECOVERY_CONFIRMATION,
  MAX_ROOM_STORAGE_NAME_BYTES,
  mergeDocLinks,
  normalizeRoomName,
  ROOM_DELETE_CONFIRMATION,
  roomStorageName,
  type ActionResult,
  type BusinessProfile,
  type DocChunk,
  type DocsIndexState,
  type GlideMessageMetadata,
  type GlideState,
  type GuidanceDoc,
  type Invite,
  type LegacyChatMigrationStatus,
  type LiveZoneFacts,
  type MigrationCheck,
  type MigrationPlan,
  type MigrationPlanRule,
  type OnboardingPath,
  type OnboardingState,
  type OnboardingStep,
  type PendingAction,
  type PendingRollback,
  type RoomAccessStatus,
  type RoomAuditAction,
  type RoomAuditEntry,
  type RoomMember,
  type RoomRole,
  type PostureDeltaView,
  type PostureDriftView,
  type RoomSummary,
  type SecurityPostureCheckView,
  type SecurityPostureReport,
  type SetupType,
  type TerraformArtifact,
  type WriteMethod,
} from "./shared";
import {
  formatRecommendationsForModel,
  industryLabel,
  recommendConfigurations,
  recommendationToPending,
} from "./recommendations";
import {
  diffPosture,
  formatDriftForModel,
  formatPostureForModel,
  isPostureFixQueueable,
  postureFixToPending,
  scorePosture,
  type PostureCheck,
  type PostureDelta,
  type PostureDrift,
  type PostureReport,
  type ZonePostureFacts,
} from "./posture";
import { estimateBlastRadius, formatBlastRadius, type BlastRadiusEstimate } from "./blast-radius";
import { buildRollbackPlan, invertibleSetting } from "./rollback";
import {
  boundedMigrationPreviewRules,
  buildConfigData,
  configFilesSizeError,
  configSizeError,
  diffReport,
  exportMigrationCsv,
  generateMigrationTerraform,
  listMigrationProviders,
  MAX_CONFIG_BYTES,
  MAX_CONFIG_FILES,
  MAX_MIGRATION_PREVIEW_RULES,
  MIGRATION_SNAPSHOT_DISABLED,
  MIGRATION_VALIDATION_DISABLED,
  migrationFilesValidationError,
  migrationPreviewValidationError,
  migrationConfigured,
  preflightPermissions,
  previewProviderMigration,
  serializeMigrationSource,
  sha256Hex,
  validMigrationProviderKey,
  validateMigrationArtifact,
  type MigrationConfigFormat,
  type MigrationTransport,
} from "./migration";
import { buildSystemPrompt } from "./system-prompt";
import {
  claimsNewQueuedAction,
  hasFinalUserHandoff,
  hasSuccessfulToolOutput,
  needsOnboardingFollowUp,
  promisesToolAction,
  queueClaimCorrection,
  repairOnboardingToolInput,
} from "./chat-integrity";
import {
  MAX_CHAT_DELIVERY_STATUS_IDS,
  MAX_CHAT_HISTORY_BYTES,
  MAX_CHAT_PROTOCOL_BYTES,
  MAX_CHAT_REQUEST_BODY_BYTES,
  MAX_CHAT_TEXT_CHARS,
  MAX_MODEL_CHAT_HISTORY_BYTES,
  MAX_MODEL_CHAT_MESSAGES,
  MAX_PERSISTED_CHAT_HISTORY_BYTES,
  MAX_PERSISTED_CHAT_MESSAGES,
  boundedChatHistory,
  chatParticipantNameError,
  clientChatSubmissionError,
  containsCloudflareApiToken,
  interruptedRetryTarget,
  isAuthoritativeRetryTarget,
  isJsonStructureWithinLimits,
  isValidChatProtocolId,
  isWithinUtf8ByteLimit,
  isUntrustedChatRole,
  redactCloudflareApiTokens,
  utf8ByteLengthWithinLimit,
} from "./chat-delivery";
import {
  APPLY_ATTEMPT_STALE_MS,
  actionApprovalIdentity,
  actionResultEventId,
  actionResourceKey,
  formatActionResultEvent,
  hasCanonicalActionResultParts,
  isSnapshotRestoreAction,
  isActionApplying,
  isActionOutcomeUncertain,
  isTrustedActionResultEvent,
  markActionApplying,
  markActionFailed,
  neutralizeActionResultMarkers,
  pendingActionStatus,
  recoverStaleActionAttempts,
  rulesetEntrypointIdentity,
  selectBulkApplyIds,
  snapshotRestoreIdFromAction,
  zoneCreationIdentity,
} from "./action-lifecycle";
import {
  normalizeActor,
  MAX_ACTOR_CHARS,
  MAX_ONBOARDING_DOMAIN_CHARS,
  MAX_PROFILE_NOTES_CHARS,
  isSafeSyncedStateTransition,
  syncedStateSizeError,
  validateBusinessProfilePatch,
  validateIdentifier,
  validateOnboardingPatch,
} from "./input-validation";
import { hasAffirmedMatch } from "./text-signals";
import {
  resolveMigrationExportTarget,
  zoneAfterAccountChange,
} from "./migration-target";
import {
  backfillAcceptedChatMessageLedger,
  initializeAcceptedChatMessageLedger,
} from "./chat-message-ledger";
import {
  GUIDANCE_TOP_K,
  deleteGuidanceVector,
  hasVectorize,
  isIndexableGuidance,
  retrieveGuidance,
  roomKeyFor,
  syncGuidanceVectors,
} from "./guidance-rag";
import {
  DOCS_ROOT_INDEX,
  DOCS_TOP_K,
  deleteDocPages,
  fetchDocText,
  indexDocPage,
  parseProductIndex,
  parseTopIndex,
  retrieveDocChunks,
} from "./docs-scraper";
import {
  CLIENT_RATE_LIMIT_HEADER,
  clientRateLimitKey,
  consumeRateLimit,
  isClientRateLimitKey,
  opaqueRateLimitKey,
  rateLimitResponse,
  type RateLimitDecision,
  type RateLimiter,
} from "./rate-limits";

/** Keep this many finished results in synced state. */
const MAX_RECENT_RESULTS = 25;
const MAX_PENDING_ACTIONS = 100;
const MAX_MEMORY_ENTRIES = 100;
const MAX_ROOM_MEMBERS = 100;
/** Cap on retained append-only audit rows per room; oldest are pruned past this. */
const MAX_ROOM_AUDIT_ENTRIES = 5_000;
/** Default page size when reading the audit log if the caller doesn't specify one. */
const DEFAULT_ROOM_AUDIT_PAGE = 500;
/** Give a queued first activation time to claim a room before denied-probe cleanup. */
const FRESH_ROOM_CLEANUP_DELAY_SECONDS = 1;
/** Retry transient schedule-write failures within the Durable Object waitUntil budget. */
const FRESH_ROOM_CLEANUP_RETRY_DELAYS_MS = [50, 250] as const;
/** Give a native fallback alarm a fresh invocation for atomic storage cleanup. */
const FRESH_ROOM_CLEANUP_FALLBACK_ALARM_DELAY_MS = 1_000;
/** Cap raw read payloads echoed back to the model so a huge list can't blow the context. */
const MAX_READ_CHARS = 6_000;
/** SQLite row name for the encrypted Cloudflare API token. */
const TOKEN_SECRET_NAME = "cf_api_token";
/** Cap migration-plan rules synced into state (full config still lives in SQLite). */
const MAX_PLAN_RULES = 300;
/** Cap admin guidance docs per room (they're injected into the prompt). */
const MAX_GUIDANCE_DOCS = 25;
/** Cap a single guidance doc's body so it can't blow the prompt/state size. */
const MAX_GUIDANCE_BODY = 4_000;
/**
 * When a room has at most this many enabled guidance docs, we skip retrieval and
 * inject them all (cheap, zero added latency). Above it, RAG retrieves the most
 * relevant `GUIDANCE_TOP_K` per message. Keep this ≥ GUIDANCE_TOP_K.
 */
const GUIDANCE_INJECT_ALL_MAX = 6;
/**
 * Cloudflare-docs reindex: pages fetched+embedded per scheduled tick. The work
 * is network-bound (fetch + Workers AI), so we keep batches modest and chain
 * ticks quickly, leaving the DO responsive to chat between batches.
 */
const DOCS_PAGES_PER_TICK = 10;
/** Delay (seconds) between docs-reindex ticks. */
const DOCS_TICK_DELAY_SEC = 2;
/** Page work-queue status codes. */
const DOCS_PAGE_PENDING = 0;
const DOCS_PAGE_DONE = 1;
const DOCS_PAGE_FAILED = 2;
/** Retry transient product-index failures before declaring the refresh incomplete. */
const DOCS_PRODUCT_ATTEMPTS = 3;
/** Avoid repeatedly fetching the root index when first-use bootstrap hits an outage. */
const DOCS_BOOTSTRAP_RETRY_MS = 15 * 60 * 1_000;
const ASSISTANT_PROVENANCE_MIGRATION_ID = "assistant-provenance-v1";
const LEGACY_CHAT_MIGRATION_BATCH_SIZE = 50;
const LEGACY_CHAT_MIGRATION_BATCH_BYTES = 1_000_000;
const LEGACY_CHAT_MIGRATION_DELAY_SEC = 1;
const LEGACY_CHAT_MIGRATION_RETRY_SEC = 30;
const MAX_LEGACY_ARCHIVE_MESSAGE_BYTES = 1_800_000;
const LEGACY_CHAT_TOKEN_DECRYPTION_FAILED = "token_decryption_failed";
const LEGACY_CHAT_ENCRYPTION_KEY_UNAVAILABLE = "encryption_key_unavailable";
/** Interval (seconds) between scheduled security-posture drift checks (~weekly). */
const DRIFT_WATCH_INTERVAL_SEC = 7 * 24 * 60 * 60;
/** How long an opted-in Applied change stays auto-revertible before the timer fires. */
const AUTO_ROLLBACK_WINDOW_SEC = 15 * 60;
/** Cap on open auto-rollback safety windows retained in synced state. */
const MAX_PENDING_ROLLBACKS = 20;

function persistedChatMessageRole(
  rowId: string,
  serialized: string,
): "user" | "assistant" | "system" | undefined {
  if (!isValidChatProtocolId(rowId)) return undefined;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = parsed as { id?: unknown; role?: unknown; parts?: unknown };
    if (candidate.id !== rowId || !Array.isArray(candidate.parts)) return undefined;
    if (candidate.role === "user" || candidate.role === "assistant" || candidate.role === "system") {
      return candidate.role;
    }
  } catch {
    /* Invalid persisted rows are quarantined by the migration. */
  }
  return undefined;
}

/**
 * Constructors in the Agent/AIChatAgent stack create SQLite tables even when a
 * request is only probing a room. Capture whether any schema existed before
 * those writes so a denied probe can remove only the storage it just created.
 */
function storageHadSchemaBeforeInitialization(storage: DurableObjectStorage): boolean {
  return storage.sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1",
  ).toArray().length > 0;
}

/** Swap legacy history out before AIChatAgent can hydrate an unbounded table. */
function prepareLegacyChatMigration(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS glide_chat_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS glide_chat_migration_progress (
    id                 TEXT PRIMARY KEY,
    last_rowid         INTEGER NOT NULL,
    blocked_reason     TEXT,
    recovery_requested INTEGER NOT NULL DEFAULT 0
  )`);
  storage.transactionSync(() => {
    const applied = storage.sql.exec<{ id: string }>(
      "SELECT id FROM glide_chat_migrations WHERE id = ?",
      ASSISTANT_PROVENANCE_MIGRATION_ID,
    ).toArray();
    if (applied.length) return;

    const quarantineExists = storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'glide_legacy_chat_quarantine'",
    ).toArray().length > 0;
    if (!quarantineExists) {
      storage.sql.exec("DROP TRIGGER IF EXISTS glide_record_accepted_user_message_id");
      storage.sql.exec("DROP TRIGGER IF EXISTS glide_record_chat_message_id_tombstone");
      storage.sql.exec("ALTER TABLE cf_ai_chat_agent_messages RENAME TO glide_legacy_chat_quarantine");
      storage.sql.exec("ALTER TABLE glide_legacy_chat_quarantine ADD COLUMN reason TEXT");
      storage.sql.exec("ALTER TABLE glide_legacy_chat_quarantine ADD COLUMN quarantined_at INTEGER");
      storage.sql.exec("ALTER TABLE glide_legacy_chat_quarantine ADD COLUMN redacted_at INTEGER");
      storage.sql.exec(`CREATE TABLE cf_ai_chat_agent_messages (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    }
    storage.sql.exec(
      `INSERT OR IGNORE INTO glide_chat_migration_progress (id, last_rowid) VALUES (?, 0)`,
      ASSISTANT_PROVENANCE_MIGRATION_ID,
    );
  });
}

function prepareRoomAccessStorage(
  storage: DurableObjectStorage,
  storageHadSchemaAtConstruction: boolean,
): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS glide_room_members (
    email      TEXT PRIMARY KEY COLLATE NOCASE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
    invited_by TEXT,
    joined_at  INTEGER NOT NULL
  )`);
  // Migration: rooms created before the "viewer" role existed have a members
  // table whose CHECK constraint still rejects 'viewer'. SQLite cannot ALTER a
  // CHECK constraint, so rebuild the table in place (data preserved) when the
  // stored definition predates the expanded role set. New rooms already match.
  const membersDef = storage.sql
    .exec<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'glide_room_members'",
    )
    .toArray()[0]?.sql;
  if (membersDef && !membersDef.includes("viewer")) {
    storage.sql.exec("ALTER TABLE glide_room_members RENAME TO glide_room_members_pre_viewer");
    storage.sql.exec(`CREATE TABLE glide_room_members (
      email      TEXT PRIMARY KEY COLLATE NOCASE,
      role       TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
      invited_by TEXT,
      joined_at  INTEGER NOT NULL
    )`);
    storage.sql.exec(`INSERT INTO glide_room_members (email, role, invited_by, joined_at)
      SELECT email, role, invited_by, joined_at FROM glide_room_members_pre_viewer`);
    storage.sql.exec("DROP TABLE glide_room_members_pre_viewer");
  }
  // Append-only governance audit trail: who queued/applied/rejected/invited/etc.
  // Stored only in SQLite (never synced in GlideState); read on demand by owners.
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS glide_room_audit (
    id      TEXT PRIMARY KEY,
    ts      INTEGER NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT,
    detail  TEXT
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS glide_room_invites (
    email       TEXT PRIMARY KEY COLLATE NOCASE,
    invited_by  TEXT NOT NULL,
    link        TEXT,
    invited_at  INTEGER NOT NULL
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS glide_room_lifecycle (
    id TEXT PRIMARY KEY CHECK (id = 'provisional')
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS glide_room_activations (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL COLLATE NOCASE,
    entry        TEXT NOT NULL CHECK (entry IN ('created', 'claimed')),
    activated_at INTEGER NOT NULL
  )`);
  if (!storageHadSchemaAtConstruction) {
    storage.sql.exec("INSERT OR IGNORE INTO glide_room_lifecycle (id) VALUES ('provisional')");
  }
}
/**
 * Stable, well-known DO name that drives the weekly docs-refresh cron. Using one
 * fixed instance keeps the crawl bookkeeping and global lock in a single place
 * that never collides with a real room. Reindex controls are not callable from
 * room clients; only Worker cron/bootstrap code invokes this instance directly.
 */
const DOCS_SYSTEM_ROOM = "__system__";

/**
 * Stable, well-known DO name that holds the deployment-wide room registry — a
 * convenience index of every activated room (id, name, owner, member count,
 * timestamps) powering the admin "all rooms" view. Like {@link DOCS_SYSTEM_ROOM}
 * it reuses the GlideAgent namespace but is never a real room: browser Agent
 * routes reject it and rooms only ever call its registry methods via a stub.
 */
const REGISTRY_SYSTEM_ROOM = "__registry__";

/** Reserved GlideAgent instance names that are internal system objects, not rooms. */
const RESERVED_SYSTEM_ROOMS: ReadonlySet<string> = new Set([DOCS_SYSTEM_ROOM, REGISTRY_SYSTEM_ROOM]);

/** True when a DO instance name is a reserved internal system object (docs/registry). */
function isReservedSystemRoom(name: string): boolean {
  return RESERVED_SYSTEM_ROOMS.has(name);
}

/** Never expose the deployment-wide system coordinators through browser Agent routes. */
function rejectReservedSystemRoute(
  _request: Request,
  lobby: { className: string; name: string },
): Response | undefined {
  if (lobby.className !== "GlideAgent" || !isReservedSystemRoom(lobby.name)) return undefined;
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Cloudflare rate-limiting periods (seconds) we snap a parsed period to. */
const RL_PERIODS = [10, 60, 120, 300, 600, 3600] as const;
/** Providers whose checks/migrations are zone-scoped (need a zone id). */
const CDN_MIGRATION_PROVIDERS = new Set(["akamai", "fastly", "imperva"]);

const WRITE_METHODS = new Set<WriteMethod>(["POST", "PUT", "PATCH", "DELETE"]);

interface ChatTurnContext {
  actor: string;
  queuedActions: PendingAction[];
  queueNotices: string[];
  accessLease?: RoomAccessLease;
  abortSignal?: AbortSignal;
  requestId?: string;
}

interface CredentialLease {
  token: string;
  generation: number;
}

interface GlideConnectionState {
  glideClientRateLimitKey?: string;
  glideAccessLeaseId?: string;
  glideAccessEmail?: string;
  glideAccessSubjectDigest?: string;
  glideAccessExpiresAt?: number;
  glideAccessExpiryScheduleId?: string;
  [key: string]: unknown;
}

interface RoomAccessLease {
  connectionId: string;
  leaseId: string;
  email: string;
  expiresAt: number;
}

const roomAccessProgrammaticTurn = new AsyncLocalStorage<RoomAccessLease>();

const ACCESS_SUBJECT_DIGEST_RE = /^access-subject:[a-f0-9]{64}$/;

interface RoomAuthorizationResult {
  allowed: boolean;
  code:
    | "member"
    | "room_claimed"
    | "room_created"
    | "room_membership_required"
    | "legacy_room_not_found";
  message: string;
  access?: RoomAccessStatus;
}

/**
 * A read-only, point-in-time view of a room returned to a verified Cloudflare
 * employee inspecting a room they are not a member of. Sourced entirely from the
 * server's own persisted state — there is no socket, so nothing here can be
 * mutated. Contains no secrets: {@link GlideState} only ever carries the token's
 * last-4/validity, never the token itself.
 */
interface RoomInspectionSnapshot {
  state: GlideState;
  messages: UIMessage[];
  audit: RoomAuditEntry[];
}

interface RoomInspectionResult {
  allowed: boolean;
  code: "member" | "inspect" | "room_membership_required";
  message: string;
  access?: RoomAccessStatus;
  /** Present only when a non-member employee is granted read-only inspection. */
  snapshot?: RoomInspectionSnapshot;
}

/** Runtime guard for persisted queue data before it can reach the privileged API client. */
function pendingActionValidationError(action: PendingAction): string | undefined {
  if (!action || typeof action !== "object") return "Action data is not an object.";
  if (typeof action.id !== "string" || !action.id || action.id.length > 200) return "Invalid action id.";
  if (typeof action.product !== "string" || !action.product || action.product.length > 200) {
    return "Invalid product label.";
  }
  if (typeof action.summary !== "string" || !action.summary || action.summary.length > 1_000) {
    return "Invalid action summary.";
  }
  if (!WRITE_METHODS.has(action.method)) return "Invalid write method.";
  const actionType = (action as { actionType?: unknown }).actionType;
  if (actionType === "snapshot_restore") {
    return snapshotRestoreIdFromAction(action) ? undefined : "Invalid snapshot restore approval.";
  }
  if (
    actionType !== undefined ||
    (action as { restoreSnapshotId?: unknown }).restoreSnapshotId !== undefined ||
    (action as { restoreSnapshotAccountId?: unknown }).restoreSnapshotAccountId !== undefined ||
    (action as { restoreSnapshotZoneId?: unknown }).restoreSnapshotZoneId !== undefined ||
    (action as { restoreSnapshotVersion?: unknown }).restoreSnapshotVersion !== undefined ||
    (action as { restoreSnapshotDigest?: unknown }).restoreSnapshotDigest !== undefined
  ) {
    return "Invalid action type.";
  }
  const canonicalPath = typeof action.path === "string" ? canonicalizeApiPath(action.path) : undefined;
  if (!canonicalPath || canonicalPath !== action.path || action.path.length > 2_000) {
    return "Invalid Cloudflare API path.";
  }
  if (action.zoneId !== undefined && !/^[a-f0-9]{32}$/i.test(action.zoneId)) return "Invalid zone id.";
  const zonePath = /^\/zones\/([^/?]+)(?:[/?]|$)/.exec(canonicalPath);
  if (zonePath) {
    const pathZoneId = zoneIdFromApiPath(canonicalPath);
    if (!pathZoneId) return "Invalid zone id in the Cloudflare API path.";
    if (!action.zoneId || action.zoneId.toLowerCase() !== pathZoneId.toLowerCase()) {
      return "Zone snapshot metadata does not match the Cloudflare API path.";
    }
  }
  try {
    const body = JSON.stringify(action.body);
    if (body && new TextEncoder().encode(body).byteLength > 250_000) return "Action body is too large.";
  } catch {
    return "Action body is not valid JSON.";
  }
  if (action.mergeEntrypoint) {
    const target = rulesetEntrypointIdentity(action.path);
    if (
      !action.zoneId ||
      !/^[a-f0-9]{32}$/i.test(action.zoneId) ||
      !target ||
      target.zoneId !== action.zoneId ||
      target.phase !== action.mergeEntrypoint.phase ||
      !Array.isArray(action.mergeEntrypoint.newRules) ||
      action.mergeEntrypoint.newRules.length > 1_000
    ) {
      return "Ruleset merge metadata does not match the API path.";
    }
  }
  return undefined;
}

/**
 * Extract the most recent user message's text from converted model messages —
 * used as the semantic query for guidance retrieval. Handles both string content
 * and structured text parts; returns "" if none.
 */
function latestUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c.trim();
    if (Array.isArray(c)) {
      return c
        .map((p) =>
          p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : "",
        )
        .join(" ")
        .trim();
    }
    return "";
  }
  return "";
}

function uiMessageText(message: UIMessage): string {
  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part) && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/** The recommended Cloudflare go-live checklist, tailored to the chosen path. */
function checklistForPath(path?: OnboardingPath): OnboardingStep[] {
  const step = (id: string, label: string): OnboardingStep => ({ id, label, done: false });
  if (path === "migrate") {
    return [
      step("domain", "Identify the domain(s) to onboard"),
      step("setup", "Choose DNS setup: Full (primary) or Partial (CNAME)"),
      step("preview", "Preview existing provider config (read-only)"),
      step("scan", "Review DNS records Cloudflare scanned from your provider"),
      step("migrate", "Queue migrated rules (WAF / cache / rate limits)"),
      step("ssl", "Set SSL/TLS mode to Full (strict) once origin cert is valid"),
      step("ttl", "Lower record TTLs before cutover to reduce downtime"),
      step("nameservers", "Change nameservers at your registrar"),
      step("verify", "Verify activation; test before/after cutover"),
      step("dnssec", "Coordinate DNSSEC (DS record) if it was enabled"),
    ];
  }
  if (path === "fresh") {
    return [
      step("domain", "Identify the domain(s) to onboard"),
      step("setup", "Choose DNS setup: Full (primary) or Partial (CNAME)"),
      step("dns", "Add / review DNS records (Cloudflare scans existing ones)"),
      step("proxy", "Set proxy status (orange/grey cloud) per record"),
      step("security", "Configure WAF / security rules (if wanted)"),
      step("ssl", "Set SSL/TLS mode to Full (strict) once origin cert is valid"),
      step("ttl", "Lower record TTLs before cutover to reduce downtime"),
      step("nameservers", "Change nameservers at your registrar"),
      step("verify", "Verify activation; test before/after cutover"),
    ];
  }
  return [];
}

/**
 * Derive which checklist step ids should be auto-marked done given the
 * onboarding answers captured so far plus room signals (queued migration rules
 * and the pending/applied action queue). This is what makes "the checklist on
 * the right fills itself in as Glide gathers the required info."
 *
 * It only ever ADDS completions and N/A marks — callers union the result with the
 * existing flags and never uncheck, so manual checks and earlier auto-checks are
 * sticky. Returned ids that don't exist in the active checklist are ignored.
 *
 * `done` are steps proven satisfied (from captured answers, queued/applied
 * actions, OR the domain's live zone state); `na` are steps that don't apply to
 * this room's real situation (e.g. lowering TTLs once the zone is already active).
 */
function autoDoneSteps(
  ob: OnboardingState,
  signals: {
    migrationQueued: boolean;
    pending: PendingAction[];
    results: ActionResult[];
    liveZone?: LiveZoneFacts;
  },
): { done: Set<string>; na: Set<string> } {
  const done = new Set<string>();
  const na = new Set<string>();

  // --- Captured directly in the guided conversation (or the form) ---
  if (ob.domain && ob.domain.trim()) done.add("domain");
  if (ob.setupType === "full" || ob.setupType === "partial") done.add("setup");
  if (ob.configProvided) done.add("preview");
  if (ob.dnsReviewed) {
    done.add("scan"); // migrate path
    done.add("dns"); // fresh path
  }
  if (signals.migrationQueued) done.add("migrate");

  // --- Derived from actions Glide has queued or that have been applied ---
  const consider = (product: string, path: string, summary: string) => {
    const p = product.toLowerCase();
    const pa = path.toLowerCase();
    const sm = summary.toLowerCase();
    if (pa.includes("/settings/ssl") || (p.includes("zone setting") && sm.includes("ssl"))) {
      done.add("ssl");
    }
    if (p === "dns") done.add("dns");
    if (p === "waf") {
      done.add("security"); // fresh path
    }
  };
  for (const a of signals.pending) consider(a.product, a.path, a.summary);
  for (const r of signals.results) if (r.status === "applied") consider(r.product, "", r.summary);

  // --- Derived from the domain's real, live Cloudflare state ---
  // These reflect the actual zone, so they tick go-live steps a human would
  // otherwise confirm by hand (nameservers/activation) and settings that may
  // already be in place from outside this room (SSL, WAF, proxy). Callers only
  // pass `liveZone` when it matches the current default zone, so it can't be
  // stale here.
  const live = signals.liveZone;
  if (live) {
    if (live.status === "active") {
      // An active zone means the registrar nameservers already point to
      // Cloudflare and activation is verified — and TTL-lowering before cutover
      // is moot, so it no longer applies.
      done.add("nameservers");
      done.add("verify");
      na.add("ttl");
    }
    if (live.sslMode === "full" || live.sslMode === "strict") done.add("ssl");
    if (live.wafManaged === true) done.add("security");
    if (typeof live.proxiedRecords === "number" && live.proxiedRecords > 0) done.add("proxy");
  }

  return { done, na };
}

/**
 * Deterministically extract onboarding answers from a user's chat message.
 *
 * The quantized chat model is unreliable at populating structured tool
 * arguments: it will call `update_onboarding` (the chip shows) but omit the
 * fields, so e.g. the team answers "full" yet `setupType` is never recorded and
 * the right-hand checklist never ticks. This parser recovers those answers from
 * the raw text so the room's onboarding state — and the checklist — stay correct
 * regardless of how the model formats its tool call.
 *
 * It is intentionally conservative and only reports what it's confident about;
 * the caller fills ONLY fields that aren't set yet (goals are unioned), so it can
 * never overwrite or fight a more specific, explicit answer.
 */
function inferOnboardingFromText(text: string): {
  path?: OnboardingPath;
  setupType?: SetupType;
  domain?: string;
  goals?: string[];
} {
  const out: { path?: OnboardingPath; setupType?: SetupType; domain?: string; goals?: string[] } = {};
  const t = text.toLowerCase();
  if (!t.trim()) return out;

  // DNS setup type (answer to "Full (primary) vs Partial (CNAME)?").
  if (hasAffirmedMatch(t, /\bpartial\b|\bcname\b/)) out.setupType = "partial";
  else if (hasAffirmedMatch(t, /\bfull\b|\bprimary\b/)) out.setupType = "full";

  // Top-level path (migrate vs fresh).
  if (hasAffirmedMatch(t, /\bmigrat/)) out.path = "migrate";
  else if (hasAffirmedMatch(t, /\bstart(?:ing)?\s+fresh\b|\bfresh\b|\bfrom scratch\b|\bbrand[-\s]?new\b|\bnew to cloudflare\b/)) {
    out.path = "fresh";
  }

  // Goals / scope (what to set up). Canonical keys mirror the tool schema.
  const goals: string[] = [];
  if (hasAffirmedMatch(t, /\bdns\b/)) goals.push("dns");
  if (hasAffirmedMatch(t, /\bwaf\b|\bfirewall\b|\bsecurity\b|\bmanaged rules?\b/)) goals.push("waf");
  if (hasAffirmedMatch(t, /\bcache\b|\bcaching\b|\bcdn\b|\bperformance\b/)) goals.push("cache");
  if (hasAffirmedMatch(t, /\brate[-\s]?limit/)) goals.push("rate_limiting");
  if (hasAffirmedMatch(t, /\bload[-\s]?balanc/)) goals.push("load_balancing");
  if (hasAffirmedMatch(t, /\bzero[-\s]?trust\b|\bwarp\b|\bcloudflare access\b/)) goals.push("zero_trust");
  if (goals.length) out.goals = goals;

  // Domain: first plausible hostname that isn't Cloudflare's own.
  const m = text.match(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\b/i);
  if (m) {
    const d = m[1].toLowerCase();
    if (!/(?:^|\.)cloudflare\.com$/.test(d)) out.domain = d;
  }

  return out;
}

/**
 * Deterministically recover "nature of the business" answers from a user's chat
 * message, mirroring {@link inferOnboardingFromText}. The chat model often calls
 * `update_business_profile` with empty arguments, so this backfill keeps the
 * room's {@link BusinessProfile} — and therefore the recommendations — populated
 * regardless of how the model formats its tool call.
 *
 * Conservative: it reports only high-confidence signals and NEVER sets a boolean
 * to `false` (absence of a keyword is not a "no"), so callers only fill blanks
 * and can't overwrite an explicit answer.
 */
function inferBusinessProfileFromText(text: string): Partial<BusinessProfile> {
  const out: Partial<BusinessProfile> = {};
  const t = ` ${text.toLowerCase()} `;
  if (!t.trim()) return out;

  // Industry / vertical (first match wins for the canonical key).
  const industry: Array<[string, RegExp]> = [
    ["ecommerce", /\b(e-?commerce|online store|storefront|shop(?:ping)?|retail|checkout|cart)\b/],
    ["fintech", /\b(fintech|bank(?:ing)?|payments? company|lending|trading|brokerage|crypto|wallet)\b/],
    ["healthcare", /\b(health\s?care|healthcare|medical|clinic|hospital|patient|telehealth|pharma)\b/],
    ["saas", /\b(saas|b2b software|software as a service|dashboard app|platform for)\b/],
    ["media", /\b(media|publish(?:er|ing)|news|blog|streaming|video platform|content site)\b/],
    ["gaming", /\b(gaming|game studio|multiplayer|esports)\b/],
    ["government", /\b(government|public sector|\.gov|municipal|federal agency)\b/],
    ["education", /\b(education|university|school|\bedu\b|e-?learning|lms)\b/],
    ["nonprofit", /\b(non-?profit|charity|ngo|foundation)\b/],
    ["marketing", /\b(marketing site|brand site|landing page|campaign site|agency site)\b/],
    ["api_platform", /\b(api platform|api-first|developer platform|public api)\b/],
  ];
  for (const [key, re] of industry) {
    if (hasAffirmedMatch(t, re)) {
      out.industry = key;
      break;
    }
  }

  // App type(s).
  const appTypes: string[] = [];
  if (hasAffirmedMatch(t, /\b(api|rest api|graphql|endpoints?)\b/)) appTypes.push("api");
  if (hasAffirmedMatch(t, /\b(mobile app|ios app|android app|mobile backend)\b/)) appTypes.push("mobile_backend");
  if (hasAffirmedMatch(t, /\b(static site|jamstack|marketing site|landing page|brochure)\b/)) appTypes.push("static_site");
  if (hasAffirmedMatch(t, /\b(web app|web application|spa|single-page|portal|dashboard)\b/)) appTypes.push("web_app");
  if (hasAffirmedMatch(t, /\b(user-generated|ugc|forum|community|marketplace|comments)\b/)) appTypes.push("ugc");
  if (appTypes.length) out.appTypes = [...new Set(appTypes)];

  // Audience reach.
  if (hasAffirmedMatch(t, /\b(global|worldwide|international|around the world|multi-?region)\b/)) out.audience = "global";
  else if (hasAffirmedMatch(t, /\b(internal|intranet|employees? only|behind (?:the )?vpn|private app)\b/)) out.audience = "internal";
  else if (hasAffirmedMatch(t, /\b(regional|local|single (?:country|region)|domestic)\b/)) out.audience = "regional";

  // Traffic profile.
  if (hasAffirmedMatch(t, /\b(high[-\s]?volume|millions of|huge traffic|massive traffic)\b/)) out.trafficProfile = "high_volume";
  else if (hasAffirmedMatch(t, /\b(spiky|spikes|flash sale|product launch|bursty|black friday|goes viral)\b/)) out.trafficProfile = "spiky";
  else if (hasAffirmedMatch(t, /\b(steady|consistent|predictable)\b/)) out.trafficProfile = "steady";
  else if (hasAffirmedMatch(t, /\b(low traffic|small (?:site|audience)|just launched)\b/)) out.trafficProfile = "low";

  // Login / API booleans (only ever set to true).
  if (hasAffirmedMatch(t, /\b(log ?in|logins?|sign ?in|sign ?up|authentication|user accounts?|sso)\b/)) out.hasLogin = true;
  if (appTypes.includes("api") || hasAffirmedMatch(t, /\bapi\b/)) out.hasApi = true;

  // Sensitive data.
  const sensitive: string[] = [];
  if (hasAffirmedMatch(t, /\b(credit cards?|card(?:holder)? data|payments?|checkout|pci)\b/)) sensitive.push("payments");
  if (hasAffirmedMatch(t, /\b(health|phi|medical records?|patient data|hipaa)\b/)) sensitive.push("health");
  if (hasAffirmedMatch(t, /\b(passwords?|credentials?|logins?)\b/)) sensitive.push("credentials");
  if (hasAffirmedMatch(t, /\b(pii|personal data|personal information|customer data|user data)\b/)) sensitive.push("pii");
  if (hasAffirmedMatch(t, /\b(financial data|account balances?|bank details?)\b/)) sensitive.push("financial");
  if (sensitive.length) out.sensitiveData = [...new Set(sensitive)];

  // Compliance regimes.
  const compliance: string[] = [];
  if (hasAffirmedMatch(t, /\bpci(?:[-\s]?dss)?\b/)) compliance.push("pci_dss");
  if (hasAffirmedMatch(t, /\bhipaa\b/)) compliance.push("hipaa");
  if (hasAffirmedMatch(t, /\bgdpr\b/)) compliance.push("gdpr");
  if (hasAffirmedMatch(t, /\bsoc\s?2\b/)) compliance.push("soc2");
  if (hasAffirmedMatch(t, /\biso\s?27001\b/)) compliance.push("iso27001");
  if (hasAffirmedMatch(t, /\bfedramp\b/)) compliance.push("fedramp");
  if (compliance.length) out.compliance = [...new Set(compliance)];

  // Concerns / threats.
  const concerns: string[] = [];
  if (hasAffirmedMatch(t, /\b(bots?|automated traffic|scrapers?)\b/)) concerns.push("bots");
  if (hasAffirmedMatch(t, /\b(ddos|denial of service|flood(?:ing)?)\b/)) concerns.push("ddos");
  if (hasAffirmedMatch(t, /\bscrap(?:e|ing)\b/)) concerns.push("scraping");
  if (hasAffirmedMatch(t, /\b(credential stuffing|account takeover|ato|brute[-\s]?force)\b/)) concerns.push("credential_stuffing");
  if (hasAffirmedMatch(t, /\b(card testing|carding|card fraud)\b/)) concerns.push("card_testing");
  if (hasAffirmedMatch(t, /\b(fraud|abuse)\b/)) concerns.push("fraud");
  if (hasAffirmedMatch(t, /\b(latency|slow|speed|performance|page load)\b/)) concerns.push("latency");
  if (hasAffirmedMatch(t, /\b(downtime|availability|uptime|outages?|reliability)\b/)) concerns.push("downtime");
  if (hasAffirmedMatch(t, /\b(egress|bandwidth cost|origin cost|hosting cost)\b/)) concerns.push("cost");
  if (concerns.length) out.concerns = [...new Set(concerns)];

  return out;
}

/** Map a provider's WAF action to a valid Cloudflare custom-rule action. */
function mapWafActionToCf(action?: string): { action: string; action_parameters?: Record<string, unknown> } | undefined {
  const s = (action ?? "").toLowerCase().replace(/^api\.rule_action_type\./, "");
  if (["block", "deny", "drop"].includes(s)) return { action: "block" };
  if (["managed_challenge", "challenge", "captcha", "interactive"].includes(s)) {
    return { action: "managed_challenge" };
  }
  if (["js_challenge", "jschallenge"].includes(s)) return { action: "js_challenge" };
  if (["log", "alert", "monitor"].includes(s)) return { action: "log" };
  if (["allow", "bypass", "whitelist", "skip"].includes(s)) {
    return { action: "skip", action_parameters: { ruleset: "current" } };
  }
  return undefined;
}

/** Snap an arbitrary period (seconds) to the nearest Cloudflare-supported value. */
function snapPeriod(period: number): number {
  let best: number = RL_PERIODS[1];
  let bestDiff = Infinity;
  for (const p of RL_PERIODS) {
    const d = Math.abs(p - period);
    if (d < bestDiff) {
      best = p;
      bestDiff = d;
    }
  }
  return best;
}

/** Best-effort parse of a preview "detail" like "100 req/60s" or "100 rps (60s window)". */
function parseRateLimit(detail?: string): { requests: number; period: number } | undefined {
  if (!detail) return undefined;
  const reqMatch = detail.match(/(\d+)\s*(?:req|rps|requests)/i) ?? detail.match(/(\d+)/);
  if (!reqMatch) return undefined;
  const requests = parseInt(reqMatch[1], 10);
  if (!Number.isSafeInteger(requests) || requests <= 0 || requests > 1_000_000_000) return undefined;
  const periodMatch =
    detail.match(/\/\s*(\d+)\s*s/i) ?? detail.match(/\(\s*(\d+)\s*s/i) ?? detail.match(/per\s*(\d+)\s*s/i);
  const period = periodMatch ? snapPeriod(parseInt(periodMatch[1], 10)) : 60;
  return { requests, period };
}

/** Parse a preview zone-setting "detail" like "always_use_https = on" into id + value. */
function parseZoneSetting(detail?: string): { setting: string; value: string | number | boolean } | undefined {
  if (!detail) return undefined;
  const m = detail.match(/^\s*([a-z0-9_]+)\s*=\s*(.+?)\s*$/i);
  if (!m) return undefined;
  const setting = m[1].toLowerCase();
  if (!/^[a-z0-9_]+$/.test(setting)) return undefined;
  const raw = m[2].trim();
  let value: string | number | boolean = raw;
  if (/^(true|false)$/i.test(raw)) value = raw.toLowerCase() === "true";
  else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
  return { setting, value };
}

// ---------------------------------------------------------------------------
// Best-effort builders for additional ruleset phases (#4). These translate the
// slim preview rule into a Cloudflare ruleset rule. Some fields are approximate,
// so callers flag these queued actions as "review before Apply". Each returns a
// CF rule, or a skip reason when required data can't be derived.
// ---------------------------------------------------------------------------

type BuildOut = { rule: Record<string, unknown> } | { skip: string };

/** http_request_dynamic_redirect — needs an expression and a target. */
function buildRedirectRule(r: MigrationPlanRule): BuildOut {
  if (!r.expression) return { skip: "no expression (export via Terraform)" };
  let target = (r.detail ?? "").trim();
  if (target.includes("→")) target = target.split("→").pop()!.trim();
  if (!target) return { skip: "no redirect target (export via Terraform)" };
  const code = Number.parseInt(r.action ?? "", 10);
  if (!Number.isInteger(code) || code < 300 || code >= 400) {
    return { skip: "invalid redirect status (export via Terraform)" };
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return { skip: "invalid redirect URL (export via Terraform)" };
  }
  if (!(["https:", "http:"] as string[]).includes(targetUrl.protocol) || targetUrl.username || targetUrl.password) {
    return { skip: "unsafe redirect URL (export via Terraform)" };
  }
  return {
    rule: {
      action: "redirect",
      expression: r.expression,
      description: r.name.slice(0, 1024),
      enabled: true,
      action_parameters: {
        from_value: {
          status_code: code,
          target_url: { value: targetUrl.toString() },
          preserve_query_string: true,
        },
      },
    },
  };
}

/** http_request_cache_settings — cache on/off (+ edge TTL when present). */
function buildCacheRule(r: MigrationPlanRule): BuildOut {
  if (!r.expression) return { skip: "no expression (export via Terraform)" };
  const a = (r.action ?? "").toLowerCase();
  const cacheActions = new Set(["cache", "store", "enable", "cache_everything"]);
  const bypassActions = new Set(["bypass", "no-store", "no_cache", "no-cache", "pass"]);
  if (!cacheActions.has(a) && !bypassActions.has(a)) {
    return { skip: "unknown cache action (export via Terraform)" };
  }
  const cache = cacheActions.has(a);
  const params: Record<string, unknown> = { cache };
  const ttlMatch = (r.detail ?? "").match(/(\d+)/);
  if (cache && ttlMatch) {
    params.edge_ttl = { mode: "override_origin", default: Number.parseInt(ttlMatch[1], 10) };
  }
  return {
    rule: {
      action: "set_cache_settings",
      expression: r.expression,
      description: r.name.slice(0, 1024),
      enabled: true,
      action_parameters: params,
    },
  };
}

/** http_request_origin — override origin host. */
function buildOriginRule(r: MigrationPlanRule): BuildOut {
  if (!r.expression) return { skip: "no expression (export via Terraform)" };
  const host = canonicalizeDomainName((r.detail ?? "").trim());
  if (!host) return { skip: "no clean origin host (export via Terraform)" };
  return {
    rule: {
      action: "route",
      expression: r.expression,
      description: r.name.slice(0, 1024),
      enabled: true,
      action_parameters: { origin: { host } },
    },
  };
}

const HEADER_OP_MAP: Record<string, "set" | "add" | "remove"> = {
  set: "set",
  insert: "set",
  modify: "set",
  add: "add",
  append: "add",
  remove: "remove",
  delete: "remove",
  unset: "remove",
};

/** http_request_late_transform / http_response_headers_transform — header rewrite. */
function buildHeaderRule(r: MigrationPlanRule): BuildOut {
  if (!r.expression) return { skip: "no expression (export via Terraform)" };
  // Derive the header name from the preview's name field (akamai "… Header: X", fastly "set x").
  let header = "";
  const m1 = r.name.match(/header:\s*(.+)$/i);
  const m2 = r.name.match(/^(?:set|add|remove|delete|append|unset)\s+(.+)$/i);
  if (m1) header = m1[1].trim();
  else if (m2) header = m2[1].trim();
  if (!header || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) {
    return { skip: "couldn't determine a valid header name (export via Terraform)" };
  }

  const op = HEADER_OP_MAP[(r.action ?? "").toLowerCase()];
  if (!op) return { skip: "unknown header operation (export via Terraform)" };
  const headerEntry: Record<string, unknown> =
    op === "remove" ? { operation: "remove" } : { operation: op, value: (r.detail ?? "").trim() || "" };
  return {
    rule: {
      action: "rewrite",
      expression: r.expression,
      description: r.name.slice(0, 1024),
      enabled: true,
      action_parameters: { headers: { [header]: headerEntry } },
    },
  };
}

type OnChatFinish = StreamTextOnFinishCallback<ToolSet>;

function clip(value: unknown): string {
  const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (json.length <= MAX_READ_CHARS) return json;
  return `${json.slice(0, MAX_READ_CHARS)}\n…(truncated — narrow your query)`;
}

// Some Workers AI models emit a tool call as *literal text*
// (`<|python_tag|>{"type":"function",...}` or a bare `{"name":...,"parameters":...}`)
// instead of — or in addition to — a structured tool part. (This was rife on the
// quantized fp8-fast Llama we previously ran; gpt-oss can also leak JSON, though
// workers-ai-provider salvages those under a forced toolChoice.) That text is not
// prose: the client strips it (see `stripToolCalls` in client/main.tsx), so the
// bubble renders empty. This mirrors that stripping server-side so we can tell
// whether pass 1 actually produced narration. Returns the prose with any
// serialized tool call removed (may be "").
const LLAMA_TOKENS =
  /<\|(?:python_tag|eom_id|eot_id|start_header_id|end_header_id|begin_of_text)\|>/g;

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

function looksLikeToolCall(obj: string): boolean {
  if (!/"(?:type|name|function|parameters|arguments)"\s*:/.test(obj)) return false;
  return (
    /"type"\s*:\s*"function"/.test(obj) ||
    (/"name"\s*:/.test(obj) && /"(?:parameters|arguments)"\s*:/.test(obj))
  );
}

function assistantProse(raw: string): string {
  const s = raw.replace(LLAMA_TOKENS, "").replace(/<\/?(?:tool_call|function_call)>/g, "");
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
    if (!looksLikeToolCall(candidate)) out += candidate;
    i = end;
  }
  return out
    .replace(/```[a-zA-Z0-9]*\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// True when `raw` carries a tool call encoded as literal TEXT (a python_tag or a
// bare {"name":…,"parameters":…} blob) rather than a structured tool part — i.e.
// the model TRIED to call a tool but it never executed. Mirrors the scan in
// `assistantProse`, but reports presence instead of stripping it.
function containsToolCallText(raw: string): boolean {
  const s = raw.replace(LLAMA_TOKENS, "").replace(/<\/?(?:tool_call|function_call)>/g, "");
  let i = 0;
  while (i < s.length) {
    const brace = s.indexOf("{", i);
    if (brace === -1) return false;
    const end = scanJsonObject(s, brace);
    if (end === -1) return false;
    if (looksLikeToolCall(s.slice(brace, end))) return true;
    i = end;
  }
  return false;
}

// ---------------------------------------------------------------------------
// workers-ai-provider streaming de-dup shim.
//
// For streaming Llama models (e.g. the fp8-fast Llama we previously used) the
// Workers AI SSE stream carries the SAME text in BOTH the native
// `chunk.response` field AND the
// OpenAI-shaped `chunk.choices[0].delta.content` field of a single frame.
// workers-ai-provider's getMappedStream enqueues a `text-delta` for each of
// those branches independently, so every fragment is emitted twice — the
// client receives doubled prose ("HelloHello, today, today"). This shim wraps
// the AI binding: when a streamed frame contains both fields, it drops the
// duplicate OpenAI `content` and keeps the native `response`, leaving
// tool_calls / reasoning / usage / finish_reason on the frame untouched.
// ---------------------------------------------------------------------------
function dedupWorkersAiSse(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const rewriteLine = (line: string): string => {
    const lead = line.slice(0, line.length - line.trimStart().length);
    const trimmed = line.slice(lead.length);
    if (!trimmed.startsWith("data:")) return line;
    const payload = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (payload === "" || payload === "[DONE]" || payload[0] !== "{") return line;
    let obj: {
      response?: unknown;
      choices?: Array<{ delta?: { content?: unknown } } | undefined>;
    };
    try {
      obj = JSON.parse(payload);
    } catch {
      return line; // not JSON we understand — pass through verbatim
    }
    const nativeText = obj.response;
    const delta = obj.choices?.[0]?.delta;
    const oaiContent = delta?.content;
    if (
      typeof nativeText === "string" &&
      nativeText.length > 0 &&
      typeof oaiContent === "string" &&
      oaiContent.length > 0 &&
      delta
    ) {
      // Duplicate text in one frame: keep native `response`, drop the copy.
      delete delta.content;
      return `${lead}data: ${JSON.stringify(obj)}`;
    }
    return line;
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        controller.enqueue(encoder.encode(`${rewriteLine(line)}\n`));
      }
    },
    flush(controller) {
      if (buffer.length > 0) controller.enqueue(encoder.encode(rewriteLine(buffer)));
    },
  });
}

/**
 * Wrap an AI binding so streamed (`ReadableStream`) responses pass through the
 * SSE de-dup transform. Non-streaming results and every other binding method
 * are delegated unchanged.
 */
function dedupAIBinding(binding: Ai): Ai {
  return new Proxy(binding, {
    get(target, prop, receiver) {
      if (prop === "run") {
        return async (...args: unknown[]): Promise<unknown> => {
          const run = Reflect.get(target, prop, receiver) as (
            ...a: unknown[]
          ) => Promise<unknown>;
          const res = await run.apply(target, args);
          return res instanceof ReadableStream ? res.pipeThrough(dedupWorkersAiSse()) : res;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// At-rest encryption for GUI-provided secrets (AES-256-GCM via HKDF).
// The key is derived from the Worker-held GLIDE_TOKEN_KEY secret, so the
// ciphertext stored in the DO is useless without that secret.
// ---------------------------------------------------------------------------

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const HKDF_SALT = ENC.encode("glide:token:salt:v1");
const HKDF_INFO = ENC.encode("glide:token:aes-gcm:v1");

/** Copy bytes into a fresh ArrayBuffer so they satisfy the strict `BufferSource` lib type. */
function ab(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}
function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", ab(ENC.encode(secret)), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ab(HKDF_SALT), info: ab(HKDF_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Returns `base64(iv):base64(ciphertext)`. */
async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(ENC.encode(plaintext)));
  return `${toB64(iv)}:${toB64(new Uint8Array(ct))}`;
}

async function decryptSecret(secret: string, packed: string): Promise<string> {
  const [ivB64, ctB64] = packed.split(":");
  if (!ivB64 || !ctB64) throw new Error("malformed ciphertext");
  const key = await deriveAesKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(fromB64(ivB64)) },
    key,
    ab(fromB64(ctB64)),
  );
  return DEC.decode(pt);
}

export class GlideAgent extends AIChatAgent<Cloudflare.Env, GlideState> {
  initialState: GlideState = INITIAL_GLIDE_STATE;
  maxPersistedMessages = MAX_PERSISTED_CHAT_MESSAGES;
  messageConcurrency = "drop" as const;
  private readonly storageSql: Pick<SqlStorage, "exec">;
  private readonly durableStorage: Pick<DurableObjectStorage, "transactionSync">;
  private readonly storageHadSchemaAtConstruction: boolean;
  private freshRoomDestroyQueued = false;
  private protocolBytesInFlight = 0;
  private assistantProvenanceReady = false;
  private assistantMigrationAttempted = false;
  private assistantMigrationRunning = false;
  private assistantMigrationFinalizing = false;
  private readonly roomAccessAborters = new Map<
    string,
    Map<string, Set<(reason: Error) => void>>
  >();

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    const storageHadSchemaAtConstruction = storageHadSchemaBeforeInitialization(ctx.storage);
    prepareLegacyChatMigration(ctx.storage);
    prepareRoomAccessStorage(ctx.storage, storageHadSchemaAtConstruction);
    super(ctx, env);
    this.storageSql = ctx.storage.sql;
    this.durableStorage = ctx.storage;
    this.storageHadSchemaAtConstruction = storageHadSchemaAtConstruction;
    // SDK stream recovery can persist reconstructed messages before onStart().
    // Create the provenance tables synchronously so sanitization always fails closed.
    this.sql`CREATE TABLE IF NOT EXISTS glide_system_events (
      id   TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      ts   INTEGER
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_assistant_events (
      id          TEXT PRIMARY KEY,
      response_to TEXT NOT NULL,
      ts          INTEGER
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_chat_migrations (
      id         TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_legacy_chat_quarantine (
      id             TEXT PRIMARY KEY,
      message        TEXT NOT NULL,
      created_at     TEXT,
      reason         TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL,
      redacted_at    INTEGER NOT NULL
    )`;
    this.assistantProvenanceReady = this.sql<{ id: string }>`SELECT id FROM glide_chat_migrations
      WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`.length > 0;
    if (!this.assistantProvenanceReady) this.hideUnregisteredAssistantMessages();
    initializeAcceptedChatMessageLedger(this.storageSql);
    const handleMessage = this.onMessage.bind(this);
    this.onMessage = async (connection, message) => {
      if (typeof message !== "string") {
        try {
          connection.close(1003, "Binary protocol messages are not supported");
        } catch {
          /* The connection already closed. */
        }
        return;
      }
      const messageBytes = utf8ByteLengthWithinLimit(message, MAX_CHAT_PROTOCOL_BYTES);
      if (messageBytes === undefined) {
        this.rejectClientTranscript(connection, undefined, "Chat protocol message is too large.");
        try {
          connection.close(1009, "Chat protocol message is too large");
        } catch {
          /* The connection already closed. */
        }
        return;
      }
      if (this.protocolBytesInFlight + messageBytes > MAX_CHAT_PROTOCOL_BYTES) {
        try {
          connection.close(1009, "Too much protocol data is awaiting admission");
        } catch {
          /* The connection already closed. */
        }
        return;
      }
      this.protocolBytesInFlight += messageBytes;
      try {
        if (!await this.admitProtocolMessage(connection)) return;
        let admittedUserMessageId: string | undefined;
        if (!isJsonStructureWithinLimits(message)) {
          this.rejectClientTranscript(connection, undefined, "Chat protocol message is too large.");
          return;
        }
        let envelope: Record<string, unknown>;
        let event: ReturnType<typeof parseProtocolMessage>;
        try {
          const parsedEnvelope: unknown = JSON.parse(message);
          if (!parsedEnvelope || typeof parsedEnvelope !== "object" || Array.isArray(parsedEnvelope)) {
            throw new Error("Malformed protocol envelope.");
          }
          envelope = parsedEnvelope as Record<string, unknown>;
          event = parseProtocolMessage(message);
        } catch {
          this.rejectClientTranscript(connection, undefined, "Chat protocol message is malformed.");
          return;
        }
        if (
          event?.type === "messages" ||
          event?.type === "clear" ||
          event?.type === "tool-result" ||
          event?.type === "tool-approval"
        ) {
          this.rejectClientTranscript(connection);
          return;
        }
        if (event?.type === "chat-request") {
          if (!this.assistantProvenanceReady) {
            this.rejectClientTranscript(connection, event.id, "Chat history migration must finish before sending messages.");
            return;
          }
          if (
            !isValidChatProtocolId(event.id) ||
            !event.init ||
            typeof event.init !== "object" ||
            Array.isArray(event.init) ||
            event.init.method !== "POST" ||
            typeof event.init.body !== "string"
          ) {
            this.rejectClientTranscript(connection, undefined, "Chat request id is malformed.");
            return;
          }
          if (
            event.init.body &&
            (!isWithinUtf8ByteLimit(event.init.body, MAX_CHAT_REQUEST_BODY_BYTES) ||
              !isJsonStructureWithinLimits(event.init.body))
          ) {
            this.rejectClientTranscript(connection, event.id, "Chat request body is too large.");
            return;
          }
          let body: Record<string, unknown> | undefined;
          if (event.init.method === "POST" && event.init.body) {
            try {
              const parsed: unknown = JSON.parse(event.init.body);
              body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : undefined;
            } catch {
              /* Rejected below without delegating client content to the SDK. */
            }
          }
          if (!body) {
            this.rejectClientTranscript(connection, event.id, "Chat request body is malformed.");
            return;
          } else {
            const tools = body.clientTools;
            const trigger = body.trigger;
            const submitted = Array.isArray(body.messages) ? body.messages : [];
            const latest = submitted[submitted.length - 1] as
              | { id?: unknown; parts?: Array<{ type?: unknown; text?: unknown }> }
              | undefined;
            const submittedText = latest?.parts?.[0]?.type === "text" && typeof latest.parts[0].text === "string"
              ? latest.parts[0].text
              : "";
            const actor = this.connectionIdentity(connection)?.email;
            const participantNameError = actor
              ? chatParticipantNameError(actor, this.tokenForRedaction)
              : "Authenticated chat identity is unavailable.";
            const error =
              (Object.keys(body).some((key) => !["messages", "trigger", "name", "clientTools"].includes(key))
                ? "Chat request contains unsupported fields."
                : tools !== undefined && (!Array.isArray(tools) || tools.length > 0)
                ? "Client-defined chat tools are not allowed."
                : participantNameError
                  ? participantNameError
                : trigger !== undefined && trigger !== "submit-message"
                  ? "Client-triggered regeneration is not allowed."
                   : clientChatSubmissionError(
                       this.messages,
                       body.messages,
                       (messageId) => this.wasUserMessagePreviouslyAccepted(messageId),
                     ) ??
                     (containsCloudflareApiToken(submittedText, this.tokenForRedaction)
                       ? "Cloudflare API tokens must be added through the encrypted Connection form, not chat."
                       : undefined));
            if (error) {
              this.rejectClientTranscript(connection, event.id, error);
              return;
            }
            const rateLimit = await this.chatRateLimit(connection);
            if (!this.enforceCurrentConnectionAccess(connection)) return;
            if (rateLimit.decision !== "allowed") {
              this.rejectRateLimitedChat(connection, event.id, rateLimit);
              return;
            }
            admittedUserMessageId = latest?.id as string;
            this.admittingUserMessageIds.add(admittedUserMessageId);
            const canonicalMessages = [
              ...submitted.slice(0, -1),
              {
                ...(latest as Record<string, unknown>),
                metadata: { name: actor } satisfies GlideMessageMetadata,
              },
            ];
            const init = envelope.init && typeof envelope.init === "object" && !Array.isArray(envelope.init)
              ? envelope.init as Record<string, unknown>
              : {};
            message = JSON.stringify({
              ...envelope,
              init: {
                ...init,
                body: JSON.stringify({ ...body, messages: canonicalMessages, name: actor }),
              },
            });
          }
        }
        if (
          (event?.type === "cancel" || event?.type === "stream-resume-ack") &&
          !isValidChatProtocolId(event.id)
        ) {
          this.rejectClientTranscript(connection, undefined, "Chat protocol id is malformed.");
          return;
        }
        try {
          return await handleMessage(connection, message);
        } finally {
          if (admittedUserMessageId) this.admittingUserMessageIds.delete(admittedUserMessageId);
        }
      } finally {
        this.protocolBytesInFlight -= messageBytes;
      }
    };
    const handleRequest = this.onRequest.bind(this);
    this.onRequest = async (request) => {
      if (!agentRequestHasAllowedOrigin(request)) return invalidOriginResponse();
      const identity = accessIdentityFromHeaders(request.headers);
      if (!identity || this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
        return this.roomAccessDeniedResponse();
      }
      const isHistoryRequest = new URL(request.url).pathname.split("/").pop() === "get-messages";
      if (
        !this.assistantProvenanceReady &&
        isHistoryRequest
      ) {
        const migration = this.currentLegacyChatMigrationStatus();
        return Response.json(
          {
            code: "legacy_chat_migration_incomplete",
            error: migration.message,
            message: migration.message,
            status: migration.status,
            recoveryAllowed: migration.status === "recovery_required",
            recoveryConfirmation: migration.recoveryConfirmation,
          },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      const response = await handleRequest(request);
      if (!isHistoryRequest) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "private, no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
  }

  async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const identity = accessIdentityFromHeaders(context.request.headers);
    if (
      !agentRequestHasAllowedOrigin(context.request) ||
      !identity ||
      this.isAccessIdentityExpired(identity) ||
      !this.isRoomMember(identity.email)
    ) {
      try {
        connection.close(1008, "Room membership required");
      } catch {
        /* The connection closed before authorization completed. */
      }
      return;
    }
    this.abortRoomAccessOperationsForConnection(
      connection.id,
      new Error("The socket session was replaced by a reconnect."),
    );
    const current = connection.state;
    const state = current && typeof current === "object" && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {};
    const headerRateLimitKey = context.request.headers.get(CLIENT_RATE_LIMIT_HEADER);
    const [subjectDigest, clientKey] = await Promise.all([
      opaqueRateLimitKey("access-subject", identity.subject),
      isClientRateLimitKey(headerRateLimitKey)
        ? Promise.resolve(headerRateLimitKey)
        : clientRateLimitKey(context.request),
    ]);
    // Revocation can interleave while Web Crypto derives the opaque keys.
    if (this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
      try {
        connection.close(1008, "Room membership required");
      } catch {
        /* The connection closed while authorization was being finalized. */
      }
      return;
    }
    connection.setState({
      ...state,
      glideAccessLeaseId: crypto.randomUUID(),
      glideAccessEmail: identity.email,
      glideAccessSubjectDigest: subjectDigest,
      glideAccessExpiresAt: identity.expiresAt,
      glideClientRateLimitKey: clientKey,
    });
    try {
      const expiry = await this.schedule(
        new Date(identity.expiresAt * 1_000),
        "expireAccessConnection",
        { connectionId: connection.id },
      );
      connection.setState({
        ...(connection.state as Record<string, unknown>),
        glideAccessExpiryScheduleId: expiry.id,
      });
      // Scheduling is durable I/O, so authorization may have changed while it ran.
      if (this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
        const deniedState = { ...(connection.state as GlideConnectionState) };
        delete deniedState.glideAccessLeaseId;
        delete deniedState.glideAccessEmail;
        delete deniedState.glideAccessSubjectDigest;
        delete deniedState.glideAccessExpiresAt;
        delete deniedState.glideClientRateLimitKey;
        delete deniedState.glideAccessExpiryScheduleId;
        connection.setState(deniedState);
        try {
          connection.close(1008, "Room membership required");
        } catch {
          /* The connection closed while its expiry was being scheduled. */
        }
        try {
          await this.cancelSchedule(expiry.id);
        } catch {
          this.logChatEvent("room.access_expiry_schedule_cleanup_failed", {}, "warn");
        }
        return;
      }
    } catch {
      this.logChatEvent("room.access_expiry_schedule_failed", {}, "error");
      try {
        connection.close(1011, "Unable to enforce Access session expiry");
      } catch {
        /* The connection closed while its expiry was being scheduled. */
      }
      return;
    }
    await super.onConnect(connection, context);
  }

  async onBeforeSubAgent(): Promise<Response> {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  shouldSendProtocolMessages(_connection: Connection, context: ConnectionContext): boolean {
    const identity = accessIdentityFromHeaders(context.request.headers);
    return Boolean(
      agentRequestHasAllowedOrigin(context.request) &&
      identity &&
      !this.isAccessIdentityExpired(identity) &&
      this.isRoomMember(identity.email),
    );
  }

  async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const accessLease = this.roomAccessLeaseForConnection(connection);
    if (accessLease) {
      this.abortRoomAccessOperations(
        accessLease,
        new Error("The socket session ended before the chat operation completed."),
      );
    }
    const scheduleId = (connection.state as GlideConnectionState | null)?.glideAccessExpiryScheduleId;
    if (typeof scheduleId === "string" && scheduleId.length > 0 && scheduleId.length <= 128) {
      try {
        await this.cancelSchedule(scheduleId);
      } catch {
        this.logChatEvent("room.access_expiry_schedule_cleanup_failed", {}, "warn");
      }
    }
    await super.onClose(connection, code, reason, wasClean);
  }

  async expireAccessConnection(payload: { connectionId?: unknown } | null): Promise<void> {
    const connectionId = payload?.connectionId;
    if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.length > 256) {
      this.logChatEvent("room.access_expiry_schedule_invalid", {}, "error");
      return;
    }
    for (const connection of this.getConnections(connectionId)) {
      const identity = this.connectionIdentity(connection);
      if (identity && !this.isAccessIdentityExpired(identity) && this.isRoomMember(identity.email)) continue;
      this.logChatEvent("room.access_expired", {}, "warn");
      const accessLease = this.roomAccessLeaseForConnection(connection);
      if (accessLease) {
        this.abortRoomAccessOperations(
          accessLease,
          new Error("Room membership or the Access session expired."),
        );
      }
      try {
        connection.close(1008, "Room membership or Access session expired");
      } catch {
        /* The connection already closed. */
      }
    }
  }

  private isAccessIdentityExpired(identity: AccessIdentity): boolean {
    return identity.expiresAt <= Math.floor(Date.now() / 1_000);
  }

  private connectionIdentity(connection: Connection | undefined): AccessIdentity | undefined {
    const state = connection?.state as GlideConnectionState | null | undefined;
    const email = canonicalizeEmail(state?.glideAccessEmail);
    const subjectDigest = typeof state?.glideAccessSubjectDigest === "string"
      ? state.glideAccessSubjectDigest.trim()
      : "";
    const expiresAt = state?.glideAccessExpiresAt;
    if (
      !email ||
      !ACCESS_SUBJECT_DIGEST_RE.test(subjectDigest) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt! <= 0
    ) {
      return undefined;
    }
    return { email, subject: subjectDigest, expiresAt: expiresAt! };
  }

  private isRoomMember(email: string): boolean {
    return this.sql<{ present: number }>`SELECT 1 AS present FROM glide_room_members
      WHERE email = ${email} LIMIT 1`.length > 0;
  }

  private roomMembers(): RoomMember[] {
    return this.sql<{
      email: string;
      role: RoomMember["role"];
      invited_by: string | null;
      joined_at: number;
    }>`SELECT email, role, invited_by, joined_at FROM glide_room_members
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, joined_at, email
      LIMIT ${MAX_ROOM_MEMBERS}`.map((row) => ({
        email: row.email,
        role: row.role,
        ...(row.invited_by ? { invitedBy: row.invited_by } : {}),
        joinedAt: row.joined_at,
      }));
  }

  // ---------------------------------------------------------------------------
  // Per-room RBAC. Three persisted roles (see {@link RoomRole}):
  //   owner  — full control (manage roles/members, tokens, rename, delete)
  //   member — apply/reject changes, invite teammates, manage the token
  //   viewer — read-only: may read + chat + propose (queue) changes, but may NOT
  //            apply/reject, invite, manage the token, rename, or delete.
  // Write RPCs already require a current member lease; these helpers additionally
  // block viewers from the "commit" surface. Owner-only actions gate separately.
  // ---------------------------------------------------------------------------

  /** The caller's persisted room role, or undefined if they are not a member. */
  private roomRole(email: string): RoomRole | undefined {
    return this.sql<{ role: RoomRole }>`SELECT role FROM glide_room_members
      WHERE email = ${email} LIMIT 1`[0]?.role;
  }

  /**
   * Gate a write/"commit" action behind member-or-owner (i.e. reject viewers).
   *
   * Over a browser socket, {@link currentRoomAccessLease} resolves a verified
   * member lease (or throws for a non-member); this additionally rejects viewers.
   * For DO-internal/programmatic calls there is no connection, so the lease is
   * `undefined` and no role gate applies — mirroring the pre-RBAC behavior these
   * write methods relied on (the caller is trusted server code, not a browser).
   * Returns the lease + role for attribution/audit; `capability` is woven into
   * the error a viewer sees.
   */
  private requireCommitRole(
    capability: string,
  ): { lease: RoomAccessLease | undefined; role: RoomRole | undefined } {
    const lease = this.currentRoomAccessLease();
    const role = lease ? this.roomRole(lease.email) : undefined;
    if (role === "viewer") {
      throw new Error(`Viewers have read-only access and cannot ${capability}. Ask a room owner or member.`);
    }
    return { lease, role };
  }

  /** Append one row to the append-only audit trail (best-effort; never throws). */
  private recordAudit(
    action: RoomAuditAction,
    actor: string,
    target?: string,
    detail?: string,
  ): void {
    try {
      this.sql`INSERT INTO glide_room_audit (id, ts, actor, action, target, detail)
        VALUES (${crypto.randomUUID()}, ${Date.now()}, ${actor || "system"}, ${action},
          ${target ?? null}, ${detail ?? null})`;
      this.sql`DELETE FROM glide_room_audit WHERE id IN (
        SELECT id FROM glide_room_audit ORDER BY ts DESC, id DESC
        LIMIT -1 OFFSET ${MAX_ROOM_AUDIT_ENTRIES})`;
    } catch {
      this.logChatEvent("room.audit_write_failed", { action }, "warn");
    }
  }

  /** Read recent audit rows (newest first), bounded. */
  private roomAuditEntries(limit: number): RoomAuditEntry[] {
    return this.sql<{
      id: string;
      ts: number;
      actor: string;
      action: string;
      target: string | null;
      detail: string | null;
    }>`SELECT id, ts, actor, action, target, detail FROM glide_room_audit
      ORDER BY ts DESC, id DESC LIMIT ${limit}`.map((row) => ({
        id: row.id,
        ts: row.ts,
        actor: row.actor,
        action: row.action as RoomAuditAction,
        ...(row.target ? { target: row.target } : {}),
        ...(row.detail ? { detail: row.detail } : {}),
      }));
  }

  /**
   * Owner-gated read of the room's audit trail, exported to CSV/JSON from the
   * admin dashboard. Only the room owner may read who queued/applied what.
   */
  @callable()
  async getAuditLog(limit?: unknown): Promise<RoomAuditEntry[]> {
    const { connection } = getCurrentAgent<GlideAgent>();
    const identity = this.connectionIdentity(connection);
    if (
      !identity ||
      this.isAccessIdentityExpired(identity) ||
      this.roomRole(identity.email) !== "owner"
    ) {
      throw new Error("Only the room owner can view the audit log.");
    }
    const cap = Number.isSafeInteger(limit) && (limit as number) > 0
      ? Math.min(limit as number, MAX_ROOM_AUDIT_ENTRIES)
      : DEFAULT_ROOM_AUDIT_PAGE;
    return this.roomAuditEntries(cap);
  }

  // ---------------------------------------------------------------------------
  // Deployment-wide room registry (a convenience index for the admin "all rooms"
  // view). Rooms self-report their metadata to a fixed {@link REGISTRY_SYSTEM_ROOM}
  // instance as they are activated and used; the Worker reads it for GET /api/rooms.
  // It is NOT an authorization boundary — per-room membership still governs access.
  // ---------------------------------------------------------------------------

  /** True when this instance is an internal system object (docs/registry), not a room. */
  private isReservedSystemInstance(): boolean {
    return isReservedSystemRoom(this.name);
  }

  /** Best-effort in-memory throttle so chat activity doesn't hammer the registry. */
  private lastRegistrySyncAt = 0;
  /** Set once this room is being permanently deleted, to cancel any in-flight registry re-sync. */
  private roomDestroyed = false;

  /** Create the registry table lazily; only ever used on the registry instance. */
  private ensureRoomRegistrySchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS glide_room_registry (
      id TEXT PRIMARY KEY,
      name TEXT,
      owner TEXT,
      member_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    )`;
  }

  /**
   * Build this room's registry summary from its own membership table + state.
   * Returns undefined for reserved instances or rooms with no members (nothing
   * to advertise). `id` is the DO instance name, which is the URL-hash room id.
   */
  private roomRegistrySummary(now = Date.now()): RoomSummary | undefined {
    if (this.isReservedSystemInstance()) return undefined;
    const agg = this.sql<{ count: number; created: number | null }>`
      SELECT COUNT(*) AS count, MIN(joined_at) AS created FROM glide_room_members`[0];
    const memberCount = agg?.count ?? 0;
    if (memberCount <= 0) return undefined;
    const owner = this.sql<{ email: string }>`
      SELECT email FROM glide_room_members WHERE role = 'owner' ORDER BY joined_at ASC LIMIT 1`[0]?.email;
    return {
      id: this.name,
      ...(this.state.roomName ? { name: this.state.roomName } : {}),
      ...(owner ? { owner } : {}),
      memberCount,
      createdAt: agg?.created ?? now,
      lastActiveAt: now,
    };
  }

  /**
   * Best-effort upsert of this room's summary into the registry. Fire-and-forget
   * (never blocks or fails the caller). Pass `throttleMs` for high-frequency
   * callers (chat turns) so we only refresh `lastActiveAt` periodically.
   */
  private syncRoomToRegistry(options?: { throttleMs?: number }): void {
    if (this.isReservedSystemInstance()) return;
    const now = Date.now();
    const throttleMs = options?.throttleMs ?? 0;
    if (throttleMs > 0 && now - this.lastRegistrySyncAt < throttleMs) return;
    const summary = this.roomRegistrySummary(now);
    if (!summary) return;
    this.lastRegistrySyncAt = now;
    this.ctx.waitUntil(
      (async () => {
        try {
          const registry = await getAgentByName(this.env.GlideAgent, REGISTRY_SYSTEM_ROOM);
          // A delete may have raced ahead of this deferred sync — don't resurrect it.
          if (this.roomDestroyed) return;
          await registry.upsertRoomRegistryEntry(summary);
        } catch {
          this.logChatEvent("room.registry_sync_failed", {}, "warn");
        }
      })(),
    );
  }

  /** Remove this room from the registry and await it (used before a destroy wipes storage). */
  private async removeRoomFromRegistry(id = this.name): Promise<void> {
    if (this.isReservedSystemInstance()) return;
    try {
      const registry = await getAgentByName(this.env.GlideAgent, REGISTRY_SYSTEM_ROOM);
      await registry.removeRoomRegistryEntry(id);
    } catch {
      this.logChatEvent("room.registry_remove_failed", {}, "warn");
    }
  }

  /**
   * Registry RPC (invoked only on {@link REGISTRY_SYSTEM_ROOM} via a stub):
   * insert or refresh a room row. Guarded so it is inert on real rooms. Inputs
   * are treated defensively even though callers are trusted room DOs.
   */
  async upsertRoomRegistryEntry(entry: RoomSummary): Promise<void> {
    if (this.name !== REGISTRY_SYSTEM_ROOM) return;
    const id = typeof entry?.id === "string" ? entry.id.slice(0, MAX_ROOM_STORAGE_NAME_BYTES) : "";
    if (!id) return;
    this.ensureRoomRegistrySchema();
    const name = typeof entry.name === "string" ? entry.name.slice(0, 200) || null : null;
    const owner = typeof entry.owner === "string" ? entry.owner.slice(0, MAX_ACTOR_CHARS) || null : null;
    const memberCount = Number.isFinite(entry.memberCount) ? Math.max(0, Math.trunc(entry.memberCount)) : 0;
    const now = Date.now();
    const createdAt = Number.isFinite(entry.createdAt) && entry.createdAt > 0 ? Math.trunc(entry.createdAt) : now;
    const lastActiveAt = Number.isFinite(entry.lastActiveAt) && entry.lastActiveAt > 0
      ? Math.trunc(entry.lastActiveAt)
      : now;
    this.sql`INSERT INTO glide_room_registry (id, name, owner, member_count, created_at, last_active_at)
      VALUES (${id}, ${name}, ${owner}, ${memberCount}, ${createdAt}, ${lastActiveAt})
      ON CONFLICT(id) DO UPDATE SET
        name = ${name},
        owner = ${owner},
        member_count = ${memberCount},
        last_active_at = ${lastActiveAt}`;
  }

  /** Registry RPC: drop a room row (called when a room is deleted). */
  async removeRoomRegistryEntry(id: string): Promise<void> {
    if (this.name !== REGISTRY_SYSTEM_ROOM) return;
    if (typeof id !== "string" || !id) return;
    this.ensureRoomRegistrySchema();
    this.sql`DELETE FROM glide_room_registry WHERE id = ${id}`;
  }

  /** Registry RPC: list all known rooms, most-recently-active first (bounded). */
  async listRoomRegistry(): Promise<RoomSummary[]> {
    if (this.name !== REGISTRY_SYSTEM_ROOM) return [];
    this.ensureRoomRegistrySchema();
    return this.sql<{
      id: string;
      name: string | null;
      owner: string | null;
      member_count: number;
      created_at: number;
      last_active_at: number;
    }>`SELECT id, name, owner, member_count, created_at, last_active_at
      FROM glide_room_registry ORDER BY last_active_at DESC LIMIT 1000`.map((row) => ({
        id: row.id,
        ...(row.name ? { name: row.name } : {}),
        ...(row.owner ? { owner: row.owner } : {}),
        memberCount: row.member_count,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
      }));
  }

  private roomInvitationAudit(): Invite[] {
    return this.sql<{
      email: string;
      invited_by: string;
      link: string | null;
      invited_at: number;
    }>`SELECT email, invited_by, link, invited_at FROM glide_room_invites
      ORDER BY invited_at DESC, email
      LIMIT ${MAX_ROOM_MEMBERS}`.map((row) => ({
        email: row.email,
        invitedBy: row.invited_by,
        ...(row.link ? { link: row.link } : {}),
        ts: row.invited_at,
      }));
  }

  private persistLegacyInvitationAudit(): void {
    for (const candidate of this.state.invites.slice(0, MAX_ROOM_MEMBERS)) {
      const email = canonicalizeEmail(candidate.email);
      if (!email || !Number.isSafeInteger(candidate.ts) || candidate.ts <= 0) continue;
      const invitedBy = normalizeActor(candidate.invitedBy, "legacy invite");
      const link = typeof candidate.link === "string" && candidate.link.length <= 2_048
        ? candidate.link
        : null;
      this.sql`INSERT OR IGNORE INTO glide_room_invites (email, invited_by, link, invited_at)
        VALUES (${email}, ${invitedBy}, ${link}, ${candidate.ts})`;
    }
  }

  private publishInvitationAudit(invites = this.roomInvitationAudit()): void {
    if (JSON.stringify(invites) === JSON.stringify(this.state.invites)) return;
    const nextState = { ...this.state, invites };
    if (syncedStateSizeError(nextState) && !isSafeSyncedStateTransition(this.state, nextState)) {
      this.logChatEvent("room.invite_projection_oversized", {}, "error");
      return;
    }
    try {
      this.setState(nextState);
    } catch {
      this.logChatEvent("room.invite_projection_failed", {}, "error");
    }
  }

  private roomHadExistingData(): boolean {
    const durableContent = this.sql<{ present: number }>`SELECT CASE WHEN
      EXISTS (SELECT 1 FROM cf_ai_chat_agent_messages) OR
      EXISTS (SELECT 1 FROM glide_legacy_chat_quarantine) OR
      EXISTS (SELECT 1 FROM glide_secrets) OR
      EXISTS (SELECT 1 FROM glide_migration_src) OR
      EXISTS (SELECT 1 FROM glide_room_invites) OR
      EXISTS (SELECT 1 FROM glide_action_notifications) OR
      EXISTS (SELECT 1 FROM glide_system_events) OR
      EXISTS (SELECT 1 FROM glide_assistant_events) OR
      EXISTS (SELECT 1 FROM glide_accepted_user_message_ids) OR
      EXISTS (SELECT 1 FROM glide_chat_message_id_tombstones) OR
      EXISTS (
        SELECT 1 FROM glide_chat_migration_progress
        WHERE last_rowid > 0 OR blocked_reason IS NOT NULL OR recovery_requested != 0
      ) OR
      EXISTS (SELECT 1 FROM glide_docs_products) OR
      EXISTS (SELECT 1 FROM glide_docs_pages) OR
      EXISTS (SELECT 1 FROM glide_docs_previous_pages) OR
      EXISTS (SELECT 1 FROM glide_docs_product_attempts)
      THEN 1 ELSE 0 END AS present`[0]?.present === 1;

    return durableContent ||
      this.messages.length > 0 ||
      Object.keys(this.state.memory).length > 0 ||
      this.state.pendingActions.length > 0 ||
      this.state.recentResults.length > 0 ||
      this.state.invites.length > 0 ||
      this.state.tokenConfigured ||
      this.state.tokenLast4 !== undefined ||
      this.state.tokenValid !== undefined ||
      Boolean(
        this.state.onboarding ||
        this.state.businessProfile ||
        this.state.migrationPlan ||
        this.state.terraform ||
        this.state.csv ||
        this.state.migrationCheck ||
        this.state.defaultAccountId !== undefined ||
        this.state.defaultZone !== undefined ||
        this.state.docLinks?.length ||
        this.state.snapshots?.length ||
        this.state.guidance?.length ||
        this.state.docsIndex,
      );
  }

  private isProvisionalRoom(): boolean {
    return this.sql<{ present: number }>`SELECT 1 AS present FROM glide_room_lifecycle
      WHERE id = ${"provisional"} LIMIT 1`.length > 0;
  }

  private replayedRoomActivation(
    attemptId: string | undefined,
    authorization: RoomAuthorizationResult,
  ): RoomAuthorizationResult | undefined {
    if (!authorization.allowed || !authorization.access || !attemptId) return undefined;
    const replay = this.sql<{ entry: "created" | "claimed" }>`SELECT entry FROM glide_room_activations
      WHERE id = ${attemptId} AND email = ${authorization.access.email} LIMIT 1`[0];
    if (!replay) return undefined;
    const claimed = replay.entry === "claimed";
    return {
      ...authorization,
      code: claimed ? "room_claimed" : "room_created",
      message: claimed
        ? "This legacy room is now protected by verified membership."
        : "Private room created.",
      access: { ...authorization.access, entry: replay.entry },
    };
  }

  private async retryFreshDeniedRoomCleanup(): Promise<void> {
    try {
      for (const delay of FRESH_ROOM_CLEANUP_RETRY_DELAYS_MS) {
        await scheduler.wait(delay);
        if (!this.isProvisionalRoom() || this.roomHadExistingData()) {
          this.freshRoomDestroyQueued = false;
          return;
        }
        try {
          await this.schedule(
            FRESH_ROOM_CLEANUP_DELAY_SECONDS,
            "destroyFreshDeniedRoomIfUnused",
            { freshDeniedRoom: true },
            { idempotent: true },
          );
          return;
        } catch {
          /* Retry below, then move destruction to a fresh alarm invocation. */
        }
      }
      if (!this.isProvisionalRoom() || this.roomHadExistingData()) {
        this.freshRoomDestroyQueued = false;
        return;
      }
      const memberCount = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0;
      if (memberCount !== 0) {
        this.freshRoomDestroyQueued = false;
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + FRESH_ROOM_CLEANUP_FALLBACK_ALARM_DELAY_MS);
    } catch {
      this.freshRoomDestroyQueued = false;
      this.logChatEvent("room.fresh_cleanup_retry_failed", {}, "error");
    }
  }

  /** Native fallback alarms also destroy only an unchanged provisional room. */
  async alarm(): Promise<void> {
    if (this.isProvisionalRoom() && !this.roomHadExistingData()) {
      const memberCount = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0;
      if (memberCount === 0) {
        await this.destroyFreshDeniedRoomIfUnused({ freshDeniedRoom: true });
        return;
      }
    }
    await super.alarm();
  }

  private evaluateRoomAuthorization(identity: AccessIdentity): RoomAuthorizationResult {
    const email = canonicalizeEmail(identity?.email);
    const subject = typeof identity?.subject === "string" ? identity.subject.trim() : "";
    const expiresAt = identity?.expiresAt;
    if (
      !email ||
      !subject ||
      subject.length > 512 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      return {
        allowed: false,
        code: "room_membership_required",
        message: "A current verified identity is required to open this room.",
      };
    }

    const existing = this.sql<{ role: RoomMember["role"] }>`SELECT role FROM glide_room_members
      WHERE email = ${email} LIMIT 1`[0];
    if (existing) {
      return {
        allowed: true,
        code: "member",
        message: "Room access granted.",
        access: {
          email,
          isEmployee: isCloudflareEmployeeEmail(email),
          role: existing.role,
          members: this.roomMembers(),
          entry: "member",
        },
      };
    }

    return {
      allowed: false,
      code: "room_membership_required",
      message: "This room is private. Ask a room member to invite your verified email address.",
    };
  }

  /** Durably queue cleanup for constructor-only storage left by a denied probe. */
  private async queueFreshDeniedRoomDestroy(): Promise<void> {
    if (!this.isProvisionalRoom() || this.roomHadExistingData()) return;
    const memberCount = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0;
    if (memberCount !== 0 || this.freshRoomDestroyQueued) return;

    this.freshRoomDestroyQueued = true;
    try {
      await this.schedule(
        FRESH_ROOM_CLEANUP_DELAY_SECONDS,
        "destroyFreshDeniedRoomIfUnused",
        { freshDeniedRoom: true },
        { idempotent: true },
      );
    } catch {
      this.logChatEvent("room.fresh_cleanup_schedule_failed", {}, "error");
      this.ctx.waitUntil(this.retryFreshDeniedRoomCleanup());
    }
  }

  /** Scheduled cleanup rechecks durable room state before atomically clearing storage. */
  async destroyFreshDeniedRoomIfUnused(
    payload: { freshDeniedRoom?: unknown } | null,
  ): Promise<void> {
    if (payload?.freshDeniedRoom !== true) {
      this.logChatEvent("room.fresh_cleanup_payload_invalid", {}, "error");
      return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.isProvisionalRoom() || this.roomHadExistingData()) {
        this.freshRoomDestroyQueued = false;
        return;
      }
      const memberCount = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0;
      if (memberCount !== 0) {
        this.freshRoomDestroyQueued = false;
        return;
      }
      await this.ctx.storage.deleteAll();
      setTimeout(() => this.ctx.abort("fresh denied room destroyed"), 0);
    });
  }

  private async finalizeRoomAuthorization(
    authorization: RoomAuthorizationResult,
  ): Promise<RoomAuthorizationResult> {
    if (!authorization.allowed) await this.queueFreshDeniedRoomDestroy();
    return authorization;
  }

  async authorizeRoomAccess(identity: AccessIdentity): Promise<RoomAuthorizationResult> {
    return this.finalizeRoomAuthorization(this.evaluateRoomAuthorization(identity));
  }

  /**
   * Read-only inspection for the `/admin` dashboard. Deliberately SEPARATE from
   * {@link authorizeRoomAccess} (the socket/activation gate, which stays
   * members-only) so widening inspection can never widen write access.
   *
   * - A room member is told to use the live socket (no snapshot, no audit entry).
   * - A verified Cloudflare employee who is NOT a member gets an audited,
   *   read-only snapshot of the room — state, transcript, and audit trail — and
   *   never a connection, so the inspection has zero mutation surface.
   * - Anyone else is denied. A room that was never activated (no members) is
   *   reported as non-existent and queued for provisional cleanup, so inspecting
   *   an unknown id can't materialize a junk room.
   */
  async inspectRoom(identity: AccessIdentity): Promise<RoomInspectionResult> {
    const email = canonicalizeEmail(identity?.email);
    const subject = typeof identity?.subject === "string" ? identity.subject.trim() : "";
    const expiresAt = identity?.expiresAt;
    if (
      !email ||
      !subject ||
      subject.length > 512 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      return {
        allowed: false,
        code: "room_membership_required",
        message: "A current verified identity is required to inspect this room.",
      };
    }

    const member = this.sql<{ role: RoomMember["role"] }>`SELECT role FROM glide_room_members
      WHERE email = ${email} LIMIT 1`[0];
    if (member) {
      return {
        allowed: true,
        code: "member",
        message: "Room access granted.",
        access: {
          email,
          isEmployee: isCloudflareEmployeeEmail(email),
          role: member.role,
          members: this.roomMembers(),
          entry: "member",
        },
      };
    }

    const memberCount = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0;
    if (memberCount === 0) {
      await this.queueFreshDeniedRoomDestroy();
      return {
        allowed: false,
        code: "room_membership_required",
        message: "This room does not exist yet.",
      };
    }
    if (!isCloudflareEmployeeEmail(email)) {
      return {
        allowed: false,
        code: "room_membership_required",
        message: "This room is private. Ask a room member to invite your verified email address.",
      };
    }

    this.recordAudit("inspect", email, undefined, "Opened the read-only admin inspector");
    return {
      allowed: true,
      code: "inspect",
      message: "Read-only inspection access granted.",
      access: {
        email,
        isEmployee: true,
        role: "inspector",
        members: this.roomMembers(),
        entry: "inspect",
      },
      snapshot: {
        state: this.state,
        messages: this.messages,
        audit: this.roomAuditEntries(DEFAULT_ROOM_AUDIT_PAGE),
      },
    };
  }

  async activateRoomAccess(
    identity: AccessIdentity,
    canonicalRoomId: boolean,
    attemptId?: string,
  ): Promise<RoomAuthorizationResult> {
    // Activation must evaluate without cleanup: a valid first employee may turn
    // this same freshly-created instance into a durable room below.
    const authorized = this.evaluateRoomAuthorization(identity);
    if (authorized.allowed) return this.replayedRoomActivation(attemptId, authorized) ?? authorized;

    const email = canonicalizeEmail(identity?.email);
    const subject = typeof identity?.subject === "string" ? identity.subject.trim() : "";
    const expiresAt = identity?.expiresAt;
    if (
      !email ||
      !subject ||
      subject.length > 512 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Math.floor(Date.now() / 1_000)
    ) return this.finalizeRoomAuthorization(authorized);

    const hadExistingData = this.roomHadExistingData();
    if (!canonicalRoomId && !hadExistingData) {
      return this.finalizeRoomAuthorization({
        allowed: false,
        code: "legacy_room_not_found",
        message: "That legacy room does not exist. Create a room with a URL-safe room id.",
      });
    }

    const activation = this.durableStorage.transactionSync(() => {
      const member = this.sql<{ role: RoomMember["role"] }>`SELECT role FROM glide_room_members
        WHERE email = ${email} LIMIT 1`[0];
      if (member) {
        this.sql`DELETE FROM glide_room_lifecycle WHERE id = ${"provisional"}`;
        return { role: member.role, inserted: false };
      }
      const count = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0;
      if (count !== 0 || !isCloudflareEmployeeEmail(email)) return undefined;

      const now = Date.now();
      this.sql`INSERT INTO glide_room_members (email, role, invited_by, joined_at)
        VALUES (${email}, ${"owner"}, ${null}, ${now})`;
      this.sql`DELETE FROM glide_room_lifecycle WHERE id = ${"provisional"}`;
      if (hadExistingData) this.persistLegacyInvitationAudit();
      if (attemptId) {
        this.sql`INSERT OR REPLACE INTO glide_room_activations (id, email, entry, activated_at)
          VALUES (${attemptId}, ${email}, ${hadExistingData ? "claimed" : "created"}, ${now})`;
      }
      return { role: "owner" as const, inserted: true };
    });

    if (!activation) {
      return this.finalizeRoomAuthorization({
        allowed: false,
        code: "room_membership_required",
        message: "This room is private. Ask a room member to invite your verified email address.",
      });
    }
    if (!activation.inserted) return this.evaluateRoomAuthorization(identity);

    // Advertise the newly created/claimed room to the deployment-wide registry.
    this.syncRoomToRegistry();

    const entry = hadExistingData ? "claimed" : "created";
    return {
      allowed: true,
      code: hadExistingData ? "room_claimed" : "room_created",
      message: hadExistingData
        ? "This legacy room is now protected by verified membership."
        : "Private room created.",
      access: {
        email,
        isEmployee: true,
        role: activation.role,
        members: this.roomMembers(),
        entry,
      },
    };
  }

  @callable()
  async roomAccessStatus(): Promise<RoomAccessStatus> {
    const { connection } = getCurrentAgent<GlideAgent>();
    const identity = this.connectionIdentity(connection);
    if (!identity || this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
      throw new Error("Room membership is no longer active. Reconnect through Cloudflare Access.");
    }
    const role = this.sql<{ role: RoomMember["role"] }>`SELECT role FROM glide_room_members
      WHERE email = ${identity.email} LIMIT 1`[0]!.role;
    return {
      email: identity.email,
      isEmployee: isCloudflareEmployeeEmail(identity.email),
      role,
      members: this.roomMembers(),
      entry: "member",
    };
  }

  private roomAccessDeniedResponse(): Response {
    return Response.json(
      {
        code: "room_membership_required",
        message: "This room is private. Ask a room member to invite your verified email address.",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  private verifiedActor(value: unknown, fallback = "a teammate"): string {
    return this.currentRoomAccessLease()?.email ?? normalizeActor(value, fallback);
  }

  private roomAccessLeaseForConnection(connection: Connection | undefined): RoomAccessLease | undefined {
    if (!connection) return undefined;
    const identity = this.connectionIdentity(connection);
    const leaseId = (connection.state as GlideConnectionState | null)?.glideAccessLeaseId;
    if (
      !identity ||
      typeof leaseId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(leaseId)
    ) {
      return undefined;
    }
    return {
      connectionId: connection.id,
      leaseId,
      email: identity.email,
      expiresAt: identity.expiresAt,
    };
  }

  private currentRoomAccessLease(): RoomAccessLease | undefined {
    const { connection } = getCurrentAgent<GlideAgent>();
    if (!connection) return undefined;
    const lease = this.roomAccessLeaseForConnection(connection);
    if (
      !lease ||
      lease.expiresAt <= Math.floor(Date.now() / 1_000) ||
      !this.isRoomMember(lease.email)
    ) {
      throw new Error("Room membership is no longer active. Reconnect through Cloudflare Access.");
    }
    return lease;
  }

  private currentChatRoomAccessLease(): RoomAccessLease | undefined {
    const { connection } = getCurrentAgent<GlideAgent>();
    return connection ? this.currentRoomAccessLease() : roomAccessProgrammaticTurn.getStore();
  }

  private isRoomAccessLeaseCurrent(lease: RoomAccessLease | undefined): boolean {
    if (!lease) return true;
    for (const connection of this.getConnections(lease.connectionId)) {
      const identity = this.connectionIdentity(connection);
      const leaseId = (connection.state as GlideConnectionState | null)?.glideAccessLeaseId;
      if (
        leaseId === lease.leaseId &&
        identity &&
        identity.email === lease.email &&
        identity.expiresAt === lease.expiresAt &&
        !this.isAccessIdentityExpired(identity) &&
        this.isRoomMember(identity.email)
      ) return true;
    }
    return false;
  }

  private registerRoomAccessAborter(
    lease: RoomAccessLease,
    abort: (reason: Error) => void,
  ): () => void {
    let byLease = this.roomAccessAborters.get(lease.connectionId);
    if (!byLease) {
      byLease = new Map();
      this.roomAccessAborters.set(lease.connectionId, byLease);
    }
    let aborters = byLease.get(lease.leaseId);
    if (!aborters) {
      aborters = new Set();
      byLease.set(lease.leaseId, aborters);
    }
    aborters.add(abort);
    if (!this.isRoomAccessLeaseCurrent(lease)) {
      abort(new Error("Room access ended before the operation started."));
    }
    return () => {
      aborters!.delete(abort);
      if (aborters!.size === 0) byLease!.delete(lease.leaseId);
      if (byLease!.size === 0) this.roomAccessAborters.delete(lease.connectionId);
    };
  }

  private abortRoomAccessOperations(lease: RoomAccessLease, reason: Error): void {
    const aborters = this.roomAccessAborters.get(lease.connectionId)?.get(lease.leaseId);
    if (!aborters) return;
    for (const abort of [...aborters]) abort(reason);
  }

  private abortRoomAccessOperationsForConnection(connectionId: string, reason: Error): void {
    const byLease = this.roomAccessAborters.get(connectionId);
    if (!byLease) return;
    for (const aborters of byLease.values()) {
      for (const abort of [...aborters]) abort(reason);
    }
  }

  private isChatTurnAccessCurrent(turn: ChatTurnContext): boolean {
    return !turn.abortSignal?.aborted && this.isRoomAccessLeaseCurrent(turn.accessLease);
  }

  private chatTurnAccessError(): string {
    return "Error: room access ended before this chat operation completed.";
  }

  private checkRateLimit(limiter: RateLimiter, key: string): Promise<RateLimitDecision> {
    return consumeRateLimit(limiter, key);
  }

  private async connectionRateLimitKey(connection: Connection): Promise<string> {
    const state = connection.state as GlideConnectionState | null;
    const key = state?.glideClientRateLimitKey;
    return typeof key === "string" && key.length <= 128
      ? key
      : opaqueRateLimitKey("client", "unidentified");
  }

  private async admitProtocolMessage(connection: Connection): Promise<boolean> {
    if (!this.enforceCurrentConnectionAccess(connection)) return false;
    const decision = await this.checkRateLimit(
      this.env.AGENT_RATE_LIMITER,
      `protocol:${await this.connectionRateLimitKey(connection)}`,
    );
    if (decision === "allowed") return this.enforceCurrentConnectionAccess(connection);
    this.logChatEvent(
      decision === "limited" ? "rate_limit.exceeded" : "rate_limit.unavailable",
      { scope: "agent_protocol" },
      decision === "limited" ? "warn" : "error",
    );
    try {
      connection.close(
        1013,
        decision === "limited" ? "Rate limit exceeded; retry later" : "Rate limiter unavailable; retry later",
      );
    } catch {
      /* The connection already closed. */
    }
    return false;
  }

  private enforceCurrentConnectionAccess(connection: Connection): boolean {
    const identity = this.connectionIdentity(connection);
    if (identity && !this.isAccessIdentityExpired(identity) && this.isRoomMember(identity.email)) {
      return true;
    }
    this.logChatEvent("room.access_revoked", {}, "warn");
    try {
      connection.close(1008, "Room membership or Access session expired");
    } catch {
      /* The connection already closed. */
    }
    return false;
  }

  private async chatRateLimit(
    connection: Connection,
  ): Promise<{ decision: RateLimitDecision; scope: "chat_client" | "chat_room" }> {
    const clientDecision = await this.checkRateLimit(
      this.env.CHAT_RATE_LIMITER,
      `chat-client:${await this.connectionRateLimitKey(connection)}`,
    );
    if (clientDecision !== "allowed") return { decision: clientDecision, scope: "chat_client" };

    const roomKey = await opaqueRateLimitKey("room", this.name);
    const roomDecision = await this.checkRateLimit(this.env.CHAT_RATE_LIMITER, `chat-room:${roomKey}`);
    return { decision: roomDecision, scope: "chat_room" };
  }

  private async expensiveOperationRateLimit(): Promise<string | undefined> {
    const { connection } = getCurrentAgent<GlideAgent>();
    if (!connection) return undefined;
    const result = await this.chatRateLimit(connection);
    if (!this.enforceCurrentConnectionAccess(connection)) {
      return "Room membership is no longer active. Reconnect through Cloudflare Access.";
    }
    if (result.decision === "allowed") return undefined;
    this.logChatEvent(
      result.decision === "limited" ? "rate_limit.exceeded" : "rate_limit.unavailable",
      { scope: result.scope },
      result.decision === "limited" ? "warn" : "error",
    );
    return result.decision === "limited"
      ? "Too many expensive room operations were requested. Wait about a minute and try again."
      : "Glide's abuse protection is temporarily unavailable. Retry shortly.";
  }

  private rejectRateLimitedChat(
    connection: Connection,
    requestId: string,
    rateLimit: { decision: RateLimitDecision; scope: "chat_client" | "chat_room" },
  ): void {
    if (rateLimit.decision === "allowed") return;
    const reason = rateLimit.decision === "limited"
      ? "Too many chat messages were sent. Wait about a minute and try again."
      : "Glide's chat abuse protection is temporarily unavailable. Retry shortly.";
    this.sendChatRequestError(connection, requestId, reason);
    this.logChatEvent(
      rateLimit.decision === "limited" ? "rate_limit.exceeded" : "rate_limit.unavailable",
      { scope: rateLimit.scope, requestId },
      rateLimit.decision === "limited" ? "warn" : "error",
    );
  }

  private hideUnregisteredAssistantMessages(): void {
    const userIds = new Set(
      this.messages.filter((message) => message.role === "user").map((message) => message.id),
    );
    this.messages = this.messages.filter((message) => {
      if (message.role !== "assistant") return true;
      const responseTo = this.registeredAssistantResponse(message.id);
      return Boolean(responseTo && userIds.has(responseTo));
    });
  }

  private migrateLegacyArchiveBatch(): number {
    return this.durableStorage.transactionSync(() => {
      const cursor = Number(this.sql<{ last_rowid: number }>`SELECT last_rowid
        FROM glide_chat_migration_progress
        WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`[0]?.last_rowid ?? 0);
      const candidates = this.sql<{ source_rowid: number; bytes: number }>`
        SELECT
          rowid AS source_rowid,
          length(CAST(message AS BLOB)) + length(CAST(id AS BLOB)) + 512 AS bytes
        FROM glide_legacy_chat_quarantine
        WHERE rowid > ${cursor} AND reason IS NULL
        ORDER BY rowid
        LIMIT ${LEGACY_CHAT_MIGRATION_BATCH_SIZE}
      `;
      const selectedRowIds: number[] = [];
      let selectedBytes = 0;
      for (const candidate of candidates) {
        const bytes = Number(candidate.bytes);
        if (selectedRowIds.length > 0 && selectedBytes + bytes > LEGACY_CHAT_MIGRATION_BATCH_BYTES) break;
        selectedRowIds.push(Number(candidate.source_rowid));
        selectedBytes += bytes;
      }
      if (!selectedRowIds.length) return 0;
      const rows = this.sql<{
        source_rowid: number;
        id: string | null;
        message: string | null;
        oversized: number;
      }>`
        SELECT
          rowid AS source_rowid,
          CASE
            WHEN length(CAST(id AS BLOB)) BETWEEN 1 AND 200
              AND id NOT GLOB '*[^A-Za-z0-9_-]*'
            THEN id
            ELSE NULL
          END AS id,
          CASE
            WHEN length(CAST(message AS BLOB)) <= ${MAX_LEGACY_ARCHIVE_MESSAGE_BYTES}
            THEN message
            ELSE NULL
          END AS message,
          length(CAST(message AS BLOB)) > ${MAX_LEGACY_ARCHIVE_MESSAGE_BYTES} AS oversized
        FROM glide_legacy_chat_quarantine
        WHERE rowid IN (SELECT value FROM json_each(${JSON.stringify(selectedRowIds)}))
        ORDER BY rowid
      `;
      for (const row of rows) {
        const now = Date.now();
        if (row.id) {
          this.sql`INSERT OR IGNORE INTO glide_chat_message_id_tombstones (message_id) VALUES (${row.id})`;
        }
        const role = row.id && row.message ? persistedChatMessageRole(row.id, row.message) : undefined;
        if (
          role === "user" &&
          this.sql<{ registered: number }>`SELECT 1 AS registered FROM glide_system_events
            WHERE id = ${row.id}`.length === 0
        ) {
          this.sql`INSERT OR IGNORE INTO glide_accepted_user_message_ids (message_id) VALUES (${row.id})`;
        }
        const sourceOversized = Number(row.oversized) === 1;
        const redacted = sourceOversized
          ? ""
          : redactCloudflareApiTokens(row.message ?? "", this.tokenForRedaction);
        const oversized = sourceOversized ||
          !isWithinUtf8ByteLimit(redacted, MAX_LEGACY_ARCHIVE_MESSAGE_BYTES);
        const archivedMessage = oversized
          ? JSON.stringify({
              id: row.id ?? `legacy-row-${row.source_rowid}`,
              role: "system",
              parts: [{ type: "text", text: "[oversized legacy message omitted]" }],
            })
          : redacted;
        const reason = oversized
          ? "oversized_legacy_message"
          : role === "assistant"
            ? "unverified_legacy_assistant"
            : role === "user"
              ? "legacy_transcript"
              : "invalid_legacy_message";
        this.sql`UPDATE glide_legacy_chat_quarantine
          SET message = ${archivedMessage}, reason = ${reason}, quarantined_at = ${now}, redacted_at = ${now}
          WHERE rowid = ${row.source_rowid}`;
      }
      const lastRowId = Number(rows[rows.length - 1]?.source_rowid ?? cursor);
      this.sql`UPDATE glide_chat_migration_progress SET last_rowid = ${lastRowId}
        WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`;
      return rows.length;
    });
  }

  private archiveUnregisteredActiveMessages(): {
    quarantinedIds: Set<string>;
    archivedCount: number;
  } {
    const quarantinedIds = new Set<string>();
    let archivedCount = 0;
    this.durableStorage.transactionSync(() => {
      const rows = this.sql<{ id: string; message: string; created_at: string | null }>`
        SELECT id, message, CAST(created_at AS TEXT) AS created_at
        FROM cf_ai_chat_agent_messages
        ORDER BY created_at, rowid
      `.map((row) => ({ ...row, role: persistedChatMessageRole(row.id, row.message) }));
      const userIds = new Set(rows.filter((row) => row.role === "user").map((row) => row.id));

      for (const row of rows) {
        if (row.role === "user") continue;
        const registered = row.role === "assistant"
          ? this.sql<{ response_to: string }>`SELECT response_to
              FROM glide_assistant_events WHERE id = ${row.id}`[0]?.response_to
          : undefined;
        if (registered && userIds.has(registered)) continue;
        if (registered) this.sql`DELETE FROM glide_assistant_events WHERE id = ${row.id}`;

        const now = Date.now();
        const reason = row.role === "assistant" ? "unverified_legacy_assistant" : "invalid_legacy_message";
        const redacted = redactCloudflareApiTokens(row.message, this.tokenForRedaction);
        const oversized = !isWithinUtf8ByteLimit(redacted, MAX_LEGACY_ARCHIVE_MESSAGE_BYTES);
        const archivedMessage = oversized
          ? JSON.stringify({
              id: isValidChatProtocolId(row.id) ? row.id : `active-row-${archivedCount + 1}`,
              role: "system",
              parts: [{ type: "text", text: "[oversized legacy message omitted]" }],
            })
          : redacted;
        this.sql`INSERT OR IGNORE INTO glide_legacy_chat_quarantine
          (id, message, created_at, reason, quarantined_at, redacted_at)
          VALUES (${row.id}, ${archivedMessage}, ${row.created_at}, ${oversized ? "oversized_legacy_message" : reason}, ${now}, ${now})`;
        if (isValidChatProtocolId(row.id)) {
          this.sql`INSERT OR IGNORE INTO glide_chat_message_id_tombstones (message_id) VALUES (${row.id})`;
        }
        this.sql`DELETE FROM cf_ai_chat_agent_messages WHERE id = ${row.id}`;
        quarantinedIds.add(row.id);
        archivedCount += 1;
      }
      this.sql`DELETE FROM glide_assistant_events
        WHERE id NOT IN (SELECT id FROM cf_ai_chat_agent_messages)`;
    });
    return { quarantinedIds, archivedCount };
  }

  private migrateLegacyAssistantProvenance(): {
    complete: boolean;
    quarantinedIds: Set<string>;
    archivedCount: number;
  } {
    const archivedCount = this.migrateLegacyArchiveBatch();
    const cursor = Number(this.sql<{ last_rowid: number }>`SELECT last_rowid
      FROM glide_chat_migration_progress
      WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`[0]?.last_rowid ?? 0);
    const remaining = this.sql<{ pending: number }>`SELECT 1 AS pending
      FROM glide_legacy_chat_quarantine WHERE rowid > ${cursor} AND reason IS NULL LIMIT 1`;
    if (remaining.length) {
      return { complete: false, quarantinedIds: new Set(), archivedCount };
    }
    const active = this.archiveUnregisteredActiveMessages();
    return {
      complete: true,
      quarantinedIds: active.quarantinedIds,
      archivedCount: archivedCount + active.archivedCount,
    };
  }

  private discardLegacyChatArchiveBatch(): { complete: boolean; discardedCount: number } {
    return this.durableStorage.transactionSync(() => {
      const candidates = this.sql<{ source_rowid: number; bytes: number }>`
        SELECT
          rowid AS source_rowid,
          length(CAST(message AS BLOB)) + length(CAST(id AS BLOB)) + 512 AS bytes
        FROM glide_legacy_chat_quarantine
        WHERE reason IS NULL OR reason <> ${"retention_limit"}
        ORDER BY rowid
        LIMIT ${LEGACY_CHAT_MIGRATION_BATCH_SIZE}
      `;
      const selectedRowIds: number[] = [];
      let selectedBytes = 0;
      for (const candidate of candidates) {
        const bytes = Number(candidate.bytes);
        if (selectedRowIds.length > 0 && selectedBytes + bytes > LEGACY_CHAT_MIGRATION_BATCH_BYTES) break;
        selectedRowIds.push(Number(candidate.source_rowid));
        selectedBytes += bytes;
      }
      if (!selectedRowIds.length) return { complete: true, discardedCount: 0 };

      const rowIds = JSON.stringify(selectedRowIds);
      this.sql`INSERT OR IGNORE INTO glide_chat_message_id_tombstones (message_id)
        SELECT id
        FROM glide_legacy_chat_quarantine
        WHERE rowid IN (SELECT value FROM json_each(${rowIds}))
          AND length(CAST(id AS BLOB)) BETWEEN 1 AND 200
          AND id NOT GLOB '*[^A-Za-z0-9_-]*'`;
      this.sql`DELETE FROM glide_legacy_chat_quarantine
        WHERE rowid IN (SELECT value FROM json_each(${rowIds}))`;
      const remaining = this.sql<{ pending: number }>`SELECT 1 AS pending
        FROM glide_legacy_chat_quarantine
        WHERE reason IS NULL OR reason <> ${"retention_limit"}
        LIMIT 1`;
      return { complete: remaining.length === 0, discardedCount: selectedRowIds.length };
    });
  }

  private completeLegacyChatMigration(): void {
    this.durableStorage.transactionSync(() => {
      this.sql`INSERT OR IGNORE INTO glide_chat_migrations (id, applied_at)
        VALUES (${ASSISTANT_PROVENANCE_MIGRATION_ID}, ${Date.now()})`;
      this.sql`DELETE FROM glide_chat_migration_progress WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`;
      this.sql`DELETE FROM glide_assistant_events
        WHERE id NOT IN (SELECT id FROM cf_ai_chat_agent_messages)`;
    });
    this.assistantProvenanceReady = true;
  }

  private async sanitizeAndCompleteLegacyChatMigration(): Promise<void> {
    this.assistantMigrationFinalizing = true;
    try {
      await this.sanitizePersistedChatHistory();
      this.completeLegacyChatMigration();
    } finally {
      this.assistantMigrationFinalizing = false;
    }
  }

  private currentLegacyChatMigrationStatus(): LegacyChatMigrationStatus {
    if (this.assistantProvenanceReady) {
      return { status: "ready", message: "Room history is ready." };
    }
    const progress = this.sql<{ blocked_reason: string | null; recovery_requested: number }>`
      SELECT blocked_reason, recovery_requested
      FROM glide_chat_migration_progress
      WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}
    `[0];
    if (Number(progress?.recovery_requested) === 1) {
      return {
        status: "discarding",
        message: "The unrecoverable legacy archive is being discarded in bounded background batches.",
      };
    }
    if (progress?.blocked_reason === LEGACY_CHAT_TOKEN_DECRYPTION_FAILED) {
      return {
        status: "recovery_required",
        message: "The legacy archive cannot be redacted because the room token cannot be decrypted.",
        recoveryConfirmation: LEGACY_CHAT_RECOVERY_CONFIRMATION,
      };
    }
    return {
      status: "migrating",
      message: progress?.blocked_reason === LEGACY_CHAT_ENCRYPTION_KEY_UNAVAILABLE
        ? "Room history migration is waiting for the GLIDE_TOKEN_KEY secret."
        : "Room history migration is still running.",
    };
  }

  private async armLegacyChatMigration(delaySeconds: number, replace = false): Promise<void> {
    // Create the successor before removing stale rows. During an alarm callback,
    // idempotent scheduling would return the currently executing one-shot row,
    // which the SDK deletes as soon as the callback returns.
    const successor = await this.schedule(
      delaySeconds,
      "continueLegacyChatMigration",
      { migration: ASSISTANT_PROVENANCE_MIGRATION_ID },
      { idempotent: !replace },
    );
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback !== "continueLegacyChatMigration" || schedule.id === successor.id) continue;
      try {
        await this.cancelSchedule(schedule.id);
      } catch {
        this.logChatEvent("chat.assistant_provenance_schedule_cleanup_failed", {}, "warn");
      }
    }
  }

  private async cancelLegacyChatMigrationSchedules(): Promise<void> {
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "continueLegacyChatMigration") await this.cancelSchedule(schedule.id);
    }
  }

  private async attemptLegacyChatMigration(replaceSchedule = false): Promise<void> {
    if (this.assistantProvenanceReady || this.assistantMigrationRunning) return;
    this.assistantMigrationRunning = true;
    this.assistantMigrationAttempted = true;
    try {
      const recoveryRequested = Number(this.sql<{ recovery_requested: number }>`
        SELECT recovery_requested
        FROM glide_chat_migration_progress
        WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}
      `[0]?.recovery_requested) === 1;
      if (recoveryRequested) {
        const active = this.archiveUnregisteredActiveMessages();
        this.messages = this.messages.filter((message) => !active.quarantinedIds.has(message.id));
        const discarded = this.discardLegacyChatArchiveBatch();
        const discardedThisBatch = discarded.discardedCount + active.archivedCount;
        if (discardedThisBatch) {
          this.logChatEvent(
            "chat.legacy_archive_recovery_batch",
            { messageCount: discardedThisBatch },
            "warn",
          );
        }
        if (!discarded.complete) {
          await this.armLegacyChatMigration(LEGACY_CHAT_MIGRATION_DELAY_SEC, replaceSchedule);
          return;
        }
        await this.sanitizeAndCompleteLegacyChatMigration();
        await this.cancelLegacyChatMigrationSchedules();
        this.logChatEvent("chat.legacy_archive_recovery_completed", {}, "warn");
        return;
      }

      const token = await this.getToken();
      const encryptedTokenStored = this.sql<{ value: string }>`SELECT value FROM glide_secrets
        WHERE name = ${TOKEN_SECRET_NAME}`[0]?.value;
      if (encryptedTokenStored && !token) {
        const blockedReason = this.env.GLIDE_TOKEN_KEY
          ? LEGACY_CHAT_TOKEN_DECRYPTION_FAILED
          : LEGACY_CHAT_ENCRYPTION_KEY_UNAVAILABLE;
        this.sql`UPDATE glide_chat_migration_progress
          SET blocked_reason = ${blockedReason}
          WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`;
        this.logChatEvent("chat.assistant_provenance_migration_blocked", {}, "error");
        await this.armLegacyChatMigration(LEGACY_CHAT_MIGRATION_RETRY_SEC, replaceSchedule);
        return;
      }
      this.sql`UPDATE glide_chat_migration_progress
        SET blocked_reason = NULL
        WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`;

      const { complete, quarantinedIds, archivedCount } = this.migrateLegacyAssistantProvenance();
      this.messages = this.messages.filter((message) => !quarantinedIds.has(message.id));
      if (archivedCount) {
        this.logChatEvent("chat.legacy_messages_quarantined", { messageCount: archivedCount }, "warn");
      }
      if (!complete) {
        await this.armLegacyChatMigration(LEGACY_CHAT_MIGRATION_DELAY_SEC, replaceSchedule);
        return;
      }

      await this.sanitizeAndCompleteLegacyChatMigration();
      await this.cancelLegacyChatMigrationSchedules();
    } catch {
      this.hideUnregisteredAssistantMessages();
      this.logChatEvent("chat.assistant_provenance_migration_failed", {}, "error");
      await this.armLegacyChatMigration(LEGACY_CHAT_MIGRATION_RETRY_SEC, replaceSchedule);
    } finally {
      this.assistantMigrationRunning = false;
    }
  }

  async continueLegacyChatMigration(): Promise<void> {
    await this.attemptLegacyChatMigration(true);
  }

  @callable()
  async legacyChatMigrationStatus(): Promise<LegacyChatMigrationStatus> {
    const status = this.currentLegacyChatMigrationStatus();
    if (status.status !== "ready" && !this.assistantMigrationRunning) {
      const scheduled = (await this.listSchedules()).some(
        (schedule) => schedule.callback === "continueLegacyChatMigration",
      );
      if (!scheduled) {
        await this.armLegacyChatMigration(
          status.status === "discarding" ? LEGACY_CHAT_MIGRATION_DELAY_SEC : LEGACY_CHAT_MIGRATION_RETRY_SEC,
        );
      }
    }
    return this.currentLegacyChatMigrationStatus();
  }

  @callable()
  async discardLegacyChatArchiveForRecovery(
    confirmation: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.discardLegacyChatArchiveForRecoveryInternal(
      confirmation,
      this.currentRoomAccessLease(),
    );
  }

  private async discardLegacyChatArchiveForRecoveryInternal(
    confirmation: string,
    accessLease?: RoomAccessLease,
  ): Promise<{ ok: boolean; message: string }> {
    if (
      typeof confirmation !== "string" ||
      confirmation.length !== LEGACY_CHAT_RECOVERY_CONFIRMATION.length ||
      confirmation !== LEGACY_CHAT_RECOVERY_CONFIRMATION
    ) {
      return { ok: false, message: `Type ${LEGACY_CHAT_RECOVERY_CONFIRMATION} to confirm archive deletion.` };
    }
    if (this.currentLegacyChatMigrationStatus().status !== "recovery_required" || !this.env.GLIDE_TOKEN_KEY) {
      return { ok: false, message: "Legacy archive recovery is not available in the room's current state." };
    }
    const encryptedTokenStored = this.sql<{ value: string }>`SELECT value FROM glide_secrets
      WHERE name = ${TOKEN_SECRET_NAME}`[0]?.value;
    if (!encryptedTokenStored) {
      return { ok: false, message: "The stored token is no longer in the unrecoverable state." };
    }
    const token = await this.getToken();
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, message: "Room access ended before archive deletion could be authorized." };
    }
    if (token) return { ok: false, message: "The stored token is no longer in the unrecoverable state." };
    const armed = this.durableStorage.transactionSync(() => {
      const eligible = this.sql<{ eligible: number }>`SELECT 1 AS eligible
        FROM glide_chat_migration_progress AS progress
        JOIN glide_secrets AS secret ON secret.name = ${TOKEN_SECRET_NAME}
        WHERE progress.id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}
          AND progress.blocked_reason = ${LEGACY_CHAT_TOKEN_DECRYPTION_FAILED}
          AND progress.recovery_requested = 0
          AND secret.value = ${encryptedTokenStored}
          AND NOT EXISTS (
            SELECT 1 FROM glide_chat_migrations WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}
          )`;
      if (!eligible.length) return false;
      this.sql`UPDATE glide_chat_migration_progress
        SET recovery_requested = 1
        WHERE id = ${ASSISTANT_PROVENANCE_MIGRATION_ID}`;
      return true;
    });
    if (!armed) {
      return { ok: false, message: "Legacy archive recovery is no longer available; refresh the room status." };
    }
    await this.attemptLegacyChatMigration(true);
    const status = this.currentLegacyChatMigrationStatus();
    return {
      ok: true,
      message: status.status === "ready"
        ? "Legacy chat archive discarded; room history is unlocked."
        : "Legacy archive deletion started and will continue in bounded background batches.",
    };
  }

  private archiveRetentionMessages(messages: readonly UIMessage[]): void {
    if (!messages.length) return;
    this.durableStorage.transactionSync(() => {
      for (const message of messages) {
        const now = Date.now();
        const serialized = redactCloudflareApiTokens(JSON.stringify(message), this.tokenForRedaction);
        this.sql`INSERT OR IGNORE INTO glide_chat_message_id_tombstones (message_id) VALUES (${message.id})`;
        this.sql`INSERT OR IGNORE INTO glide_legacy_chat_quarantine
          (id, message, created_at, reason, quarantined_at, redacted_at)
          VALUES (${message.id}, ${serialized}, ${null}, ${"retention_limit"}, ${now}, ${now})`;
      }
    });
  }

  private async sanitizePersistedChatHistory(): Promise<void> {
    const redactedMessages = this.messages.map((message) => this.sanitizeMessageForPersistence(message));
    const redactedCount = redactedMessages.reduce(
      (count, message, index) => count + (message === this.messages[index] ? 0 : 1),
      0,
    );
    const boundedMessages = boundedChatHistory(
      redactedMessages,
      MAX_PERSISTED_CHAT_MESSAGES,
      MAX_PERSISTED_CHAT_HISTORY_BYTES,
    );
    if (redactedCount > 0 || boundedMessages.length < this.messages.length) {
      await this.persistMessages(redactedMessages);
      this.logChatEvent("chat.secrets_redacted", { messageCount: redactedCount }, "warn");
    }
  }

  private sendChatRequestError(connection: Connection, requestId: string | undefined, reason: string): void {
    if (!requestId) return;
    try {
      connection.send(JSON.stringify({
        body: reason,
        done: true,
        error: true,
        id: requestId,
        type: MessageType.CF_AGENT_USE_CHAT_RESPONSE,
      }));
    } catch {
      /* The client disconnected before it could receive the bounded rejection. */
    }
  }

  private rejectClientTranscript(
    connection: Connection,
    requestId?: string,
    reason = "Client transcript updates are not allowed.",
  ): void {
    this.sendChatRequestError(connection, requestId, reason);
    this.logChatEvent("chat.client_transcript_rejected", { requestId: requestId ?? "none" }, "warn");
  }

  override async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean },
  ): Promise<void> {
    if (!this.assistantProvenanceReady && !this.assistantMigrationFinalizing) {
      if (this.assistantMigrationAttempted) {
        throw new Error("Chat history migration is incomplete; persisted messages were not changed.");
      }
      const maxPersistedMessages = this.maxPersistedMessages;
      this.maxPersistedMessages = Number.MAX_SAFE_INTEGER;
      try {
        await super.persistMessages(messages, excludeBroadcastIds, { ...options, _deleteStaleRows: false });
        this.hideUnregisteredAssistantMessages();
      } finally {
        this.maxPersistedMessages = maxPersistedMessages;
      }
      return;
    }
    const sanitized = messages.map((message) => this.sanitizeMessageForPersistence(message));
    const bounded = boundedChatHistory(
      sanitized,
      MAX_PERSISTED_CHAT_MESSAGES,
      MAX_PERSISTED_CHAT_HISTORY_BYTES,
    );
    const previous = this.messages;
    const previousIds = new Set(previous.map((message) => message.id));
    const retainedIds = new Set(bounded.map((message) => message.id));
    this.archiveRetentionMessages(
      sanitized.filter((message) => previousIds.has(message.id) && !retainedIds.has(message.id)),
    );
    this.messages = bounded;
    try {
      await super.persistMessages(bounded, excludeBroadcastIds, { ...options, _deleteStaleRows: true });
    } catch (error) {
      this.messages = previous;
      throw error;
    }
    this.sql`DELETE FROM glide_assistant_events
      WHERE id NOT IN (SELECT id FROM cf_ai_chat_agent_messages)`;
  }

  /** Room clients consume synced state but may only mutate it through validated RPCs. */
  validateStateChange(nextState: GlideState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Direct client state changes are not allowed.");
    const sizeError = syncedStateSizeError(nextState);
    if (sizeError && !isSafeSyncedStateTransition(this.state, nextState)) throw new Error(sizeError);
  }

  /** Plaintext exists only in memory and lets persistence scrub this room's legacy unprefixed token exactly. */
  private tokenForRedaction = "";
  /** Prevent slower credential operations and checks from overwriting newer intent. */
  private credentialGeneration = 0;
  /** Matches credentialGeneration only when no token replacement is in progress. */
  private credentialReadyGeneration = 0;
  /** Close the pre-persistence race between overlapping submissions with one id. */
  private admittingUserMessageIds = new Set<string>();
  /** Monotonic guard against a slow preview replacing a newer request. */
  private migrationPreviewGeneration = 0;
  /** Per-output guards keep older same-plan work from replacing a newer request. */
  private migrationTerraformGeneration = 0;
  private migrationCsvGeneration = 0;
  private migrationCheckGeneration = 0;

  private registeredActionResultEvent(id: string): { id: string; text: string } | undefined {
    const rows = this.sql<{ text: string }>`SELECT text FROM glide_system_events WHERE id = ${id}`;
    return rows[0] ? { id, text: rows[0].text } : undefined;
  }

  private wasUserMessagePreviouslyAccepted(id: string): boolean {
    if (this.admittingUserMessageIds.has(id)) return true;
    return this.sql<{ accepted: number }>`
      SELECT 1 AS accepted FROM glide_accepted_user_message_ids WHERE message_id = ${id}
      UNION ALL
      SELECT 1 AS accepted FROM glide_chat_message_id_tombstones WHERE message_id = ${id}
      UNION ALL
      SELECT 1 AS accepted FROM glide_system_events WHERE id = ${id}
      UNION ALL
      SELECT 1 AS accepted FROM glide_legacy_chat_quarantine WHERE id = ${id}
      LIMIT 1
    `.length > 0;
  }

  private acceptedUserMessageIds(ids: readonly string[]): string[] {
    if (!ids.length) return [];
    return this.sql<{ message_id: string }>`
      SELECT message_id
      FROM glide_accepted_user_message_ids
      WHERE message_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      UNION
      SELECT message_id
      FROM glide_chat_message_id_tombstones
      WHERE message_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
    `.map((row) => row.message_id);
  }

  private registeredAssistantResponse(id: string): string | undefined {
    return this.sql<{ response_to: string }>`
      SELECT response_to FROM glide_assistant_events WHERE id = ${id}
    `[0]?.response_to;
  }

  private isRegisteredActionResultEvent(
    message: UIMessage,
    registered?: { id: string; text: string },
  ): boolean {
    const systemEvent = (message.metadata as GlideMessageMetadata | undefined)?.systemEvent;
    if (message.role !== "user" || systemEvent !== "action_result") return false;
    registered ??= this.registeredActionResultEvent(message.id);
    const metadata = message.metadata as Record<string, unknown> | undefined;
    return isTrustedActionResultEvent(
      { id: message.id, text: uiMessageText(message), systemEvent },
      registered,
    ) &&
      metadata?.name === "Glide system" &&
      Object.keys(metadata).every((key) => key === "name" || key === "systemEvent") &&
      hasCanonicalActionResultParts(message.parts, registered!.text);
  }

  private canonicalActionResultMessage(id: string, text: string): UIMessage {
    return {
      id,
      role: "user",
      metadata: {
        name: "Glide system",
        systemEvent: "action_result",
      } satisfies GlideMessageMetadata,
      parts: [{ type: "text", text }],
    };
  }

  private messageForModel(message: UIMessage): UIMessage {
    if (this.isRegisteredActionResultEvent(message)) return message;
    const originalParts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
    const rawParts: UIMessage["parts"] = originalParts.filter(
      (part): part is UIMessage["parts"][number] =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part) &&
        typeof (part as { type?: unknown }).type === "string",
    );
    const responseTo =
      message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? (message.metadata as GlideMessageMetadata).responseTo
        : undefined;
    if (
      message.role === "assistant" &&
      typeof responseTo === "string" &&
      this.registeredAssistantResponse(message.id) === responseTo &&
      this.messages.some((candidate) => candidate.id === responseTo && candidate.role === "user")
    ) {
      return rawParts === message.parts ? message : { ...message, parts: rawParts };
    }
    const untrustedSystemRole = message.role === "system";
    let changed = false;
    let sourceParts = rawParts.filter((part) => part.type === "text" && typeof part.text === "string");
    if (sourceParts.length === 0) sourceParts = [{ type: "text", text: "[unsupported user content removed]" }];
    const parts = sourceParts.map((part) => {
      if (part.type !== "text") return part;
      const text = neutralizeActionResultMarkers(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed || untrustedSystemRole || message.role !== "user" || rawParts.length !== originalParts.length
      ? { ...message, role: "user", parts, metadata: undefined }
      : message;
  }

  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    const untrustedRole = isUntrustedChatRole(message.role);
    const originalParts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
    const rawParts: UIMessage["parts"] = originalParts.filter(
      (part): part is UIMessage["parts"][number] =>
        Boolean(part) && typeof part === "object" && !Array.isArray(part) &&
        typeof (part as { type?: unknown }).type === "string",
    );
    let changed =
      message.role === "system" ||
      rawParts.length !== originalParts.length ||
      (untrustedRole && rawParts.some((part) => part.type !== "text" || typeof part.text !== "string"));
    let remainingText = MAX_CHAT_TEXT_CHARS;
    let truncated = false;
    let sourceParts = untrustedRole
      ? rawParts.filter((part) => part.type === "text" && typeof part.text === "string")
      : rawParts;
    if (untrustedRole && sourceParts.length === 0) {
      sourceParts = [{ type: "text", text: "[unsupported user content removed]" }];
      changed = true;
    }
    const parts = sourceParts.map((part) => {
      if (part.type !== "text") return part;
      const redacted = redactCloudflareApiTokens(part.text, this.tokenForRedaction);
      const available = Math.max(0, remainingText);
      const clipped = redacted.slice(0, available);
      remainingText -= clipped.length;
      const text = clipped.length < redacted.length && !truncated ? `${clipped}\n[message truncated]` : clipped;
      if (clipped.length < redacted.length) truncated = true;
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    let metadata = message.metadata;
    if (message.role === "assistant") {
      const claimedDelivery = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as GlideMessageMetadata).delivery
        : undefined;
      const registeredResponse = this.registeredAssistantResponse(message.id);
      const canonicalMetadata = registeredResponse
        ? {
            responseTo: registeredResponse,
            ...(claimedDelivery === "completed" || claimedDelivery === "interrupted"
              ? { delivery: claimedDelivery }
              : {}),
          }
        : undefined;
      if (JSON.stringify(metadata) !== JSON.stringify(canonicalMetadata)) changed = true;
      metadata = canonicalMetadata;
    }
    const candidate: UIMessage = {
      ...message,
      ...(untrustedRole ? { role: "user" as const } : {}),
      parts,
      metadata,
    };
    const registered = this.registeredActionResultEvent(message.id);
    if (registered) {
      if (this.isRegisteredActionResultEvent(candidate, registered)) return changed ? candidate : message;
      this.logChatEvent("chat.registered_event_repaired", { messageId: message.id }, "warn");
      return this.canonicalActionResultMessage(registered.id, registered.text);
    }
    const systemEvent = (metadata as GlideMessageMetadata | undefined)?.systemEvent;
    if (systemEvent === "action_result") {
      const { systemEvent: _forgedEvent, ...rest } = metadata as GlideMessageMetadata;
      metadata = rest;
      changed = true;
      this.logChatEvent("chat.forged_system_event", { messageId: message.id }, "warn");
    }
    return changed ? { ...candidate, metadata } : message;
  }

  async onStart(): Promise<void> {
    // Legacy rollback breadcrumbs were incomplete and had no safe restore consumer.
    this.sql`DROP TABLE IF EXISTS glide_snapshots`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_secrets (
      name  TEXT PRIMARY KEY,
      value TEXT,
      ts    INTEGER
    )`;
    // Raw provider config for the last preview, kept server-side so Terraform
    // export can reuse it without the user re-pasting a large export. Never synced.
    this.sql`CREATE TABLE IF NOT EXISTS glide_migration_src (
      id       TEXT PRIMARY KEY,
      provider TEXT,
      data     TEXT,
      ts       INTEGER
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_action_notifications (
      id        TEXT PRIMARY KEY,
      completed INTEGER DEFAULT 0,
      ts        INTEGER
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_system_events (
      id   TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      ts   INTEGER
    )`;
    if ((this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0) > 0) {
      this.publishInvitationAudit();
    }
    initializeAcceptedChatMessageLedger(this.storageSql);
    this.sql`CREATE TABLE IF NOT EXISTS glide_assistant_events (
      id          TEXT PRIMARY KEY,
      response_to TEXT NOT NULL,
      ts          INTEGER
    )`;
    // Cloudflare-docs reindex work queue. `products` are discovered from the
    // top-level llms.txt index; `pages` is the per-product page queue drained in
    // bounded batches. Vectors go to a GLOBAL Vectorize namespace with
    // deterministic ids (see docs-scraper.ts), so re-runs upsert in place.
    this.sql`CREATE TABLE IF NOT EXISTS glide_docs_products (
      product    TEXT PRIMARY KEY,
      label      TEXT,
      url        TEXT,
      category   TEXT,
      enumerated INTEGER DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_docs_pages (
      url     TEXT PRIMARY KEY,
      product TEXT,
      title   TEXT,
      section TEXT,
      status  INTEGER DEFAULT 0,
      chunks  INTEGER DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_docs_previous_pages (
      url    TEXT PRIMARY KEY,
      chunks INTEGER DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS glide_docs_product_attempts (
      product  TEXT PRIMARY KEY,
      attempts INTEGER DEFAULT 0
    )`;

    // A delayed schedule can disappear after a reset or exhausted callback. The
    // durable queue marker lets the coordinator safely restore exactly one tick.
    await this.reconcileDocsReindex();
    await this.getToken();

    // One-time compatibility backfill from authoritative action results. Never
    // trust mutable historical chat text when establishing a system event.
    const completedEventIds = new Set(
      this.sql<{ id: string }>`
        SELECT notifications.id
        FROM glide_action_notifications AS notifications
        LEFT JOIN glide_system_events AS events ON events.id = notifications.id
        WHERE notifications.completed = 1 AND events.id IS NULL
      `.map((row) => row.id),
    );
    for (const result of this.state.recentResults) {
      const id = actionResultEventId([result]);
      if (!completedEventIds.has(id)) continue;
      const text = redactCloudflareApiTokens(formatActionResultEvent([result]), this.tokenForRedaction);
      this.sql`INSERT OR IGNORE INTO glide_system_events (id, text, ts)
        VALUES (${id}, ${text}, ${Date.now()})`;
    }
    await this.attemptLegacyChatMigration();
    // Existing retained user turns predate the insert trigger. Backfill before
    // transcript pruning so their ids remain reserved for the room's lifetime.
    backfillAcceptedChatMessageLedger(this.storageSql);

    // Tokens pasted into old chat turns predate the persistence sanitizer.
    // Scrub them as each room wakes; this is idempotent and does not touch the
    // encrypted token stored in glide_secrets.
    if (!this.assistantProvenanceReady) {
      this.logChatEvent("chat.assistant_provenance_migration_blocked", {}, "error");
    } else {
      await this.sanitizePersistedChatHistory();
    }

    const tokenConfigured = Boolean(await this.getToken());
    const migrationToolConfigured = migrationConfigured(this.migrationTransport());
    const pendingActions = recoverStaleActionAttempts(this.state.pendingActions).map((action) => {
      if (action.zoneId) return action;
      const canonicalPath = canonicalizeApiPath(action.path);
      const zoneId = canonicalPath === action.path ? zoneIdFromApiPath(canonicalPath) : undefined;
      return zoneId ? { ...action, zoneId } : action;
    });
    const recoveredAction = pendingActions.some((action, i) => action !== this.state.pendingActions[i]);
    const legacyValidationCheck = this.state.migrationCheck?.kind === "validate";
    const defaultZoneAccountMismatch = Boolean(
      this.state.defaultZone?.accountId &&
      this.state.defaultAccountId &&
      this.state.defaultZone.accountId.toLowerCase() !== this.state.defaultAccountId.toLowerCase(),
    );
    const missingDefaultAccount = Boolean(this.state.defaultZone?.accountId && !this.state.defaultAccountId);
    if (
      this.state.tokenConfigured !== tokenConfigured ||
      this.state.migrationToolConfigured !== migrationToolConfigured ||
      recoveredAction ||
      legacyValidationCheck ||
      defaultZoneAccountMismatch ||
      missingDefaultAccount ||
      syncedStateSizeError(this.state) !== undefined
    ) {
      const { migrationCheck: _legacyValidation, ...stateWithoutValidation } = this.state;
      let nextState: GlideState = {
        ...(legacyValidationCheck ? stateWithoutValidation : this.state),
        tokenConfigured,
        migrationToolConfigured,
        pendingActions,
        ...(!tokenConfigured ? { tokenLast4: undefined, tokenValid: undefined } : {}),
      };
      if (defaultZoneAccountMismatch) {
        const { defaultZone: _inconsistentZone, ...stateWithoutZone } = nextState;
        nextState = stateWithoutZone;
      } else if (missingDefaultAccount && nextState.defaultZone?.accountId) {
        nextState = { ...nextState, defaultAccountId: nextState.defaultZone.accountId };
      }
      if (syncedStateSizeError(nextState)) {
        const { terraform: _terraform, csv: _csv, ...withoutGeneratedArtifacts } = nextState;
        nextState = withoutGeneratedArtifacts;
        if (syncedStateSizeError(nextState)) {
          const { migrationPlan: _migrationPlan, ...withoutMigrationPlan } = nextState;
          nextState = withoutMigrationPlan;
        }
      }
      if (isSafeSyncedStateTransition(this.state, nextState)) {
        this.setState(nextState);
      } else {
        this.logChatEvent("state.legacy_oversize", {}, "warn");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Migration source persistence (server-side only; never synced).
  // ---------------------------------------------------------------------------

  private saveMigrationSource(revision: string, provider: string, serializedConfig: string): void {
    this.sql`INSERT OR REPLACE INTO glide_migration_src (id, provider, data, ts)
      VALUES (${revision}, ${provider}, ${serializedConfig}, ${Date.now()})`;
  }

  private loadMigrationSource(): { provider: string; configData: unknown } | null {
    const revision = this.state.migrationPlan?.sourceRevision ?? "last";
    const rows = this.sql<{ provider: string; data: string }>`
      SELECT provider, data FROM glide_migration_src WHERE id = ${revision}`;
    const row = rows[0];
    if (!row) return null;
    try {
      const configData = JSON.parse(row.data);
      return validMigrationProviderKey(row.provider) && validateMigrationArtifact(configData).ok
        ? { provider: row.provider, configData }
        : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Onboarding state (synced to the room; driven by the model and the UI).
  // ---------------------------------------------------------------------------

  /** The live-zone snapshot, but only when it still describes the current default zone. */
  private currentLiveZone(): LiveZoneFacts | undefined {
    const live = this.state.liveZone;
    const zoneId = this.state.defaultZone?.id;
    return live && zoneId && live.zoneId === zoneId ? live : undefined;
  }

  /**
   * Merge freshly-read facts into the room's live-zone snapshot, then re-derive
   * the checklist so newly-known state ticks (or N/As) steps immediately. A
   * snapshot for a different zone id is replaced wholesale — stale SSL/WAF/status
   * must never leak across zones; a same-zone read merges field-by-field.
   * Undefined fields are dropped so a failed reader never clobbers a prior value.
   */
  private mergeLiveZone(facts: Partial<LiveZoneFacts> & { zoneId: string }): void {
    const prev = this.state.liveZone;
    const base: LiveZoneFacts = prev && prev.zoneId === facts.zoneId ? prev : { zoneId: facts.zoneId, ts: 0 };
    const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined));
    const next: LiveZoneFacts = { ...base, ...clean, zoneId: facts.zoneId, ts: Date.now() };
    this.setState({ ...this.state, liveZone: next });
    this.recomputeOnboardingChecklist();
  }

  /**
   * Read the default zone's live SSL mode and managed-WAF status (activation
   * status is already known from the zone lookup) and fold them into the
   * live-zone snapshot. Fully best-effort: reader failures/permission gaps just
   * leave those fields unset, and a superseded credential or a since-changed
   * default zone aborts the merge so we never record facts for the wrong zone.
   */
  private async captureLiveZoneFacts(
    zoneId: string,
    zoneName: string,
    status: string | undefined,
    credential: CredentialLease,
  ): Promise<void> {
    const facts: Partial<LiveZoneFacts> & { zoneId: string } = { zoneId, name: zoneName };
    if (typeof status === "string" && status) facts.status = status;
    const [ssl, waf] = await Promise.all([
      getZoneSslMode(credential.token, zoneId),
      getZoneManagedWafDeployed(credential.token, zoneId),
    ]);
    if (!this.isCredentialLeaseCurrent(credential)) return;
    if (this.state.defaultZone?.id !== zoneId) return;
    if (ssl.ok) facts.sslMode = ssl.result;
    if (waf.ok) facts.wafManaged = waf.result;
    this.mergeLiveZone(facts);
  }

  /**
   * Read a zone's live, security-relevant configuration into posture facts. Each
   * read is best-effort and independent: a read that fails (missing permission,
   * transient error) simply leaves its fact `undefined`, which the scorer treats
   * as an "unreadable" check excluded from the grade rather than a failure.
   */
  private async collectZonePostureFacts(
    zoneId: string,
    zoneName: string | undefined,
    credential: CredentialLease,
  ): Promise<ZonePostureFacts> {
    const token = credential.token;
    const [ssl, waf, alwaysHttps, minTls, tls13, hsts, dnssec] = await Promise.all([
      getZoneSslMode(token, zoneId),
      getZoneManagedWafDeployed(token, zoneId),
      getZoneSettingValue(token, zoneId, "always_use_https"),
      getZoneSettingValue(token, zoneId, "min_tls_version"),
      getZoneSettingValue(token, zoneId, "tls_1_3"),
      getZoneHstsEnabled(token, zoneId),
      getZoneDnssecStatus(token, zoneId),
    ]);
    const facts: ZonePostureFacts = { zoneId, zoneName };
    if (ssl.ok) facts.sslMode = ssl.result;
    if (waf.ok) facts.managedWaf = waf.result;
    if (alwaysHttps.ok) facts.alwaysUseHttps = alwaysHttps.result === "on";
    if (minTls.ok && minTls.result) facts.minTlsVersion = minTls.result;
    if (tls13.ok) facts.tls13 = tls13.result === "on";
    if (hsts.ok) facts.hsts = hsts.result;
    if (dnssec.ok) facts.dnssec = dnssec.result;
    // Proxy coverage is already captured by list_dns_records into the live-zone
    // facts; reuse it rather than re-listing every record here.
    const live = this.currentLiveZone();
    if (live && live.zoneId === zoneId) {
      if (typeof live.proxiedRecords === "number") facts.proxiedRecords = live.proxiedRecords;
      if (typeof live.proxiableRecords === "number") facts.proxiableRecords = live.proxiableRecords;
    }
    return facts;
  }

  /** Project a scored report onto the client-facing shape (no raw fix bodies). */
  private toClientPostureReport(report: PostureReport, by?: string): SecurityPostureReport {
    return {
      zoneId: report.zoneId,
      zoneName: report.zoneName,
      grade: report.grade,
      score: report.score,
      summary: report.summary,
      tally: report.tally,
      ts: report.ts,
      by,
      checks: report.checks.map(
        (c): SecurityPostureCheckView => ({
          id: c.id,
          area: c.area,
          title: c.title,
          status: c.status,
          detail: c.detail,
          queueable: isPostureFixQueueable(c),
          reviewRequired: c.fix?.reviewRequired,
          ask: c.ask,
          doc: c.docs[0],
        }),
      ),
    };
  }

  /**
   * Rebuild a minimal {@link PostureReport} from a stored baseline view so it can
   * be fed to the pure {@link diffPosture}. Only the fields the differ reads
   * (id/area/title/status per check, plus grade/score/ts) are meaningful; the
   * check `weight`/`docs` are placeholders and never used for diffing.
   */
  private postureReportFromView(view: SecurityPostureReport): PostureReport {
    return {
      zoneId: view.zoneId,
      zoneName: view.zoneName,
      grade: view.grade,
      score: view.score,
      summary: view.summary,
      tally: view.tally,
      ts: view.ts,
      checks: view.checks.map(
        (c): PostureCheck => ({
          id: c.id,
          area: c.area,
          title: c.title,
          status: c.status,
          detail: c.detail,
          weight: 0,
          docs: c.doc ? [c.doc] : [],
        }),
      ),
    };
  }

  /**
   * Project a computed drift onto the client-facing shape. The per-delta
   * `queueable` flag is taken from the *current* report's checks so the drift
   * banner can offer to re-queue a one-click fix for a regressed check.
   */
  private toClientDrift(drift: PostureDrift, current: PostureReport): PostureDriftView {
    const queueableById = new Map(current.checks.map((c) => [c.id, isPostureFixQueueable(c)] as const));
    const view = (d: PostureDelta): PostureDeltaView => ({
      id: d.id,
      area: d.area,
      title: d.title,
      from: d.from,
      to: d.to,
      direction: d.direction,
      queueable: queueableById.get(d.id) ?? false,
    });
    return {
      baselineTs: drift.baselineTs,
      currentTs: drift.currentTs,
      baselineGrade: drift.baselineGrade,
      currentGrade: drift.currentGrade,
      baselineScore: drift.baselineScore,
      currentScore: drift.currentScore,
      regressions: drift.regressions.map(view),
      improvements: drift.improvements.map(view),
      drifted: drift.drifted,
      summary: drift.summary,
    };
  }

  /** True when a report read enough to actually grade (>0 readable checks). */
  private isGradeableReport(report: PostureReport): boolean {
    return report.tally.pass + report.tally.warn + report.tally.fail > 0;
  }

  /**
   * Fold a freshly-scored report into synced state: store the scorecard, and
   * either auto-capture the zone's baseline (first gradeable check, or when the
   * target zone changed) or recompute drift against the existing baseline. Shared
   * by the on-demand posture check and the scheduled drift watch so both keep the
   * baseline/drift bookkeeping identical. Returns the projected drift (if any).
   */
  private recordPostureReport(report: PostureReport, by?: string): PostureDriftView | undefined {
    const next: GlideState = { ...this.state, securityPosture: this.toClientPostureReport(report, by) };
    const baseline = this.state.postureBaseline;
    const sameZoneBaseline = baseline && baseline.zoneId === report.zoneId;
    let drift: PostureDriftView | undefined;
    if (!sameZoneBaseline) {
      // No baseline for this zone yet (or the target zone changed): bless the
      // current report as the baseline once it's actually gradeable, and clear any
      // stale drift carried over from a previous zone.
      if (this.isGradeableReport(report)) {
        next.postureBaseline = this.toClientPostureReport(report, by);
      }
      next.postureDrift = undefined;
    } else {
      drift = this.toClientDrift(diffPosture(this.postureReportFromView(baseline), report), report);
      next.postureDrift = drift;
    }
    this.setState(next);
    return drift;
  }

  /**
   * Read the room's default zone's live config, grade it, store the scorecard in
   * synced state (auto-capturing/comparing the drift baseline), and return the
   * full report (for chat relay). Shared by the `security_posture` tool, the
   * "Check now" RPC, and the scheduled drift watch.
   */
  private async computeSecurityPosture(
    by: string,
    isCurrent: () => boolean,
  ): Promise<{ ok: true; report: PostureReport; drift?: PostureDriftView } | { ok: false; message: string }> {
    const zone = this.state.defaultZone;
    if (!zone) return { ok: false, message: "No target zone yet — ask Glide to find your zone first." };
    const credential = await this.getCredentialLease();
    if (!isCurrent()) return { ok: false, message: "Room access ended before the posture check completed." };
    if (!credential) return { ok: false, message: this.credentialUnavailableMessage() };
    const facts = await this.collectZonePostureFacts(zone.id, zone.name, credential);
    if (!isCurrent()) return { ok: false, message: "Room access ended before the posture check completed." };
    if (!this.isCredentialLeaseCurrent(credential)) return { ok: false, message: this.credentialSupersededMessage() };
    if (this.state.defaultZone?.id !== zone.id) {
      return { ok: false, message: "The target zone changed while the posture check ran — run it again." };
    }
    const report = scorePosture(facts);
    const drift = this.recordPostureReport(report, by);
    return { ok: true, report, drift };
  }

  /**
   * Arm the recurring drift watch: schedule the next `runDriftWatch` and cancel
   * any stale siblings. Mirrors {@link armLegacyChatMigration} — the successor is
   * created *before* cleanup so an in-flight alarm callback (whose one-shot row
   * the SDK deletes on return) isn't returned by idempotent scheduling.
   */
  private async armDriftWatch(delaySeconds: number, replace = false): Promise<void> {
    const successor = await this.schedule(delaySeconds, "runDriftWatch", {}, { idempotent: !replace });
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback !== "runDriftWatch" || schedule.id === successor.id) continue;
      try {
        await this.cancelSchedule(schedule.id);
      } catch {
        this.logChatEvent("posture.drift_watch_schedule_cleanup_failed", {}, "warn");
      }
    }
  }

  /** Cancel every scheduled drift-watch run (used when the watch is turned off). */
  private async cancelDriftWatchSchedules(): Promise<void> {
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "runDriftWatch") await this.cancelSchedule(schedule.id);
    }
  }

  /**
   * Scheduled callback (public so the DO scheduler can invoke it by name): the
   * weekly drift check. Re-scores the zone's live posture — which updates the
   * synced scorecard and drift banner via {@link recordPostureReport} — records
   * the run time, and re-arms itself for the next interval while the watch stays
   * enabled. It never posts chat messages or mutates Cloudflare; drift surfaces
   * only through synced state. Failures are swallowed so a transient outage never
   * kills the recurring schedule.
   */
  async runDriftWatch(): Promise<void> {
    const watch = this.state.driftWatch;
    if (!watch?.enabled) {
      // The watch was turned off since this run was scheduled — stop the loop.
      await this.cancelDriftWatchSchedules();
      return;
    }
    if (this.state.defaultZone) {
      try {
        const res = await this.computeSecurityPosture("the weekly drift watch", () => true);
        if (res.ok) {
          this.setState({ ...this.state, driftWatch: { ...watch, lastCheckedTs: Date.now() } });
          if (res.drift?.drifted) {
            this.logChatEvent(
              "posture.drift_detected",
              { regressions: res.drift.regressions.length },
              "warn",
            );
          }
        }
      } catch {
        this.logChatEvent("posture.drift_watch_failed", {}, "warn");
      }
    }
    // Recurring: re-arm for the next interval (replacing this executing one-shot)
    // as long as the watch is still enabled.
    if (this.state.driftWatch?.enabled) await this.armDriftWatch(DRIFT_WATCH_INTERVAL_SEC, true);
  }

  /**
   * Resolve one posture check to a concrete, queue-ready Cloudflare call by
   * re-reading the zone's live state and rebuilding the fix from the posture
   * catalog — never from client input. Returns the check's fix (or an error).
   */
  private async resolvePostureFix(
    checkId: string,
    zoneId: string,
    isCurrent: () => boolean,
  ): Promise<{ ok: true; check: PostureCheck } | { ok: false; message: string }> {
    const zone = this.state.defaultZone;
    if (!zone || zone.id !== zoneId) {
      return { ok: false, message: "That zone is no longer the room's target zone — run find_zone again." };
    }
    const credential = await this.getCredentialLease();
    if (!isCurrent()) return { ok: false, message: "Room access ended before the fix could be prepared." };
    if (!credential) return { ok: false, message: this.credentialUnavailableMessage() };
    const facts = await this.collectZonePostureFacts(zone.id, zone.name, credential);
    if (!isCurrent()) return { ok: false, message: "Room access ended before the fix could be prepared." };
    if (!this.isCredentialLeaseCurrent(credential)) return { ok: false, message: this.credentialSupersededMessage() };
    const report = scorePosture(facts);
    // Refresh the stored scorecard (and drift) while we have fresh facts.
    this.recordPostureReport(report, this.state.securityPosture?.by);
    const check = report.checks.find((c) => c.id === checkId);
    if (!check) return { ok: false, message: "That posture check no longer applies to this zone." };
    if (check.status === "pass") return { ok: false, message: `"${check.title}" already passes — nothing to queue.` };
    if (!check.fix) {
      return { ok: false, message: `"${check.title}" needs a quick chat-guided setup — ask Glide and it'll walk you through it.` };
    }
    return { ok: true, check };
  }

  /**
   * Estimate a queued change's blast radius by reading the target zone's recent
   * traffic and running the (pure) estimator. Read-only. When the zone or the
   * analytics can't be read, the estimator still returns an honest qualitative
   * assessment (level "unknown") rather than failing.
   */
  private async blastRadiusForAction(
    action: PendingAction,
    isCurrent: () => boolean,
  ): Promise<{ ok: true; estimate: BlastRadiusEstimate } | { ok: false; message: string }> {
    const input = {
      method: action.method,
      path: action.path,
      body: action.body,
      summary: action.summary,
      product: action.product,
    };
    const zoneId = action.zoneId || zoneIdFromApiPath(action.path) || this.state.defaultZone?.id;
    if (!zoneId || !/^[0-9a-f]{32}$/i.test(zoneId)) {
      return { ok: true, estimate: estimateBlastRadius(input, undefined) };
    }
    const credential = await this.getCredentialLease();
    if (!isCurrent()) return { ok: false, message: "Room access ended before the impact preview completed." };
    if (!credential) return { ok: true, estimate: estimateBlastRadius(input, undefined) };
    const traffic = await getZoneTraffic24h(credential.token, zoneId);
    if (!isCurrent()) return { ok: false, message: "Room access ended before the impact preview completed." };
    return { ok: true, estimate: estimateBlastRadius(input, traffic.ok ? traffic.result : undefined) };
  }

  /** Ensure an onboarding object exists (checklist is filled once a path is chosen). */
  private ensureOnboarding(): OnboardingState {
    return this.state.onboarding ?? { active: true, goals: [], checklist: [] };
  }

  /** Patch the onboarding state (shared by the UI wizard RPC and the model tool). */
  private applyOnboardingPatch(
    patch: {
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
    },
    by: string,
  ): OnboardingState {
    const ob = this.ensureOnboarding();
    const pathChanged = patch.path !== undefined && patch.path !== ob.path;
    const path = patch.path ?? ob.path;
    const providerChanged = patch.migratingFrom !== undefined && patch.migratingFrom !== ob.migratingFrom;
    const migrationSelectionChanged = pathChanged || providerChanged;
    const migratingFrom = patch.migratingFrom ?? (pathChanged ? undefined : ob.migratingFrom);
    const matchingPlan = Boolean(
      path === "migrate" && migratingFrom && this.state.migrationPlan?.provider === migratingFrom,
    );
    let checklist = !ob.checklist.length || pathChanged ? checklistForPath(path) : ob.checklist;
    if (providerChanged) {
      checklist = checklist.map((step) =>
        step.id === "preview" || step.id === "migrate" ? { ...step, done: false } : step
      );
    }
    if (patch.checkOff?.length) {
      const set = new Set(
        patch.checkOff.filter((id) =>
          id === "preview"
            ? matchingPlan
            : id === "migrate"
              ? Boolean(
                  matchingPlan &&
                  this.state.migrationPlan &&
                  !this.state.migrationPlan.truncated &&
                  this.state.migrationPlan.rules.some((rule) => rule.queued)
                )
              : true
        ),
      );
      checklist = checklist.map((s) => (set.has(s.id) ? { ...s, done: true } : s));
    }
    const next: OnboardingState = {
      ...ob,
      active: true,
      path,
      domain: patch.domain ?? ob.domain,
      setupType: patch.setupType ?? ob.setupType,
      migratingFrom,
      migratingFromLabel: patch.migratingFromLabel ?? (migrationSelectionChanged ? undefined : ob.migratingFromLabel),
      goals: patch.goals ?? ob.goals,
      configProvided: patch.configProvided === true
        ? matchingPlan
        : patch.configProvided ?? (migrationSelectionChanged ? false : ob.configProvided),
      dnsReviewed: patch.dnsReviewed ?? ob.dnsReviewed,
      completed: patch.completed ?? ob.completed,
      checklist,
      updatedBy: by,
      ts: Date.now(),
    };
    // Auto-complete any checklist steps whose required info is now captured.
    const auto = autoDoneSteps(next, {
      migrationQueued: Boolean(
        !migrationSelectionChanged &&
        this.state.migrationPlan &&
        !this.state.migrationPlan.truncated &&
        this.state.migrationPlan.rules.some((r) => r.queued)
      ),
      pending: this.state.pendingActions,
      results: this.state.recentResults,
      liveZone: this.currentLiveZone(),
    });
    next.checklist = next.checklist.map((s) => {
      const done = s.done || auto.done.has(s.id);
      const na = Boolean(s.na) || auto.na.has(s.id);
      return done === s.done && na === Boolean(s.na) ? s : { ...s, done, na };
    });
    const unchanged =
      next.active === ob.active &&
      next.completed === ob.completed &&
      next.path === ob.path &&
      next.domain === ob.domain &&
      next.setupType === ob.setupType &&
      next.migratingFrom === ob.migratingFrom &&
      next.migratingFromLabel === ob.migratingFromLabel &&
      next.configProvided === ob.configProvided &&
      next.dnsReviewed === ob.dnsReviewed &&
      JSON.stringify(next.goals) === JSON.stringify(ob.goals) &&
      JSON.stringify(next.checklist) === JSON.stringify(ob.checklist);
    if (unchanged) return ob;
    if (migrationSelectionChanged) {
      const {
        migrationPlan: _stalePlan,
        terraform: _staleTerraform,
        csv: _staleCsv,
        migrationCheck: _staleCheck,
        ...stateWithoutMigrationArtifacts
      } = this.state;
      this.migrationPreviewGeneration += 1;
      this.migrationTerraformGeneration += 1;
      this.migrationCsvGeneration += 1;
      this.migrationCheckGeneration += 1;
      this.sql`DELETE FROM glide_migration_src`;
      this.setState({ ...stateWithoutMigrationArtifacts, onboarding: next });
    } else {
      this.setState({ ...this.state, onboarding: next });
    }
    return next;
  }

  /**
   * Re-derive auto-completable checklist steps from current room signals and
   * flip any newly-satisfied step to done. Never unchecks. Called after the
   * action queue / results change (queueing, applying) so the checklist keeps
   * up without the model having to explicitly check things off.
   */
  private recomputeOnboardingChecklist(): void {
    const ob = this.state.onboarding;
    if (!ob?.active || !ob.checklist.length) return;
    const auto = autoDoneSteps(ob, {
      migrationQueued: Boolean(
        this.state.migrationPlan &&
        !this.state.migrationPlan.truncated &&
        this.state.migrationPlan.rules.some((r) => r.queued)
      ),
      pending: this.state.pendingActions,
      results: this.state.recentResults,
      liveZone: this.currentLiveZone(),
    });
    let changed = false;
    const checklist = ob.checklist.map((s) => {
      const done = s.done || auto.done.has(s.id);
      const na = Boolean(s.na) || auto.na.has(s.id);
      if (done !== s.done || na !== Boolean(s.na)) {
        changed = true;
        return { ...s, done, na };
      }
      return s;
    });
    if (changed) this.setState({ ...this.state, onboarding: { ...ob, checklist, ts: Date.now() } });
  }

  /** Verify reserved UI events against exact server-authored text kept in SQLite. */
  @callable()
  async verifyActionResultEvents(
    candidates: unknown,
  ): Promise<Array<{ id: string; text: string }>> {
    if (!Array.isArray(candidates)) return [];
    const verified: Array<{ id: string; text: string }> = [];
    const seen = new Set<string>();
    for (const candidate of candidates.slice(0, 100)) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const { id, text } = candidate as Record<string, unknown>;
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 300 ||
        typeof text !== "string" ||
        text.length > MAX_CHAT_TEXT_CHARS + 100
      ) {
        continue;
      }
      const key = JSON.stringify([id, text]);
      if (seen.has(key)) continue;
      seen.add(key);
      const rows = this.sql<{ text: string }>`SELECT text FROM glide_system_events WHERE id = ${id}`;
      if (rows[0]?.text === text) verified.push({ id, text });
    }
    return verified;
  }

  @callable()
  async startOnboarding(by = "someone"): Promise<{ ok: true }> {
    this.applyOnboardingPatch({}, this.verifiedActor(by));
    return { ok: true };
  }

  /** UI wizard: merge a partial answer set into the room's onboarding state. */
  @callable()
  async updateOnboarding(
    patch: {
      path?: OnboardingPath;
      domain?: string;
      setupType?: SetupType;
      migratingFrom?: string;
      migratingFromLabel?: string;
      goals?: string[];
      configProvided?: boolean;
      completed?: boolean;
      checkOff?: string[];
    },
    by = "someone",
  ): Promise<{ ok: boolean; message?: string }> {
    const parsed = validateOnboardingPatch(patch);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    this.applyOnboardingPatch(parsed.value, this.verifiedActor(by));
    return { ok: true };
  }

  @callable()
  async completeOnboarding(by = "someone"): Promise<{ ok: true }> {
    this.applyOnboardingPatch({ completed: true }, this.verifiedActor(by));
    return { ok: true };
  }

  /**
   * UI: wipe THIS room's onboarding so the guided flow starts over from scratch.
   * Clears the path, domain, DNS setup, goals, and checklist by dropping the
   * whole `onboarding` object back to the brand-new-room state (undefined). The
   * room's pending approvals, chat history, token, memory, and defaults are left
   * untouched. Migration previews/exports are cleared so a new path cannot reuse
   * stale provider input. A
   * hard refresh reconnects to the same durable room, so this is the intended
   * way to "start fresh" without opening a new room URL.
   */
  @callable()
  async resetOnboarding(_by = "someone"): Promise<{ ok: true }> {
    const {
      migrationPlan: _stalePlan,
      terraform: _staleTerraform,
      csv: _staleCsv,
      migrationCheck: _staleCheck,
      ...stateWithoutMigrationArtifacts
    } = this.state;
    this.migrationPreviewGeneration += 1;
    this.migrationTerraformGeneration += 1;
    this.migrationCsvGeneration += 1;
    this.migrationCheckGeneration += 1;
    this.sql`DELETE FROM glide_migration_src`;
    this.setState({ ...stateWithoutMigrationArtifacts, onboarding: undefined });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Business profile — the "nature of the business" discovery answers that drive
  // tailored recommendations (see recommendations.ts). Kept at the room level so
  // the advisor works during onboarding AND on-demand after go-live.
  // ---------------------------------------------------------------------------

  /** Ensure a business-profile object exists with its arrays initialised. */
  private ensureBusinessProfile(): BusinessProfile {
    return this.state.businessProfile ?? { ...EMPTY_BUSINESS_PROFILE };
  }

  /**
   * Merge a partial profile into room state (REPLACE semantics: any field present
   * in `patch` wins; omitted fields are kept; an explicit boolean `false` is
   * honoured). The industry label is auto-derived. Callers that must not lose
   * prior array answers (the model tool, the chat backfill) union the arrays
   * themselves before calling. Capturing a profile changes NOTHING on the account.
   */
  private applyBusinessProfilePatch(patch: Partial<BusinessProfile>, by: string): BusinessProfile {
    const cur = this.ensureBusinessProfile();
    const next: BusinessProfile = {
      industry: patch.industry ?? cur.industry,
      industryLabel: patch.industry ? industryLabel(patch.industry) : cur.industryLabel,
      appTypes: patch.appTypes ?? cur.appTypes,
      audience: patch.audience ?? cur.audience,
      trafficProfile: patch.trafficProfile ?? cur.trafficProfile,
      hasLogin: patch.hasLogin ?? cur.hasLogin,
      hasApi: patch.hasApi ?? cur.hasApi,
      cacheableContent: patch.cacheableContent ?? cur.cacheableContent,
      sensitiveData: patch.sensitiveData ?? cur.sensitiveData,
      compliance: patch.compliance ?? cur.compliance,
      concerns: patch.concerns ?? cur.concerns,
      notes: patch.notes ?? cur.notes,
      completed: patch.completed ?? cur.completed,
      updatedBy: by,
      ts: Date.now(),
    };
    const stable = (b: BusinessProfile) => JSON.stringify({ ...b, updatedBy: "", ts: 0 });
    if (stable(cur) === stable(next)) return cur;
    this.setState({ ...this.state, businessProfile: next });
    return next;
  }

  /**
   * UI: merge answers to the "nature of the business" questions into room state.
   * Array fields replace (the form sends the full current selection); scalars and
   * booleans overwrite when provided. Mirrors {@link updateOnboarding}.
   */
  @callable()
  async updateBusinessProfile(
    patch: Partial<BusinessProfile>,
    by = "someone",
  ): Promise<{ ok: boolean; message?: string }> {
    const parsed = validateBusinessProfilePatch(patch);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    this.applyBusinessProfilePatch(parsed.value, this.verifiedActor(by));
    return { ok: true };
  }

  /** UI: clear the captured business profile so discovery can start over. */
  @callable()
  async resetBusinessProfile(_by = "someone"): Promise<{ ok: true }> {
    this.setState({ ...this.state, businessProfile: undefined });
    return { ok: true };
  }

  /**
   * UI: set (or clear) the room's human-friendly display name — the editable
   * label in the header. Any room member may rename the room; the name is
   * normalized and length-capped and is display-only, so it never affects room
   * routing, storage identity, or membership. Passing an empty value clears it.
   */
  @callable()
  async setRoomName(name: unknown, by = "someone"): Promise<{ ok: true; roomName?: string }> {
    // Membership + role are enforced for the calling connection like the other
    // room-mutating RPCs (viewers are read-only); `by` is kept for signature
    // parity but the verified lease email is used for attribution/audit.
    const { lease } = this.requireCommitRole("rename the room");
    const actor = lease?.email ?? normalizeActor(by, "a teammate");
    const roomName = normalizeRoomName(name);
    if (roomName === this.state.roomName) return { ok: true, roomName };
    if (roomName === undefined) {
      const { roomName: _drop, ...rest } = this.state;
      this.setState(rest as GlideState);
    } else {
      this.setState({ ...this.state, roomName });
    }
    this.syncRoomToRegistry();
    this.recordAudit(
      "rename",
      actor,
      undefined,
      roomName ? `Renamed room to "${roomName}"` : "Cleared the room name",
    );
    return { ok: true, roomName };
  }

  /**
   * UI: permanently delete this room — owner only. Wipes ALL of the room's
   * Durable Object storage (chat history + ledger, pending approvals, recent
   * results, memory, business profile, onboarding/migration artifacts, members,
   * invites, and the encrypted Cloudflare token), removes it from the registry,
   * and aborts the instance so every connected client drops. Irreversible.
   *
   * Requires the exact {@link ROOM_DELETE_CONFIRMATION} phrase and a current
   * verified OWNER session (not the untrusted `by` label) so a member or a stale
   * socket can't trigger it. Mirrors the destructive-op checks used elsewhere.
   */
  @callable()
  async destroyRoom(
    confirmation: unknown,
    _by = "someone",
  ): Promise<{ ok: boolean; message: string }> {
    const { connection } = getCurrentAgent<GlideAgent>();
    const identity = this.connectionIdentity(connection);
    if (!identity || this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
      return { ok: false, message: "A current room owner session is required to delete this room." };
    }
    const actor = this.sql<{ role: RoomMember["role"] }>`SELECT role FROM glide_room_members
      WHERE email = ${identity.email} LIMIT 1`[0];
    if (actor?.role !== "owner") {
      return { ok: false, message: "Only the room owner can delete this room." };
    }
    if (confirmation !== ROOM_DELETE_CONFIRMATION) {
      return { ok: false, message: `Type ${ROOM_DELETE_CONFIRMATION} to confirm deleting this room.` };
    }
    // Audit the deletion. (The row is wiped with everything else below, but the
    // event is emitted to observability so the destruction is never silent.)
    this.recordAudit("destroy", identity.email, this.name, "Deleted the room");

    // Mark destroyed so any in-flight registry sync bails instead of resurrecting
    // this room, then deregister (awaited) so it never lingers in the list.
    this.roomDestroyed = true;
    await this.removeRoomFromRegistry();
    await this.ctx.storage.deleteAll();
    // Defer the abort so this RPC result reaches the caller before the socket drops.
    setTimeout(() => this.ctx.abort("room deleted by owner"), 0);
    return { ok: true, message: "Room deleted." };
  }

  /** UI: clear the running "Cloudflare docs from this chat" reading list. */
  @callable()
  async clearDocLinks(_by = "someone"): Promise<{ ok: true }> {
    this.setState({ ...this.state, docLinks: [] });
    return { ok: true };
  }

  /**
   * UI: queue a single tailored recommendation (from recommendations.ts) as a
   * pending action for human Apply — the "Queue" button in the sidebar
   * Recommendations panel.
   *
   * Security: the client sends only the recommendation **id** and the target zone
   * id. The server recomputes the recommendation set from the room's own trusted
   * {@link BusinessProfile} and rebuilds the exact API call from its catalog via
   * {@link recommendationToPending}, so the button can never inject an arbitrary
   * Cloudflare request. Recommendations that aren't concretely queueable (managed
   * rules, rate limits, and manual/plan-gated steps) are refused here and must be
   * set up through chat, where Glide can do the required discovery first.
   */
  @callable()
  async queueRecommendation(
    recId: string,
    zoneId: string,
    by = "someone",
  ): Promise<{ ok: boolean; message: string; id?: string }> {
    const actor = this.verifiedActor(by);
    if (typeof zoneId !== "string" || !/^[0-9a-f]{32}$/i.test(zoneId.trim())) {
      return { ok: false, message: "A valid target zone id is required first — ask Glide to find your zone." };
    }
    const parsedRecId = validateIdentifier(recId, "Recommendation id", 100);
    if (!parsedRecId.ok) return { ok: false, message: parsedRecId.message };
    const set = recommendConfigurations(this.state.businessProfile, {
      goals: this.state.onboarding?.goals,
      setupType: this.state.onboarding?.setupType,
    });
    const rec = set.recommendations.find((r) => r.id === parsedRecId.value);
    if (!rec) {
      return { ok: false, message: "That recommendation no longer applies to this room's business profile." };
    }
    const mapped = recommendationToPending(rec, zoneId.trim());
    if (!mapped) {
      return {
        ok: false,
        message: `"${rec.title}" needs a quick setup — ask Glide in chat and it'll walk you through it before queuing.`,
      };
    }
    const before = new Set(this.state.pendingActions.map((action) => action.id));
    const message = this.queuePending(mapped, actor);
    const created = this.state.pendingActions.find((action) => !before.has(action.id));
    if (!created) return { ok: false, message };
    return { ok: true, message, id: created.id };
  }

  /**
   * UI: (re)compute the security-posture scorecard for the room's default zone
   * from its LIVE Cloudflare configuration and store it in synced state — the
   * "Check now / Refresh" button in the Security posture panel. Read-only.
   */
  @callable()
  async refreshSecurityPosture(
    by = "someone",
  ): Promise<{ ok: boolean; message: string; grade?: string; score?: number; drifted?: boolean }> {
    const actor = this.verifiedActor(by);
    const res = await this.computeSecurityPosture(actor, () => true);
    if (!res.ok) return { ok: false, message: res.message };
    const drift =
      res.drift && res.drift.drifted
        ? ` ${res.drift.regressions.length} check${res.drift.regressions.length === 1 ? "" : "s"} drifted from the baseline.`
        : "";
    return {
      ok: true,
      message: `Security posture graded ${res.report.grade} (${res.report.score}/100).${drift}`,
      grade: res.report.grade,
      score: res.report.score,
      drifted: res.drift?.drifted,
    };
  }

  /**
   * UI: bless the zone's *current* live configuration as the known-good baseline
   * the drift watch compares against — the "Set baseline" button in the Security
   * posture panel. Member-or-owner only (a room-config change, not a proposal).
   * Re-reads live state so the baseline reflects reality, then clears any drift.
   */
  @callable()
  async setPostureBaseline(
    by = "someone",
  ): Promise<{ ok: boolean; message: string; grade?: string; score?: number }> {
    this.requireCommitRole("set the security-posture baseline");
    const actor = this.verifiedActor(by);
    const res = await this.computeSecurityPosture(actor, () => true);
    if (!res.ok) return { ok: false, message: res.message };
    if (!this.isGradeableReport(res.report)) {
      return {
        ok: false,
        message:
          "Couldn't read enough of the zone's configuration to set a baseline — check the API token's read permissions.",
      };
    }
    // Bless the freshly-scored live report as the new baseline and clear drift —
    // there is nothing to compare against a brand-new baseline.
    this.setState({
      ...this.state,
      postureBaseline: this.toClientPostureReport(res.report, actor),
      postureDrift: undefined,
    });
    this.recordAudit(
      "posture_baseline",
      actor,
      res.report.zoneId,
      `grade ${res.report.grade} (${res.report.score}/100)`,
    );
    return {
      ok: true,
      message: `Baseline set at grade ${res.report.grade} (${res.report.score}/100). Glide will flag any future drift from this.`,
      grade: res.report.grade,
      score: res.report.score,
    };
  }

  /**
   * UI: enable or disable the weekly configuration-drift watch — the "Watch
   * weekly" toggle in the Security posture panel. Member-or-owner only. Enabling
   * auto-captures a baseline (if none) so the first scheduled run has something to
   * compare against, then arms a recurring ~7-day posture recheck that updates the
   * synced drift banner. No chat messages are posted (that's a later phase).
   */
  @callable()
  async setDriftWatch(
    enabled: boolean,
    by = "someone",
  ): Promise<{ ok: boolean; message: string; enabled: boolean }> {
    this.requireCommitRole("change the configuration-drift watch");
    const actor = this.verifiedActor(by);
    const on = enabled === true;
    if (on && !this.state.defaultZone) {
      return { ok: false, message: "No target zone yet — ask Glide to find your zone first.", enabled: false };
    }
    if (on && (!this.state.postureBaseline || this.state.postureBaseline.zoneId !== this.state.defaultZone?.id)) {
      // Auto-capture a baseline so the watch has something to compare against.
      const res = await this.computeSecurityPosture(actor, () => true);
      if (!res.ok) return { ok: false, message: res.message, enabled: false };
    }
    this.setState({
      ...this.state,
      driftWatch: { enabled: on, by: actor, ts: Date.now(), lastCheckedTs: this.state.driftWatch?.lastCheckedTs },
    });
    if (on) await this.armDriftWatch(DRIFT_WATCH_INTERVAL_SEC, true);
    else await this.cancelDriftWatchSchedules();
    this.recordAudit("drift_watch", actor, this.state.defaultZone?.id, on ? "enabled" : "disabled");
    return {
      ok: true,
      enabled: on,
      message: on
        ? "Weekly drift watch is on — Glide will re-check this zone's posture about every 7 days and flag drift from the baseline."
        : "Drift watch is off.",
    };
  }

  /**
   * UI: queue a single security-posture fix as a pending action for human Apply
   * — the "Queue fix" button in the Security posture panel.
   *
   * Security: the client sends only the check **id** and the target zone id. The
   * server re-reads the zone's live state, rebuilds the scorecard, and rebuilds
   * the exact API call from the posture catalog via {@link postureFixToPending},
   * so the button can never inject an arbitrary Cloudflare request. Checks with
   * no one-click fix are refused here and must be set up through chat.
   */
  @callable()
  async queuePostureFix(
    checkId: string,
    zoneId: string,
    by = "someone",
  ): Promise<{ ok: boolean; message: string; id?: string }> {
    const actor = this.verifiedActor(by);
    if (typeof zoneId !== "string" || !/^[0-9a-f]{32}$/i.test(zoneId.trim())) {
      return { ok: false, message: "A valid target zone id is required — ask Glide to find your zone." };
    }
    const parsedCheckId = validateIdentifier(checkId, "Posture check id", 100);
    if (!parsedCheckId.ok) return { ok: false, message: parsedCheckId.message };
    const resolved = await this.resolvePostureFix(parsedCheckId.value, zoneId.trim(), () => true);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    const mapped = postureFixToPending(resolved.check, zoneId.trim());
    if (!mapped) {
      return { ok: false, message: `"${resolved.check.title}" can't be one-click queued — ask Glide in chat.` };
    }
    const before = new Set(this.state.pendingActions.map((action) => action.id));
    const message = this.queuePending(mapped, actor);
    const created = this.state.pendingActions.find((action) => !before.has(action.id));
    if (!created) return { ok: false, message };
    return { ok: true, message, id: created.id };
  }

  /**
   * UI: preview the blast radius of a single queued action — how much of the
   * zone's real last-24h traffic it would touch — before anyone Applies it. The
   * "Preview impact" button on a pending-action card. Read-only.
   */
  @callable()
  async estimateActionImpact(
    actionId: string,
    by = "someone",
  ): Promise<{ ok: boolean; message: string; estimate?: BlastRadiusEstimate }> {
    this.verifiedActor(by);
    const parsed = validateIdentifier(actionId, "Action id", 100);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const action = this.state.pendingActions.find((a) => a.id === parsed.value);
    if (!action) return { ok: false, message: "That pending action no longer exists." };
    const res = await this.blastRadiusForAction(action, () => true);
    if (!res.ok) return { ok: false, message: res.message };
    return { ok: true, message: formatBlastRadius(res.estimate), estimate: res.estimate };
  }

  /** UI wizard: run a read-only provider-config preview (parses + stores the plan). */
  @callable()
  async previewMigration(
    args: {
      provider: string;
      config?: string;
      configFiles?: Array<{ filename: string; content: string }>;
      format?: MigrationConfigFormat;
    },
    by = "someone",
  ): Promise<{ ok: boolean; message: string; totalRules?: number; phases?: Array<{ key: string; label: string; count: number }> }> {
    const accessLease = this.currentRoomAccessLease();
    const actor = accessLease?.email ?? normalizeActor(by, "a teammate");
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, message: "Migration preview input must be an object." };
    }
    const provider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
    if (!validMigrationProviderKey(provider)) return { ok: false, message: "Provide a valid migration provider key." };
    if (!migrationConfigured(this.migrationTransport())) {
      return { ok: false, message: this.notConfigured() };
    }
    const resolved = await this.resolveConfigData(args);
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, message: "Room access ended before the migration preview completed." };
    }
    if (!resolved.ok) return { ok: false, message: resolved.message };
    const res = await this.runPreview(
      provider,
      resolved.data,
      actor,
      () => this.isRoomAccessLeaseCurrent(accessLease),
    );
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, message: "Room access ended before the migration preview completed." };
    }
    if (!res.ok) return { ok: false, message: res.message };
    this.applyOnboardingPatch({ configProvided: true, migratingFrom: provider, checkOff: ["preview"] }, actor);
    const retained = res.plan.truncated
      ? ` Retained ${res.plan.rules.length} of ${res.plan.totalRules} items for review and queueing; export Terraform for the complete config.`
      : "";
    return {
      ok: true,
      message: `${res.phaseSummary || "Parsed (no rules detected)."}${retained}`,
      totalRules: res.plan.totalRules,
      phases: res.plan.phases,
    };
  }

  @callable()
  async toggleOnboardingStep(id: string, done: boolean, by = "someone"): Promise<{ ok: boolean }> {
    const ob = this.state.onboarding;
    if (!ob) return { ok: false };
    if (typeof id !== "string" || typeof done !== "boolean" || !ob.checklist.some((step) => step.id === id)) {
      return { ok: false };
    }
    const checklist = ob.checklist.map((s) => (s.id === id ? { ...s, done } : s));
    this.setState({
      ...this.state,
      onboarding: { ...ob, checklist, updatedBy: this.verifiedActor(by), ts: Date.now() },
    });
    return { ok: true };
  }

  /** UI: pre-flight permission check for the room's migration plan. */
  @callable()
  async runPreflight(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; summary: string }> {
    const accessLease = this.currentRoomAccessLease();
    if (zoneId !== undefined && (typeof zoneId !== "string" || !/^[a-f0-9]{32}$/i.test(zoneId))) {
      return { ok: false, summary: "The zone id is invalid." };
    }
    return this.doPreflight(
      zoneId,
      accessLease?.email ?? normalizeActor(by, "a teammate"),
      () => this.isRoomAccessLeaseCurrent(accessLease),
    );
  }

  /** UI: pre-migration diff (what already exists in the target zone). */
  @callable()
  async runDiffReport(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; summary: string }> {
    const accessLease = this.currentRoomAccessLease();
    if (zoneId !== undefined && (typeof zoneId !== "string" || !/^[a-f0-9]{32}$/i.test(zoneId))) {
      return { ok: false, summary: "The zone id is invalid." };
    }
    return this.doDiff(
      zoneId,
      accessLease?.email ?? normalizeActor(by, "a teammate"),
      () => this.isRoomAccessLeaseCurrent(accessLease),
    );
  }

  /** Disabled compatibility RPC retained for older clients. */
  @callable()
  async runValidate(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; summary: string }> {
    void zoneId;
    void by;
    return { ok: false, summary: MIGRATION_VALIDATION_DISABLED };
  }

  /** UI: export the migration plan's config as CSV. */
  @callable()
  async exportMigrationCsv(by = "someone"): Promise<{ ok: boolean; message: string }> {
    const accessLease = this.currentRoomAccessLease();
    return this.doExportCsv(
      {},
      accessLease?.email ?? normalizeActor(by, "a teammate"),
      () => this.isRoomAccessLeaseCurrent(accessLease),
    );
  }

  /** Disabled compatibility RPC retained for older clients. */
  @callable()
  async snapshotZone(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; message: string }> {
    void zoneId;
    void by;
    return { ok: false, message: MIGRATION_SNAPSHOT_DISABLED };
  }

  /** Disabled compatibility RPC retained for older clients. */
  @callable()
  async refreshSnapshots(zoneId?: string): Promise<{ ok: boolean; message?: string }> {
    void zoneId;
    return { ok: false, message: MIGRATION_SNAPSHOT_DISABLED };
  }

  /** Disabled compatibility RPC retained for older clients. */
  @callable()
  async restoreSnapshot(
    snapshotId: string,
    by = "someone",
  ): Promise<{ ok: boolean; message: string; id?: string }> {
    void snapshotId;
    void by;
    return { ok: false, message: MIGRATION_SNAPSHOT_DISABLED };
  }

  // ---------------------------------------------------------------------------
  // Token storage (encrypted at rest) — never synced or returned in plaintext.
  // ---------------------------------------------------------------------------

  /** Resolve this room's encrypted token. Decryption failures fail closed. */
  private async getToken(): Promise<string> {
    const key = this.env.GLIDE_TOKEN_KEY;
    if (!key) {
      this.tokenForRedaction = "";
      return "";
    }
    const rows = this.sql<{ value: string }>`
      SELECT value FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`;
    const packed = rows[0]?.value;
    if (!packed) {
      this.tokenForRedaction = "";
      return "";
    }
    try {
      const token = await decryptSecret(key, packed);
      const latest = this.sql<{ value: string }>`
        SELECT value FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`;
      if (latest[0]?.value !== packed) return "";
      this.tokenForRedaction = token;
      return token;
    } catch (err) {
      this.tokenForRedaction = "";
      this.logChatEvent(
        "token.decrypt_failed",
        { reason: err instanceof Error ? err.name : "unknown" },
        "error",
      );
      return "";
    }
  }

  private credentialChangeInProgress(): boolean {
    return this.credentialGeneration !== this.credentialReadyGeneration;
  }

  private isCredentialLeaseCurrent(credential: CredentialLease): boolean {
    return credential.generation === this.credentialGeneration &&
      credential.generation === this.credentialReadyGeneration;
  }

  /** null means stably absent; undefined means acquisition was superseded. */
  private async getCredentialLease(): Promise<CredentialLease | null | undefined> {
    const generation = this.credentialGeneration;
    if (generation !== this.credentialReadyGeneration) return undefined;
    const token = await this.getToken();
    const credential = { token, generation };
    if (!this.isCredentialLeaseCurrent(credential)) return undefined;
    return token ? credential : null;
  }

  private credentialUnavailableMessage(): string {
    return this.credentialChangeInProgress()
      ? "A Cloudflare token change is still being verified. Wait for it to finish, then retry."
      : "No Cloudflare API token is configured. Add one in Connection > Set token.";
  }

  private credentialSupersededMessage(): string {
    return "A newer Cloudflare token change replaced this request. Retry it with the current token.";
  }

  @callable()
  async setCloudflareToken(rawToken: string): Promise<{ ok: boolean; message: string }> {
    const { lease } = this.requireCommitRole("manage the Cloudflare token");
    const result = await this.setCloudflareTokenInternal(rawToken, lease);
    if (result.ok) {
      const last4 = typeof rawToken === "string" ? rawToken.trim().slice(-4) : "";
      this.recordAudit(
        "token_set",
        lease?.email ?? "system",
        undefined,
        last4 ? `Saved the Cloudflare API token (…${last4})` : "Saved the Cloudflare API token",
      );
    }
    return result;
  }

  private async setCloudflareTokenInternal(
    rawToken: string,
    accessLease?: RoomAccessLease,
  ): Promise<{ ok: boolean; message: string }> {
    if (typeof rawToken !== "string" || rawToken.length > 512) {
      return { ok: false, message: "Token must be text no longer than 512 characters." };
    }
    const token = rawToken.trim();
    if (!token) return { ok: false, message: "Token was empty." };
    if (!this.env.GLIDE_TOKEN_KEY) {
      return {
        ok: false,
        message:
          "Server can't store a token securely yet — GLIDE_TOKEN_KEY is not set. Ask an operator to run `wrangler secret put GLIDE_TOKEN_KEY`.",
      };
    }
    if (!this.assistantProvenanceReady) {
      await this.attemptLegacyChatMigration(true);
      if (!this.assistantProvenanceReady) {
        return {
          ok: false,
          message: "Chat history is still being migrated. Wait for it to finish before replacing the room token.",
        };
      }
    }
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, message: "Room access ended before the token could be saved." };
    }

    const previousSecret = this.sql<{ value: string; ts: number }>`
      SELECT value, ts FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`[0];
    const previousTokenForRedaction = this.tokenForRedaction;
    const generation = ++this.credentialGeneration;
    let stored = false;
    try {
      // Check authentication before trusting, but store regardless so the user can
      // retry if all verification reads fail transiently for an otherwise-valid token.
      const verify = await verifyToken(token);
      const packed = await encryptSecret(this.env.GLIDE_TOKEN_KEY, token);
      if (!this.isRoomAccessLeaseCurrent(accessLease)) {
        if (generation === this.credentialGeneration) {
          const readyGeneration = ++this.credentialGeneration;
          this.credentialReadyGeneration = readyGeneration;
        }
        return { ok: false, message: "Room access ended before the token could be saved." };
      }
      if (generation !== this.credentialGeneration) {
        return { ok: false, message: "A newer token change replaced this request; the older token was not saved." };
      }
      this.sql`INSERT OR REPLACE INTO glide_secrets (name, value, ts)
        VALUES (${TOKEN_SECRET_NAME}, ${packed}, ${Date.now()})`;
      stored = true;
      this.tokenForRedaction = token;

      const { migrationCheck: _staleCheck, ...stateWithoutCheck } = this.state;
      this.setState({
        ...stateWithoutCheck,
        tokenConfigured: true,
        tokenLast4: token.slice(-4),
        tokenValid: verify.valid,
      });
      const readyGeneration = ++this.credentialGeneration;
      this.credentialReadyGeneration = readyGeneration;
      this.migrationCheckGeneration += 1;

      return {
        ok: true,
        message: verify.valid
          ? "Token saved (encrypted at rest) and verified ✓"
          : `Token saved (encrypted), but verification said: ${verify.message}. You can still try applying changes.`,
      };
    } catch (error) {
      if (generation === this.credentialGeneration) {
        try {
          if (stored) {
            if (previousSecret) {
              this.sql`INSERT OR REPLACE INTO glide_secrets (name, value, ts)
                VALUES (${TOKEN_SECRET_NAME}, ${previousSecret.value}, ${previousSecret.ts})`;
            } else {
              this.sql`DELETE FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`;
            }
          }
        } finally {
          this.tokenForRedaction = previousTokenForRedaction;
          const readyGeneration = ++this.credentialGeneration;
          this.credentialReadyGeneration = readyGeneration;
        }
      }
      throw error;
    }
  }

  @callable()
  async clearCloudflareToken(): Promise<{ ok: boolean; message?: string }> {
    const { lease: accessLease } = this.requireCommitRole("manage the Cloudflare token");
    if (!this.assistantProvenanceReady) {
      await this.attemptLegacyChatMigration(true);
      if (!this.assistantProvenanceReady) {
        return {
          ok: false,
          message: "Chat history is still being migrated. Wait for it to finish before clearing the room token.",
        };
      }
    }
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, message: "Room access ended before the token could be cleared." };
    }
    const previousSecret = this.sql<{ value: string; ts: number }>`
      SELECT value, ts FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`[0];
    const previousTokenForRedaction = this.tokenForRedaction;
    const generation = ++this.credentialGeneration;
    try {
      this.sql`DELETE FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`;
      this.tokenForRedaction = "";
      const { migrationCheck: _staleCheck, ...stateWithoutCheck } = this.state;
      this.setState({
        ...stateWithoutCheck,
        tokenConfigured: false,
        tokenLast4: undefined,
        tokenValid: undefined,
      });
      this.credentialReadyGeneration = generation;
      this.migrationCheckGeneration += 1;
      this.recordAudit("token_clear", accessLease?.email ?? "system", undefined, "Cleared the Cloudflare API token");
      return { ok: true };
    } catch (error) {
      try {
        if (previousSecret) {
          this.sql`INSERT OR REPLACE INTO glide_secrets (name, value, ts)
            VALUES (${TOKEN_SECRET_NAME}, ${previousSecret.value}, ${previousSecret.ts})`;
        }
      } finally {
        this.tokenForRedaction = previousTokenForRedaction;
        this.credentialReadyGeneration = generation;
      }
      throw error;
    }
  }

  /**
   * Re-check the ALREADY-stored token and refresh the synced `tokenValid` flag.
   * The client calls this on connect when the badge is stuck "unverified", so a
   * token saved by an older build (or one that tripped the `/user/tokens/verify`
   * false-negative) self-corrects without the user re-entering it. No-ops the
   * flag when no token is configured.
   */
  @callable()
  async reverifyToken(): Promise<{ ok: boolean; valid: boolean; message: string }> {
    const accessLease = this.currentRoomAccessLease();
    const credential = await this.getCredentialLease();
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, valid: false, message: "Room access ended before token verification completed." };
    }
    if (credential === undefined) {
      return { ok: false, valid: false, message: "A newer token change replaced this verification request." };
    }
    if (credential === null) {
      if (this.state.tokenValid !== undefined) {
        this.setState({
          ...this.state,
          tokenConfigured: false,
          tokenLast4: undefined,
          tokenValid: undefined,
        });
      }
      return { ok: false, valid: false, message: "No Cloudflare API token is configured." };
    }
    const verify = await verifyToken(credential.token);
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, valid: false, message: "Room access ended before token verification completed." };
    }
    if (!this.isCredentialLeaseCurrent(credential)) {
      return { ok: false, valid: false, message: "A newer token change replaced this verification request." };
    }
    this.setState({ ...this.state, tokenConfigured: true, tokenValid: verify.valid });
    return { ok: true, valid: verify.valid, message: verify.message };
  }

  /** Record client-detected delivery failures without logging message content. */
  @callable()
  async reportClientChatIssue(raw: {
    kind?: unknown;
    messageId?: unknown;
    connectionEpoch?: unknown;
  }): Promise<{ ok: true }> {
    const kind =
      raw?.kind === "not_delivered" || raw?.kind === "response_interrupted" || raw?.kind === "accepted_pruned"
        ? raw.kind
        : "unknown";
    const messageId = typeof raw?.messageId === "string" ? raw.messageId.slice(0, 128) : "unknown";
    const connectionEpoch =
      typeof raw?.connectionEpoch === "number" && Number.isFinite(raw.connectionEpoch)
        ? raw.connectionEpoch
        : -1;
    this.logChatEvent(
      "chat.client_issue",
      { kind, messageId, connectionEpoch },
      "warn",
    );
    return { ok: true };
  }

  /** Resolve absent transcript ids against the permanent accepted-message ledger. */
  @callable()
  async acceptedChatMessageIds(rawIds: unknown): Promise<{ ok: boolean; accepted: string[] }> {
    if (
      !Array.isArray(rawIds) ||
      rawIds.length > MAX_CHAT_DELIVERY_STATUS_IDS ||
      rawIds.some((id) => !isValidChatProtocolId(id))
    ) {
      return { ok: false, accepted: [] };
    }
    const ids = Array.from(new Set(rawIds as string[]));
    return { ok: true, accepted: this.acceptedUserMessageIds(ids) };
  }

  /** Retry only the exact unanswered user turn in the authoritative transcript. */
  @callable()
  async retryInterruptedResponse(
    messageId: string,
    interruptedAssistantId?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const accessLease = this.currentRoomAccessLease();
    const rateLimitMessage = await this.expensiveOperationRateLimit();
    if (rateLimitMessage) return { ok: false, message: rateLimitMessage };
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return { ok: false, message: "Room access ended before the retry started." };
    }
    return this.retryInterruptedResponseInternal(messageId, interruptedAssistantId, accessLease);
  }

  private async retryInterruptedResponseInternal(
    messageId: string,
    interruptedAssistantId: string | undefined,
    accessLease?: RoomAccessLease,
  ): Promise<{ ok: boolean; message: string }> {
    const parsedId = validateIdentifier(messageId, "Message id", 200);
    if (!parsedId.ok) return { ok: false, message: parsedId.message };
    const parsedAssistantId = interruptedAssistantId === undefined
      ? undefined
      : validateIdentifier(interruptedAssistantId, "Assistant message id", 200);
    if (parsedAssistantId && !parsedAssistantId.ok) return { ok: false, message: parsedAssistantId.message };
    if (
      parsedAssistantId?.ok &&
      this.registeredAssistantResponse(parsedAssistantId.value) !== parsedId.value
    ) {
      return { ok: false, message: "That interrupted response is not registered to the requested user turn." };
    }
    const conversationChanged = new Error("conversation changed before retry");
    const accessEnded = new Error("room access ended before retry");
    const controller = new AbortController();
    const releaseAccessAborter = accessLease
      ? this.registerRoomAccessAborter(accessLease, (reason) => controller.abort(reason))
      : () => {};
    try {
      const save = () => this.saveMessages(
        (messages) => {
          if (!this.isRoomAccessLeaseCurrent(accessLease) || controller.signal.aborted) {
            throw accessEnded;
          }
          const assistantId = parsedAssistantId?.ok ? parsedAssistantId.value : undefined;
          if (!isAuthoritativeRetryTarget(messages, parsedId.value, assistantId)) {
            throw conversationChanged;
          }
          return assistantId ? messages.slice(0, -1) : [...messages];
        },
        { signal: controller.signal },
      );
      const result = accessLease
        ? await roomAccessProgrammaticTurn.run(accessLease, save)
        : await save();
      if (!this.isRoomAccessLeaseCurrent(accessLease) || controller.signal.aborted) {
        return { ok: false, message: "Room access ended before the retry completed." };
      }
      if (result.status !== "completed") {
        const target = interruptedRetryTarget(this.messages);
        return {
          ok: false,
          message:
            result.status === "skipped"
              ? "The conversation changed before the retry started. Reload the latest history."
              : target
                ? "Glide could not complete the retried response. The turn is still retryable after the room is stable."
                : "Glide could not complete the retried response. Reload the latest history.",
        };
      }
      return { ok: true, message: "Glide retried the unanswered turn from server history." };
    } catch (error) {
      if (error === accessEnded || controller.signal.aborted || !this.isRoomAccessLeaseCurrent(accessLease)) {
        return { ok: false, message: "Room access ended before the retry completed." };
      }
      if (error === conversationChanged) {
        return { ok: false, message: "That message is no longer the latest unanswered turn. Reload the latest history." };
      }
      return { ok: false, message: "Glide could not start the retried response. Try again after the room is stable." };
    } finally {
      releaseAccessAborter();
    }
  }

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------

  @callable()
  async inviteTeammate(
    email: string,
    _by = "someone",
    link?: string,
    role?: unknown,
  ): Promise<{ ok: boolean; message: string; members?: RoomMember[] }> {
    const e = canonicalizeEmail(email);
    if (!e) {
      return { ok: false, message: `"${email}" doesn't look like a valid email address.` };
    }
    // Invites grant "member" by default; only an owner may grant read-only "viewer".
    const desiredRole: RoomRole = role === "viewer" ? "viewer" : "member";
    let safeLink: string | undefined;
    if (link !== undefined && link !== null) {
      if (typeof link !== "string" || link.length > 2_048) return { ok: false, message: "Invite link is invalid." };
      try {
        const parsed = new URL(link);
        if (!(["https:", "http:"] as string[]).includes(parsed.protocol) || parsed.username || parsed.password) {
          return { ok: false, message: "Invite link is invalid." };
        }
        safeLink = parsed.toString();
      } catch {
        return { ok: false, message: "Invite link is invalid." };
      }
    }
    const { connection } = getCurrentAgent<GlideAgent>();
    const identity = this.connectionIdentity(connection);
    if (!identity || this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
      return { ok: false, message: "Only current room members can invite someone." };
    }
    const inviterRole = this.roomRole(identity.email);
    if (inviterRole === "viewer") {
      return { ok: false, message: "Viewers have read-only access and cannot invite teammates." };
    }
    if (desiredRole === "viewer" && inviterRole !== "owner") {
      return { ok: false, message: "Only the room owner can invite a read-only viewer." };
    }
    const actor = identity.email;
    const memberCount = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM glide_room_members`[0]?.count ?? 0;
    const existingMember = this.isRoomMember(e);
    if (!existingMember && memberCount >= MAX_ROOM_MEMBERS) {
      return { ok: false, message: `This room already has the maximum of ${MAX_ROOM_MEMBERS} members.` };
    }
    if (existingMember) {
      return { ok: true, message: `${e} is already a room member.`, members: this.roomMembers() };
    }

    const now = Date.now();
    const invite: Invite = { email: e, invitedBy: actor, link: safeLink, ts: now };
    const nextInvites = [
      invite,
      ...this.roomInvitationAudit().filter((candidate) => canonicalizeEmail(candidate.email) !== e),
    ].slice(0, MAX_ROOM_MEMBERS);
    const nextState = {
      ...this.state,
      invites: nextInvites,
    };
    const stateError = syncedStateSizeError(nextState);
    if (stateError && !isSafeSyncedStateTransition(this.state, nextState)) {
      return { ok: false, message: stateError };
    }
    try {
      this.durableStorage.transactionSync(() => {
        this.sql`INSERT INTO glide_room_members (email, role, invited_by, joined_at)
          VALUES (${e}, ${desiredRole}, ${actor}, ${now})`;
        this.sql`INSERT OR REPLACE INTO glide_room_invites (email, invited_by, link, invited_at)
          VALUES (${e}, ${actor}, ${safeLink ?? null}, ${now})`;
      });
    } catch {
      this.logChatEvent("room.invite_failed", {}, "error");
      return { ok: false, message: "Glide could not grant that room membership. Try again." };
    }
    this.publishInvitationAudit(nextInvites);
    this.recordAudit("invite", actor, e, `Invited ${e} as ${desiredRole}`);
    this.syncRoomToRegistry();
    return {
      ok: true,
      message: desiredRole === "viewer" ? `Invited ${e} as a read-only viewer.` : `Invited ${e}.`,
      members: this.roomMembers(),
    };
  }

  @callable()
  async removeRoomMember(
    email: string,
  ): Promise<{ ok: boolean; message: string; members?: RoomMember[] }> {
    const targetEmail = canonicalizeEmail(email);
    if (!targetEmail) return { ok: false, message: "Provide a valid member email address." };

    const { connection } = getCurrentAgent<GlideAgent>();
    const identity = this.connectionIdentity(connection);
    if (!identity || this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
      return { ok: false, message: "A current room owner session is required to remove a member." };
    }
    const actor = this.sql<{ role: RoomMember["role"] }>`SELECT role FROM glide_room_members
      WHERE email = ${identity.email} LIMIT 1`[0];
    if (actor?.role !== "owner") {
      return { ok: false, message: "Only the room owner can remove a member." };
    }
    const target = this.sql<{ role: RoomMember["role"] }>`SELECT role FROM glide_room_members
      WHERE email = ${targetEmail} LIMIT 1`[0];
    if (!target) return { ok: false, message: `${targetEmail} is not a room member.` };
    if (target.role === "owner") {
      return { ok: false, message: "The room owner cannot be removed." };
    }

    const nextInvites = this.roomInvitationAudit().filter(
      (candidate) => canonicalizeEmail(candidate.email) !== targetEmail,
    );
    try {
      this.durableStorage.transactionSync(() => {
        this.sql`DELETE FROM glide_room_members WHERE email = ${targetEmail}`;
        this.sql`DELETE FROM glide_room_invites WHERE email = ${targetEmail}`;
      });
    } catch {
      this.logChatEvent("room.member_removal_failed", {}, "error");
      return { ok: false, message: "Glide could not remove that room member. Try again." };
    }
    this.publishInvitationAudit(nextInvites);
    this.recordAudit("remove", identity.email, targetEmail, `Removed ${targetEmail} (${target.role})`);

    for (const activeConnection of this.getConnections()) {
      if (this.connectionIdentity(activeConnection)?.email !== targetEmail) continue;
      const accessLease = this.roomAccessLeaseForConnection(activeConnection);
      if (accessLease) {
        this.abortRoomAccessOperations(
          accessLease,
          new Error("Room membership was revoked."),
        );
      }
      try {
        activeConnection.close(1008, "Room membership revoked");
      } catch {
        /* The removed member's connection already closed. */
      }
    }
    this.syncRoomToRegistry();
    return {
      ok: true,
      message: `Removed ${targetEmail} from this room.`,
      members: this.roomMembers(),
    };
  }

  /**
   * UI: change a member's role between `member` and `viewer` — owner only. The
   * owner's own role is immutable here, and this never creates a second owner
   * (ownership transfer is out of scope). Downgrading to `viewer` takes effect on
   * the target's next write attempt; their read/chat sessions stay connected.
   */
  @callable()
  async setMemberRole(
    email: string,
    role: unknown,
  ): Promise<{ ok: boolean; message: string; members?: RoomMember[] }> {
    const targetEmail = canonicalizeEmail(email);
    if (!targetEmail) return { ok: false, message: "Provide a valid member email address." };
    const nextRole: RoomRole | undefined =
      role === "member" ? "member" : role === "viewer" ? "viewer" : undefined;
    if (!nextRole) return { ok: false, message: 'Role must be "member" or "viewer".' };

    const { connection } = getCurrentAgent<GlideAgent>();
    const identity = this.connectionIdentity(connection);
    if (!identity || this.isAccessIdentityExpired(identity) || !this.isRoomMember(identity.email)) {
      return { ok: false, message: "A current room owner session is required to change roles." };
    }
    if (this.roomRole(identity.email) !== "owner") {
      return { ok: false, message: "Only the room owner can change member roles." };
    }
    const target = this.roomRole(targetEmail);
    if (!target) return { ok: false, message: `${targetEmail} is not a room member.` };
    if (target === "owner") return { ok: false, message: "The room owner's role cannot be changed." };
    if (target === nextRole) {
      return { ok: true, message: `${targetEmail} is already a ${nextRole}.`, members: this.roomMembers() };
    }
    try {
      this.sql`UPDATE glide_room_members SET role = ${nextRole}
        WHERE email = ${targetEmail} AND role != ${"owner"}`;
    } catch {
      this.logChatEvent("room.role_change_failed", {}, "error");
      return { ok: false, message: "Glide could not change that member's role. Try again." };
    }
    this.recordAudit(
      "role_change",
      identity.email,
      targetEmail,
      `Changed ${targetEmail} from ${target} to ${nextRole}`,
    );
    return {
      ok: true,
      message: `${targetEmail} is now a ${nextRole}.`,
      members: this.roomMembers(),
    };
  }

  // ---------------------------------------------------------------------------
  // Guidance docs (admin-authored; steer Glide's questions via the prompt).
  // Edited live from /admin; enabled docs are folded into buildSystemPrompt().
  // ---------------------------------------------------------------------------

  /**
   * Create or update an admin guidance doc. Omit `id` to create; pass an existing
   * `id` to edit in place. Enabled docs are injected into the system prompt so
   * Glide asks relevant, team-specific onboarding questions.
   */
  @callable()
  async upsertGuidanceDoc(
    input: { id?: string; title?: string; body?: string; enabled?: boolean },
    by = "an admin",
  ): Promise<{ ok: boolean; message: string; id?: string }> {
    const rateLimitMessage = await this.expensiveOperationRateLimit();
    if (rateLimitMessage) return { ok: false, message: rateLimitMessage };
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, message: "Guidance input must be an object." };
    }
    if (input.title !== undefined && typeof input.title !== "string") {
      return { ok: false, message: "Guidance title must be text." };
    }
    if (input.body !== undefined && typeof input.body !== "string") {
      return { ok: false, message: "Guidance body must be text." };
    }
    if ((input.title?.length ?? 0) > 120 || (input.body?.length ?? 0) > MAX_GUIDANCE_BODY) {
      return { ok: false, message: `Guidance is too long (title max 120; body max ${MAX_GUIDANCE_BODY} characters).` };
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      return { ok: false, message: "Guidance enabled must be true or false." };
    }
    if (
      input.id !== undefined &&
      (typeof input.id !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(input.id))
    ) {
      return { ok: false, message: "Guidance id is invalid." };
    }
    const title = (input.title ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
    const body = (input.body ?? "").replace(/\u0000/g, "").trim().slice(0, MAX_GUIDANCE_BODY);
    if (!title && !body) {
      return { ok: false, message: "Give the guidance a title or some text before saving." };
    }
    const list = this.state.guidance ?? [];
    const id = input?.id || `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const exists = list.some((d) => d.id === id);
    if (!exists && list.length >= MAX_GUIDANCE_DOCS) {
      return { ok: false, message: `You can keep at most ${MAX_GUIDANCE_DOCS} guidance docs — edit or delete one first.` };
    }
    const doc: GuidanceDoc = {
      id,
      title: title || "(untitled)",
      body,
      enabled: input?.enabled ?? true,
      updatedBy: this.verifiedActor(by, "an admin"),
      ts: Date.now(),
    };
    const guidance = exists ? list.map((d) => (d.id === id ? doc : d)) : [...list, doc];
    this.setState({ ...this.state, guidance });
    // Keep the RAG index in sync: (re)embed if enabled+non-empty, else drop its
    // vector so a disabled doc can't be retrieved. Best-effort — never fails the save.
    await syncGuidanceVectors(this.env, this.roomKey(), [doc]);
    return { ok: true, message: exists ? "Guidance updated." : "Guidance added.", id };
  }

  /** Delete an admin guidance doc by id. */
  @callable()
  async deleteGuidanceDoc(id: string): Promise<{ ok: boolean; message?: string }> {
    const rateLimitMessage = await this.expensiveOperationRateLimit();
    if (rateLimitMessage) return { ok: false, message: rateLimitMessage };
    if (typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,200}$/.test(id)) {
      return { ok: false, message: "Guidance id is invalid." };
    }
    const list = this.state.guidance ?? [];
    this.setState({ ...this.state, guidance: list.filter((d) => d.id !== id) });
    await deleteGuidanceVector(this.env, this.roomKey(), id);
    return { ok: true };
  }

  /**
   * Re-embed every guidance doc into the RAG index (upsert enabled, drop the
   * rest). Use to backfill docs created before RAG existed, or to repair the
   * index. Best-effort and idempotent.
   */
  @callable()
  async reindexGuidance(): Promise<{ ok: boolean; indexed: number; message: string }> {
    const rateLimitMessage = await this.expensiveOperationRateLimit();
    if (rateLimitMessage) return { ok: false, indexed: 0, message: rateLimitMessage };
    const docs = this.state.guidance ?? [];
    if (!hasVectorize(this.env)) {
      return { ok: false, indexed: 0, message: "Semantic search isn't configured for this deployment." };
    }
    const { upserted } = await syncGuidanceVectors(this.env, this.roomKey(), docs);
    return {
      ok: true,
      indexed: upserted,
      message: `Reindexed ${upserted} guidance doc${upserted === 1 ? "" : "s"} for semantic search.`,
    };
  }

  /** Stable, namespace-safe key for THIS room's vectors in the shared index. */
  private _roomKey?: string;
  private roomKey(): string {
    return (this._roomKey ??= roomKeyFor(this.name));
  }

  /**
   * Choose which guidance docs to inject into the prompt for this turn. Small
   * rooms (or when semantic search is unavailable) inject all enabled docs, as
   * before. Larger rooms retrieve only the most relevant docs for the latest
   * user message. Returns `undefined` to mean "let buildSystemPrompt inject all
   * enabled docs" — so any RAG hiccup falls back to the original behaviour.
   */
  private async selectGuidanceForPrompt(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<GuidanceDoc[] | undefined> {
    const enabled = (this.state.guidance ?? []).filter(isIndexableGuidance);
    if (enabled.length <= GUIDANCE_INJECT_ALL_MAX || !hasVectorize(this.env)) return undefined;
    const query = latestUserText(messages);
    if (!query) return undefined;
    const hits = await retrieveGuidance(this.env, this.roomKey(), query, enabled, GUIDANCE_TOP_K);
    return hits && hits.length ? hits : undefined;
  }

  // ---------------------------------------------------------------------------
  // Cloudflare docs RAG (cron-owned global reindex + per-message retrieval)
  //
  // A resumable background job scrapes the FULL Cloudflare developer docs, embeds
  // each page, and upserts them into the SHARED Vectorize index under a GLOBAL
  // namespace (docs-scraper.ts) — so EVERY room's chat retrieves grounding
  // excerpts, not just this one. It runs in bounded batches chained via the
  // Agents SDK scheduler, so it survives client disconnects and DO restarts.
  // Progress and bookkeeping live only in the fixed DOCS_SYSTEM_ROOM instance.
  // The browser has no callable controls for this deployment-wide resource.
  // ---------------------------------------------------------------------------

  /** Current docs-index progress, defaulted for a room that's never run it. */
  private docsState(): DocsIndexState {
    return (
      this.state.docsIndex ?? {
        status: "idle",
        productsTotal: 0,
        productsEnumerated: 0,
        pagesTotal: 0,
        pagesIndexed: 0,
        pagesFailed: 0,
        chunksUpserted: 0,
      }
    );
  }

  /** Merge a patch into docsIndex and sync it to the room. */
  private setDocsState(patch: Partial<DocsIndexState>): DocsIndexState {
    const next: DocsIndexState = { ...this.docsState(), ...patch, updatedAt: Date.now() };
    this.setState({ ...this.state, docsIndex: next });
    return next;
  }

  /** Live counts from the work-queue tables — the source of truth for progress. */
  private docsCounts(): {
    productsTotal: number;
    productsEnumerated: number;
    pagesTotal: number;
    pagesIndexed: number;
    pagesFailed: number;
    pagesPending: number;
    chunksUpserted: number;
  } {
    const n = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
    return {
      productsTotal: n(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_products`),
      productsEnumerated: n(
        this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_products WHERE enumerated = 1`,
      ),
      pagesTotal: n(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_pages`),
      pagesIndexed: n(
        this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_pages WHERE status = ${DOCS_PAGE_DONE}`,
      ),
      pagesFailed: n(
        this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_pages WHERE status = ${DOCS_PAGE_FAILED}`,
      ),
      pagesPending: n(
        this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_pages WHERE status = ${DOCS_PAGE_PENDING}`,
      ),
      chunksUpserted: n(
        this.sql<{ n: number }>`SELECT COALESCE(SUM(chunks), 0) AS n FROM glide_docs_pages WHERE status = ${DOCS_PAGE_DONE}`,
      ),
    };
  }

  private docsReindexIsActive(state: DocsIndexState = this.docsState()): boolean {
    return state.status === "enumerating" || state.status === "indexing";
  }

  private docsReindexErrorMessage(error: unknown, fallback: string): string {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
    return (raw.trim() || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
  }

  /** Move only the same still-active run to a terminal error state. */
  private failDocsReindex(runId: string, error: string): void {
    const state = this.docsState();
    if (state.runId !== runId || !this.docsReindexIsActive(state)) return;
    this.setDocsState({
      status: "error",
      currentProduct: undefined,
      error,
      finishedAt: Date.now(),
    });
  }

  private docsTickRunId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const runId = (payload as { runId?: unknown }).runId;
    return typeof runId === "string" ? runId : undefined;
  }

  /**
   * Ensure exactly one delayed tick owns the active run. `replace` is used by
   * the executing callback: its one-shot row still exists until the callback
   * returns, so it must be removed before an idempotent successor is inserted.
   */
  private async armDocsTick(runId: string, replace = false): Promise<void> {
    const schedules = (await this.listSchedules()).filter((schedule) => schedule.callback === "docsTick");
    let retainedCurrentRun = false;
    for (const schedule of schedules) {
      const sameRun = this.docsTickRunId(schedule.payload) === runId;
      if (!replace && sameRun && !retainedCurrentRun) {
        retainedCurrentRun = true;
        continue;
      }
      await this.cancelSchedule(schedule.id);
    }
    // Calling idempotent schedule even when a row was retained also restores
    // the physical Durable Object alarm if it was lost during a reset.
    await this.schedule(
      DOCS_TICK_DELAY_SEC,
      "docsTick",
      { runId },
      { idempotent: true },
    );
  }

  /** Recover an active, fully-seeded crawl whenever the coordinator wakes. */
  private async reconcileDocsReindex(): Promise<void> {
    if (this.name !== DOCS_SYSTEM_ROOM) return;
    const state = this.docsState();
    if (!this.docsReindexIsActive(state)) return;
    const runId = state.runId;
    if (!runId) {
      this.setDocsState({
        status: "error",
        currentProduct: undefined,
        error: "The docs reindex lost its run id and must be restarted.",
        finishedAt: Date.now(),
      });
      return;
    }

    try {
      const counts = this.docsCounts();
      // Never infer completion from a partially-populated legacy queue: doing so
      // could make an incomplete manifest authoritative and delete valid vectors.
      if (state.queueSeeded !== true || counts.productsTotal === 0) {
        this.failDocsReindex(
          runId,
          "The docs reindex was interrupted before its work queue was ready; start a new refresh.",
        );
        return;
      }
      await this.armDocsTick(runId);
    } catch (error) {
      const message = this.docsReindexErrorMessage(error, "The docs reindex could not be resumed.");
      console.error({ glideEvent: "docs.reindex_reconcile_failed", runId, error: message });
      this.failDocsReindex(runId, message);
    }
  }

  /**
   * Start (or restart) the cron-owned Cloudflare-docs reindex. Fetches the top-level
   * index synchronously so we can report the product total immediately, seeds the
   * work queue, then hands off to `docsTick` via the scheduler. The heavy lifting
   * (per-product enumeration + per-page embed/upsert) happens in the background.
   */
  async startDocsReindex(by = "the weekly refresh cron"): Promise<{ ok: boolean; message: string }> {
    if (this.name !== DOCS_SYSTEM_ROOM) {
      return { ok: false, message: "The docs reindex coordinator is internal-only." };
    }
    if (!hasVectorize(this.env)) {
      return {
        ok: false,
        message: "Semantic search isn't configured for this deployment (no Vectorize index).",
      };
    }
    const cur = this.docsState();
    if (this.docsReindexIsActive(cur)) {
      return { ok: false, message: "A docs reindex is already running." };
    }

    const runId = `d-${crypto.randomUUID()}`;
    const startedBy = this.verifiedActor(by, "the docs refresh");
    const startedAt = Date.now();
    try {
      this.setState({
        ...this.state,
        docsIndex: {
          status: "enumerating",
          runId,
          queueSeeded: false,
          productsTotal: 0,
          productsEnumerated: 0,
          pagesTotal: 0,
          pagesIndexed: 0,
          pagesFailed: 0,
          chunksUpserted: 0,
          startedBy,
          startedAt,
          updatedAt: startedAt,
        },
      });

      return await this.keepAliveWhile(async () => {
        const md = await fetchDocText(DOCS_ROOT_INDEX);
        if (md == null) {
          this.failDocsReindex(runId, "Couldn't fetch the Cloudflare docs index.");
          return { ok: false, message: "Couldn't fetch the Cloudflare docs index — try again shortly." };
        }
        const products = parseTopIndex(md);
        if (!products.length) {
          this.failDocsReindex(
            runId,
            "The docs index listed no products (the format may have changed).",
          );
          return { ok: false, message: "The docs index looked empty — the format may have changed." };
        }

        // Preserve the last completed manifest. Deterministic page ids let this run
        // replace vectors in place while failed pages keep their last-known-good data.
        const previousManifestCount = Number(
          this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_previous_pages`[0]?.n ?? 0,
        );
        if (previousManifestCount === 0) {
          this.sql`INSERT OR REPLACE INTO glide_docs_previous_pages (url, chunks)
            SELECT url, chunks FROM glide_docs_pages WHERE status = ${DOCS_PAGE_DONE}`;
        }

        this.sql`DELETE FROM glide_docs_products`;
        this.sql`DELETE FROM glide_docs_pages`;
        this.sql`DELETE FROM glide_docs_product_attempts`;
        for (const product of products) {
          this.sql`INSERT OR REPLACE INTO glide_docs_products (product, label, url, category, enumerated)
            VALUES (${product.product}, ${product.label}, ${product.url}, ${product.category}, 0)`;
        }

        // Publish the handoff only after every queue row is durable. onStart()
        // treats an active run without this marker as interrupted, never resumable.
        this.setState({
          ...this.state,
          docsIndex: {
            status: "enumerating",
            runId,
            queueSeeded: true,
            productsTotal: products.length,
            productsEnumerated: 0,
            pagesTotal: 0,
            pagesIndexed: 0,
            pagesFailed: 0,
            chunksUpserted: 0,
            startedBy,
            startedAt,
            updatedAt: Date.now(),
          },
        });

        await this.armDocsTick(runId);
        return {
          ok: true,
          message: `Indexing ${products.length} Cloudflare products in the background — progress updates here.`,
        };
      });
    } catch (error) {
      const message = this.docsReindexErrorMessage(error, "The docs reindex could not be started.");
      console.error({ glideEvent: "docs.reindex_start_failed", runId, error: message });
      this.failDocsReindex(runId, message);
      return { ok: false, message: `Docs reindex setup failed: ${message}` };
    }
  }

  /** Start the first global index on demand so a new deployment need not wait for Sunday. */
  async ensureDocsIndex(): Promise<{ ok: boolean; message: string }> {
    const state = this.docsState();
    if (state.status === "enumerating" || state.status === "indexing" || state.status === "done") {
      return { ok: true, message: `Docs index is ${state.status}.` };
    }
    if (
      state.status === "error" &&
      state.updatedAt &&
      Date.now() - state.updatedAt < DOCS_BOOTSTRAP_RETRY_MS
    ) {
      return { ok: false, message: "Docs index bootstrap is waiting before retrying." };
    }
    return this.startDocsReindex("the initial deployment bootstrap");
  }

  /** Commit manifest cleanup only after every product index was enumerated. */
  private async finishDocsReindex(): Promise<void> {
    const counts = this.docsCounts();
    const failedProducts = Number(
      this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM glide_docs_products WHERE enumerated = -1`[0]?.n ?? 0,
    );
    if (failedProducts > 0) {
      this.setDocsState({
        status: "error",
        currentProduct: undefined,
        productsTotal: counts.productsTotal,
        productsEnumerated: counts.productsEnumerated,
        pagesTotal: counts.pagesTotal,
        pagesIndexed: counts.pagesIndexed,
        pagesFailed: counts.pagesFailed,
        chunksUpserted: counts.chunksUpserted,
        error: `${failedProducts} product index${failedProducts === 1 ? "" : "es"} could not be enumerated; last-known-good vectors were retained.`,
        finishedAt: Date.now(),
      });
      return;
    }

    const currentUrls = new Set(this.sql<{ url: string }>`SELECT url FROM glide_docs_pages`.map((row) => row.url));
    const previousPages = this.sql<{ url: string; chunks: number }>`
      SELECT url, chunks FROM glide_docs_previous_pages`;
    const removedPages = previousPages.filter((page) => !currentUrls.has(page.url));
    const cleanup = await deleteDocPages(this.env, removedPages);
    if (!cleanup.ok) {
      this.setDocsState({
        status: "error",
        currentProduct: undefined,
        error: "The replacement crawl completed, but removed-page cleanup failed; existing vectors were retained.",
        finishedAt: Date.now(),
      });
      return;
    }
    for (const page of removedPages) {
      this.sql`DELETE FROM glide_docs_previous_pages WHERE url = ${page.url}`;
    }
    this.setDocsState({
      status: "done",
      currentProduct: undefined,
      productsTotal: counts.productsTotal,
      productsEnumerated: counts.productsEnumerated,
      pagesTotal: counts.pagesTotal,
      pagesIndexed: counts.pagesIndexed,
      pagesFailed: counts.pagesFailed,
      chunksUpserted: counts.chunksUpserted,
      error: undefined,
      finishedAt: Date.now(),
    });
  }

  /**
   * One bounded unit of reindex work, invoked by the scheduler and re-armed by
   * itself until the queue drains. Phase 1 enumerates one product's page list;
   * phase 2 embeds+upserts a batch of pending pages. Stale ticks (from a
   * superseded run — matched on `runId`) return without rescheduling,
   * which cleanly kills the chain. Per-page failures are recorded, not fatal.
   */
  async docsTick(payload?: { runId?: string }): Promise<void> {
    const runId = payload?.runId;
    const state = this.docsState();
    if (!runId || runId !== state.runId) return; // stale/cancelled
    if (!this.docsReindexIsActive(state)) return;
    if (state.queueSeeded !== true) {
      this.failDocsReindex(
        runId,
        "The docs reindex cannot continue because its work queue is incomplete.",
      );
      return;
    }

    try {
      await this.keepAliveWhile(async () => {
        const current = this.docsState();
        if (current.runId !== runId || !this.docsReindexIsActive(current)) return;

        // Phase 1 — enumerate one un-enumerated product into the page queue.
        const prod = this.sql<{ product: string; label: string; url: string }>`
          SELECT product, label, url FROM glide_docs_products WHERE enumerated = 0 LIMIT 1`[0];
        if (prod) {
          const md = await fetchDocText(prod.url);
          const pages = md == null ? [] : parseProductIndex(md);
          if (pages.length) {
            for (const page of pages) {
              this.sql`INSERT OR IGNORE INTO glide_docs_pages (url, product, title, section, status, chunks)
                VALUES (${page.url}, ${prod.label}, ${page.title}, ${page.section}, ${DOCS_PAGE_PENDING}, 0)`;
            }
            this.sql`UPDATE glide_docs_products SET enumerated = 1 WHERE product = ${prod.product}`;
            this.sql`DELETE FROM glide_docs_product_attempts WHERE product = ${prod.product}`;
          } else {
            const attempts =
              Number(
                this.sql<{ attempts: number }>`SELECT attempts FROM glide_docs_product_attempts
                  WHERE product = ${prod.product}`[0]?.attempts ?? 0,
              ) + 1;
            this.sql`INSERT OR REPLACE INTO glide_docs_product_attempts (product, attempts)
              VALUES (${prod.product}, ${attempts})`;
            if (attempts >= DOCS_PRODUCT_ATTEMPTS) {
              this.sql`UPDATE glide_docs_products SET enumerated = -1 WHERE product = ${prod.product}`;
            }
          }
          const counts = this.docsCounts();
          this.setDocsState({
            status: "enumerating",
            currentProduct: prod.label,
            productsTotal: counts.productsTotal,
            productsEnumerated: counts.productsEnumerated,
            pagesTotal: counts.pagesTotal,
          });
          await this.armDocsTick(runId, true);
          return;
        }

        // Phase 2 — index a batch of pending pages.
        const pageRows = this.sql<{ url: string; product: string; title: string; section: string }>`
          SELECT url, product, title, section FROM glide_docs_pages
          WHERE status = ${DOCS_PAGE_PENDING} LIMIT ${DOCS_PAGES_PER_TICK}`;
        if (pageRows.length) {
          for (const row of pageRows) {
            // Re-check cancellation between pages so a superseding run is responsive.
            const latest = this.docsState();
            if (latest.runId !== runId || !this.docsReindexIsActive(latest)) return;
            const result = await indexDocPage(
              this.env,
              { url: row.url, title: row.title, section: row.section },
              row.product,
            );
            if (result.ok) {
              this.sql`UPDATE glide_docs_pages SET status = ${DOCS_PAGE_DONE}, chunks = ${result.chunks} WHERE url = ${row.url}`;
              const retainedChunks = result.retainedChunks ?? result.chunks;
              this.sql`INSERT OR REPLACE INTO glide_docs_previous_pages (url, chunks)
                VALUES (${row.url}, ${retainedChunks})`;
            } else {
              this.sql`UPDATE glide_docs_pages SET status = ${DOCS_PAGE_FAILED} WHERE url = ${row.url}`;
            }
          }
          const counts = this.docsCounts();
          if (counts.pagesPending === 0) {
            await this.finishDocsReindex();
          } else {
            this.setDocsState({
              status: "indexing",
              currentProduct: pageRows[pageRows.length - 1]?.product,
              productsTotal: counts.productsTotal,
              productsEnumerated: counts.productsEnumerated,
              pagesTotal: counts.pagesTotal,
              pagesIndexed: counts.pagesIndexed,
              pagesFailed: counts.pagesFailed,
              chunksUpserted: counts.chunksUpserted,
            });
            await this.armDocsTick(runId, true);
          }
          return;
        }

        // All products enumerated and no pending pages → done.
        await this.finishDocsReindex();
      });
    } catch (error) {
      const message = this.docsReindexErrorMessage(error, "The docs reindex tick failed.");
      console.error({ glideEvent: "docs.reindex_tick_failed", runId, error: message });
      this.failDocsReindex(runId, message);
    }
  }

  /**
   * Retrieve the indexed Cloudflare-docs chunks most relevant to this turn, to
   * ground the model's answer. Returns undefined when semantic search is
   * unavailable or nothing matched — so buildSystemPrompt simply omits the docs
   * section. Never throws (retrieveDocChunks swallows its own errors).
   */
  private async selectDocsForPrompt(
    messages: Array<{ role: string; content: unknown }>,
  ): Promise<DocChunk[] | undefined> {
    if (!hasVectorize(this.env)) return undefined;
    const query = latestUserText(messages);
    if (!query) return undefined;
    const hits = await retrieveDocChunks(this.env, query, DOCS_TOP_K);
    return hits.length ? hits : undefined;
  }

  /**
   * Fold the Cloudflare-docs pages surfaced this turn into the room's running
   * "further reading" list (deduped by URL, most-recent first, capped). Built
   * automatically from what the conversation actually needed; rendered in the
   * sidebar and `/admin`. Best-effort — never blocks the chat turn.
   */
  private recordDocLinks(hits: DocChunk[]): void {
    if (!hits.length) return;
    const next = mergeDocLinks(this.state.docLinks, hits, Date.now());
    this.setState({ ...this.state, docLinks: next });
  }

  // ---------------------------------------------------------------------------
  // Chat brain
  // ---------------------------------------------------------------------------

  private roomLogCorrelation(): string {
    return this.ctx.id.toString();
  }

  private logChatEvent(
    event: string,
    details: Record<string, string | number | boolean | undefined> = {},
    level: "info" | "warn" | "error" = "info",
  ): void {
    const payload = { glideEvent: event, room: this.roomLogCorrelation(), ...details };
    if (level === "error") console.error(payload);
    else if (level === "warn") console.warn(payload);
    else console.log(payload);
  }

  async onChatMessage(
    onFinish: OnChatFinish,
    options?: {
      requestId?: string;
      abortSignal?: AbortSignal;
      body?: Record<string, unknown>;
      continuation?: boolean;
    },
  ): Promise<Response | undefined> {
    const accessLease = this.currentChatRoomAccessLease();
    if (accessLease && !this.isRoomAccessLeaseCurrent(accessLease)) {
      throw new Error("Room access ended before the chat turn started.");
    }
    // Refresh this room's "last active" in the registry, throttled so a busy room
    // doesn't write on every turn. Best-effort; never blocks the chat turn.
    this.syncRoomToRegistry({ throttleMs: 5 * 60_000 });
    const turn: ChatTurnContext = {
      actor: accessLease?.email ?? this.resolveServerActor(options?.body),
      queuedActions: [],
      queueNotices: [],
      accessLease,
      abortSignal: options?.abortSignal,
      requestId: options?.requestId,
    };

    const turnId = crypto.randomUUID();
    const latestMessage = this.messages[this.messages.length - 1];
    const responseToMessageId = latestMessage?.role === "user" ? latestMessage.id : "";
    const assistantMessageId = crypto.randomUUID();
    if (responseToMessageId) {
      this.sql`INSERT OR REPLACE INTO glide_assistant_events (id, response_to, ts)
        VALUES (${assistantMessageId}, ${responseToMessageId}, ${Date.now()})`;
    }
    const isActionResultEvent = latestMessage ? this.isRegisteredActionResultEvent(latestMessage) : false;
    this.logChatEvent("chat.received", {
      turnId,
      messageId: latestMessage?.id ?? "unknown",
      messageCount: this.messages.length,
      actionResultEvent: isActionResultEvent,
    });

    const workersai = createWorkersAI({ binding: dedupAIBinding(this.env.AI) });
    const model = workersai(this.env.GLIDE_MODEL);

    const modelHistory = boundedChatHistory(
      this.messages,
      MAX_MODEL_CHAT_MESSAGES,
      MAX_MODEL_CHAT_HISTORY_BYTES,
    );
    const messages = await convertToModelMessages(modelHistory.map((message) => this.messageForModel(message)));
    if (!this.isChatTurnAccessCurrent(turn)) {
      throw new Error("Room access ended while the chat turn was being prepared.");
    }

    // Deterministically capture onboarding answers straight from the user's
    // latest message and fold them into the room's onboarding state BEFORE the
    // model runs. The quantized model routinely calls `update_onboarding` with
    // empty arguments (observed: the team picked "full" but `setupType` was never
    // recorded, so the right-hand checklist never ticked). This backfill fills
    // ONLY fields that aren't set yet (goals are unioned), so it never fights a
    // more specific tool call — it just makes the checklist self-complete and
    // keeps the prompt's "Onboarding status" accurate so the model stops re-asking.
    if (this.state.onboarding?.active && !isActionResultEvent) {
      const ob = this.state.onboarding;
      const inferred = inferOnboardingFromText(latestUserText(messages));
      const patch: { path?: OnboardingPath; setupType?: SetupType; domain?: string; goals?: string[] } = {};
      if (inferred.path && !ob.path) patch.path = inferred.path;
      if (inferred.setupType && !ob.setupType) patch.setupType = inferred.setupType;
      if (inferred.domain && !ob.domain) patch.domain = inferred.domain;
      if (inferred.goals?.length) {
        const merged = Array.from(new Set([...(ob.goals ?? []), ...inferred.goals]));
        if (merged.length !== (ob.goals?.length ?? 0)) patch.goals = merged;
      }
      if (Object.keys(patch).length) this.applyOnboardingPatch(patch, turn.actor);
    }

    // Backfill the "nature of the business" profile from the user's message
    // (see inferBusinessProfileFromText). Runs whether or not onboarding is
    // active so the on-demand advisor keeps a useful profile even after go-live.
    // It only FILLS BLANKS and UNIONS arrays — it never overwrites an explicit
    // answer or flips a boolean to false — so it can't fight a more specific tool
    // call, exactly like the onboarding backfill above.
    if (!isActionResultEvent) {
      const inferred = inferBusinessProfileFromText(latestUserText(messages));
      const cur = this.state.businessProfile ?? EMPTY_BUSINESS_PROFILE;
      const patch: Partial<BusinessProfile> = {};
      if (inferred.industry && !cur.industry) patch.industry = inferred.industry;
      if (inferred.audience && !cur.audience) patch.audience = inferred.audience;
      if (inferred.trafficProfile && !cur.trafficProfile) patch.trafficProfile = inferred.trafficProfile;
      if (inferred.hasLogin && cur.hasLogin === undefined) patch.hasLogin = true;
      if (inferred.hasApi && cur.hasApi === undefined) patch.hasApi = true;
      const union = (base: string[], extra?: string[]): string[] | undefined => {
        if (!extra?.length) return undefined;
        const merged = Array.from(new Set([...base, ...extra]));
        return merged.length !== base.length ? merged : undefined;
      };
      const appTypes = union(cur.appTypes, inferred.appTypes);
      if (appTypes) patch.appTypes = appTypes;
      const sensitiveData = union(cur.sensitiveData, inferred.sensitiveData);
      if (sensitiveData) patch.sensitiveData = sensitiveData;
      const compliance = union(cur.compliance, inferred.compliance);
      if (compliance) patch.compliance = compliance;
      const concerns = union(cur.concerns, inferred.concerns);
      if (concerns) patch.concerns = concerns;
      if (Object.keys(patch).length) this.applyBusinessProfilePatch(patch, turn.actor);
    }

    // RAG (run both retrievals concurrently): pick the guidance docs most
    // relevant to this turn (or all, for small rooms / when semantic search is
    // unavailable), and pull grounding excerpts from the indexed Cloudflare docs.
    // Both fall back to undefined so the prompt degrades gracefully.
    const [guidanceForPrompt, docsForPrompt] = await Promise.all([
      this.selectGuidanceForPrompt(messages),
      this.selectDocsForPrompt(messages),
    ]);
    if (!this.isChatTurnAccessCurrent(turn)) {
      throw new Error("Room access ended while the chat turn was being prepared.");
    }
    this.logChatEvent("chat.prepared", {
      turnId,
      guidanceCount: guidanceForPrompt?.length ?? 0,
      docsCount: docsForPrompt?.length ?? 0,
    });
    // Fold the docs surfaced this turn into the room's running "further reading"
    // list so the team gets a reading list built from the actual conversation.
    if (docsForPrompt?.length) this.recordDocLinks(docsForPrompt);
    const system = buildSystemPrompt(this.state, guidanceForPrompt, docsForPrompt);
    const tools = this.buildTools(turn);
    const repairToolCall: ToolCallRepairFunction<typeof tools> = async ({ toolCall }) => {
      if (toolCall.toolName !== "update_onboarding") return null;
      const input = repairOnboardingToolInput(toolCall.input);
      return input ? { ...toolCall, input } : null;
    };
    const abortSignal = options?.abortSignal;
    const releaseAccessAborter = accessLease && options?.requestId
      ? this.registerRoomAccessAborter(
          accessLease,
          (reason) => this.abortRequest(options.requestId!, reason),
        )
      : () => {};

    // Multi-pass response, emitted as ONE assistant message. Pass 1 runs the
    // tools; models sometimes mis-end the turn in two ways regardless of prompt
    // nudges (this was chronic on the quantized fp8-fast Llama; kept as a general
    // safety net for gpt-oss and any future model), so we recover both:
    //
    //   • Ends ON a tool call with no follow-up prose → a lone, stuck-looking
    //     tool chip. If pass 1 produced no prose, run a tool-less narration
    //     pass (`toolChoice: "none"`) forced to say what just happened.
    //   • Ends by PROMISING an action ("let me check if the zone exists…") — or
    //     by emitting a tool call as literal text — but never actually calls a
    //     tool, so the step silently never runs. If the final prose is such a
    //     dangling promise, run a continuation WITH tools (`toolChoice:
    //     "required"`) that performs it, then narrate. Fires at most once.
    //
    // Model passes are buffered before being replayed. That lets server state
    // replace any unsupported "queued" claim before the client ever sees it,
    // while preserving tool chunks and emitting exactly one final `finish`.
    const stream = createUIMessageStream({
      generateId: () => assistantMessageId,
      execute: async ({ writer }) => {
        let stage = "initializing";
        let outcome: "completed" | "aborted" | "error" = "completed";
        try {
        type Chunk = Parameters<typeof writer.write>[0];
        const collect = async (source: ReadableStream<Chunk>): Promise<Chunk[]> => {
          const chunks: Chunk[] = [];
          const reader = source.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) return chunks;
            chunks.push(value);
          }
        };
        const isTextChunk = (chunk: Chunk): boolean =>
          chunk.type === "text-start" || chunk.type === "text-delta" || chunk.type === "text-end";
        const writeChunks = (chunks: Chunk[], includeText = true): void => {
          for (const chunk of chunks) {
            if (includeText || !isTextChunk(chunk)) writer.write(chunk);
          }
        };
        const textFromChunks = (chunks: Chunk[]): string =>
          chunks
            .filter((chunk): chunk is Extract<Chunk, { type: "text-delta" }> => chunk.type === "text-delta")
            .map((chunk) => chunk.delta)
            .join("")
            .trim();
        const appendText = (text: string, separated = false): void => {
          if (!text) return;
          const id = crypto.randomUUID();
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: `${separated ? "\n\n" : ""}${text}` });
          writer.write({ type: "text-end", id });
        };
        const finishMessage = (): void => {
          writer.write({
            type: "finish",
            messageMetadata: {
              responseTo: responseToMessageId,
              delivery: this.isChatTurnAccessCurrent(turn) ? "completed" : "interrupted",
            } satisfies GlideMessageMetadata,
          });
        };
        const emitQueueNarration = (chunks: Chunk[], label: string): boolean => {
          const prose = assistantProse(textFromChunks(chunks));
          if (!turn.queuedActions.length && !claimsNewQueuedAction(prose)) {
            return false;
          }

          // Tool chunks remain visible, but free-form queue narration is replaced
          // with an exact summary derived from actions server code created.
          writeChunks(chunks, false);
          console.warn(`Replaced model queue narration with server state in ${label}.`);
          appendText(this.authoritativeQueueNarration(prose, turn.queuedActions, turn.queueNotices));
          return true;
        };
        if (!this.isChatTurnAccessCurrent(turn)) {
          outcome = "aborted";
          finishMessage();
          return;
        }
        stage = "model.initial";
        const first = streamText({
          model,
          system,
          messages,
          tools,
          experimental_repairToolCall: repairToolCall,
          stopWhen: stepCountIs(8),
          abortSignal,
          onFinish,
        });
        // sendReasoning:false — gpt-oss streams a harmony "reasoning" channel, and
        // the client renders reasoning parts as visible chat text (main.tsx). Keep
        // the model's chain-of-thought out of the room; only its final prose shows.
        const firstChunks = await collect(
          first.toUIMessageStream({
            sendFinish: false,
            sendReasoning: false,
            messageMetadata: () => ({ responseTo: responseToMessageId } satisfies GlideMessageMetadata),
          }),
        );
        stage = "model.initial.complete";
        const firstText = textFromChunks(firstChunks);
        this.logChatEvent("chat.model_pass", {
          turnId,
          stage,
          chunkCount: firstChunks.length,
          textLength: firstText.length,
          queuedActions: turn.queuedActions.length,
        });

        // A tool-less pass (`toolChoice: "none"`) that forces the model to put
        // WORDS to what just happened — used whenever a turn would otherwise end
        // with no forward motion. `narrate` shapes what it should say.
        const runNarration = async (
          responseMessages: Awaited<typeof first.response>["messages"],
          narrate: string,
          fallbackQuestion?: string,
        ): Promise<void> => {
          if (!this.isChatTurnAccessCurrent(turn)) {
            outcome = "aborted";
            finishMessage();
            return;
          }
          stage = "model.narration";
          // Tools may have updated onboarding/defaults since `system` was built
          // (notably list_dns_records marks DNS review complete). Rebuild here so
          // the forced follow-up asks for the actual next unchecked step.
          const narrationSystem = buildSystemPrompt(
            this.state,
            guidanceForPrompt,
            docsForPrompt,
          );
          const narration = streamText({
            model,
            system: `${narrationSystem}\n\n${narrate}`,
            messages: [...messages, ...responseMessages],
            toolChoice: "none",
            abortSignal,
          });
          const narrationChunks = await collect(
            narration.toUIMessageStream({ sendStart: false, sendFinish: false, sendReasoning: false }),
          );
          if (emitQueueNarration(narrationChunks, "chat narration")) {
            if (fallbackQuestion) appendText(fallbackQuestion, true);
            finishMessage();
            return;
          }
          writeChunks(narrationChunks, false);
          const narrationProse = assistantProse(textFromChunks(narrationChunks));
          if (promisesToolAction(narrationProse)) {
            const correction = this.unfulfilledActionNarration();
            appendText(fallbackQuestion ? `${correction}\n\n${fallbackQuestion}` : correction, true);
          } else if (fallbackQuestion && !hasFinalUserHandoff(narrationProse)) {
            appendText(
              narrationProse ? `${narrationProse}\n\n${fallbackQuestion}` : fallbackQuestion,
              true,
            );
          } else {
            appendText(narrationProse, true);
          }
          finishMessage();
        };

        if (!this.isChatTurnAccessCurrent(turn)) {
          outcome = "aborted";
          if (!emitQueueNarration(firstChunks, "aborted initial chat response")) {
            writeChunks(firstChunks, false);
            appendText("The response was interrupted before that step completed. Please retry the request.");
          }
          finishMessage();
          return;
        }

        const prose = assistantProse(firstText);
        let responseMessages: Awaited<typeof first.response>["messages"] = [];
        try {
          responseMessages = (await first.response).messages;
        } catch {
          responseMessages = [];
        }

        // The standard "you just ran a tool — now say what happened" nudge.
        const captureNarrate =
          `The tool result above is already recorded — do not call any more tools. ` +
          `In one or two short, warm sentences, tell ${turn.actor} what you just ` +
          `captured and clearly state the next onboarding step or question. ` +
          `Server-confirmed approvals created this turn: ${turn.queuedActions.length}. ` +
          `If that number is zero, explicitly say that nothing was queued.`;
        const dnsFollowUpNarrate =
          `The DNS result above is already shown to ${turn.actor} — do NOT call any tools and do ` +
          `NOT repeat that data. Onboarding is still in progress. In ONE short, warm sentence, ask the ` +
          `single next unanswered onboarding question from the current Onboarding status. Ask exactly ` +
          `one question and end it with a question mark.`;
        const dnsFallbackQuestion =
          "Which DNS records should Cloudflare proxy (orange cloud), and which should remain DNS-only?";
        const completedDnsReview = (chunks: Chunk[]): boolean =>
          !!this.state.onboarding?.active &&
          !this.state.onboarding.completed &&
          hasSuccessfulToolOutput(chunks, "list_dns_records");
        const needsDnsFollowUp = (chunks: Chunk[], text: string): boolean =>
          needsOnboardingFollowUp(
            this.state.onboarding,
            text,
            hasSuccessfulToolOutput(chunks, "list_dns_records"),
          );

        if (emitQueueNarration(firstChunks, "initial chat response")) {
          if (completedDnsReview(firstChunks)) {
            this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
            appendText(dnsFallbackQuestion, true);
          }
          finishMessage();
          return;
        }

        // Case A — the model wrote a tool call as literal TEXT, so it never ran
        // and nothing happened. Force ONE real, structured call
        // (`toolChoice: "required"`) so the intended action actually executes,
        // then narrate. Bounded to a single retry, so it can't loop.
        if (containsToolCallText(firstText)) {
          stage = "model.tool_continuation";
          const nudge =
            `You wrote a tool call as plain text, so it never ran and nothing happened. ` +
            `Carry out exactly what you intended NOW by actually calling the tool, then ` +
            `tell ${turn.actor} the result and the next step. Do not paste JSON.`;
          const cont = streamText({
            model,
            system: `${system}\n\n${nudge}`,
            messages: [...messages, ...responseMessages],
            tools,
            toolChoice: "required",
            experimental_repairToolCall: repairToolCall,
            stopWhen: stepCountIs(8),
            abortSignal,
          });
          const contChunks = await collect(
            cont.toUIMessageStream({ sendStart: false, sendFinish: false, sendReasoning: false }),
          );
          const contText = textFromChunks(contChunks);
          try {
            responseMessages = [...responseMessages, ...(await cont.response).messages];
          } catch {
            /* keep the pass-1 messages we already gathered */
          }

          // The first pass contained a non-executing literal tool call. Preserve
          // only protocol/tool chunks; its prose is not trustworthy narration.
          writeChunks(firstChunks, false);
          const contProse = assistantProse(contText);
          const contCompletedDnsReview = completedDnsReview(contChunks);
          const contNeedsDnsFollowUp = needsDnsFollowUp(contChunks, contProse);
          if (emitQueueNarration(contChunks, "tool continuation")) {
            if (contCompletedDnsReview) {
              this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
              appendText(dnsFallbackQuestion, true);
            }
            finishMessage();
            return;
          }
          if (contProse.length === 0 && this.isChatTurnAccessCurrent(turn)) {
            writeChunks(contChunks);
            if (contNeedsDnsFollowUp) this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
            await runNarration(
              responseMessages,
              contNeedsDnsFollowUp ? dnsFollowUpNarrate : captureNarrate,
              contNeedsDnsFollowUp ? dnsFallbackQuestion : undefined,
            );
          } else if (promisesToolAction(contProse)) {
            writeChunks(contChunks, false);
            const correction = this.unfulfilledActionNarration();
            if (contCompletedDnsReview) {
              this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
            }
            appendText(
              contCompletedDnsReview ? `${correction}\n\n${dnsFallbackQuestion}` : correction,
              true,
            );
            finishMessage();
          } else if (contNeedsDnsFollowUp) {
            this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
            writeChunks(contChunks);
            await runNarration(responseMessages, dnsFollowUpNarrate, dnsFallbackQuestion);
          } else {
            writeChunks(contChunks);
            finishMessage();
          }
          return;
        }

        // Case B — a tool ran but the model produced no prose (only tool-call
        // JSON / tokens that strip to empty): narrate what happened.
        if (prose.length === 0) {
          const needsFollowUp = needsDnsFollowUp(firstChunks, prose);
          if (needsFollowUp) this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
          writeChunks(firstChunks);
          await runNarration(
            responseMessages,
            needsFollowUp ? dnsFollowUpNarrate : captureNarrate,
            needsFollowUp ? dnsFallbackQuestion : undefined,
          );
          return;
        }

        // Case C — the prose PROMISES an action somewhere ("I will now queue an
        // action to add your domain.") but ends the turn without asking anything,
        // and often without actually doing it (the reported dead-end: it claimed a
        // queue while nothing was queued). Run a corrective narration that forbids
        // false claims and forces a forward-moving question. We deliberately do
        // NOT force a blind write here — without the domain/token that would only
        // junk the pending queue; asking is the correct, safe recovery.
        if (promisesToolAction(prose)) {
          writeChunks(firstChunks, false);
          const correction = this.unfulfilledActionNarration();
          const dnsReviewed = completedDnsReview(firstChunks);
          if (dnsReviewed) this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
          appendText(
            dnsReviewed ? `${correction}\n\n${dnsFallbackQuestion}` : correction,
          );
          finishMessage();
          return;
        }

        // Case D — list_dns_records succeeded mid-onboarding and the model
        // reported the result but asked nothing. Keep the useful summary, then
        // force one tool-less follow-up question so the guided flow cannot stall.
        if (needsDnsFollowUp(firstChunks, prose)) {
          this.logChatEvent("chat.onboarding_nudge", { turnId, stage });
          writeChunks(firstChunks);
          await runNarration(responseMessages, dnsFollowUpNarrate, dnsFallbackQuestion);
          return;
        }

        // Pass 1 produced real prose that moves forward.
        writeChunks(firstChunks);
        finishMessage();
        } catch (error) {
          outcome = "error";
          this.logChatEvent(
            "chat.error",
            {
              turnId,
              stage,
              errorName: error instanceof Error ? error.name : "UnknownError",
              errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            },
            "error",
          );
          throw error;
        } finally {
          this.logChatEvent(
            "chat.stream_finished",
            {
              turnId,
              stage,
              outcome,
              queuedActions: turn.queuedActions.length,
            },
            outcome === "error" ? "error" : outcome === "aborted" ? "warn" : "info",
          );
          releaseAccessAborter();
        }
      },
    });

    this.logChatEvent("chat.stream_created", { turnId });
    return createUIMessageStreamResponse({ stream });
  }

  /** Server-driven turns retain a bounded attribution fallback. */
  private resolveServerActor(body?: Record<string, unknown>): string {
    const fromBody = normalizeActor(body?.name, "");
    if (fromBody) return fromBody;

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      const name = (m.metadata as GlideMessageMetadata | undefined)?.name;
      if (typeof name === "string" && name.trim()) return normalizeActor(name, "a teammate");
      break;
    }
    return "a teammate";
  }

  // ---------------------------------------------------------------------------
  // Tools — reads run now; writes only QUEUE a pending action.
  // ---------------------------------------------------------------------------

  private buildTools(turn: ChatTurnContext): ToolSet {
    const tools = {
      // ---- READ / DISCOVERY -------------------------------------------------
      list_accounts: tool({
        description: "List Cloudflare accounts this token can see. Runs immediately.",
        inputSchema: z.object({}),
        execute: async () => {
          const credential = await this.getCredentialLease();
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!credential) return `Error: ${this.credentialUnavailableMessage()}`;
          const res = await listAccounts(credential.token);
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!this.isCredentialLeaseCurrent(credential)) return `Error: ${this.credentialSupersededMessage()}`;
          if (!res.ok) return this.readError(res, credential);
          this.noteTokenOutcome(res, credential);
          return clip(res.result.map((a: AccountSummary) => ({ id: a.id, name: a.name })));
        },
      }),

      list_zones: tool({
        description:
          "List zones (domains), optionally filtered to one account id. Runs immediately.",
        inputSchema: z.object({
          accountId: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Restrict to a single account id."),
        }),
        execute: async ({ accountId }) => {
          const credential = await this.getCredentialLease();
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!credential) return `Error: ${this.credentialUnavailableMessage()}`;
          const res = await listZones(credential.token, accountId);
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!this.isCredentialLeaseCurrent(credential)) return `Error: ${this.credentialSupersededMessage()}`;
          if (!res.ok) return this.readError(res, credential);
          this.noteTokenOutcome(res, credential);
          return clip(
            res.result.map((z: ZoneSummary) => ({ id: z.id, name: z.name, status: z.status })),
          );
        },
      }),

      find_zone: tool({
        description:
          "Resolve a zone id by its domain name and remember it as the room's default zone. Runs immediately.",
        inputSchema: z.object({ name: z.string().max(253).describe('Domain, e.g. "example.com".') }),
        execute: async ({ name }) => {
          const domain = canonicalizeDomainName(name);
          if (!domain) return `"${name}" doesn't look like a bare domain, e.g. "example.com".`;
          const defaultsRevision = this.migrationDefaultsRevision();
          const credential = await this.getCredentialLease();
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!credential) return `Error: ${this.credentialUnavailableMessage()}`;
          const res = await findZoneByName(credential.token, domain);
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!this.isCredentialLeaseCurrent(credential)) return `Error: ${this.credentialSupersededMessage()}`;
          if (!res.ok) return this.readError(res, credential);
          if (defaultsRevision !== this.migrationDefaultsRevision()) {
            return "A newer account/zone selection replaced this lookup. Run find_zone again if you still want to change it.";
          }
          this.noteTokenOutcome(res, credential);
          const accountId = res.result.account?.id;
          const zone = { id: res.result.id, name: res.result.name, accountId };
          if (accountId) {
            this.setState({ ...this.state, defaultAccountId: accountId, defaultZone: zone });
          } else {
            const { defaultAccountId: _unverifiedAccount, ...stateWithoutAccount } = this.state;
            this.setState({ ...stateWithoutAccount, defaultZone: zone });
          }
          // Capture the domain's live state (activation, SSL, WAF) so the go-live
          // checklist reflects the real zone, not just actions queued in-room.
          await this.captureLiveZoneFacts(zone.id, zone.name, res.result.status, credential);
          const activation = res.result.status === "active" ? "" : ` (status: ${res.result.status})`;
          return `Found zone ${zone.name} → ${zone.id}${activation}. Saved as the room's default zone.`;
        },
      }),

      list_dns_records: tool({
        description: "List DNS records for a zone. Runs immediately.",
        inputSchema: z.object({
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i),
          type: z.string().max(16).regex(/^[A-Za-z0-9]+$/).optional().describe('Filter by record type, e.g. "A", "CNAME".'),
        }),
        execute: async ({ zoneId, type }) => {
          const q = type ? `?type=${encodeURIComponent(type)}` : "";
          const credential = await this.getCredentialLease();
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!credential) return `Error: ${this.credentialUnavailableMessage()}`;
          const res = await cfGetAll<Record<string, unknown>>(
            `/zones/${zoneId}/dns_records${q}`,
            credential.token,
          );
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!this.isCredentialLeaseCurrent(credential)) return `Error: ${this.credentialSupersededMessage()}`;
          if (!res.ok) return this.readError(res, credential);
          this.noteTokenOutcome(res, credential);
          // Reviewing scanned DNS records completes the "review DNS records" step.
          if (this.state.onboarding?.active && !this.state.onboarding.dnsReviewed) {
            this.applyOnboardingPatch({ dnsReviewed: true }, turn.actor);
          }
          // Fold DNS proxy coverage into the live-zone snapshot so the "proxy
          // status" step ticks from the real records. Only for a full (untyped)
          // listing of the room's default zone, so a filtered or other-zone read
          // never distorts the counts.
          if (!type && this.state.defaultZone?.id === zoneId) {
            let proxiable = 0;
            let proxied = 0;
            for (const r of res.result) {
              if (r.proxiable === true) {
                proxiable += 1;
                if (r.proxied === true) proxied += 1;
              }
            }
            this.mergeLiveZone({ zoneId, proxiedRecords: proxied, proxiableRecords: proxiable });
          }
          return clip(
            res.result.map((r) => ({
              id: r.id,
              type: r.type,
              name: r.name,
              content: r.content,
              proxied: r.proxied,
            })),
          );
        },
      }),

      cf_get: tool({
        description:
          "Generic READ against Cloudflare v4 JSON REST endpoints that use the standard API envelope. Use for products without a dedicated read tool. Runs immediately and changes nothing.",
        inputSchema: z.object({
          path: z
            .string()
            .max(2_000)
            .describe('Path after https://api.cloudflare.com/client/v4, e.g. "/zones/<id>/settings".'),
        }),
        execute: async ({ path }) => {
          const canonicalPath = canonicalizeApiPath(path.startsWith("/") ? path : `/${path}`);
          if (!canonicalPath) return "Error: Invalid Cloudflare API path.";
          const credential = await this.getCredentialLease();
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!credential) return `Error: ${this.credentialUnavailableMessage()}`;
          const res = await cfGet(canonicalPath, credential.token);
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!this.isCredentialLeaseCurrent(credential)) return `Error: ${this.credentialSupersededMessage()}`;
          if (!res.ok) return this.readError(res, credential);
          this.noteTokenOutcome(res, credential);
          return clip(res.result);
        },
      }),

      // ---- MEMORY + COLLABORATION ------------------------------------------
      remember: tool({
        description:
          "Store a durable fact for this room (account id, naming conventions, preferences). Persists across restarts.",
        inputSchema: z.object({ key: z.string().min(1).max(80), value: z.string().max(2_000) }),
        execute: async ({ key, value }) => {
          const normalizedKey = key.trim();
          if (!normalizedKey || /[\u0000-\u001f\u007f]/.test(normalizedKey)) return "Memory key is invalid.";
          if (!(normalizedKey in this.state.memory) && Object.keys(this.state.memory).length >= MAX_MEMORY_ENTRIES) {
            return `Room memory is full (${MAX_MEMORY_ENTRIES} facts). Update an existing fact instead.`;
          }
          this.setState({ ...this.state, memory: { ...this.state.memory, [normalizedKey]: value.trim() } });
          return `Remembered "${normalizedKey}".`;
        },
      }),

      set_defaults: tool({
        description: "Set the room's default account id and/or default zone so users needn't repeat ids.",
        inputSchema: z.object({
          accountId: z.string().regex(/^[a-f0-9]{32}$/i).optional(),
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i).optional(),
          zoneName: z.string().max(253).optional(),
        }),
        execute: async ({ accountId, zoneId, zoneName }) => {
          const defaultsRevision = this.migrationDefaultsRevision();
          const hasZoneInput = Boolean(zoneId || zoneName);
          if (hasZoneInput && (!zoneId || !zoneName || !accountId)) {
            return "Defaults not changed: set a zone only with its account id, zone id, and zone name.";
          }
          if (zoneId && zoneName && accountId) {
            const credential = await this.getCredentialLease();
            if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
            if (!credential) return `Defaults not changed: ${this.credentialUnavailableMessage()}`;
            const resolved = await cfGet<ZoneSummary>(`/zones/${zoneId}`, credential.token);
            if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
            if (!this.isCredentialLeaseCurrent(credential)) {
              return `Defaults not changed: ${this.credentialSupersededMessage()}`;
            }
            if (!resolved.ok) return `Defaults not changed: ${this.readError(resolved, credential)}`;
            if (defaultsRevision !== this.migrationDefaultsRevision()) {
              return "Defaults not changed: a newer account/zone selection replaced this request.";
            }
            this.noteTokenOutcome(resolved, credential);
            const owner = resolved.result.account?.id;
            if (!owner || owner.toLowerCase() !== accountId.toLowerCase()) {
              return "Defaults not changed: the requested account does not own that zone.";
            }
            if (canonicalizeDomainName(resolved.result.name) !== canonicalizeDomainName(zoneName)) {
              return `Defaults not changed: zone ${zoneId} resolves to ${resolved.result.name}, not ${zoneName}.`;
            }
            this.setState({
              ...this.state,
              defaultAccountId: owner,
              defaultZone: { id: resolved.result.id, name: resolved.result.name, accountId: owner },
            });
            return "Updated the room's verified account and zone defaults.";
          }
          if (accountId) {
            const normalizedAccountId = accountId.toLowerCase();
            const defaultZone = zoneAfterAccountChange(this.state.defaultZone, normalizedAccountId);
            if (defaultZone) this.setState({ ...this.state, defaultAccountId: normalizedAccountId, defaultZone });
            else {
              const { defaultZone: _incompatibleZone, ...stateWithoutZone } = this.state;
              this.setState({ ...stateWithoutZone, defaultAccountId: normalizedAccountId });
            }
            return "Updated the room's default account; any unverified or different-account zone was cleared.";
          }
          return "Defaults not changed: provide an account id or a complete account/zone tuple.";
        },
      }),

      // ---- WRITES — these only QUEUE a pending action ----------------------
      add_domain: tool({
        description:
          "QUEUE adding a domain (zone) to Cloudflare for human approval after checking that it does not already exist. It creates a pending \"Add domain\" action a human clicks Apply to execute. Does NOT add it immediately. If you don't pass an accountId, it uses the room's default account or, when a token is available, auto-resolves it (asking you to choose only if the token sees several accounts).",
        inputSchema: z.object({
          name: z.string().max(253).describe('The domain to add, bare hostname only, e.g. "example.com" (no scheme, no path).'),
          accountId: z
            .string()
            .regex(/^[a-f0-9]{32}$/i)
            .optional()
            .describe("Account id to create the zone under. Omit to use the room default / auto-resolve."),
          setupType: z
            .enum(["full", "partial"])
            .optional()
            .describe('"full" = Cloudflare is primary DNS (default, recommended); "partial" = CNAME setup (Business/Enterprise).'),
        }),
        execute: async ({ name, accountId, setupType }) => {
          let defaultsRevision = this.migrationDefaultsRevision();
          const domain = canonicalizeDomainName(name);
          if (!domain) {
            return `"${name}" doesn't look like a domain. Give me the bare hostname, e.g. "example.com", and I'll queue it.`;
          }

          const selectedZone = this.state.defaultZone;
          const selectedZoneMatches =
            canonicalizeDomainName(selectedZone?.name ?? "") === domain;
          const credential = await this.getCredentialLease();
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (credential === undefined) {
            return `No action queued: ${this.credentialSupersededMessage()}`;
          }
          if (defaultsRevision !== this.migrationDefaultsRevision()) {
            return "No action queued: a newer account/zone selection replaced this request.";
          }
          const token = credential?.token ?? "";

          // Older persisted rooms stored only zone id/name. Resolve that zone by
          // id before considering any default account, so a stale account cannot
          // redirect a duplicate zone request into the wrong account.
          const selectedZoneIsCurrent = selectedZoneMatches;
          let selectedZoneAccountId = selectedZone?.accountId;
          // An explicit target account is authoritative. Do not let a stale
          // legacy room default block it while trying to recover provenance.
          if (selectedZone && selectedZoneMatches && !selectedZoneAccountId && token && !accountId?.trim()) {
            const resolved = await cfGet<ZoneSummary>(
              `/zones/${encodeURIComponent(selectedZone.id)}`,
              token,
            );
            if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
            if (!credential || !this.isCredentialLeaseCurrent(credential)) {
              return `No action queued: ${this.credentialSupersededMessage()}`;
            }
            if (defaultsRevision !== this.migrationDefaultsRevision()) {
              return "No action queued: a newer account/zone selection replaced this request.";
            }
            if (!resolved.ok) {
              const detail =
                resolved.category === "not_found"
                  ? "The selected zone id is no longer accessible; run find_zone again or choose the target account explicitly."
                  : this.readError(resolved, credential);
              return `No action queued: I couldn't verify the selected zone's account. ${detail}`;
            }
            if (canonicalizeDomainName(resolved.result.name) !== domain) {
              return `No action queued: the selected zone id now resolves to ${resolved.result.name}, not ${domain}. Run find_zone again.`;
            }
            selectedZoneAccountId = resolved.result.account?.id;
            if (!selectedZoneAccountId) {
              return `No action queued: Cloudflare returned ${domain} without an owning account, so I can't target zone creation safely.`;
            }
            this.setState({
              ...this.state,
              defaultAccountId: selectedZoneAccountId,
              defaultZone: {
                id: resolved.result.id,
                name: resolved.result.name,
                accountId: selectedZoneAccountId,
              },
            });
            this.noteTokenOutcome(resolved, credential);
            defaultsRevision = this.migrationDefaultsRevision();
          }

          // Resolve which account to create the zone under. Reads (listAccounts)
          // run now; the write itself is only ever QUEUED below.
          let acct =
            resolveTargetAccountId({
              explicitAccountId: accountId,
              selectedZoneMatches: selectedZoneIsCurrent,
              selectedZoneAccountId,
              defaultAccountId: this.state.defaultAccountId,
            }) ?? "";
          if (!acct) {
            if (!token) {
              return (
                `I can add **${domain}**, but I need to know which Cloudflare account it goes under, and ` +
                `there's no API token in this room yet to look that up. Add a Cloudflare API token in the ` +
                `sidebar (it's encrypted at rest) or tell me the account id, and I'll queue the domain for approval.`
              );
            }
            const res = await listAccounts(token);
            if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
            if (!credential || !this.isCredentialLeaseCurrent(credential)) {
              return `No action queued: ${this.credentialSupersededMessage()}`;
            }
            if (defaultsRevision !== this.migrationDefaultsRevision()) {
              return "No action queued: a newer account/zone selection replaced this request.";
            }
            if (!res.ok) return this.readError(res, credential);
            this.noteTokenOutcome(res, credential);
            if (res.result.length === 0) {
              return `This token can't see any Cloudflare accounts, so I can't add ${domain}. Check the token's account permissions.`;
            }
            if (res.result.length > 1) {
              const list = res.result.map((a: AccountSummary) => `${a.name} (${a.id})`).join(", ");
              return `This token can see several accounts: ${list}. Which one should **${domain}** go under? Tell me the account id and I'll queue it.`;
            }
            acct = res.result[0].id;
            const compatibleZone = zoneAfterAccountChange(this.state.defaultZone, acct);
            if (compatibleZone) this.setState({ ...this.state, defaultAccountId: acct, defaultZone: compatibleZone });
            else {
              const { defaultZone: _incompatibleZone, ...stateWithoutZone } = this.state;
              this.setState({ ...stateWithoutZone, defaultAccountId: acct });
            }
            defaultsRevision = this.migrationDefaultsRevision();
          }

          // Never queue a duplicate solely from a possibly stale default. With a
          // token, confirm against the selected account immediately before queueing.
          if (token) {
            const existing = await findZoneByName(token, domain, acct);
            if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
            if (!credential || !this.isCredentialLeaseCurrent(credential)) {
              return `No action queued: ${this.credentialSupersededMessage()}`;
            }
            if (defaultsRevision !== this.migrationDefaultsRevision()) {
              return "No action queued: a newer account/zone selection replaced this request.";
            }
            if (!existing.ok && existing.category !== "not_found") {
              return `No action queued: I couldn't safely check whether ${domain} already exists. ${this.readError(existing, credential)}`;
            }
            if (existing.ok) {
              this.noteTokenOutcome(existing, credential);
              if (selectedZone?.id !== existing.result.id || this.state.defaultAccountId !== acct) {
                this.setState({
                  ...this.state,
                  defaultAccountId: acct,
                  defaultZone: {
                    id: existing.result.id,
                    name: existing.result.name,
                    accountId: acct,
                  },
                });
              }
              return (
                `No action queued: ${domain} already exists in Cloudflare account ${acct}. ` +
                `Use list_dns_records with zone id ${existing.result.id} to review its current DNS records.`
              );
            }
            if (selectedZoneIsCurrent && (!selectedZoneAccountId || selectedZoneAccountId === acct)) {
              const { defaultZone: _staleDefault, ...nextState } = this.state;
              this.setState(nextState);
              defaultsRevision = this.migrationDefaultsRevision();
            }
          } else if (selectedZoneIsCurrent && !accountId?.trim()) {
            return (
              `No action queued: ${domain} is selected as this room's default zone, but there is no token to ` +
              "confirm whether it still exists. Add a token in Connection, then retry."
            );
          }

          if (credential && !this.isCredentialLeaseCurrent(credential)) {
            return `No action queued: ${this.credentialSupersededMessage()}`;
          }
          if (defaultsRevision !== this.migrationDefaultsRevision()) {
            return "No action queued: a newer account/zone selection replaced this request.";
          }
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          const type = setupType === "partial" ? "partial" : "full";
          return this.queuePending({
            product: "Zones",
            summary: `Add domain ${domain} (${type} setup)`,
            method: "POST",
            path: "/zones",
            body: { name: domain, account: { id: acct }, type },
          }, turn.actor, turn.queuedActions);
        },
      }),

      create_dns_record: tool({
        description:
          "QUEUE creating a DNS record for human approval. Does NOT create it — a person must click Apply.",
        inputSchema: z.object({
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i),
          type: z.string().min(1).max(16).regex(/^[A-Za-z0-9]+$/).describe('Record type, e.g. "A", "AAAA", "CNAME", "TXT", "MX".'),
          name: z.string().min(1).max(253).describe('Record name, e.g. "www" or "@" for the root.'),
          content: z.string().max(65_535).describe("Record value (IP, target hostname, text, …)."),
          ttl: z.number().int().min(1).max(2_147_483_647).optional().describe("TTL seconds; 1 means automatic."),
          proxied: z.boolean().optional().describe("Whether to proxy through Cloudflare (orange cloud)."),
          priority: z.number().int().min(0).max(65_535).optional().describe("Priority (MX/SRV only)."),
        }),
        execute: async ({ zoneId, type, name, content, ttl, proxied, priority }) => {
          const body: Record<string, unknown> = { type, name, content };
          if (ttl !== undefined) body.ttl = ttl;
          if (proxied !== undefined) body.proxied = proxied;
          if (priority !== undefined) body.priority = priority;
          return this.queuePending({
            product: "DNS",
            summary: `Create ${type} record ${name} → ${content}`,
            method: "POST",
            path: `/zones/${zoneId}/dns_records`,
            body,
            zoneId,
          }, turn.actor, turn.queuedActions);
        },
      }),

      set_zone_setting: tool({
        description:
          'QUEUE changing a zone setting (e.g. "security_level", "ssl", "always_use_https") for human approval. Does NOT apply it.',
        inputSchema: z.object({
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i),
          setting: z.string().max(80).regex(/^[a-z0-9_]+$/).describe('Setting id, e.g. "security_level".'),
          value: z.union([z.string().max(1_000), z.number().finite(), z.boolean()]).describe("New value."),
        }),
        execute: async ({ zoneId, setting, value }) => {
          return this.queuePending({
            product: "Zone settings",
            summary: `Set ${setting} = ${String(value)}`,
            method: "PATCH",
            path: `/zones/${zoneId}/settings/${setting}`,
            body: { value },
            zoneId,
          }, turn.actor, turn.queuedActions);
        },
      }),

      create_waf_custom_rule: tool({
        description:
          "QUEUE adding a WAF custom rule to a ruleset for human approval. First use cf_get on /zones/<id>/rulesets to find the http_request_firewall_custom ruleset id. Does NOT apply it.",
        inputSchema: z.object({
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i),
          rulesetId: z
            .string()
            .max(64)
            .regex(/^[a-zA-Z0-9_-]+$/)
            .describe("Id of the zone's http_request_firewall_custom entrypoint ruleset."),
          description: z.string().max(1_024),
          expression: z.string().min(1).max(16_000).describe('Wirefilter expression, e.g. ip.geoip.country eq "RU".'),
          action: z.enum(["block", "managed_challenge", "js_challenge", "log", "skip"]).describe('Action: "block", "managed_challenge", "js_challenge", "log", "skip".'),
        }),
        execute: async ({ zoneId, rulesetId, description, expression, action }) => {
          return this.queuePending({
            product: "WAF",
            summary: `${action} when ${expression} — ${description}`,
            method: "POST",
            path: `/zones/${zoneId}/rulesets/${rulesetId}/rules`,
            body: { action, expression, description, enabled: true },
            zoneId,
          }, turn.actor, turn.queuedActions);
        },
      }),

      cf_write: tool({
        description:
          "QUEUE a Cloudflare v4 JSON REST change (POST/PUT/PATCH/DELETE) for human approval. Use for products without a dedicated builder (Gateway, Access, Tunnels, Load Balancing, cache/redirect rules, …). Raw, multipart, binary, GraphQL, and nonstandard response APIs are not supported. Does NOT execute it — a human must Apply.",
        inputSchema: z.object({
          product: z.string().min(1).max(200).describe('Short product label for the UI, e.g. "Gateway", "Cache".'),
          summary: z.string().min(1).max(1_000).describe("One-line human description of the change."),
          method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
          path: z
            .string()
            .max(2_000)
            .describe('Path after https://api.cloudflare.com/client/v4, e.g. "/accounts/<id>/gateway/rules".'),
          body: z.record(z.string(), z.unknown()).optional().describe("JSON body to send."),
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Optional zone id used to group conflicting approvals safely."),
        }),
        execute: async ({ product, summary, method, path, body, zoneId }) => {
          const normalizedPath = canonicalizeApiPath(path.startsWith("/") ? path : `/${path}`);
          if (!normalizedPath) return "No action queued: the Cloudflare API path is invalid or ambiguous.";
          if (method === "POST" && normalizedPath.split("?", 1)[0].replace(/\/+$/, "") === "/zones") {
            return "No action queued: use add_domain for zone creation so Glide can resolve the account, check for an existing zone, and prevent duplicate approvals.";
          }
          return this.queuePending({
            product,
            summary,
            method: method as WriteMethod,
            path: normalizedPath,
            body,
            zoneId,
          }, turn.actor, turn.queuedActions);
        },
      }),

      // ---- ONBOARDING + MIGRATION ------------------------------------------
      update_onboarding: tool({
        description:
          "Start or update the room's guided onboarding: record the path (migrate vs fresh), domain, DNS setup, provider being migrated from, goals, and check off completed steps. Mirrors the UI wizard — only fill in what the user told you and don't re-ask what's already captured below.",
        inputSchema: z.object({
          path: z
            .enum(["migrate", "fresh"])
            .optional()
            .describe("Migrate from an existing provider, or start fresh on Cloudflare."),
          domain: z.string().max(MAX_ONBOARDING_DOMAIN_CHARS).optional().describe('Domain(s) being onboarded, e.g. "example.com".'),
          setupType: z
            .enum(["full", "partial", "unsure"])
            .optional()
            .describe("Full (primary) DNS, Partial (CNAME), or undecided."),
          migratingFrom: z.string().max(80).optional().describe('Provider key being migrated from, e.g. "akamai".'),
          goals: z
            .array(z.string().max(64))
            .max(20)
            .optional()
            .describe('What to migrate/set up, e.g. ["dns","waf","cache","load_balancing"].'),
          checkOff: z
            .array(z.string().max(32))
            .max(20)
            .optional()
            .describe('Checklist step ids to mark done, e.g. ["domain","setup","scan"].'),
        }).strict(),
        execute: async ({ path, domain, setupType, migratingFrom, goals, checkOff }) => {
          const next = this.applyOnboardingPatch(
            { path, domain, setupType: setupType as SetupType | undefined, migratingFrom, goals, checkOff },
            turn.actor,
          );
          const done = next.checklist.filter((s) => s.done).length;
          const nextStep = next.checklist.find((s) => !s.done);
          const status = nextStep
            ? `The next step is "${nextStep.label}".`
            : next.checklist.length
              ? "Every step is now complete 🎉."
              : "";
          const who = turn.actor;
          return `Onboarding state saved (${done}/${next.checklist.length} steps done). ${status} Now reply to ${who} in plain conversational prose: confirm in a sentence what you just recorded, briefly explain this step, and ask the single next question to keep things moving. Do NOT emit JSON or call another tool unless their next answer actually requires one.`;
        },
      }),

      update_business_profile: tool({
        description:
          "Record answers to the 'nature of the business' discovery questions (industry, app type, audience, traffic, whether users log in, whether an API is exposed, sensitive data, compliance, and top concerns). Call this as you learn each answer — it feeds the recommendation engine. It ONLY stores context; it changes nothing on the account. Pass only what the user told you; arrays you pass REPLACE the stored ones, so include prior values you still want to keep.",
        inputSchema: z
          .object({
            industry: z
              .enum([
                "ecommerce",
                "saas",
                "fintech",
                "healthcare",
                "media",
                "gaming",
                "government",
                "education",
                "nonprofit",
                "marketing",
                "api_platform",
                "other",
              ])
              .optional()
              .describe("Industry/vertical."),
            appTypes: z
              .array(z.enum(["website", "web_app", "api", "mobile_backend", "static_site", "ugc"]))
              .max(6)
              .optional()
              .describe("Kinds of app the team runs."),
            audience: z.enum(["global", "regional", "internal"]).optional().describe("Who the app serves."),
            trafficProfile: z
              .enum(["low", "steady", "spiky", "high_volume"])
              .optional()
              .describe("Rough traffic scale / spikiness."),
            hasLogin: z.boolean().optional().describe("Whether the app has user login / authentication."),
            hasApi: z.boolean().optional().describe("Whether the team exposes an API."),
            cacheableContent: z.boolean().optional().describe("Whether a meaningful share of content is static/cacheable."),
            sensitiveData: z
              .array(z.enum(["pii", "payments", "health", "credentials", "financial"]))
              .max(5)
              .optional()
              .describe("Sensitive data handled."),
            compliance: z
              .array(z.enum(["pci_dss", "hipaa", "gdpr", "soc2", "iso27001", "fedramp"]))
              .max(6)
              .optional()
              .describe("Compliance regimes in scope."),
            concerns: z
              .array(
                z.enum([
                  "bots",
                  "ddos",
                  "scraping",
                  "credential_stuffing",
                  "card_testing",
                  "fraud",
                  "latency",
                  "downtime",
                  "cost",
                ]),
              )
              .max(9)
              .optional()
              .describe("Top concerns / threats the team named."),
            notes: z.string().max(MAX_PROFILE_NOTES_CHARS).optional().describe("Freeform note that doesn't fit a field."),
          })
          .strict(),
        execute: async (input) => {
          // Union arrays with what's already captured so a partial tool call can
          // never drop earlier answers (models are inconsistent about resending
          // the full set), then persist with the low-level replace setter.
          const cur = this.state.businessProfile ?? EMPTY_BUSINESS_PROFILE;
          const merge = (base: string[], extra?: string[]) =>
            extra?.length ? Array.from(new Set([...base, ...extra])) : undefined;
          const next = this.applyBusinessProfilePatch(
            {
              ...input,
              appTypes: merge(cur.appTypes, input.appTypes),
              sensitiveData: merge(cur.sensitiveData, input.sensitiveData),
              compliance: merge(cur.compliance, input.compliance),
              concerns: merge(cur.concerns, input.concerns),
            },
            turn.actor,
          );
          const missing = recommendConfigurations(next, {
            goals: this.state.onboarding?.goals,
            setupType: this.state.onboarding?.setupType,
          }).missing;
          const nextQ = missing.length
            ? `Still unknown: ${missing.slice(0, 3).join("; ")}. Ask ONE of these next.`
            : "The profile is well-rounded — you can call recommend_configuration now.";
          return `Business profile saved. ${nextQ} Reply to the room in one or two plain sentences: confirm what you noted and ask the single next question (or, if enough is captured, offer tailored recommendations). Do NOT dump JSON.`;
        },
      }),

      recommend_configuration: tool({
        description:
          "Turn the captured business profile into tailored Cloudflare performance/security/reliability recommendations. READ-ONLY: it proposes settings and rules but queues nothing. Call it once you've learned enough about the business (or when the user asks 'what should I turn on?'). Then present the relevant items grouped by theme, explain why each fits, and offer to QUEUE the important ones via the builder tools (set_zone_setting, create_waf_custom_rule, cf_write).",
        inputSchema: z
          .object({
            focus: z
              .enum(["all", "security", "performance", "reliability", "privacy", "bots", "api", "tls"])
              .optional()
              .describe("Optionally narrow the recommendations to one theme."),
          })
          .strict(),
        execute: async ({ focus }) => {
          const profile = this.state.businessProfile;
          if (!profile || (!profile.industry && !profile.appTypes.length && !profile.concerns.length && !profile.compliance.length && !profile.sensitiveData.length)) {
            const missing = recommendConfigurations(profile, {}).missing;
            return `No business profile captured yet, so recommendations would be generic. First ask a couple of the discovery questions (one at a time) — e.g. ${missing.slice(0, 3).join("; ")} — record them with update_business_profile, then call this again.`;
          }
          const set = recommendConfigurations(profile, {
            goals: this.state.onboarding?.goals,
            setupType: this.state.onboarding?.setupType,
          });
          const filtered =
            focus && focus !== "all"
              ? { ...set, recommendations: set.recommendations.filter((r) => r.category === focus) }
              : set;
          return clip(formatRecommendationsForModel(filtered));
        },
      }),

      security_posture: tool({
        description:
          "Grade the room's default zone's LIVE Cloudflare security configuration into an A–F scorecard: SSL/TLS mode, Always-Use-HTTPS, minimum TLS version, TLS 1.3, HSTS, Managed WAF, DNSSEC, and DNS proxy coverage. READ-ONLY — it reads the zone's real settings and changes nothing, but surfaces concrete one-click fixes the user can QUEUE (a human still Applies them). Requires a default zone (run find_zone first) and a connected API token. Use when the user asks things like 'how secure is my site', 'what's my security grade', or 'what should I fix'. The scorecard also appears in the sidebar.",
        inputSchema: z.object({}).strict(),
        execute: async () => {
          const res = await this.computeSecurityPosture(turn.actor, () => this.isChatTurnAccessCurrent(turn));
          if (!res.ok) return `Error: ${res.message}`;
          let text = formatPostureForModel(res.report);
          if (res.drift?.drifted) text += `\n\n---\n${formatDriftForModel(res.drift)}`;
          return clip(text);
        },
      }),

      estimate_impact: tool({
        description:
          "Preview the BLAST RADIUS of a queued change before anyone Applies it — how much of the zone's real last-24h traffic it would touch (most precise for country-scoped WAF / rate-limit rules, where per-country volume is known). READ-ONLY. Optionally pass a pending action id; otherwise the most recently queued action is assessed. Use when the user asks 'what would this affect', 'how many users', or 'is this safe to apply'.",
        inputSchema: z.object({ actionId: z.string().max(100).optional() }).strict(),
        execute: async ({ actionId }) => {
          const pending = this.state.pendingActions;
          if (!pending.length) return "There are no queued changes to assess.";
          const action = actionId ? pending.find((a) => a.id === actionId) : pending[pending.length - 1];
          if (!action) return `No queued action with id ${actionId}.`;
          const res = await this.blastRadiusForAction(action, () => this.isChatTurnAccessCurrent(turn));
          if (!res.ok) return `Error: ${res.message}`;
          const signals = res.estimate.signals.length ? `\nSignals: ${res.estimate.signals.join("; ")}` : "";
          return clip(`${action.summary}\n${formatBlastRadius(res.estimate)}${signals}`);
        },
      }),

      list_migration_providers: tool({
        description:
          "List the providers the migration tool can parse (Akamai, Fastly, Imperva, Zscaler ZIA/ZPA, Prisma Access, Cisco Umbrella, Proofpoint, Akamai EAA) and their phases. Read-only.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await listMigrationProviders(this.migrationTransport());
          if (!res.ok) return `Error: ${res.message}`;
          return clip(
            res.result.providers.map((p) => ({
              key: p.key,
              label: p.label,
              category: p.category,
              phases: p.phases.length,
            })),
          );
        },
      }),

      preview_provider_migration: tool({
        description:
          "READ-ONLY: translate an existing provider config into Cloudflare-equivalent rules and store a migration plan for the room. Changes nothing. Give the provider key plus the exported config as inline `config` text; JSON, XML, Terraform, and PAN-OS are supported.",
        inputSchema: z.object({
          provider: z
            .string()
            .max(64)
            .regex(/^[a-z0-9][a-z0-9_-]*$/)
            .describe('Provider key from list_migration_providers, e.g. "akamai", "fastly", "imperva".'),
          config: z
            .string()
            .max(MAX_CONFIG_BYTES)
            .optional()
            .describe("The exported provider config as text (JSON/XML/Terraform/PAN-OS)."),
          format: z
            .enum(["json", "xml", "terraform", "panos", "auto"])
            .optional()
            .describe("Config format; defaults to auto-detect."),
        }),
        execute: async ({ provider, config, format }) => {
          if (!migrationConfigured(this.migrationTransport())) return this.notConfigured();
          const resolved = await this.resolveConfigData({ config, format });
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!resolved.ok) return `Error: ${resolved.message}`;

          const normalizedProvider = provider.trim().toLowerCase();
          const res = await this.runPreview(
            normalizedProvider,
            resolved.data,
            turn.actor,
            () => this.isChatTurnAccessCurrent(turn),
          );
          if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
          if (!res.ok) return `Error from migration tool: ${res.message}`;
          this.applyOnboardingPatch(
            { configProvided: true, migratingFrom: normalizedProvider, checkOff: ["preview"] },
            turn.actor,
          );

          const retained = res.plan.truncated
            ? ` Only ${res.plan.rules.length} items fit in the review plan; queueing covers that subset, while Terraform export uses the complete stored source.`
            : "";
          return `Parsed ${res.plan.totalRules} item(s) from ${res.plan.providerLabel} (read-only, nothing changed). Phases — ${
            res.phaseSummary || "none"
          }. Saved as the room's migration plan.${retained} Next: queue supported rules with \`queue_migration_rules\` (needs a zone id), or export Terraform with \`generate_migration_terraform\`.`;
        },
      }),

      queue_migration_rules: tool({
        description:
          "QUEUE the supported rules retained in the room's migration plan as pending actions for human Apply: WAF custom rules, IP/geo access, rate limiting, redirects, cache, origin, request/response header transforms, and zone/SSL settings. A truncated plan queues only its visible subset; use Terraform export for the complete config. Redirect/cache/origin/header mappings are best-effort and flagged 'review before Apply'. Run preview_provider_migration first. Does NOT apply anything; anything it can't build is reported for Terraform export.",
        inputSchema: z.object({
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i).describe("Target Cloudflare zone id for the migrated rules."),
          phases: z
            .array(z.string().max(128))
            .max(100)
            .optional()
            .describe("Optional subset of phase keys to queue (default: all supported)."),
        }),
        execute: async ({ zoneId, phases }) => this.queueMigrationRules(zoneId, phases, turn),
      }),

      generate_migration_terraform: tool({
        description:
          "READ-ONLY: generate Terraform (Infrastructure-as-Code) for the migration plan — ideal for phases best managed via IaC, or teams who prefer Terraform. Reuses the last previewed config unless you pass a new one. The room downloads it from the Migration panel.",
        inputSchema: z.object({
          provider: z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]*$/).optional().describe("Provider key; defaults to the last previewed provider."),
          config: z.string().max(MAX_CONFIG_BYTES).optional().describe("Override config text (otherwise reuses the last preview)."),
          format: z.enum(["json", "xml", "terraform", "panos", "auto"]).optional(),
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Zone id to embed; defaults to the room's default zone."),
          accountId: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Account id to embed; defaults to the room's default account."),
          zoneName: z.string().max(253).optional(),
        }),
        execute: async (args) => this.generateTerraform(
          args,
          turn.actor,
          () => this.isChatTurnAccessCurrent(turn),
        ),
      }),

      migration_preflight: tool({
        description:
          "READ-ONLY: check whether the configured Cloudflare API token has the permissions the migration plan's provider needs (per phase). Probes endpoints without creating anything. Run after preview_provider_migration.",
        inputSchema: z.object({
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Target zone id; defaults to the room's default zone."),
        }),
        execute: async ({ zoneId }) => (await this.doPreflight(
          zoneId,
          turn.actor,
          () => this.isChatTurnAccessCurrent(turn),
        )).summary,
      }),

      migration_diff_report: tool({
        description:
          "READ-ONLY: compare the target Cloudflare zone's current state against the migration — shows what already exists per phase (migration-owned vs manually-created), plus IP lists and load balancers. Helps avoid surprises before queueing.",
        inputSchema: z.object({
          zoneId: z.string().regex(/^[a-f0-9]{32}$/i).optional().describe("Target zone id; defaults to the room's default zone."),
        }),
        execute: async ({ zoneId }) => (await this.doDiff(
          zoneId,
          turn.actor,
          () => this.isChatTurnAccessCurrent(turn),
        )).summary,
      }),

      export_migration_csv: tool({
        description:
          "READ-ONLY: export the migration plan's config as CSV (one row per rule/resource). Reuses the last previewed config unless you pass a new one. The room downloads it from the Migration panel.",
        inputSchema: z.object({
          provider: z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]*$/).optional().describe("Provider key; defaults to the last previewed provider."),
          config: z.string().max(MAX_CONFIG_BYTES).optional().describe("Override config text (otherwise reuses the last preview)."),
          format: z.enum(["json", "xml", "terraform", "panos", "auto"]).optional(),
        }),
        execute: async (args) => (await this.doExportCsv(
          args,
          turn.actor,
          () => this.isChatTurnAccessCurrent(turn),
        )).message,
      }),

    } satisfies ToolSet;

    type ExecutableTool = { execute?: (...args: unknown[]) => unknown };
    for (const definition of Object.values(tools)) {
      const executable = definition as ExecutableTool;
      const execute = executable.execute;
      if (!execute) continue;
      executable.execute = async (...args) => {
        if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
        const result = await execute(...args);
        return this.isChatTurnAccessCurrent(turn) ? result : this.chatTurnAccessError();
      };
    }
    return tools;
  }

  /** Turn a failed read into a friendly, model-readable line (with a permission hint when relevant). */
  private readError(
    res: { message: string; hint?: string; category?: string },
    credential: CredentialLease,
  ): string {
    if (!this.isCredentialLeaseCurrent(credential)) return `Error: ${this.credentialSupersededMessage()}`;
    this.noteTokenOutcome(res, credential);
    return res.hint
      ? `Error: ${res.message} (likely missing token permission: ${res.hint})`
      : `Error: ${res.message}`;
  }

  /**
   * Keep the synced `tokenValid` flag honest as the token is actually used.
   * A successful authenticated read proves the token works; a 401 (`auth`)
   * proves it doesn't. Everything else — a permission gap (e.g. the token can
   * list zones but lacks DNS edit), a 404, a transient 5xx — says nothing about
   * the token's validity, so we leave the flag alone. This self-corrects a
   * stale "token unverified" badge without the user re-entering the token, and
   * never flips a working token to "unverified" just because one specific
   * action lacked a scope.
   */
  private noteTokenOutcome(res: { ok?: boolean; category?: string }, credential: CredentialLease): void {
    if (!this.isCredentialLeaseCurrent(credential)) return;
    const next = res.ok === true ? true : res.category === "auth" ? false : undefined;
    if (next !== undefined && this.state.tokenValid !== next) {
      this.setState({ ...this.state, tokenValid: next });
    }
  }

  /** Build a PendingAction (id/createdBy/ts filled in) without touching state. */
  private newPending(
    input: Omit<PendingAction, "id" | "ts" | "createdBy" | "status" | "error" | "attemptedAt">,
    createdBy = "a teammate",
  ): PendingAction {
    return {
      ...input,
      id: crypto.randomUUID(),
      createdBy,
      status: "pending",
      ts: Date.now(),
    };
  }

  /** Append a pending action to synced state and return the model-facing confirmation. */
  private queuePending(
    input: Omit<PendingAction, "id" | "ts" | "createdBy" | "status" | "error" | "attemptedAt">,
    createdBy = "a teammate",
    trackedActions?: PendingAction[],
  ): string {
    if (this.state.pendingActions.length >= MAX_PENDING_ACTIONS) {
      return `No action queued: this room already has ${MAX_PENDING_ACTIONS} pending approvals. Apply or reject one first.`;
    }
    const path = canonicalizeApiPath(input.path);
    if (!path) return "No action queued: the Cloudflare API path is invalid or ambiguous.";
    const pathZoneId = zoneIdFromApiPath(path);
    if (pathZoneId && input.zoneId && input.zoneId.toLowerCase() !== pathZoneId.toLowerCase()) {
      return "No action queued: the zone id does not match the Cloudflare API path.";
    }
    const normalizedInput = { ...input, path, ...(pathZoneId ? { zoneId: pathZoneId } : {}) };
    const zoneTarget = zoneCreationIdentity(normalizedInput);
    const approvalIdentity = actionApprovalIdentity(normalizedInput);
    const duplicate = this.state.pendingActions.find((action) =>
      zoneTarget
        ? zoneCreationIdentity(action) === zoneTarget
        : approvalIdentity !== undefined && actionApprovalIdentity(action) === approvalIdentity,
    );
    if (duplicate) {
      const status = pendingActionStatus(duplicate);
      const nextStep = isActionApplying(duplicate)
        ? "It is currently being applied."
        : isActionOutcomeUncertain(duplicate)
          ? "Its outcome is uncertain; verify the live zone before retrying that approval individually."
          : status === "failed"
            ? "It previously failed; review the error and Retry that approval instead."
            : "Review or Apply the existing approval instead.";
      const label = zoneTarget ? "this Add domain approval" : "an identical approval";
      return `No action queued: ${label} already exists (pending id: ${duplicate.id}). ${nextStep}`;
    }
    const action = this.newPending(normalizedInput, createdBy);
    const validationError = pendingActionValidationError(action);
    if (validationError) return `No action queued: ${validationError}`;
    const nextState = { ...this.state, pendingActions: [...this.state.pendingActions, action] };
    const stateError = syncedStateSizeError(nextState);
    if (stateError) return `No action queued: ${stateError}`;
    this.setState(nextState);
    this.recordAudit("queue", createdBy, action.id, action.summary);
    trackedActions?.push(action);
    // Queueing a change may satisfy a go-live step (e.g. an SSL setting, a WAF
    // rule, a DNS record) — reflect that on the checklist immediately.
    this.recomputeOnboardingChecklist();
    const tokenNote = this.state.tokenConfigured
      ? ""
      : " No Cloudflare API token is connected yet, so Apply is blocked until someone adds one in Connection > Set token.";
    return `Queued for approval ✅ — ${action.summary}. This has NOT run yet; a human in the room must click **Apply** to execute it.${tokenNote} (pending id: ${action.id})`;
  }

  /** Render queue narration from server-created actions, never from model claims. */
  private authoritativeQueueNarration(
    prose: string,
    queuedActions: readonly PendingAction[],
    notices: readonly string[] = [],
  ): string {
    if (!queuedActions.length) return queueClaimCorrection(this.state, prose);

    const pendingById = new Map(this.state.pendingActions.map((action) => [action.id, action]));
    const resultById = new Map<string, ActionResult>();
    for (const result of this.state.recentResults) {
      if (!resultById.has(result.id)) resultById.set(result.id, result);
    }
    const ready: string[] = [];
    const applying: string[] = [];
    const failed: string[] = [];
    const finished: string[] = [];

    for (const created of queuedActions) {
      const pending = pendingById.get(created.id);
      if (pending) {
        const status = pendingActionStatus(pending);
        if (status === "failed") failed.push(pending.summary);
        else if (status === "applying") applying.push(pending.summary);
        else ready.push(pending.summary);
        continue;
      }
      const result = resultById.get(created.id);
      if (result) finished.push(`${result.summary} (${result.status})`);
    }

    const lines: string[] = [];
    if (ready.length) {
      lines.push(
        `Queued for approval: ${ready.join("; ")}. ${ready.length === 1 ? "It is" : "They are"} visible in Pending approvals; click Apply to execute ${ready.length === 1 ? "it" : "them"}.`,
      );
    }
    if (applying.length) lines.push(`Applying now: ${applying.join("; ")}.`);
    if (failed.length) lines.push(`Apply failed and remains available for Retry: ${failed.join("; ")}.`);
    if (finished.length) lines.push(`Action result: ${finished.join("; ")}.`);
    if (lines.length) return [...lines, ...notices].join(" ");

    return (
      `The server created ${queuedActions.map((action) => action.summary).join("; ")}, ` +
      "but it is no longer awaiting approval. Refresh the room before taking another action."
    );
  }

  /** Deterministic recovery for a model promise that did not execute a tool. */
  private unfulfilledActionNarration(): string {
    if (this.state.onboarding?.active && this.state.onboarding.path && !this.state.onboarding.domain) {
      // Early onboarding: nothing "failed to run" — we simply still need the
      // domain before any action is possible. Keep it warm and forward-moving.
      return "Let's start with your domain — which domain would you like to onboard to Cloudflare? (for example, example.com)";
    }
    if (this.state.tokenValid === false) {
      return (
        "That step did not run. The saved Cloudflare API token failed verification; review or replace it " +
        "in Connection > Change, then retry the request."
      );
    }
    if (!this.state.tokenConfigured) {
      return (
        "That step did not run. Add a Cloudflare API token in Connection > Set token, or provide the " +
        "target account id, then retry the request."
      );
    }
    return (
      "That step did not run. Please retry the request; a change is ready only after it appears in " +
      "Pending approvals."
    );
  }

  // ---------------------------------------------------------------------------
  // Migration helpers — read provider config, queue rules, export Terraform.
  // ---------------------------------------------------------------------------

  /** Resolve how to reach the migration tool: service binding first, URL fallback. */
  private migrationTransport(): MigrationTransport {
    return { fetcher: this.env.MIGRATION, baseUrl: this.env.MIGRATION_API_URL };
  }

  private notConfigured(): string {
    return "Migration import isn't configured. Bind the Switchflare Worker to Glide (a `MIGRATION` service binding) or set MIGRATION_API_URL.";
  }

  /** Bind display-label responses to the provider registry when no preview plan supplies the label. */
  private async migrationProviderLabel(provider: string, plan?: MigrationPlan): Promise<string | undefined> {
    if (plan?.provider === provider) return plan.providerLabel;
    const listed = await listMigrationProviders(this.migrationTransport());
    if (!listed.ok) return undefined;
    return listed.result.providers.find((candidate) => candidate.key === provider)?.label;
  }

  /** Resolve uploaded files or inline text into the migration tool's payload shape. */
  private async resolveConfigData(args: {
    config?: string;
    configFiles?: Array<{ filename: string; content: string }>;
    format?: MigrationConfigFormat;
  }): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, message: "Migration config input must be an object." };
    }
    if (args.config !== undefined && typeof args.config !== "string") {
      return { ok: false, message: "Inline config must be text." };
    }
    if (
      args.format !== undefined &&
      !(["json", "xml", "terraform", "panos", "auto"] as unknown[]).includes(args.format)
    ) {
      return { ok: false, message: "Config format is unsupported." };
    }
    if (args.configFiles !== undefined && !Array.isArray(args.configFiles)) {
      return { ok: false, message: "Uploaded configs must be a file list." };
    }
    const inlineSizeError = args.config ? configSizeError(args.config) : undefined;
    if (inlineSizeError) return { ok: false, message: inlineSizeError };
    const configFiles = args.configFiles ?? [];
    if (configFiles.length > MAX_CONFIG_FILES) {
      return { ok: false, message: `Too many config files (${configFiles.length}; max ${MAX_CONFIG_FILES}).` };
    }
    for (const file of configFiles) {
      if (!file || typeof file.filename !== "string" || typeof file.content !== "string") {
        return { ok: false, message: "Every uploaded config file needs a filename and text content." };
      }
      if (!file.filename || /[\u0000-\u001f\u007f/\\]/.test(file.filename)) {
        return { ok: false, message: "Config filenames cannot contain paths or control characters." };
      }
    }
    const filesSizeError = configFilesSizeError(configFiles);
    if (filesSizeError) return { ok: false, message: filesSizeError };
    // Multiple uploaded Terraform files → the migration tool parses + merges them.
    const tfFiles = configFiles.filter((f) => f.content.trim());
    if (tfFiles.length > 1) {
      return {
        ok: true,
        data: { __raw_tf_files: tfFiles.map(({ filename, content }) => ({ filename, content })) },
      };
    }
    // A single uploaded file is treated like pasted text (format inferred upstream).
    if (tfFiles.length === 1 && !args.config) {
      const built = buildConfigData(tfFiles[0].content, args.format ?? "auto", tfFiles[0].filename);
      if (!built.ok) return { ok: false, message: built.message };
      return { ok: true, data: built.data };
    }

    let raw = args.config?.trim();
    if (!raw) {
      return {
        ok: false,
        message: "Upload the exported config or provide it inline as `config`.",
      };
    }
    const built = buildConfigData(raw, args.format ?? "auto");
    if (!built.ok) return { ok: false, message: built.message };
    return { ok: true, data: built.data };
  }

  /**
   * Run a read-only provider-config preview: parse it, persist the raw source
   * (for Terraform reuse), and store the migration plan in synced state.
   */
  private async runPreview(
    provider: string,
    configData: unknown,
    actor = "a teammate",
    isAuthorized: () => boolean = () => true,
  ): Promise<{ ok: true; plan: MigrationPlan; phaseSummary: string } | { ok: false; message: string }> {
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the migration preview started." };
    if (!validMigrationProviderKey(provider)) return { ok: false, message: "Invalid migration provider key." };
    const serializedSource = serializeMigrationSource(configData);
    if (!serializedSource.ok) return serializedSource;
    const generation = ++this.migrationPreviewGeneration;
    const res = await previewProviderMigration(this.migrationTransport(), provider, configData);
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the migration preview completed." };
    if (generation !== this.migrationPreviewGeneration) {
      return { ok: false, message: "A newer migration preview replaced this request." };
    }
    if (!res.ok) return { ok: false, message: res.message };

    const dto = res.result;
    const previewError = migrationPreviewValidationError(dto, provider, MAX_MIGRATION_PREVIEW_RULES);
    if (previewError) return { ok: false, message: previewError };
    const sourceRevision = crypto.randomUUID();
    const createdAt = Date.now();
    let boundedRules = boundedMigrationPreviewRules(dto.rules, MAX_PLAN_RULES).rules;
    const toPlanRules = (): MigrationPlanRule[] => boundedRules.map((r) => ({
      name: r.name,
      type: r.type,
      phase: r.phase,
      phaseLabel: r.phaseLabel,
      action: r.action,
      detail: r.detail,
      expression: r.expression,
    }));
    const toPlan = (): MigrationPlan => ({
      provider: dto.provider,
      providerLabel: dto.providerLabel,
      totalRules: dto.totalRules,
      phases: dto.phases,
      rules: toPlanRules(),
      truncated: boundedRules.length < dto.totalRules,
      sourceRevision,
      createdBy: actor,
      ts: createdAt,
    });
    const ob = this.state.onboarding;
    const nextOb = ob
      ? {
          ...ob,
          migratingFrom: provider,
          migratingFromLabel: dto.providerLabel,
          checklist: ob.checklist.map((step) => step.id === "migrate" ? { ...step, done: false } : step),
        }
      : undefined;
    const {
      terraform: _staleTerraform,
      csv: _staleCsv,
      migrationCheck: _staleCheck,
      ...stateWithoutPlanArtifacts
    } = this.state;
    let plan = toPlan();
    let nextState = {
      ...stateWithoutPlanArtifacts,
      migrationPlan: plan,
      ...(nextOb ? { onboarding: nextOb } : {}),
    };
    let stateError = syncedStateSizeError(nextState);
    while (stateError && boundedRules.length) {
      boundedRules = boundedRules.slice(0, Math.floor(boundedRules.length / 2));
      plan = toPlan();
      nextState = { ...stateWithoutPlanArtifacts, migrationPlan: plan, ...(nextOb ? { onboarding: nextOb } : {}) };
      stateError = syncedStateSizeError(nextState);
    }
    if (stateError) return { ok: false, message: stateError };
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the migration preview could be saved." };
    this.saveMigrationSource(sourceRevision, provider, serializedSource.data);
    this.setState(nextState);
    this.sql`DELETE FROM glide_migration_src WHERE id <> ${sourceRevision}`;

    const phaseSummary = dto.phases.map((p) => `${p.label}: ${p.count}`).join("; ");
    return { ok: true, plan, phaseSummary };
  }

  /**
   * Convert the room's migration plan into pending actions for the rule types
   * Glide can faithfully express as a single Cloudflare API call. WAF custom
   * rules and rate-limit rules are merged into their phase entrypoint (existing
   * rules preserved when a token is available); zone settings become PATCHes.
   * Everything else is reported as needing Terraform/manual review.
   */
  private async queueMigrationRules(
    zoneId: string,
    phases: string[] | undefined,
    turn: ChatTurnContext,
  ): Promise<string> {
    if (typeof zoneId !== "string" || !/^[a-f0-9]{32}$/i.test(zoneId)) {
      return "No action queued: a valid target zone id is required.";
    }
    if (
      phases !== undefined &&
      (!Array.isArray(phases) ||
        phases.length > 100 ||
        phases.some((phase) => typeof phase !== "string" || phase.length > 128))
    ) {
      return "No action queued: migration phases are invalid.";
    }
    const plan = this.state.migrationPlan;
    if (!plan) return "No migration plan yet. Run preview_provider_migration first.";
    if (this.state.onboarding?.migratingFrom && this.state.onboarding.migratingFrom !== plan.provider) {
      return "No action queued: the selected migration provider changed. Preview its config before queueing rules.";
    }

    const want = phases && phases.length ? new Set(phases) : null;
    const inScope = (phase: string) => !want || want.has(phase);

    const credential = await this.getCredentialLease();
    if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
    if (credential === undefined) {
      return `Nothing queued: ${this.credentialSupersededMessage()}`;
    }
    if (this.state.migrationPlan !== plan) {
      return "Nothing queued: the migration preview changed while rules were being prepared. Review the latest plan and retry.";
    }
    const token = credential?.token ?? "";
    const newActions: PendingAction[] = [];
    const queuedIdx = new Set<number>();
    const skipped: string[] = [];

    // --- WAF custom rules + IP/geo access controls → http_request_firewall_custom ---
    const wafRules: Record<string, unknown>[] = [];
    const wafIdx: number[] = [];
    plan.rules.forEach((r, i) => {
      if (r.queued || (r.type !== "waf_custom" && r.type !== "access_control") || !inScope(r.phase)) return;
      if (!r.expression) {
        skipped.push(`${r.name} (no expression — export via Terraform)`);
        return;
      }
      const mappedAction = mapWafActionToCf(r.action);
      if (!mappedAction) {
        skipped.push(`${r.name} (unknown WAF action — export via Terraform)`);
        return;
      }
      const { action, action_parameters } = mappedAction;
      const rule: Record<string, unknown> = {
        action,
        expression: r.expression,
        description: r.name.slice(0, 1024),
        enabled: true,
      };
      if (action_parameters) rule.action_parameters = action_parameters;
      wafRules.push(rule);
      wafIdx.push(i);
    });
    if (wafRules.length) {
      const merged = await this.mergeEntrypointRules(
        zoneId,
        "http_request_firewall_custom",
        wafRules,
        token,
      );
      if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
      if (credential && !this.isCredentialLeaseCurrent(credential)) {
        return `Nothing queued: ${this.credentialSupersededMessage()}`;
      }
      if (this.state.migrationPlan !== plan) {
        return "Nothing queued: the migration preview changed while rules were being prepared. Review the latest plan and retry.";
      }
      newActions.push(
        this.newPending({
          product: "WAF",
          summary: `Add ${wafRules.length} WAF custom rule(s) from ${plan.providerLabel}${merged.note}`,
          method: "PUT",
          path: `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
          body: { rules: merged.rules },
          mergeEntrypoint: { phase: "http_request_firewall_custom", newRules: wafRules },
          zoneId,
        }, turn.actor),
      );
      wafIdx.forEach((i) => queuedIdx.add(i));
    }

    // --- Rate limiting → http_ratelimit ---
    const rlRules: Record<string, unknown>[] = [];
    const rlIdx: number[] = [];
    plan.rules.forEach((r, i) => {
      if (r.queued || r.type !== "rate_limit" || !inScope(r.phase)) return;
      const parsed = parseRateLimit(r.detail);
      const mappedAction = mapWafActionToCf(r.action);
      if (!parsed || !mappedAction || mappedAction.action === "skip" || !r.expression) {
        skipped.push(`${r.name} (incomplete rate-limit mapping — export via Terraform)`);
        return;
      }
      const action = mappedAction.action;
      rlRules.push({
        action,
        expression: r.expression,
        description: r.name.slice(0, 1024),
        enabled: true,
        ratelimit: {
          characteristics: ["ip.src", "cf.colo.id"],
          period: parsed.period,
          requests_per_period: parsed.requests,
          mitigation_timeout: parsed.period,
        },
      });
      rlIdx.push(i);
    });
    if (rlRules.length) {
      const merged = await this.mergeEntrypointRules(zoneId, "http_ratelimit", rlRules, token);
      if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
      if (credential && !this.isCredentialLeaseCurrent(credential)) {
        return `Nothing queued: ${this.credentialSupersededMessage()}`;
      }
      if (this.state.migrationPlan !== plan) {
        return "Nothing queued: the migration preview changed while rules were being prepared. Review the latest plan and retry.";
      }
      newActions.push(
        this.newPending({
          product: "Rate limiting",
          summary: `Add ${rlRules.length} rate-limit rule(s) from ${plan.providerLabel}${merged.note}`,
          method: "PUT",
          path: `/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`,
          body: { rules: merged.rules },
          mergeEntrypoint: { phase: "http_ratelimit", newRules: rlRules },
          zoneId,
        }, turn.actor),
      );
      rlIdx.forEach((i) => queuedIdx.add(i));
    }

    // --- Additional ruleset phases (#4): redirects, cache, origin, headers ---
    // Best-effort: some fields are approximate, so these are flagged for review.
    const extraBuckets: Array<{
      phase: string;
      product: string;
      types: string[];
      build: (r: MigrationPlanRule) => BuildOut;
    }> = [
      { phase: "http_request_dynamic_redirect", product: "Redirects", types: ["redirect"], build: buildRedirectRule },
      { phase: "http_request_cache_settings", product: "Cache", types: ["cache"], build: buildCacheRule },
      { phase: "http_request_origin", product: "Origin", types: ["origin"], build: buildOriginRule },
      { phase: "http_request_late_transform", product: "Request headers", types: ["request_header"], build: buildHeaderRule },
      { phase: "http_response_headers_transform", product: "Response headers", types: ["response_header"], build: buildHeaderRule },
    ];
    for (const bucket of extraBuckets) {
      const builtRules: Record<string, unknown>[] = [];
      const bucketIdx: number[] = [];
      plan.rules.forEach((r, i) => {
        if (r.queued || !bucket.types.includes(r.type) || !inScope(r.phase)) return;
        const out = bucket.build(r);
        if ("skip" in out) {
          skipped.push(`${r.name} (${out.skip})`);
          return;
        }
        builtRules.push(out.rule);
        bucketIdx.push(i);
      });
      if (builtRules.length) {
        const merged = await this.mergeEntrypointRules(zoneId, bucket.phase, builtRules, token);
        if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
        if (credential && !this.isCredentialLeaseCurrent(credential)) {
          return `Nothing queued: ${this.credentialSupersededMessage()}`;
        }
        if (this.state.migrationPlan !== plan) {
          return "Nothing queued: the migration preview changed while rules were being prepared. Review the latest plan and retry.";
        }
        newActions.push(
          this.newPending({
            product: bucket.product,
            summary: `Add ${builtRules.length} ${bucket.product.toLowerCase()} rule(s) from ${plan.providerLabel}${merged.note} — review fields before Apply`,
            method: "PUT",
            path: `/zones/${zoneId}/rulesets/phases/${bucket.phase}/entrypoint`,
            body: { rules: merged.rules },
            mergeEntrypoint: { phase: bucket.phase, newRules: builtRules },
            zoneId,
          }, turn.actor),
        );
        bucketIdx.forEach((i) => queuedIdx.add(i));
      }
    }

    // --- Zone / SSL settings → PATCH /settings/<id> ---
    plan.rules.forEach((r, i) => {
      if (r.queued || (r.type !== "zone_setting" && r.type !== "ssl_tls") || !inScope(r.phase)) return;
      const parsed = parseZoneSetting(r.detail);
      if (!parsed) {
        skipped.push(`${r.name} (no parseable setting — review manually)`);
        return;
      }
      newActions.push(
        this.newPending({
          product: "Zone settings",
          summary: `Set ${parsed.setting} = ${String(parsed.value)} (from ${plan.providerLabel})`,
          method: "PATCH",
          path: `/zones/${zoneId}/settings/${parsed.setting}`,
          body: { value: parsed.value },
          zoneId,
        }, turn.actor),
      );
      queuedIdx.add(i);
    });

    if (credential && !this.isCredentialLeaseCurrent(credential)) {
      return `Nothing queued: ${this.credentialSupersededMessage()}`;
    }
    if (this.state.migrationPlan !== plan) {
      return "Nothing queued: the migration preview changed while rules were being prepared. Review the latest plan and retry.";
    }

    const knownApprovals = new Set(
      this.state.pendingActions
        .map((action) => actionApprovalIdentity(action))
        .filter((identity): identity is string => identity !== undefined),
    );
    for (let index = newActions.length - 1; index >= 0; index--) {
      const validationError = pendingActionValidationError(newActions[index]);
      if (validationError) {
        return `Nothing queued: a generated migration approval failed validation (${validationError}). Export Terraform instead.`;
      }
      const identity = actionApprovalIdentity(newActions[index]);
      if (!identity || knownApprovals.has(identity)) {
        skipped.push(`${newActions[index].summary} (an identical approval is already queued)`);
        newActions.splice(index, 1);
      } else {
        knownApprovals.add(identity);
      }
    }

    if (this.state.pendingActions.length + newActions.length > MAX_PENDING_ACTIONS) {
      return `Nothing queued: this migration would exceed the room limit of ${MAX_PENDING_ACTIONS} pending approvals. Apply or reject existing approvals, or queue fewer phases.`;
    }

    if (!newActions.length) {
      if (queuedIdx.size) {
        const rules = plan.rules.map((rule, index) => (queuedIdx.has(index) ? { ...rule, queued: true } : rule));
        const nextState = { ...this.state, migrationPlan: { ...plan, rules } };
        const stateError = syncedStateSizeError(nextState);
        if (stateError) return `Nothing queued: ${stateError}`;
        this.setState(nextState);
      }
      const skipNote = skipped.length
        ? `Skipped: ${skipped.slice(0, 6).join("; ")}${skipped.length > 6 ? ` …(+${skipped.length - 6} more)` : ""}. `
        : "";
      const partialNote = plan.truncated
        ? `This review plan contains ${plan.rules.length} of ${plan.totalRules} parsed items; Terraform export covers the complete source. `
        : "";
      return `Nothing new to queue. ${skipNote}${partialNote}Phases like origin, cache, headers, load balancing, and Zero Trust are best handled via generate_migration_terraform.`;
    }

    // One atomic state write: append actions, mark queued rules, advance checklist.
    const rules = plan.rules.map((r, i) => (queuedIdx.has(i) ? { ...r, queued: true } : r));
    const ob = this.state.onboarding;
    const nextOb = ob
      ? {
          ...ob,
          checklist: ob.checklist.map((s) =>
            s.id === "migrate" && !plan.truncated ? { ...s, done: true } : s
          ),
          ts: Date.now(),
        }
      : undefined;
    const nextState = {
      ...this.state,
      pendingActions: [...this.state.pendingActions, ...newActions],
      migrationPlan: { ...plan, rules },
      ...(nextOb ? { onboarding: nextOb } : {}),
    };
    const stateError = syncedStateSizeError(nextState);
    if (stateError) return `Nothing queued: ${stateError} Queue fewer migration phases.`;
    if (!this.isChatTurnAccessCurrent(turn)) return this.chatTurnAccessError();
    this.setState(nextState);
    turn.queuedActions.push(...newActions);
    if (plan.truncated) {
      turn.queueNotices.push(
        `Partial migration plan: these approvals cover the retained ${plan.rules.length} of ${plan.totalRules} parsed items. Export Terraform for the complete source.`,
      );
    }
    // Newly-queued WAF/rate-limit/SSL rules may complete further checklist steps.
    this.recomputeOnboardingChecklist();

    const remaining = new Set(
      plan.rules.filter((r, i) => !queuedIdx.has(i) && !r.queued).map((r) => r.phaseLabel),
    );
    let msg = `Queued ${newActions.length} action(s) for approval ✅ — covering ${queuedIdx.size} rule(s). A human must click **Apply** (changes are NOT live yet). `;
    if (plan.truncated) {
      msg += `This review plan contains ${plan.rules.length} of ${plan.totalRules} parsed items; Terraform export covers the complete source. `;
    }
    if (skipped.length) msg += `Skipped ${skipped.length} rule(s) that need review/Terraform. `;
    if (remaining.size) {
      msg += `Phases not auto-queued (use generate_migration_terraform): ${Array.from(remaining)
        .slice(0, 10)
        .join(", ")}.`;
    }
    return msg;
  }

  /**
   * Read a phase's existing entrypoint rules (when a token is available) and
   * return existing+new so a queued PUT never silently drops current rules.
   */
  private async mergeEntrypointRules(
    zoneId: string,
    phase: string,
    newRules: Record<string, unknown>[],
    token: string,
  ): Promise<{ rules: Record<string, unknown>[]; note: string }> {
    if (!token) {
      return {
        rules: newRules,
        note: " (existing rules will be re-read and merged at Apply; Apply fails safely if that read is unavailable)",
      };
    }
    const ep = await cfGet<{ rules?: Array<Record<string, unknown>> }>(
      `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
      token,
    );
    if (ep.ok && Array.isArray(ep.result?.rules) && ep.result.rules.length > 0) {
      const existing = ep.result.rules.map(rulesetRuleForPut);
      return {
        rules: [...existing, ...newRules],
        note: ` (merged with ${existing.length} existing rule(s))`,
      };
    }
    return { rules: newRules, note: "" };
  }

  /** Generate Terraform for the plan (reusing the stored config unless overridden). */
  private async generateTerraform(args: {
    provider?: string;
    config?: string;
    format?: MigrationConfigFormat;
    zoneId?: string;
    accountId?: string;
    zoneName?: string;
  }, actor = "a teammate", isAuthorized: () => boolean = () => true): Promise<string> {
    if (!isAuthorized()) return this.chatTurnAccessError();
    const generation = ++this.migrationTerraformGeneration;
    if (!migrationConfigured(this.migrationTransport())) return this.notConfigured();
    const expectedPlan = this.state.migrationPlan;

    let provider = args.provider;
    let configData: unknown;
    if (args.config) {
      const resolved = await this.resolveConfigData(args);
      if (!isAuthorized()) return this.chatTurnAccessError();
      if (!resolved.ok) return `Error: ${resolved.message}`;
      configData = resolved.data;
    } else {
      const src = this.loadMigrationSource();
      if (!src) {
        return "No stored config to export. Run preview_provider_migration first, or pass `config`.";
      }
      if (provider !== undefined && provider !== src.provider) {
        return `The stored config belongs to ${src.provider}, not ${provider}. Preview or provide matching config first.`;
      }
      configData = src.configData;
      provider = src.provider;
    }
    if (!provider || !validMigrationProviderKey(provider)) return "Provide a valid `provider` key (e.g. \"akamai\").";

    const sourceRevision = args.config
      ? `sha256:${await sha256Hex(JSON.stringify(configData))}`
      : expectedPlan?.sourceRevision ?? `sha256:${await sha256Hex(JSON.stringify(configData))}`;
    if (!isAuthorized()) return this.chatTurnAccessError();
    const targetScope = CDN_MIGRATION_PROVIDERS.has(provider) ? "zone" : "account";
    const targetResolution = resolveMigrationExportTarget(
      this.state.defaultAccountId,
      this.state.defaultZone,
      args,
      targetScope,
    );
    if (!targetResolution.ok) return `Error: ${targetResolution.message}`;
    const target = targetResolution.target;
    if (generation !== this.migrationTerraformGeneration || this.state.migrationPlan !== expectedPlan) {
      return "A newer Terraform request or migration plan replaced this export. Review the latest plan and retry.";
    }

    const providerLabel = await this.migrationProviderLabel(provider, expectedPlan);
    if (!isAuthorized()) return this.chatTurnAccessError();
    if (generation !== this.migrationTerraformGeneration || this.state.migrationPlan !== expectedPlan) {
      return "A newer Terraform request or migration plan replaced this export. Review the latest plan and retry.";
    }
    const res = await generateMigrationTerraform(this.migrationTransport(), {
      provider,
      providerLabel,
      configData,
      ...target,
    });
    if (!isAuthorized()) return this.chatTurnAccessError();
    const latestTarget = resolveMigrationExportTarget(
      this.state.defaultAccountId,
      this.state.defaultZone,
      args,
      targetScope,
    );
    if (
      generation !== this.migrationTerraformGeneration ||
      this.state.migrationPlan !== expectedPlan ||
      !latestTarget.ok ||
      JSON.stringify(latestTarget.target) !== JSON.stringify(target)
    ) {
      return "A newer Terraform request or migration plan replaced this export. Review the latest plan and retry.";
    }
    if (!res.ok) return `Error from migration tool: ${res.message}`;

    const tf = res.result;
    const filesError = migrationFilesValidationError(tf?.files);
    if (filesError) return `Error from migration tool: ${filesError}`;
    const artifact: TerraformArtifact = {
      provider,
      sourceRevision,
      targetScope,
      ...target,
      files: tf.files,
      rulesetCount: tf.rulesetCount,
      ipListCount: tf.ipListCount,
      createdBy: actor,
      ts: Date.now(),
    };
    const nextState = { ...this.state, terraform: artifact };
    const stateError = syncedStateSizeError(nextState);
    if (stateError) return `Error: ${stateError}`;
    if (!isAuthorized()) return this.chatTurnAccessError();
    this.setState(nextState);

    const names = artifact.files.map((f) => f.filename).join(", ");
    const extra = [
      artifact.rulesetCount ? `${artifact.rulesetCount} ruleset(s)` : "",
      artifact.ipListCount ? `${artifact.ipListCount} IP list(s)` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const completeTarget = targetScope === "zone"
      ? Boolean(target.zoneId && target.accountId)
      : Boolean(target.accountId);
    return `Generated Terraform (${artifact.files.length} file(s)${extra ? `, ${extra}` : ""}): ${
      names || "(none)"
    }. Download it from the room's Migration panel.${
      completeTarget
        ? ""
        : ` Note: replace the placeholder ${targetScope === "zone" ? "zone/account ids" : "account id"} before \`terraform apply\`.`
    }`;
  }

  /** Resolve a zone together with its owner; never pair independent defaults. */
  private migrationDefaultsRevision(): string {
    return JSON.stringify({
      defaultAccountId: this.state.defaultAccountId,
      defaultZone: this.state.defaultZone,
    });
  }

  private async resolveMigrationCheckTarget(
    credential: CredentialLease,
    requestedZoneId?: string,
    isAuthorized: () => boolean = () => true,
  ): Promise<
    | { ok: true; accountId: string; zoneId?: string }
    | { ok: false; message: string }
  > {
    const selectedZoneId = requestedZoneId ?? this.state.defaultZone?.id;
    if (selectedZoneId) {
      const defaultZone = this.state.defaultZone;
      if (
        defaultZone?.accountId &&
        defaultZone.id.toLowerCase() === selectedZoneId.toLowerCase()
      ) {
        return { ok: true, accountId: defaultZone.accountId, zoneId: selectedZoneId };
      }
      const resolved = await cfGet<ZoneSummary>(`/zones/${selectedZoneId}`, credential.token);
      if (!isAuthorized()) return { ok: false, message: "Room access ended before the migration check completed." };
      if (!this.isCredentialLeaseCurrent(credential)) {
        return { ok: false, message: this.credentialSupersededMessage() };
      }
      if (!resolved.ok) {
        return { ok: false, message: `Couldn't verify the target zone's account: ${this.readError(resolved, credential)}` };
      }
      this.noteTokenOutcome(resolved, credential);
      const accountId = resolved.result.account?.id;
      if (!accountId) return { ok: false, message: "Cloudflare returned the target zone without an owning account." };
      return { ok: true, accountId, zoneId: selectedZoneId };
    }

    if (this.state.defaultAccountId) return { ok: true, accountId: this.state.defaultAccountId };
    const accounts = await listAccounts(credential.token);
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the migration check completed." };
    if (!this.isCredentialLeaseCurrent(credential)) {
      return { ok: false, message: this.credentialSupersededMessage() };
    }
    if (!accounts.ok) {
      return { ok: false, message: `Couldn't determine the target account: ${this.readError(accounts, credential)}` };
    }
    this.noteTokenOutcome(accounts, credential);
    if (accounts.result.length !== 1) {
      return { ok: false, message: "Couldn't determine one target account. Set a default account, then retry." };
    }
    const accountId = accounts.result[0].id;
    return { ok: true, accountId };
  }

  /** Record the latest pre-flight/diff result in synced state for the UI. */
  private recordCheck(
    kind: "preflight" | "diff" | "validate",
    ok: boolean,
    summary: string,
    by: string,
    expectedPlan: MigrationPlan | undefined,
    generation: number,
    target: { provider: string; accountId: string; zoneId?: string },
    defaultsRevision: string,
    credential: CredentialLease,
    isAuthorized: () => boolean = () => true,
  ): { ok: boolean; summary: string } {
    const safeSummary = redactCloudflareApiTokens(summary, credential.token);
    if (
      generation !== this.migrationCheckGeneration ||
      !isAuthorized() ||
      !this.isCredentialLeaseCurrent(credential) ||
      this.state.migrationPlan !== expectedPlan ||
      defaultsRevision !== this.migrationDefaultsRevision()
    ) {
      return {
        ok: false,
        summary: "A newer migration check or plan replaced this request. Review the latest result and retry if needed.",
      };
    }
    const check: MigrationCheck = {
      kind,
      ok,
      summary: safeSummary,
      provider: target.provider,
      sourceRevision: expectedPlan?.sourceRevision,
      accountId: target.accountId,
      zoneId: target.zoneId,
      by: redactCloudflareApiTokens(by, credential.token),
      ts: Date.now(),
    };
    this.setState({ ...this.state, migrationCheck: check });
    return { ok, summary: safeSummary };
  }

  /** Pre-flight permission validation for the current migration plan's provider. */
  private async doPreflight(
    zoneId: string | undefined,
    by: string,
    isAuthorized: () => boolean = () => true,
  ): Promise<{ ok: boolean; summary: string }> {
    if (!isAuthorized()) return { ok: false, summary: "Room access ended before the pre-flight started." };
    const generation = ++this.migrationCheckGeneration;
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, summary: this.notConfigured() };
    const expectedPlan = this.state.migrationPlan;
    const provider = expectedPlan?.provider;
    if (!provider) return { ok: false, summary: "No migration plan yet — preview a provider config first." };
    const defaultsRevision = this.migrationDefaultsRevision();
    const credential = await this.getCredentialLease();
    if (!isAuthorized()) return { ok: false, summary: "Room access ended before the pre-flight completed." };
    if (!credential) return { ok: false, summary: this.credentialUnavailableMessage() };
    if (
      generation !== this.migrationCheckGeneration ||
      this.state.migrationPlan !== expectedPlan ||
      defaultsRevision !== this.migrationDefaultsRevision()
    ) {
      return { ok: false, summary: "A newer account/zone, token, or migration check replaced this pre-flight request. Retry it." };
    }
    const resolvedTarget = await this.resolveMigrationCheckTarget(credential, zoneId, isAuthorized);
    if (
      !isAuthorized() ||
      generation !== this.migrationCheckGeneration ||
      this.state.migrationPlan !== expectedPlan ||
      defaultsRevision !== this.migrationDefaultsRevision() ||
      !this.isCredentialLeaseCurrent(credential)
    ) {
      return { ok: false, summary: "A newer account/zone or token selection replaced this pre-flight request. Retry it." };
    }
    if (!resolvedTarget.ok) return { ok: false, summary: resolvedTarget.message };
    const { accountId } = resolvedTarget;
    const zone = resolvedTarget.zoneId ?? "";
    if (CDN_MIGRATION_PROVIDERS.has(provider) && !zone) {
      return { ok: false, summary: `${provider} is zone-scoped — set a default zone (find_zone) or pass a zone id first.` };
    }
    const res = await preflightPermissions(this.migrationTransport(), {
      provider,
      accountId,
      zoneId: zone,
      apiToken: credential.token,
    });
    if (!isAuthorized()) return { ok: false, summary: "Room access ended before the pre-flight completed." };
    const target = { provider, accountId, zoneId: zone || undefined };
    if (!res.ok) {
      return this.recordCheck("preflight", false, `Pre-flight failed: ${res.message}`, by, expectedPlan, generation, target, defaultsRevision, credential, isAuthorized);
    }

    const r = res.result;
    if (r.skipped) {
      return this.recordCheck(
        "preflight",
        r.tokenValid && r.allPassed,
        r.skipReason ?? "Pre-flight skipped for this provider.",
        by,
        expectedPlan,
        generation,
        target,
        defaultsRevision,
        credential,
        isAuthorized,
      );
    }
    const preflightOk = r.tokenValid && r.allPassed;
    const summary = preflightOk
      ? `Pre-flight ✓ — token has all ${r.passed.length} permission(s) needed for ${provider}.`
      : `Pre-flight: ${r.passed.length} ok, ${r.missing.length} MISSING. Add: ${r.missing.slice(0, 6).join("; ")}${
          r.missing.length > 6 ? ` …(+${r.missing.length - 6})` : ""
        }`;
    return this.recordCheck("preflight", preflightOk, summary, by, expectedPlan, generation, target, defaultsRevision, credential, isAuthorized);
  }

  /** Pre-migration diff: what already exists in the target zone. */
  private async doDiff(
    zoneId: string | undefined,
    by: string,
    isAuthorized: () => boolean = () => true,
  ): Promise<{ ok: boolean; summary: string }> {
    if (!isAuthorized()) return { ok: false, summary: "Room access ended before the diff started." };
    const generation = ++this.migrationCheckGeneration;
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, summary: this.notConfigured() };
    const expectedPlan = this.state.migrationPlan;
    if (!expectedPlan) return { ok: false, summary: "No migration plan yet — preview a provider config first." };
    const provider = expectedPlan.provider;
    const defaultsRevision = this.migrationDefaultsRevision();
    const credential = await this.getCredentialLease();
    if (!isAuthorized()) return { ok: false, summary: "Room access ended before the diff completed." };
    if (!credential) return { ok: false, summary: this.credentialUnavailableMessage() };
    if (
      generation !== this.migrationCheckGeneration ||
      this.state.migrationPlan !== expectedPlan ||
      defaultsRevision !== this.migrationDefaultsRevision()
    ) {
      return { ok: false, summary: "A newer account/zone, token, or migration check replaced this diff request. Retry it." };
    }
    const requestedZone = zoneId ?? this.state.defaultZone?.id;
    if (!requestedZone) return { ok: false, summary: "A diff needs a target zone — set a default zone (find_zone) or pass a zone id." };
    const resolvedTarget = await this.resolveMigrationCheckTarget(credential, requestedZone, isAuthorized);
    if (
      !isAuthorized() ||
      generation !== this.migrationCheckGeneration ||
      this.state.migrationPlan !== expectedPlan ||
      defaultsRevision !== this.migrationDefaultsRevision() ||
      !this.isCredentialLeaseCurrent(credential)
    ) {
      return { ok: false, summary: "A newer account/zone or token selection replaced this diff request. Retry it." };
    }
    if (!resolvedTarget.ok || !resolvedTarget.zoneId) {
      return { ok: false, summary: resolvedTarget.ok ? "Couldn't resolve the target zone." : resolvedTarget.message };
    }
    const { accountId, zoneId: zone } = resolvedTarget;

    const res = await diffReport(this.migrationTransport(), {
      provider,
      accountId,
      zoneId: zone,
      apiToken: credential.token,
    });
    if (!isAuthorized()) return { ok: false, summary: "Room access ended before the diff completed." };
    const target = { provider, accountId, zoneId: zone };
    if (!res.ok) {
      return this.recordCheck("diff", false, `Diff failed: ${res.message}`, by, expectedPlan, generation, target, defaultsRevision, credential, isAuthorized);
    }

    const d = res.result;
    const phaseBits = Object.values(d.phases)
      .filter((p) => p.existingTotal > 0)
      .map((p) => `${p.label}: ${p.existingTotal} (${p.existingManual} manual)`);
    const summary =
      `Diff for zone ${zone}: ` +
      (phaseBits.length ? phaseBits.join("; ") : "no existing rules in migration phases") +
      `. IP lists: ${d.ipLists.total}; LB pools: ${d.loadBalancers.pools}, LBs: ${d.loadBalancers.lbs}. ` +
      "Manual rules are preserved; queued rules merge into the phase entrypoint.";
    return this.recordCheck("diff", true, summary, by, expectedPlan, generation, target, defaultsRevision, credential, isAuthorized);
  }

  /** Export the migration plan's config as CSV (reuses the stored source, or args). */
  private async doExportCsv(args: {
    provider?: string;
    config?: string;
    configFiles?: Array<{ filename: string; content: string }>;
    format?: MigrationConfigFormat;
  }, actor = "a teammate", isAuthorized: () => boolean = () => true): Promise<{ ok: boolean; message: string }> {
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the CSV export started." };
    const generation = ++this.migrationCsvGeneration;
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, message: this.notConfigured() };
    const expectedPlan = this.state.migrationPlan;

    let provider = args.provider;
    let configData: unknown;
    if (args.config || args.configFiles?.length) {
      const resolved = await this.resolveConfigData(args);
      if (!isAuthorized()) return { ok: false, message: "Room access ended before the CSV export completed." };
      if (!resolved.ok) return { ok: false, message: resolved.message };
      configData = resolved.data;
    } else {
      const src = this.loadMigrationSource();
      if (!src) return { ok: false, message: "No stored config to export. Preview a provider config first, or pass config." };
      if (provider !== undefined && provider !== src.provider) {
        return {
          ok: false,
          message: `The stored config belongs to ${src.provider}, not ${provider}. Preview or provide matching config first.`,
        };
      }
      configData = src.configData;
      provider = src.provider;
    }
    if (!provider || !validMigrationProviderKey(provider)) {
      return { ok: false, message: 'Provide a valid `provider` key (e.g. "akamai").' };
    }
    const explicitSource = Boolean(args.config || args.configFiles?.length);
    const sourceRevision = explicitSource
      ? `sha256:${await sha256Hex(JSON.stringify(configData))}`
      : expectedPlan?.sourceRevision ?? `sha256:${await sha256Hex(JSON.stringify(configData))}`;
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the CSV export completed." };
    if (generation !== this.migrationCsvGeneration || this.state.migrationPlan !== expectedPlan) {
      return { ok: false, message: "A newer CSV request or migration plan replaced this export. Review the latest plan and retry." };
    }

    const providerLabel = await this.migrationProviderLabel(provider, expectedPlan);
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the CSV export completed." };
    if (generation !== this.migrationCsvGeneration || this.state.migrationPlan !== expectedPlan) {
      return { ok: false, message: "A newer CSV request or migration plan replaced this export. Review the latest plan and retry." };
    }
    const res = await exportMigrationCsv(this.migrationTransport(), { provider, providerLabel, configData });
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the CSV export completed." };
    if (generation !== this.migrationCsvGeneration || this.state.migrationPlan !== expectedPlan) {
      return { ok: false, message: "A newer CSV request or migration plan replaced this export. Review the latest plan and retry." };
    }
    if (!res.ok) return { ok: false, message: `Error from migration tool: ${res.message}` };
    const filesError = migrationFilesValidationError(res.result?.files);
    if (filesError) return { ok: false, message: `Error from migration tool: ${filesError}` };

    const artifact: TerraformArtifact = {
      provider,
      sourceRevision,
      files: res.result.files,
      createdBy: actor,
      ts: Date.now(),
    };
    const nextState = { ...this.state, csv: artifact };
    const stateError = syncedStateSizeError(nextState);
    if (stateError) return { ok: false, message: stateError };
    if (!isAuthorized()) return { ok: false, message: "Room access ended before the CSV export could be saved." };
    this.setState(nextState);
    const names = artifact.files.map((f) => f.filename).join(", ");
    return {
      ok: true,
      message: `Generated CSV (${artifact.files.length} file(s)): ${names || "(none)"}. Download it from the room's Migration panel.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Approval RPC — the ONLY place real Cloudflare writes happen.
  // ---------------------------------------------------------------------------

  private applyCanceledForAccessLoss(
    action: PendingAction,
    by: string,
  ): Promise<ActionResult> {
    return this.recordActionResult(
      action.id,
      {
        id: action.id,
        product: action.product,
        summary: action.summary,
        status: "failed",
        detail: "Apply canceled because room access ended before the write. Nothing was sent to Cloudflare.",
        by,
        ts: Date.now(),
      },
      true,
      false,
    );
  }

  @callable()
  async applyAction(
    id: string,
    by = "someone",
    confirmUncertain = false,
    autoRevert = false,
  ): Promise<ActionResult> {
    const { lease: accessLease } = this.requireCommitRole("apply changes");
    const actor = accessLease?.email ?? normalizeActor(by, "a teammate");
    const parsedId = validateIdentifier(id, "Action id", 200);
    if (!parsedId.ok) {
      return {
        id: "invalid",
        product: "—",
        summary: "(invalid action)",
        status: "failed",
        detail: parsedId.message,
        by: actor,
        ts: Date.now(),
      };
    }
    return this.applyActionInternal(
      parsedId.value,
      actor,
      true,
      confirmUncertain === true,
      undefined,
      accessLease,
      autoRevert === true,
    );
  }

  private async applyActionInternal(
    id: string,
    by: string,
    notify: boolean,
    confirmUncertain = false,
    capturedCredential?: CredentialLease | null,
    accessLease?: RoomAccessLease,
    autoRevert = false,
  ): Promise<ActionResult> {
    let action = this.state.pendingActions.find((a) => a.id === id);
    if (!action) {
      return {
        id,
        product: "—",
        summary: "(unknown action)",
        status: "failed",
        detail: "That action is no longer pending.",
        by,
        ts: Date.now(),
      };
    }
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return {
        id,
        product: action.product,
        summary: action.summary,
        status: "failed",
        detail: "Apply canceled because room access ended before it started. Nothing was sent to Cloudflare.",
        by,
        ts: Date.now(),
      };
    }

    if (isSnapshotRestoreAction(action)) {
      return this.recordActionResult(
        id,
        {
          id,
          product: typeof action.product === "string" ? action.product : "Restore",
          summary: typeof action.summary === "string" ? action.summary : "Disabled snapshot restore",
          status: "failed",
          detail: MIGRATION_SNAPSHOT_DISABLED,
          by,
          ts: Date.now(),
        },
        false,
        notify,
      );
    }

    if (!action.zoneId && action.actionType !== "snapshot_restore") {
      const canonicalPath = canonicalizeApiPath(action.path);
      const zoneId = canonicalPath === action.path ? zoneIdFromApiPath(canonicalPath) : undefined;
      if (zoneId) {
        action = { ...action, zoneId };
        this.setState({
          ...this.state,
          pendingActions: this.state.pendingActions.map((candidate) =>
            candidate.id === id ? action! : candidate,
          ),
        });
      }
    }

    const validationError = pendingActionValidationError(action);
    if (validationError) {
      return this.recordActionResult(
        id,
        {
          id,
          product: typeof action.product === "string" ? action.product : "Invalid action",
          summary: typeof action.summary === "string" ? action.summary : "Invalid queued action",
          status: "failed",
          detail: `Refused malformed queued action: ${validationError}`,
          by,
          ts: Date.now(),
        },
        true,
        notify,
      );
    }

    if (isActionOutcomeUncertain(action) && confirmUncertain !== true) {
      return {
        id,
        product: action.product,
        summary: action.summary,
        status: "failed",
        detail:
          "Outcome uncertain: verify the live Cloudflare configuration, then retry this action individually with explicit confirmation.",
        by,
        ts: Date.now(),
      };
    }

    if (isActionApplying(action)) {
      return {
        id,
        product: action.product,
        summary: action.summary,
        status: "failed",
        detail: "Another teammate is already applying this action.",
        by,
        ts: Date.now(),
      };
    }

    const resourceKey = actionResourceKey(action);
    const restoring = action.actionType === "snapshot_restore";
    const conflictingAction = this.state.pendingActions.find(
      (candidate) =>
        candidate.id !== id &&
        isActionApplying(candidate) &&
        (restoring ||
          candidate.actionType === "snapshot_restore" ||
          (resourceKey !== undefined && actionResourceKey(candidate) === resourceKey)),
    );
    if (conflictingAction) {
      return {
        id,
        product: action.product,
        summary: action.summary,
        status: "failed",
        detail: `Wait for "${conflictingAction.summary}" to finish; both actions update the same resource.`,
        by,
        ts: Date.now(),
      };
    }

    const attemptedAt = Date.now();
    this.setState({
      ...this.state,
      pendingActions: markActionApplying(this.state.pendingActions, id, attemptedAt),
    });
    try {
      await this.schedule(
        APPLY_ATTEMPT_STALE_MS / 1_000,
        "recoverActionAttempt",
        { id, attemptedAt },
        { idempotent: true },
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "failed to schedule Apply watchdog",
          actionId: id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (!this.isRoomAccessLeaseCurrent(accessLease)) {
      return this.applyCanceledForAccessLoss(action, by);
    }

    try {
      const credential = capturedCredential === undefined
        ? await this.getCredentialLease()
        : capturedCredential;
      if (!this.isRoomAccessLeaseCurrent(accessLease)) {
        return this.applyCanceledForAccessLoss(action, by);
      }
      if (!credential) {
        return this.recordActionResult(
          id,
          {
            id,
            product: action.product,
            summary: action.summary,
            status: "failed",
            detail: `${this.credentialUnavailableMessage()} Nothing was sent to Cloudflare.`,
            by,
            ts: Date.now(),
          },
          true,
          notify,
        );
      }
      if (!this.isCredentialLeaseCurrent(credential)) {
        return this.recordActionResult(
          id,
          {
            id,
            product: action.product,
            summary: action.summary,
            status: "failed",
            detail: "The Cloudflare credential changed before this write. Nothing was sent; retry with the current token.",
            by,
            ts: Date.now(),
          },
          true,
          notify,
        );
      }

      // For ruleset-phase entrypoint replacements, re-read the phase's CURRENT
      // rules at apply time and append our new rules. Refuse the write if that
      // safety read fails: replacing the phase from an empty baseline could
      // silently delete rules added after this action was queued.
      let body = action.body;
      if (action.mergeEntrypoint && action.zoneId) {
        const { phase, newRules } = action.mergeEntrypoint;
        const ep = await cfGet<{ rules?: Array<Record<string, unknown>> }>(
          `/zones/${action.zoneId}/rulesets/phases/${phase}/entrypoint`,
          credential.token,
        );
        if (!this.isRoomAccessLeaseCurrent(accessLease)) {
          return this.applyCanceledForAccessLoss(action, by);
        }
        if (!this.isCredentialLeaseCurrent(credential)) {
          return this.recordActionResult(
            id,
            {
              id,
              product: action.product,
              summary: action.summary,
              status: "failed",
              detail: "The Cloudflare credential changed during the safety read. No write was sent; retry with the current token.",
              by,
              ts: Date.now(),
            },
            true,
            notify,
          );
        }
        const baseline = resolveRulesetEntrypointBaseline(ep);
        if (!baseline.ok) {
          const detail = baseline.hint
            ? `${baseline.message} — needs token permission: ${baseline.hint}`
            : baseline.message;
          return this.recordActionResult(
            id,
            {
              id,
              product: action.product,
              summary: action.summary,
              status: "failed",
              detail: `Couldn't safely read the current ruleset, so nothing was changed: ${detail}`,
              by,
              ts: Date.now(),
            },
            true,
            notify,
          );
        }
        const existing = baseline.result.map(rulesetRuleForPut);
        body = { rules: [...existing, ...newRules] };
      }

      if (!this.isCredentialLeaseCurrent(credential)) {
        return this.recordActionResult(
          id,
          {
            id,
            product: action.product,
            summary: action.summary,
            status: "failed",
            detail: "The Cloudflare credential changed before this write. Nothing was sent; retry with the current token.",
            by,
            ts: Date.now(),
          },
          true,
          notify,
        );
      }
      if (!this.isRoomAccessLeaseCurrent(accessLease)) {
        return this.applyCanceledForAccessLoss(action, by);
      }

      // Auto-rollback safety window (opt-in; invertible zone-setting PATCH only):
      // read the CURRENT value now so a successful write can be restored later. If
      // the member opted in but we can't read the prior value, honor their intent
      // by failing safe — send nothing to Cloudflare rather than apply a change we
      // couldn't undo.
      let rollbackPriorValue: unknown;
      let armRollback = false;
      const invertible = autoRevert ? invertibleSetting(action) : null;
      if (invertible) {
        const prior = await cfGet<{ value?: unknown }>(invertible.path, credential.token);
        if (!this.isRoomAccessLeaseCurrent(accessLease)) {
          return this.applyCanceledForAccessLoss(action, by);
        }
        if (!this.isCredentialLeaseCurrent(credential)) {
          return this.recordActionResult(
            id,
            {
              id,
              product: action.product,
              summary: action.summary,
              status: "failed",
              detail: "The Cloudflare credential changed during the auto-revert safety read. Nothing was sent; retry with the current token.",
              by,
              ts: Date.now(),
            },
            true,
            notify,
          );
        }
        if (!prior.ok || prior.result?.value === undefined) {
          const why = prior.ok
            ? "Cloudflare didn't return a current value."
            : prior.hint
              ? `${prior.message} — needs token permission: ${prior.hint}`
              : prior.message;
          return this.recordActionResult(
            id,
            {
              id,
              product: action.product,
              summary: action.summary,
              status: "failed",
              detail: `Couldn't read the current value to arm the auto-revert safety window, so nothing was changed: ${why} Retry, or apply without the safety window.`,
              by,
              ts: Date.now(),
            },
            true,
            notify,
          );
        }
        rollbackPriorValue = prior.result.value;
        armRollback = true;
      }
      const res = await cfRequest(action.method, action.path, credential.token, body);

      if (res.ok) {
        const createdId = (res.result as { id?: string } | undefined)?.id;
        let detail = createdId ? `Applied — created ${createdId}` : "Applied successfully.";
        if (armRollback) {
          const armed = await this.armAutoRollback(action, rollbackPriorValue, by);
          detail += armed
            ? " Auto-revert armed — restores the previous setting in 15 min unless you Keep it."
            : " (Couldn't arm auto-revert; the change stays unless you revert it manually.)";
        }
        return this.recordActionResult(
          id,
          {
            id,
            product: action.product,
            summary: action.summary,
            status: "applied",
            detail,
            by,
            ts: Date.now(),
          },
          false,
          notify,
        );
      }

      const rawDetail = res.hint ? `${res.message} — needs token permission: ${res.hint}` : res.message;
      const detail =
        res.category === "network" || res.category === "transient"
          ? `Outcome uncertain: Cloudflare may have received the write before the response failed. Verify the live configuration before retrying. ${rawDetail}`
          : rawDetail;
      return this.recordActionResult(
        id,
        {
          id,
          product: action.product,
          summary: action.summary,
          status: "failed",
          detail,
          by,
          ts: Date.now(),
        },
        true,
        notify,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.recordActionResult(
        id,
        {
          id,
          product: action.product,
          summary: action.summary,
          status: "failed",
          detail: `Outcome uncertain: Apply was interrupted before it reported a definitive result. Verify the live configuration before retrying. ${detail}`,
          by,
          ts: Date.now(),
        },
        true,
        notify,
      );
    }
  }

  @callable()
  async rejectAction(id: string, by = "someone"): Promise<ActionResult> {
    const parsedId = validateIdentifier(id, "Action id", 200);
    const actor = this.requireCommitRole("reject changes").lease?.email ?? normalizeActor(by, "a teammate");
    if (!parsedId.ok) {
      return {
        id: "invalid",
        product: "—",
        summary: "(invalid action)",
        status: "failed",
        detail: parsedId.message,
        by: actor,
        ts: Date.now(),
      };
    }
    id = parsedId.value;
    by = actor;
    const action = this.state.pendingActions.find((a) => a.id === id);
    if (!action) {
      return {
        id,
        product: "—",
        summary: "(unknown action)",
        status: "failed",
        detail: "That action is no longer pending.",
        by,
        ts: Date.now(),
      };
    }
    if (isActionApplying(action)) {
      return {
        id,
        product: action.product,
        summary: action.summary,
        status: "failed",
        detail: "This action is already being applied and can no longer be rejected.",
        by,
        ts: Date.now(),
      };
    }
    return this.recordActionResult(id, {
      id,
      product: action.product,
      summary: action.summary,
      status: "rejected",
      detail: `Rejected by ${by}.`,
      by,
      ts: Date.now(),
    }, false, true);
  }

  @callable()
  async applyAll(ids: string[], by = "someone"): Promise<ActionResult[]> {
    if (!Array.isArray(ids)) return [];
    const reviewedIds = Array.from(
      new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200)),
    ).slice(0, 100);
    const safeIds = selectBulkApplyIds(this.state.pendingActions, reviewedIds);
    const results: ActionResult[] = [];
    const { lease: accessLease } = this.requireCommitRole("apply changes");
    const actor = accessLease?.email ?? normalizeActor(by, "a teammate");
    const credential = await this.getCredentialLease() ?? null;
    for (const id of safeIds) {
      if (!this.isRoomAccessLeaseCurrent(accessLease)) break;
      results.push(await this.applyActionInternal(id, actor, true, false, credential, accessLease));
      if (
        !credential ||
        !this.isCredentialLeaseCurrent(credential) ||
        !this.isRoomAccessLeaseCurrent(accessLease)
      ) break;
    }
    return results;
  }

  /** Record an outcome atomically. Failed writes stay queued for correction or verification. */
  private async recordActionResult(
    id: string,
    result: ActionResult,
    retainForRetry: boolean,
    notify: boolean,
  ): Promise<ActionResult> {
    const safeResult: ActionResult = {
      ...result,
      product: redactCloudflareApiTokens(result.product, this.tokenForRedaction),
      summary: redactCloudflareApiTokens(result.summary, this.tokenForRedaction),
      detail: redactCloudflareApiTokens(result.detail, this.tokenForRedaction),
      by: redactCloudflareApiTokens(result.by, this.tokenForRedaction),
    };
    this.setState({
      ...this.state,
      pendingActions: retainForRetry
        ? markActionFailed(this.state.pendingActions, id, safeResult.detail, safeResult.ts)
        : this.state.pendingActions.filter((a) => a.id !== id),
      recentResults: [safeResult, ...this.state.recentResults].slice(0, MAX_RECENT_RESULTS),
    });
    // Governance audit: record who applied or rejected which change (failed
    // attempts stay queued for retry and are not audited as a decision).
    if (safeResult.status === "applied") {
      this.recordAudit("apply", safeResult.by, safeResult.id, safeResult.summary);
    } else if (safeResult.status === "rejected") {
      this.recordAudit("reject", safeResult.by, safeResult.id, safeResult.summary);
    }
    // An applied change (e.g. SSL set, WAF rule live) can complete a go-live step.
    this.recomputeOnboardingChecklist();
    if (notify) await this.scheduleActionResultNotification([safeResult]);
    return safeResult;
  }

  // ---------------------------------------------------------------------------
  // Auto-rollback safety window
  //
  // When a member opts in while applying an invertible zone-setting change, the
  // Apply path captured the prior value and calls armAutoRollback, which stores a
  // PendingRollback and schedules runAutoRollback. The change auto-reverts when
  // the timer fires unless a member calls keepAppliedChange first (or reverts
  // early with revertAppliedChange). The executable inverse is server-authored
  // and stored in synced state (clients cannot mutate synced state); the Keep /
  // Revert RPCs take only the window id.
  // ---------------------------------------------------------------------------

  /** Store the inverse + arm the revert timer for a just-applied invertible change. */
  private async armAutoRollback(action: PendingAction, priorValue: unknown, by: string): Promise<boolean> {
    const plan = buildRollbackPlan(action, priorValue);
    if (!plan) return false;
    const rollbackId = crypto.randomUUID();
    const now = Date.now();
    let scheduleId: string | undefined;
    try {
      const scheduled = await this.schedule(
        AUTO_ROLLBACK_WINDOW_SEC,
        "runAutoRollback",
        { rollbackId },
        { idempotent: true },
      );
      scheduleId = scheduled.id;
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "failed to schedule auto-rollback",
          actionId: action.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return false;
    }
    const rollback: PendingRollback = {
      id: rollbackId,
      actionId: action.id,
      product: action.product,
      summary: action.summary,
      revertSummary: plan.summary,
      method: plan.method,
      path: plan.path,
      body: plan.body,
      zoneId: action.zoneId,
      by,
      appliedTs: now,
      expiresTs: now + AUTO_ROLLBACK_WINDOW_SEC * 1_000,
      scheduleId,
    };
    this.setState({
      ...this.state,
      pendingRollbacks: [rollback, ...(this.state.pendingRollbacks ?? [])].slice(0, MAX_PENDING_ROLLBACKS),
    });
    return true;
  }

  /**
   * Scheduled callback (public so the DO scheduler can invoke it by name): fire an
   * auto-revert when its safety window closes. A no-op if the window was already
   * kept or reverted (the record is gone).
   */
  async runAutoRollback(payload: { rollbackId?: string }): Promise<void> {
    const rollbackId = typeof payload?.rollbackId === "string" ? payload.rollbackId : undefined;
    if (!rollbackId) return;
    const rollback = (this.state.pendingRollbacks ?? []).find((r) => r.id === rollbackId);
    if (!rollback) return;
    await this.executeRollback(rollback, "the auto-revert safety window", true);
  }

  /**
   * Restore an applied change's prior value. Removes the window first so a manual
   * "Revert now" racing the timer can't double-apply, then sends the inverse and
   * records the outcome.
   */
  private async executeRollback(rollback: PendingRollback, by: string, notify: boolean): Promise<ActionResult> {
    this.setState({
      ...this.state,
      pendingRollbacks: (this.state.pendingRollbacks ?? []).filter((r) => r.id !== rollback.id),
    });
    const base = { id: rollback.id, product: rollback.product, summary: rollback.revertSummary, by, ts: Date.now() };
    const credential = await this.getCredentialLease();
    if (!credential) {
      return this.recordRollbackOutcome(
        { ...base, status: "failed", detail: `${this.credentialUnavailableMessage()} The change was NOT reverted.` },
        rollback,
        notify,
      );
    }
    const res = await cfRequest(rollback.method, rollback.path, credential.token, rollback.body);
    if (res.ok) {
      return this.recordRollbackOutcome(
        { ...base, status: "applied", detail: `Reverted to the previous setting (${rollback.summary}).` },
        rollback,
        notify,
      );
    }
    const why = res.hint ? `${res.message} — needs token permission: ${res.hint}` : res.message;
    return this.recordRollbackOutcome(
      { ...base, status: "failed", detail: `Auto-revert failed — the applied change is still live: ${why}` },
      rollback,
      notify,
    );
  }

  /** Record a revert outcome in recentResults + audit, without touching pendingActions. */
  private async recordRollbackOutcome(
    result: ActionResult,
    rollback: PendingRollback,
    notify: boolean,
  ): Promise<ActionResult> {
    const safeResult: ActionResult = {
      ...result,
      product: redactCloudflareApiTokens(result.product, this.tokenForRedaction),
      summary: redactCloudflareApiTokens(result.summary, this.tokenForRedaction),
      detail: redactCloudflareApiTokens(result.detail, this.tokenForRedaction),
      by: redactCloudflareApiTokens(result.by, this.tokenForRedaction),
    };
    this.setState({
      ...this.state,
      recentResults: [safeResult, ...this.state.recentResults].slice(0, MAX_RECENT_RESULTS),
    });
    if (safeResult.status === "applied") {
      this.recordAudit("rollback", safeResult.by, rollback.actionId, safeResult.summary);
    }
    // A revert can un-satisfy a go-live step (e.g. SSL mode changed back).
    this.recomputeOnboardingChecklist();
    if (notify) await this.scheduleActionResultNotification([safeResult]);
    return safeResult;
  }

  /**
   * UI: "Keep" an applied change — cancel its auto-revert timer and close the
   * safety window so the change stays live. Member-or-owner only.
   */
  @callable()
  async keepAppliedChange(rollbackId: string, by = "someone"): Promise<{ ok: boolean; message: string }> {
    this.requireCommitRole("keep or revert an applied change");
    const parsed = validateIdentifier(rollbackId, "Safety-window id", 200);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const rollback = (this.state.pendingRollbacks ?? []).find((r) => r.id === parsed.value);
    if (!rollback) return { ok: false, message: "That safety window has already closed." };
    if (rollback.scheduleId) {
      try {
        await this.cancelSchedule(rollback.scheduleId);
      } catch {
        this.logChatEvent("rollback.keep_schedule_cancel_failed", {}, "warn");
      }
    }
    this.setState({
      ...this.state,
      pendingRollbacks: (this.state.pendingRollbacks ?? []).filter((r) => r.id !== rollback.id),
    });
    return { ok: true, message: `Kept "${rollback.summary}" — the change stays live.` };
  }

  /**
   * UI: "Revert now" — restore the prior value immediately instead of waiting for
   * the timer. Member-or-owner only.
   */
  @callable()
  async revertAppliedChange(rollbackId: string, by = "someone"): Promise<ActionResult> {
    const { lease } = this.requireCommitRole("keep or revert an applied change");
    const actor = lease?.email ?? normalizeActor(by, "a teammate");
    const parsed = validateIdentifier(rollbackId, "Safety-window id", 200);
    if (!parsed.ok) {
      return { id: "invalid", product: "—", summary: "(invalid)", status: "failed", detail: parsed.message, by: actor, ts: Date.now() };
    }
    const rollback = (this.state.pendingRollbacks ?? []).find((r) => r.id === parsed.value);
    if (!rollback) {
      return {
        id: parsed.value,
        product: "—",
        summary: "(closed)",
        status: "failed",
        detail: "That safety window has already closed.",
        by: actor,
        ts: Date.now(),
      };
    }
    if (rollback.scheduleId) {
      try {
        await this.cancelSchedule(rollback.scheduleId);
      } catch {
        this.logChatEvent("rollback.revert_schedule_cancel_failed", {}, "warn");
      }
    }
    return this.executeRollback(rollback, actor, true);
  }

  /** Schedule the model follow-up outside the approval RPC, so Apply returns promptly. */
  private async scheduleActionResultNotification(results: ActionResult[]): Promise<void> {
    if (!results.length) return;
    try {
      await this.schedule(
        0,
        "announceActionResults",
        { results },
        { idempotent: true, retry: { maxAttempts: 2 } },
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "failed to schedule action-result chat update",
          actionIds: results.map((result) => result.id),
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /** Scheduled, server-driven turn that tells Glide an Apply/Reject outcome occurred. */
  async announceActionResults(payload: { results: ActionResult[] }): Promise<void> {
    const results = payload?.results ?? [];
    if (!results.length) return;

    const eventId = actionResultEventId(results);
    const completed = this.sql<{ completed: number }>`
      SELECT completed FROM glide_action_notifications WHERE id = ${eventId}`;
    if (Number(completed[0]?.completed ?? 0) === 1) return;

    const eventText = redactCloudflareApiTokens(formatActionResultEvent(results), this.tokenForRedaction);
    const event = this.canonicalActionResultMessage(eventId, eventText);

    // Register before saveMessages invokes persistence sanitization and the
    // model. A conflicting browser-authored message with this id is replaced.
    this.sql`INSERT OR REPLACE INTO glide_system_events (id, text, ts)
      VALUES (${eventId}, ${eventText}, ${Date.now()})`;

    const response = await this.saveMessages((messages) => {
      const existing = messages.find((message) => message.id === eventId);
      return existing && this.isRegisteredActionResultEvent(existing)
        ? [...messages]
        : [...messages.filter((message) => message.id !== eventId), event];
    });
    if (response.status !== "completed") {
      throw new Error(
        response.error ? String(response.error) : `Action-result chat update ended with ${response.status}.`,
      );
    }
    this.sql`INSERT OR REPLACE INTO glide_action_notifications (id, completed, ts)
      VALUES (${eventId}, 1, ${Date.now()})`;
  }

  /** Resolve an Apply that was left in-flight by an isolate reset or lost RPC. */
  async recoverActionAttempt(payload: { id: string; attemptedAt: number }): Promise<void> {
    const action = this.state.pendingActions.find((candidate) => candidate.id === payload?.id);
    if (
      !action ||
      pendingActionStatus(action) !== "applying" ||
      action.attemptedAt !== payload.attemptedAt
    ) {
      return;
    }

    await this.recordActionResult(
      action.id,
      {
        id: action.id,
        product: action.product,
        summary: action.summary,
        status: "failed",
        detail:
          "Outcome uncertain: the Apply attempt did not report a result before its safety deadline. Verify the live configuration before retrying.",
        by: "Glide recovery",
        ts: Date.now(),
      },
      true,
      true,
    );
  }
}

function validRoomStorageName(value: unknown): value is string {
  return isValidRoomStorageName(value) && value !== DOCS_SYSTEM_ROOM;
}

function isSameOriginRequest(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

function agentRequestHasAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === new URL(request.url).origin;
  return request.headers.get("Upgrade")?.toLowerCase() !== "websocket";
}

function invalidOriginResponse(): Response {
  return Response.json(
    { code: "invalid_origin", message: "Glide Agent connections require the same application origin." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

async function rateLimitedDynamicRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Request | Response> {
  const clientKey = await clientRateLimitKey(request);
  const decision = await consumeRateLimit(env.AGENT_RATE_LIMITER, clientKey);
  if (decision !== "allowed") {
    const event = decision === "limited" ? "rate_limit.exceeded" : "rate_limit.unavailable";
    const details = { glideEvent: event, scope: "agent_request" };
    if (decision === "limited") console.warn(details);
    else console.error(details);
    return rateLimitResponse(decision);
  }
  return request;
}

async function authenticatedDynamicRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<{ request: Request; identity: AccessIdentity } | Response> {
  const limited = await rateLimitedDynamicRequest(request, env);
  if (limited instanceof Response) return limited;
  const authentication = await authenticateAccessRequest(limited, env);
  if (!authentication.ok) return accessAuthErrorResponse(authentication);
  const authenticatedRequest = requestWithAccessIdentity(limited, authentication.identity);
  const headers = new Headers(authenticatedRequest.headers);
  headers.set(
    CLIENT_RATE_LIMIT_HEADER,
    await opaqueRateLimitKey("client", authentication.identity.subject),
  );
  return {
    request: new Request(authenticatedRequest, { headers }),
    identity: authentication.identity,
  };
}

/** Ownership activation is idempotent, so retry once if cleanup reset the DO. */
async function activateRoomWithRetry(
  env: Cloudflare.Env,
  storageRoom: string,
  identity: AccessIdentity,
  canonicalRoomId: boolean,
): Promise<RoomAuthorizationResult> {
  const attemptId = crypto.randomUUID();
  try {
    const agent = await getAgentByName(env.GlideAgent, storageRoom);
    return await agent.activateRoomAccess(identity, canonicalRoomId, attemptId);
  } catch {
    console.warn({ glideEvent: "room.activation_retry" });
    await scheduler.wait(10);
    const agent = await getAgentByName(env.GlideAgent, storageRoom);
    return agent.activateRoomAccess(identity, canonicalRoomId, attemptId);
  }
}

// ---------------------------------------------------------------------------
// Worker entry: route /agents/* to the DO, otherwise serve the React SPA.
// ---------------------------------------------------------------------------

export default {
  /**
   * Weekly Cloudflare-docs refresh (cron `0 2 * * SUN`; see wrangler.jsonc).
   * A Worker-level cron can't touch a DO's work queue directly, so we drive the
   * reindex through one stable, well-known agent instance ({@link DOCS_SYSTEM_ROOM}).
   * `startDocsReindex` only seeds the queue and schedules the first tick — the
   * self-chaining `docsTick`s do the heavy lifting on the DO — so this handler
   * returns almost immediately. Best-effort: a failure is logged, not thrown, so
   * a bad week doesn't crash the cron and next Sunday simply tries again. If a
   * run is already in flight, `startDocsReindex` no-ops with a message.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const system = await getAgentByName(env.GlideAgent, DOCS_SYSTEM_ROOM);
          const res = await system.startDocsReindex("the weekly refresh cron");
          if (res.ok) console.log(`[cron] weekly docs reindex: ${res.message}`);
          else console.warn(`[cron] weekly docs reindex did not start: ${res.message}`);
        } catch (err) {
          console.error(
            "[cron] weekly docs reindex failed to start:",
            (err as Error)?.message ?? err,
          );
        }
      })(),
    );
  },
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/api/session") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const authenticated = await authenticatedDynamicRequest(request, env);
      if (authenticated instanceof Response) return authenticated;
      const session: AccessSession = {
        email: authenticated.identity.email,
        isEmployee: isCloudflareEmployeeEmail(authenticated.identity.email),
      };
      return Response.json(session, { headers: { "Cache-Control": "no-store" } });
    }

    if (requestUrl.pathname === "/api/room-access") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      }
      if (!isSameOriginRequest(request)) {
        return Response.json(
          { code: "invalid_origin", message: "Room access requests require a same-origin request." },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      const intent = requestUrl.searchParams.get("intent");
      if (intent !== null && intent !== "inspect") {
        return Response.json(
          { code: "invalid_intent", message: "Provide a valid room-access intent." },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      const room = requestUrl.searchParams.get("room")?.trim();
      const storageRoom = roomStorageName(room);
      if (!storageRoom || isReservedSystemRoom(storageRoom)) {
        return Response.json(
          { code: "invalid_room", message: "Provide a valid room id." },
          {
            status: storageRoom && isReservedSystemRoom(storageRoom) ? 404 : 400,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
      const authenticated = await authenticatedDynamicRequest(request, env);
      if (authenticated instanceof Response) return authenticated;
      const authorization = intent === "inspect"
        ? await (await getAgentByName(env.GlideAgent, storageRoom)).authorizeRoomAccess(authenticated.identity)
        : await activateRoomWithRetry(
            env,
            storageRoom,
            authenticated.identity,
            isValidRoomId(room),
          );
      if (!authorization.allowed || !authorization.access) {
        return Response.json(
          { code: authorization.code, message: authorization.message },
          {
            status: authorization.code === "legacy_room_not_found" ? 404 : 403,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
      return Response.json(
        { ...authorization.access, message: authorization.message },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Read-only inspection for the /admin dashboard. Members are told to use the
    // live socket; verified Cloudflare employees who are NOT members get an
    // audited, read-only snapshot (state + transcript + audit) and never a
    // connection. Same-origin + authenticated, like /api/room-access.
    if (requestUrl.pathname === "/api/room-inspect") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      }
      if (!isSameOriginRequest(request)) {
        return Response.json(
          { code: "invalid_origin", message: "Room inspection requests require a same-origin request." },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      const room = requestUrl.searchParams.get("room")?.trim();
      const storageRoom = roomStorageName(room);
      if (!storageRoom || isReservedSystemRoom(storageRoom)) {
        return Response.json(
          { code: "invalid_room", message: "Provide a valid room id." },
          {
            status: storageRoom && isReservedSystemRoom(storageRoom) ? 404 : 400,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
      const authenticated = await authenticatedDynamicRequest(request, env);
      if (authenticated instanceof Response) return authenticated;
      const agent = await getAgentByName(env.GlideAgent, storageRoom);
      // The Workers RPC return-type mapper reduces the embedded UIMessage[] to
      // `never`; the runtime value is the real, structured-cloneable result.
      const result = (await agent.inspectRoom(authenticated.identity)) as unknown as RoomInspectionResult;
      if (!result.allowed || !result.access) {
        return Response.json(
          { code: result.code, message: result.message },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { ...result.access, message: result.message, snapshot: result.snapshot },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Deployment-wide room list for the admin "all rooms" view. Verified
    // Cloudflare employees only (the same class that can create/claim rooms).
    // Same-origin like /api/room-access. Reads the fixed registry DO; membership
    // to any individual room is still enforced when that room is opened.
    if (requestUrl.pathname === "/api/rooms") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      }
      if (!isSameOriginRequest(request)) {
        return Response.json(
          { code: "invalid_origin", message: "Room list requests require a same-origin request." },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      const authenticated = await authenticatedDynamicRequest(request, env);
      if (authenticated instanceof Response) return authenticated;
      if (!isCloudflareEmployeeEmail(authenticated.identity.email)) {
        return Response.json(
          { code: "forbidden", message: "Only Cloudflare employees can list rooms." },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      try {
        const registry = await getAgentByName(env.GlideAgent, REGISTRY_SYSTEM_ROOM);
        const rooms = await registry.listRoomRegistry();
        return Response.json({ rooms }, { headers: { "Cache-Control": "no-store" } });
      } catch (err) {
        console.error({ glideEvent: "room.registry_list_failed", error: (err as Error)?.message ?? String(err) });
        return Response.json(
          { code: "registry_unavailable", message: "The room registry is temporarily unavailable." },
          { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "10" } },
        );
      }
    }

    let rootAuthentication: { request: Request; identity: AccessIdentity } | undefined;
    if (request.method === "GET" && requestUrl.pathname === "/") {
      const authenticated = await authenticatedDynamicRequest(request, env);
      if (authenticated instanceof Response) return authenticated;
      rootAuthentication = authenticated;
      ctx.waitUntil(
        (async () => {
          try {
            const system = await getAgentByName(env.GlideAgent, DOCS_SYSTEM_ROOM);
            await system.ensureDocsIndex();
          } catch (err) {
            console.warn("[docs-bootstrap] initial docs index check failed:", (err as Error)?.message ?? err);
          }
        })(),
      );
    }

    const admitAgentRequest = async (
      candidate: Request,
      lobby: { className: string; name: string },
    ): Promise<Request | Response | undefined> => {
      const reserved = rejectReservedSystemRoute(candidate, lobby);
      if (reserved) return reserved;
      if (lobby.className !== "GlideAgent" || !validRoomStorageName(lobby.name)) {
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      if (!agentRequestHasAllowedOrigin(candidate)) return invalidOriginResponse();
      const authenticated = await authenticatedDynamicRequest(candidate, env);
      if (authenticated instanceof Response) return authenticated;
      const agent = await getAgentByName(env.GlideAgent, lobby.name);
      const authorization = await agent.authorizeRoomAccess(authenticated.identity);
      if (!authorization.allowed) {
        return Response.json(
          { code: authorization.code, message: authorization.message },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      return authenticated.request;
    };
    const routed = await routeAgentRequest(rootAuthentication?.request ?? request, env, {
      onBeforeConnect: admitAgentRequest,
      onBeforeRequest: admitAgentRequest,
    });
    if (routed) return routed;
    const res = await env.ASSETS.fetch(request);
    // Revalidate HTML on every load so a redeploy's new hashed asset URLs are
    // picked up immediately. The hashed JS/CSS themselves stay immutably cached;
    // only the tiny index.html is re-checked. Prevents stale-bundle confusion.
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "no-cache");
      headers.set("Content-Security-Policy", "frame-ancestors 'none'");
      headers.set("X-Frame-Options", "DENY");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
