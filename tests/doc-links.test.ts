import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DOC_LINKS, mergeDocLinks, type DocLink } from "../src/shared.ts";

type Hit = Parameters<typeof mergeDocLinks>[1][number];
const DOCS = "https://developers.cloudflare.com";

function doc(path: string): string {
  return `${DOCS}/${path}`;
}

function hit(url: string, over: Partial<Hit> = {}): Hit {
  return { url, title: url, product: undefined, score: undefined, ...over };
}

test("merges fresh hits into an empty list, stamping ts and preserving fields", () => {
  const out = mergeDocLinks(undefined, [hit(doc("a"), { title: "A", product: "WAF", score: 0.8 })], 1000);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { url: doc("a"), title: "A", product: "WAF", score: 0.8, ts: 1000 });
});

test("dedupes by URL, keeping one entry per page", () => {
  const out = mergeDocLinks(undefined, [hit(doc("a")), hit(doc("a")), hit(doc("b"))], 1000);
  assert.deepEqual(
    out.map((d) => d.url).sort(),
    [doc("a"), doc("b")],
  );
});

test("keeps the best (max) score seen for a page across merges", () => {
  const first = mergeDocLinks(undefined, [hit(doc("a"), { score: 0.5 })], 1000);
  const second = mergeDocLinks(first, [hit(doc("a"), { score: 0.9 })], 2000);
  assert.equal(second.length, 1);
  assert.equal(second[0].score, 0.9);

  // A weaker later score must not overwrite a stronger earlier one.
  const third = mergeDocLinks(second, [hit(doc("a"), { score: 0.2 })], 3000);
  assert.equal(third[0].score, 0.9);
});

test("re-surfacing a page bumps it to the top (most-recent-first)", () => {
  const existing: DocLink[] = [
    { url: doc("a"), title: "A", ts: 1000 },
    { url: doc("b"), title: "B", ts: 1100 },
  ];
  const out = mergeDocLinks(existing, [hit(doc("a"), { title: "A" })], 2000);
  assert.deepEqual(
    out.map((d) => d.url),
    [doc("a"), doc("b")],
  );
  assert.equal(out[0].ts, 2000);
  assert.equal(out[1].ts, 1100);
});

test("within one turn, ties on ts break by score descending", () => {
  const out = mergeDocLinks(
    undefined,
    [hit(doc("low"), { score: 0.1 }), hit(doc("high"), { score: 0.9 }), hit(doc("mid"), { score: 0.5 })],
    1000,
  );
  assert.deepEqual(
    out.map((d) => d.url),
    [doc("high"), doc("mid"), doc("low")],
  );
});

test("caps the list at MAX_DOC_LINKS, dropping the weakest same-turn pages", () => {
  const hits = Array.from({ length: MAX_DOC_LINKS + 3 }, (_, i) => hit(doc(String(i)), { score: i }));
  const out = mergeDocLinks(undefined, hits, 1000);
  assert.equal(out.length, MAX_DOC_LINKS);
  // Highest scores survive; the three lowest (0,1,2) are dropped.
  const urls = new Set(out.map((d) => d.url));
  assert.ok(!urls.has(doc("0")));
  assert.ok(!urls.has(doc("1")));
  assert.ok(!urls.has(doc("2")));
  assert.ok(urls.has(doc(String(MAX_DOC_LINKS + 2))));
});

test("honours a custom cap", () => {
  const hits = Array.from({ length: 6 }, (_, i) => hit(doc(String(i)), { score: i }));
  const out = mergeDocLinks(undefined, hits, 1000, 3);
  assert.equal(out.length, 3);
});

test("falls back to prev title / URL when a hit's title is blank", () => {
  const withPrev = mergeDocLinks(
    [{ url: doc("a"), title: "Kept", ts: 1000 }],
    [hit(doc("a"), { title: "   " })],
    2000,
  );
  assert.equal(withPrev[0].title, "Kept");

  const noPrev = mergeDocLinks(undefined, [hit(doc("b"), { title: "" })], 1000);
  assert.equal(noPrev[0].title, doc("b"));
});

test("carries product forward from the existing entry when a hit omits it", () => {
  const out = mergeDocLinks([{ url: doc("a"), title: "A", product: "WAF", ts: 1000 }], [hit(doc("a"))], 2000);
  assert.equal(out[0].product, "WAF");
});

test("ignores malformed hits and existing entries without a URL", () => {
  const existing = [{ url: "", title: "bad", ts: 1 } as DocLink, null as unknown as DocLink];
  const hits = [hit(""), { title: "no url" } as unknown as Hit, null as unknown as Hit, hit(doc("ok"), { title: "ok" })];
  const out = mergeDocLinks(existing, hits, 1000);
  assert.deepEqual(
    out.map((d) => d.url),
    [doc("ok")],
  );
});

test("keeps only official HTTPS Cloudflare developer-docs URLs", () => {
  const out = mergeDocLinks(
    [{ url: "https://example.com/old", title: "external", ts: 1 }],
    [
      hit("https://developers.cloudflare.com/dns/", { title: "DNS" }),
      hit("http://developers.cloudflare.com/waf/", { title: "insecure" }),
      hit("https://example.com/phishing", { title: "external" }),
    ],
    1000,
  );
  assert.deepEqual(out.map((d) => d.url), ["https://developers.cloudflare.com/dns/"]);
});

test("is pure — does not mutate the existing array or its entries", () => {
  const existing: DocLink[] = [{ url: doc("a"), title: "A", score: 0.5, ts: 1000 }];
  const snapshot = JSON.parse(JSON.stringify(existing));
  mergeDocLinks(existing, [hit(doc("a"), { score: 0.9 }), hit(doc("b"))], 2000);
  assert.deepEqual(existing, snapshot);
});

test("empty inputs yield an empty list", () => {
  assert.deepEqual(mergeDocLinks(undefined, [], 1000), []);
});
