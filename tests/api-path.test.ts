import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeApiPath, canonicalizeDomainName } from "../src/api-path.ts";

test("canonicalizes ordinary Cloudflare API paths", () => {
  assert.equal(canonicalizeApiPath(" /zones/z1/dns_records?type=A "), "/zones/z1/dns_records?type=A");
  const unicodeQuery = canonicalizeApiPath("/zones?name=bücher.example");
  assert.equal(unicodeQuery, "/zones?name=b%C3%BCcher.example");
  assert.equal(canonicalizeApiPath(unicodeQuery ?? ""), unicodeQuery);
  assert.equal(
    canonicalizeApiPath("/accounts/a1/storage/kv/namespaces/n1/values/name%20with%20spaces"),
    "/accounts/a1/storage/kv/namespaces/n1/values/name%20with%20spaces",
  );
  assert.equal(
    canonicalizeApiPath("/accounts/a1/storage/kv/namespaces/n1/values/100%25-ready"),
    "/accounts/a1/storage/kv/namespaces/n1/values/100%25-ready",
  );
});

test("rejects paths whose fetch target is ambiguous", () => {
  for (const path of [
    "/zones#bypass",
    "/zones/.",
    "/zones\\",
    "/zones/%2e",
    "/zones/%252fescape",
    "/zones/%25252fescape",
    "/zones/bücher.example",
    "/zones/has space",
    "//zones",
  ]) {
    assert.equal(canonicalizeApiPath(path), undefined, path);
  }
});

test("normalizes internationalized domains and rejects non-host input", () => {
  assert.equal(canonicalizeDomainName("BÜCHER.example."), "xn--bcher-kva.example");
  assert.equal(canonicalizeDomainName("Example.COM"), "example.com");
  for (const value of ["https://example.com", "user@example.com", "example.com/path", "localhost", "127.0.0.1"]) {
    assert.equal(canonicalizeDomainName(value), undefined, value);
  }
});
