/**
 * Glide's recommendation engine.
 *
 * Turns a {@link BusinessProfile} (the answers to Glide's "nature of the
 * business" discovery questions) into a curated, deterministic set of Cloudflare
 * performance / security / reliability recommendations. This keeps suggestions
 * consistent and grounded rather than letting the model free-associate: the LLM
 * calls the `recommend_configuration` tool, gets this set back, then explains the
 * relevant items and offers to QUEUE each one via the existing builder tools
 * (`set_zone_setting`, `create_waf_custom_rule`, `cf_write`).
 *
 * Nothing here touches the Cloudflare API. It only proposes. The safety contract
 * is unchanged: every real change is still queued for a human to Apply.
 */

import type { BusinessProfile, SetupType } from "./shared";

/** Broad grouping so the UI/model can present recommendations by theme. */
export type RecommendationCategory =
  | "tls"
  | "security"
  | "bots"
  | "api"
  | "performance"
  | "reliability"
  | "privacy";

export type RecommendationPriority = "high" | "medium" | "low";

/** How the model should turn a recommendation into a queued pending action. */
export interface RecommendationAction {
  /**
   * Preferred builder tool to queue this with:
   * - `set_zone_setting`: a simple zone setting (uses `setting` + `value`).
   * - `create_waf_custom_rule`: a WAF custom rule (uses `expression` + `action`).
   * - `cf_write`: any other API change (uses `method` + `path` + `body`).
   * - `manual`: needs a paid plan / dashboard step; Glide should guide, not queue.
   */
  tool: "set_zone_setting" | "create_waf_custom_rule" | "cf_write" | "manual";
  /** One-line, human-readable description of the concrete change to queue. */
  hint: string;
  /** For `set_zone_setting`: the exact setting id (e.g. "min_tls_version"). */
  setting?: string;
  /** For `set_zone_setting`: the exact value (e.g. "1.2"). */
  value?: string | number | boolean;
  /** For `create_waf_custom_rule` / rate-limit: a suggested wirefilter expression. */
  expression?: string;
  /** Suggested WAF/rate-limit action (e.g. "managed_challenge", "block", "log"). */
  ruleAction?: string;
  /** For `cf_write`: HTTP method. */
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /** For `cf_write`: API path after https://api.cloudflare.com/client/v4 (`{zone}` = the zone id). */
  path?: string;
  /** For `cf_write`: request body. */
  body?: unknown;
  /**
   * True when the item needs a paid plan/subscription or careful review before it
   * can be safely queued. Glide should flag this and confirm before queueing.
   */
  reviewRequired?: boolean;
}

/** A single tailored recommendation. */
export interface Recommendation {
  /** Stable id (dedupes multiple triggers of the same suggestion). */
  id: string;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  /** Cloudflare product/area label for the UI, e.g. "SSL/TLS", "WAF". */
  product: string;
  /** Short imperative title, e.g. "Set SSL/TLS mode to Full (strict)". */
  title: string;
  /** Why it matters for THIS business — tie it back to the profile. */
  rationale: string;
  /** Human-readable profile signals that triggered it (for transparency). */
  because: string[];
  /** How to apply it (queued via a builder). */
  action: RecommendationAction;
  /** Cloudflare docs URLs to cite. */
  docs: string[];
}

/** The full result of running the engine against a profile. */
export interface RecommendationSet {
  recommendations: Recommendation[];
  /** One-line natural-language summary of the profile the set was built from. */
  profileSummary: string;
  /** Discovery dimensions still unanswered — questions Glide should ask next. */
  missing: string[];
}

const PRIORITY_RANK: Record<RecommendationPriority, number> = { high: 0, medium: 1, low: 2 };

