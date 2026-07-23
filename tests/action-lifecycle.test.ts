import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLY_ATTEMPT_STALE_MS,
  formatActionResultEvent,
  isActionApplying,
  markActionApplying,
  markActionFailed,
  pendingActionStatus,
  recoverStaleActionAttempts,
} from "../src/action-lifecycle.ts";

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
