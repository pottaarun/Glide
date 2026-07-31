/**
 * Glide's security-posture scorecard.
 *
 * Turns a set of facts read from a zone's *live* Cloudflare configuration into a
 * graded report card (A–F) with a per-check pass / warn / fail breakdown and,
 * where a change can be safely one-click queued, a concrete fix.
 *
 * Like {@link ./recommendations}, nothing here touches the Cloudflare API — it is
 * a pure, deterministic scorer so it can be unit-tested and reused by both the
 * on-demand tool/RPC and the scheduled drift watch. The safety contract is
 * unchanged: a fix is only ever *queued* for a human to Apply, and the server
 * rebuilds the exact API call from this catalog (never from client input) via
 * {@link postureFixToPending}.
 */

import type { QueuedRecommendation } from "./recommendations.ts";
import type { ZoneSslMode } from "./cf-api.ts";

/** Outcome of a single posture check. `unknown` = the fact couldn't be read. */
export type PostureStatus = "pass" | "warn" | "fail" | "unknown";

/** Overall letter grade for the zone. */
export type PostureGrade = "A" | "B" | "C" | "D" | "F";

/** Themed grouping so the UI/model can present checks by area. */
export type PostureArea = "TLS" | "WAF" | "DNS" | "Network";

/**
 * Raw facts read from a zone's live Cloudflare state. Every field is optional:
 * an unreadable fact (missing permission, transient error) becomes an `unknown`
 * check and is excluded from scoring rather than counted as a failure.
 */
export interface ZonePostureFacts {
  zoneId: string;
  zoneName?: string;
  /** Zone activation status === "active". */
  active?: boolean;
  sslMode?: ZoneSslMode;
  alwaysUseHttps?: boolean;
  /** Minimum TLS version as reported by the API ("1.0" | "1.1" | "1.2" | "1.3"). */
  minTlsVersion?: string;
  tls13?: boolean;
  hsts?: boolean;
  managedWaf?: boolean;
  /** DNSSEC status ("active" | "pending" | "disabled" | other). */
  dnssec?: string;
  /** Proxiable DNS records currently proxied (orange-cloud), from the last listing. */
  proxiedRecords?: number;
  /** Proxiable DNS records total, from the last listing. */
  proxiableRecords?: number;
}

/** A concrete, queue-ready fix the server can rebuild and enqueue for Apply. */
export interface PostureFix {
  /** Human summary of the change (mirrors the pending action summary). */
  summary: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path after https://api.cloudflare.com/client/v4, `{zone}` = the zone id. */
  path: string;
  body: unknown;
  /** True when the change should be reviewed before Apply (sticky / risky). */
  reviewRequired?: boolean;
}

/** One graded check. */
export interface PostureCheck {
  id: string;
  area: PostureArea;
  title: string;
  status: PostureStatus;
  /** Plain-English description of the current live state. */
  detail: string;
  /** Contribution to the score when this check is readable (status !== "unknown"). */
  weight: number;
  /** Concrete one-click fix, when the gap can be safely queued. */
  fix?: PostureFix;
  /** When not one-click fixable: a chat prompt to hand to Glide instead. */
  ask?: string;
  docs: string[];
}

/** The full scored report. */
export interface PostureReport {
  zoneId: string;
  zoneName?: string;
  grade: PostureGrade;
  /** 0–100, weighted over the checks that could be read. */
  score: number;
  checks: PostureCheck[];
  /** One-line natural-language summary of the result. */
  summary: string;
  /** How many checks are pass / warn / fail / unknown. */
  tally: Record<PostureStatus, number>;
  /** ms epoch the report was produced (set by the caller). */
  ts: number;
}

const DOCS = {
  sslModes: "https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/",
  alwaysHttps: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/",
  minTls: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/",
  tls13: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/tls-13/",
  hsts: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  managedRules: "https://developers.cloudflare.com/waf/managed-rules/",
  dnssec: "https://developers.cloudflare.com/dns/dnssec/",
  proxy: "https://developers.cloudflare.com/dns/proxy-status/",
} as const;

/** Standard grade bands over the 0–100 weighted score. */
export function gradeForScore(score: number): PostureGrade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/** Numeric value a status earns toward its weight (unknown is excluded upstream). */
const STATUS_CREDIT: Record<PostureStatus, number> = { pass: 1, warn: 0.5, fail: 0, unknown: 0 };