// Stable, canonical Cloudflare developer-docs URLs used for citations.
const DOCS = {
  sslModes: "https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/",
  minTls: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/",
  tls13: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/tls-13/",
  alwaysHttps: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/",
  hsts: "https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/",
  waf: "https://developers.cloudflare.com/waf/",
  managedRules: "https://developers.cloudflare.com/waf/managed-rules/",
  customRules: "https://developers.cloudflare.com/waf/custom-rules/",
  rateLimiting: "https://developers.cloudflare.com/waf/rate-limiting-rules/",
  leakedCreds: "https://developers.cloudflare.com/waf/detections/leaked-credentials/",
  bots: "https://developers.cloudflare.com/bots/",
  botFightMode: "https://developers.cloudflare.com/bots/get-started/bot-fight-mode/",
  superBotFightMode: "https://developers.cloudflare.com/bots/get-started/super-bot-fight-mode/",
  turnstile: "https://developers.cloudflare.com/turnstile/",
  apiShield: "https://developers.cloudflare.com/api-shield/",
  schemaValidation: "https://developers.cloudflare.com/api-shield/security/schema-validation/",
  jwtValidation: "https://developers.cloudflare.com/api-shield/security/jwt-validation/",
  mtls: "https://developers.cloudflare.com/api-shield/security/mtls/",
  cache: "https://developers.cloudflare.com/cache/",
  cacheRules: "https://developers.cloudflare.com/cache/how-to/cache-rules/",
  tieredCache: "https://developers.cloudflare.com/cache/how-to/tiered-cache/",
  argo: "https://developers.cloudflare.com/argo-smart-routing/",
  speed: "https://developers.cloudflare.com/speed/optimization/",
  loadBalancing: "https://developers.cloudflare.com/load-balancing/",
  ddos: "https://developers.cloudflare.com/ddos-protection/",
  access: "https://developers.cloudflare.com/cloudflare-one/policies/access/",
  gateway: "https://developers.cloudflare.com/cloudflare-one/policies/gateway/",
  dataLocalization: "https://developers.cloudflare.com/data-localization/",
  logpush: "https://developers.cloudflare.com/logs/logpush/",
} as const;

// Human labels for canonical profile keys (kept in sync with the client).
const INDUSTRY_LABELS: Record<string, string> = {
  ecommerce: "E-commerce",
  saas: "SaaS",
  fintech: "Fintech / financial services",
  healthcare: "Healthcare",
  media: "Media / publishing",
  gaming: "Gaming",
  government: "Government / public sector",
  education: "Education",
  nonprofit: "Nonprofit",
  marketing: "Marketing / brand site",
  api_platform: "API platform",
  other: "Other",
};

const APP_TYPE_LABELS: Record<string, string> = {
  website: "website",
  web_app: "web application",
  api: "API",
  mobile_backend: "mobile backend",
  static_site: "static site",
  ugc: "user-generated-content platform",
};

const CONCERN_LABELS: Record<string, string> = {
  bots: "automated bot traffic",
  ddos: "DDoS attacks",
  scraping: "content scraping",
  credential_stuffing: "credential stuffing / account takeover",
  card_testing: "carding / card testing",
  fraud: "fraud / abuse",
  latency: "latency / slow load times",
  downtime: "downtime / availability",
  cost: "origin / egress cost",
};

const COMPLIANCE_LABELS: Record<string, string> = {
  pci_dss: "PCI DSS",
  hipaa: "HIPAA",
  gdpr: "GDPR",
  soc2: "SOC 2",
  iso27001: "ISO 27001",
  fedramp: "FedRAMP",
};

const SENSITIVE_LABELS: Record<string, string> = {
  pii: "personal data (PII)",
  payments: "payment / cardholder data",
  health: "health data (PHI)",
  credentials: "user credentials",
  financial: "financial data",
};

export function industryLabel(key?: string): string | undefined {
  if (!key) return undefined;
  return INDUSTRY_LABELS[key] ?? key;
}

/**
 * Run the engine. `profile` may be partial or undefined; recommendations are
 * emitted for whatever signals are present, plus a baseline that applies to any
 * internet-facing property. `ctx` lets onboarding answers (goals, DNS setup)
 * refine the output.
 */
