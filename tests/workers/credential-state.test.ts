import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

import type { GlideAgent } from "../../src/server";
import type { PendingAction } from "../../src/shared";

const TOKEN_A = "cfat_abcdefghijklmnopqrstuvwxyz";
const TOKEN_B = "cfat_zyxwvutsrqponmlkjihgfedcba";
const ZONE_ID = "a".repeat(32);

function pendingSetting(id: string): PendingAction {
  return {
    id,
    product: "Zone settings",
    summary: "Set SSL mode",
    method: "PATCH",
    path: `/zones/${ZONE_ID}/settings/ssl`,
    body: { value: "strict" },
    zoneId: ZONE_ID,
    createdBy: "test",
    status: "pending",
    ts: Date.now(),
  };
}

function pendingRuleset(id: string): PendingAction {
  const phase = "http_request_firewall_custom";
  const newRules = [{ action: "block", expression: "true", description: "test", enabled: true }];
  return {
    id,
    product: "WAF",
    summary: "Add WAF rule",
    method: "PUT",
    path: `/zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`,
    body: { rules: newRules },
    mergeEntrypoint: { phase, newRules },
    zoneId: ZONE_ID,
    createdBy: "test",
    status: "pending",
    ts: Date.now(),
  };
}

describe("credential operation ordering", () => {
  it("does not let a slower token save overwrite a newer clear", async () => {
    const stub = await getAgentByName(env.GlideAgent, `credential-${crypto.randomUUID()}`);
    await stub.startOnboarding("test");

    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      let releaseVerification!: () => void;
      let markStarted!: () => void;
      const verificationStarted = new Promise<void>((resolve) => { markStarted = resolve; });
      const verificationRelease = new Promise<void>((resolve) => { releaseVerification = resolve; });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        markStarted();
        await verificationRelease;
        return Response.json({ success: true, result: { status: "active" } });
      }) as typeof fetch;
      try {
        const saving = agent.setCloudflareToken(TOKEN_A);
        await verificationStarted;
        await agent.clearCloudflareToken();
        releaseVerification();
        const saveResult = await saving;
        const secretCount = state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM glide_secrets")
          .one().count;
        return { saveResult, secretCount, tokenConfigured: agent.state.tokenConfigured };
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    expect(result.saveResult.ok).toBe(false);
    expect(result.saveResult.message).toMatch(/newer token change/i);
    expect(result.secretCount).toBe(0);
    expect(result.tokenConfigured).toBe(false);
  });

  it("does not start Apply while a replacement token is still verifying", async () => {
    const stub = await getAgentByName(env.GlideAgent, `credential-apply-${crypto.randomUUID()}`);
    await stub.startOnboarding("test");

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      let releaseVerification!: () => void;
      let markVerificationStarted!: () => void;
      const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
      const verificationRelease = new Promise<void>((resolve) => { releaseVerification = resolve; });
      const writes: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("Authorization");
        if (url.includes("/user/tokens/verify")) {
          if (authorization === `Bearer ${TOKEN_B}`) {
            markVerificationStarted();
            await verificationRelease;
          }
          return Response.json({ success: true, result: { status: "active" } });
        }
        if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`);
        return Response.json({ success: true, result: {} });
      }) as typeof fetch;
      try {
        expect((await agent.setCloudflareToken(TOKEN_A)).ok).toBe(true);
        const action = pendingSetting(crypto.randomUUID());
        agent.setState({ ...agent.state, pendingActions: [action] });

        const saving = agent.setCloudflareToken(TOKEN_B);
        await verificationStarted;
        const result = await agent.applyAction(action.id, "test");
        releaseVerification();
        const saveResult = await saving;
        return {
          result,
          saveResult,
          writes,
          pending: agent.state.pendingActions.find((candidate) => candidate.id === action.id),
        };
      } finally {
        releaseVerification?.();
        await state.storage.deleteAlarm();
        globalThis.fetch = originalFetch;
      }
    });

    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.detail).toMatch(/nothing was sent/i);
    expect(outcome.saveResult.ok).toBe(true);
    expect(outcome.writes).toEqual([]);
    expect(outcome.pending?.status).toBe("failed");
  });

  it("does not PUT a ruleset after the token is cleared during its safety read", async () => {
    const stub = await getAgentByName(env.GlideAgent, `credential-ruleset-${crypto.randomUUID()}`);
    await stub.startOnboarding("test");

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({ success: true, result: { status: "active" } })) as typeof fetch;
      expect((await agent.setCloudflareToken(TOKEN_A)).ok).toBe(true);

      let releaseRead!: () => void;
      let markReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
      const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
      const writes: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "GET" && url.includes("/rulesets/phases/")) {
          markReadStarted();
          await readRelease;
          return Response.json({ success: true, result: { rules: [] } });
        }
        if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url}`);
        return Response.json({ success: true, result: {} });
      }) as typeof fetch;
      try {
        const action = pendingRuleset(crypto.randomUUID());
        agent.setState({ ...agent.state, pendingActions: [action] });
        const applying = agent.applyAction(action.id, "test");
        await readStarted;
        await agent.clearCloudflareToken();
        releaseRead();
        const result = await applying;
        return {
          result,
          writes,
          pending: agent.state.pendingActions.find((candidate) => candidate.id === action.id),
        };
      } finally {
        releaseRead?.();
        await state.storage.deleteAlarm();
        globalThis.fetch = originalFetch;
      }
    });

    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.detail).toMatch(/no write was sent/i);
    expect(outcome.writes).toEqual([]);
    expect(outcome.pending?.status).toBe("failed");
  });
});
