import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { GlideAgent } from "../../src/server";
import { roomStorageName, type RoomAccessStatus, type RoomAuditEntry } from "../../src/shared";
import { asAccessUser } from "./access-test-helpers";

const OWNER = "owner@cloudflare.com";
const MEMBER = "member@example.com";
const VIEWER = "viewer@example.com";
const TOKEN = "cfat_abcdefghijklmnopqrstuvwxyz";

function requiredStorageRoom(room: string): string {
  const storageRoom = roomStorageName(room);
  if (!storageRoom) throw new Error(`Invalid test room: ${room}`);
  return storageRoom;
}

function agentUrl(room: string): string {
  return `https://example.com/agents/glide-agent/${requiredStorageRoom(room)}`;
}

async function roomAccess(email: string, room: string, intent?: "inspect"): Promise<Response> {
  return asAccessUser(email, (headers) => {
    headers.set("Origin", "https://example.com");
    const intentQuery = intent ? `&intent=${intent}` : "";
    return exports.default.fetch(
      new Request(`https://example.com/api/room-access?room=${encodeURIComponent(room)}${intentQuery}`, {
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

type InviteResult = { ok: boolean; message: string; members?: RoomAccessStatus["members"] };

async function createRoomWithViewer(room: string): Promise<void> {
  expect((await roomAccess(OWNER, room)).status).toBe(200);
  const invite = await rpcAs<InviteResult>(OWNER, room, "inviteTeammate", [
    VIEWER,
    OWNER,
    `https://example.com/#${room}`,
    "viewer",
  ]);
  expect(invite.ok).toBe(true);
}

describe("per-room RBAC (viewer role)", () => {
  it("lets an owner invite a read-only viewer", async () => {
    const room = `rbac-viewer-${crypto.randomUUID()}`;
    await createRoomWithViewer(room);

    const viewerAccess = await roomAccess(VIEWER, room);
    expect(viewerAccess.status).toBe(200);
    await expect(viewerAccess.json()).resolves.toMatchObject({
      email: VIEWER,
      role: "viewer",
      entry: "member",
    });
  });

  it("blocks viewers from every commit action", async () => {
    const room = `rbac-block-${crypto.randomUUID()}`;
    await createRoomWithViewer(room);

    await expect(rpcAs(VIEWER, room, "applyAction", ["missing", VIEWER])).rejects.toThrow(/read-only|viewer/i);
    await expect(rpcAs(VIEWER, room, "applyAll", [["missing"], VIEWER])).rejects.toThrow(/read-only|viewer/i);
    await expect(rpcAs(VIEWER, room, "rejectAction", ["missing", VIEWER])).rejects.toThrow(/read-only|viewer/i);
    await expect(rpcAs(VIEWER, room, "setRoomName", ["Nope", VIEWER])).rejects.toThrow(/read-only|viewer/i);
    await expect(rpcAs(VIEWER, room, "setCloudflareToken", [TOKEN])).rejects.toThrow(/read-only|viewer/i);

    // inviteTeammate returns a soft failure (resolved RPC) rather than throwing.
    const invite = await rpcAs<InviteResult>(VIEWER, room, "inviteTeammate", ["x@example.com", VIEWER]);
    expect(invite.ok).toBe(false);
    expect(invite.message).toMatch(/viewer|read-only/i);
  });

  it("still lets a viewer read room state (roomAccessStatus)", async () => {
    const room = `rbac-read-${crypto.randomUUID()}`;
    await createRoomWithViewer(room);
    const status = await rpcAs<RoomAccessStatus>(VIEWER, room, "roomAccessStatus", []);
    expect(status).toMatchObject({ email: VIEWER, role: "viewer" });
  });

  it("only lets the owner change roles, and never the owner's own role", async () => {
    const room = `rbac-roles-${crypto.randomUUID()}`;
    expect((await roomAccess(OWNER, room)).status).toBe(200);
    expect((await rpcAs<InviteResult>(OWNER, room, "inviteTeammate", [MEMBER, OWNER])).ok).toBe(true);

    // A non-owner member cannot change roles.
    const memberAttempt = await rpcAs<InviteResult>(MEMBER, room, "setMemberRole", [MEMBER, "viewer"]);
    expect(memberAttempt.ok).toBe(false);
    expect(memberAttempt.message).toMatch(/owner/i);

    // The owner downgrades the member to viewer, then restores membership.
    const down = await rpcAs<InviteResult>(OWNER, room, "setMemberRole", [MEMBER, "viewer"]);
    expect(down.ok).toBe(true);
    expect(down.members?.find((m) => m.email === MEMBER)?.role).toBe("viewer");
    await expect((await roomAccess(MEMBER, room)).json()).resolves.toMatchObject({ role: "viewer" });

    const up = await rpcAs<InviteResult>(OWNER, room, "setMemberRole", [MEMBER, "member"]);
    expect(up.ok).toBe(true);
    expect(up.members?.find((m) => m.email === MEMBER)?.role).toBe("member");

    // The owner's own role is immutable.
    const ownerImmutable = await rpcAs<InviteResult>(OWNER, room, "setMemberRole", [OWNER, "viewer"]);
    expect(ownerImmutable.ok).toBe(false);
  });

  it("lets members invite members but reserves viewer grants for the owner", async () => {
    const room = `rbac-invite-${crypto.randomUUID()}`;
    expect((await roomAccess(OWNER, room)).status).toBe(200);
    expect((await rpcAs<InviteResult>(OWNER, room, "inviteTeammate", [MEMBER, OWNER])).ok).toBe(true);

    // A member may invite another member (default role).
    const asMember = await rpcAs<InviteResult>(MEMBER, room, "inviteTeammate", ["m2@example.com", MEMBER]);
    expect(asMember.ok).toBe(true);
    expect(asMember.members?.find((m) => m.email === "m2@example.com")?.role).toBe("member");

    // But a member cannot grant the read-only viewer role.
    const asViewer = await rpcAs<InviteResult>(MEMBER, room, "inviteTeammate", [
      "v2@example.com",
      MEMBER,
      undefined,
      "viewer",
    ]);
    expect(asViewer.ok).toBe(false);
    expect(asViewer.message).toMatch(/owner/i);
  });
});

describe("room audit trail", () => {
  it("records governance events and is readable only by the owner", async () => {
    const room = `audit-${crypto.randomUUID()}`;
    expect((await roomAccess(OWNER, room)).status).toBe(200);
    expect((await rpcAs<InviteResult>(OWNER, room, "inviteTeammate", [MEMBER, OWNER])).ok).toBe(true);
    expect((await rpcAs<{ ok: boolean }>(OWNER, room, "setRoomName", ["Acme Corp", OWNER])).ok).toBe(true);
    expect((await rpcAs<InviteResult>(OWNER, room, "setMemberRole", [MEMBER, "viewer"])).ok).toBe(true);

    // Non-owners cannot read the audit log.
    await expect(rpcAs(MEMBER, room, "getAuditLog", [])).rejects.toThrow(/owner/i);

    const log = await rpcAs<RoomAuditEntry[]>(OWNER, room, "getAuditLog", [100]);
    const actions = log.map((e) => e.action);
    expect(actions).toContain("invite");
    expect(actions).toContain("rename");
    expect(actions).toContain("role_change");
    // Every entry is attributed and time-stamped; newest first.
    expect(log[0]?.actor).toBe(OWNER);
    expect(log.every((e) => typeof e.ts === "number" && e.ts > 0)).toBe(true);
    for (let i = 1; i < log.length; i++) expect(log[i - 1]!.ts).toBeGreaterThanOrEqual(log[i]!.ts);
  });
});

describe("viewer-role storage migration", () => {
  it("accepts viewer invites in rooms whose members table predates the role", async () => {
    const room = `rbac-migrate-${crypto.randomUUID()}`;
    expect((await roomAccess(OWNER, room)).status).toBe(200);

    // Simulate a pre-viewer schema: rebuild the members table with the old CHECK.
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec("ALTER TABLE glide_room_members RENAME TO glide_room_members_old_test");
      state.storage.sql.exec(`CREATE TABLE glide_room_members (
        email      TEXT PRIMARY KEY COLLATE NOCASE,
        role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        invited_by TEXT,
        joined_at  INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        "INSERT INTO glide_room_members SELECT * FROM glide_room_members_old_test",
      );
      state.storage.sql.exec("DROP TABLE glide_room_members_old_test");
      // Confirm the constraint really rejects 'viewer' before the migration runs.
      expect(() =>
        state.storage.sql.exec(
          "INSERT INTO glide_room_members (email, role, invited_by, joined_at) VALUES ('probe@example.com','viewer',NULL,1)",
        ),
      ).toThrow();
    });

    // Evict so the next access reconstructs the DO and runs the schema migration.
    await evictDurableObject(stub);

    const invite = await rpcAs<InviteResult>(OWNER, room, "inviteTeammate", [
      VIEWER,
      OWNER,
      undefined,
      "viewer",
    ]);
    expect(invite.ok).toBe(true);
    expect(invite.members?.find((m) => m.email === VIEWER)?.role).toBe("viewer");
  });
});