export function recommendConfigurations(
  profile: BusinessProfile | undefined,
  ctx?: { goals?: string[]; setupType?: SetupType },
): RecommendationSet {
  const p: BusinessProfile = {
    appTypes: [],
    sensitiveData: [],
    compliance: [],
    concerns: [],
    ...(profile ?? {}),
  };
  const goals = new Set((ctx?.goals ?? []).map((g) => g.toLowerCase()));

  const has = (list: string[], key: string) => list.includes(key);
  const industry = p.industry;
  const isEcommerce = industry === "ecommerce" || has(p.concerns, "card_testing");
  const isFintech = industry === "fintech";
  const isHealthcare = industry === "healthcare";
  const isMedia = industry === "media";
  const handlesPayments = has(p.sensitiveData, "payments") || isEcommerce || isFintech;
  const handlesHealth = has(p.sensitiveData, "health") || isHealthcare;
  const handlesPii = has(p.sensitiveData, "pii") || handlesHealth || handlesPayments;
  const hasLogin = p.hasLogin === true || has(p.sensitiveData, "credentials");
  const hasApi = p.hasApi === true || has(p.appTypes, "api") || industry === "api_platform";
  const global = p.audience === "global";
  const spiky = p.trafficProfile === "spiky" || p.trafficProfile === "high_volume";
  const cacheable = p.cacheableContent === true || isMedia || has(p.appTypes, "static_site");

  const pci = has(p.compliance, "pci_dss") || handlesPayments;
  const hipaa = has(p.compliance, "hipaa") || handlesHealth;
  const gdpr = has(p.compliance, "gdpr");
  const soc2 = has(p.compliance, "soc2");

  // Collect with de-dup + priority/rationale/because merging.
  const byId = new Map<string, Recommendation>();
  const add = (rec: Recommendation) => {
    const existing = byId.get(rec.id);
    if (!existing) {
      byId.set(rec.id, { ...rec, because: dedupe(rec.because) });
      return;
    }
    // Merge: keep the strongest priority and union the reasons/rationale.
    if (PRIORITY_RANK[rec.priority] < PRIORITY_RANK[existing.priority]) existing.priority = rec.priority;
    existing.because = dedupe([...existing.because, ...rec.because]);
  };

  // -- Baseline: every internet-facing property ----------------------------
  add({
    id: "ssl_full_strict",
    category: "tls",
    priority: "high",
    product: "SSL/TLS",
    title: "Set SSL/TLS encryption mode to Full (strict)",
    rationale:
      "Encrypts traffic end-to-end and validates the origin certificate, preventing downgrade and man-in-the-middle attacks. Avoid 'Flexible', which leaves the Cloudflare→origin hop unencrypted.",
    because: ["Applies to any site serving traffic over Cloudflare"],
    action: {
      tool: "set_zone_setting",
      setting: "ssl",
      value: "strict",
      hint: "Queue set_zone_setting ssl = strict (only after a valid origin certificate is in place).",
      reviewRequired: true,
    },
    docs: [DOCS.sslModes],
  });
  add({
    id: "always_use_https",
    category: "tls",
    priority: "high",
    product: "SSL/TLS",
    title: "Redirect all traffic to HTTPS",
    rationale: "Forces every request onto TLS so no request is served in the clear.",
    because: ["Applies to any site serving traffic over Cloudflare"],
    action: {
      tool: "set_zone_setting",
      setting: "always_use_https",
      value: "on",
      hint: "Queue set_zone_setting always_use_https = on.",
    },
    docs: [DOCS.alwaysHttps],
  });
  add({
    id: "min_tls_12",
    category: "tls",
    priority: "medium",
    product: "SSL/TLS",
    title: "Require a minimum TLS version of 1.2",
    rationale: "Blocks obsolete, insecure TLS 1.0/1.1 clients — a baseline hardening step.",
    because: ["Applies to any site serving traffic over Cloudflare"],
    action: {
      tool: "set_zone_setting",
      setting: "min_tls_version",
      value: "1.2",
      hint: "Queue set_zone_setting min_tls_version = 1.2.",
    },
    docs: [DOCS.minTls],
  });
  add({
    id: "waf_managed_rules",
    category: "security",
    priority: "high",
    product: "WAF",
    title: "Deploy the Cloudflare Managed Ruleset (WAF)",
    rationale:
      "Cloudflare's managed WAF ruleset blocks common exploits (injection, RCE, known CVEs) out of the box and is maintained by Cloudflare's security team.",
    because: ["Applies to any application exposed to the internet"],
    action: {
      tool: "cf_write",
      method: "PUT",
      path: "/zones/{zone}/rulesets/phases/http_request_firewall_managed/entrypoint",
      hint: "Deploy the Cloudflare Managed Ruleset by adding an `execute` rule for the managed ruleset id to the http_request_firewall_managed phase entry point. Review before Apply.",
      reviewRequired: true,
    },
    docs: [DOCS.managedRules, DOCS.waf],
  });

  // -- Login / authentication flows ----------------------------------------
  if (hasLogin) {
    add({
      id: "rate_limit_login",
      category: "security",
      priority: "high",
      product: "Rate limiting",
      title: "Rate limit the login / authentication endpoint",
      rationale:
        "Caps how many login attempts a single client can make, blunting brute-force and credential-stuffing attacks against your auth endpoint.",
      because: ["The app has user login / authentication flows"],
      action: {
        tool: "cf_write",
        method: "POST",
        path: "/zones/{zone}/rulesets/phases/http_ratelimit/entrypoint (or add a rate limiting rule)",
        expression: 'http.request.uri.path eq "/login" and http.request.method eq "POST"',
        ruleAction: "managed_challenge",
        hint: "Queue a rate limiting rule on the login path (e.g. 5–10 requests/minute per client IP, mitigation managed_challenge). Adjust the path to the real login endpoint.",
        reviewRequired: true,
      },
      docs: [DOCS.rateLimiting],
    });
    add({
      id: "leaked_credentials",
      category: "security",
      priority: "high",
      product: "WAF",
      title: "Enable leaked-credential detection",
      rationale:
        "Flags logins using username/password pairs known to be exposed in prior breaches, so you can challenge or block account-takeover attempts.",
      because: ["The app has user login / authentication flows"],
      action: {
        tool: "manual",
        hint: "Enable the Leaked Credentials detection in the WAF, then add a WAF custom rule acting on cf.waf.credential_check.password_leaked.",
        reviewRequired: true,
      },
      docs: [DOCS.leakedCreds],
    });
    add({
      id: "turnstile_login",
      category: "security",
      priority: "medium",
      product: "Turnstile",
      title: "Add Turnstile (CAPTCHA alternative) to login / signup",
      rationale:
        "A privacy-friendly challenge on auth and signup forms stops automated account creation and credential stuffing without hurting real users.",
      because: ["The app has user login / authentication flows"],
      action: {
        tool: "manual",
        hint: "Create a Turnstile widget and embed it on the login/signup forms, verifying the token server-side.",
      },
      docs: [DOCS.turnstile],
    });
  }

  // -- Payments / e-commerce / carding -------------------------------------
  if (handlesPayments) {
    add({
      id: "bot_management_checkout",
      category: "bots",
      priority: "high",
      product: "Bots",
      title: "Turn on bot protection to stop card testing / carding",
      rationale:
        "Automated card-testing hits checkout and payment endpoints with stolen card numbers. Bot Fight Mode (or Super Bot Fight Mode on paid plans) challenges automated traffic before it reaches those endpoints.",
      because: ["Handles payment / cardholder data"],
      action: {
        tool: "manual",
        hint: "Enable Bot Fight Mode (Free) or configure Super Bot Fight Mode (Pro+) to challenge/block automated traffic, especially on checkout and payment paths.",
        reviewRequired: true,
      },
      docs: [DOCS.botFightMode, DOCS.superBotFightMode],
    });
    add({
      id: "rate_limit_checkout",
      category: "security",
      priority: "high",
      product: "Rate limiting",
      title: "Rate limit checkout / payment endpoints",
      rationale:
        "Limits rapid-fire requests to payment endpoints, a hallmark of card-testing and checkout-abuse attacks.",
      because: ["Handles payment / cardholder data"],
      action: {
        tool: "cf_write",
        expression: 'http.request.uri.path contains "/checkout" or http.request.uri.path contains "/payment"',
        ruleAction: "block",
        hint: "Queue a rate limiting rule on checkout/payment paths tuned to your legitimate purchase rate.",
        reviewRequired: true,
      },
      docs: [DOCS.rateLimiting],
    });
  }

  // -- PCI DSS -------------------------------------------------------------
  if (pci) {
    add({
      id: "min_tls_12",
      category: "tls",
      priority: "high",
      product: "SSL/TLS",
      title: "Require a minimum TLS version of 1.2 (PCI DSS)",
      rationale: "PCI DSS requires disabling early TLS. Setting the minimum to 1.2 removes TLS 1.0/1.1.",
      because: ["PCI DSS is in scope"],
      action: { tool: "set_zone_setting", setting: "min_tls_version", value: "1.2", hint: "Queue set_zone_setting min_tls_version = 1.2." },
      docs: [DOCS.minTls],
    });
    add({
      id: "tls_13",
      category: "tls",
      priority: "medium",
      product: "SSL/TLS",
      title: "Enable TLS 1.3",
      rationale: "TLS 1.3 is faster and more secure; enabling it is recommended alongside PCI DSS hardening.",
      because: ["PCI DSS is in scope"],
      action: { tool: "set_zone_setting", setting: "tls_1_3", value: "on", hint: "Queue set_zone_setting tls_1_3 = on." },
      docs: [DOCS.tls13],
    });
    add({
      id: "hsts",
      category: "tls",
      priority: "medium",
      product: "SSL/TLS",
      title: "Enable HSTS (HTTP Strict Transport Security)",
      rationale:
        "Tells browsers to only ever connect over HTTPS. Required posture for PCI DSS. Enable carefully — it is hard to undo once cached by browsers.",
      because: ["PCI DSS is in scope"],
      action: {
        tool: "cf_write",
        method: "PATCH",
        path: "/zones/{zone}/settings/security_header",
        body: { value: { strict_transport_security: { enabled: true, max_age: 31536000, include_subdomains: true, nosniff: true } } },
        hint: "Queue HSTS via the security_header setting (max-age 1 year, includeSubDomains). Confirm the team is fully on HTTPS first — HSTS is sticky.",
        reviewRequired: true,
      },
      docs: [DOCS.hsts],
    });
  }

  // -- HIPAA / health ------------------------------------------------------
  if (hipaa) {
    add({
      id: "hsts",
      category: "tls",
      priority: "high",
      product: "SSL/TLS",
      title: "Enable HSTS to enforce encryption in transit",
      rationale:
        "HIPAA requires protecting PHI in transit. HSTS guarantees browsers never downgrade to HTTP. Enable carefully — it is sticky once cached.",
      because: ["HIPAA / health data is in scope"],
      action: {
        tool: "cf_write",
        method: "PATCH",
        path: "/zones/{zone}/settings/security_header",
        body: { value: { strict_transport_security: { enabled: true, max_age: 31536000, include_subdomains: true, nosniff: true } } },
        hint: "Queue HSTS via the security_header setting once the team is fully on HTTPS.",
        reviewRequired: true,
      },
      docs: [DOCS.hsts],
    });
    add({
      id: "access_internal_apps",
      category: "security",
      priority: "high",
      product: "Zero Trust (Access)",
      title: "Put admin / internal tools behind Cloudflare Access",
      rationale:
        "Restrict PHI-handling admin surfaces to authenticated, authorized identities with MFA — a strong access control for HIPAA.",
      because: ["HIPAA / health data is in scope"],
      action: {
        tool: "manual",
        hint: "Create a Cloudflare Access application + policy for internal/admin hostnames, requiring your IdP and MFA.",
        reviewRequired: true,
      },
      docs: [DOCS.access],
    });
  }

  // -- GDPR / data localization -------------------------------------------
  if (gdpr || (global && handlesPii)) {
    add({
      id: "data_localization",
      category: "privacy",
      priority: gdpr ? "high" : "medium",
      product: "Data Localization",
      title: "Keep inspection and keys in-region with the Data Localization Suite",
      rationale:
        "Regional Services and the Data Localization Suite let you control where TLS termination and traffic inspection happen (e.g. EU-only), supporting GDPR data-residency requirements.",
      because: gdpr ? ["GDPR is in scope"] : ["Global audience handling personal data"],
      action: {
        tool: "manual",
        hint: "Review the Data Localization Suite (Regional Services + Customer Metadata Boundary + Keyless/Geo Key Manager) to pin data handling to a region.",
        reviewRequired: true,
      },
      docs: [DOCS.dataLocalization],
    });
  }

  // -- SOC 2 / logging -----------------------------------------------------
  if (soc2 || hipaa || pci) {
    add({
      id: "logpush",
      category: "security",
      priority: "medium",
      product: "Logs",
      title: "Stream security logs to your SIEM with Logpush",
      rationale:
        "Auditable, retained logs of HTTP requests and security events support SOC 2 / PCI / HIPAA evidence and incident investigation.",
      because: dedupe([
        soc2 ? "SOC 2 is in scope" : "",
        hipaa ? "HIPAA is in scope" : "",
        pci ? "PCI DSS is in scope" : "",
      ]),
      action: {
        tool: "manual",
        hint: "Configure a Logpush job for HTTP requests and/or firewall events to your storage/SIEM destination.",
        reviewRequired: true,
      },
      docs: [DOCS.logpush],
    });
  }

  // -- APIs ----------------------------------------------------------------
  if (hasApi) {
    add({
      id: "api_shield_schema",
      category: "api",
      priority: "high",
      product: "API Shield",
      title: "Validate API requests against an OpenAPI schema (API Shield)",
      rationale:
        "Schema validation rejects malformed or out-of-contract requests at the edge, shrinking your API's attack surface. Start in log mode, then switch to block.",
      because: ["The team exposes an API"],
      action: {
        tool: "manual",
        hint: "Upload your OpenAPI schema to API Shield → Schema validation (start with action = log, then block).",
        reviewRequired: true,
      },
      docs: [DOCS.schemaValidation, DOCS.apiShield],
    });
    add({
      id: "api_rate_limit",
      category: "api",
      priority: "high",
      product: "Rate limiting",
      title: "Rate limit API endpoints per client",
      rationale:
        "Protects the API from abuse and runaway clients. Use an API key / token header as the rate-limit characteristic where possible.",
      because: ["The team exposes an API"],
      action: {
        tool: "cf_write",
        expression: 'http.request.uri.path contains "/api/"',
        ruleAction: "block",
        hint: "Queue a rate limiting rule scoped to API paths, keyed on the client's API token/header rather than just IP.",
        reviewRequired: true,
      },
      docs: [DOCS.rateLimiting],
    });
    add({
      id: "api_auth",
      category: "api",
      priority: "medium",
      product: "API Shield",
      title: "Enforce client authentication (mTLS / JWT validation)",
      rationale:
        "mTLS client certificates or JWT validation ensure only known, authenticated clients can call sensitive API endpoints.",
      because: ["The team exposes an API"],
      action: {
        tool: "manual",
        hint: "Set up mTLS client certificates and/or JWT validation in API Shield for sensitive endpoints.",
        reviewRequired: true,
      },
      docs: [DOCS.mtls, DOCS.jwtValidation],
    });
  }

  // -- Bots / scraping -----------------------------------------------------
  if (has(p.concerns, "bots") || has(p.concerns, "scraping") || isEcommerce || has(p.appTypes, "ugc")) {
    add({
      id: "bot_fight_mode",
      category: "bots",
      priority: "high",
      product: "Bots",
      title: "Enable bot protection (Bot Fight / Super Bot Fight Mode)",
      rationale:
        "Detects and challenges automated traffic — scrapers, scanners, and abusive bots — before it reaches your origin.",
      because: dedupe([
        has(p.concerns, "bots") ? "Concerned about automated bot traffic" : "",
        has(p.concerns, "scraping") ? "Concerned about content scraping" : "",
        has(p.appTypes, "ugc") ? "Runs a user-generated-content platform" : "",
      ]),
      action: {
        tool: "manual",
        hint: "Enable Bot Fight Mode (Free) or Super Bot Fight Mode (Pro+); optionally add WAF custom rules using cf.bot_management.score.",
        reviewRequired: true,
      },
      docs: [DOCS.botFightMode, DOCS.superBotFightMode, DOCS.bots],
    });
  }

  // -- DDoS / spiky / high-volume traffic ----------------------------------
  if (has(p.concerns, "ddos") || spiky) {
    add({
      id: "ddos_awareness",
      category: "reliability",
      priority: "medium",
      product: "DDoS protection",
      title: "Tune the HTTP DDoS Managed Ruleset sensitivity",
      rationale:
        "Cloudflare's always-on DDoS protection is enabled by default; for spiky/high-volume or attack-prone traffic, review the managed ruleset sensitivity and add rate limiting for layer-7 floods.",
      because: dedupe([
        has(p.concerns, "ddos") ? "Concerned about DDoS attacks" : "",
        spiky ? "Traffic is spiky / high-volume" : "",
      ]),
      action: {
        tool: "manual",
        hint: "Review the HTTP DDoS Managed Ruleset overrides and pair with rate limiting rules for sensitive endpoints.",
        reviewRequired: true,
      },
      docs: [DOCS.ddos, DOCS.rateLimiting],
    });
  }

  // -- Performance: caching ------------------------------------------------
  if (cacheable || goals.has("cache") || has(p.concerns, "latency") || has(p.concerns, "cost")) {
    add({
      id: "cache_rules_static",
      category: "performance",
      priority: "medium",
      product: "Cache",
      title: "Cache static assets with Cache Rules",
      rationale:
        "Serving images, CSS/JS, and other static assets from Cloudflare's edge cuts origin load, latency, and egress cost.",
      because: dedupe([
        cacheable ? "A meaningful share of content is static/cacheable" : "",
        has(p.concerns, "latency") ? "Concerned about latency" : "",
        has(p.concerns, "cost") ? "Concerned about origin/egress cost" : "",
      ]),
      action: {
        tool: "cf_write",
        method: "PUT",
        path: "/zones/{zone}/rulesets/phases/http_request_cache_settings/entrypoint",
        hint: "Queue a Cache Rule that sets cache eligibility (and edge TTL) for static asset paths/extensions.",
        reviewRequired: true,
      },
      docs: [DOCS.cacheRules, DOCS.cache],
    });
    add({
      id: "brotli",
      category: "performance",
      priority: "low",
      product: "Speed",
      title: "Enable Brotli compression",
      rationale: "Compresses text responses more efficiently than gzip, reducing transfer size and load time.",
      because: ["Performance / caching is a goal"],
      action: { tool: "set_zone_setting", setting: "brotli", value: "on", hint: "Queue set_zone_setting brotli = on." },
      docs: [DOCS.speed],
    });
  }

  // -- Performance: global audience ---------------------------------------
  if (global || has(p.concerns, "latency")) {
    add({
      id: "tiered_cache",
      category: "performance",
      priority: "medium",
      product: "Cache",
      title: "Enable Tiered Cache",
      rationale:
        "Uses upper-tier data centers so cache misses are filled from a nearby tier instead of your origin, improving hit ratio and reducing long-tail latency for a global audience.",
      because: dedupe([global ? "Serves a global audience" : "", has(p.concerns, "latency") ? "Concerned about latency" : ""]),
      action: {
        tool: "cf_write",
        method: "PATCH",
        path: "/zones/{zone}/argo/tiered_caching",
        body: { value: "on" },
        hint: "Queue enabling Tiered Cache (Smart Tiered Cache topology recommended).",
      },
      docs: [DOCS.tieredCache],
    });
    add({
      id: "argo_smart_routing",
      category: "performance",
      priority: "low",
      product: "Argo Smart Routing",
      title: "Consider Argo Smart Routing",
      rationale:
        "Routes traffic over the fastest network paths, cutting latency ~30% on average — most impactful for a global audience or a distant origin. Paid add-on.",
      because: [global ? "Serves a global audience" : "Concerned about latency"],
      action: {
        tool: "manual",
        hint: "Argo Smart Routing is a paid add-on. Enable via Traffic → Argo (or Smart Shield) after confirming the subscription.",
        reviewRequired: true,
      },
      docs: [DOCS.argo],
    });
  }

  // -- Reliability: load balancing ----------------------------------------
  if (goals.has("load_balancing") || has(p.concerns, "downtime")) {
    add({
      id: "load_balancing",
      category: "reliability",
      priority: has(p.concerns, "downtime") ? "high" : "medium",
      product: "Load Balancing",
      title: "Set up Load Balancing with health checks and failover",
      rationale:
        "Distributes traffic across multiple origins and fails over automatically when one is unhealthy, protecting availability.",
      because: dedupe([
        goals.has("load_balancing") ? "Load balancing is a goal" : "",
        has(p.concerns, "downtime") ? "Concerned about downtime / availability" : "",
      ]),
      action: {
        tool: "manual",
        hint: "Create a Load Balancer with pools, origins, and health monitors; add geo/failover steering as needed.",
        reviewRequired: true,
      },
      docs: [DOCS.loadBalancing],
    });
  }

  // -- Zero Trust for internal apps ---------------------------------------
  if (p.audience === "internal" || goals.has("zero_trust")) {
    add({
      id: "access_internal_apps",
      category: "security",
      priority: "high",
      product: "Zero Trust (Access)",
      title: "Protect internal apps with Cloudflare Access",
      rationale:
        "Replaces VPN exposure with identity-aware access: only authenticated, authorized users reach internal applications.",
      because: dedupe([
        p.audience === "internal" ? "The app primarily serves internal users" : "",
        goals.has("zero_trust") ? "Zero Trust is a goal" : "",
      ]),
      action: {
        tool: "manual",
        hint: "Create Access applications + policies (with your IdP) for internal hostnames; front them with a Cloudflare Tunnel where there is no public origin.",
        reviewRequired: true,
      },
      docs: [DOCS.access, DOCS.gateway],
    });
  }

  const recommendations = [...byId.values()].sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    return a.category.localeCompare(b.category);
  });

  return {
    recommendations,
    profileSummary: summarizeProfile(p),
    missing: missingDimensions(p),
  };
}

