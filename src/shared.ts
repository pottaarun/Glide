/**
 * Client-safe types and validation shared by the Worker and React client.
 * No Workers or DOM globals and no `declare global`.
 */

import type { PendingActionStatus } from "./action-lifecycle";

export type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export const LEGACY_CHAT_RECOVERY_CONFIRMATION = "DISCARD LEGACY CHAT ARCHIVE";
/** Exact phrase the owner must send to confirm permanently deleting a room. */
export const ROOM_DELETE_CONFIRMATION = "DELETE THIS ROOM";
export const MAX_ROOM_ID_CHARS = 128;
export const MAX_LEGACY_ROOM_ID_CHARS = 200;
/** Max length of the room's human-friendly display name (see {@link GlideState.roomName}). */
export const MAX_ROOM_NAME_CHARS = 60;
/** Durable Object names are limited to 1,024 bytes; URL path serialization is ASCII. */
export const MAX_ROOM_STORAGE_NAME_BYTES = 1_024;

function routeStorageName(value: string): string | undefined {
  try {
    const parts = new URL(`https://glide.invalid/agents/glide-agent/${value}`)
      .pathname.split("/").filter(Boolean);
    if (parts[0] !== "agents" || parts[1] !== "glide-agent") return undefined;
    const storageName = parts[2];
    return storageName && storageName.length <= MAX_ROOM_STORAGE_NAME_BYTES
      ? storageName
      : undefined;
  } catch {
    return undefined;
  }
}

export function isValidRoomId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_ROOM_ID_CHARS &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Resolve a displayed room id to the name PartySocket historically placed in
 * the Agent URL's first room segment. Keeping this mapping shared prevents the
 * access endpoint and browser Agent client from selecting different objects.
 */
export function roomStorageName(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LEGACY_ROOM_ID_CHARS ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) return undefined;
  return routeStorageName(value);
}

export function isSupportedRoomId(value: unknown): value is string {
  return roomStorageName(value) !== undefined;
}

/** Validate a room name after URL serialization, where the 200-char display cap no longer applies. */
export function isValidRoomStorageName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_ROOM_STORAGE_NAME_BYTES &&
    routeStorageName(value) === value;
}

/**
 * Clean a user-supplied room display name (see {@link GlideState.roomName}).
 * Strips control characters, collapses whitespace, trims, and caps the length.
 * Returns `undefined` when the result is empty, which clears the name. This is a
 * free-form label only — it never affects room routing or storage identity.
 */
export function normalizeRoomName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ROOM_NAME_CHARS);
  return name || undefined;
}

export interface LegacyChatMigrationStatus {
  status: "ready" | "migrating" | "recovery_required" | "discarding";
  message: string;
  recoveryConfirmation?: typeof LEGACY_CHAT_RECOVERY_CONFIRMATION;
}

/** A Cloudflare-changing action the LLM proposed but that has NOT run yet. */
export interface PendingAction {
  id: string;
  /** Product area for grouping/labelling in the UI, e.g. "DNS", "WAF". */
  product: string;
  /** Human-readable description of what this will do. */
  summary: string;
  /** HTTP method against the Cloudflare API. */
  method: WriteMethod;
  /** Path after https://api.cloudflare.com/client/v4 (e.g. "/zones/<id>/dns_records"). */
  path: string;
  /** JSON body to send (omitted for DELETE with no body). */
  body?: unknown;
  /** Dedicated destructive operation executed by the migration service after Apply. */
  /** Legacy disabled action type retained only so persisted approvals can fail closed. */
  actionType?: "snapshot_restore";
  /** Legacy snapshot id retained only for fail-closed validation. */
  restoreSnapshotId?: string;
  /** Legacy reviewed payload retained only for fail-closed validation. */
  restoreSnapshotAccountId?: string;
  restoreSnapshotZoneId?: string;
  restoreSnapshotVersion?: number;
  restoreSnapshotDigest?: string;
  /**
   * Set when this action replaces a ruleset phase entrypoint (a PUT that would
   * otherwise overwrite the whole phase). At Apply time the server re-reads the
   * phase's CURRENT rules and appends these `newRules`, so applying never
   * silently drops rules added (by anyone) after this was queued. `body` holds a
   * best-effort preview of the merged result, computed at queue time, for display.
   */
  mergeEntrypoint?: { phase: string; newRules: Array<Record<string, unknown>> };
  /** Display name of the room participant whose message triggered this. */
  createdBy: string;
  /** Optional zone id used for resource locking and target-aware approval handling. */
  zoneId?: string;
  /** Missing on legacy persisted actions, which are treated as pending. */
  status?: PendingActionStatus;
  /** Last Apply error. Failed actions remain queued so they can be retried. */
  error?: string;
  /** Start/end time of the latest Apply attempt, used to recover interrupted attempts. */
  attemptedAt?: number;
  ts: number;
}

