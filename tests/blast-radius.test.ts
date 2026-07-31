import assert from "node:assert/strict";
import test from "node:test";

import { estimateBlastRadius, formatBlastRadius, type BlastActionInput } from "../src/blast-radius.ts";
import type { ZoneTrafficSnapshot } from "../src/cf-api.ts";

function traffic(total: number, byCountry: Record<string, number> = {}): ZoneTrafficSnapshot {
  return {
    since: "2026-01-01T00:00:00Z",
    until: "2026-01-02T00:00:00Z",
    windowHours: 24,
    totalRequests: total,
    byCountry: Object.entries(byCountry).map(([country, requests]) => ({ country, requests })),
  };
}

function waf(expression: string, action = "block"): BlastActionInput {
  return {
    method: "POST",
    path: "/zones/abcdef0123456789abcdef0123456789/rulesets/phases/http_request_firewall_custom/entrypoint",
    body: { expression, action },
  };
}

test("country-scoped block is quantified from per-country volume", () => {
  const est = estimateBlastRadius(waf('ip.geoip.country eq "RU"'), traffic(100_000, { RU: 30_000, US: 70_000 }));
  assert.equal(est.matchedRequests, 30_000);
  assert.equal(est.matchedPct, 30);
  assert.equal(est.level, "high");
  assert.equal(est.totalRequests, 100_000);
  assert.match(est.summary, /Blocking RU/);
  assert.match(est.summary, /30\.0%/);
});

test("blast level scales with matched percentage", () => {
  assert.equal(estimateBlastRadius(waf('ip.geoip.country eq "RU"'), traffic(100_000, { RU: 6_000 })).level, "medium");
  assert.equal(estimateBlastRadius(waf('ip.geoip.country eq "RU"'), traffic(100_000, { RU: 2_000 })).level, "low");
  assert.equal(estimateBlastRadius(waf('ip.geoip.country eq "RU"'), traffic(100_000, { RU: 40_000 })).level, "high");
});

test("observational actions (log) never exceed low risk", () => {
  const est = estimateBlastRadius(waf('ip.geoip.country eq "RU"', "log"), traffic(100_000, { RU: 90_000 }));
  assert.equal(est.level, "low");
  assert.match(est.summary, /only observes/);
});

test("multi-country membership sets are summed", () => {
  const est = estimateBlastRadius(
    waf('ip.geoip.country in {"RU" "CN"}'),
    traffic(100_000, { RU: 10_000, CN: 15_000, US: 75_000 }),
  );
  assert.equal(est.matchedRequests, 25_000);
  assert.equal(est.matchedPct, 25);
  assert.ok(est.signals.some((s) => s.includes("RU") && s.includes("CN")));
});

test("path-scoped rules are honest about not being exactly countable", () => {
  const est = estimateBlastRadius(waf('http.request.uri.path contains "/checkout"'), traffic(50_000));
  assert.equal(est.level, "unknown");
  assert.match(est.summary, /\/checkout/);
  assert.match(est.summary, /50,000/);
  assert.equal(est.totalRequests, 50_000);
});

test("a zone-wide blocking rule with no filter is high risk", () => {
  const est = estimateBlastRadius(
    { method: "POST", path: "/zones/x/rulesets", body: { expression: "true", action: "block" } },
    traffic(20_000),
  );
  assert.equal(est.level, "high");
  assert.match(est.summary, /ALL traffic/);
});

test("a zone-wide setting change reports reach, not a scary level", () => {
  const est = estimateBlastRadius(
    { method: "PATCH", path: "/zones/x/settings/min_tls_version", body: { value: "1.2" } },
    traffic(20_000),
  );
  assert.equal(est.level, "unknown");
  assert.match(est.summary, /zone-wide/i);
  assert.match(est.summary, /20,000/);
});

test("missing analytics yields an honest unknown with a permission hint", () => {
  const est = estimateBlastRadius(waf('ip.geoip.country eq "RU"'), undefined);
  assert.equal(est.level, "unknown");
  assert.match(est.summary, /Analytics: Read/);
  // Signals are still parsed even without traffic.
  assert.ok(est.signals.some((s) => s.includes("RU")));
});

test("signals capture action, country, path and method", () => {
  const est = estimateBlastRadius(
    waf('ip.geoip.country eq "RU" and http.request.uri.path contains "/api" and http.request.method eq "POST"'),
    traffic(1000, { RU: 100 }),
  );
  assert.ok(est.signals.includes("action: block"));
  assert.ok(est.signals.some((s) => s.startsWith("countries:")));
  assert.ok(est.signals.some((s) => s.startsWith("path:")));
  assert.ok(est.signals.some((s) => s === "method: POST"));
});

test("expressions nested inside ruleset rule arrays are discovered", () => {
  const action: BlastActionInput = {
    method: "PUT",
    path: "/zones/x/rulesets/phases/http_request_firewall_custom/entrypoint",
    body: { rules: [{ action: "block", expression: 'ip.geoip.country eq "CN"' }] },
  };
  const est = estimateBlastRadius(action, traffic(100_000, { CN: 5_000 }));
  assert.equal(est.matchedRequests, 5_000);
  assert.equal(est.level, "medium");
});

test("formatBlastRadius renders level and reach", () => {
  const est = estimateBlastRadius(waf('ip.geoip.country eq "RU"'), traffic(100_000, { RU: 30_000 }));
  const line = formatBlastRadius(est);
  assert.match(line, /Impact: HIGH/);
  assert.match(line, /30,000 req, 30%/);
});
