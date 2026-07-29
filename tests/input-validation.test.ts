import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ACTOR_CHARS,
  MAX_PROFILE_NOTES_CHARS,
  MAX_SYNCED_STATE_BYTES,
  isSafeSyncedStateTransition,
  normalizeActor,
  syncedStateSizeError,
  validateBusinessProfilePatch,
  validateOnboardingPatch,
} from "../src/input-validation.ts";

test("synced state budgets serialized bytes including JSON escaping", () => {
  assert.equal(syncedStateSizeError({ value: "small" }, 100), undefined);
  assert.match(syncedStateSizeError({ value: '"'.repeat(20) }, 30) ?? "", /storage budget/i);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.match(syncedStateSizeError(circular, 100) ?? "", /not JSON-serializable/i);
});

test("legacy oversized state can only transition toward the current budget", () => {
  const current = { artifact: "x".repeat(MAX_SYNCED_STATE_BYTES) };
  const smaller = { artifact: "x".repeat(MAX_SYNCED_STATE_BYTES - 100) };
  const larger = { artifact: "x".repeat(MAX_SYNCED_STATE_BYTES + 100) };
  assert.equal(isSafeSyncedStateTransition(current, smaller), true);
  assert.equal(isSafeSyncedStateTransition(current, larger), false);
  assert.equal(isSafeSyncedStateTransition(current, { artifact: "small" }), true);
});

test("actor names are normalized and bounded before persistence", () => {
  const actor = normalizeActor(`  Avery\n${"x".repeat(200)}  `);
  assert.equal(actor.includes("\n"), false);
  assert.equal(actor.length, MAX_ACTOR_CHARS);
  assert.equal(normalizeActor(null, "teammate"), "teammate");
});

test("onboarding RPC patches reject unknown, oversized, and malformed fields", () => {
  assert.equal(validateOnboardingPatch({ path: "fresh", goals: ["dns"], completed: false }).ok, true);
  assert.equal(validateOnboardingPatch({ path: "invalid" }).ok, false);
  assert.equal(validateOnboardingPatch({ goals: "dns" }).ok, false);
  assert.equal(validateOnboardingPatch({ checkOff: ["not-a-real-step"] }).ok, false);
  assert.equal(validateOnboardingPatch({ admin: true }).ok, false);
});

test("business profile RPC patches enforce canonical values and text limits", () => {
  assert.equal(
    validateBusinessProfilePatch({ industry: "saas", appTypes: ["api"], hasLogin: false }).ok,
    true,
  );
  assert.equal(validateBusinessProfilePatch({ audience: "everyone" }).ok, false);
  assert.equal(validateBusinessProfilePatch({ appTypes: ["shell"] }).ok, false);
  assert.equal(validateBusinessProfilePatch({ notes: "x".repeat(MAX_PROFILE_NOTES_CHARS + 1) }).ok, false);
  assert.equal(validateBusinessProfilePatch({ updatedBy: "browser" }).ok, false);
});
