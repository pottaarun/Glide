/**
 * Shared types used by BOTH the Worker (GlideAgent) and the React client.
 * Pure types only — no Workers or DOM globals, no `declare global`.
 */

import type { PendingActionStatus } from "./action-lifecycle";

export type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";

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
  /** Optional zone id this action targets (used to snapshot before applying). */
  zoneId?: string;
  /** Missing on legacy persisted actions, which are treated as pending. */
  status?: PendingActionStatus;
  /** Last Apply error. Failed actions remain queued so they can be retried. */
  error?: string;
  /** Start/end time of the latest Apply attempt, used to recover interrupted attempts. */
  attemptedAt?: number;
  ts: number;
}

/** Someone invited to this room by email. Stored so the room can show who's been asked to join. */
export interface Invite {
  email: string;
  /** Display name of the room participant who sent the invite. */
  invitedBy: string;
  /** Shareable room link captured at invite time (origin + room hash). */
  link?: string;
  ts: number;
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
  /** Durable free-form facts the room has learned (account id, conventions, etc.). */
  memory: Record<string, string>;
  /** Changes awaiting human approval. */
  pendingActions: PendingAction[];
  /** Last N applied/failed/rejected actions, newest first (full history is in SQLite). */
  recentResults: ActionResult[];
  /** People invited to this room by email (most recent first). */
  invites: Invite[];
  /** Convenience pointers the agent can set so users don't repeat IDs. */
  defaultAccountId?: string;
  defaultZone?: { id: string; name: string };
  /**
   * Whether a Cloudflare API token is available to this room — either set in the
   * GUI (stored encrypted in the Durable Object) or via the `CF_API_TOKEN` secret.
   */
  tokenConfigured: boolean;
  /** Last 4 chars of the GUI-set token, for a non-sensitive status display. */
  tokenLast4?: string;
  /** Latest authentication check, including account/zone read fallback for account-scoped tokens. */
  tokenValid?: boolean;
  /** Guided onboarding progress (set once someone starts onboarding). */
  onboarding?: OnboardingState;
  /** Most recent provider-config preview translated into Cloudflare rules. */
  migrationPlan?: MigrationPlan;
  /** Most recent Terraform export the room generated (downloadable in the UI). */
  terraform?: TerraformArtifact;
  /** Most recent CSV export the room generated (downloadable in the UI). */
  csv?: TerraformArtifact;
  /** Result of the most recent pre-flight or diff check (shown in the UI). */
  migrationCheck?: MigrationCheck;
  /** Zone snapshots (restore points) captured via the migration tool. */
  snapshots?: SnapshotInfo[];
  /** Whether the room is connected to a migration tool (MIGRATION_API_URL set). */
  migrationToolConfigured?: boolean;
  /**
   * Admin-authored guidance docs for THIS room (see {@link GuidanceDoc}). Edited
   * live in `/admin`; every enabled doc is injected into Glide's system prompt so
   * it asks relevant, team-specific onboarding questions — no redeploy needed.
   */
  guidance?: GuidanceDoc[];
  /**
   * Progress of the admin-triggered Cloudflare-docs reindex job (see
   * {@link DocsIndexState}). The job scrapes the full Cloudflare developer docs,
   * embeds each page, and upserts them into the SHARED Vectorize index under a
   * global namespace — so retrieval benefits EVERY room, not just this one. Only
   * present on the room whose admin started the run; synced so the dashboard can
   * show live progress and offer cancel.
   */
  docsIndex?: DocsIndexState;
}

/**
 * Live progress of the global "index the Cloudflare docs" background job.
 *
 * The job is admin-triggered from `/admin`, resumable, and runs in bounded
 * batches via the Agents SDK scheduler (it survives client disconnects and DO
 * restarts). Vectors are written to a GLOBAL namespace in the shared index with
 * deterministic ids derived from each page URL, so re-runs update in place
 * (never duplicate) and concurrent runs from different rooms are idempotent.
 */
export interface DocsIndexState {
  /** Lifecycle: idle (never run) → enumerating → indexing → done | error | cancelled. */
  status: "idle" | "enumerating" | "indexing" | "done" | "error" | "cancelled";
  /** Opaque id for the current run; stale scheduled ticks self-cancel when it changes. */
  runId?: string;
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
  by: string;
  ts: number;
}

/** A stored zone snapshot (a restore point), surfaced in the UI. */
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

/** One step in the onboarding checklist (mirrors Cloudflare's go-live path). */
export interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
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
  /** True if `rules` was truncated for sync size; full config still lives server-side. */
  truncated?: boolean;
  createdBy: string;
  ts: number;
}

/** A generated Terraform artifact the room can download. */
export interface TerraformArtifact {
  provider: string;
  files: Array<{ filename: string; content: string }>;
  rulesetCount?: number;
  ipListCount?: number;
  createdBy: string;
  ts: number;
}

/** Metadata attached to each chat message so the room knows who said what. */
export interface GlideMessageMetadata {
  name?: string;
  /** Internal event that should inform the model but stay hidden in the human transcript. */
  systemEvent?: "action_result";
}
