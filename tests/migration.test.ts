import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONFIG_BYTES,
  MAX_CONFIG_FILENAME_BYTES,
  MAX_MIGRATION_ARTIFACT_NODES,
  MAX_MIGRATION_SOURCE_BYTES,
  MAX_MIGRATION_RESPONSE_BYTES,
  MAX_MIGRATION_OUTPUT_BYTES,
  MAX_MIGRATION_PREVIEW_RULES,
  boundedMigrationPreviewRules,
  buildConfigData,
  captureZoneSnapshot,
  configFilesSizeError,
  diffReport,
  exportMigrationCsv,
  generateMigrationTerraform,
  getZoneSnapshot,
  listMigrationProviders,
  listZoneSnapshots,
  migrationFilesValidationError,
  migrationPreviewValidationError,
  migrationSnapshotDataValidationError,
  MIGRATION_SNAPSHOT_DISABLED,
  MIGRATION_VALIDATION_DISABLED,
  normalizeMigrationBase,
  preflightPermissions,
  resolveSnapshotTarget,
  restoreZoneSnapshot,
  serializeMigrationSource,
  sha256Hex,
  SUPPORTED_MIGRATION_SNAPSHOT_VERSION,
  validMigrationSnapshotId,
  validateMigrationArtifact,
  validateConfig,
} from "../src/migration.ts";

const SNAPSHOT_ACCOUNT_ID = "a".repeat(32);
const SNAPSHOT_ZONE_ID = "b".repeat(32);

function snapshotData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshot_version: SUPPORTED_MIGRATION_SNAPSHOT_VERSION,
    zone_id: SNAPSHOT_ZONE_ID,
    zone_name: "example.com",
    account_id: SNAPSHOT_ACCOUNT_ID,
    timestamp: "2026-07-28T12:00:00.000Z",
    ip_lists: [],
    lb_pools: [],
    load_balancers: [],
    rulesets: [],
    settings: {},
    ...overrides,
  };
}

test("config limits use UTF-8 bytes before parsing", () => {
  const exact = buildConfigData("a".repeat(MAX_CONFIG_BYTES), "xml");
  assert.equal(exact.ok, true);

  const oversized = buildConfigData("é".repeat(MAX_CONFIG_BYTES / 2 + 1), "xml");
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.message, /too large/i);
});

test("uploaded config bounds include UTF-8 filenames", () => {
  assert.match(
    configFilesSizeError([{ filename: "é".repeat(MAX_CONFIG_FILENAME_BYTES / 2 + 1), content: "" }]) ?? "",
    /filename is too long/i,
  );
  assert.match(
    configFilesSizeError([{ filename: "main.tf", content: "a".repeat(MAX_CONFIG_BYTES) }]) ?? "",
    /configs are too large/i,
  );
  assert.equal(configFilesSizeError([{ filename: "main.tf", content: "resource {}" }]), undefined);
});

test("migration service URLs require public HTTPS while permitting loopback development", () => {
  assert.equal(normalizeMigrationBase("https://migration.example/api/"), "https://migration.example/api");
  assert.equal(normalizeMigrationBase("http://localhost:8788/"), "http://localhost:8788");
  assert.equal(normalizeMigrationBase("http://migration.example"), undefined);
  assert.equal(normalizeMigrationBase("https://user:pass@migration.example"), undefined);
  assert.equal(normalizeMigrationBase("https://migration.example?target=other"), undefined);
});