/** Invitation audit record; authorization uses the server-only room-members table. */
export interface Invite {
  email: string;
  /** Canonical verified email of the room member who granted access. */
  invitedBy: string;
  /** Shareable room link captured at invite time (origin + room hash). */
  link?: string;
  ts: number;
}

/**
 * Persisted per-room membership roles (row in `glide_room_members`), least → most
 * privileged: `viewer` can read + chat + propose but cannot apply/queue changes,
 * invite, or manage the room; `member` can additionally apply changes and invite
 * teammates; `owner` can additionally manage roles, tokens, rename, and delete.
 */
export type RoomRole = "owner" | "member" | "viewer";

export interface RoomMember {
  email: string;
  role: RoomRole;
  invitedBy?: string;
  joinedAt: number;
}

export interface RoomAccessStatus {
  email: string;
  isEmployee: boolean;
  /**
   * The caller's effective role. `inspector` is NOT a persisted membership — it
   * is the ephemeral read-only grant given to a verified Cloudflare employee who
   * opens the `/admin` dashboard for a room they are not a member of.
   */
  role: RoomRole | "inspector";
  members: RoomMember[];
  entry: "member" | "created" | "claimed" | "inspect";
}

/** Audit-trail action verbs recorded in `glide_room_audit` (append-only). */
export type RoomAuditAction =
  | "queue"
  | "apply"
  | "reject"
  | "invite"
  | "remove"
  | "role_change"
  | "token_set"
  | "token_clear"
  | "rename"
  | "destroy"
  | "inspect";

/**
 * One append-only governance audit entry: who did what, when. Stored in SQLite
 * (not synced in {@link GlideState}); read on demand by an owner via
 * `getAuditLog` and exportable to CSV/JSON from the admin dashboard.
 */
export interface RoomAuditEntry {
  id: string;
  ts: number;
  /** Canonical verified email of the actor (or a system label for automated entries). */
  actor: string;
  action: RoomAuditAction;
  /** The object acted on: an invited email, a pending-action id, a member email, etc. */
  target?: string;
  /** Short human-readable summary of the entry. */
  detail?: string;
}

/**
 * A row in the deployment-wide room registry, returned by `GET /api/rooms` for
 * the admin "all rooms" view. Rooms self-report this metadata to a fixed
 * registry Durable Object as they are activated and used; it is a convenience
 * index, not an authorization boundary. Membership is still enforced per room.
 */
export interface RoomSummary {
  /** Room id used in the URL hash (the Durable Object instance name). */
  id: string;
  /** Human-friendly room name, when one has been set (see {@link GlideState.roomName}). */
  name?: string;
  /** Canonical email of the room owner, when known. */
  owner?: string;
  /** Number of members with access. */
  memberCount: number;
  /** ms epoch the room was first activated. */
  createdAt: number;
  /** ms epoch of the most recent recorded activity. */
  lastActiveAt: number;
}

/** The outcome of applying or rejecting a pending action. */
export interface ActionResult {
  id: string;
  product: string;
  summary: string;
  status: "applied" | "failed" | "rejected";
  /** Created resource id on success, or an error message on failure. */
  detail: string;
  by: string;
  ts: number;
}

/**
 * State synced live to every client in the room (Agents SDK state sync).
 * This is also the room's persistent memory — it survives restarts.
 */
