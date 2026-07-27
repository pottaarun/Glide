import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteDocPages,
  indexDocPage,
  parseProductIndex,
  parseTopIndex,
} from "../src/docs-scraper.ts";

test("docs indexes accept only official HTTPS Cloudflare URLs", () => {
  const products = parseTopIndex(`
- [DNS](https://developers.cloudflare.com/dns/llms.txt)
- [External](https://example.com/llms.txt)
- [Insecure](http://developers.cloudflare.com/waf/llms.txt)
`);
  assert.deepEqual(products.map((product) => product.url), ["https://developers.cloudflare.com/dns/llms.txt"]);

  const pages = parseProductIndex(`
## Reference
- [Records](https://developers.cloudflare.com/dns/manage-dns-records/index.md)
- [External](https://example.com/fake.md)
- [Insecure](http://developers.cloudflare.com/waf/rules.md)
`);
  assert.deepEqual(pages.map((page) => page.url), [
    "https://developers.cloudflare.com/dns/manage-dns-records/index.md",
  ]);
});

test("docs cleanup deletes known vector ids in bounded batches", async () => {
  const batches: string[][] = [];
  const env = {
    VECTORIZE: {
      deleteByIds: async (ids: string[]) => {
        batches.push(ids);
        return {};
      },
    },
  } as unknown as Cloudflare.Env;
  const pages = Array.from({ length: 126 }, (_, i) => ({
    url: `https://developers.cloudflare.com/product/${i}.md`,
    chunks: 8,
  }));

  const result = await deleteDocPages(env, pages);
  assert.deepEqual(result, { ok: true, deleted: 1008 });
  assert.deepEqual(batches.map((batch) => batch.length), [1000, 8]);
  assert.equal(new Set(batches.flat()).size, 1008);
});

test("a page refresh upserts replacement vectors before deleting stale tails", async () => {
  const realFetch = globalThis.fetch;
  const operations: string[] = [];
  globalThis.fetch = (async () => new Response("# Updated\n\nCurrent documentation.")) as typeof fetch;
  const env = {
    GLIDE_EMBED_MODEL: "embedding-model",
    AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
    VECTORIZE: {
      upsert: async () => {
        operations.push("upsert");
        return {};
      },
      deleteByIds: async () => {
        operations.push("delete");
        return {};
      },
    },
  } as unknown as Cloudflare.Env;
  try {
    const result = await indexDocPage(
      env,
      { url: "https://developers.cloudflare.com/dns/page.md", title: "DNS", section: "Reference" },
      "DNS",
    );
    assert.deepEqual(result, { ok: true, chunks: 1 });
    assert.deepEqual(operations, ["upsert", "delete"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a successfully fetched empty page clears its previous vectors", async () => {
  const realFetch = globalThis.fetch;
  const deleted: string[][] = [];
  globalThis.fetch = (async () => new Response("> Documentation Index")) as typeof fetch;
  const env = {
    VECTORIZE: {
      deleteByIds: async (ids: string[]) => {
        deleted.push(ids);
        return {};
      },
    },
  } as unknown as Cloudflare.Env;
  try {
    const result = await indexDocPage(
      env,
      { url: "https://developers.cloudflare.com/dns/empty.md", title: "Empty", section: "Reference" },
      "DNS",
    );
    assert.deepEqual(result, { ok: true, chunks: 0 });
    assert.equal(deleted[0]?.length, 8);
  } finally {
    globalThis.fetch = realFetch;
  }
});
