/**
 * Change-risk classifier for the room's four-eyes (dual-approval) policy.
 *
 * Given a queued change, decide whether it is destructive or can break live
 * traffic and therefore needs a SECOND approver before Apply. Pure and
 * deterministic from method/path/body only — no API calls and no traffic data —
 * so it yields the same verdict at queue, schedule, and apply time (mirroring
 * {@link ./posture}, {@link ./recommendations}, and {@link ./blast-radius}).
 *
 * Deliberately conservative: it gates the genuinely dangerous changes (resource
 * deletion, ruleset/WAF rules that can block traffic, connectivity-critical TLS
 * settings) and lets routine posture improvements through so four-eyes stays
 * worth leaving on.
 */

import { canonicalizeApiPath } from "./api-path.ts";

/** A queued change to classify (a subset of a PendingAction). */
export interface ChangeRiskInput {
  method: string;
  path: string;
  body?: unknown;
  mergeEntrypoint?: { phase: string; newRules: Array<Record<string, unknown>> };
}

export interface ChangeRiskAssessment {
  /** True when this change is destructive or can break live traffic. */
  required: boolean;
  /** Short human reason shown in the UI / audit when a second approval is required. */
  reason?: string;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RULESET_PATH_RE = /^\/(?:zones|accounts)\/[a-f0-9]{32}\/rulesets(?:\/|$)/i;
const ZONE_SETTING_RE = /^\/zones\/[a-f0-9]{32}\/settings\/([a-z0-9_]+)$/i;
/** Zone settings whose misconfiguration can break TLS or lock legitimate clients out. */
const CONNECTIVITY_CRITICAL_SETTINGS = new Set(["ssl", "min_tls_version"]);

/**
 * Decide whether a queued change needs a second approver under four-eyes. The
 * assessment is independent of the room policy toggle — callers combine it with
 * the room's `fourEyes.enabled` flag.
 */
export function requiresSecondApproval(action: ChangeRiskInput): ChangeRiskAssessment {
  const method = typeof action.method === "string" ? action.method.toUpperCase() : "";
  const canonical = typeof action.path === "string" ? canonicalizeApiPath(action.path) : undefined;
  const pathname = canonical?.split("?", 1)[0].replace(/\/+$/, "") ?? "";

  // Ruleset phase entrypoint replacement (WAF/firewall/transform) reshapes how
  // every request the phase matches is handled.
  if (action.mergeEntrypoint) {
    return { required: true, reason: "Replaces a ruleset phase — changes how live traffic is filtered." };
  }
  // Any write to a ruleset (custom firewall/WAF rules) can block real traffic.
  if (RULESET_PATH_RE.test(pathname) && WRITE_METHODS.has(method)) {
    return { required: true, reason: "Changes firewall/WAF rules that can block live traffic." };
  }
  // Any DELETE destroys a Cloudflare resource.
  if (method === "DELETE") {
    return { required: true, reason: "Deletes a Cloudflare resource." };
  }
  // Connectivity-critical zone settings (TLS mode, minimum TLS version).
  const settingMatch = pathname.match(ZONE_SETTING_RE);
  if (settingMatch && method === "PATCH") {
    const setting = settingMatch[1].toLowerCase();
    if (CONNECTIVITY_CRITICAL_SETTINGS.has(setting)) {
      return { required: true, reason: `Changes a connectivity-critical setting (${setting}).` };
    }
  }
  return { required: false };
}
