import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

import { MAX_ROOM_NAME_CHARS, ROOM_DELETE_CONFIRMATION, type RoomSummary } from "../../src/shared";
import { asAccessUser } from "./access-test-helpers";

// Mirrors the (unexported) REGISTRY_SYSTEM_ROOM constant in src/server.ts.
const REGISTRY_SYSTEM_ROOM = "__registry__";

const EMPLOYEE = "registry-admin@cloudflare.com";
const GUEST = "guest@example.com";

type RpcReply = {
  type: string;
  id: string;
  success?: boolean;
  result?: { ok?: boolean; message?: string; roomName?: string };
};

/** Send one callable RPC frame over an accepted socket and await its reply. */
function callRpcOverSocket(
  socket: WebSocket,
  id: string,
  method: string,
  args: unknown[],
): Promise<RpcReply> {
  const reply = new Promise<RpcReply>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as RpcReply;
      if (message.type === "rpc" && message.id === id) resolve(message);
    });
  });
  socket.send(JSON.stringify({ type: "rpc", id, method, args }));
  return reply;
}

/** Activate room access for `email`, then open + accept an agent socket. */
async function openRoomSocket(email: string, room: string): Promise<WebSocket> {
  const access = await asAccessUser(email, (headers) =>
    exports.default.fetch(new Request(
      `https://example.com/api/room-access?room=${encodeURIComponent(room)}`,
      { headers, method: "POST" },
    )));
  expect(access.status).toBe(200);

  const response = await asAccessUser(email, async (headers) => {
    headers.set("Upgrade", "websocket");
    return exports.default.fetch(
      new Request(`https://example.com/agents/glide-agent/${room}`, { headers }),
    );
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  socket!.accept();
  return socket!;
}

function closeQuietly(socket: WebSocket): void {
  try {
    socket.close(1000, "done");
  } catch {
    /* The socket may already be gone (e.g. after a room-destroy abort). */
  }
}

/**
 * Poll GET /api/rooms until `roomId` reports the expected name. Registry sync
 * from setRoomName is fire-and-forget (waitUntil), so it is eventually — not
 * immediately — consistent after the RPC returns.
 */
async function waitForRegistryName(
  email: string,
  roomId: string,
  attempts = 25,
): Promise<string | undefined> {
  for (let i = 0; i < attempts; i++) {
    const response = await asAccessUser(email, (headers) =>
      exports.default.fetch(new Request("https://example.com/api/rooms", { headers })));
    if (response.status === 200) {
      const body = await response.json() as { rooms: RoomSummary[] };
      const name = body.rooms.find((r) => r.id === roomId)?.name;
      if (name) return name;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

describe("room registry DO RPC", () => {
  it("upserts, lists, and removes room entries on the registry instance", async () => {
    const registry = await getAgentByName(env.GlideAgent, REGISTRY_SYSTEM_ROOM);
    const id = `reg-${crypto.randomUUID()}`;
    const now = Date.now();
    const entry: RoomSummary = {
      id,
      name: "Registry Test Room",
      owner: EMPLOYEE,
      memberCount: 3,
      createdAt: now,
      lastActiveAt: now,
    };

    await registry.upsertRoomRegistryEntry(entry);
    const listed = await registry.listRoomRegistry();
    const found = listed.find((r) => r.id === id);
    expect(found).toMatchObject({
      id,
      name: "Registry Test Room",
      owner: EMPLOYEE,
      memberCount: 3,
    });

    await registry.removeRoomRegistryEntry(id);
    const afterRemoval = await registry.listRoomRegistry();
    expect(afterRemoval.some((r) => r.id === id)).toBe(false);
  });

  it("is inert when registry RPC is invoked on a normal room instance", async () => {
    const stray = await getAgentByName(env.GlideAgent, `guard-${crypto.randomUUID()}`);
    const strayId = `ghost-${crypto.randomUUID()}`;
    const now = Date.now();
    await stray.upsertRoomRegistryEntry({
      id: strayId,
      memberCount: 1,
      createdAt: now,
      lastActiveAt: now,
    });

    // The guard makes both the write and the read inert on non-registry rooms.
    expect(await stray.listRoomRegistry()).toEqual([]);

    const registry = await getAgentByName(env.GlideAgent, REGISTRY_SYSTEM_ROOM);
    const listed = await registry.listRoomRegistry();
    expect(listed.some((r) => r.id === strayId)).toBe(false);
  });
});

describe("GET /api/rooms", () => {
  it("rejects non-GET methods", async () => {
    const response = await asAccessUser(EMPLOYEE, (headers) =>
      exports.default.fetch(new Request("https://example.com/api/rooms", { headers, method: "POST" })));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  it("rejects cross-origin requests before authentication", async () => {
    const response = await asAccessUser(EMPLOYEE, (headers) => {
      headers.set("Origin", "https://evil.example");
      return exports.default.fetch(new Request("https://example.com/api/rooms", { headers }));
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "invalid_origin" });
  });

  it("forbids non-Cloudflare employees", async () => {
    const response = await asAccessUser(GUEST, (headers) =>
      exports.default.fetch(new Request("https://example.com/api/rooms", { headers })));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  it("returns the registry listing for verified employees", async () => {
    const registry = await getAgentByName(env.GlideAgent, REGISTRY_SYSTEM_ROOM);
    const seededId = `api-${crypto.randomUUID()}`;
    const now = Date.now();
    await registry.upsertRoomRegistryEntry({
      id: seededId,
      name: "Listed Room",
      owner: EMPLOYEE,
      memberCount: 2,
      createdAt: now,
      lastActiveAt: now,
    });

    const response = await asAccessUser(EMPLOYEE, (headers) =>
      exports.default.fetch(new Request("https://example.com/api/rooms", { headers })));
    expect(response.status).toBe(200);
    const body = await response.json() as { rooms: RoomSummary[] };
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.some((r) => r.id === seededId && r.name === "Listed Room")).toBe(true);
  });
});

describe("destroyRoom (owner-gated)", () => {
  it("refuses the owner without the exact confirmation phrase", async () => {
    const room = `del-${crypto.randomUUID()}`;
    const owner = `owner-${crypto.randomUUID()}@cloudflare.com`;
    const socket = await openRoomSocket(owner, room);
    const reply = await callRpcOverSocket(socket, "destroy-1", "destroyRoom", ["delete this room"]);
    expect(reply.success).toBe(true);
    expect(reply.result?.ok).toBe(false);
    expect(reply.result?.message).toContain(ROOM_DELETE_CONFIRMATION);
    closeQuietly(socket);
  });

  it("refuses a non-owner member even with the correct phrase", async () => {
    const room = `del-${crypto.randomUUID()}`;
    const owner = `owner-${crypto.randomUUID()}@cloudflare.com`;
    const member = `member-${crypto.randomUUID()}@cloudflare.com`;

    const ownerSocket = await openRoomSocket(owner, room);
    const invite = await callRpcOverSocket(ownerSocket, "invite-1", "inviteTeammate", [member, "Owner"]);
    expect(invite.result?.ok).toBe(true);
    closeQuietly(ownerSocket);

    const memberSocket = await openRoomSocket(member, room);
    const reply = await callRpcOverSocket(
      memberSocket,
      "destroy-1",
      "destroyRoom",
      [ROOM_DELETE_CONFIRMATION],
    );
    expect(reply.success).toBe(true);
    expect(reply.result?.ok).toBe(false);
    expect(reply.result?.message).toContain("owner");
    closeQuietly(memberSocket);
  });

  it("lets the owner delete with the correct phrase and denies access afterward", async () => {
    const room = `del-${crypto.randomUUID()}`;
    const owner = `owner-${crypto.randomUUID()}@cloudflare.com`;

    const socket = await openRoomSocket(owner, room);
    const reply = await callRpcOverSocket(
      socket,
      "destroy-1",
      "destroyRoom",
      [ROOM_DELETE_CONFIRMATION],
    );
    expect(reply.success).toBe(true);
    expect(reply.result?.ok).toBe(true);
    closeQuietly(socket);

    // Storage was wiped, so even the former owner can no longer inspect the room.
    const inspect = await asAccessUser(owner, (headers) =>
      exports.default.fetch(new Request(
        `https://example.com/api/room-access?room=${encodeURIComponent(room)}&intent=inspect`,
        { headers, method: "POST" },
      )));
    expect(inspect.status).toBe(403);
  });
});

describe("setRoomName (room naming)", () => {
  it("lets a member set the display name and propagates it to the registry", async () => {
    const room = `name-${crypto.randomUUID()}`;
    const owner = `owner-${crypto.randomUUID()}@cloudflare.com`;

    const socket = await openRoomSocket(owner, room);
    const reply = await callRpcOverSocket(socket, "name-1", "setRoomName", ["  Acme   Corp  "]);
    expect(reply.success).toBe(true);
    // Whitespace is collapsed and trimmed by normalizeRoomName.
    expect(reply.result).toMatchObject({ ok: true, roomName: "Acme Corp" });
    closeQuietly(socket);

    expect(await waitForRegistryName(owner, room)).toBe("Acme Corp");
  });

  it("clears the name when given a blank value", async () => {
    const room = `name-${crypto.randomUUID()}`;
    const owner = `owner-${crypto.randomUUID()}@cloudflare.com`;

    const socket = await openRoomSocket(owner, room);
    const set = await callRpcOverSocket(socket, "name-1", "setRoomName", ["Temporary"]);
    expect(set.result).toMatchObject({ ok: true, roomName: "Temporary" });

    const cleared = await callRpcOverSocket(socket, "name-2", "setRoomName", ["   "]);
    expect(cleared.success).toBe(true);
    expect(cleared.result?.ok).toBe(true);
    // An empty result clears the name, so no roomName is echoed back.
    expect(cleared.result?.roomName).toBeUndefined();
    closeQuietly(socket);
  });

  it("caps an over-long name at MAX_ROOM_NAME_CHARS", async () => {
    const room = `name-${crypto.randomUUID()}`;
    const owner = `owner-${crypto.randomUUID()}@cloudflare.com`;

    const socket = await openRoomSocket(owner, room);
    const reply = await callRpcOverSocket(socket, "name-1", "setRoomName", ["z".repeat(100)]);
    expect(reply.result?.ok).toBe(true);
    expect(reply.result?.roomName).toBe("z".repeat(MAX_ROOM_NAME_CHARS));
    closeQuietly(socket);
  });
});
