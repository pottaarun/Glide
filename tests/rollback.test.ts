import assert from "node:assert/strict";
import test from "node:test";

import { buildRollbackPlan, describeValue, invertibleSetting } from "../src/rollback.ts";

const ZID = "abcdef0123456789abcdef0123456789";

test("a zone-setting PATCH with a value body is invertible", () => {
  const inv = invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: { value: "strict" } });
  assert.deepEqual(inv, { zoneId: ZID, setting: "ssl", path: `/zones/${ZID}/settings/ssl` });
});

test("invertibility is case-insensitive on the zone id and setting", () => {
  const inv = invertibleSetting({
    method: "patch",
    path: `/zones/${ZID.toUpperCase()}/settings/MIN_TLS_VERSION`,
    body: { value: "1.2" },
  });
  assert.equal(inv?.zoneId, ZID);
  assert.equal(inv?.setting, "min_tls_version");
});

test("a settings PATCH with a query string still matches on the pathname", () => {
  const inv = invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/settings/tls_1_3?x=1`, body: { value: "on" } });
  assert.equal(inv?.setting, "tls_1_3");
  assert.equal(inv?.path, `/zones/${ZID}/settings/tls_1_3`);
});

test("non-PATCH methods are never invertible", () => {
  for (const method of ["POST", "PUT", "DELETE", "GET"]) {
    assert.equal(
      invertibleSetting({ method, path: `/zones/${ZID}/settings/ssl`, body: { value: "strict" } }),
      null,
      `${method} should not be invertible`,
    );
  }
});

test("non-settings paths (dnssec, rulesets, dns_records) are not invertible", () => {
  assert.equal(invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/dnssec`, body: { status: "active" } }), null);
  assert.equal(
    invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/rulesets/phases/http_request_firewall_managed/entrypoint`, body: { rules: [] } }),
    null,
  );
  assert.equal(invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/dns_records/x`, body: { value: 1 } }), null);
});

test("a settings PATCH without a value key is not invertible", () => {
  assert.equal(invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: { other: "x" } }), null);
  assert.equal(invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: undefined }), null);
  assert.equal(invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: [1, 2] }), null);
});

test("mergeEntrypoint and legacy restore actions are excluded", () => {
  assert.equal(
    invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: { value: "strict" }, mergeEntrypoint: { phase: "x", newRules: [] } }),
    null,
  );
  assert.equal(
    invertibleSetting({ method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: { value: "strict" }, actionType: "snapshot_restore" }),
    null,
  );
});

test("malformed paths are rejected", () => {
  assert.equal(invertibleSetting({ method: "PATCH", path: "zones/x/settings/ssl", body: { value: "x" } }), null);
  assert.equal(invertibleSetting({ method: "PATCH", path: 42, body: { value: "x" } }), null);
});

test("buildRollbackPlan builds the inverse PATCH with the captured prior value", () => {
  const action = { method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: { value: "strict" } };
  const plan = buildRollbackPlan(action, "full");
  assert.deepEqual(plan, {
    method: "PATCH",
    path: `/zones/${ZID}/settings/ssl`,
    body: { value: "full" },
    summary: "Revert ssl to full",
  });
});

test("buildRollbackPlan preserves object prior values verbatim (e.g. HSTS)", () => {
  const priorHsts = { strict_transport_security: { enabled: false } };
  const action = { method: "PATCH", path: `/zones/${ZID}/settings/security_header`, body: { value: { strict_transport_security: { enabled: true } } } };
  const plan = buildRollbackPlan(action, priorHsts);
  assert.deepEqual(plan?.body, { value: priorHsts });
  assert.match(plan?.summary ?? "", /^Revert security_header to /);
});

test("buildRollbackPlan returns null for a missing prior value or non-invertible action", () => {
  assert.equal(buildRollbackPlan({ method: "PATCH", path: `/zones/${ZID}/settings/ssl`, body: { value: "strict" } }, undefined), null);
  assert.equal(buildRollbackPlan({ method: "POST", path: `/zones/${ZID}/settings/ssl`, body: { value: "strict" } }, "full"), null);
});

test("describeValue renders scalars and shortens large/complex values", () => {
  assert.equal(describeValue("off"), "off");
  assert.equal(describeValue(1.2), "1.2");
  assert.equal(describeValue(true), "true");
  assert.equal(describeValue(null), "null");
  assert.equal(describeValue({ a: 1 }), '{"a":1}');
  const big = { strict_transport_security: { enabled: true, max_age: 31536000, include_subdomains: true, nosniff: true } };
  assert.equal(describeValue(big), "its previous setting");
  assert.equal(describeValue("x".repeat(80)).endsWith("…"), true);
});
