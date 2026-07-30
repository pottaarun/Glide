import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName, type Connection } from "agents";
import { describe, expect, it } from "vitest";

import worker, { type GlideAgent } from "../../src/server";
import type { RateLimitDecision, RateLimiter } from "../../src/rate-limits";

type RateLimitHook = {
  checkRateLimit(limiter: RateLimiter, key: string): Promise<RateLimitDecision>;
};

function executionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  } as unknown as ExecutionContext;
}

function withAgentLimiter(limiter: RateLimiter): Cloudflare.Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      return property === "AGENT_RATE_LIMITER" ? limiter : Reflect.get(target, property, receiver);
    },
  });
}

function chatRequestFrame(requestId: string, messageId: string): string {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id: requestId,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [{ id: messageId, role: "user", parts: [{ type: "text", text: "Rate limit me." }] }],
        trigger: "submit-message",
        name: "rate-limit-test",
        clientTools: [],
      }),
    },
  });
}

function testConnection(frames: string[], closes: Array<{ code?: number; reason?: string }>): Connection {
  return {
    id: crypto.randomUUID(),
    server: "test",
    state: {
      glideAccessLeaseId: crypto.randomUUID(),
      glideAccessEmail: "rate-limit-test@cloudflare.com",
      glideAccessSubjectDigest: `access-subject:${"a".repeat(64)}`,
      glideAccessExpiresAt: Math.floor(Date.now() / 1_000) + 300,
      glideClientRateLimitKey: "client:test",
    },
    setState() {},
    send(frame: string | ArrayBuffer) {
      if (typeof frame === "string") frames.push(frame);
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
  } as unknown as Connection;
}

describe("production rate limits", () => {
  it.each(["/agents/glide-agent/room", "//agents/glide-agent/room"])(
    "returns a retryable 429 before routing an exhausted Agent request at %s",
    async (path) => {
    const response = await worker.fetch(
      new Request(`https://example.com${path}`, {
        headers: {
          "CF-Connecting-IP": "203.0.113.20",
          Origin: "https://example.com",
          Upgrade: "websocket",
        },
      }),
      withAgentLimiter({ limit: async () => ({ success: false }) }),
      executionContext(),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({ code: "rate_limit_exceeded" });
    },
  );

  it("fails closed with 503 when dynamic abuse protection is unavailable", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/agents/glide-agent/room", {
        headers: {
          "CF-Connecting-IP": "203.0.113.21",
          Origin: "https://example.com",
          Upgrade: "websocket",
        },
      }),
      withAgentLimiter({ limit: async () => { throw new Error("unavailable"); } }),
      executionContext(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("10");
    await expect(response.json()).resolves.toMatchObject({ code: "rate_limit_unavailable" });
  });

  it("closes an over-limit protocol connection before dispatching its RPC", async () => {
    const room = `protocol-rate-limit-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    const result = await runInDurableObject(stub, async (agent: GlideAgent) => {
      await agent.activateRoomAccess({
        email: "rate-limit-test@cloudflare.com",
        subject: "rate-limit-test-subject",
        expiresAt: Math.floor(Date.now() / 1_000) + 300,
      }, true);
      (agent as unknown as RateLimitHook).checkRateLimit = async (_limiter, key) =>
        key.startsWith("protocol:") ? "limited" : "allowed";
      const frames: string[] = [];
      const closes: Array<{ code?: number; reason?: string }> = [];
      await agent.onMessage(
        testConnection(frames, closes),
        JSON.stringify({ type: "rpc", id: "rpc-1", method: "startOnboarding", args: ["test"] }),
      );
      return { frames, closes, active: agent.state.onboarding?.active ?? false };
    });

    expect(result.frames).toEqual([]);
    expect(result.closes).toEqual([{ code: 1013, reason: "Rate limit exceeded; retry later" }]);
    expect(result.active).toBe(false);
  });

  for (const blockedScope of ["chat-client", "chat-room"] as const) {
    it(`rejects a ${blockedScope} limit before persisting the user turn`, async () => {
      const room = `${blockedScope}-rate-limit-${crypto.randomUUID()}`;
      const stub = await getAgentByName(env.GlideAgent, room);
      const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
        await agent.activateRoomAccess({
          email: "rate-limit-test@cloudflare.com",
          subject: "rate-limit-test-subject",
          expiresAt: Math.floor(Date.now() / 1_000) + 300,
        }, true);
        const checkedKeys: string[] = [];
        (agent as unknown as RateLimitHook).checkRateLimit = async (_limiter, key) => {
          checkedKeys.push(key);
          return key.startsWith(`${blockedScope}:`) ? "limited" : "allowed";
        };
        const frames: string[] = [];
        await agent.onMessage(
          testConnection(frames, []),
          chatRequestFrame("chat-1", "user-1"),
        );
        return {
          checkedKeys,
          response: JSON.parse(frames[0] ?? "null") as { body?: string; error?: boolean; id?: string },
          messages: state.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
          ).one().count,
          accepted: state.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM glide_accepted_user_message_ids",
          ).one().count,
        };
      });

      expect(result.checkedKeys[0]).toMatch(/^protocol:/);
      expect(result.checkedKeys.some((key) => key.startsWith(`${blockedScope}:`))).toBe(true);
      expect(result.response).toMatchObject({
        body: "Too many chat messages were sent. Wait about a minute and try again.",
        error: true,
        id: "chat-1",
      });
      expect(result.messages).toBe(0);
      expect(result.accepted).toBe(0);
    });
  }

  it("rejects every expensive callable before mutating room state", async () => {
    const room = `expensive-rate-limit-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    const result = await runInDurableObject(stub, async (agent: GlideAgent) => {
      await agent.activateRoomAccess({
        email: "rate-limit-test@cloudflare.com",
        subject: "rate-limit-test-subject",
        expiresAt: Math.floor(Date.now() / 1_000) + 300,
      }, true);
      agent.setState({
        ...agent.state,
        guidance: [{
          id: "keep-me",
          title: "Existing guidance",
          body: "This must survive a rejected delete.",
          enabled: true,
          updatedBy: "rate-limit-test@cloudflare.com",
          ts: Date.now(),
        }],
      });
      const checkedKeys: string[] = [];
      (agent as unknown as RateLimitHook).checkRateLimit = async (_limiter, key) => {
        checkedKeys.push(key);
        return key.startsWith("chat-client:") ? "limited" : "allowed";
      };
      const frames: string[] = [];
      const connection = testConnection(frames, []);
      const calls = [
        ["retryInterruptedResponse", ["missing-message"]],
        ["upsertGuidanceDoc", [{ title: "Rejected guidance", body: "Do not save" }, "forged actor"]],
        ["deleteGuidanceDoc", ["keep-me"]],
        ["reindexGuidance", []],
      ] as const;
      for (const [index, [method, args]] of calls.entries()) {
        await agent.onMessage(
          connection,
          JSON.stringify({ type: "rpc", id: `rpc-${index}`, method, args }),
        );
      }
      return {
        checkedKeys,
        frames: frames.map((frame) => JSON.parse(frame) as {
          success?: boolean;
          result?: { ok?: boolean; message?: string };
        }),
        guidance: agent.state.guidance,
      };
    });

    expect(result.checkedKeys.filter((key) => key.startsWith("protocol:"))).toHaveLength(4);
    expect(result.checkedKeys.filter((key) => key.startsWith("chat-client:"))).toHaveLength(4);
    expect(result.frames).toHaveLength(4);
    for (const frame of result.frames) {
      expect(frame).toMatchObject({
        success: true,
        result: {
          ok: false,
          message: "Too many expensive room operations were requested. Wait about a minute and try again.",
        },
      });
    }
    expect(result.guidance?.map((doc) => doc.id)).toEqual(["keep-me"]);
  });
});
