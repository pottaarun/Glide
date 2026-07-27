import assert from "node:assert/strict";
import test from "node:test";

import {
  cfRequest,
  findZoneByName,
  permissionHint,
  resolveTargetAccountId,
  verifyToken,
} from "../src/cf-api.ts";

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

test("zone creation failures explain the zone-scoped token policy", async () => {
  assert.match(permissionHint("/zones", "POST") ?? "", /All zones\/domains/);
  assert.match(permissionHint("/zones", "POST") ?? "", /not shown under Entire Account/);

  await withFetch(
    () => permFail(),
    async () => {
      const res = await cfRequest("POST", "/zones", "tok", {
        name: "example.com",
        account: { id: "a1" },
      });
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.hint ?? "", /Zone > Zone > Edit/);
    },
  );
});

test("zone lookup uses exact name and account filters", async () => {
  let requestedUrl = "";
  await withFetch(
    (url) => {
      requestedUrl = url;
      return ok([
        {
          id: "z1",
          name: "example.com",
          status: "active",
          account: { id: "a1", name: "Account" },
        },
      ]);
    },
    async () => {
      const res = await findZoneByName("tok", "example.com", "a1");
      assert.equal(res.ok, true);
    },
  );

  assert.match(requestedUrl, /\/zones\?name=example\.com&account\.id=a1$/);
});

test("zone lookup normalizes internationalized names", async () => {
  let requestedUrl = "";
  await withFetch(
    (url) => {
      requestedUrl = url;
      return ok([{ id: "z1", name: "xn--bcher-kva.example", status: "active" }]);
    },
    async () => {
      const res = await findZoneByName("tok", "BÜCHER.example");
      assert.equal(res.ok, true);
    },
  );
  assert.match(requestedUrl, /\/zones\?name=xn--bcher-kva\.example$/);
});

test("malformed 2xx write responses are uncertain rather than successful", async () => {
  await withFetch(
    () => ({ status: 200, body: { unexpected: true } }),
    async () => {
      const write = await cfRequest("POST", "/zones/z1/dns_records", "tok", { type: "A" });
      assert.equal(write.ok, false);
      if (!write.ok) assert.equal(write.category, "transient");

      const read = await cfRequest("GET", "/zones", "tok");
      assert.equal(read.ok, false);
      if (!read.ok) assert.equal(read.category, "unknown");
    },
  );
});

test("legacy selected zones never fall through to a mismatched default account", () => {
  assert.equal(
    resolveTargetAccountId({
      selectedZoneMatches: true,
      selectedZoneAccountId: undefined,
      defaultAccountId: "wrong-account",
    }),
    undefined,
  );
  assert.equal(
    resolveTargetAccountId({
      selectedZoneMatches: true,
      selectedZoneAccountId: "zone-account",
      defaultAccountId: "wrong-account",
    }),
    "zone-account",
  );
  assert.equal(
    resolveTargetAccountId({
      explicitAccountId: "explicit-account",
      selectedZoneMatches: true,
      selectedZoneAccountId: "zone-account",
      defaultAccountId: "wrong-account",
    }),
    "explicit-account",
  );
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
