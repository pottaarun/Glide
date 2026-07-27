import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRecommendationsForModel,
  isRecommendationQueueable,
  missingDimensions,
  recommendConfigurations,
  recommendationToPending,
  type Recommendation,
} from "../src/recommendations.ts";
import { EMPTY_BUSINESS_PROFILE, type BusinessProfile } from "../src/shared.ts";

function profile(overrides: Partial<BusinessProfile>): BusinessProfile {
  return { ...EMPTY_BUSINESS_PROFILE, ...overrides };
}

function ids(p?: BusinessProfile, ctx?: Parameters<typeof recommendConfigurations>[1]): string[] {
  return recommendConfigurations(p, ctx).recommendations.map((r) => r.id);
}

function recById(id: string, p?: BusinessProfile, ctx?: Parameters<typeof recommendConfigurations>[1]): Recommendation {
  const rec = recommendConfigurations(p, ctx).recommendations.find((r) => r.id === id);
  if (!rec) throw new Error(`no recommendation with id ${id}`);
  return rec;
}

test("baseline recommendations apply to any internet-facing property", () => {
  const set = recommendConfigurations(undefined);
  const got = set.recommendations.map((r) => r.id);
  for (const id of ["ssl_full_strict", "always_use_https", "min_tls_12", "waf_managed_rules"]) {
    assert.ok(got.includes(id), `expected baseline recommendation ${id}`);
  }
  // With nothing captured, every discovery dimension is still open.
  assert.ok(set.missing.length >= 8);
});

test("e-commerce with payments triggers PCI TLS hardening and carding protections", () => {
  const got = ids(profile({ industry: "ecommerce", sensitiveData: ["payments"] }));
  for (const id of ["bot_management_checkout", "rate_limit_checkout", "tls_13", "hsts"]) {
    assert.ok(got.includes(id), `expected ${id} for a payments-handling store`);
  }
});

test("min TLS 1.2 is de-duplicated and upgraded to high priority under PCI", () => {
  const set = recommendConfigurations(profile({ compliance: ["pci_dss"] }));
  const minTls = set.recommendations.filter((r) => r.id === "min_tls_12");
  assert.equal(minTls.length, 1, "min_tls_12 must appear exactly once");
  assert.equal(minTls[0].priority, "high");
  // The merged reasons capture both the baseline and the PCI trigger.
  assert.ok(minTls[0].because.some((b) => /PCI/i.test(b)));
});

test("login flows add authentication-abuse protections", () => {
  const got = ids(profile({ hasLogin: true }));
  for (const id of ["rate_limit_login", "leaked_credentials", "turnstile_login"]) {
    assert.ok(got.includes(id), `expected ${id} when users log in`);
  }
});

test("exposing an API adds API Shield and API rate limiting", () => {
  const got = ids(profile({ hasApi: true }));
  for (const id of ["api_shield_schema", "api_rate_limit", "api_auth"]) {
    assert.ok(got.includes(id), `expected ${id} for an exposed API`);
  }
  // app type "api" should imply the same even without the boolean.
  assert.ok(ids(profile({ appTypes: ["api"] })).includes("api_shield_schema"));
});

test("a global audience adds edge caching and smart routing", () => {
  const got = ids(profile({ audience: "global" }));
  assert.ok(got.includes("tiered_cache"));
  assert.ok(got.includes("argo_smart_routing"));
});

test("HIPAA adds HSTS and Access for internal/admin surfaces", () => {
  const got = ids(profile({ compliance: ["hipaa"] }));
  assert.ok(got.includes("hsts"));
  assert.ok(got.includes("access_internal_apps"));
});

test("onboarding goals feed the engine even without a profile", () => {
  const got = ids(EMPTY_BUSINESS_PROFILE, { goals: ["load_balancing"] });
  assert.ok(got.includes("load_balancing"));
});

test("recommendations are sorted with high priority first", () => {
  const set = recommendConfigurations(profile({ industry: "fintech", sensitiveData: ["payments"], hasLogin: true }));
  const rank = { high: 0, medium: 1, low: 2 } as const;
  for (let i = 1; i < set.recommendations.length; i++) {
    assert.ok(
      rank[set.recommendations[i - 1].priority] <= rank[set.recommendations[i].priority],
      "recommendations must be ordered by descending priority",
    );
  }
  assert.equal(set.recommendations[0].priority, "high");
});

test("every recommendation carries a rationale, an action, and at least one doc", () => {
  const set = recommendConfigurations(profile({ industry: "ecommerce", hasApi: true, audience: "global" }));
  for (const r of set.recommendations) {
    assert.ok(r.rationale.trim().length > 0, `${r.id} needs a rationale`);
    assert.ok(r.action && r.action.hint.trim().length > 0, `${r.id} needs an action hint`);
    assert.ok(r.docs.length > 0, `${r.id} needs a docs citation`);
  }
});

test("formatRecommendationsForModel renders a profile summary, hints and docs", () => {
  const set = recommendConfigurations(profile({ industry: "ecommerce", sensitiveData: ["payments"] }));
  const text = formatRecommendationsForModel(set);
  assert.match(text, /Business profile:/);
  assert.match(text, /Queue via:/);
  assert.match(text, /Docs:/);
  assert.match(text, /HIGH priority/);
});

test("recommendationToPending builds a concrete zone-setting call", () => {
  const rec = recById("ssl_full_strict", EMPTY_BUSINESS_PROFILE);
  const q = recommendationToPending(rec, "zone123");
  assert.ok(q);
  assert.equal(q?.method, "PATCH");
  assert.equal(q?.path, "/zones/zone123/settings/ssl");
  assert.deepEqual(q?.body, { value: "strict" });
  assert.ok(isRecommendationQueueable(rec));
});

test("recommendationToPending substitutes {zone} in a concrete cf_write path", () => {
  const rec = recById("tiered_cache", profile({ audience: "global" }));
  const q = recommendationToPending(rec, "zone123");
  assert.ok(q);
  assert.equal(q?.method, "PATCH");
  assert.equal(q?.path, "/zones/zone123/argo/tiered_caching");
  assert.deepEqual(q?.body, { value: "on" });
});

test("HSTS is queueable via a concrete security_header body", () => {
  const rec = recById("hsts", profile({ compliance: ["pci_dss"] }));
  const q = recommendationToPending(rec, "zone123");
  assert.ok(q);
  assert.equal(q?.method, "PATCH");
  assert.equal(q?.path, "/zones/zone123/settings/security_header");
});

test("recommendations needing discovery or a plan are NOT one-click queueable", () => {
  // Managed WAF ruleset needs a ruleset id in the body → not concrete.
  const managed = recById("waf_managed_rules", EMPTY_BUSINESS_PROFILE);
  assert.equal(recommendationToPending(managed, "zone123"), null);
  assert.equal(isRecommendationQueueable(managed), false);
  // Rate-limit rules need a real endpoint + entrypoint → handed to chat.
  assert.equal(isRecommendationQueueable(recById("rate_limit_login", profile({ hasLogin: true }))), false);
  // Manual/plan-gated steps are never one-click.
  assert.equal(isRecommendationQueueable(recById("leaked_credentials", profile({ hasLogin: true }))), false);
});

test("missingDimensions shrinks as the profile fills in", () => {
  const empty = missingDimensions(EMPTY_BUSINESS_PROFILE);
  const partial = missingDimensions(
    profile({ industry: "saas", appTypes: ["web_app"], hasLogin: true, hasApi: false }),
  );
  assert.ok(partial.length < empty.length);
  assert.ok(!partial.some((m) => /industry/i.test(m)));
});