export interface GlideState {
  /**
   * Optional human-friendly name any room member can set for this room (e.g.
   * "arubhe.com go-live"). Display-only: it labels the room in the header, admin
   * view, and invites, but never changes the room's routing id or storage
   * identity. Normalized and length-capped via {@link normalizeRoomName}.
   */
  roomName?: string;
  /** Durable free-form facts the room has learned (account id, conventions, etc.). */
  memory: Record<string, string>;
  /** Changes awaiting human approval. */
  pendingActions: PendingAction[];
  /** Last N applied/failed/rejected actions retained in synced state, newest first. */
  recentResults: ActionResult[];
  /** People invited to this room by email (most recent first). */
  invites: Invite[];
  /** Convenience pointers the agent can set so users don't repeat IDs. */
  defaultAccountId?: string;
  defaultZone?: { id: string; name: string; accountId?: string };
  /**
   * Live facts read from the default zone's real Cloudflare state (activation
   * status, SSL mode, managed-WAF deployment, DNS proxy coverage). Captured
   * best-effort by `find_zone` and `list_dns_records` so the go-live checklist
   * auto-ticks (and marks steps N/A) from the domain's actual configuration —
   * not just from actions queued inside the room. See {@link LiveZoneFacts}.
   */
  liveZone?: LiveZoneFacts;
  /**
   * Whether this room has a usable GUI-set Cloudflare API token, stored encrypted
   * in its Durable Object.
   */
  tokenConfigured: boolean;
  /** Last 4 chars of the GUI-set token, for a non-sensitive status display. */
  tokenLast4?: string;
  /** Latest authentication check, including account/zone read fallback for account-scoped tokens. */
  tokenValid?: boolean;
  /** Guided onboarding progress (set once someone starts onboarding). */
  onboarding?: OnboardingState;
  /**
   * The team's "nature of the business" answers (see {@link BusinessProfile}).
   * Captured by Glide's discovery questions during onboarding AND on-demand, and
   * fed to the recommendation engine (recommendations.ts) to suggest tailored
   * performance/security settings. Lives at the room level (not inside
   * onboarding) so the advisor keeps working after go-live.
   */
  businessProfile?: BusinessProfile;
  /**
   * A running "further reading" list of Cloudflare docs pages the RAG retriever
   * surfaced while answering this room's questions (see {@link DocLink}). Deduped
   * by URL, most-recent first, capped at {@link MAX_DOC_LINKS}. Built automatically
   * from the conversation and shown in the sidebar and `/admin`.
   */
  docLinks?: DocLink[];
  /** Most recent provider-config preview translated into Cloudflare rules. */
  migrationPlan?: MigrationPlan;
  /** Most recent Terraform export the room generated (downloadable in the UI). */
  terraform?: TerraformArtifact;
  /** Most recent CSV export the room generated (downloadable in the UI). */
  csv?: TerraformArtifact;
  /** Result of the most recent pre-flight or diff check (shown in the UI). */
  migrationCheck?: MigrationCheck;
  /** Legacy state shape; current snapshot RPCs never populate it. */
  snapshots?: SnapshotInfo[];
  /** Whether the room is connected to a migration tool service. */
  migrationToolConfigured?: boolean;
  /**
   * Admin-authored guidance docs for THIS room (see {@link GuidanceDoc}). Edited
   * live in `/admin`; every enabled doc is injected into Glide's system prompt so
   * it asks relevant, team-specific onboarding questions — no redeploy needed.
   */
  guidance?: GuidanceDoc[];
  /**
   * Internal progress for the cron-owned Cloudflare-docs reindex job. Present only
   * on the fixed system Durable Object; normal room clients cannot control it.
   */
  docsIndex?: DocsIndexState;
}

/**
 * Live progress of the global "index the Cloudflare docs" background job.
 *
 * The job is triggered by the Worker cron, resumable, and runs in bounded batches
 * via the Agents SDK scheduler. Vectors are written to a global namespace with
 * deterministic ids, and the previous canonical run is removed before rebuild.
 */
export interface DocsIndexState {
  /** Lifecycle: idle (never run) → enumerating → indexing → done | error | cancelled. */
  status: "idle" | "enumerating" | "indexing" | "done" | "error" | "cancelled";
  /** Opaque id for the current run; stale scheduled ticks self-cancel when it changes. */
  runId?: string;
  /** Durable handoff marker: the SQL work queue is complete and safe to resume. */
  queueSeeded?: boolean;
  /** Products discovered from the top-level docs index. */
  productsTotal: number;
  /** Products whose page list has been enumerated into the work queue. */
  productsEnumerated: number;
  /** Pages discovered across enumerated products (grows during enumeration). */
  pagesTotal: number;
  /** Pages fetched, embedded and upserted so far. */
  pagesIndexed: number;
  /** Pages skipped after a fetch/embed failure (non-fatal). */
  pagesFailed: number;
  /** Vector chunks upserted so far (a page yields one or more chunks). */
  chunksUpserted: number;
  /** Product currently being enumerated/indexed, for a live status line. */
  currentProduct?: string;
  /** Error message when status === "error". */
  error?: string;
  /** Display name of the admin who started the run. */
  startedBy?: string;
  /** ms epoch when the run started. */
  startedAt?: number;
  /** ms epoch of the most recent progress update. */
  updatedAt?: number;
  /** ms epoch when the run reached a terminal state. */
  finishedAt?: number;
}

