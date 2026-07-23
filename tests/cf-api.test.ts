import assert from "node:assert/strict";
import test from "node:test";

import { verifyToken } from "../src/cf-api.ts";

type Handler = (url: string) => { status: number; body: unknown };

/** Swap in a fake global fetch that routes by URL, then restore it. */
async function withFetch(handler: Handler, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (result: unknown) => ({
  status: 200,
  body: { success: true, result, result_info: { total_pages: 1 } },
});
const authFail = () => ({
  status: 401,
  body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] },
});
const permFail = () => ({
  status: 403,
  body: { success: false, errors: [{ code: 9109, message: "Unauthorized" }] },
});

test("verifyToken trusts an active /user/tokens/verify without extra reads", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/user/tokens/verify")) return ok({ status: "active" });
      throw new Error(`unexpected call to ${url}`);
    },
    async () => {
      const res = await verifyToken("tok");
      assert.equal(res.valid, true);
    },
  );
});

test("verifyToken falls back to account access when verify endpoint 401s", async () => {
  // Account-scoped tokens 401 on /user/tokens/verify even though they work.
  await withFetch(
    (url) => {
      if (url.includes("/user/tokens/verify")) return authFail();
      if (url.includes("/accounts")) return ok([{ id: "a1", name: "Acct" }]);
      throw new Error(`unexpected call to ${url}`);
    },
    async () => {
      const res = await verifyToken("tok");
      assert.equal(res.valid, true);
      assert.match(res.message, /account access/);
    },
  );
});

test("verifyToken falls back to zone access when accounts are forbidden", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/user/tokens/verify")) return authFail();
      if (url.includes("/accounts")) return permFail();
      if (url.includes("/zones")) return ok([{ id: "z1", name: "example.com", status: "active" }]);
      throw new Error(`unexpected call to ${url}`);
    },
    async () => {
      const res = await verifyToken("tok");
      assert.equal(res.valid, true);
      assert.match(res.message, /zone access/);
    },
  );
});

test("verifyToken reports invalid only when the token can touch nothing", async () => {
  await withFetch(
    (url) => {
      if (url.includes("/user/tokens/verify")) return authFail();
      if (url.includes("/accounts")) return authFail();
      if (url.includes("/zones")) return authFail();
      throw new Error(`unexpected call to ${url}`);
    },
    async () => {
      const res = await verifyToken("tok");
      assert.equal(res.valid, false);
    },
  );
});
