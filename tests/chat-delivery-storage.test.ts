import assert from "node:assert/strict";
import test from "node:test";

import {
  readPendingDelivery,
  readRecoverableDrafts,
  type DeliveryStorage,
  type PendingDelivery,
} from "../src/chat-delivery-storage.ts";

class MemoryStorage implements DeliveryStorage {
  readonly values = new Map<string, string>();
  failMutations = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failMutations) throw new Error("storage unavailable");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failMutations) throw new Error("storage unavailable");
    this.values.delete(key);
  }
}

const safe: PendingDelivery = { id: "safe-id", text: "Review DNS records" };
const unsafe: PendingDelivery = {
  id: "unsafe-id",
  text: `use cfat_${"a".repeat(40)}`,
};

test("evicts an unsafe pending delivery instead of restoring it", () => {
  const storage = new MemoryStorage();
  storage.values.set("pending", JSON.stringify(unsafe));

  assert.equal(readPendingDelivery(storage, "pending"), undefined);
  assert.equal(storage.getItem("pending"), null);
});

test("removes unsafe recoverable deliveries while preserving safe order", () => {
  const storage = new MemoryStorage();
  const second = { id: "second-safe", text: "Set SSL to strict" };
  storage.values.set("recoverable", JSON.stringify([safe, unsafe, second]));

  assert.deepEqual(readRecoverableDrafts(storage, "recoverable"), [safe, second]);
  assert.deepEqual(JSON.parse(storage.getItem("recoverable") ?? "[]"), [safe, second]);
});

test("removes recoverable storage when every delivery is unsafe", () => {
  const storage = new MemoryStorage();
  storage.values.set("recoverable", JSON.stringify([unsafe]));

  assert.deepEqual(readRecoverableDrafts(storage, "recoverable"), []);
  assert.equal(storage.getItem("recoverable"), null);
});

test("excludes unsafe recovery text even when storage cleanup fails", () => {
  const storage = new MemoryStorage();
  storage.values.set("pending", JSON.stringify(unsafe));
  storage.values.set("recoverable", JSON.stringify([unsafe, safe]));
  storage.failMutations = true;

  assert.equal(readPendingDelivery(storage, "pending"), undefined);
  assert.deepEqual(readRecoverableDrafts(storage, "recoverable"), [safe]);
  assert.match(storage.getItem("pending") ?? "", /cfat_/);
});

test("leaves safe delivery records unchanged", () => {
  const storage = new MemoryStorage();
  const serialized = JSON.stringify([safe]);
  storage.values.set("pending", JSON.stringify(safe));
  storage.values.set("recoverable", serialized);

  assert.deepEqual(readPendingDelivery(storage, "pending"), safe);
  assert.deepEqual(readRecoverableDrafts(storage, "recoverable"), [safe]);
  assert.equal(storage.getItem("recoverable"), serialized);
});
