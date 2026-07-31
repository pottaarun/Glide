/**
 * Auto-rollback safety window (pure).
 *
 * When a member Applies an invertible change and opts into the safety window,
 * Glide captures the change's inverse and arms a timer that restores the prior
 * state unless a human clicks "Keep" first. This module holds the pure,
 * deterministic pieces — deciding whether an action is safely invertible, and
 * building the inverse call from the action plus the prior value read live at
 * Apply time. All I/O (the pre-write read, the scheduled revert) lives in
 * server.ts, and the same pure check runs client-side so the opt-in is only
 * offered when it will actually work.
 *
 * Only zone-setting PATCHes are treated as invertible: they flip a single
 * `value` we can read beforehand and write back verbatim, with no dependency on
 * ids created by the change or on registrar/DNS side effects. That deliberately
 * excludes rule creation (POST), deletes, ruleset merges, and DNSSEC, none of
 * which have a clean one-call inverse.
 */

import { canonicalizeApiPath } from "./api-path.ts";

/** A zone-setting PATCH recognized as safely invertible. */
export interface InvertibleSetting {
  /** 32-hex zone id parsed from the path. */
  zoneId: string;
  /** Setting name (e.g. "ssl", "min_tls_version", "security_header"). */
  setting: string;
  /** Canonical settings path (no query), reused for the pre-read and the inverse. */
  path: string;
}

/** The inverse call that restores a setting to its captured prior value. */
export interface RollbackPlan {
  method: "PATCH";
  path: string;
  body: { value: unknown };
  /** Human summary of the revert. */
  summary: string;
}

const SETTINGS_PATH = /^\/zones\/([0-9a-f]{32})\/settings\/([a-z0-9_]+)$/i;

/**
 * Decide whether an action is a safely-invertible zone-setting PATCH, returning
 * the parsed setting (or `null`). Pure — used server-side to arm the window and
 * client-side to offer the opt-in only when a clean inverse exists. The write
 * must set a single `value` we can read back and restore.
 */
export function invertibleSetting(action: {
  method?: unknown;
  path?: unknown;
  body?: unknown;
  actionType?: unknown;
  mergeEntrypoint?: unknown;
}): InvertibleSetting | null {
  if (typeof action.method !== "string" || action.method.toUpperCase() !== "PATCH") return null;
  // Ruleset merges and legacy restore actions are never simple value flips.
  if (action.actionType || action.mergeEntrypoint) return null;
  if (typeof action.path !== "string") return null;
  const canonical = canonicalizeApiPath(action.path);
  if (!canonical) return null;
  const pathname = canonical.split("?", 1)[0].replace(/\/+$/, "");
  const match = pathname.match(SETTINGS_PATH);
  if (!match) return null;
  if (!action.body || typeof action.body !== "object" || Array.isArray(action.body)) return null;
  if (!Object.prototype.hasOwnProperty.call(action.body, "value")) return null;
  return { zoneId: match[1].toLowerCase(), setting: match[2].toLowerCase(), path: pathname };
}

/**
 * Build the inverse PATCH from an invertible action and the value read live from
 * the zone *before* the change was applied. Returns `null` when the action isn't
 * invertible or the prior value is unusable (`undefined`).
 */
export function buildRollbackPlan(
  action: { method?: unknown; path?: unknown; body?: unknown; actionType?: unknown; mergeEntrypoint?: unknown },
  priorValue: unknown,
): RollbackPlan | null {
  const inv = invertibleSetting(action);
  if (!inv) return null;
  if (priorValue === undefined) return null;
  return {
    method: "PATCH",
    path: inv.path,
    body: { value: priorValue },
    summary: `Revert ${inv.setting} to ${describeValue(priorValue)}`,
  };
}

/** Compact, human-readable rendering of a setting value for revert summaries. */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Objects (e.g. the HSTS security_header) — keep the summary short.
  try {
    const json = JSON.stringify(value);
    return json && json.length <= 60 ? json : "its previous setting";
  } catch {
    return "its previous setting";
  }
}
