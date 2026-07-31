import assert from "node:assert/strict";
import test from "node:test";

import { requiresSecondApproval } from "../src/change-risk.ts";

const ZONE = "a".repeat(32);

test("destructive DELETEs require a second approver", () => {
  const r = requiresSecondApproval({ method: "DELETE", path: `/zones/${ZONE}/dns_records/${"b".repeat(32)}` });
  assert.equal(r.required, true);
  assert.match(r.reason ?? "", /Deletes/);
});

test("ruleset writes (WAF/firewall rules) require a second approver", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      requiresSecondApproval({ method, path: `/zones/${ZONE}/rulesets/${"c".repeat(32)}` }).required,
      true,
      `${method} ruleset`,
    );
  }
  // Reading a ruleset is not gated.
  assert.equal(requiresSecondApproval({ method: "GET", path: `/zones/${ZONE}/rulesets` }).required, false);
});

test("a ruleset phase entrypoint replacement (mergeEntrypoint) requires a second approver", () => {
  const r = requiresSecondApproval({
    method: "PUT",
    path: `/zones/${ZONE}/rulesets/phases/http_request_firewall_custom/entrypoint`,
    mergeEntrypoint: { phase: "http_request_firewall_custom", newRules: [{ action: "block" }] },
  });
  assert.equal(r.required, true);
  assert.match(r.reason ?? "", /ruleset phase/);
});

test("connectivity-critical TLS settings require a second approver", () => {
  assert.equal(requiresSecondApproval({ method: "PATCH", path: `/zones/${ZONE}/settings/ssl` }).required, true);
  assert.equal(
    requiresSecondApproval({ method: "PATCH", path: `/zones/${ZONE}/settings/min_tls_version` }).required,
    true,
  );
  // Case/whitespace-insensitive on method and path.
  assert.equal(requiresSecondApproval({ method: "patch", path: `/zones/${ZONE}/settings/ssl ` }).required, true);
});

test("routine posture-improving settings are NOT gated", () => {
  for (const setting of ["always_use_https", "security_header", "automatic_https_rewrites", "brotli"]) {
    assert.equal(
      requiresSecondApproval({ method: "PATCH", path: `/zones/${ZONE}/settings/${setting}` }).required,
      false,
      setting,
    );
  }
});

test("creating resources (DNS records, zones) is not gated", () => {
  assert.equal(requiresSecondApproval({ method: "POST", path: `/zones/${ZONE}/dns_records` }).required, false);
  assert.equal(requiresSecondApproval({ method: "POST", path: "/zones" }).required, false);
});

test("malformed or non-write requests are not gated (they fail-closed at Apply anyway)", () => {
  assert.equal(requiresSecondApproval({ method: "GET", path: `/zones/${ZONE}/settings/ssl` }).required, false);
  assert.equal(requiresSecondApproval({ method: "DELETE", path: "//evil\\path" }).required, true); // DELETE still gated by method
  assert.equal(requiresSecondApproval({ method: "PATCH", path: "not-a-path" }).required, false);
});
