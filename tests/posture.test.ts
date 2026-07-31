import assert from "node:assert/strict";
import test from "node:test";

import {
  diffPosture,
  formatDriftForModel,
  formatPostureForModel,
  gradeForScore,
  isPostureFixQueueable,
  postureFixToPending,
  scorePosture,
  type PostureCheck,
  type PostureReport,
  type ZonePostureFacts,
} from "../src/posture.ts";

const ZID = "abcdef0123456789abcdef0123456789";

/** A fully-hardened zone — every check passes. */
function strongFacts(overrides: Partial<ZonePostureFacts> = {}): ZonePostureFacts {
  return {
    zoneId: ZID,
    zoneName: "example.com",
    active: true,
    sslMode: "strict",
    alwaysUseHttps: true,
    minTlsVersion: "1.2",
    tls13: true,
    hsts: true,
    managedWaf: true,
    dnssec: "active",
    proxiedRecords: 3,
    proxiableRecords: 3,
    ...overrides,
  };
}

function checkById(report: PostureReport, id: string): PostureCheck {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no posture check with id ${id}`);
  return c;
}

test("a fully-hardened zone grades A at 100", () => {
  const report = scorePosture(strongFacts(), 1_000);
  assert.equal(report.grade, "A");
  assert.equal(report.score, 100);
  assert.equal(report.ts, 1_000);
  assert.equal(report.tally.fail, 0);
  assert.equal(report.tally.unknown, 0);
  // Eight checks: SSL mode, Always-HTTPS, min TLS, TLS 1.3, HSTS, WAF, DNSSEC, proxy.
  assert.equal(report.checks.length, 8);
  assert.ok(report.checks.every((c) => c.status === "pass"));
});

test("a wide-open zone grades F", () => {
  const report = scorePosture(
    strongFacts({
      sslMode: "flexible",
      alwaysUseHttps: false,
      minTlsVersion: "1.0",
      tls13: false,
      hsts: false,
      managedWaf: false,
      dnssec: "disabled",
      proxiedRecords: 0,
      proxiableRecords: 3,
    }),
  );
  assert.equal(report.grade, "F");
  assert.ok(report.score < 20, `expected a low score, got ${report.score}`);
});

test("TLS 1.3 and HSTS gaps are warnings, not failures", () => {
  const report = scorePosture(strongFacts({ tls13: false, hsts: false }));
  assert.equal(checkById(report, "tls_1_3").status, "warn");
  assert.equal(checkById(report, "hsts").status, "warn");
  assert.equal(checkById(report, "ssl_mode").status, "pass");
});

test("Full (non-strict) SSL is a warning with partial credit, not a pass or fail", () => {
  const strict = scorePosture(strongFacts({ sslMode: "strict" }));
  const full = scorePosture(strongFacts({ sslMode: "full" }));
  assert.equal(checkById(full, "ssl_mode").status, "warn");
  assert.ok(full.score < strict.score, "warn should score below pass");
});

test("unreadable facts become unknown checks and are excluded from the grade", () => {
  // Only the SSL mode is readable; everything else failed to read.
  const report = scorePosture({ zoneId: ZID, sslMode: "strict" });
  assert.equal(report.tally.unknown, 7);
  assert.equal(checkById(report, "ssl_mode").status, "pass");
  // The one readable, passing check means the grade is A over what could be read.
  assert.equal(report.score, 100);
  assert.equal(report.grade, "A");
});

test("no proxiable records excludes the proxy check rather than failing it", () => {
  const report = scorePosture(strongFacts({ proxiedRecords: 0, proxiableRecords: 0 }));
  assert.equal(checkById(report, "proxy_coverage").status, "unknown");
});

test("partial proxy coverage warns; zero-of-many fails", () => {
  assert.equal(
    checkById(scorePosture(strongFacts({ proxiedRecords: 1, proxiableRecords: 3 })), "proxy_coverage").status,
    "warn",
  );
  assert.equal(
    checkById(scorePosture(strongFacts({ proxiedRecords: 0, proxiableRecords: 3 })), "proxy_coverage").status,
    "fail",
  );
});

test("pending DNSSEC warns; disabled fails", () => {
  assert.equal(checkById(scorePosture(strongFacts({ dnssec: "pending" })), "dnssec").status, "warn");
  assert.equal(checkById(scorePosture(strongFacts({ dnssec: "disabled" })), "dnssec").status, "fail");
});

test("queueable checks build a concrete call with the real zone id substituted", () => {
  const report = scorePosture(strongFacts({ sslMode: "flexible", minTlsVersion: "1.0" }));
  const ssl = postureFixToPending(checkById(report, "ssl_mode"), ZID);
  assert.deepEqual(ssl, {
    product: "Posture · TLS",
    summary: "Set SSL/TLS mode to Full (strict)",
    method: "PATCH",
    path: `/zones/${ZID}/settings/ssl`,
    body: { value: "strict" },
    zoneId: ZID,
  });
  const minTls = postureFixToPending(checkById(report, "min_tls"), ZID);
  assert.equal(minTls?.path, `/zones/${ZID}/settings/min_tls_version`);
  assert.deepEqual(minTls?.body, { value: "1.2" });
});

test("passing checks and non-queueable checks map to null (nothing to queue)", () => {
  const passing = scorePosture(strongFacts());
  assert.equal(postureFixToPending(checkById(passing, "ssl_mode"), ZID), null);
  // Managed WAF + proxy coverage are chat-guided, never one-click.
  const failing = scorePosture(strongFacts({ managedWaf: false, proxiedRecords: 0, proxiableRecords: 3 }));
  assert.equal(postureFixToPending(checkById(failing, "managed_waf"), ZID), null);
  assert.equal(postureFixToPending(checkById(failing, "proxy_coverage"), ZID), null);
  assert.equal(isPostureFixQueueable(checkById(failing, "managed_waf")), false);
  assert.equal(isPostureFixQueueable(checkById(failing, "proxy_coverage")), false);
});

test("non-queueable failing checks carry an Ask-Glide prompt", () => {
  const report = scorePosture(strongFacts({ managedWaf: false, proxiedRecords: 0, proxiableRecords: 3 }));
  assert.ok(checkById(report, "managed_waf").ask);
  assert.ok(checkById(report, "proxy_coverage").ask);
});

test("HSTS and DNSSEC fixes are flagged review-required", () => {
  const report = scorePosture(strongFacts({ hsts: false, dnssec: "disabled" }));
  assert.equal(checkById(report, "hsts").fix?.reviewRequired, true);
  assert.equal(checkById(report, "dnssec").fix?.reviewRequired, true);
});

test("gradeForScore uses standard bands", () => {
  assert.equal(gradeForScore(100), "A");
  assert.equal(gradeForScore(90), "A");
  assert.equal(gradeForScore(89), "B");
  assert.equal(gradeForScore(80), "B");
  assert.equal(gradeForScore(70), "C");
  assert.equal(gradeForScore(60), "D");
  assert.equal(gradeForScore(59), "F");
  assert.equal(gradeForScore(0), "F");
});

test("a zone with nothing readable reports an ungradeable summary", () => {
  const report = scorePosture({ zoneId: ZID });
  assert.equal(report.tally.unknown, report.checks.length);
  assert.match(report.summary, /couldn't read/i);
});

test("formatPostureForModel renders the grade and groups by status", () => {
  const text = formatPostureForModel(scorePosture(strongFacts({ sslMode: "flexible" })));
  assert.match(text, /grade [A-F] \(\d+\/100\)/i);
  assert.match(text, /FAILING/);
  assert.match(text, /Fix: queue/);
});

// --- Configuration-drift watch (diffPosture) -------------------------------

test("identical posture reports show no drift", () => {
  const baseline = scorePosture(strongFacts(), 1_000);
  const current = scorePosture(strongFacts(), 2_000);
  const drift = diffPosture(baseline, current);
  assert.equal(drift.drifted, false);
  assert.equal(drift.regressions.length, 0);
  assert.equal(drift.improvements.length, 0);
  assert.equal(drift.baselineTs, 1_000);
  assert.equal(drift.currentTs, 2_000);
  assert.equal(drift.baselineGrade, "A");
  assert.equal(drift.currentGrade, "A");
  assert.match(drift.summary, /no posture drift/i);
});

test("a check that got worse is reported as a regression with from/to", () => {
  const baseline = scorePosture(strongFacts());
  const current = scorePosture(strongFacts({ sslMode: "flexible" }));
  const drift = diffPosture(baseline, current);
  assert.equal(drift.drifted, true);
  assert.equal(drift.regressions.length, 1);
  const reg = drift.regressions[0];
  assert.equal(reg.id, "ssl_mode");
  assert.equal(reg.from, "pass");
  assert.equal(reg.to, "fail");
  assert.equal(reg.direction, "regression");
  assert.ok(drift.currentScore < drift.baselineScore);
  assert.match(drift.summary, /1 posture regression/i);
});

test("a check that recovered is an improvement, not drift", () => {
  const baseline = scorePosture(strongFacts({ sslMode: "flexible" }));
  const current = scorePosture(strongFacts());
  const drift = diffPosture(baseline, current);
  assert.equal(drift.drifted, false);
  assert.equal(drift.regressions.length, 0);
  assert.equal(drift.improvements.length, 1);
  assert.equal(drift.improvements[0].id, "ssl_mode");
  assert.equal(drift.improvements[0].direction, "improvement");
  assert.match(drift.summary, /improved/i);
});

test("transitions involving an unreadable status are ignored (both directions)", () => {
  const readable = scorePosture(strongFacts());
  const sslUnknown = scorePosture(strongFacts({ sslMode: undefined }));
  assert.equal(checkById(sslUnknown, "ssl_mode").status, "unknown");
  // pass -> unknown is not a regression.
  assert.equal(diffPosture(readable, sslUnknown).regressions.length, 0);
  assert.equal(diffPosture(readable, sslUnknown).improvements.length, 0);
  // unknown -> pass is not an improvement.
  assert.equal(diffPosture(sslUnknown, readable).improvements.length, 0);
  assert.equal(diffPosture(sslUnknown, readable).regressions.length, 0);
});

test("regressions are ordered worst severity-jump first", () => {
  const baseline = scorePosture(strongFacts());
  // hsts pass->warn (jump 1); ssl_mode pass->fail (jump 2).
  const current = scorePosture(strongFacts({ hsts: false, sslMode: "flexible" }));
  const drift = diffPosture(baseline, current);
  assert.deepEqual(
    drift.regressions.map((d) => d.id),
    ["ssl_mode", "hsts"],
  );
});

test("a regression carries whether its fix is one-click queueable", () => {
  const baseline = scorePosture(strongFacts());
  // ssl_mode (queueable one-click) regresses; managed_waf (chat-guided) also regresses.
  const current = scorePosture(strongFacts({ sslMode: "flexible", managedWaf: false }));
  const drift = diffPosture(baseline, current);
  const ssl = drift.regressions.find((d) => d.id === "ssl_mode");
  const waf = drift.regressions.find((d) => d.id === "managed_waf");
  assert.equal(ssl?.direction, "regression");
  assert.equal(waf?.direction, "regression");
  // diffPosture itself doesn't compute queueable (the server projection does), but
  // the underlying checks must still map correctly for that projection.
  assert.equal(isPostureFixQueueable(checkById(current, "ssl_mode")), true);
  assert.equal(isPostureFixQueueable(checkById(current, "managed_waf")), false);
});

test("mixed regressions and improvements are both reported", () => {
  const baseline = scorePosture(strongFacts({ sslMode: "flexible" })); // ssl fails
  const current = scorePosture(strongFacts({ hsts: false })); // ssl recovers, hsts warns
  const drift = diffPosture(baseline, current);
  assert.equal(drift.drifted, true);
  assert.deepEqual(drift.regressions.map((d) => d.id), ["hsts"]);
  assert.deepEqual(drift.improvements.map((d) => d.id), ["ssl_mode"]);
  assert.match(drift.summary, /regression/i);
  assert.match(drift.summary, /improvement/i);
});

test("formatDriftForModel renders regressions and the re-queue prompt", () => {
  const drift = diffPosture(scorePosture(strongFacts()), scorePosture(strongFacts({ sslMode: "flexible" })));
  const text = formatDriftForModel(drift);
  assert.match(text, /## REGRESSIONS/);
  assert.match(text, /PASS → FAIL/);
  assert.match(text, /re-queue the one-click fixes/i);
});

test("formatDriftForModel shows improvements without a regressions section", () => {
  const drift = diffPosture(scorePosture(strongFacts({ sslMode: "flexible" })), scorePosture(strongFacts()));
  const text = formatDriftForModel(drift);
  assert.match(text, /## IMPROVEMENTS/);
  assert.doesNotMatch(text, /## REGRESSIONS/);
});
