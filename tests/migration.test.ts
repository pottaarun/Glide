import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONFIG_BYTES,
  MAX_CONFIG_FILENAME_BYTES,
  buildConfigData,
  configFilesSizeError,
  fetchConfigFromUrl,
  resolveSnapshotTarget,
} from "../src/migration.ts";

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

test("URL config reads stop once the streamed body exceeds the limit", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("a".repeat(MAX_CONFIG_BYTES + 1))) as typeof fetch;
  try {
    const result = await fetchConfigFromUrl("https://configs.example/export");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /too large/i);
  } finally {
    globalThis.fetch = realFetch;
  }
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