/** Build a one-line, human-readable summary of the profile for prompts/UI. */
export function summarizeProfile(p: BusinessProfile): string {
  const bits: string[] = [];
  const ind = industryLabel(p.industry);
  if (ind) bits.push(ind);
  if (p.appTypes.length) bits.push(p.appTypes.map((a) => APP_TYPE_LABELS[a] ?? a).join(" + "));
  if (p.audience) bits.push(`${p.audience} audience`);
  if (p.trafficProfile) bits.push(`${p.trafficProfile.replace("_", "-")} traffic`);
  if (p.hasLogin) bits.push("user logins");
  if (p.hasApi) bits.push("an API");
  if (p.sensitiveData.length) bits.push(`handles ${p.sensitiveData.map((s) => SENSITIVE_LABELS[s] ?? s).join(", ")}`);
  if (p.compliance.length) bits.push(`${p.compliance.map((c) => COMPLIANCE_LABELS[c] ?? c).join(", ")} in scope`);
  if (p.concerns.length) bits.push(`worried about ${p.concerns.map((c) => CONCERN_LABELS[c] ?? c).join(", ")}`);
  return bits.length ? bits.join("; ") : "(no business profile captured yet)";
}

/** Which discovery dimensions are still blank — the questions Glide should ask next. */
export function missingDimensions(p: BusinessProfile): string[] {
  const missing: string[] = [];
  if (!p.industry) missing.push("industry / what the business does");
  if (!p.appTypes.length) missing.push("what kind of app (website, web app, API, static site)");
  if (p.hasLogin === undefined) missing.push("whether users log in");
  if (p.hasApi === undefined) missing.push("whether an API is exposed");
  if (!p.audience) missing.push("audience reach (global, regional, internal)");
  if (!p.trafficProfile) missing.push("traffic profile (steady, spiky, high-volume)");
  if (!p.sensitiveData.length) missing.push("sensitive data handled (PII, payments, health, credentials)");
  if (!p.compliance.length) missing.push("compliance requirements (PCI, HIPAA, GDPR, SOC 2)");
  if (!p.concerns.length) missing.push("top concerns (bots, DDoS, scraping, latency, downtime, cost)");
  return missing;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter((s) => s && s.trim()))];
}

