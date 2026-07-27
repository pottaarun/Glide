import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_ATTEMPT_STALE_MS,
  actionResourceKey,
  formatActionResultEvent,
  isActionApplying,
  isActionOutcomeUncertain,
  markActionApplying,
  markActionFailed,
  pendingActionStatus,
  recoverStaleActionAttempts,
  rulesetEntrypointIdentity,
  selectBulkApplyIds,
  zoneCreationIdentity,
} from "../src/action-lifecycle.ts";

test("only failed actions with an explicit uncertain outcome require individual verification", () => {
  assert.equal(
    isActionOutcomeUncertain({
      id: "uncertain",
      status: "failed",
      error: "Outcome uncertain: verify the live configuration before retrying.",
    }),
    true,
  );
  assert.equal(
    isActionOutcomeUncertain({ id: "ordinary-failure", status: "failed", error: "Permission denied" }),
    false,
  );
  assert.equal(
    isActionOutcomeUncertain({ id: "pending", status: "pending", error: "Outcome uncertain: stale text" }),
    false,
  );
  assert.equal(
    isActionOutcomeUncertain(
      { id: "stale", status: "applying", attemptedAt: 100 },
      100 + APPLY_ATTEMPT_STALE_MS,
    ),
    true,
  );
});

test("bulk apply uses only the reviewed snapshot and excludes stale attempts", () => {
  const now = 1_000 + APPLY_ATTEMPT_STALE_MS;
  const actions = [
    { id: "reviewed", status: "pending" as const },
    { id: "new-after-review", status: "pending" as const },
    { id: "stale", status: "applying" as const, attemptedAt: 1_000 },
    { id: "uncertain", status: "failed" as const, error: "Outcome uncertain: timeout" },
  ];

  assert.deepEqual(
    selectBulkApplyIds(actions, ["reviewed", "stale", "uncertain"], now),
    ["reviewed"],
  );
});

test("resource locks cover method changes and semantic zone creation", () => {
  assert.equal(
    actionResourceKey({ method: "PATCH", path: "/zones/z1/settings/ssl" }),
    actionResourceKey({ method: "DELETE", path: "/zones/z1/settings/ssl?force=true" }),
  );
  const zone = { method: "POST", path: "/zones", body: { name: "Example.COM.", account: { id: "a1" } } };
  assert.equal(zoneCreationIdentity(zone), "a1:example.com");
  assert.equal(actionResourceKey(zone), "zone-create:a1:example.com");

  const rulesetPath = "/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint";
  assert.deepEqual(rulesetEntrypointIdentity(rulesetPath), {
    zoneId: "z1",
    phase: "http_request_firewall_custom",
  });
  assert.equal(
    actionResourceKey({
      method: "PUT",
      path: rulesetPath,
      zoneId: "z1",
      mergeEntrypoint: { phase: "http_request_firewall_custom" },
    }),
    actionResourceKey({ method: "DELETE", path: rulesetPath }),
  );
  assert.equal(
    actionResourceKey({ method: "POST", path: "/zones/z1/rulesets/ruleset-1/rules" }),
    actionResourceKey({ method: "PUT", path: rulesetPath }),
  );
  assert.notEqual(
    actionResourceKey({ method: "POST", path: "/zones/z2/rulesets/ruleset-1/rules" }),
    actionResourceKey({ method: "PUT", path: rulesetPath }),
  );
});

test("legacy actions default to pending and failed attempts stay retryable", () => {
  const legacy = { id: "a1", summary: "Add zone" };
  assert.equal(pendingActionStatus(legacy), "pending");

  const applying = markActionApplying([legacy], "a1", 100);
  assert.equal(applying[0].status, "applying");
  assert.equal(isActionApplying(applying[0], 101), true);

  const failed = markActionFailed(applying, "a1", "Missing token", 102);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, "failed");
  assert.equal(failed[0].error, "Missing token");
  assert.equal(pendingActionStatus(legacy), "pending");
});

test("interrupted applying actions recover to a retryable failure", () => {
  const startedAt = 1_000;
  const actions = [{ id: "a1", status: "applying" as const, attemptedAt: startedAt }];
  const recovered = recoverStaleActionAttempts(actions, startedAt + APPLY_ATTEMPT_STALE_MS);

  assert.equal(recovered[0].status, "failed");
  assert.match(recovered[0].error ?? "", /interrupted/i);
});

test("action result events tell the agent not to duplicate failed writes", () => {
  const event = formatActionResultEvent([
    {
      id: "a1",
      summary: "Add domain example.com",
      status: "failed",
      detail: "No API token",
      by: "Avery",
      ts: 123,
    },
  ]);

  assert.match(event, /remains in Pending approvals for retry/);
  assert.match(event, /Never re-queue/);
  assert.match(event, /live-state check before Retry/);
});
