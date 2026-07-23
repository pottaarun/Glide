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
 * The Cloudflare API token can be provided two ways:
 *   1. In the GUI — stored AES-256-GCM **encrypted at rest** in this DO's SQLite,
 *      keyed off the Worker-held `GLIDE_TOKEN_KEY` secret. Never synced, logged,
 *      or returned; only a masked last-4 is exposed for status.
 *   2. The `CF_API_TOKEN` Worker secret (fallback).
 */

import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, getAgentByName, routeAgentRequest, type Connection } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  type StreamTextOnFinishCallback,
  type ToolSet,
  type UIMessage,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

import {
  cfGet,
  cfGetAll,
  cfRequest,
  findZoneByName,
  listAccounts,
  listZones,
  snapshotZone,
  verifyToken,
  type AccountSummary,
  type ZoneSummary,
} from "./cf-api";
import {
  INITIAL_GLIDE_STATE,
  type ActionResult,
  type DocChunk,
  type DocsIndexState,
  type GlideMessageMetadata,
  type GlideState,
  type GuidanceDoc,
  type Invite,
  type MigrationCheck,
  type MigrationPlan,
  type MigrationPlanRule,
  type OnboardingPath,
  type SnapshotInfo,
  type OnboardingState,
  type OnboardingStep,
  type PendingAction,
  type SetupType,
  type TerraformArtifact,
  type WriteMethod,
} from "./shared";
import {
  buildConfigData,
  captureZoneSnapshot,
  diffReport,
  exportMigrationCsv,
  fetchConfigFromUrl,
  generateMigrationTerraform,
  getZoneSnapshot,
  listMigrationProviders,
  listZoneSnapshots,
  migrationConfigured,
  preflightPermissions,
  previewProviderMigration,
  restoreZoneSnapshot,
  validateConfig,
  type MigrationConfigFormat,
  type MigrationTransport,
} from "./migration";
import { buildSystemPrompt } from "./system-prompt";
import { claimsNewQueuedAction, promisesToolAction, queueClaimCorrection } from "./chat-integrity";
import { redactCloudflareApiTokens } from "./chat-delivery";
import {
  APPLY_ATTEMPT_STALE_MS,
  formatActionResultEvent,
  isActionApplying,
  markActionApplying,
  markActionFailed,
  pendingActionStatus,
  recoverStaleActionAttempts,
} from "./action-lifecycle";
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
  deleteDocPage,
  fetchDocText,
  indexDocPage,
  parseProductIndex,
  parseTopIndex,
  retrieveDocChunks,
} from "./docs-scraper";

/** Keep this many finished results in synced state (full history lives in SQLite later). */
const MAX_RECENT_RESULTS = 25;
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
/**
 * Stable, well-known DO name that drives the weekly docs-refresh cron. Using one
 * fixed instance keeps the crawl bookkeeping (work queue + progress) in a single
 * place that never collides with a real room; deterministic vector ids
 * (docs-scraper.ts) keep it idempotent even if a room reindexes concurrently.
 */
const DOCS_SYSTEM_ROOM = "__system__";
/** Cloudflare rate-limiting periods (seconds) we snap a parsed period to. */
const RL_PERIODS = [10, 60, 120, 300, 600, 3600] as const;
/** Providers whose checks/migrations are zone-scoped (need a zone id). */
const CDN_MIGRATION_PROVIDERS = new Set(["akamai", "fastly", "imperva"]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WRITE_METHODS = new Set<WriteMethod>(["POST", "PUT", "PATCH", "DELETE"]);

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
  if (
    typeof action.path !== "string" ||
    !action.path.startsWith("/") ||
    action.path.length > 2_000 ||
    action.path.includes("://") ||
    /[\r\n\0]/.test(action.path)
  ) {
    return "Invalid Cloudflare API path.";
  }
  return undefined;
}

/** Resource-level fence for read/merge/write operations that must not interleave. */
function actionResourceKey(action: PendingAction): string | undefined {
  if (action.mergeEntrypoint && action.zoneId) {
    return `ruleset-entrypoint:${action.zoneId}:${action.mergeEntrypoint.phase}`;
  }
  if (action.method === "PUT" || action.method === "PATCH" || action.method === "DELETE") {
    return `${action.method}:${action.path}`;
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
 * It only ever ADDS completions — callers union the result with the existing
 * `done` flags and never uncheck, so manual checks and earlier auto-checks are
 * sticky. Returned ids that don't exist in the active checklist are ignored.
 */
function autoDoneSteps(
  ob: OnboardingState,
  signals: { migrationQueued: boolean; pending: PendingAction[]; results: ActionResult[] },
): Set<string> {
  const done = new Set<string>();

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
      done.add("migrate"); // migrate path
    }
    if (["rate limiting", "redirects", "cache", "origin", "request headers", "response headers"].includes(p)) {
      done.add("migrate");
    }
  };
  for (const a of signals.pending) consider(a.product, a.path, a.summary);
  for (const r of signals.results) if (r.status === "applied") consider(r.product, "", r.summary);

  return done;
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
  if (/\bpartial\b|\bcname\b/.test(t)) out.setupType = "partial";
  else if (/\bfull\b|\bprimary\b/.test(t)) out.setupType = "full";

  // Top-level path (migrate vs fresh).
  if (/\bmigrat/.test(t)) out.path = "migrate";
  else if (/\bstart(?:ing)?\s+fresh\b|\bfresh\b|\bfrom scratch\b|\bbrand[-\s]?new\b|\bnew to cloudflare\b/.test(t)) {
    out.path = "fresh";
  }

  // Goals / scope (what to set up). Canonical keys mirror the tool schema.
  const goals: string[] = [];
  if (/\bdns\b/.test(t)) goals.push("dns");
  if (/\bwaf\b|\bfirewall\b|\bsecurity\b|\bmanaged rules?\b/.test(t)) goals.push("waf");
  if (/\bcache\b|\bcaching\b|\bcdn\b|\bperformance\b/.test(t)) goals.push("cache");
  if (/\brate[-\s]?limit/.test(t)) goals.push("rate_limiting");
  if (/\bload[-\s]?balanc/.test(t)) goals.push("load_balancing");
  if (/\bzero[-\s]?trust\b|\bwarp\b|\bcloudflare access\b/.test(t)) goals.push("zero_trust");
  if (goals.length) out.goals = goals;

  // Domain: first plausible hostname that isn't Cloudflare's own.
  const m = text.match(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\b/i);
  if (m) {
    const d = m[1].toLowerCase();
    if (!/(?:^|\.)cloudflare\.com$/.test(d)) out.domain = d;
  }

  return out;
}

