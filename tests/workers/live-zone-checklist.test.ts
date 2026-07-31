import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

import { getZoneManagedWafDeployed, getZoneSslMode } from "../../src/cf-api";
import type { GlideAgent } from "../../src/server";
import type { LiveZoneFacts, OnboardingStep } from "../../src/shared";

const TOKEN = "cfat_" + "a".repeat(30);
const ZONE_ID = "b".repeat(32);
const OTHER_ZONE_ID = "c".repeat(32);

/** Reach the private live-zone helpers the chat tools drive, without the model. */
interface LiveZoneInternals {
  mergeLiveZone(facts: Partial<LiveZoneFacts> & { zoneId: string }): void;
  captureLiveZoneFacts(
    zoneId: string,
    name: string,
    status: string | undefined,
    credential: unknown,
  ): Promise<void>;
  getCredentialLease(): Promise<{ token: string; generation: number } | null | undefined>;
}

function stepStates(checklist: OnboardingStep[]): Record<string, { done: boolean; na: boolean }> {
  return Object.fromEntries(checklist.map((s) => [s.id, { done: s.done, na: Boolean(s.na) }]));
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cf-api live zone readers", () => {
  it("getZoneSslMode returns the configured mode", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(`/zones/${ZONE_ID}/settings/ssl`);
      return Response.json({ success: true, result: { id: "ssl", value: "strict" } });
    }) as typeof fetch;
    expect(await getZoneSslMode(TOKEN, ZONE_ID)).toEqual({ ok: true, result: "strict" });
  });

  it("getZoneSslMode maps an unrecognized value to 'unknown'", async () => {
    globalThis.fetch = (async () =>
      Response.json({ success: true, result: { value: "weird" } })) as typeof fetch;
    expect(await getZoneSslMode(TOKEN, ZONE_ID)).toEqual({ ok: true, result: "unknown" });
  });

  it("getZoneManagedWafDeployed is true when an enabled execute rule exists", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(
        `/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_managed/entrypoint`,
      );
      return Response.json({ success: true, result: { rules: [{ action: "execute", enabled: true }] } });
    }) as typeof fetch;
    expect(await getZoneManagedWafDeployed(TOKEN, ZONE_ID)).toEqual({ ok: true, result: true });
  });

  it("getZoneManagedWafDeployed treats a missing entrypoint (404) as not deployed", async () => {
    globalThis.fetch = (async () =>
      Response.json({ success: false, errors: [{ code: 1001, message: "not found" }] }, { status: 404 })) as typeof fetch;
    expect(await getZoneManagedWafDeployed(TOKEN, ZONE_ID)).toEqual({ ok: true, result: false });
  });

  it("getZoneManagedWafDeployed ignores disabled execute rules", async () => {
    globalThis.fetch = (async () =>
      Response.json({ success: true, result: { rules: [{ action: "execute", enabled: false }] } })) as typeof fetch;
    expect(await getZoneManagedWafDeployed(TOKEN, ZONE_ID)).toEqual({ ok: true, result: false });
  });
});

describe("live zone → onboarding checklist", () => {
  it("an active, secured zone auto-ticks go-live steps and marks TTL N/A", async () => {
    const stub = await getAgentByName(env.GlideAgent, `livezone-active-${crypto.randomUUID()}`);
    const checklist = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/user/tokens/verify")) {
          return Response.json({ success: true, result: { status: "active" } });
        }
        if (url.includes(`/zones/${ZONE_ID}/settings/ssl`)) {
          return Response.json({ success: true, result: { value: "strict" } });
        }
        if (url.includes(`/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_managed/entrypoint`)) {
          return Response.json({ success: true, result: { rules: [{ action: "execute", enabled: true }] } });
        }
        return Response.json({ success: true, result: {} });
      }) as typeof fetch;
      try {
        await agent.startOnboarding("tester");
        await agent.updateOnboarding({ path: "fresh", domain: "example.com" }, "tester");
        expect((await agent.setCloudflareToken(TOKEN)).ok).toBe(true);
        agent.setState({ ...agent.state, defaultZone: { id: ZONE_ID, name: "example.com" } });
        const internals = agent as unknown as LiveZoneInternals;
        const lease = await internals.getCredentialLease();
        if (!lease) throw new Error("expected a credential lease");
        // find_zone captures activation + SSL + WAF ...
        await internals.captureLiveZoneFacts(ZONE_ID, "example.com", "active", lease);
        // ... and list_dns_records folds in proxy coverage.
        internals.mergeLiveZone({ zoneId: ZONE_ID, proxiedRecords: 2, proxiableRecords: 3 });
        return agent.state.onboarding!.checklist;
      } finally {
        await state.storage.deleteAlarm().catch(() => {});
      }
    });

    const s = stepStates(checklist);
    expect(s.domain).toEqual({ done: true, na: false });
    expect(s.nameservers).toEqual({ done: true, na: false });
    expect(s.verify).toEqual({ done: true, na: false });
    expect(s.ssl).toEqual({ done: true, na: false });
    expect(s.security).toEqual({ done: true, na: false });
    expect(s.proxy).toEqual({ done: true, na: false });
    expect(s.ttl).toEqual({ done: false, na: true });
  });

  it("a pending, unsecured zone leaves go-live steps unticked and TTL applicable", async () => {
    const stub = await getAgentByName(env.GlideAgent, `livezone-pending-${crypto.randomUUID()}`);
    const checklist = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      try {
        await agent.startOnboarding("tester");
        await agent.updateOnboarding({ path: "fresh", domain: "example.com" }, "tester");
        agent.setState({ ...agent.state, defaultZone: { id: ZONE_ID, name: "example.com" } });
        (agent as unknown as LiveZoneInternals).mergeLiveZone({
          zoneId: ZONE_ID,
          status: "pending",
          sslMode: "flexible",
          wafManaged: false,
          proxiedRecords: 0,
          proxiableRecords: 3,
        });
        return agent.state.onboarding!.checklist;
      } finally {
        await state.storage.deleteAlarm().catch(() => {});
      }
    });

    const s = stepStates(checklist);
    expect(s.nameservers).toEqual({ done: false, na: false });
    expect(s.verify).toEqual({ done: false, na: false });
    expect(s.ssl).toEqual({ done: false, na: false });
    expect(s.security).toEqual({ done: false, na: false });
    expect(s.proxy).toEqual({ done: false, na: false });
    expect(s.ttl).toEqual({ done: false, na: false });
  });

  it("a snapshot for a different zone than the default never ticks steps", async () => {
    const stub = await getAgentByName(env.GlideAgent, `livezone-stale-${crypto.randomUUID()}`);
    const checklist = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      try {
        await agent.startOnboarding("tester");
        await agent.updateOnboarding({ path: "fresh", domain: "example.com" }, "tester");
        agent.setState({ ...agent.state, defaultZone: { id: ZONE_ID, name: "example.com" } });
        // Facts describe a DIFFERENT zone than the room's default.
        (agent as unknown as LiveZoneInternals).mergeLiveZone({
          zoneId: OTHER_ZONE_ID,
          status: "active",
          sslMode: "strict",
          wafManaged: true,
        });
        return agent.state.onboarding!.checklist;
      } finally {
        await state.storage.deleteAlarm().catch(() => {});
      }
    });

    const s = stepStates(checklist);
    expect(s.nameservers).toEqual({ done: false, na: false });
    expect(s.verify).toEqual({ done: false, na: false });
    expect(s.ssl).toEqual({ done: false, na: false });
    expect(s.ttl).toEqual({ done: false, na: false });
  });
});