/** A concrete, queue-ready Cloudflare API call derived from a recommendation. */
export interface QueuedRecommendation {
  product: string;
  summary: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path after https://api.cloudflare.com/client/v4, with the real zone id substituted. */
  path: string;
  body?: unknown;
  zoneId: string;
}

/**
 * Map a recommendation to a concrete, queue-ready Cloudflare API call — or `null`
 * when it can't be safely one-click queued and should instead be handed to Glide
 * in chat (it needs discovery, a managed-ruleset id, a real endpoint path, or a
 * paid-plan / dashboard step).
 *
 * Only two action shapes are treated as concrete:
 *   • a simple zone setting (`set_zone_setting` with a `setting` + `value`), and
 *   • a `cf_write` with an explicit `method`, a `body`, and a placeholder-free path.
 *
 * `{zone}` in the path is replaced with the real zone id. The server rebuilds the
 * call from its own catalog via this same function — never from client input — so
 * a "Queue" button can't be used to inject an arbitrary API request.
 */
export function recommendationToPending(rec: Recommendation, zoneId: string): QueuedRecommendation | null {
  const a = rec.action;
  if (a.tool === "set_zone_setting" && a.setting && a.value !== undefined) {
    return {
      product: "Zone settings",
      summary: `Set ${a.setting} = ${String(a.value)}`,
      method: "PATCH",
      path: `/zones/${zoneId}/settings/${a.setting}`,
      body: { value: a.value },
      zoneId,
    };
  }
  if (a.tool === "cf_write" && a.method && a.path && a.body !== undefined) {
    const path = a.path.replace(/\{zone\}/g, zoneId);
    // A descriptive/placeholder path (spaces, parentheses, or <…> tokens) is not
    // a real endpoint — never queue those; they belong in a chat-guided setup.
    if (/[<>()\s]/.test(path)) return null;
    return { product: rec.product, summary: rec.title, method: a.method, path, body: a.body, zoneId };
  }
  return null;
}

