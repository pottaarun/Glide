import assert from "node:assert/strict";
import test from "node:test";

import { resolveMigrationExportTarget, zoneAfterAccountChange } from "../src/migration-target.ts";

const accountA = "a".repeat(32);
const accountB = "b".repeat(32);
const zone = { id: "c".repeat(32), name: "example.com", accountId: accountA };

test("migration targets use a selected zone's owner instead of an unrelated account default", () => {
  assert.deepEqual(resolveMigrationExportTarget(accountB, zone, {}, "zone"), {
    ok: true,
    target: { accountId: accountA, zoneId: zone.id, zoneName: zone.name },
  });
  assert.deepEqual(resolveMigrationExportTarget(accountA, zone, { accountId: accountB }, "zone"), {
    ok: true,
    target: { accountId: accountB },
  });
});

test("migration targets reject known conflicting explicit tuples", () => {
  assert.deepEqual(resolveMigrationExportTarget(accountA, zone, { accountId: accountB, zoneId: zone.id }, "zone"), {
    ok: false,
    message: "The requested account does not own the selected default zone.",
  });
  assert.equal(resolveMigrationExportTarget(accountA, zone, { zoneName: zone.name }, "zone").ok, false);
  assert.equal(resolveMigrationExportTarget(accountA, zone, { zoneId: zone.id, zoneName: "other.example" }, "zone").ok, false);
});

test("legacy zones never inherit an account with unknown provenance", () => {
  const legacyZone = { id: zone.id, name: zone.name };
  assert.deepEqual(resolveMigrationExportTarget(accountB, legacyZone, {}, "zone"), {
    ok: true,
    target: { zoneId: zone.id, zoneName: zone.name },
  });
  assert.equal(zoneAfterAccountChange(legacyZone, accountB), undefined);
  assert.equal(zoneAfterAccountChange(zone, accountB), undefined);
  assert.deepEqual(zoneAfterAccountChange(zone, accountA.toUpperCase()), zone);
  assert.equal(
    resolveMigrationExportTarget(accountB, legacyZone, { accountId: accountB, zoneId: zone.id }, "zone").ok,
    false,
  );
});

test("account-scoped migrations never inherit a zone", () => {
  assert.deepEqual(resolveMigrationExportTarget(accountB, zone, {}, "account"), {
    ok: true,
    target: { accountId: accountB },
  });
  assert.deepEqual(resolveMigrationExportTarget(undefined, zone, {}, "account"), {
    ok: true,
    target: { accountId: accountA },
  });
  assert.equal(resolveMigrationExportTarget(accountA, zone, { zoneId: zone.id }, "account").ok, false);
});

test("unknown explicit zone/account tuples require prior verification", () => {
  assert.equal(
    resolveMigrationExportTarget(accountA, zone, { zoneId: "d".repeat(32), accountId: accountA }, "zone").ok,
    false,
  );
});