/**
 * A single retrieved Cloudflare-docs excerpt, injected into the system prompt to
 * ground Glide's answers. Produced by the docs RAG retriever (docs-scraper.ts)
 * and rendered by buildSystemPrompt. Pure data so both the Worker and (if ever
 * needed) the client can share the shape.
 */
export interface DocChunk {
  /** Canonical docs page URL (human-facing, without the `.md` suffix). */
  url: string;
  /** Page title. */
  title: string;
  /** Product the page belongs to, e.g. "DNS". */
  product?: string;
  /** Section within the product index, e.g. "Get started". */
  section?: string;
  /** The excerpt text. */
  text: string;
  /** Similarity score from Vectorize (higher is closer), when available. */
  score?: number;
}

/**
 * A Cloudflare docs page surfaced by the RAG retriever during this room's
 * conversation. Accumulated (deduped by URL, most-recent first) into
 * {@link GlideState.docLinks} so the team gets a running "further reading" list
 * built from what they actually discussed. Distinct from {@link DocChunk}: a
 * DocLink is a whole page reference (no excerpt text), safe to render as a link.
 */
export interface DocLink {
  /** Canonical docs page URL. */
  url: string;
  /** Page title. */
  title: string;
  /** Product the page belongs to, e.g. "WAF". */
  product?: string;
  /** Best similarity score seen for this page (higher is closer). */
  score?: number;
  /** ms epoch this page was most recently surfaced in the conversation. */
  ts: number;
}

/** Cap on the running doc-links reading list kept in synced state. */
export const MAX_DOC_LINKS = 12;

/** Only official Cloudflare developer-docs pages belong in the reading list. */
export function isCloudflareDocsUrl(value: string): boolean {
  try {
    return new URL(value).origin === "https://developers.cloudflare.com";
  } catch {
    return false;
  }
}

/**
 * Fold freshly retrieved doc chunks into the room's running doc-links list:
 * dedupe by URL (one entry per page, keeping the best score seen), stamp
 * `ts = now` on pages surfaced this turn so they float to the top, then return
 * the list most-recent-first, capped at {@link MAX_DOC_LINKS}. Pure — shared by
 * the Worker and unit-tested directly.
 */
export function mergeDocLinks(
  existing: DocLink[] | undefined,
  hits: ReadonlyArray<Pick<DocChunk, "url" | "title" | "product" | "score">>,
  now: number,
  cap = MAX_DOC_LINKS,
): DocLink[] {
  const byUrl = new Map<string, DocLink>();
  for (const link of existing ?? []) {
    if (link && typeof link.url === "string" && isCloudflareDocsUrl(link.url)) {
      byUrl.set(link.url, { ...link });
    }
  }
  for (const h of hits) {
    if (!h || typeof h.url !== "string" || !isCloudflareDocsUrl(h.url)) continue;
    const prev = byUrl.get(h.url);
    const score =
      typeof h.score === "number"
        ? prev?.score !== undefined
          ? Math.max(prev.score, h.score)
          : h.score
        : prev?.score;
    byUrl.set(h.url, {
      url: h.url,
      title: (h.title && h.title.trim()) || prev?.title || h.url,
      product: h.product ?? prev?.product,
      score,
      ts: now,
    });
  }
  return [...byUrl.values()]
    .sort((a, b) => b.ts - a.ts || (b.score ?? 0) - (a.score ?? 0))
    .slice(0, cap);
}

/**
 * A piece of admin-authored guidance that steers the questions Glide asks.
 *
 * Unlike the build-time "dev docs" (bundled Markdown about the app itself),
 * guidance docs are created at runtime by admins in the `/admin` dashboard and
 * live in the room's synced state. Enabled docs are folded into the system
 * prompt as high-priority context, so Glide tailors its onboarding — skipping
 * questions the guidance already answers and asking the follow-ups it implies.
 */
export interface GuidanceDoc {
  /** Stable id, generated when the doc is created. */
  id: string;
  /** Short title, e.g. "Our stack" or "Compliance requirements". */
  title: string;
  /** Freeform guidance the model reads (plain text / light Markdown). */
  body: string;
  /** When false the doc is kept but NOT injected into the prompt. */
  enabled: boolean;
  /** Display name of the room participant who last edited it. */
  updatedBy?: string;
  ts: number;
}

