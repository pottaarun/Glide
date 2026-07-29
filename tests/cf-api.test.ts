import assert from "node:assert/strict";
import test from "node:test";

import {
  cfGetAll,
  cfRequest,
  findZoneByName,
  MAX_CF_API_PAGES,
  MAX_CF_API_PAGINATION_BYTES,
  MAX_CF_API_RESPONSE_BYTES,
  permissionHint,
  resolveRulesetEntrypointBaseline,
  resolveTargetAccountId,
  rulesetRuleForPut,
  verifyToken,
} from "../src/cf-api.ts";

test("ruleset PUT projection preserves every writable field and drops response metadata", () => {
  const projected = rulesetRuleForPut({
    id: "rule-id",
    version: "12",
    last_updated: "2026-07-28T00:00:00Z",
    action: "block",
    action_parameters: { response: { status_code: 403 } },
    categories: ["credential-abuse"],
    description: "Protect login",
    enabled: false,
    exposed_credential_check: { username_expression: "x", password_expression: "y" },
    expression: "true",
    logging: { enabled: false },
    ratelimit: { period: 60, requests_per_period: 10 },
    ref: "stable-reference",
  });
  assert.deepEqual(projected, {
    id: "rule-id",
    action: "block",
    action_parameters: { response: { status_code: 403 } },
    categories: ["credential-abuse"],
    description: "Protect login",
    enabled: false,
    exposed_credential_check: { username_expression: "x", password_expression: "y" },
    expression: "true",
    logging: { enabled: false },
    ratelimit: { period: 60, requests_per_period: 10 },
    ref: "stable-reference",
  });
});

type HandlerResult = Response | { status: number; body: unknown };
type Handler = (url: string, init?: RequestInit) => HandlerResult;

/** Swap in a fake global fetch that routes by URL, then restore it. */
async function withFetch(handler: Handler, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const response = handler(url, init);
    if (response instanceof Response) return response;
    const { status, body } = response;
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

test("rejects a declared oversized response before buffering it", async () => {
  let cancelled = false;
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), {
        status: 200,
        headers: { "Content-Length": String(MAX_CF_API_RESPONSE_BYTES + 1) },
      });
    },
    async () => {
      const res = await cfRequest("GET", "/zones", "tok");
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.message, /response exceeded/);
    },
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("enforces the response limit when Content-Length is absent or false", async () => {
  let cancelled = false;
  await withFetch(
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CF_API_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 200,
      headers: { "Content-Length": "1" },
    }),
    async () => {
      const res = await cfRequest("GET", "/zones", "tok");
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.message, /response exceeded/);
    },
  );
  assert.equal(cancelled, true);
});

test("preserves HTTP permission classification when an error body is unusable", async () => {
  const responses = [
    () => new Response(null, { status: 403 }),
    () => new Response("not json", { status: 403 }),
    () => new Response(new Uint8Array([0xff]), { status: 403 }),
    () => new Response(new ReadableStream({}), {
      status: 403,
      headers: { "Content-Length": String(MAX_CF_API_RESPONSE_BYTES + 1) },
    }),
  ];

  for (const response of responses) {
    await withFetch(
      response,
      async () => {
        const res = await cfRequest("GET", "/zones/z1/dns_records", "tok");
        assert.equal(res.ok, false);
        if (!res.ok) {
          assert.equal(res.status, 403);
          assert.equal(res.category, "permission");
          assert.match(res.hint ?? "", /DNS.*Read/);
          assert.deepEqual(res.cfErrors, []);
        }
      },
    );
  }
});

test("decodes multibyte JSON split across stream chunks", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ success: true, result: "café" }));
  const split = encoded.indexOf(0xc3) + 1;
  await withFetch(
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    }), { status: 200 }),
    async () => {
      const res = await cfRequest<string>("GET", "/zones", "tok");
      assert.deepEqual(res, { ok: true, result: "café", resultInfo: undefined });
    },
  );
});

test("cancels retryable response bodies before retrying", async () => {
  const realSetTimeout = globalThis.setTimeout;
  let calls = 0;
  let cancelled = false;
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, delay === 1500 ? 0 : delay, ...args)) as typeof setTimeout;
  try {
    await withFetch(
      () => {
        calls++;
        if (calls === 1) {
          return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 503 });
        }
        return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
      },
      async () => {
        const res = await cfRequest("GET", "/zones", "tok");
        assert.equal(res.ok, true);
      },
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
});

test("fetches paginated results in order", async () => {
  await withFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      return {
        status: 200,
        body: {
          success: true,
          result: page === "1" ? ["first"] : ["second"],
          result_info: { total_pages: 2 },
        },
      };
    },
    async () => {
      const res = await cfGetAll<string>("/zones", "tok");
      assert.deepEqual(res, { ok: true, result: ["first", "second"] });
    },
  );
});

test("bounds cumulative pagination response bytes", async () => {
  const payload = "x".repeat(Math.floor(MAX_CF_API_PAGINATION_BYTES / 4) - 100_000);
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      const body = JSON.stringify({
        success: true,
        result: [payload],
        result_info: { total_pages: 5 },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Length": String(new TextEncoder().encode(body).byteLength) },
      });
    },
    async () => {
      const res = await cfGetAll<string>("/zones", "tok");
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.message, /pagination exceeded/);
    },
  );
  assert.equal(calls, 5);
});

test("fails closed on malformed or excessive pagination metadata", async () => {
  await withFetch(
    () => ({ status: 200, body: { success: true, result: {}, result_info: { total_pages: 1 } } }),
    async () => {
      const res = await cfGetAll("/zones", "tok");
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.message, /malformed paginated result/);
    },
  );

  await withFetch(
    () => ({
      status: 200,
      body: { success: true, result: [], result_info: { total_pages: MAX_CF_API_PAGES + 1 } },
    }),
    async () => {
      const res = await cfGetAll("/zones", "tok");
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.message, /exceeded.*pages/);
    },
  );
});

test("ignores malformed Cloudflare error entries without throwing", async () => {
  await withFetch(
    () => ({ status: 403, body: { success: false, errors: { code: 9109, message: "bad shape" } } }),
    async () => {
      const res = await cfRequest("GET", "/zones", "tok");
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.category, "permission");
        assert.equal(res.message, "HTTP 403");
        assert.deepEqual(res.cfErrors, []);
      }
    },
  );
});

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

test("permission hints distinguish read access from write access", () => {
  assert.match(permissionHint("/zones/example/dns_records", "GET") ?? "", /DNS.*Read/);
  assert.match(permissionHint("/zones/example/dns_records", "POST") ?? "", /DNS.*Edit/);
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

test("only a missing ruleset phase becomes an empty apply baseline", () => {
  assert.deepEqual(
    resolveRulesetEntrypointBaseline({
      ok: false,
      status: 404,
      category: "not_found",
      message: "missing",
    }),
    { ok: true, result: [] },
  );
  for (const failure of [
    { ok: false as const, status: 403, category: "permission" as const, message: "forbidden" },
    { ok: false as const, status: 503, category: "transient" as const, message: "unavailable" },
    { ok: false as const, status: 0, category: "network" as const, message: "offline" },
  ]) {
    const baseline = resolveRulesetEntrypointBaseline(failure);
    assert.equal(baseline.ok, false);
    if (!baseline.ok) assert.equal(baseline.category, failure.category);
  }
  assert.equal(resolveRulesetEntrypointBaseline({ ok: true, result: {} }).ok, false);
  assert.deepEqual(
    resolveRulesetEntrypointBaseline({ ok: true, result: { rules: [{ id: "existing" }] } }),
    { ok: true, result: [{ id: "existing" }] },
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
