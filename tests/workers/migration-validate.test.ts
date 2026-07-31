import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { GlideAgent } from "../../src/server";
import { roomStorageName, type MigrationPlan } from "../../src/shared";
import { asAccessUser } from "./access-test-helpers";

const OWNER = "owner@cloudflare.com";
const ZID = "a".repeat(32);
const AID = "c".repeat(32);

function requiredStorageRoom(room: string): string {
  const storageRoom = roomStorageName(room);
  if (!storageRoom) throw new Error(`Invalid test room: ${room}`);
  return storageRoom;
}

function agentUrl(room: string): string {
  return `https://example.com/agents/glide-agent/${requiredStorageRoom(room)}`;
}

async function roomAccess(email: string, room: string): Promise<Response> {
  return asAccessUser(email, (headers) => {
    headers.set("Origin", "https://example.com");
    return exports.default.fetch(
      new Request(`https://example.com/api/room-access?room=${encodeURIComponent(room)}`, {
        headers,
        method: "POST",
      }),
    );
  });
}

async function rpcAs<T>(email: string, room: string, method: string, args: unknown[]): Promise<T> {
  return asAccessUser(email, async (headers) => {
    headers.set("Upgrade", "websocket");
    const response = await exports.default.fetch(new Request(agentUrl(room), { headers }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const id = crypto.randomUUID();
    const reply = new Promise<T>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const value = JSON.parse(event.data) as {
          type?: string;
          id?: string;
          success?: boolean;
          result?: T;
          error?: string;
        };
        if (value.type !== "rpc" || value.id !== id) return;
        if (value.success) resolve(value.result as T);
        else reject(new Error(value.error ?? "RPC failed"));
      });
    });
    socket.send(JSON.stringify({ type: "rpc", id, method, args }));
    try {
      return await reply;
    } finally {
      socket.close(1000, "done");
    }
  });
}

type CheckResult = { ok: boolean; summary: string };

describe("post-migration verification (re-enabled validateConfig)", () => {
  it("runValidate runs the verification path instead of the old disabled stub", async () => {
    const room = `validate-boundary-${crypto.randomUUID()}`;
    expect((await roomAccess(OWNER, room)).status).toBe(200);
    const res = await rpcAs<CheckResult>(OWNER, room, "runValidate", [ZID, OWNER]);
    expect(res.ok).toBe(false);
    // With no migration plan (and the tool unbound), verification reaches a real
    // run-path guard — crucially NOT the old fail-closed "validation is disabled"
    // stub, which returned unconditionally regardless of plan/config state.
    expect(res.summary).toMatch(/isn't configured|no migration plan/i);
    expect(res.summary).not.toMatch(/does not compare complete live rule/i);
  });

  it("reports an honest presence-check summary and records a validate check", async () => {
    const room = `validate-happy-${crypto.randomUUID()}`;
    expect((await roomAccess(OWNER, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const out = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const generation = Reflect.get(agent, "credentialGeneration") as number;
      // Stub the credential lease (no real Cloudflare token needed) and the
      // migration transport (return a report with one missing rule).
      Reflect.set(agent, "getCredentialLease", async () => ({ token: "fake-token", generation }));
      Reflect.set(agent, "migrationTransport", () => ({
        fetcher: {
          fetch: async () =>
            Response.json({
              zoneId: ZID,
              accountId: AID,
              provider: "akamai",
              totalIntended: 2,
              verified: 1,
              missing: 1,
              details: [
                { ruleName: "Block bad bots", ruleType: "waf_custom", status: "VERIFIED" },
                { ruleName: "Rate limit login", ruleType: "ratelimit", status: "MISSING" },
              ],
              timestamp: new Date().toISOString(),
            }),
        },
      }));

      const plan: MigrationPlan = {
        provider: "akamai",
        providerLabel: "Akamai",
        totalRules: 2,
        phases: [{ key: "waf", label: "WAF", count: 2 }],
        rules: [],
        sourceRevision: "rev-1",
        createdBy: "seed",
        ts: Date.now(),
      };
      agent.setState({
        ...agent.state,
        defaultZone: { id: ZID, name: "example.com", accountId: AID },
        migrationPlan: plan,
      });
      // The plan's config source lives server-side (never synced); seed it.
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO glide_migration_src (id, provider, data, ts) VALUES (?, ?, ?, ?)",
        "rev-1",
        "akamai",
        "{}",
        Date.now(),
      );

      const doValidate = Reflect.get(agent, "doValidate") as (
        zoneId: string | undefined,
        by: string,
        isAuthorized: () => boolean,
      ) => Promise<CheckResult>;
      const res = await doValidate.call(agent, ZID, "tester@cloudflare.com", () => true);
      return { res, check: agent.state.migrationCheck };
    });

    // One rule missing → not ok, and the summary is framed as a presence check.
    expect(out.res.ok).toBe(false);
    expect(out.res.summary).toMatch(/1\/2/);
    expect(out.res.summary).toMatch(/MISSING/);
    expect(out.res.summary).toMatch(/presence check/i);
    // The result is persisted as a `validate` check (no longer purged on load).
    expect(out.check?.kind).toBe("validate");
    expect(out.check?.ok).toBe(false);
    expect(out.check?.zoneId).toBe(ZID);
  });
});