/** Whether a recommendation can be one-click queued (vs. handed to Glide in chat). */
export function isRecommendationQueueable(rec: Recommendation): boolean {
  return recommendationToPending(rec, "0".repeat(32)) !== null;
}

/**
 * Render a recommendation set as compact, readable text for the model to relay.
 * Groups by category, marks priority, cites docs, and includes the queue hint so
 * the model can turn each into a pending action via the existing builders.
 */
export function formatRecommendationsForModel(set: RecommendationSet): string {
  if (!set.recommendations.length) {
    return `No specific recommendations yet — the business profile is too sparse. Ask about: ${set.missing.join("; ")}.`;
  }
  const lines: string[] = [`Business profile: ${set.profileSummary}`, ""];
  const order: RecommendationPriority[] = ["high", "medium", "low"];
  for (const pri of order) {
    const items = set.recommendations.filter((r) => r.priority === pri);
    if (!items.length) continue;
    lines.push(`## ${pri.toUpperCase()} priority`);
    for (const r of items) {
      lines.push(`- [${r.category}] **${r.title}** (${r.product})`);
      lines.push(`  Why: ${r.rationale}`);
      if (r.because.length) lines.push(`  Because: ${r.because.join("; ")}`);
      lines.push(`  Queue via: ${r.action.tool}${r.action.reviewRequired ? " (review before Apply)" : ""} — ${r.action.hint}`);
      if (r.docs.length) lines.push(`  Docs: ${r.docs.join(" , ")}`);
    }
    lines.push("");
  }
  if (set.missing.length) {
    lines.push(`Still unknown (ask to refine): ${set.missing.join("; ")}.`);
  }
  lines.push(
    "Present the relevant items grouped by theme (security / performance / etc.), explain WHY each fits this business, and offer to QUEUE the high-priority ones. Items marked 'review before Apply' or 'manual' need confirmation or a plan/dashboard step — never claim anything is enabled until a human Applies it.",
  );
  return lines.join("\n");
}