test("migration service calls reject redirects and oversized responses", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } });
    }) as typeof fetch;
    const redirected = await listMigrationProviders({ baseUrl: "https://migration.example" });
    assert.equal(redirected.ok, false);
    if (!redirected.ok) assert.match(redirected.message, /redirect/i);

    globalThis.fetch = (async () =>
      new Response("{}", {
        headers: { "content-length": String(MAX_MIGRATION_RESPONSE_BYTES + 1) },
      })) as typeof fetch;
    const oversized = await listMigrationProviders({ baseUrl: "https://migration.example" });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) assert.match(oversized.message, /response exceeded|oversized/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("migration service errors never reflect downstream bodies and successful DTOs are schema checked", async () => {
  const realFetch = globalThis.fetch;
  const token = `cfat_${"a".repeat(40)}`;
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: `rejected ${token}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const failed = await listMigrationProviders({ baseUrl: "https://migration.example" });
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.message, "Migration tool returned HTTP 500");
      assert.equal(failed.message.includes(token), false);
    }

    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    const malformed = await listMigrationProviders({ baseUrl: "https://migration.example" });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.match(malformed.message, /provider response is malformed/i);

    globalThis.fetch = (async () =>
      Response.json({
        providers: [
          {
            key: "akamai",
            label: "Akamai",
            category: "CDN",
            description: "",
            phases: [{ key: "waf", label: "WAF" }],
          },
        ],
      })) as typeof fetch;
    const valid = await listMigrationProviders({ baseUrl: "https://migration.example" });
    assert.equal(valid.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("migration connection errors do not expose a configured URL path", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const result = await listMigrationProviders({ baseUrl: "https://migration.example/secret-path" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.doesNotMatch(result.message, /secret-path|migration\.example/);
      assert.match(result.message, /configured HTTPS endpoint/i);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("migration artifacts reject unsafe object graphs", () => {
  assert.equal(validateMigrationArtifact({ rules: [{ action: "block" }] }).ok, true);
  assert.equal(validateMigrationArtifact(JSON.parse('{"__proto__":{"polluted":true}}')).ok, false);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(validateMigrationArtifact(circular).ok, false);

  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 90; i++) {
    const next: Record<string, unknown> = {};
    deep.next = next;
    deep = next;
  }
  assert.equal(validateMigrationArtifact(root).ok, false);
  assert.equal(validateMigrationArtifact(new Array(MAX_MIGRATION_ARTIFACT_NODES + 1).fill(null)).ok, false);
});

test("migration previews fail closed when mappings are malformed or truncated", () => {
  const valid = {
    provider: "akamai",
    providerLabel: "Akamai",
    totalRules: 1,
    phases: [{ key: "waf", label: "WAF", count: 1 }],
    rules: [{ name: "Block bots", type: "waf_custom", phase: "waf", phaseLabel: "WAF", action: "block" }],
  };
  assert.equal(migrationPreviewValidationError(valid, "akamai", 300), undefined);
  assert.match(migrationPreviewValidationError({ ...valid, provider: "fastly" }, "akamai", 300) ?? "", /provider/i);
  assert.match(migrationPreviewValidationError({ ...valid, totalRules: 2 }, "akamai", 300) ?? "", /incomplete|count/i);
  assert.match(migrationPreviewValidationError(valid, "akamai", 0) ?? "", /safely queue/i);
  assert.match(
    migrationPreviewValidationError({ ...valid, rules: [{ ...valid.rules[0], expression: "x".repeat(16_001) }] }, "akamai", 300) ?? "",
    /expression/i,
  );
  assert.match(
    migrationPreviewValidationError(
      {
        ...valid,
        phases: [{ key: "cache", label: "Cache", count: 1 }],
      },
      "akamai",
      300,
    ) ?? "",
    /phases/i,
  );
  assert.match(
    migrationPreviewValidationError(
      {
        ...valid,
        phases: [
          { key: "waf", label: "WAF", count: 0 },
          { key: "waf", label: "WAF", count: 1 },
        ],
      },
      "akamai",
      300,
    ) ?? "",
    /duplicate/i,
  );
});

test("large valid previews retain a bounded subset without losing the authoritative total", () => {
  const rule = { name: "Block bots", type: "waf_custom", phase: "waf", phaseLabel: "WAF", action: "block" };
  const rules = Array.from({ length: 301 }, (_, index) => ({ ...rule, name: `Rule ${index + 1}` }));
  const preview = {
    provider: "akamai",
    providerLabel: "Akamai",
    totalRules: rules.length,
    phases: [{ key: "waf", label: "WAF", count: rules.length }],
    rules,
  };

  assert.equal(migrationPreviewValidationError(preview, "akamai", MAX_MIGRATION_PREVIEW_RULES), undefined);
  const bounded = boundedMigrationPreviewRules(preview.rules, 300);
  assert.equal(bounded.rules.length, 300);
  assert.equal(bounded.truncated, true);
  assert.equal(preview.totalRules, 301);
});

test("generated migration files are bounded and use safe leaf filenames", () => {
  assert.equal(migrationFilesValidationError([{ filename: "main.tf", content: "resource {}" }]), undefined);
  assert.match(migrationFilesValidationError([{ filename: "../main.tf", content: "" }]) ?? "", /unsafe/i);
  assert.match(
    migrationFilesValidationError([{ filename: "main.tf", content: "x".repeat(MAX_MIGRATION_OUTPUT_BYTES + 1) }]) ?? "",
    /too large/i,
  );
  assert.match(
    migrationFilesValidationError([
      { filename: "MAIN.tf", content: "one" },
      { filename: "main.tf", content: "two" },
    ]) ?? "",
    /duplicate/i,
  );
});

test("v2 snapshot data is complete and bound to its stored target", async () => {
  const expected = {
    accountId: SNAPSHOT_ACCOUNT_ID,
    zoneId: SNAPSHOT_ZONE_ID,
    zoneName: "example.com",
    version: SUPPORTED_MIGRATION_SNAPSHOT_VERSION,
  };
  assert.equal(migrationSnapshotDataValidationError(snapshotData(), expected), undefined);
  assert.match(migrationSnapshotDataValidationError({}, expected) ?? "", /metadata/i);
  assert.match(
    migrationSnapshotDataValidationError(snapshotData({ zone_id: "c".repeat(32) }), expected) ?? "",
    /target/i,
  );
  assert.match(
    migrationSnapshotDataValidationError(snapshotData({ rulesets: [{ phase: "waf", id: "id", rules: [{}] }] }), expected) ?? "",
    /ruleset/i,
  );
  assert.match(
    migrationSnapshotDataValidationError(snapshotData(), { ...expected, version: 3 }) ?? "",
    /unsupported/i,
  );
  assert.equal(await sha256Hex("snapshot"), "16a0eeb0791b6c92451fd284dd9f599e0a7dbe7f6ebea6e2d2d06c7f74aec112");
});

test("snapshot restore targets come only from the recorded account and zone", () => {
  const zoneId = "a".repeat(32);
  assert.deepEqual(resolveSnapshotTarget({ account_id: "acct", zone_id: zoneId }, "acct"), {
    ok: true,
    accountId: "acct",
    zoneId,
  });
  assert.equal(resolveSnapshotTarget({ account_id: "other", zone_id: zoneId }, "acct").ok, false);
  assert.equal(resolveSnapshotTarget({ account_id: "acct", zone_id: "../zone" }, "acct").ok, false);
});

test("serialized migration sources stay below the Workers SQLite row limit", () => {
  assert.equal(serializeMigrationSource({ config: "small" }).ok, true);
  assert.equal(serializeMigrationSource({ __raw_tf: "\\".repeat(MAX_CONFIG_BYTES) }).ok, true);
  const oversized = serializeMigrationSource({ config: "\"".repeat(MAX_MIGRATION_SOURCE_BYTES / 2) });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.message, /too large/i);
});

test("snapshot ids are URL-segment safe", () => {
  assert.equal(validMigrationSnapshotId("snapshot_01J2Y5Y5Q3TQJ8N0M5D4R2K1AB"), true);
  assert.equal(validMigrationSnapshotId("snapshot/../../other"), false);
  assert.equal(validMigrationSnapshotId("snapshot with spaces"), false);
});

test("snapshot mutations are disabled before any migration-service request", async () => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  const input = { apiToken: "secret", accountId: "a".repeat(32), zoneId: "b".repeat(32) };
  try {
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("snapshot request escaped the fail-closed boundary");
    }) as typeof fetch;
    const captured = await captureZoneSnapshot({ baseUrl: "https://migration.example" }, input);
    const restored = await restoreZoneSnapshot(
      { baseUrl: "https://migration.example" },
      { ...input, snapshotData: snapshotData(), idempotencyKey: "action_01" },
    );
    const listed = await listZoneSnapshots({ baseUrl: "https://migration.example" }, input.zoneId);
    const fetched = await getZoneSnapshot({ baseUrl: "https://migration.example" }, "snapshot_01J2Y5Y5Q3TQJ8N0M5D4R2K1AB");
    assert.deepEqual(captured, { ok: false, message: MIGRATION_SNAPSHOT_DISABLED });
    assert.deepEqual(restored, { ok: false, message: MIGRATION_SNAPSHOT_DISABLED });
    assert.deepEqual(listed, { ok: false, message: MIGRATION_SNAPSHOT_DISABLED });
    assert.deepEqual(fetched, { ok: false, message: MIGRATION_SNAPSHOT_DISABLED });
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Terraform generation accepts the expected label and rejects a mismatched provider", async () => {
  const realFetch = globalThis.fetch;
  const input = { provider: "akamai", configData: { rules: [] } };
  try {
    globalThis.fetch = (async () => Response.json({ provider: "akamai", files: [] })) as typeof fetch;
    assert.equal((await generateMigrationTerraform({ baseUrl: "https://migration.example" }, input)).ok, true);

    globalThis.fetch = (async () => Response.json({ files: [] })) as typeof fetch;
    assert.equal((await generateMigrationTerraform({ baseUrl: "https://migration.example" }, input)).ok, true);

    globalThis.fetch = (async () => Response.json({ provider: "Akamai", files: [] })) as typeof fetch;
    assert.equal((await generateMigrationTerraform(
      { baseUrl: "https://migration.example" },
      { ...input, providerLabel: "Akamai" },
    )).ok, true);

    globalThis.fetch = (async () => Response.json({ provider: "fastly", files: [] })) as typeof fetch;
    const mismatched = await generateMigrationTerraform({ baseUrl: "https://migration.example" }, input);
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.match(mismatched.message, /provider does not match/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("CSV export accepts a registry-backed display label without sending it as config", async () => {
  const realFetch = globalThis.fetch;
  const input = { provider: "akamai", providerLabel: "Akamai", configData: { rules: [] } };
  try {
    globalThis.fetch = (async (_request, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.providerLabel, undefined);
      return Response.json({ provider: "Akamai", files: [] });
    }) as typeof fetch;
    assert.equal((await exportMigrationCsv({ baseUrl: "https://migration.example" }, input)).ok, true);

    globalThis.fetch = (async () => Response.json({ provider: "Fastly", files: [] })) as typeof fetch;
    const mismatched = await exportMigrationCsv({ baseUrl: "https://migration.example" }, input);
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.match(mismatched.message, /provider does not match/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("migration preflight and diff checks reject contradictory counts and flags", async () => {
  const realFetch = globalThis.fetch;
  const transport = { baseUrl: "https://migration.example" };
  const accountId = "a".repeat(32);
  const zoneId = "b".repeat(32);
  try {
    const preflight = {
      skipped: false,
      tokenValid: true,
      tokenDetail: "active",
      checks: [{ name: "Zone", description: "Zone read", status: "passed", detail: "ok" }],
      missing: [],
      passed: ["Zone read"],
      allPassed: true,
    };
    globalThis.fetch = (async () => Response.json(preflight)) as typeof fetch;
    assert.equal((await preflightPermissions(transport, { provider: "akamai", accountId, zoneId, apiToken: "secret" })).ok, true);
    globalThis.fetch = (async () => Response.json({ ...preflight, tokenValid: false })) as typeof fetch;
    assert.equal((await preflightPermissions(transport, { provider: "akamai", accountId, zoneId, apiToken: "secret" })).ok, false);

    const diff = {
      provider: "akamai",
      zoneId,
      accountId,
      phases: { waf: { label: "WAF", existingTotal: 2, existingMigration: 1, existingManual: 1 } },
      ipLists: { total: 0, names: [] },
      loadBalancers: { pools: 0, poolNames: [], lbs: 0, lbNames: [] },
      timestamp: "2026-07-28T12:00:00.000Z",
    };
    globalThis.fetch = (async () => Response.json(diff)) as typeof fetch;
    assert.equal((await diffReport(transport, { provider: "akamai", accountId, zoneId, apiToken: "secret" })).ok, true);
    globalThis.fetch = (async () => Response.json({
      ...diff,
      phases: { waf: { label: "WAF", existingTotal: 3, existingMigration: 1, existingManual: 1 } },
    })) as typeof fetch;
    assert.equal((await diffReport(transport, { provider: "akamai", accountId, zoneId, apiToken: "secret" })).ok, false);

  } finally {
    globalThis.fetch = realFetch;
  }
});

test("post-migration validation is disabled before any migration-service request", async () => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("validation request escaped the fail-closed boundary");
    }) as typeof fetch;
    const result = await validateConfig(
      { baseUrl: "https://migration.example" },
      {
        provider: "akamai",
        configData: {},
        accountId: "a".repeat(32),
        zoneId: "b".repeat(32),
        apiToken: "secret",
      },
    );
    assert.deepEqual(result, { ok: false, message: MIGRATION_VALIDATION_DISABLED });
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