/** A compact, synced result of a pre-flight check, diff, or post-migration validation. */
export interface MigrationCheck {
  kind: "preflight" | "diff" | "validate";
  ok: boolean;
  summary: string;
  /** Missing only on legacy persisted checks. */
  provider?: string;
  sourceRevision?: string;
  /** Missing only on legacy persisted checks. */
  accountId?: string;
  zoneId?: string;
  by: string;
  ts: number;
}

/** Legacy snapshot metadata retained for persisted-state compatibility only. */
export interface SnapshotInfo {
  id: string;
  zoneId: string;
  zoneName: string;
  /** ISO timestamp the snapshot was captured. */
  created: string;
}

export const INITIAL_GLIDE_STATE: GlideState = {
  memory: {},
  pendingActions: [],
  recentResults: [],
  invites: [],
  tokenConfigured: false,
};

// ---------------------------------------------------------------------------
// Onboarding — a guided, doc-grounded flow for getting a team onto Cloudflare.
// ---------------------------------------------------------------------------

/**
 * A snapshot of the default zone's real Cloudflare state, read live from the API
 * so the onboarding checklist reflects the domain's actual configuration. All
 * fields beyond `zoneId`/`ts` are best-effort: a reader that fails or lacks
 * permission simply leaves its field undefined (the related step stays unticked).
 */
export interface LiveZoneFacts {
  /** The zone this snapshot describes (matches {@link GlideState.defaultZone}.id). */
  zoneId: string;
  /** Zone name, when known. */
  name?: string;
  /** Activation status from the API: "active", "pending", "initializing", "moved", … */
  status?: string;
  /** SSL/TLS encryption mode ("off" | "flexible" | "full" | "strict" | "unknown"). */
  sslMode?: "off" | "flexible" | "full" | "strict" | "unknown";
  /** Whether the Cloudflare Managed WAF ruleset is deployed on the zone. */
  wafManaged?: boolean;
  /** Number of proxiable DNS records that are currently proxied (orange cloud). */
  proxiedRecords?: number;
  /** Number of proxiable DNS records total, from the most recent record listing. */
  proxiableRecords?: number;
  /** ms epoch these facts were captured. */
  ts: number;
}

/** One step in the onboarding checklist (mirrors Cloudflare's go-live path). */
export interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
  /**
   * Marked "not applicable" for this room's real situation — e.g. lowering TTLs
   * before cutover once the zone is already active. Auto-derived from the live
   * zone state (see {@link LiveZoneFacts}); counts as satisfied for progress but
   * renders distinctly from a completed step. Never unset once set.
   */
  na?: boolean;
}

/** DNS zone setup type the team is targeting (see Cloudflare DNS zone setups). */
export type SetupType = "full" | "partial" | "unsure";

/** The top-level branch: migrate an existing provider, or start fresh. */
export type OnboardingPath = "migrate" | "fresh";

/** Live, synced onboarding progress for the room. */
export interface OnboardingState {
  /** Whether an onboarding flow has been started in this room. */
  active: boolean;
  /** Whether the guided setup has been finished. */
  completed?: boolean;
  /** Migrate from an existing provider, or start fresh. */
  path?: OnboardingPath;
  /** Domain(s) being onboarded, comma-separated or freeform. */
  domain?: string;
  /** Full (primary) vs Partial (CNAME) setup, or undecided. */
  setupType?: SetupType;
  /** Provider key the team is migrating away from (e.g. "akamai"), if any. */
  migratingFrom?: string;
  /** Human label for the provider (e.g. "Akamai"). */
  migratingFromLabel?: string;
  /** Whether an exported provider config has been previewed. */
  configProvided?: boolean;
  /**
   * Whether the team has reviewed the DNS records Cloudflare scanned (set once
   * `list_dns_records` runs during an active onboarding). Auto-checks the
   * "scan"/"dns" checklist step.
   */
  dnsReviewed?: boolean;
  /** What they want to migrate/set up, e.g. ["dns", "waf", "cache"]. */
  goals: string[];
  /** Ordered checklist reflecting the recommended path (tailored to `path`). */
  checklist: OnboardingStep[];
  updatedBy?: string;
  ts?: number;
}

// ---------------------------------------------------------------------------
// Business profile — the "nature of the business" discovery answers that drive
// tailored Cloudflare recommendations (see recommendations.ts). Pure data.
// ---------------------------------------------------------------------------