/** Map a provider's WAF action to a valid Cloudflare custom-rule action. */
function mapWafActionToCf(action?: string): { action: string; action_parameters?: Record<string, unknown> } {
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
  return { action: "block" };
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
  if (!Number.isFinite(requests) || requests <= 0) return undefined;
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
  const statusCode = code >= 300 && code < 400 ? code : 301;
  return {
    rule: {
      action: "redirect",
      expression: r.expression,
      description: r.name.slice(0, 1024),
      enabled: true,
      action_parameters: {
        from_value: {
          status_code: statusCode,
          target_url: { value: target },
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
  const cache = !["bypass", "no-store", "no_cache", "no-cache", "pass"].includes(a);
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
  const host = (r.detail ?? "").trim();
  if (!host || /\s/.test(host)) return { skip: "no clean origin host (export via Terraform)" };
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
  // Derive the header name from the preview's name field (akamai "… Header: X", fastly "set x").
  let header = "";
  const m1 = r.name.match(/header:\s*(.+)$/i);
  const m2 = r.name.match(/^(?:set|add|remove|delete|append|unset)\s+(.+)$/i);
  if (m1) header = m1[1].trim();
  else if (m2) header = m2[1].trim();
  if (!header) return { skip: "couldn't determine header name (export via Terraform)" };

  const op = HEADER_OP_MAP[(r.action ?? "set").toLowerCase()] ?? "set";
  const headerEntry: Record<string, unknown> =
    op === "remove" ? { operation: "remove" } : { operation: op, value: (r.detail ?? "").trim() || "" };
  return {
    rule: {
      action: "rewrite",
      expression: r.expression || "true",
      description: r.name.slice(0, 1024),
      enabled: true,
      action_parameters: { headers: { [header]: headerEntry } },
    },
  };
}

/** Keep only the fields Cloudflare accepts when re-PUTting an existing ruleset rule. */
function stripRuleForPut(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { action: r.action, expression: r.expression };
  if (r.description !== undefined) out.description = r.description;
  if (r.enabled !== undefined) out.enabled = r.enabled;
  if (r.action_parameters !== undefined) out.action_parameters = r.action_parameters;
  if (r.ratelimit !== undefined) out.ratelimit = r.ratelimit;
  return out;
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

  /** Room clients consume synced state but may only mutate it through validated RPCs. */
  validateStateChange(_nextState: GlideState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("Direct client state changes are not allowed.");
  }

  /** Best-effort: remember who triggered the current turn so queued actions are attributed. */
  private currentActor = "a teammate";
  /** Server-created approvals in the current chat turn; model prose is checked against this source of truth. */
  private queuedActionsThisTurn: PendingAction[] = [];

  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "text") return part;
      const text = redactCloudflareApiTokens(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, parts } : message;
  }

  async onStart(): Promise<void> {
    // Durable tables: zone snapshots (rollback breadcrumbs) + encrypted secrets.
    this.sql`CREATE TABLE IF NOT EXISTS glide_snapshots (
      action_id TEXT PRIMARY KEY,
      zone_id   TEXT,
      ts        INTEGER,
      data      TEXT
    )`;
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

    // Tokens pasted into old chat turns predate the persistence sanitizer.
    // Scrub them as each room wakes; this is idempotent and does not touch the
    // encrypted token stored in glide_secrets.
    const redactedMessages = this.messages.map((message) => this.sanitizeMessageForPersistence(message));
    const redactedCount = redactedMessages.reduce(
      (count, message, index) => count + (message === this.messages[index] ? 0 : 1),
      0,
    );
    if (redactedCount > 0) {
      await this.persistMessages(redactedMessages);
      this.logChatEvent("chat.secrets_redacted", { messageCount: redactedCount }, "warn");
    }

    const tokenConfigured = this.hasStoredToken() || Boolean(this.env.CF_API_TOKEN);
    const migrationToolConfigured = migrationConfigured(this.migrationTransport());
    const pendingActions = recoverStaleActionAttempts(this.state.pendingActions);
    const recoveredAction = pendingActions.some((action, i) => action !== this.state.pendingActions[i]);
    if (
      this.state.tokenConfigured !== tokenConfigured ||
      this.state.migrationToolConfigured !== migrationToolConfigured ||
      recoveredAction
    ) {
      this.setState({ ...this.state, tokenConfigured, migrationToolConfigured, pendingActions });
    }
  }

  // ---------------------------------------------------------------------------
  // Migration source persistence (server-side only; never synced).
  // ---------------------------------------------------------------------------

  private saveMigrationSource(provider: string, configData: unknown): void {
    this.sql`INSERT OR REPLACE INTO glide_migration_src (id, provider, data, ts)
      VALUES ('last', ${provider}, ${JSON.stringify(configData)}, ${Date.now()})`;
  }

  private loadMigrationSource(): { provider: string; configData: unknown } | null {
    const rows = this.sql<{ provider: string; data: string }>`
      SELECT provider, data FROM glide_migration_src WHERE id = 'last'`;
    const row = rows[0];
    if (!row) return null;
    try {
      return { provider: row.provider, configData: JSON.parse(row.data) };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Onboarding state (synced to the room; driven by the model and the UI).
  // ---------------------------------------------------------------------------

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
    let checklist = !ob.checklist.length || pathChanged ? checklistForPath(path) : ob.checklist;
    if (patch.checkOff?.length) {
      const set = new Set(patch.checkOff);
      checklist = checklist.map((s) => (set.has(s.id) ? { ...s, done: true } : s));
    }
    const next: OnboardingState = {
      ...ob,
      active: true,
      path,
      domain: patch.domain ?? ob.domain,
      setupType: patch.setupType ?? ob.setupType,
      migratingFrom: patch.migratingFrom ?? ob.migratingFrom,
      migratingFromLabel: patch.migratingFromLabel ?? ob.migratingFromLabel,
      goals: patch.goals ?? ob.goals,
      configProvided: patch.configProvided ?? ob.configProvided,
      dnsReviewed: patch.dnsReviewed ?? ob.dnsReviewed,
      completed: patch.completed ?? ob.completed,
      checklist,
      updatedBy: by,
      ts: Date.now(),
    };
    // Auto-complete any checklist steps whose required info is now captured.
    const auto = autoDoneSteps(next, {
      migrationQueued: !!this.state.migrationPlan?.rules.some((r) => r.queued),
      pending: this.state.pendingActions,
      results: this.state.recentResults,
    });
    next.checklist = next.checklist.map((s) => (s.done || auto.has(s.id) ? { ...s, done: true } : s));
    this.setState({ ...this.state, onboarding: next });
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
      migrationQueued: !!this.state.migrationPlan?.rules.some((r) => r.queued),
      pending: this.state.pendingActions,
      results: this.state.recentResults,
    });
    let changed = false;
    const checklist = ob.checklist.map((s) => {
      if (!s.done && auto.has(s.id)) {
        changed = true;
        return { ...s, done: true };
      }
      return s;
    });
    if (changed) this.setState({ ...this.state, onboarding: { ...ob, checklist, ts: Date.now() } });
  }

  @callable()
  async startOnboarding(by = "someone"): Promise<{ ok: true }> {
    this.applyOnboardingPatch({}, by);
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
  ): Promise<{ ok: true }> {
    this.applyOnboardingPatch(patch ?? {}, by);
    return { ok: true };
  }

  @callable()
  async completeOnboarding(by = "someone"): Promise<{ ok: true }> {
    this.applyOnboardingPatch({ completed: true }, by);
    return { ok: true };
  }

  /**
   * UI: wipe THIS room's onboarding so the guided flow starts over from scratch.
   * Clears the path, domain, DNS setup, goals, and checklist by dropping the
   * whole `onboarding` object back to the brand-new-room state (undefined). The
   * room's pending approvals, chat history, token, memory, and defaults are left
   * untouched — this only resets the guided-setup progress, not the room. A
   * hard refresh reconnects to the same durable room, so this is the intended
   * way to "start fresh" without opening a new room URL.
   */
  @callable()
  async resetOnboarding(_by = "someone"): Promise<{ ok: true }> {
    this.setState({ ...this.state, onboarding: undefined });
    return { ok: true };
  }

  /** UI wizard: run a read-only provider-config preview (parses + stores the plan). */
  @callable()
  async previewMigration(
    args: {
      provider: string;
      config?: string;
      configUrl?: string;
      configFiles?: Array<{ filename: string; content: string }>;
      format?: MigrationConfigFormat;
    },
    by = "someone",
  ): Promise<{ ok: boolean; message: string; totalRules?: number; phases?: Array<{ key: string; label: string; count: number }> }> {
    this.currentActor = by;
    if (!migrationConfigured(this.migrationTransport())) {
      return { ok: false, message: this.notConfigured() };
    }
    const resolved = await this.resolveConfigData(args);
    if (!resolved.ok) return { ok: false, message: resolved.message };
    const res = await this.runPreview(args.provider, resolved.data);
    if (!res.ok) return { ok: false, message: res.message };
    this.applyOnboardingPatch({ configProvided: true, migratingFrom: args.provider, checkOff: ["preview"] }, by);
    return {
      ok: true,
      message: res.phaseSummary || "Parsed (no rules detected).",
      totalRules: res.plan.totalRules,
      phases: res.plan.phases,
    };
  }

  @callable()
  async toggleOnboardingStep(id: string, done: boolean, by = "someone"): Promise<{ ok: boolean }> {
    const ob = this.state.onboarding;
    if (!ob) return { ok: false };
    const checklist = ob.checklist.map((s) => (s.id === id ? { ...s, done } : s));
    this.setState({
      ...this.state,
      onboarding: { ...ob, checklist, updatedBy: by, ts: Date.now() },
    });
    return { ok: true };
  }

  /** UI: pre-flight permission check for the room's migration plan. */
  @callable()
  async runPreflight(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; summary: string }> {
    this.currentActor = by;
    return this.doPreflight(zoneId, by);
  }

  /** UI: pre-migration diff (what already exists in the target zone). */
  @callable()
  async runDiffReport(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; summary: string }> {
    this.currentActor = by;
    return this.doDiff(zoneId, by);
  }

  /** UI: post-migration validation — verify queued rules landed in the zone. */
  @callable()
  async runValidate(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; summary: string }> {
    this.currentActor = by;
    return this.doValidate(zoneId, by);
  }

  /** UI: export the migration plan's config as CSV. */
  @callable()
  async exportMigrationCsv(by = "someone"): Promise<{ ok: boolean; message: string }> {
    this.currentActor = by;
    return this.doExportCsv({});
  }

  /** UI: capture a full zone snapshot (restore point). Read-only on Cloudflare. */
  @callable()
  async snapshotZone(zoneId: string | undefined, by = "someone"): Promise<{ ok: boolean; message: string }> {
    this.currentActor = by;
    return this.doSnapshot(zoneId);
  }

  /** UI: refresh the list of stored snapshots into synced state. */
  @callable()
  async refreshSnapshots(zoneId?: string): Promise<{ ok: boolean; message?: string }> {
    return this.doRefreshSnapshots(zoneId);
  }

  /**
   * UI: restore a zone to a captured snapshot. DESTRUCTIVE — reverts the zone to
   * the snapshot, removing changes made since. Human-only (never an LLM tool).
   */
  @callable()
  async restoreSnapshot(
    snapshotId: string,
    zoneId: string | undefined,
    by = "someone",
  ): Promise<{ ok: boolean; message: string }> {
    this.currentActor = by;
    return this.doRestore(snapshotId, zoneId, by);
  }

  // ---------------------------------------------------------------------------
  // Token storage (encrypted at rest) — never synced or returned in plaintext.
  // ---------------------------------------------------------------------------

  private hasStoredToken(): boolean {
    const rows = this.sql<{ name: string }>`
      SELECT name FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`;
    return rows.length > 0;
  }

  /** Resolve the active token: GUI-set (decrypted) first, then the Worker secret. */
  private async getToken(): Promise<string> {
    const key = this.env.GLIDE_TOKEN_KEY;
    if (key) {
      const rows = this.sql<{ value: string }>`
        SELECT value FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`;
      const packed = rows[0]?.value;
      if (packed) {
        try {
          return await decryptSecret(key, packed);
        } catch {
          // Corrupt/rotated key — fall through to the env secret.
        }
      }
    }
    return this.env.CF_API_TOKEN ?? "";
  }

  @callable()
  async setCloudflareToken(rawToken: string): Promise<{ ok: boolean; message: string }> {
    const token = (rawToken ?? "").trim();
    if (!token) return { ok: false, message: "Token was empty." };
    if (!this.env.GLIDE_TOKEN_KEY) {
      return {
        ok: false,
        message:
          "Server can't store a token securely yet — GLIDE_TOKEN_KEY is not set. Ask an operator to run `wrangler secret put GLIDE_TOKEN_KEY`.",
      };
    }

    // Check authentication before trusting, but store regardless so the user can
    // retry if all verification reads fail transiently for an otherwise-valid token.
    const verify = await verifyToken(token);
    const packed = await encryptSecret(this.env.GLIDE_TOKEN_KEY, token);
    this.sql`INSERT OR REPLACE INTO glide_secrets (name, value, ts)
      VALUES (${TOKEN_SECRET_NAME}, ${packed}, ${Date.now()})`;

    this.setState({
      ...this.state,
      tokenConfigured: true,
      tokenLast4: token.slice(-4),
      tokenValid: verify.valid,
    });

    return {
      ok: true,
      message: verify.valid
        ? "Token saved (encrypted at rest) and verified ✓"
        : `Token saved (encrypted), but verification said: ${verify.message}. You can still try applying changes.`,
    };
  }

  @callable()
  async clearCloudflareToken(): Promise<{ ok: true }> {
    this.sql`DELETE FROM glide_secrets WHERE name = ${TOKEN_SECRET_NAME}`;
    this.setState({
      ...this.state,
      tokenConfigured: Boolean(this.env.CF_API_TOKEN),
      tokenLast4: undefined,
      tokenValid: undefined,
    });
    return { ok: true };
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
    const token = await this.getToken();
    if (!token) {
      if (this.state.tokenValid !== undefined) {
        this.setState({ ...this.state, tokenValid: undefined });
      }
      return { ok: false, valid: false, message: "No Cloudflare API token is configured." };
    }
    const verify = await verifyToken(token);
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
      raw?.kind === "not_delivered" || raw?.kind === "response_interrupted"
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

  // ---------------------------------------------------------------------------
  // Invites
  // ---------------------------------------------------------------------------

  @callable()
  async inviteTeammate(
    email: string,
    by = "someone",
    link?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const e = (email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(e)) {
      return { ok: false, message: `"${email}" doesn't look like a valid email address.` };
    }
    const already = this.state.invites.some((i) => i.email === e);
    if (!already) {
      const invite: Invite = { email: e, invitedBy: by, link, ts: Date.now() };
      this.setState({ ...this.state, invites: [invite, ...this.state.invites].slice(0, 100) });
    }
    return { ok: true, message: already ? `${e} was already invited.` : `Invited ${e}.` };
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
    const title = (input?.title ?? "").trim().slice(0, 120);
    const body = (input?.body ?? "").trim().slice(0, MAX_GUIDANCE_BODY);
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
      updatedBy: by,
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
  async deleteGuidanceDoc(id: string): Promise<{ ok: true }> {
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
  // Cloudflare docs RAG (admin-triggered global reindex + per-message retrieval)
  //
  // A resumable background job scrapes the FULL Cloudflare developer docs, embeds
  // each page, and upserts them into the SHARED Vectorize index under a GLOBAL
  // namespace (docs-scraper.ts) — so EVERY room's chat retrieves grounding
  // excerpts, not just this one. It runs in bounded batches chained via the
  // Agents SDK scheduler, so it survives client disconnects and DO restarts.
  // Progress is mirrored into `state.docsIndex` for the /admin dashboard. The job
  // is global but bookkeeping (the work queue + progress) lives on whichever
  // room's DO started it; deterministic vector ids make concurrent runs idempotent.
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

  /**
   * Start (or restart) a full Cloudflare-docs reindex. Fetches the top-level
   * index synchronously so we can report the product total immediately, seeds the
   * work queue, then hands off to `docsTick` via the scheduler. The heavy lifting
   * (per-product enumeration + per-page embed/upsert) happens in the background.
   */
  @callable()
  async startDocsReindex(by = "an admin"): Promise<{ ok: boolean; message: string }> {
    if (!hasVectorize(this.env)) {
      return {
        ok: false,
        message: "Semantic search isn't configured for this deployment (no Vectorize index).",
      };
    }
    const cur = this.docsState();
    if (cur.status === "enumerating" || cur.status === "indexing") {
      return { ok: false, message: "A docs reindex is already running — cancel it first to restart." };
    }

    const md = await fetchDocText(DOCS_ROOT_INDEX);
    if (md == null) {
      this.setDocsState({
        status: "error",
        error: "Couldn't fetch the Cloudflare docs index.",
        finishedAt: Date.now(),
      });
      return { ok: false, message: "Couldn't fetch the Cloudflare docs index — try again shortly." };
    }
    const products = parseTopIndex(md);
    if (!products.length) {
      this.setDocsState({
        status: "error",
        error: "The docs index listed no products (the format may have changed).",
        finishedAt: Date.now(),
      });
      return { ok: false, message: "The docs index looked empty — the format may have changed." };
    }

    // Reset the work queue for a clean run.
    this.sql`DELETE FROM glide_docs_products`;
    this.sql`DELETE FROM glide_docs_pages`;
    for (const p of products) {
      this.sql`INSERT OR REPLACE INTO glide_docs_products (product, label, url, category, enumerated)
        VALUES (${p.product}, ${p.label}, ${p.url}, ${p.category}, 0)`;
    }

    const runId = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.setState({
      ...this.state,
      docsIndex: {
        status: "enumerating",
        runId,
        productsTotal: products.length,
        productsEnumerated: 0,
        pagesTotal: 0,
        pagesIndexed: 0,
        pagesFailed: 0,
        chunksUpserted: 0,
        startedBy: by,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    await this.schedule(DOCS_TICK_DELAY_SEC, "docsTick", { runId });
    return {
      ok: true,
      message: `Indexing ${products.length} Cloudflare products in the background — progress updates here.`,
    };
  }

  /**
   * One bounded unit of reindex work, invoked by the scheduler and re-armed by
   * itself until the queue drains. Phase 1 enumerates one product's page list;
   * phase 2 embeds+upserts a batch of pending pages. Stale ticks (from a
   * cancelled/superseded run — matched on `runId`) return without rescheduling,
   * which cleanly kills the chain. Per-page failures are recorded, not fatal.
   */
  async docsTick(payload?: { runId?: string }): Promise<void> {
    const state = this.docsState();
    if (!payload?.runId || payload.runId !== state.runId) return; // stale/cancelled
    if (state.status !== "enumerating" && state.status !== "indexing") return;

    try {
      // Phase 1 — enumerate one un-enumerated product into the page queue.
      const prod = this.sql<{ product: string; label: string; url: string }>`
        SELECT product, label, url FROM glide_docs_products WHERE enumerated = 0 LIMIT 1`[0];
      if (prod) {
        const md = await fetchDocText(prod.url);
        if (md != null) {
          for (const pg of parseProductIndex(md)) {
            this.sql`INSERT OR IGNORE INTO glide_docs_pages (url, product, title, section, status, chunks)
              VALUES (${pg.url}, ${prod.label}, ${pg.title}, ${pg.section}, ${DOCS_PAGE_PENDING}, 0)`;
          }
        }
        this.sql`UPDATE glide_docs_products SET enumerated = 1 WHERE product = ${prod.product}`;
        const c = this.docsCounts();
        this.setDocsState({
          status: "enumerating",
          currentProduct: prod.label,
          productsTotal: c.productsTotal,
          productsEnumerated: c.productsEnumerated,
          pagesTotal: c.pagesTotal,
        });
        await this.schedule(DOCS_TICK_DELAY_SEC, "docsTick", { runId: payload.runId });
        return;
      }

      // Phase 2 — index a batch of pending pages.
      const pageRows = this.sql<{ url: string; product: string; title: string; section: string }>`
        SELECT url, product, title, section FROM glide_docs_pages
        WHERE status = ${DOCS_PAGE_PENDING} LIMIT ${DOCS_PAGES_PER_TICK}`;
      if (pageRows.length) {
        for (const row of pageRows) {
          // Re-check cancellation between pages so Cancel is responsive.
          if (this.docsState().runId !== payload.runId) return;
          const res = await indexDocPage(
            this.env,
            { url: row.url, title: row.title, section: row.section },
            row.product,
          );
          if (res.ok) {
            this.sql`UPDATE glide_docs_pages SET status = ${DOCS_PAGE_DONE}, chunks = ${res.chunks} WHERE url = ${row.url}`;
          } else {
            this.sql`UPDATE glide_docs_pages SET status = ${DOCS_PAGE_FAILED} WHERE url = ${row.url}`;
          }
        }
        const c = this.docsCounts();
        const done = c.pagesPending === 0;
        this.setDocsState({
          status: done ? "done" : "indexing",
          currentProduct: pageRows[pageRows.length - 1]?.product,
          productsTotal: c.productsTotal,
          productsEnumerated: c.productsEnumerated,
          pagesTotal: c.pagesTotal,
          pagesIndexed: c.pagesIndexed,
          pagesFailed: c.pagesFailed,
          chunksUpserted: c.chunksUpserted,
          ...(done ? { finishedAt: Date.now(), currentProduct: undefined } : {}),
        });
        if (!done) await this.schedule(DOCS_TICK_DELAY_SEC, "docsTick", { runId: payload.runId });
        return;
      }

      // All products enumerated and no pending pages → done.
      const c = this.docsCounts();
      this.setDocsState({
        status: "done",
        currentProduct: undefined,
        productsTotal: c.productsTotal,
        productsEnumerated: c.productsEnumerated,
        pagesTotal: c.pagesTotal,
        pagesIndexed: c.pagesIndexed,
        pagesFailed: c.pagesFailed,
        chunksUpserted: c.chunksUpserted,
        finishedAt: Date.now(),
      });
    } catch (err) {
      this.setDocsState({
        status: "error",
        error: (err as Error)?.message ?? String(err),
        finishedAt: Date.now(),
      });
    }
  }

  /**
   * Cancel a running reindex. We flip status to "cancelled" and clear the runId;
   * the next scheduled tick sees the mismatch and stops without rescheduling, so
   * no explicit alarm cancellation is needed. Work already indexed is kept.
   */
  @callable()
  async cancelDocsReindex(): Promise<{ ok: true; message: string }> {
    const cur = this.docsState();
    if (cur.status === "enumerating" || cur.status === "indexing") {
      this.setDocsState({
        status: "cancelled",
        runId: undefined,
        currentProduct: undefined,
        finishedAt: Date.now(),
      });
      return { ok: true, message: "Reindex cancelling — the background job stops on its next step." };
    }
    return { ok: true, message: "No reindex is running." };
  }

  /**
   * Remove every doc vector this room indexed (by reconstructing deterministic
   * ids from the page queue) and reset the work queue. Refuses while a run is in
   * flight — cancel first.
   */
  @callable()
  async clearDocsIndex(): Promise<{ ok: boolean; message: string; deleted: number }> {
    const cur = this.docsState();
    if (cur.status === "enumerating" || cur.status === "indexing") {
      return { ok: false, message: "Cancel the running reindex before clearing.", deleted: 0 };
    }
    const rows = this.sql<{ url: string; chunks: number }>`
      SELECT url, chunks FROM glide_docs_pages WHERE status = ${DOCS_PAGE_DONE} AND chunks > 0`;
    let deleted = 0;
    for (const r of rows) {
      await deleteDocPage(this.env, r.url, Number(r.chunks));
      deleted += Number(r.chunks);
    }
    this.sql`DELETE FROM glide_docs_pages`;
    this.sql`DELETE FROM glide_docs_products`;
    this.setState({
      ...this.state,
      docsIndex: {
        status: "idle",
        productsTotal: 0,
        productsEnumerated: 0,
        pagesTotal: 0,
        pagesIndexed: 0,
        pagesFailed: 0,
        chunksUpserted: 0,
        updatedAt: Date.now(),
      },
    });
    return {
      ok: true,
      message: `Cleared ${deleted} doc chunk${deleted === 1 ? "" : "s"} from the shared index.`,
      deleted,
    };
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

  // ---------------------------------------------------------------------------
  // Chat brain
  // ---------------------------------------------------------------------------

  private logChatEvent(
    event: string,
    details: Record<string, string | number | boolean | undefined> = {},
    level: "info" | "warn" | "error" = "info",
  ): void {
    const payload = { glideEvent: event, room: this.name, ...details };
    if (level === "error") console.error(payload);
    else if (level === "warn") console.warn(payload);
    else console.log(payload);
  }

  async onChatMessage(
    onFinish: OnChatFinish,
    options?: { abortSignal?: AbortSignal; body?: Record<string, unknown> },
  ): Promise<Response | undefined> {
    this.currentActor = this.resolveActor(options?.body);
    this.queuedActionsThisTurn = [];

    const turnId = crypto.randomUUID();
    const latestMessage = this.messages[this.messages.length - 1];
    const isActionResultEvent =
      latestMessage?.role === "user" &&
      (latestMessage.metadata as GlideMessageMetadata | undefined)?.systemEvent === "action_result";
    this.logChatEvent("chat.received", {
      turnId,
      messageId: latestMessage?.id ?? "unknown",
      messageCount: this.messages.length,
      actionResultEvent: isActionResultEvent,
    });

    const workersai = createWorkersAI({ binding: dedupAIBinding(this.env.AI) });
    const model = workersai(this.env.GLIDE_MODEL);

    const messages = await convertToModelMessages(this.messages);

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
      if (Object.keys(patch).length) this.applyOnboardingPatch(patch, this.currentActor);
    }

    // RAG (run both retrievals concurrently): pick the guidance docs most
    // relevant to this turn (or all, for small rooms / when semantic search is
    // unavailable), and pull grounding excerpts from the indexed Cloudflare docs.
    // Both fall back to undefined so the prompt degrades gracefully.
    const [guidanceForPrompt, docsForPrompt] = await Promise.all([
      this.selectGuidanceForPrompt(messages),
      this.selectDocsForPrompt(messages),
    ]);
    this.logChatEvent("chat.prepared", {
      turnId,
      guidanceCount: guidanceForPrompt?.length ?? 0,
      docsCount: docsForPrompt?.length ?? 0,
    });
    const system = buildSystemPrompt(this.state, guidanceForPrompt, docsForPrompt);
    const tools = this.buildTools();
    const abortSignal = options?.abortSignal;

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
        const emitQueueNarration = (chunks: Chunk[], label: string): boolean => {
          const prose = assistantProse(textFromChunks(chunks));
          if (!this.queuedActionsThisTurn.length && !claimsNewQueuedAction(prose)) {
            return false;
          }

          // Tool chunks remain visible, but free-form queue narration is replaced
          // with an exact summary derived from actions server code created.
          writeChunks(chunks, false);
          console.warn(`Replaced model queue narration with server state in ${label}.`);
          appendText(this.authoritativeQueueNarration());
          return true;
        };
        stage = "model.initial";
        const first = streamText({
          model,
          system,
          messages,
          tools,
          stopWhen: stepCountIs(8),
          abortSignal,
          onFinish,
        });
        // sendReasoning:false — gpt-oss streams a harmony "reasoning" channel, and
        // the client renders reasoning parts as visible chat text (main.tsx). Keep
        // the model's chain-of-thought out of the room; only its final prose shows.
        const firstChunks = await collect(
          first.toUIMessageStream({ sendFinish: false, sendReasoning: false }),
        );
        stage = "model.initial.complete";
        const firstText = textFromChunks(firstChunks);
        this.logChatEvent("chat.model_pass", {
          turnId,
          stage,
          chunkCount: firstChunks.length,
          textLength: firstText.length,
          queuedActions: this.queuedActionsThisTurn.length,
        });

        // A tool-less pass (`toolChoice: "none"`) that forces the model to put
        // WORDS to what just happened — used whenever a turn would otherwise end
        // with no forward motion. `narrate` shapes what it should say.
        const runNarration = async (
          responseMessages: Awaited<typeof first.response>["messages"],
          narrate: string,
        ): Promise<void> => {
          stage = "model.narration";
          const narration = streamText({
            model,
            system: `${system}\n\n${narrate}`,
            messages: [...messages, ...responseMessages],
            toolChoice: "none",
            abortSignal,
          });
          const narrationChunks = await collect(
            narration.toUIMessageStream({ sendStart: false, sendFinish: false, sendReasoning: false }),
          );
          if (emitQueueNarration(narrationChunks, "chat narration")) {
            writer.write({ type: "finish" });
            return;
          }
          writeChunks(narrationChunks, false);
          const narrationProse = assistantProse(textFromChunks(narrationChunks));
          if (promisesToolAction(narrationProse)) {
            appendText(this.unfulfilledActionNarration(), true);
          } else {
            appendText(narrationProse, true);
          }
          writer.write({ type: "finish" });
        };

        if (abortSignal?.aborted) {
          outcome = "aborted";
          if (!emitQueueNarration(firstChunks, "aborted initial chat response")) {
            writeChunks(firstChunks, false);
            appendText("The response was interrupted before that step completed. Please retry the request.");
          }
          writer.write({ type: "finish" });
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
          `In one or two short, warm sentences, tell ${this.currentActor} what you just ` +
          `captured and clearly state the next onboarding step or question. ` +
          `Server-confirmed approvals created this turn: ${this.queuedActionsThisTurn.length}. ` +
          `If that number is zero, explicitly say that nothing was queued.`;

        if (emitQueueNarration(firstChunks, "initial chat response")) {
          writer.write({ type: "finish" });
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
            `tell ${this.currentActor} the result and the next step. Do not paste JSON.`;
          const cont = streamText({
            model,
            system: `${system}\n\n${nudge}`,
            messages: [...messages, ...responseMessages],
            tools,
            toolChoice: "required",
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
          if (emitQueueNarration(contChunks, "tool continuation")) {
            writer.write({ type: "finish" });
            return;
          }
          if (assistantProse(contText).length === 0 && !abortSignal?.aborted) {
            writeChunks(contChunks);
            await runNarration(responseMessages, captureNarrate);
          } else if (promisesToolAction(assistantProse(contText))) {
            writeChunks(contChunks, false);
            appendText(this.unfulfilledActionNarration(), true);
            writer.write({ type: "finish" });
          } else {
            writeChunks(contChunks);
            writer.write({ type: "finish" });
          }
          return;
        }

        // Case B — a tool ran but the model produced no prose (only tool-call
        // JSON / tokens that strip to empty): narrate what happened.
        if (prose.length === 0) {
          writeChunks(firstChunks);
          await runNarration(responseMessages, captureNarrate);
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
          appendText(this.unfulfilledActionNarration());
          writer.write({ type: "finish" });
          return;
        }

        // Pass 1 produced real prose that moves forward.
        writeChunks(firstChunks);
        writer.write({ type: "finish" });
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
              queuedActions: this.queuedActionsThisTurn.length,
            },
            outcome === "error" ? "error" : outcome === "aborted" ? "warn" : "info",
          );
        }
      },
    });

    this.logChatEvent("chat.stream_created", { turnId });
    return createUIMessageStreamResponse({ stream });
  }

  /** Prefer the name sent on the request body, then the latest user message's metadata. */
  private resolveActor(body?: Record<string, unknown>): string {
    const fromBody = typeof body?.name === "string" ? body.name.trim() : "";
    if (fromBody) return fromBody;

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "user") continue;
      const name = (m.metadata as GlideMessageMetadata | undefined)?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
      break;
    }
    return "a teammate";
  }

  // ---------------------------------------------------------------------------
  // Tools — reads run now; writes only QUEUE a pending action.
  // ---------------------------------------------------------------------------

  private buildTools(): ToolSet {
    const tools = {
      // ---- READ / DISCOVERY -------------------------------------------------
      list_accounts: tool({
        description: "List Cloudflare accounts this token can see. Runs immediately.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await listAccounts(await this.getToken());
          if (!res.ok) return this.readError(res);
          this.noteTokenOutcome(res);
          return clip(res.result.map((a: AccountSummary) => ({ id: a.id, name: a.name })));
        },
      }),

      list_zones: tool({
        description:
          "List zones (domains), optionally filtered to one account id. Runs immediately.",
        inputSchema: z.object({
          accountId: z.string().optional().describe("Restrict to a single account id."),
        }),
        execute: async ({ accountId }) => {
          const res = await listZones(await this.getToken(), accountId);
          if (!res.ok) return this.readError(res);
          this.noteTokenOutcome(res);
          return clip(
            res.result.map((z: ZoneSummary) => ({ id: z.id, name: z.name, status: z.status })),
          );
        },
      }),

      find_zone: tool({
        description:
          "Resolve a zone id by its domain name and remember it as the room's default zone. Runs immediately.",
        inputSchema: z.object({ name: z.string().describe('Domain, e.g. "example.com".') }),
        execute: async ({ name }) => {
          const res = await findZoneByName(await this.getToken(), name);
          if (!res.ok) return this.readError(res);
          this.noteTokenOutcome(res);
          const zone = { id: res.result.id, name: res.result.name };
          this.setState({ ...this.state, defaultZone: zone });
          return `Found zone ${zone.name} → ${zone.id}. Saved as the room's default zone.`;
        },
      }),

      list_dns_records: tool({
        description: "List DNS records for a zone. Runs immediately.",
        inputSchema: z.object({
          zoneId: z.string(),
          type: z.string().optional().describe('Filter by record type, e.g. "A", "CNAME".'),
        }),
        execute: async ({ zoneId, type }) => {
          const q = type ? `?type=${encodeURIComponent(type)}` : "";
          const res = await cfGetAll<Record<string, unknown>>(
            `/zones/${zoneId}/dns_records${q}`,
            await this.getToken(),
          );
          if (!res.ok) return this.readError(res);
          // Reviewing scanned DNS records completes the "review DNS records" step.
          if (this.state.onboarding?.active && !this.state.onboarding.dnsReviewed) {
            this.applyOnboardingPatch({ dnsReviewed: true }, this.currentActor);
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
          "Generic READ against any Cloudflare API GET endpoint. Use for products without a dedicated read tool. Runs immediately and changes nothing.",
        inputSchema: z.object({
          path: z
            .string()
            .describe('Path after https://api.cloudflare.com/client/v4, e.g. "/zones/<id>/settings".'),
        }),
        execute: async ({ path }) => {
          const res = await cfGet(path.startsWith("/") ? path : `/${path}`, await this.getToken());
          if (!res.ok) return this.readError(res);
          return clip(res.result);
        },
      }),

      // ---- MEMORY + COLLABORATION ------------------------------------------
      remember: tool({
        description:
          "Store a durable fact for this room (account id, naming conventions, preferences). Persists across restarts.",
        inputSchema: z.object({ key: z.string(), value: z.string() }),
        execute: async ({ key, value }) => {
          this.setState({ ...this.state, memory: { ...this.state.memory, [key]: value } });
          return `Remembered "${key}".`;
        },
      }),

      set_defaults: tool({
        description: "Set the room's default account id and/or default zone so users needn't repeat ids.",
        inputSchema: z.object({
          accountId: z.string().optional(),
          zoneId: z.string().optional(),
          zoneName: z.string().optional(),
        }),
        execute: async ({ accountId, zoneId, zoneName }) => {
          const next: GlideState = { ...this.state };
          if (accountId) next.defaultAccountId = accountId;
          if (zoneId && zoneName) next.defaultZone = { id: zoneId, name: zoneName };
          this.setState(next);
          return "Updated room defaults.";
        },
      }),

      invite_teammate: tool({
        description:
          "Record an invite for someone by email so they show up in the room's invite list. Tell the user to share the room link (top-right) or use the Invite panel to email it.",
        inputSchema: z.object({ email: z.string().describe("Email address to invite.") }),
        execute: async ({ email }) => {
          const res = await this.inviteTeammate(email, this.currentActor);
          return res.message;
        },
      }),

      // ---- WRITES — these only QUEUE a pending action ----------------------
      add_domain: tool({
        description:
          "QUEUE adding a domain (zone) to Cloudflare for human approval. Call this the moment onboarding has a domain to add — it creates a pending \"Add domain\" action a human clicks Apply to execute. Does NOT add it immediately. If you don't pass an accountId, it uses the room's default account or, when a token is available, auto-resolves it (asking you to choose only if the token sees several accounts).",
        inputSchema: z.object({
          name: z.string().describe('The domain to add, bare hostname only, e.g. "example.com" (no scheme, no path).'),
          accountId: z
            .string()
            .optional()
            .describe("Account id to create the zone under. Omit to use the room default / auto-resolve."),
          setupType: z
            .enum(["full", "partial"])
            .optional()
            .describe('"full" = Cloudflare is primary DNS (default, recommended); "partial" = CNAME setup (Business/Enterprise).'),
        }),
        execute: async ({ name, accountId, setupType }) => {
          const domain = name
            .trim()
            .replace(/^https?:\/\//i, "")
            .replace(/\/.*$/, "")
            .replace(/\.$/, "")
            .toLowerCase();
          if (!domain || !domain.includes(".") || /\s/.test(domain)) {
            return `"${name}" doesn't look like a domain. Give me the bare hostname, e.g. "example.com", and I'll queue it.`;
          }

          // Resolve which account to create the zone under. Reads (listAccounts)
          // run now; the write itself is only ever QUEUED below.
          let acct = (accountId ?? this.state.defaultAccountId ?? "").trim();
          if (!acct) {
            const token = await this.getToken();
            if (!token) {
              return (
                `I can add **${domain}**, but I need to know which Cloudflare account it goes under, and ` +
                `there's no API token in this room yet to look that up. Add a Cloudflare API token in the ` +
                `sidebar (it's encrypted at rest) or tell me the account id, and I'll queue the domain for approval.`
              );
            }
            const res = await listAccounts(token);
            if (!res.ok) return this.readError(res);
            if (res.result.length === 0) {
              return `This token can't see any Cloudflare accounts, so I can't add ${domain}. Check the token's account permissions.`;
            }
            if (res.result.length > 1) {
              const list = res.result.map((a: AccountSummary) => `${a.name} (${a.id})`).join(", ");
              return `This token can see several accounts: ${list}. Which one should **${domain}** go under? Tell me the account id and I'll queue it.`;
            }
            acct = res.result[0].id;
            this.setState({ ...this.state, defaultAccountId: acct });
          }

          const type = setupType === "partial" ? "partial" : "full";
          return this.queuePending({
            product: "Zones",
            summary: `Add domain ${domain} (${type} setup)`,
            method: "POST",
            path: "/zones",
            body: { name: domain, account: { id: acct }, type },
          });
        },
      }),

      create_dns_record: tool({
        description:
          "QUEUE creating a DNS record for human approval. Does NOT create it — a person must click Apply.",
        inputSchema: z.object({
          zoneId: z.string(),
          type: z.string().describe('Record type, e.g. "A", "AAAA", "CNAME", "TXT", "MX".'),
          name: z.string().describe('Record name, e.g. "www" or "@" for the root.'),
          content: z.string().describe("Record value (IP, target hostname, text, …)."),
          ttl: z.number().int().optional().describe("TTL seconds; 1 means automatic."),
          proxied: z.boolean().optional().describe("Whether to proxy through Cloudflare (orange cloud)."),
          priority: z.number().int().optional().describe("Priority (MX/SRV only)."),
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
          });
        },
      }),

      set_zone_setting: tool({
        description:
          'QUEUE changing a zone setting (e.g. "security_level", "ssl", "always_use_https") for human approval. Does NOT apply it.',
        inputSchema: z.object({
          zoneId: z.string(),
          setting: z.string().describe('Setting id, e.g. "security_level".'),
          value: z.union([z.string(), z.number(), z.boolean()]).describe("New value."),
        }),
        execute: async ({ zoneId, setting, value }) => {
          return this.queuePending({
            product: "Zone settings",
            summary: `Set ${setting} = ${String(value)}`,
            method: "PATCH",
            path: `/zones/${zoneId}/settings/${setting}`,
            body: { value },
            zoneId,
          });
        },
      }),

      create_waf_custom_rule: tool({
        description:
          "QUEUE adding a WAF custom rule to a ruleset for human approval. First use cf_get on /zones/<id>/rulesets to find the http_request_firewall_custom ruleset id. Does NOT apply it.",
        inputSchema: z.object({
          zoneId: z.string(),
          rulesetId: z
            .string()
            .describe("Id of the zone's http_request_firewall_custom entrypoint ruleset."),
          description: z.string(),
          expression: z.string().describe('Wirefilter expression, e.g. ip.geoip.country eq "RU".'),
          action: z.string().describe('Action: "block", "managed_challenge", "js_challenge", "log", "skip".'),
        }),
        execute: async ({ zoneId, rulesetId, description, expression, action }) => {
          return this.queuePending({
            product: "WAF",
            summary: `${action} when ${expression} — ${description}`,
            method: "POST",
            path: `/zones/${zoneId}/rulesets/${rulesetId}/rules`,
            body: { action, expression, description, enabled: true },
            zoneId,
          });
        },
      }),

      cf_write: tool({
        description:
          "QUEUE any Cloudflare API change (POST/PUT/PATCH/DELETE) for human approval. Use for products without a dedicated builder (Gateway, Access, Tunnels, R2, Load Balancing, cache/redirect rules, …). Does NOT execute it — a human must Apply.",
        inputSchema: z.object({
          product: z.string().describe('Short product label for the UI, e.g. "Gateway", "Cache".'),
          summary: z.string().describe("One-line human description of the change."),
          method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
          path: z
            .string()
            .describe('Path after https://api.cloudflare.com/client/v4, e.g. "/accounts/<id>/gateway/rules".'),
          body: z.record(z.string(), z.unknown()).optional().describe("JSON body to send."),
          zoneId: z.string().optional().describe("Zone id this targets (snapshotted before Apply)."),
        }),
        execute: async ({ product, summary, method, path, body, zoneId }) => {
          return this.queuePending({
            product,
            summary,
            method: method as WriteMethod,
            path: path.startsWith("/") ? path : `/${path}`,
            body,
            zoneId,
          });
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
          domain: z.string().optional().describe('Domain(s) being onboarded, e.g. "example.com".'),
          setupType: z
            .enum(["full", "partial", "unsure"])
            .optional()
            .describe("Full (primary) DNS, Partial (CNAME), or undecided."),
          migratingFrom: z.string().optional().describe('Provider key being migrated from, e.g. "akamai".'),
          goals: z
            .array(z.string())
            .optional()
            .describe('What to migrate/set up, e.g. ["dns","waf","cache","load_balancing"].'),
          checkOff: z
            .array(z.string())
            .optional()
            .describe('Checklist step ids to mark done, e.g. ["domain","setup","scan"].'),
        }),
        execute: async ({ path, domain, setupType, migratingFrom, goals, checkOff }) => {
          const next = this.applyOnboardingPatch(
            { path, domain, setupType: setupType as SetupType | undefined, migratingFrom, goals, checkOff },
            this.currentActor,
          );
          const done = next.checklist.filter((s) => s.done).length;
          const nextStep = next.checklist.find((s) => !s.done);
          const status = nextStep
            ? `The next step is "${nextStep.label}".`
            : next.checklist.length
              ? "Every step is now complete 🎉."
              : "";
          const who = this.currentActor ?? "the team";
          return `Onboarding state saved (${done}/${next.checklist.length} steps done). ${status} Now reply to ${who} in plain conversational prose: confirm in a sentence what you just recorded, briefly explain this step, and ask the single next question to keep things moving. Do NOT emit JSON or call another tool unless their next answer actually requires one.`;
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
          "READ-ONLY: translate an existing provider config into Cloudflare-equivalent rules and store a migration plan for the room. Changes nothing. Give the provider key plus the exported config (inline `config` text or a `configUrl`); JSON, XML, Terraform, and PAN-OS are supported.",
        inputSchema: z.object({
          provider: z
            .string()
            .describe('Provider key from list_migration_providers, e.g. "akamai", "fastly", "imperva".'),
          config: z
            .string()
            .optional()
            .describe("The exported provider config as text (JSON/XML/Terraform/PAN-OS)."),
          configUrl: z.string().optional().describe("URL to fetch the exported config from (read-only)."),
          format: z
            .enum(["json", "xml", "terraform", "panos", "auto"])
            .optional()
            .describe("Config format; defaults to auto-detect."),
        }),
        execute: async ({ provider, config, configUrl, format }) => {
          if (!migrationConfigured(this.migrationTransport())) return this.notConfigured();
          const resolved = await this.resolveConfigData({ config, configUrl, format });
          if (!resolved.ok) return `Error: ${resolved.message}`;

          const res = await this.runPreview(provider, resolved.data);
          if (!res.ok) return `Error from migration tool: ${res.message}`;
          this.applyOnboardingPatch(
            { configProvided: true, migratingFrom: provider, checkOff: ["preview"] },
            this.currentActor,
          );

          return `Parsed ${res.plan.totalRules} item(s) from ${res.plan.providerLabel} (read-only, nothing changed). Phases — ${
            res.phaseSummary || "none"
          }. Saved as the room's migration plan. Next: queue supported rules with \`queue_migration_rules\` (needs a zone id), or export Terraform with \`generate_migration_terraform\`.`;
        },
      }),

      queue_migration_rules: tool({
        description:
          "QUEUE the supported rules from the room's migration plan as pending actions for human Apply: WAF custom rules, IP/geo access, rate limiting, redirects, cache, origin, request/response header transforms, and zone/SSL settings. Redirect/cache/origin/header mappings are best-effort and flagged 'review before Apply'. Run preview_provider_migration first. Does NOT apply anything; anything it can't build is reported for Terraform export.",
        inputSchema: z.object({
          zoneId: z.string().describe("Target Cloudflare zone id for the migrated rules."),
          phases: z
            .array(z.string())
            .optional()
            .describe("Optional subset of phase keys to queue (default: all supported)."),
        }),
        execute: async ({ zoneId, phases }) => this.queueMigrationRules(zoneId, phases),
      }),

      generate_migration_terraform: tool({
        description:
          "READ-ONLY: generate Terraform (Infrastructure-as-Code) for the migration plan — ideal for phases best managed via IaC, or teams who prefer Terraform. Reuses the last previewed config unless you pass a new one. The room downloads it from the Migration panel.",
        inputSchema: z.object({
          provider: z.string().optional().describe("Provider key; defaults to the last previewed provider."),
          config: z.string().optional().describe("Override config text (otherwise reuses the last preview)."),
          configUrl: z.string().optional().describe("Override config URL (read-only)."),
          format: z.enum(["json", "xml", "terraform", "panos", "auto"]).optional(),
          zoneId: z.string().optional().describe("Zone id to embed; defaults to the room's default zone."),
          accountId: z.string().optional().describe("Account id to embed; defaults to the room's default account."),
          zoneName: z.string().optional(),
        }),
        execute: async (args) => this.generateTerraform(args),
      }),

      migration_preflight: tool({
        description:
          "READ-ONLY: check whether the configured Cloudflare API token has the permissions the migration plan's provider needs (per phase). Probes endpoints without creating anything. Run after preview_provider_migration.",
        inputSchema: z.object({
          zoneId: z.string().optional().describe("Target zone id; defaults to the room's default zone."),
        }),
        execute: async ({ zoneId }) => (await this.doPreflight(zoneId, this.currentActor)).summary,
      }),

      migration_diff_report: tool({
        description:
          "READ-ONLY: compare the target Cloudflare zone's current state against the migration — shows what already exists per phase (migration-owned vs manually-created), plus IP lists and load balancers. Helps avoid surprises before queueing.",
        inputSchema: z.object({
          zoneId: z.string().optional().describe("Target zone id; defaults to the room's default zone."),
        }),
        execute: async ({ zoneId }) => (await this.doDiff(zoneId, this.currentActor)).summary,
      }),

      migration_validate: tool({
        description:
          "READ-ONLY: after applying queued migration rules, verify they actually exist in the target zone. Checks the queueable rule types from the previewed config against the live zone and reports verified vs missing. Run preview first, then this after Apply.",
        inputSchema: z.object({
          zoneId: z.string().optional().describe("Target zone id; defaults to the room's default zone."),
        }),
        execute: async ({ zoneId }) => (await this.doValidate(zoneId, this.currentActor)).summary,
      }),

      export_migration_csv: tool({
        description:
          "READ-ONLY: export the migration plan's config as CSV (one row per rule/resource). Reuses the last previewed config unless you pass a new one. The room downloads it from the Migration panel.",
        inputSchema: z.object({
          provider: z.string().optional().describe("Provider key; defaults to the last previewed provider."),
          config: z.string().optional().describe("Override config text (otherwise reuses the last preview)."),
          configUrl: z.string().optional().describe("Override config URL (read-only)."),
          format: z.enum(["json", "xml", "terraform", "panos", "auto"]).optional(),
        }),
        execute: async (args) => (await this.doExportCsv(args)).message,
      }),

      snapshot_zone: tool({
        description:
          "Capture a full snapshot of a zone (rulesets, settings, IP lists, load balancers) as a restore point. Read-only on Cloudflare. Good to run before applying migration changes.",
        inputSchema: z.object({
          zoneId: z.string().optional().describe("Zone id to snapshot; defaults to the room's default zone."),
        }),
        execute: async ({ zoneId }) => (await this.doSnapshot(zoneId)).message,
      }),

      list_zone_snapshots: tool({
        description:
          "List the zone snapshots (restore points) captured for this room. Read-only. To restore one, a human uses the Restore button in the Snapshots panel (restoring is not automated).",
        inputSchema: z.object({
          zoneId: z.string().optional().describe("Filter to a single zone id."),
        }),
        execute: async ({ zoneId }) => {
          const res = await this.doRefreshSnapshots(zoneId);
          if (!res.ok) return `Error: ${res.message}`;
          const snaps = this.state.snapshots ?? [];
          if (!snaps.length) return "No snapshots captured yet. Use snapshot_zone to create one.";
          return clip(snaps.map((s) => ({ id: s.id, zone: s.zoneName || s.zoneId, created: s.created })));
        },
      }),
    } satisfies ToolSet;

    return tools;
  }

  /** Turn a failed read into a friendly, model-readable line (with a permission hint when relevant). */
  private readError(res: { message: string; hint?: string; category?: string }): string {
    this.noteTokenOutcome(res);
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
  private noteTokenOutcome(res: { ok?: boolean; category?: string }): void {
    const next = res.ok === true ? true : res.category === "auth" ? false : undefined;
    if (next !== undefined && this.state.tokenValid !== next) {
      this.setState({ ...this.state, tokenValid: next });
    }
  }

  /** Build a PendingAction (id/createdBy/ts filled in) without touching state. */
  private newPending(
    input: Omit<PendingAction, "id" | "ts" | "createdBy" | "status" | "error" | "attemptedAt">,
  ): PendingAction {
    return {
      ...input,
      id: crypto.randomUUID(),
      createdBy: this.currentActor,
      status: "pending",
      ts: Date.now(),
    };
  }

  /** Append a pending action to synced state and return the model-facing confirmation. */
  private queuePending(
    input: Omit<PendingAction, "id" | "ts" | "createdBy" | "status" | "error" | "attemptedAt">,
  ): string {
    const action = this.newPending(input);
    this.setState({ ...this.state, pendingActions: [...this.state.pendingActions, action] });
    this.queuedActionsThisTurn.push(action);
    // Queueing a change may satisfy a go-live step (e.g. an SSL setting, a WAF
    // rule, a DNS record) — reflect that on the checklist immediately.
    this.recomputeOnboardingChecklist();
    const tokenNote = this.state.tokenConfigured
      ? ""
      : " No Cloudflare API token is connected yet, so Apply is blocked until someone adds one in Connection > Set token.";
    return `Queued for approval ✅ — ${action.summary}. This has NOT run yet; a human in the room must click **Apply** to execute it.${tokenNote} (pending id: ${action.id})`;
  }

  /** Render queue narration from server-created actions, never from model claims. */
  private authoritativeQueueNarration(): string {
    if (!this.queuedActionsThisTurn.length) return queueClaimCorrection(this.state);

    const pendingById = new Map(this.state.pendingActions.map((action) => [action.id, action]));
    const resultById = new Map<string, ActionResult>();
    for (const result of this.state.recentResults) {
      if (!resultById.has(result.id)) resultById.set(result.id, result);
    }
    const ready: string[] = [];
    const applying: string[] = [];
    const failed: string[] = [];
    const finished: string[] = [];

    for (const created of this.queuedActionsThisTurn) {
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
    if (lines.length) return lines.join(" ");

    return (
      `The server created ${this.queuedActionsThisTurn.map((action) => action.summary).join("; ")}, ` +
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
    return "The migration tool isn't connected. Bind the Switchflare Worker to Glide (a `MIGRATION` service binding) or set MIGRATION_API_URL.";
  }

  /** Resolve a raw config (uploaded files, inline text, or a URL) into the tool's payload shape. */
  private async resolveConfigData(args: {
    config?: string;
    configUrl?: string;
    configFiles?: Array<{ filename: string; content: string }>;
    format?: MigrationConfigFormat;
  }): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    // Multiple uploaded Terraform files → the migration tool parses + merges them.
    const tfFiles = (args.configFiles ?? []).filter((f) => f && typeof f.content === "string" && f.content.trim());
    if (tfFiles.length > 1) {
      return { ok: true, data: { __raw_tf_files: tfFiles } };
    }
    // A single uploaded file is treated like pasted text (format inferred upstream).
    if (tfFiles.length === 1 && !args.config) {
      const built = buildConfigData(tfFiles[0].content, args.format ?? "auto", tfFiles[0].filename);
      if (!built.ok) return { ok: false, message: built.message };
      return { ok: true, data: built.data };
    }

    let raw = args.config?.trim();
    let filename: string | undefined;
    if (!raw && args.configUrl) {
      const fetched = await fetchConfigFromUrl(args.configUrl);
      if (!fetched.ok) return { ok: false, message: fetched.message };
      raw = fetched.text;
      try {
        filename = new URL(args.configUrl).pathname.split("/").pop() || undefined;
      } catch {
        /* ignore */
      }
    }
    if (!raw) {
      return {
        ok: false,
        message: "Provide the exported config inline as `config`, or a `configUrl` to fetch it from.",
      };
    }
    const built = buildConfigData(raw, args.format ?? "auto", filename);
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
  ): Promise<{ ok: true; plan: MigrationPlan; phaseSummary: string } | { ok: false; message: string }> {
    const res = await previewProviderMigration(this.migrationTransport(), provider, configData);
    if (!res.ok) return { ok: false, message: res.message };

    this.saveMigrationSource(provider, configData);

    const dto = res.result;
    const rules: MigrationPlanRule[] = dto.rules.slice(0, MAX_PLAN_RULES).map((r) => ({
      name: r.name,
      type: r.type,
      phase: r.phase,
      phaseLabel: r.phaseLabel,
      action: r.action,
      detail: r.detail,
      expression: r.expression,
    }));
    const plan: MigrationPlan = {
      provider: dto.provider,
      providerLabel: dto.providerLabel,
      totalRules: dto.totalRules,
      phases: dto.phases,
      rules,
      truncated: dto.rules.length > MAX_PLAN_RULES,
      createdBy: this.currentActor,
      ts: Date.now(),
    };
    const ob = this.state.onboarding;
    const nextOb = ob
      ? {
          ...ob,
          migratingFrom: ob.migratingFrom ?? provider,
          migratingFromLabel: ob.migratingFromLabel ?? dto.providerLabel,
        }
      : undefined;
    this.setState({ ...this.state, migrationPlan: plan, ...(nextOb ? { onboarding: nextOb } : {}) });

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
  private async queueMigrationRules(zoneId: string, phases?: string[]): Promise<string> {
    const plan = this.state.migrationPlan;
    if (!plan) return "No migration plan yet. Run preview_provider_migration first.";

    const want = phases && phases.length ? new Set(phases) : null;
    const inScope = (phase: string) => !want || want.has(phase);

    const token = await this.getToken();
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
      const { action, action_parameters } = mapWafActionToCf(r.action);
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
      newActions.push(
        this.newPending({
          product: "WAF",
          summary: `Add ${wafRules.length} WAF custom rule(s) from ${plan.providerLabel}${merged.note}`,
          method: "PUT",
          path: `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
          body: { rules: merged.rules },
          mergeEntrypoint: { phase: "http_request_firewall_custom", newRules: wafRules },
          zoneId,
        }),
      );
      wafIdx.forEach((i) => queuedIdx.add(i));
    }

    // --- Rate limiting → http_ratelimit ---
    const rlRules: Record<string, unknown>[] = [];
    const rlIdx: number[] = [];
    plan.rules.forEach((r, i) => {
      if (r.queued || r.type !== "rate_limit" || !inScope(r.phase)) return;
      const parsed = parseRateLimit(r.detail);
      if (!parsed) {
        skipped.push(`${r.name} (couldn't parse rate — export via Terraform)`);
        return;
      }
      const action = mapWafActionToCf(r.action).action;
      rlRules.push({
        action: action === "skip" ? "log" : action,
        expression: r.expression || "true",
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
      newActions.push(
        this.newPending({
          product: "Rate limiting",
          summary: `Add ${rlRules.length} rate-limit rule(s) from ${plan.providerLabel}${merged.note}`,
          method: "PUT",
          path: `/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`,
          body: { rules: merged.rules },
          mergeEntrypoint: { phase: "http_ratelimit", newRules: rlRules },
          zoneId,
        }),
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
        newActions.push(
          this.newPending({
            product: bucket.product,
            summary: `Add ${builtRules.length} ${bucket.product.toLowerCase()} rule(s) from ${plan.providerLabel}${merged.note} — review fields before Apply`,
            method: "PUT",
            path: `/zones/${zoneId}/rulesets/phases/${bucket.phase}/entrypoint`,
            body: { rules: merged.rules },
            mergeEntrypoint: { phase: bucket.phase, newRules: builtRules },
            zoneId,
          }),
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
        }),
      );
      queuedIdx.add(i);
    });

    if (!newActions.length) {
      const skipNote = skipped.length
        ? `Skipped: ${skipped.slice(0, 6).join("; ")}${skipped.length > 6 ? ` …(+${skipped.length - 6} more)` : ""}. `
        : "";
      return `Nothing new to queue. ${skipNote}Phases like origin, cache, headers, load balancing, and Zero Trust are best handled via generate_migration_terraform.`;
    }

    // One atomic state write: append actions, mark queued rules, advance checklist.
    const rules = plan.rules.map((r, i) => (queuedIdx.has(i) ? { ...r, queued: true } : r));
    const ob = this.state.onboarding;
    const nextOb = ob
      ? {
          ...ob,
          checklist: ob.checklist.map((s) => (s.id === "migrate" ? { ...s, done: true } : s)),
          ts: Date.now(),
        }
      : undefined;
    this.setState({
      ...this.state,
      pendingActions: [...this.state.pendingActions, ...newActions],
      migrationPlan: { ...plan, rules },
      ...(nextOb ? { onboarding: nextOb } : {}),
    });
    this.queuedActionsThisTurn.push(...newActions);
    // Newly-queued WAF/rate-limit/SSL rules may complete further checklist steps.
    this.recomputeOnboardingChecklist();

    const remaining = new Set(
      plan.rules.filter((r, i) => !queuedIdx.has(i) && !r.queued).map((r) => r.phaseLabel),
    );
    let msg = `Queued ${newActions.length} action(s) for approval ✅ — covering ${queuedIdx.size} rule(s). A human must click **Apply** (changes are NOT live yet). `;
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
        note: " (no token to read existing rules — Apply will REPLACE this ruleset; a snapshot is taken first)",
      };
    }
    const ep = await cfGet<{ rules?: Array<Record<string, unknown>> }>(
      `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
      token,
    );
    if (ep.ok && Array.isArray(ep.result?.rules) && ep.result.rules.length > 0) {
      const existing = ep.result.rules.map(stripRuleForPut);
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
    configUrl?: string;
    format?: MigrationConfigFormat;
    zoneId?: string;
    accountId?: string;
    zoneName?: string;
  }): Promise<string> {
    if (!migrationConfigured(this.migrationTransport())) return this.notConfigured();

    let provider = args.provider;
    let configData: unknown;
    if (args.config || args.configUrl) {
      const resolved = await this.resolveConfigData(args);
      if (!resolved.ok) return `Error: ${resolved.message}`;
      configData = resolved.data;
    } else {
      const src = this.loadMigrationSource();
      if (!src) {
        return "No stored config to export. Run preview_provider_migration first, or pass `config`/`configUrl`.";
      }
      configData = src.configData;
      provider = provider ?? src.provider;
    }
    if (!provider) return "Provide a `provider` key (e.g. \"akamai\").";

    const zoneId = args.zoneId ?? this.state.defaultZone?.id;
    const zoneName = args.zoneName ?? this.state.defaultZone?.name;
    const accountId = args.accountId ?? this.state.defaultAccountId;

    const res = await generateMigrationTerraform(this.migrationTransport(), {
      provider,
      configData,
      zoneId,
      accountId,
      zoneName,
    });
    if (!res.ok) return `Error from migration tool: ${res.message}`;

    const tf = res.result;
    const artifact: TerraformArtifact = {
      provider,
      files: tf.files ?? [],
      rulesetCount: tf.rulesetCount,
      ipListCount: tf.ipListCount,
      createdBy: this.currentActor,
      ts: Date.now(),
    };
    this.setState({ ...this.state, terraform: artifact });

    const names = artifact.files.map((f) => f.filename).join(", ");
    const extra = [
      artifact.rulesetCount ? `${artifact.rulesetCount} ruleset(s)` : "",
      artifact.ipListCount ? `${artifact.ipListCount} IP list(s)` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `Generated Terraform (${artifact.files.length} file(s)${extra ? `, ${extra}` : ""}): ${
      names || "(none)"
    }. Download it from the room's Migration panel.${
      zoneId && accountId ? "" : " Note: replace the placeholder zone/account ids before `terraform apply`."
    }`;
  }

  /** Resolve an account id: the room default, or the sole account the token can see. */
  private async resolveAccountId(token: string): Promise<string | undefined> {
    if (this.state.defaultAccountId) return this.state.defaultAccountId;
    if (!token) return undefined;
    const res = await listAccounts(token);
    if (res.ok && res.result.length === 1) {
      const id = res.result[0].id;
      this.setState({ ...this.state, defaultAccountId: id });
      return id;
    }
    return undefined;
  }

  /** Record the latest pre-flight/diff result in synced state for the UI. */
  private recordCheck(
    kind: "preflight" | "diff" | "validate",
    ok: boolean,
    summary: string,
    by: string,
  ): { ok: boolean; summary: string } {
    const check: MigrationCheck = { kind, ok, summary, by, ts: Date.now() };
    this.setState({ ...this.state, migrationCheck: check });
    return { ok, summary };
  }

  /** Pre-flight permission validation for the current migration plan's provider. */
  private async doPreflight(zoneId: string | undefined, by: string): Promise<{ ok: boolean; summary: string }> {
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, summary: this.notConfigured() };
    const provider = this.state.migrationPlan?.provider;
    if (!provider) return { ok: false, summary: "No migration plan yet — preview a provider config first." };
    const token = await this.getToken();
    if (!token) return { ok: false, summary: "No Cloudflare API token configured — add one to run a pre-flight check." };
    const accountId = await this.resolveAccountId(token);
    if (!accountId) {
      return { ok: false, summary: "Couldn't determine the account id. Run `list_accounts` / set a default account, then retry." };
    }
    const zone = zoneId ?? this.state.defaultZone?.id ?? "";
    if (CDN_MIGRATION_PROVIDERS.has(provider) && !zone) {
      return { ok: false, summary: `${provider} is zone-scoped — set a default zone (find_zone) or pass a zone id first.` };
    }

    const res = await preflightPermissions(this.migrationTransport(), { provider, accountId, zoneId: zone, apiToken: token });
    if (!res.ok) return this.recordCheck("preflight", false, `Pre-flight failed: ${res.message}`, by);

    const r = res.result;
    if (r.skipped) return this.recordCheck("preflight", true, r.skipReason ?? "Pre-flight skipped for this provider.", by);
    const summary = r.allPassed
      ? `Pre-flight ✓ — token has all ${r.passed.length} permission(s) needed for ${provider}.`
      : `Pre-flight: ${r.passed.length} ok, ${r.missing.length} MISSING. Add: ${r.missing.slice(0, 6).join("; ")}${
          r.missing.length > 6 ? ` …(+${r.missing.length - 6})` : ""
        }`;
    return this.recordCheck("preflight", r.allPassed, summary, by);
  }

  /** Pre-migration diff: what already exists in the target zone. */
  private async doDiff(zoneId: string | undefined, by: string): Promise<{ ok: boolean; summary: string }> {
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, summary: this.notConfigured() };
    const provider = this.state.migrationPlan?.provider ?? "akamai";
    const token = await this.getToken();
    if (!token) return { ok: false, summary: "No Cloudflare API token configured — add one to run a diff." };
    const accountId = await this.resolveAccountId(token);
    if (!accountId) return { ok: false, summary: "Couldn't determine the account id. Set a default account, then retry." };
    const zone = zoneId ?? this.state.defaultZone?.id;
    if (!zone) return { ok: false, summary: "A diff needs a target zone — set a default zone (find_zone) or pass a zone id." };

    const res = await diffReport(this.migrationTransport(), { provider, accountId, zoneId: zone, apiToken: token });
    if (!res.ok) return this.recordCheck("diff", false, `Diff failed: ${res.message}`, by);

    const d = res.result;
    const phaseBits = Object.values(d.phases)
      .filter((p) => p.existingTotal > 0)
      .map((p) => `${p.label}: ${p.existingTotal} (${p.existingManual} manual)`);
    const summary =
      `Diff for zone ${zone}: ` +
      (phaseBits.length ? phaseBits.join("; ") : "no existing rules in migration phases") +
      `. IP lists: ${d.ipLists.total}; LB pools: ${d.loadBalancers.pools}, LBs: ${d.loadBalancers.lbs}. ` +
      "Manual rules are preserved; queued rules merge into the phase entrypoint.";
    return this.recordCheck("diff", true, summary, by);
  }

  /** Post-migration validation: verify the plan's queueable rules exist in the zone. */
  private async doValidate(zoneId: string | undefined, by: string): Promise<{ ok: boolean; summary: string }> {
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, summary: this.notConfigured() };
    const src = this.loadMigrationSource();
    if (!src) return { ok: false, summary: "No previewed config to validate — run a provider preview first." };
    const token = await this.getToken();
    if (!token) return { ok: false, summary: "No Cloudflare API token configured — add one to validate." };
    const accountId = await this.resolveAccountId(token);
    if (!accountId) return { ok: false, summary: "Couldn't determine the account id. Set a default account, then retry." };
    const zone = zoneId ?? this.state.defaultZone?.id;
    if (!zone) return { ok: false, summary: "Validation needs a target zone — set a default zone (find_zone) or pass a zone id." };

    // Validate only the rule types Glide can queue, so "missing" is actionable.
    const ruleTypes = [
      "waf_custom",
      "access_control",
      "rate_limit",
      "redirect",
      "cache",
      "origin",
      "request_header",
      "response_header",
      "zone_setting",
    ];
    const res = await validateConfig(this.migrationTransport(), {
      provider: src.provider,
      configData: src.configData,
      accountId,
      zoneId: zone,
      apiToken: token,
      ruleTypes,
    });
    if (!res.ok) return this.recordCheck("validate", false, `Validation failed: ${res.message}`, by);

    const v = res.result;
    const missingNames = v.details
      .filter((d) => d.status === "MISSING")
      .map((d) => d.ruleName)
      .slice(0, 6);
    const ok = v.totalIntended > 0 && v.missing === 0;
    const summary =
      v.totalIntended === 0
        ? "Validation: no queueable rules in the plan to verify."
        : v.missing === 0
          ? `Validation ✓ — all ${v.verified} queueable rule(s) are present in zone ${zone}.`
          : `Validation: ${v.verified}/${v.totalIntended} present, ${v.missing} MISSING in zone ${zone}. Not yet applied? ${missingNames.join("; ")}${
              v.details.filter((d) => d.status === "MISSING").length > 6 ? " …" : ""
            }`;
    return this.recordCheck("validate", ok, summary, by);
  }

  /** Export the migration plan's config as CSV (reuses the stored source, or args). */
  private async doExportCsv(args: {
    provider?: string;
    config?: string;
    configUrl?: string;
    configFiles?: Array<{ filename: string; content: string }>;
    format?: MigrationConfigFormat;
  }): Promise<{ ok: boolean; message: string }> {
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, message: this.notConfigured() };

    let provider = args.provider;
    let configData: unknown;
    if (args.config || args.configUrl || args.configFiles?.length) {
      const resolved = await this.resolveConfigData(args);
      if (!resolved.ok) return { ok: false, message: resolved.message };
      configData = resolved.data;
    } else {
      const src = this.loadMigrationSource();
      if (!src) return { ok: false, message: "No stored config to export. Preview a provider config first, or pass config/configUrl." };
      configData = src.configData;
      provider = provider ?? src.provider;
    }
    if (!provider) return { ok: false, message: 'Provide a `provider` key (e.g. "akamai").' };

    const res = await exportMigrationCsv(this.migrationTransport(), { provider, configData });
    if (!res.ok) return { ok: false, message: `Error from migration tool: ${res.message}` };

    const artifact: TerraformArtifact = {
      provider,
      files: res.result.files ?? [],
      createdBy: this.currentActor,
      ts: Date.now(),
    };
    this.setState({ ...this.state, csv: artifact });
    const names = artifact.files.map((f) => f.filename).join(", ");
    return {
      ok: true,
      message: `Generated CSV (${artifact.files.length} file(s)): ${names || "(none)"}. Download it from the room's Migration panel.`,
    };
  }

  /** Resolve the target zone for snapshot/restore: explicit, then the room default. */
  private resolveZone(zoneId?: string): { id: string; name: string } | undefined {
    if (zoneId) {
      const dz = this.state.defaultZone;
      return { id: zoneId, name: dz?.id === zoneId ? dz.name : "" };
    }
    return this.state.defaultZone ? { id: this.state.defaultZone.id, name: this.state.defaultZone.name } : undefined;
  }

  /** Capture a full zone snapshot (read-only on CF), then refresh the synced list. */
  private async doSnapshot(zoneId?: string): Promise<{ ok: boolean; message: string }> {
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, message: this.notConfigured() };
    const token = await this.getToken();
    if (!token) return { ok: false, message: "No Cloudflare API token configured — add one to snapshot the zone." };
    const accountId = await this.resolveAccountId(token);
    if (!accountId) return { ok: false, message: "Couldn't determine the account id. Set a default account, then retry." };
    const zone = this.resolveZone(zoneId);
    if (!zone) return { ok: false, message: "A snapshot needs a target zone — set a default zone (find_zone) or pass a zone id." };

    const res = await captureZoneSnapshot(this.migrationTransport(), {
      apiToken: token,
      accountId,
      zoneId: zone.id,
      zoneName: zone.name,
    });
    if (!res.ok) return { ok: false, message: `Snapshot failed: ${res.message}` };
    await this.doRefreshSnapshots(zone.id);
    return { ok: true, message: `Captured snapshot ${res.result.snapshotId} for ${zone.name || zone.id}.` };
  }

  /** Pull the stored snapshot list into synced state. */
  private async doRefreshSnapshots(zoneId?: string): Promise<{ ok: boolean; message?: string }> {
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, message: this.notConfigured() };
    const res = await listZoneSnapshots(this.migrationTransport(), zoneId);
    if (!res.ok) return { ok: false, message: res.message };
    const snapshots: SnapshotInfo[] = res.result.snapshots.slice(0, 50).map((s) => ({
      id: s.id,
      zoneId: s.zone_id,
      zoneName: s.zone_name,
      created: s.created_at,
    }));
    this.setState({ ...this.state, snapshots });
    return { ok: true };
  }

  /** Restore a zone to a snapshot (DESTRUCTIVE). Records the outcome in recentResults. */
  private async doRestore(
    snapshotId: string,
    zoneId: string | undefined,
    by: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!migrationConfigured(this.migrationTransport())) return { ok: false, message: this.notConfigured() };
    const token = await this.getToken();
    if (!token) return { ok: false, message: "No Cloudflare API token configured — add one to restore." };
    const accountId = await this.resolveAccountId(token);
    if (!accountId) return { ok: false, message: "Couldn't determine the account id. Set a default account, then retry." };

    const snap = await getZoneSnapshot(this.migrationTransport(), snapshotId);
    if (!snap.ok) return { ok: false, message: `Couldn't load snapshot: ${snap.message}` };
    const row = snap.result.snapshot;
    let snapshotData: unknown;
    try {
      snapshotData = JSON.parse(row.snapshot_data);
    } catch {
      return { ok: false, message: "Snapshot data is corrupt or unreadable." };
    }
    const zone = zoneId ?? row.zone_id;

    const res = await restoreZoneSnapshot(this.migrationTransport(), {
      apiToken: token,
      accountId,
      zoneId: zone,
      snapshotData,
    });

    const result: ActionResult = {
      id: crypto.randomUUID(),
      product: "Restore",
      summary: `Restore ${row.zone_name || zone} to snapshot ${snapshotId.slice(0, 8)}…`,
      status: res.ok ? "applied" : "failed",
      detail: res.ok ? "Zone restored to the snapshot." : res.message,
      by,
      ts: Date.now(),
    };
    this.setState({
      ...this.state,
      recentResults: [result, ...this.state.recentResults].slice(0, MAX_RECENT_RESULTS),
    });
    return res.ok
      ? { ok: true, message: `Restored ${row.zone_name || zone} to snapshot ${snapshotId.slice(0, 8)}…` }
      : { ok: false, message: `Restore failed: ${res.message}` };
  }

  // ---------------------------------------------------------------------------
  // Approval RPC — the ONLY place real Cloudflare writes happen.
  // ---------------------------------------------------------------------------

  @callable()
  async applyAction(id: string, by = "someone"): Promise<ActionResult> {
    return this.applyActionInternal(id, by, true);
  }

  private async applyActionInternal(id: string, by: string, notify: boolean): Promise<ActionResult> {
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
    const conflictingAction = resourceKey
      ? this.state.pendingActions.find(
          (candidate) =>
            candidate.id !== id &&
            isActionApplying(candidate) &&
            actionResourceKey(candidate) === resourceKey,
        )
      : undefined;
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

    try {
      const token = await this.getToken();
      if (!token) {
        return this.recordActionResult(
          id,
          {
            id,
            product: action.product,
            summary: action.summary,
            status: "failed",
            detail:
              "No Cloudflare API token is configured. Add one in Connection > Set token, then retry this action.",
            by,
            ts: Date.now(),
          },
          true,
          notify,
        );
      }

      // Best-effort snapshot before mutating a zone (rollback breadcrumb).
      if (action.zoneId) {
        try {
          const snap = await snapshotZone(token, action.zoneId);
          if (snap.ok) {
            this.sql`INSERT OR REPLACE INTO glide_snapshots (action_id, zone_id, ts, data)
              VALUES (${id}, ${action.zoneId}, ${Date.now()}, ${JSON.stringify(snap.result)})`;
          }
        } catch {
          // snapshots are advisory; never block an apply on them
        }
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
          token,
        );
        if (!ep.ok) {
          const detail = ep.hint
            ? `${ep.message} — needs token permission: ${ep.hint}`
            : ep.message;
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
        const existing = Array.isArray(ep.result?.rules)
          ? ep.result.rules.map(stripRuleForPut)
          : [];
        body = { rules: [...existing, ...newRules] };
      }

      const res = await cfRequest(action.method, action.path, token, body);

      if (res.ok) {
        const createdId = (res.result as { id?: string } | undefined)?.id;
        return this.recordActionResult(
          id,
          {
            id,
            product: action.product,
            summary: action.summary,
            status: "applied",
            detail: createdId ? `Applied — created ${createdId}` : "Applied successfully.",
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
  async applyAll(by = "someone"): Promise<ActionResult[]> {
    const ids = this.state.pendingActions.filter((a) => !isActionApplying(a)).map((a) => a.id);
    const results: ActionResult[] = [];
    for (const id of ids) results.push(await this.applyActionInternal(id, by, true));
    return results;
  }

  /** Record an outcome atomically. Failed writes stay queued for correction or verification. */
  private async recordActionResult(
    id: string,
    result: ActionResult,
    retainForRetry: boolean,
    notify: boolean,
  ): Promise<ActionResult> {
    this.setState({
      ...this.state,
      pendingActions: retainForRetry
        ? markActionFailed(this.state.pendingActions, id, result.detail, result.ts)
        : this.state.pendingActions.filter((a) => a.id !== id),
      recentResults: [result, ...this.state.recentResults].slice(0, MAX_RECENT_RESULTS),
    });
    // An applied change (e.g. SSL set, WAF rule live) can complete a go-live step.
    this.recomputeOnboardingChecklist();
    if (notify) await this.scheduleActionResultNotification([result]);
    return result;
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

    const eventId = `action-result-${results[0].id}-${results[0].ts}-${results.length}`;
    const completed = this.sql<{ completed: number }>`
      SELECT completed FROM glide_action_notifications WHERE id = ${eventId}`;
    if (Number(completed[0]?.completed ?? 0) === 1) return;

    const event: UIMessage = {
      id: eventId,
      role: "user",
      metadata: {
        name: "Glide system",
        systemEvent: "action_result",
      } satisfies GlideMessageMetadata,
      parts: [{ type: "text", text: formatActionResultEvent(results) }],
    };

    const response = await this.saveMessages((messages) =>
      messages.some((message) => message.id === eventId) ? [...messages] : [...messages, event],
    );
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
          console.log(`[cron] weekly docs reindex: ${res.message}`);
        } catch (err) {
          console.error(
            "[cron] weekly docs reindex failed to start:",
            (err as Error)?.message ?? err,
          );
        }
      })(),
    );
  },
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;
    const res = await env.ASSETS.fetch(request);
    // Revalidate HTML on every load so a redeploy's new hashed asset URLs are
    // picked up immediately. The hashed JS/CSS themselves stay immutably cached;
    // only the tiny index.html is re-checked. Prevents stale-bundle confusion.
    if ((res.headers.get("content-type") ?? "").includes("text/html")) {
      const headers = new Headers(res.headers);
      headers.set("Cache-Control", "no-cache");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
