/**
 * Blast-radius estimator.
 *
 * Given a queued change and a snapshot of the zone's recent traffic, estimate how
 * much LIVE traffic the change would touch — so the person about to click Apply
 * sees the consequences first. Pure and deterministic (no API calls): the server
 * reads the traffic snapshot and passes it in, mirroring {@link ./posture} and
 * {@link ./recommendations}.
 *
 * Cloudflare rule expressions are wirefilter, which we can't fully evaluate here,
 * so we parse the *quantifiable* signals we can map to zone analytics — country
 * filters above all (per-country request volume is available) — and fall back to
 * honest qualitative context (targeted path/method, zone-wide reach) when an
 * exact count isn't derivable. We never overstate certainty.
 */

import type { ZoneTrafficSnapshot } from "./cf-api.ts";

/** Risk that a change disrupts unintended, legitimate traffic. */
export type BlastLevel = "low" | "medium" | "high" | "unknown";

/** The queued change to assess (a subset of a PendingAction). */
export interface BlastActionInput {
  method: string;
  path: string;
  body?: unknown;
  summary?: string;
  product?: string;
}

export interface BlastRadiusEstimate {
  level: BlastLevel;
  /** Human-readable, honest one/two-line assessment. */
  summary: string;
  /** Human label for the window analysed, e.g. "last 24h". */
  window: string;
  /** Total requests in the window, for context (when analytics were readable). */
  totalRequests?: number;
  /** Estimated requests the change would touch, when quantifiable. */
  matchedRequests?: number;
  /** matchedRequests as a percentage of totalRequests (0–100), when quantifiable. */
  matchedPct?: number;
  /** Parsed targeting signals (country/path/method/action) for transparency. */
  signals: string[];
}

const HIGH_PCT = 25;
const MEDIUM_PCT = 5;

/** Collect every string value stored under an `expression` key, anywhere in a body. */
function collectExpressions(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectExpressions(item, out);
    return out;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "expression" && typeof v === "string") out.push(v);
    else collectExpressions(v, out);
  }
  return out;
}

/** Find the rule action ("block" | "managed_challenge" | "log" | …) in a body. */
function findRuleAction(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRuleAction(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.action === "string") return record.action;
  for (const v of Object.values(record)) {
    const found = findRuleAction(v);
    if (found) return found;
  }
  return undefined;
}

/** Uppercase ISO-3166 country codes referenced by `ip.geoip.country` clauses. */
function parseCountries(expr: string): string[] {
  const codes = new Set<string>();
  for (const m of expr.matchAll(/country\s+eq\s+"([A-Za-z]{2})"/g)) codes.add(m[1].toUpperCase());
  for (const m of expr.matchAll(/country\s+in\s+\{([^}]*)\}/g)) {
    for (const code of m[1].matchAll(/"([A-Za-z]{2})"/g)) codes.add(code[1].toUpperCase());
  }
  return [...codes];
}

/** Literal path targeted by a `http.request.uri.path` clause, if any. */
function parsePath(expr: string): string | undefined {
  const m = expr.match(/uri\.path\s+(?:eq|contains|matches|wildcard)\s+"([^"]+)"/);
  return m?.[1];
}

/** HTTP method targeted by a `http.request.method` clause, if any. */
function parseMethod(expr: string): string | undefined {
  const m = expr.match(/request\.method\s+eq\s+"([A-Za-z]+)"/);
  return m?.[1]?.toUpperCase();
}

function actionVerb(action: string | undefined): string {
  switch (action) {
    case "block":
      return "Blocking";
    case "managed_challenge":
    case "challenge":
    case "js_challenge":
      return "Challenging";
    case "log":
      return "Logging";
    case "skip":
    case "allow":
      return "Allowing";
    default:
      return "Filtering";
  }
}

/** Observational actions never disrupt users, so they cap the risk level. */
function isObservational(action: string | undefined): boolean {
  return action === "log" || action === "skip" || action === "allow";
}