/**
 * The team's answers to Glide's probing "nature of the business" questions.
 *
 * Glide asks these one at a time (during onboarding and on-demand) to understand
 * the app, audience, data sensitivity, compliance needs, and known threats, then
 * feeds this profile to the recommendation engine to suggest relevant
 * performance/security/reliability settings and rules. Every field is optional
 * so the profile fills in gradually; the arrays default to `[]`. Recommendations
 * are still only ever QUEUED for human Apply — capturing a profile changes
 * nothing on the account.
 */
export interface BusinessProfile {
  /** Canonical industry/vertical key when recognised, e.g. "ecommerce", "fintech", "saas". Freeform allowed. */
  industry?: string;
  /** Human label for the industry, e.g. "E-commerce". */
  industryLabel?: string;
  /**
   * What kind of app(s) the team runs. Canonical keys:
   * "website" | "web_app" | "api" | "mobile_backend" | "static_site" | "ugc".
   */
  appTypes: string[];
  /** Who the app serves — drives caching/routing recommendations. */
  audience?: "global" | "regional" | "internal";
  /** Rough traffic scale / spikiness — drives rate limiting and caching urgency. */
  trafficProfile?: "low" | "steady" | "spiky" | "high_volume";
  /** Whether the app has user authentication / login flows. */
  hasLogin?: boolean;
  /** Whether the team exposes an API (public or partner-facing). */
  hasApi?: boolean;
  /** Whether a meaningful share of content is static / cacheable. */
  cacheableContent?: boolean;
  /**
   * Sensitive data handled. Canonical keys:
   * "pii" | "payments" | "health" | "credentials" | "financial".
   */
  sensitiveData: string[];
  /**
   * Compliance regimes in scope. Canonical keys:
   * "pci_dss" | "hipaa" | "gdpr" | "soc2" | "iso27001" | "fedramp".
   */
  compliance: string[];
  /**
   * Known pains / threats the team is worried about. Canonical keys:
   * "bots" | "ddos" | "scraping" | "credential_stuffing" | "card_testing" |
   * "fraud" | "latency" | "downtime" | "cost".
   */
  concerns: string[];
  /** Freeform notes Glide captured that don't fit a structured field. */
  notes?: string;
  /** Whether the discovery Q&A has been marked complete for now. */
  completed?: boolean;
  updatedBy?: string;
  ts?: number;
}

/** An empty profile with the required arrays initialised. */
export const EMPTY_BUSINESS_PROFILE: BusinessProfile = {
  appTypes: [],
  sensitiveData: [],
  compliance: [],
  concerns: [],
};

// ---------------------------------------------------------------------------
// Migration — existing provider config translated to Cloudflare rules.
// ---------------------------------------------------------------------------

/** One Cloudflare-equivalent rule parsed from a provider config (read-only preview). */
export interface MigrationPlanRule {
  name: string;
  type: string;
  phase: string;
  phaseLabel: string;
  action?: string;
  detail?: string;
  expression?: string;
  /** Set once this rule has been queued as a pending action (dedup guard). */
  queued?: boolean;
}

/** The last provider-config preview produced for this room. */
export interface MigrationPlan {
  provider: string;
  providerLabel: string;
  totalRules: number;
  phases: Array<{ key: string; label: string; count: number }>;
  rules: MigrationPlanRule[];
  /** True if `rules` is a bounded subset; the complete source remains available for export. */
  truncated?: boolean;
  /** Exact SQL-only source revision used to produce this plan. Missing on legacy plans. */
  sourceRevision?: string;
  createdBy: string;
  ts: number;
}

/** A generated Terraform artifact the room can download. */
export interface TerraformArtifact {
  provider: string;
  sourceRevision?: string;
  /** Target shape used when this artifact was generated. Missing on legacy artifacts. */
  targetScope?: "account" | "zone";
  accountId?: string;
  zoneId?: string;
  zoneName?: string;
  files: Array<{ filename: string; content: string }>;
  rulesetCount?: number;
  ipListCount?: number;
  createdBy: string;
  ts: number;
}

/** Metadata attached to each chat message so the room knows who said what. */
export interface GlideMessageMetadata {
  name?: string;
  /** Server-authored correlation between an assistant response and its triggering user turn. */
  responseTo?: string;
  /** Server-authored terminal state used for durable delivery confirmation. */
  delivery?: "completed" | "interrupted";
  /** Internal event that should inform the model but stay hidden in the human transcript. */
  systemEvent?: "action_result";
}