/** Parse the API's min-TLS string into a comparable number (NaN when unknown). */
function tlsVersionValue(v: string | undefined): number {
  if (!v) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Score a zone's live configuration into a graded report. Pure and deterministic:
 * the same facts always produce the same report. Unreadable facts (`undefined`)
 * become `unknown` checks that don't count for or against the grade.
 */
export function scorePosture(facts: ZonePostureFacts, now = Date.now()): PostureReport {
  const checks: PostureCheck[] = [];

  // --- TLS: encryption mode ------------------------------------------------
  {
    const m = facts.sslMode;
    const status: PostureStatus =
      m === "strict" ? "pass" : m === "full" ? "warn" : m === "flexible" || m === "off" ? "fail" : "unknown";
    checks.push({
      id: "ssl_mode",
      area: "TLS",
      title: "SSL/TLS encryption mode is Full (strict)",
      status,
      detail:
        m === undefined || m === "unknown"
          ? "Couldn't read the SSL/TLS mode."
          : `Encryption mode is "${m}".`,
      weight: 25,
      fix:
        status === "pass" || status === "unknown"
          ? undefined
          : {
              summary: "Set SSL/TLS mode to Full (strict)",
              method: "PATCH",
              path: "/zones/{zone}/settings/ssl",
              body: { value: "strict" },
              reviewRequired: true,
            },
      docs: [DOCS.sslModes],
    });
  }

  // --- TLS: always use HTTPS ----------------------------------------------
  checks.push(
    boolCheck({
      id: "always_https",
      area: "TLS",
      title: "All traffic is redirected to HTTPS",
      value: facts.alwaysUseHttps,
      weight: 10,
      onLabel: "Always Use HTTPS is on.",
      offLabel: "Always Use HTTPS is off — requests can be served over plain HTTP.",
      failStatus: "fail",
      fix: {
        summary: "Turn on Always Use HTTPS",
        method: "PATCH",
        path: "/zones/{zone}/settings/always_use_https",
        body: { value: "on" },
      },
      docs: [DOCS.alwaysHttps],
    }),
  );

  // --- TLS: minimum version -----------------------------------------------
  {
    const v = tlsVersionValue(facts.minTlsVersion);
    const status: PostureStatus = Number.isNaN(v)
      ? "unknown"
      : v >= 1.2
        ? "pass"
        : v >= 1.1
          ? "warn"
          : "fail";
    checks.push({
      id: "min_tls",
      area: "TLS",
      title: "Minimum TLS version is 1.2 or higher",
      status,
      detail: Number.isNaN(v)
        ? "Couldn't read the minimum TLS version."
        : `Minimum TLS version is ${facts.minTlsVersion}.`,
      weight: 10,
      fix:
        status === "pass" || status === "unknown"
          ? undefined
          : {
              summary: "Set minimum TLS version to 1.2",
              method: "PATCH",
              path: "/zones/{zone}/settings/min_tls_version",
              body: { value: "1.2" },
            },
      docs: [DOCS.minTls],
    });
  }

  // --- TLS: 1.3 ------------------------------------------------------------
  checks.push(
    boolCheck({
      id: "tls_1_3",
      area: "TLS",
      title: "TLS 1.3 is enabled",
      value: facts.tls13,
      weight: 5,
      onLabel: "TLS 1.3 is enabled.",
      offLabel: "TLS 1.3 is off.",
      failStatus: "warn",
      fix: {
        summary: "Enable TLS 1.3",
        method: "PATCH",
        path: "/zones/{zone}/settings/tls_1_3",
        body: { value: "on" },
      },
      docs: [DOCS.tls13],
    }),
  );

  // --- TLS: HSTS -----------------------------------------------------------
  checks.push(
    boolCheck({
      id: "hsts",
      area: "TLS",
      title: "HSTS is enabled",
      value: facts.hsts,
      weight: 10,
      onLabel: "HTTP Strict Transport Security is enabled.",
      offLabel: "HSTS is off — browsers may still attempt HTTP.",
      // HSTS is a strong control but sticky and optional; a gap is a warning.
      failStatus: "warn",
      fix: {
        summary: "Enable HSTS (max-age 1 year, includeSubDomains)",
        method: "PATCH",
        path: "/zones/{zone}/settings/security_header",
        body: {
          value: {
            strict_transport_security: {
              enabled: true,
              max_age: 31536000,
              include_subdomains: true,
              nosniff: true,
            },
          },
        },
        reviewRequired: true,
      },
      docs: [DOCS.hsts],
    }),
  );

  // --- WAF: managed ruleset -----------------------------------------------
  {
    const w = facts.managedWaf;
    const status: PostureStatus = w === true ? "pass" : w === false ? "fail" : "unknown";
    checks.push({
      id: "managed_waf",
      area: "WAF",
      title: "Cloudflare Managed WAF ruleset is deployed",
      status,
      detail:
        w === undefined
          ? "Couldn't read the managed WAF status."
          : w
            ? "The Cloudflare Managed Ruleset is deployed."
            : "The Cloudflare Managed Ruleset is not deployed.",
      weight: 25,
      // Deploying the managed ruleset needs the managed ruleset id + an execute
      // rule; Glide sets that up in chat rather than blindly one-click queuing it.
      ask:
        status === "fail"
          ? "Deploy the Cloudflare Managed WAF ruleset on my zone."
          : undefined,
      docs: [DOCS.managedRules],
    });
  }

  // --- DNS: DNSSEC ---------------------------------------------------------
  {
    const d = facts.dnssec;
    const status: PostureStatus =
      d === "active" ? "pass" : d === "pending" ? "warn" : d === undefined ? "unknown" : "fail";
    checks.push({
      id: "dnssec",
      area: "DNS",
      title: "DNSSEC is active",
      status,
      detail:
        d === undefined
          ? "Couldn't read the DNSSEC status."
          : d === "active"
            ? "DNSSEC is active."
            : d === "pending"
              ? "DNSSEC is pending — add the DS record at your registrar to finish."
              : "DNSSEC is disabled.",
      weight: 10,
      fix:
        status === "pass" || status === "unknown"
          ? undefined
          : {
              summary: "Enable DNSSEC (then add the DS record at your registrar)",
              method: "PATCH",
              path: "/zones/{zone}/dnssec",
              body: { status: "active" },
              reviewRequired: true,
            },
      docs: [DOCS.dnssec],
    });
  }

  // --- Network: DNS proxy coverage ----------------------------------------
  {
    const proxied = facts.proxiedRecords;
    const proxiable = facts.proxiableRecords;
    // No proxiable records at all is not a failing posture — there is nothing to
    // protect at the edge, so the check is excluded from scoring (unknown).
    const status: PostureStatus =
      proxiable === undefined || proxiable === 0
        ? "unknown"
        : proxied === proxiable
          ? "pass"
          : (proxied ?? 0) > 0
            ? "warn"
            : "fail";
    checks.push({
      id: "proxy_coverage",
      area: "Network",
      title: "Proxiable DNS records are proxied through Cloudflare",
      status,
      detail:
        proxiable === undefined
          ? "Couldn't read DNS proxy coverage — list the zone's DNS records first."
          : proxiable === 0
            ? "No proxiable DNS records were found."
            : `${proxied ?? 0} of ${proxiable} proxiable records are proxied (orange-cloud).`,
      weight: 10,
      ask:
        status === "warn" || status === "fail"
          ? "Proxy the remaining orange-cloud DNS records on my zone."
          : undefined,
      docs: [DOCS.proxy],
    });
  }

  return finalizeReport(facts, checks, now);
}

/** Shared builder for a simple on/off boolean check. */
function boolCheck(input: {
  id: string;
  area: PostureArea;
  title: string;
  value: boolean | undefined;
  weight: number;
  onLabel: string;
  offLabel: string;
  /** Status to use when the value is `false` ("fail" or "warn"). */
  failStatus: "fail" | "warn";
  fix: PostureFix;
  docs: string[];
}): PostureCheck {
  const status: PostureStatus =
    input.value === true ? "pass" : input.value === false ? input.failStatus : "unknown";
  return {
    id: input.id,
    area: input.area,
    title: input.title,
    status,
    detail: input.value === undefined ? `Couldn't read ${input.title.toLowerCase()}.` : input.value ? input.onLabel : input.offLabel,
    weight: input.weight,
    fix: status === "pass" || status === "unknown" ? undefined : input.fix,
    docs: input.docs,
  };
}

/** Compute the weighted score, grade, tally and summary from scored checks. */
function finalizeReport(facts: ZonePostureFacts, checks: PostureCheck[], now: number): PostureReport {
  const tally: Record<PostureStatus, number> = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  let earned = 0;
  let total = 0;
  for (const c of checks) {
    tally[c.status] += 1;
    if (c.status === "unknown") continue;
    total += c.weight;
    earned += c.weight * STATUS_CREDIT[c.status];
  }
  const score = total > 0 ? Math.round((earned / total) * 100) : 0;
  const grade = gradeForScore(score);
  const summary =
    total === 0
      ? "Couldn't read enough of this zone's configuration to grade it — check the API token's read permissions."
      : `Grade ${grade} (${score}/100): ${tally.pass} passing, ${tally.warn} to improve, ${tally.fail} failing` +
        (tally.unknown ? `, ${tally.unknown} unreadable.` : ".");
  return {
    zoneId: facts.zoneId,
    zoneName: facts.zoneName,
    grade,
    score,
    checks,
    summary,
    tally,
    ts: now,
  };
}

/**
 * Map a check's fix to a concrete, queue-ready Cloudflare API call — or `null`
 * when the check has no one-click fix. `{zone}` is replaced with the real zone
 * id; a descriptive/placeholder path is refused. Mirrors
 * {@link ./recommendations.recommendationToPending} so posture fixes flow through
 * the same trusted queue pipeline.
 */
export function postureFixToPending(check: PostureCheck, zoneId: string): QueuedRecommendation | null {
  const fix = check.fix;
  if (!fix) return null;
  const path = fix.path.replace(/\{zone\}/g, zoneId);
  if (/[<>()\s]/.test(path)) return null;
  return { product: `Posture · ${check.area}`, summary: fix.summary, method: fix.method, path, body: fix.body, zoneId };
}

/** Whether a check can be one-click queued (vs. handed to Glide in chat). */
export function isPostureFixQueueable(check: PostureCheck): boolean {
  return postureFixToPending(check, "0".repeat(32)) !== null;
}

/** Render a posture report as compact text for the model to relay in chat. */
export function formatPostureForModel(report: PostureReport): string {
  const lines: string[] = [
    `Security posture for ${report.zoneName ?? report.zoneId}: grade ${report.grade} (${report.score}/100).`,
    report.summary,
    "",
  ];
  const order: PostureStatus[] = ["fail", "warn", "pass", "unknown"];
  const label: Record<PostureStatus, string> = {
    fail: "FAILING",
    warn: "NEEDS IMPROVEMENT",
    pass: "PASSING",
    unknown: "UNREADABLE",
  };
  for (const st of order) {
    const items = report.checks.filter((c) => c.status === st);
    if (!items.length) continue;
    lines.push(`## ${label[st]}`);
    for (const c of items) {
      lines.push(`- [${c.area}] ${c.title} — ${c.detail}`);
      if (st !== "pass" && st !== "unknown") {
        if (c.fix) lines.push(`  Fix: queue "${c.fix.summary}"${c.fix.reviewRequired ? " (review before Apply)" : ""}.`);
        else if (c.ask) lines.push(`  Fix: ${c.ask} (Glide will set it up in chat).`);
      }
      if (c.docs[0]) lines.push(`  Docs: ${c.docs[0]}`);
    }
    lines.push("");
  }
  lines.push(
    "Offer to QUEUE the one-click fixes (each is a proposal a human Applies — never claim anything changed until Applied). Items without a one-click fix need a short chat-guided setup.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Configuration-drift watch
//
// A "baseline" is simply a previously-scored PostureReport that a human blessed
// as the known-good state. diffPosture compares a fresh report against it and
// reports which checks *regressed* (drifted away from secure) or *recovered*.
// Like everything else here it is pure and deterministic so the scheduled watch
// and the on-demand tool share exactly one implementation.
// ---------------------------------------------------------------------------

/** Severity ordering used to decide whether a status change is a regression. */
const DRIFT_SEVERITY: Record<PostureStatus, number> = { pass: 0, warn: 1, fail: 2, unknown: -1 };

/** A single check whose status changed between the baseline and the current report. */
export interface PostureDelta {
  id: string;
  area: PostureArea;
  title: string;
  /** Status in the baseline report. */
  from: PostureStatus;
  /** Status in the current report. */
  to: PostureStatus;
  /** "regression" = drifted toward less-secure; "improvement" = recovered. */
  direction: "regression" | "improvement";
}

/** The result of comparing a current report against a blessed baseline. */
export interface PostureDrift {
  /** ms epoch of the baseline report. */
  baselineTs: number;
  /** ms epoch of the current report. */
  currentTs: number;
  baselineGrade: PostureGrade;
  currentGrade: PostureGrade;
  baselineScore: number;
  currentScore: number;
  /** Checks that got worse, worst jump first. */
  regressions: PostureDelta[];
  /** Checks that got better. */
  improvements: PostureDelta[];
  /** True when there is at least one regression. */
  drifted: boolean;
  /** One-line natural-language summary (deterministic — no dates). */
  summary: string;
}

/**
 * Compare a freshly-scored report against a blessed baseline. Transitions that
 * involve an `unknown` (unreadable) status on either side are ignored — a fact we
 * couldn't read is not evidence that the configuration changed. Pure and
 * deterministic: identical inputs always produce an identical drift.
 */
export function diffPosture(baseline: PostureReport, current: PostureReport): PostureDrift {
  const baseById = new Map(baseline.checks.map((c) => [c.id, c] as const));
  const regressions: PostureDelta[] = [];
  const improvements: PostureDelta[] = [];
  for (const cur of current.checks) {
    const base = baseById.get(cur.id);
    if (!base) continue; // a check that didn't exist at baseline — nothing to compare
    if (base.status === "unknown" || cur.status === "unknown") continue;
    if (base.status === cur.status) continue;
    const delta: PostureDelta = {
      id: cur.id,
      area: cur.area,
      title: cur.title,
      from: base.status,
      to: cur.status,
      direction: DRIFT_SEVERITY[cur.status] > DRIFT_SEVERITY[base.status] ? "regression" : "improvement",
    };
    (delta.direction === "regression" ? regressions : improvements).push(delta);
  }
  // Worst regressions first (largest severity jump).
  const jump = (d: PostureDelta) => DRIFT_SEVERITY[d.to] - DRIFT_SEVERITY[d.from];
  regressions.sort((a, b) => jump(b) - jump(a));
  improvements.sort((a, b) => jump(a) - jump(b));

  const gradeMove =
    current.grade === baseline.grade
      ? `grade held at ${current.grade}`
      : `grade ${baseline.grade}→${current.grade}`;
  let summary: string;
  if (regressions.length === 0 && improvements.length === 0) {
    summary = `No posture drift since the baseline — ${gradeMove} (${current.score}/100).`;
  } else if (regressions.length > 0) {
    summary =
      `${regressions.length} posture regression${regressions.length === 1 ? "" : "s"} since the baseline` +
      (improvements.length ? ` (and ${improvements.length} improvement${improvements.length === 1 ? "" : "s"})` : "") +
      `: ${gradeMove} (${baseline.score}→${current.score}).`;
  } else {
    summary =
      `Posture improved since the baseline: ${improvements.length} check${improvements.length === 1 ? "" : "s"} recovered — ` +
      `${gradeMove} (${baseline.score}→${current.score}).`;
  }

  return {
    baselineTs: baseline.ts,
    currentTs: current.ts,
    baselineGrade: baseline.grade,
    currentGrade: current.grade,
    baselineScore: baseline.score,
    currentScore: current.score,
    regressions,
    improvements,
    drifted: regressions.length > 0,
    summary,
  };
}

/** Render a drift result as compact text for the model to relay in chat. */
export function formatDriftForModel(drift: PostureDrift): string {
  const lines: string[] = [drift.summary];
  const render = (d: PostureDelta) => `- [${d.area}] ${d.title}: ${d.from.toUpperCase()} → ${d.to.toUpperCase()}`;
  if (drift.regressions.length) {
    lines.push("", "## REGRESSIONS (config drifted away from a secure baseline)");
    for (const d of drift.regressions) lines.push(render(d));
  }
  if (drift.improvements.length) {
    lines.push("", "## IMPROVEMENTS (recovered since the baseline)");
    for (const d of drift.improvements) lines.push(render(d));
  }
  if (drift.regressions.length) {
    lines.push(
      "",
      "Offer to re-queue the one-click fixes for the regressed checks (each is a proposal a human Applies — never claim anything changed until Applied).",
    );
  }
  return lines.join("\n");
}
