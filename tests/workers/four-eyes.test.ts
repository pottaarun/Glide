import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { GlideAgent } from "../../src/server";
import { roomStorageName, type ActionResult, type PendingAction, type RoomAuditEntry } from "../../src/shared";
import { asAccessUser } from "./access-test-helpers";

const OWNER = "owner@cloudflare.com";
const MEMBER = "member@example.com";
const VIEWER = "viewer@example.com";
const ZONE = "a".repeat(32);

type ApproveResult = {
  ok: boolean;
  message: string;
  applied: boolean;
  approvals: number;
  required: number;
  result?: ActionResult;
};
type ToggleResult = { ok: boolean; message: string; enabled: boolean };
type InviteResult = { ok: boolean; message: string };

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

/** Seed a pending action directly into the room's synced state (server source). */
async function seedPending(room: string, action: PendingAction): Promise<void> {
  const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
  await runInDurableObject(stub, (agent: GlideAgent) => {
    agent.setState({ ...agent.state, pendingActions: [...agent.state.pendingActions, action] });
  });
}

function pending(id: string, over: Partial<PendingAction> = {}): PendingAction {
  return {
    id,
    product: "DNS",
    summary: "Delete a DNS record",
    method: "DELETE",
    path: `/zones/${ZONE}/dns_records/${"b".repeat(32)}`,
    createdBy: OWNER,
    ts: Date.now(),
    ...over,
  };
}

async function setupRoom(room: string): Promise<void> {
  expect((await roomAccess(OWNER, room)).status).toBe(200);
  expect((await rpcAs<InviteResult>(OWNER, room, "inviteTeammate", [MEMBER, OWNER])).ok).toBe(true);
  expect(
    (await rpcAs<InviteResult>(OWNER, room, "inviteTeammate", [VIEWER, OWNER, undefined, "viewer"])).ok,
  ).toBe(true);
}

describe("four-eyes (dual-approval) change control", () => {
  it("lets only the owner toggle the policy", async () => {
    const room = `four-eyes-toggle-${crypto.randomUUID()}`;
    await setupRoom(room);

    const asMember = await rpcAs<ToggleResult>(MEMBER, room, "setFourEyes", [true, MEMBER]);
    expect(asMember.ok).toBe(false);
    expect(asMember.message).toMatch(/owner/i);

    const asOwner = await rpcAs<ToggleResult>(OWNER, room, "setFourEyes", [true, OWNER]);
    expect(asOwner.ok).toBe(true);
    expect(asOwner.enabled).toBe(true);
  });

  it("requires two distinct approvers before a risky change applies", async () => {
    const room = `four-eyes-flow-${crypto.randomUUID()}`;
    await setupRoom(room);
    expect((await rpcAs<ToggleResult>(OWNER, room, "setFourEyes", [true, OWNER])).enabled).toBe(true);
    await seedPending(room, pending("act-risky"));

    // A single member cannot apply a gated change directly — the gate refuses
    // before any write, telling them to use Approve.
    const blocked = await rpcAs<ActionResult>(MEMBER, room, "applyAction", ["act-risky", MEMBER]);
    expect(blocked.status).toBe("failed");
    expect(blocked.detail).toMatch(/approv/i);

    // First approval records but does not apply.
    const first = await rpcAs<ApproveResult>(MEMBER, room, "approveAction", ["act-risky", MEMBER]);
    expect(first.applied).toBe(false);
    expect(first.approvals).toBe(1);
    expect(first.required).toBe(2);

    // The same member approving again is a no-op (deduped by verified email).
    const dup = await rpcAs<ApproveResult>(MEMBER, room, "approveAction", ["act-risky", MEMBER]);
    expect(dup.applied).toBe(false);
    expect(dup.approvals).toBe(1);
    expect(dup.message).toMatch(/already/i);

    // A viewer cannot approve at all.
    await expect(rpcAs(VIEWER, room, "approveAction", ["act-risky", VIEWER])).rejects.toThrow(/read-only|viewer/i);

    // The second DISTINCT approver satisfies the gate: the apply is attempted
    // (and here fails only because no token is configured — proving the gate was
    // passed, not that approvals were still missing).
    const second = await rpcAs<ApproveResult>(OWNER, room, "approveAction", ["act-risky", OWNER]);
    expect(second.approvals).toBe(2);
    expect(second.required).toBe(2);
    const finalDetail = second.result?.detail ?? second.message;
    expect(finalDetail).not.toMatch(/Use Approve/i);
    expect(finalDetail).toMatch(/token/i);
  });

  it("does not gate routine low-risk changes", async () => {
    const room = `four-eyes-lowrisk-${crypto.randomUUID()}`;
    await setupRoom(room);
    expect((await rpcAs<ToggleResult>(OWNER, room, "setFourEyes", [true, OWNER])).enabled).toBe(true);
    await seedPending(
      room,
      pending("act-routine", {
        product: "SSL/TLS",
        summary: "Enable Always Use HTTPS",
        method: "PATCH",
        path: `/zones/${ZONE}/settings/always_use_https`,
        body: { value: "on" },
      }),
    );

    // A low-risk change is not gated: a single member's apply goes straight to
    // the write (failing here only on the missing token, not the approval gate).
    const applied = await rpcAs<ActionResult>(MEMBER, room, "applyAction", ["act-routine", MEMBER]);
    expect(applied.status).toBe("failed");
    expect(applied.detail).not.toMatch(/approv/i);
    expect(applied.detail).toMatch(/token/i);
  });

  it("audits policy changes and approvals for the owner", async () => {
    const room = `four-eyes-audit-${crypto.randomUUID()}`;
    await setupRoom(room);
    expect((await rpcAs<ToggleResult>(OWNER, room, "setFourEyes", [true, OWNER])).enabled).toBe(true);
    await seedPending(room, pending("act-audit"));
    await rpcAs<ApproveResult>(MEMBER, room, "approveAction", ["act-audit", MEMBER]);

    const log = await rpcAs<RoomAuditEntry[]>(OWNER, room, "getAuditLog", [100]);
    const actions = log.map((e) => e.action);
    expect(actions).toContain("four_eyes");
    expect(actions).toContain("approve");
  });
});