function pctLevel(pct: number, observational: boolean): BlastLevel {
  if (observational) return "low";
  if (pct >= HIGH_PCT) return "high";
  if (pct >= MEDIUM_PCT) return "medium";
  return "low";
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Estimate the blast radius of a queued change. When `traffic` is undefined
 * (analytics unreadable) the level is `unknown` with an explanatory summary.
 */
export function estimateBlastRadius(
  action: BlastActionInput,
  traffic: ZoneTrafficSnapshot | undefined,
): BlastRadiusEstimate {
  const window = traffic ? `last ${traffic.windowHours}h` : "last 24h";
  const expressions = collectExpressions(action.body);
  const expr = expressions.join(" ");
  const ruleAction = findRuleAction(action.body);
  const countries = expr ? parseCountries(expr) : [];
  const path = expr ? parsePath(expr) : undefined;
  const method = expr ? parseMethod(expr) : undefined;

  const signals: string[] = [];
  if (ruleAction) signals.push(`action: ${ruleAction}`);
  if (countries.length) signals.push(`countries: ${countries.join(", ")}`);
  if (path) signals.push(`path: ${path}`);
  if (method) signals.push(`method: ${method}`);

  if (!traffic) {
    return {
      level: "unknown",
      summary:
        "Couldn't read traffic analytics for this zone (the API token needs Analytics: Read), so the impact can't be quantified. Review the change carefully before Apply.",
      window,
      signals,
    };
  }

  const total = traffic.totalRequests;

  // Quantifiable case: country-scoped rule → sum per-country request volume.
  if (countries.length && total > 0) {
    const matched = traffic.byCountry
      .filter((c) => countries.includes(c.country.toUpperCase()))
      .reduce((sum, c) => sum + c.requests, 0);
    const pct = total > 0 ? (matched / total) * 100 : 0;
    const observational = isObservational(ruleAction);
    return {
      level: pctLevel(pct, observational),
      summary:
        `${actionVerb(ruleAction)} ${countries.join(", ")} would touch ≈${fmt(matched)} requests ` +
        `(${pct.toFixed(1)}%) of ${fmt(total)} in the ${window}.` +
        (observational ? " This action only observes traffic, so users aren't disrupted." : ""),
      window,
      totalRequests: total,
      matchedRequests: matched,
      matchedPct: Math.round(pct * 10) / 10,
      signals,
    };
  }

  // Targeted but not exactly countable (path/method) → honest qualitative call.
  if (path || method) {
    const target = [path ? `path ${path}` : "", method ? `${method} requests` : ""].filter(Boolean).join(" · ");
    return {
      level: "unknown",
      summary:
        `Targets ${target}. Zone-level analytics can't size this exact slice, but the zone saw ≈${fmt(total)} ` +
        `requests in the ${window} — review the rule against your real ${path ? "path" : "method"} traffic before Apply.`,
      window,
      totalRequests: total,
      signals,
    };
  }

  // Zone-wide change (e.g. a setting or a rule with no narrowing predicate).
  const observationalWide = isObservational(ruleAction);
  const zoneWideBlocking = !!ruleAction && !observationalWide;
  return {
    level: zoneWideBlocking ? "high" : "unknown",
    summary:
      (zoneWideBlocking
        ? `${actionVerb(ruleAction)} with no narrowing filter would apply to ALL traffic — `
        : "Applies zone-wide — ") +
      `the zone saw ≈${fmt(total)} requests in the ${window}.` +
      (zoneWideBlocking ? " Add a filter (path, country, method) to scope it before Apply." : ""),
    window,
    totalRequests: total,
    signals,
  };
}

/** Compact one-line rendering for chat/model relay. */
export function formatBlastRadius(estimate: BlastRadiusEstimate): string {
  const reach =
    estimate.matchedRequests !== undefined
      ? ` (~${fmt(estimate.matchedRequests)} req, ${estimate.matchedPct}%)`
      : "";
  return `Impact: ${estimate.level.toUpperCase()}${reach} — ${estimate.summary}`;
}
