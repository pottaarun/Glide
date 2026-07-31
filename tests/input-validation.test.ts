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
  validateFutureTimestamp,
  validateOnboardingPatch,
} from "../src/input-validation.ts";
import {
  isSupportedRoomId,
  isValidRoomStorageName,
  isValidRoomId,
  MAX_LEGACY_ROOM_ID_CHARS,
  MAX_ROOM_ID_CHARS,
  roomStorageName,
} from "../src/shared.ts";

test("room ids use bounded canonical ids and stable legacy storage names", () => {
  assert.equal(isValidRoomId("room_01-test"), true);
  assert.equal(isValidRoomId("a".repeat(MAX_ROOM_ID_CHARS)), true);
  assert.equal(isValidRoomId(""), false);
  assert.equal(isValidRoomId("room with spaces"), false);
  assert.equal(isValidRoomId("a".repeat(MAX_ROOM_ID_CHARS + 1)), false);
  assert.equal(isValidRoomId("room/slash"), false);
  assert.equal(isSupportedRoomId("legacy.room name"), true);
  assert.equal(isSupportedRoomId("a".repeat(MAX_LEGACY_ROOM_ID_CHARS)), true);
  assert.equal(isSupportedRoomId("a".repeat(MAX_LEGACY_ROOM_ID_CHARS + 1)), false);
  assert.equal(isSupportedRoomId("room\nname"), false);
  assert.equal(roomStorageName("legacy room"), "legacy%20room");
  assert.equal(roomStorageName("café"), "caf%C3%A9");
  assert.equal(roomStorageName("legacy%20room"), "legacy%20room");
  assert.equal(roomStorageName("room/slash"), "room");
  assert.equal(roomStorageName("../escape"), undefined);
  const encodedLegacyRoom = roomStorageName("é".repeat(34));
  assert.equal(encodedLegacyRoom?.length, 204);
  assert.equal(isValidRoomStorageName(encodedLegacyRoom), true);
  assert.equal(isSupportedRoomId("界".repeat(MAX_LEGACY_ROOM_ID_CHARS)), false);
});

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

test("future-timestamp validation enforces lead time and horizon", () => {
  const now = 1_000_000_000_000;
  const minLead = 60_000; // 1 min
  const maxAhead = 30 * 86_400_000; // 30 days
  const ok = validateFutureTimestamp(now + 5 * 60_000, now, minLead, maxAhead);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value, now + 5 * 60_000);
  // Fractional inputs are rounded to an integer ms epoch.
  const rounded = validateFutureTimestamp(now + 5 * 60_000 + 0.7, now, minLead, maxAhead);
  assert.equal(rounded.ok && rounded.value, now + 5 * 60_000 + 1);
  // Too soon (before the minimum lead), in the past, and non-finite are rejected.
  assert.equal(validateFutureTimestamp(now + 30_000, now, minLead, maxAhead).ok, false);
  assert.equal(validateFutureTimestamp(now - 1, now, minLead, maxAhead).ok, false);
  assert.equal(validateFutureTimestamp(Number.NaN, now, minLead, maxAhead).ok, false);
  assert.equal(validateFutureTimestamp("soon", now, minLead, maxAhead).ok, false);
  assert.equal(validateFutureTimestamp(Number.POSITIVE_INFINITY, now, minLead, maxAhead).ok, false);
  // Too far out (beyond the horizon) is rejected; exactly at the horizon is allowed.
  assert.equal(validateFutureTimestamp(now + maxAhead + 60_000, now, minLead, maxAhead).ok, false);
  assert.equal(validateFutureTimestamp(now + maxAhead, now, minLead, maxAhead).ok, true);
  // The label appears in messages so the UI can surface which field failed.
  const labeled = validateFutureTimestamp(now, now, minLead, maxAhead, "Apply time");
  assert.equal(labeled.ok, false);
  assert.match(labeled.ok ? "" : labeled.message, /Apply time/);
});
