import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { getAgentByName, type Connection } from "agents";
import { describe, expect, it } from "vitest";

import { MAX_CHAT_PROTOCOL_BYTES } from "../../src/chat-delivery";
import worker, { type GlideAgent } from "../../src/server";
import {
  LEGACY_CHAT_RECOVERY_CONFIRMATION,
  roomStorageName,
  type MigrationPlan,
  type PendingAction,
  type RoomAccessStatus,
} from "../../src/shared";
import { asAccessUser } from "./access-test-helpers";

const TOKEN_A = "cfat_abcdefghijklmnopqrstuvwxyz";
const TOKEN_B = "cfat_zyxwvutsrqponmlkjihgfedcba";

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

async function flushFreshRoomCleanup(room: string): Promise<void> {
  const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
  const pending = await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
    const count = state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM cf_agents_schedules WHERE callback = ?",
      "destroyFreshDeniedRoomIfUnused",
    ).toArray()[0]?.count ?? 0;
    if (count > 0) {
      state.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = 0 WHERE callback = ?",
        "destroyFreshDeniedRoomIfUnused",
      );
    }
    return count;
  });
  if (pending === 0) return;
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

async function roomHadSchemaBeforeWake(room: string): Promise<boolean> {
  await flushFreshRoomCleanup(room);
  const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
  const hadSchema = await runInDurableObject(stub, async (agent: GlideAgent) =>
    (agent as unknown as { storageHadSchemaAtConstruction: boolean }).storageHadSchemaAtConstruction
  );
  if (!hadSchema) {
    await stub.authorizeRoomAccess({
      email: "storage-probe@example.com",
      subject: "storage-probe",
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    });
    await flushFreshRoomCleanup(room);
  }
  return hadSchema;
}

async function rpcAs<T>(
  email: string,
  room: string,
  method: string,
  args: unknown[],
  mutateHeaders?: (headers: Headers) => void,
): Promise<T> {
  return asAccessUser(email, async (headers) => {
    headers.set("Upgrade", "websocket");
    mutateHeaders?.(headers);
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

async function openAgentSocket(email: string, room: string, connectionId?: string): Promise<WebSocket> {
  const response = await asAccessUser(email, (headers) => {
    headers.set("Upgrade", "websocket");
    const query = connectionId ? `?_pk=${encodeURIComponent(connectionId)}` : "";
    return exports.default.fetch(new Request(`${agentUrl(room)}${query}`, { headers }));
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}

function accessLeaseForConnection(connection: Connection): {
  connectionId: string;
  leaseId: string;
  email: string;
  expiresAt: number;
} {
  const state = connection.state as {
    glideAccessLeaseId?: unknown;
    glideAccessEmail?: unknown;
    glideAccessExpiresAt?: unknown;
  } | null;
  if (
    typeof state?.glideAccessLeaseId !== "string" ||
    typeof state.glideAccessEmail !== "string" ||
    typeof state.glideAccessExpiresAt !== "number"
  ) throw new Error("Expected a complete connection access lease");
  return {
    connectionId: connection.id,
    leaseId: state.glideAccessLeaseId,
    email: state.glideAccessEmail,
    expiresAt: state.glideAccessExpiresAt,
  };
}

async function saveRoomToken(room: string, token: string): Promise<void> {
  const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
  const result = await runInDurableObject(stub, async (agent: GlideAgent) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ success: true, result: { status: "active" } })) as typeof fetch;
    try {
      return await agent.setCloudflareToken(token);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  expect(result).toMatchObject({ ok: true });
}

function protocolConnection(
  email: string,
  expiresAt: number,
  frames: string[],
  closes: Array<{ code?: number; reason?: string }>,
): Connection {
  return {
    id: crypto.randomUUID(),
    server: "test",
    state: {
      glideAccessEmail: email,
      glideAccessSubjectDigest: `access-subject:${"a".repeat(64)}`,
      glideAccessExpiresAt: expiresAt,
      glideClientRateLimitKey: `client:${"a".repeat(64)}`,
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

describe("Cloudflare Access authentication", () => {
  it("requires a same-origin POST and canonical room id before activating a room", async () => {
    const room = `route-contract-${crypto.randomUUID()}`;
    const url = `https://example.com/api/room-access?room=${encodeURIComponent(room)}`;

    const getResponse = await exports.default.fetch(new Request(url));
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");

    const crossOrigin = await exports.default.fetch(new Request(url, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    }));
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ code: "invalid_origin" });

    const invalidRoom = "a".repeat(201);
    const invalid = await exports.default.fetch(new Request(
      `https://example.com/api/room-access?room=${encodeURIComponent(invalidRoom)}`,
      { method: "POST", headers: { Origin: "https://example.com" } },
    ));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_room" });
    const id = env.GlideAgent.idFromName(invalidRoom);
    expect((await listDurableObjectIds(env.GlideAgent)).some((candidate) => candidate.equals(id))).toBe(false);
  });

  it("rejects missing identity and ignores spoofed internal headers before creating a room", async () => {
    const room = `auth-missing-${crypto.randomUUID()}`;
    const response = await exports.default.fetch(
      new Request(agentUrl(room), {
        headers: {
          Origin: "https://example.com",
          Upgrade: "websocket",
          "X-Glide-Access-Email": "spoofed@cloudflare.com",
          "X-Glide-Access-Subject": "spoofed",
          "X-Glide-Access-Expiry": String(Math.floor(Date.now() / 1_000) + 300),
        },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "access_token_missing" });
    const id = env.GlideAgent.idFromName(room);
    expect((await listDurableObjectIds(env.GlideAgent)).some((candidate) => candidate.equals(id))).toBe(false);
  });

  it("returns only the verified Access identity from the session endpoint", async () => {
    const response = await asAccessUser("Employee@Cloudflare.com", (headers) => {
      headers.set("X-Glide-Access-Email", "spoofed@example.com");
      headers.set("X-Glide-Access-Subject", "spoofed-subject");
      headers.set("X-Glide-Access-Expiry", "1");
      return exports.default.fetch(new Request("https://example.com/api/session", { headers }));
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      email: "employee@cloudflare.com",
      isEmployee: true,
    });
  });

  it("does not activate a room through Agent routing", async () => {
    const room = `explicit-activation-${crypto.randomUUID()}`;
    const routed = await asAccessUser("owner@cloudflare.com", (headers) => {
      headers.set("Upgrade", "websocket");
      return exports.default.fetch(new Request(agentUrl(room), { headers }));
    });
    expect(routed.status).toBe(403);
    expect(routed.webSocket).toBeNull();
    await expect(routed.json()).resolves.toMatchObject({ code: "room_membership_required" });
    expect(await roomHadSchemaBeforeWake(room)).toBe(false);

    const activated = await roomAccess("owner@cloudflare.com", room);
    expect(activated.status).toBe(200);
    await expect(activated.json()).resolves.toMatchObject({ entry: "created", role: "owner" });
    await expect(rpcAs<RoomAccessStatus>("owner@cloudflare.com", room, "roomAccessStatus", []))
      .resolves.toMatchObject({ email: "owner@cloudflare.com", role: "owner" });
  });

  it("keeps admin-style room inspection read-only for new and legacy rooms", async () => {
    const employee = "inspector@cloudflare.com";
    const newRoom = `inspect-new-${crypto.randomUUID()}`;
    const deniedNew = await roomAccess(employee, newRoom, "inspect");
    expect(deniedNew.status).toBe(403);
    const created = await roomAccess(employee, newRoom);
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ entry: "created", role: "owner" });

    const legacyRoom = `inspect-legacy-${crypto.randomUUID()}`;
    const legacyStub = await getAgentByName(env.GlideAgent, requiredStorageRoom(legacyRoom));
    await runInDurableObject(legacyStub, (agent: GlideAgent) => {
      agent.setState({
        ...agent.state,
        defaultZone: { id: "a".repeat(32), name: "legacy.example" },
      });
    });
    const deniedLegacy = await roomAccess(employee, legacyRoom, "inspect");
    expect(deniedLegacy.status).toBe(403);
    const memberCount = await runInDurableObject(legacyStub, (_agent: GlideAgent, state) =>
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_room_members",
      ).one().count
    );
    expect(memberCount).toBe(0);
    const claimed = await roomAccess(employee, legacyRoom);
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({ entry: "claimed", role: "owner" });
  });

  it("does not expose persistent sub-agent routes", async () => {
    const room = `no-sub-agents-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    expect((await roomAccess(owner, room)).status).toBe(200);

    const response = await asAccessUser(owner, (headers) => {
      headers.set("Upgrade", "websocket");
      return exports.default.fetch(new Request(
        `${agentUrl(room)}/sub/glide-agent/child-${crypto.randomUUID()}`,
        { headers },
      ));
    });
    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");

    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
    await expect(runInDurableObject(stub, (agent: GlideAgent) => agent.listSubAgents()))
      .resolves.toEqual([]);
  });

  it("uses an opaque Durable Object id instead of the room name in structured logs", async () => {
    const room = `opaque-log-room-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
    const correlation = await runInDurableObject(stub, (agent: GlideAgent) => {
      const roomLogCorrelation = Reflect.get(agent, "roomLogCorrelation") as () => string;
      return roomLogCorrelation.call(agent);
    });
    expect(correlation).not.toBe(requiredStorageRoom(room));
    expect(correlation).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([undefined, "https://attacker.example"])(
    "rejects an Agent WebSocket with browser origin %s",
    async (origin) => {
      const room = `origin-${crypto.randomUUID()}`;
      expect((await roomAccess("owner@cloudflare.com", room)).status).toBe(200);
      const response = await asAccessUser("owner@cloudflare.com", (headers) => {
        if (origin === undefined) headers.delete("Origin");
        else headers.set("Origin", origin);
        headers.set("Upgrade", "websocket");
        return exports.default.fetch(new Request(agentUrl(room), { headers }));
      });
      expect(response.status).toBe(403);
      expect(response.webSocket).toBeNull();
      await expect(response.json()).resolves.toMatchObject({ code: "invalid_origin" });
    },
  );

  it("prevents authenticated application pages from being framed", async () => {
    const testEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "ASSETS") {
          return {
            fetch: async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const response = await worker.fetch(
      new Request("https://example.com/admin"),
      testEnv,
      { passThroughOnException() {}, waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it.each([
    ["expired", { expiresInSeconds: -1 }],
    ["wrong-audience", { audience: "another-application" }],
    ["wrong-issuer", { issuer: "https://another-team.cloudflareaccess.com" }],
  ] as const)("rejects a %s assertion before activating a room", async (_label, options) => {
    const room = `invalid-assertion-${crypto.randomUUID()}`;
    const response = await asAccessUser("employee@cloudflare.com", (headers) => {
      headers.set("Upgrade", "websocket");
      return exports.default.fetch(new Request(agentUrl(room), { headers }));
    }, options);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "access_token_invalid" });
    const id = env.GlideAgent.idFromName(room);
    expect((await listDurableObjectIds(env.GlideAgent)).some((candidate) => candidate.equals(id))).toBe(false);
  });
});

describe("room membership", () => {
  it("does not let an external identity create an empty room", async () => {
    const room = `external-create-${crypto.randomUUID()}`;
    const outsider = await roomAccess("guest@example.com", room);
    expect(outsider.status).toBe(403);
    expect(await roomHadSchemaBeforeWake(room)).toBe(false);

    const employee = await roomAccess("creator@cloudflare.com", room);
    expect(employee.status).toBe(200);
    await expect(employee.json()).resolves.toMatchObject({
      email: "creator@cloudflare.com",
      role: "owner",
      entry: "created",
    });
  });

  it("keeps shipped custom room ids lookup-only", async () => {
    const missingLegacyRoom = `missing.legacy-${crypto.randomUUID()}`;
    const missing = await roomAccess("owner@cloudflare.com", missingLegacyRoom);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "legacy_room_not_found" });
    expect(await roomHadSchemaBeforeWake(missingLegacyRoom)).toBe(false);
  });

  it("maps legacy spaces and Unicode to the shipped Agent storage name", async () => {
    const room = `${"é".repeat(34)} legacy-${crypto.randomUUID()}`;
    const storageRoom = requiredStorageRoom(room);
    expect(storageRoom.length).toBeGreaterThan(200);
    expect(storageRoom).not.toBe(room);
    const stub = await getAgentByName(env.GlideAgent, storageRoom);
    await runInDurableObject(stub, async (agent: GlideAgent) => {
      agent.setState({
        ...agent.state,
        defaultZone: { id: "a".repeat(32), name: "legacy.example" },
      });
    });

    const claimed = await roomAccess("claimer@cloudflare.com", room);
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      entry: "claimed",
      role: "owner",
    });
    await expect(rpcAs<RoomAccessStatus>("claimer@cloudflare.com", room, "roomAccessStatus", []))
      .resolves.toMatchObject({ email: "claimer@cloudflare.com", role: "owner" });
  });

  it("recognizes a quarantined-chat-only legacy room as existing data", async () => {
    const room = `legacy.chat-only-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        `INSERT INTO glide_legacy_chat_quarantine
          (id, message, created_at, reason, quarantined_at, redacted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "legacy-user-message",
        JSON.stringify({ id: "legacy-user-message", role: "user", parts: [{ type: "text", text: "legacy" }] }),
        new Date().toISOString(),
        "legacy_transcript",
        Date.now(),
        Date.now(),
      );
    });

    const claimed = await roomAccess("claimer@cloudflare.com", room);
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({ entry: "claimed", role: "owner" });
  });

  it("preserves a pre-marker legacy object that existed before a denied probe", async () => {
    const room = `preexisting-empty-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec("DELETE FROM glide_room_lifecycle");
    });
    await evictDurableObject(stub);

    expect((await roomAccess("guest@example.com", room)).status).toBe(403);
    await evictDurableObject(stub);
    expect(await roomHadSchemaBeforeWake(room)).toBe(true);

    const created = await roomAccess("owner@cloudflare.com", room);
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ entry: "created", role: "owner" });
  });

  it("lets one employee create a room, denies nonmembers, and grants invited email membership", async () => {
    const room = `private-${crypto.randomUUID()}`;
    const ownerAccess = await roomAccess("owner@cloudflare.com", room);
    expect(ownerAccess.status).toBe(200);
    await expect(ownerAccess.clone().json()).resolves.toMatchObject({
      email: "owner@cloudflare.com",
      role: "owner",
      entry: "created",
    });

    const outsiderBefore = await roomAccess("guest@example.com", room);
    expect(outsiderBefore.status).toBe(403);
    const employeeBefore = await roomAccess("second@cloudflare.com", room);
    expect(employeeBefore.status).toBe(403);

    const invite = await rpcAs<{ ok: boolean; message: string; members: RoomAccessStatus["members"] }>(
      "owner@cloudflare.com",
      room,
      "inviteTeammate",
      ["Guest@Example.com", "forged actor", `https://example.com/#${room}`],
    );
    expect(invite.ok).toBe(true);
    expect(invite.members.map((member) => member.email)).toEqual([
      "owner@cloudflare.com",
      "guest@example.com",
    ]);
    expect(invite.members[1]?.invitedBy).toBe("owner@cloudflare.com");

    const outsiderAfter = await roomAccess("guest@example.com", room);
    expect(outsiderAfter.status).toBe(200);
    await expect(outsiderAfter.json()).resolves.toMatchObject({
      email: "guest@example.com",
      role: "member",
      entry: "member",
    });
  });

  it("overwrites spoofed internal identity headers before Agent RPC routing", async () => {
    const room = `trusted-headers-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    const member = "member@example.com";
    expect((await roomAccess(owner, room)).status).toBe(200);
    expect((await rpcAs<{ ok: boolean }>(owner, room, "inviteTeammate", [member])).ok).toBe(true);

    const status = await rpcAs<RoomAccessStatus>(member, room, "roomAccessStatus", [], (headers) => {
      headers.set("X-Glide-Access-Email", owner);
      headers.set("X-Glide-Access-Subject", "spoofed-owner");
      headers.set("X-Glide-Access-Expiry", String(Math.floor(Date.now() / 1_000) + 3_600));
    });
    expect(status).toMatchObject({ email: member, role: "member" });
  });

  it("rolls back an ACL grant when its durable invitation audit cannot be committed", async () => {
    const room = `invite-rollback-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    const guest = "guest@example.com";
    expect((await roomAccess(owner, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, room);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_invite_audit
        BEFORE INSERT ON glide_room_invites
        BEGIN
          SELECT RAISE(ABORT, 'forced invite audit failure');
        END
      `);
    });

    const invite = await rpcAs<{ ok: boolean; message: string }>(
      owner,
      room,
      "inviteTeammate",
      [guest, "forged actor"],
    );
    expect(invite).toEqual({
      ok: false,
      message: "Glide could not grant that room membership. Try again.",
    });
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_invite_audit");
    });
    expect((await roomAccess(guest, room)).status).toBe(403);

    const retry = await rpcAs<{ ok: boolean }>(owner, room, "inviteTeammate", [guest, "forged actor"]);
    expect(retry.ok).toBe(true);
    expect((await roomAccess(guest, room)).status).toBe(200);
    await runInDurableObject(stub, async (agent: GlideAgent) => {
      expect(agent.state.invites.map((candidate) => candidate.email)).toContain(guest);
    });
  });

  it("repairs a failed synced invite projection from the durable audit after eviction", async () => {
    const room = `invite-projection-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    const guest = "projection@example.com";
    expect((await roomAccess(owner, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, room);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_invite_projection
        BEFORE INSERT ON cf_agents_state
        WHEN NEW.id = 'cf_state_row_id'
        BEGIN
          SELECT RAISE(ABORT, 'forced state projection failure');
        END
      `);
    });

    const invite = await rpcAs<{ ok: boolean }>(owner, room, "inviteTeammate", [guest, "forged actor"]);
    expect(invite.ok).toBe(true);
    expect((await roomAccess(guest, room)).status).toBe(200);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_invite_projection");
    });

    await evictDurableObject(stub);
    expect((await roomAccess(guest, room)).status).toBe(200);
    await runInDurableObject(await getAgentByName(env.GlideAgent, room), async (agent: GlideAgent) => {
      expect(agent.state.invites.map((candidate) => candidate.email)).toContain(guest);
    });
  });

  it("denies a nonmember before upgrading or dispatching an Agent request", async () => {
    const room = `route-denial-${crypto.randomUUID()}`;
    expect((await roomAccess("owner@cloudflare.com", room)).status).toBe(200);

    const response = await asAccessUser("outsider@example.com", (headers) => {
      headers.set("Upgrade", "websocket");
      return exports.default.fetch(new Request(agentUrl(room), { headers }));
    });

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ code: "room_membership_required" });
  });

  it("atomically gives only the first employee ownership and persists it across eviction", async () => {
    const room = `claim-race-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const [first, second] = await Promise.all([
      stub.activateRoomAccess({ email: "first@cloudflare.com", subject: "first", expiresAt }, true),
      stub.activateRoomAccess({ email: "second@cloudflare.com", subject: "second", expiresAt }, true),
    ]);

    expect([first.allowed, second.allowed].filter(Boolean)).toHaveLength(1);
    const owner = first.allowed ? "first@cloudflare.com" : "second@cloudflare.com";
    await evictDurableObject(stub);
    const afterWake = await (await getAgentByName(env.GlideAgent, room)).authorizeRoomAccess({
      email: owner,
      subject: "owner-after-wake",
      expiresAt,
    });
    expect(afterWake.allowed).toBe(true);
    expect(afterWake.access?.role).toBe("owner");
    expect(afterWake.access?.members).toHaveLength(1);
  });

  it("coalesces concurrent denials while removing their fresh-room storage", async () => {
    const room = `concurrent-denials-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const results = await Promise.all([
      stub.authorizeRoomAccess({ email: "first@example.com", subject: "first", expiresAt }),
      stub.authorizeRoomAccess({ email: "second@example.com", subject: "second", expiresAt }),
    ]);

    expect(results.map((result) => result.allowed)).toEqual([false, false]);
    expect(await roomHadSchemaBeforeWake(room)).toBe(false);
  });

  it("destroys a provisional room after persistent cleanup schedule failures", async () => {
    const room = `cleanup-schedule-retry-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_fresh_cleanup_schedule
        BEFORE INSERT ON cf_agents_schedules
        WHEN NEW.callback = 'destroyFreshDeniedRoomIfUnused'
        BEGIN
          SELECT RAISE(ABORT, 'forced cleanup schedule failure');
        END
      `);
    });

    expect((await roomAccess("guest@example.com", room)).status).toBe(403);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(await roomHadSchemaBeforeWake(room)).toBe(false);
  });

  it("preserves activation that wins before the native cleanup fallback alarm", async () => {
    const room = `cleanup-fallback-activation-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_fresh_cleanup_schedule_before_activation
        BEFORE INSERT ON cf_agents_schedules
        WHEN NEW.callback = 'destroyFreshDeniedRoomIfUnused'
        BEGIN
          SELECT RAISE(ABORT, 'forced cleanup schedule failure');
        END
      `);
    });

    expect((await roomAccess("guest@example.com", room)).status).toBe(403);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const created = await roomAccess("owner@cloudflare.com", room);
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ entry: "created", role: "owner" });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(stub.authorizeRoomAccess({
      email: "owner@cloudflare.com",
      subject: "owner-after-fallback",
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    })).resolves.toMatchObject({ allowed: true, access: { role: "owner" } });
  });

  it("rechecks membership after asynchronous connection identity derivation", async () => {
    const room = `connect-revocation-race-${crypto.randomUUID()}`;
    const email = "member@cloudflare.com";
    expect((await roomAccess(email, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, room);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const closes: Array<{ code?: number; reason?: string }> = [];
      let connectionState: unknown = null;
      const connection = {
        id: crypto.randomUUID(),
        server: "test",
        get state() {
          return connectionState;
        },
        setState(next: unknown) {
          connectionState = next;
        },
        send() {},
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
      } as unknown as Connection;
      const connecting = agent.onConnect(connection, {
        request: new Request(agentUrl(room), {
          headers: {
            Origin: "https://example.com",
            "X-Glide-Access-Email": email,
            "X-Glide-Access-Subject": `subject:${email}`,
            "X-Glide-Access-Expiry": String(Math.floor(Date.now() / 1_000) + 300),
          },
        }),
      } as never);
      state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", email);
      await connecting;
      return { closes, state: connectionState };
    });

    expect(result.closes).toEqual([{ code: 1008, reason: "Room membership required" }]);
    expect(result.state).not.toHaveProperty("glideAccessEmail");
  });

  it("revokes the socket lease when membership ends during expiry scheduling", async () => {
    const room = `connect-schedule-revocation-race-${crypto.randomUUID()}`;
    const email = "member@cloudflare.com";
    expect((await roomAccess(email, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, room);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const scheduleId = crypto.randomUUID();
      const cancellations: string[] = [];
      let markScheduleStarted!: () => void;
      const scheduleStarted = new Promise<void>((resolve) => {
        markScheduleStarted = resolve;
      });
      let releaseSchedule!: () => void;
      const scheduleGate = new Promise<void>((resolve) => {
        releaseSchedule = resolve;
      });
      const schedulingAgent = agent as unknown as {
        schedule: () => Promise<{ id: string }>;
        cancelSchedule: (id: string) => Promise<void>;
      };
      schedulingAgent.schedule = async () => {
        markScheduleStarted();
        await scheduleGate;
        return { id: scheduleId };
      };
      schedulingAgent.cancelSchedule = async (id) => {
        cancellations.push(id);
      };

      const closes: Array<{ code?: number; reason?: string }> = [];
      let connectionState: unknown = null;
      const connection = {
        id: crypto.randomUUID(),
        server: "test",
        get state() {
          return connectionState;
        },
        setState(next: unknown) {
          connectionState = next;
        },
        send() {},
        close(code?: number, reason?: string) {
          closes.push({ code, reason });
        },
      } as unknown as Connection;
      const connecting = agent.onConnect(connection, {
        request: new Request(agentUrl(room), {
          headers: {
            Origin: "https://example.com",
            "X-Glide-Access-Email": email,
            "X-Glide-Access-Subject": `subject:${email}`,
            "X-Glide-Access-Expiry": String(Math.floor(Date.now() / 1_000) + 300),
          },
        }),
      } as never);
      await scheduleStarted;
      state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", email);
      releaseSchedule();
      await connecting;
      return { cancellations, closes, state: connectionState };
    });

    expect(result.cancellations).toEqual([expect.any(String)]);
    expect(result.closes).toEqual([{ code: 1008, reason: "Room membership required" }]);
    expect(result.state).not.toHaveProperty("glideAccessLeaseId");
    expect(result.state).not.toHaveProperty("glideAccessEmail");
    expect(result.state).not.toHaveProperty("glideAccessExpiryScheduleId");
  });

  it("rechecks membership after asynchronous protocol rate limiting", async () => {
    const room = `protocol-revocation-race-${crypto.randomUUID()}`;
    const email = "member@cloudflare.com";
    expect((await roomAccess(email, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, room);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      let release!: (decision: "allowed") => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      (agent as unknown as {
        checkRateLimit: () => Promise<"allowed">;
      }).checkRateLimit = () => {
        markStarted();
        return new Promise<"allowed">((resolve) => {
          release = resolve;
        });
      };
      const frames: string[] = [];
      const closes: Array<{ code?: number; reason?: string }> = [];
      const handling = agent.onMessage(
        protocolConnection(email, Math.floor(Date.now() / 1_000) + 300, frames, closes),
        JSON.stringify({ type: "rpc", id: "rpc-race", method: "startOnboarding", args: ["forged actor"] }),
      );
      await started;
      state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", email);
      release("allowed");
      await handling;
      return { closes, frames, onboarding: agent.state.onboarding };
    });

    expect(result.closes).toEqual([{ code: 1008, reason: "Room membership or Access session expired" }]);
    expect(result.frames).toEqual([]);
    expect(result.onboarding).toBeUndefined();
  });

  it("closes an oversized protocol frame before rate limiting or dispatch", async () => {
    const room = `protocol-oversized-frame-${crypto.randomUUID()}`;
    const email = "member@cloudflare.com";
    expect((await roomAccess(email, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, room);
    const result = await runInDurableObject(stub, async (agent: GlideAgent) => {
      let limiterCalls = 0;
      (agent as unknown as {
        checkRateLimit: () => Promise<"allowed">;
      }).checkRateLimit = async () => {
        limiterCalls += 1;
        return "allowed";
      };
      const frames: string[] = [];
      const closes: Array<{ code?: number; reason?: string }> = [];
      await agent.onMessage(
        protocolConnection(email, Math.floor(Date.now() / 1_000) + 300, frames, closes),
        "x".repeat(MAX_CHAT_PROTOCOL_BYTES + 1),
      );
      return { closes, frames, limiterCalls };
    });

    expect(result.closes).toEqual([{ code: 1009, reason: "Chat protocol message is too large" }]);
    expect(result.frames).toEqual([]);
    expect(result.limiterCalls).toBe(0);
  });

  it("bounds concurrent protocol bytes before waiting on the limiter", async () => {
    const room = `protocol-byte-budget-${crypto.randomUUID()}`;
    const email = "member@cloudflare.com";
    expect((await roomAccess(email, room)).status).toBe(200);
    const stub = await getAgentByName(env.GlideAgent, room);
    const result = await runInDurableObject(stub, async (agent: GlideAgent) => {
      let release!: (decision: "limited") => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let limiterCalls = 0;
      (agent as unknown as {
        checkRateLimit: () => Promise<"limited">;
      }).checkRateLimit = () => {
        limiterCalls += 1;
        markStarted();
        return new Promise<"limited">((resolve) => {
          release = resolve;
        });
      };
      const closes: Array<{ code?: number; reason?: string }> = [];
      const connection = protocolConnection(
        email,
        Math.floor(Date.now() / 1_000) + 300,
        [],
        closes,
      );
      await agent.onMessage(connection, new ArrayBuffer(1));
      const padding = "x".repeat(Math.floor(MAX_CHAT_PROTOCOL_BYTES * 0.6));
      const frame = JSON.stringify({ type: "rpc", id: "large", method: "roomAccessStatus", args: [], padding });
      const first = agent.onMessage(connection, frame);
      await started;
      await agent.onMessage(connection, frame);
      release("limited");
      await first;
      return { closes, limiterCalls };
    });

    expect(result.limiterCalls).toBe(1);
    expect(result.closes).toContainEqual({ code: 1003, reason: "Binary protocol messages are not supported" });
    expect(result.closes).toContainEqual({ code: 1009, reason: "Too much protocol data is awaiting admission" });
  });

  it("does not expose membership grants as a model tool", async () => {
    const room = `model-tools-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    const toolNames = await runInDurableObject(stub, async (agent: GlideAgent) => {
      const tools = (agent as unknown as {
        buildTools(turn: { actor: string; queuedActions: unknown[]; queueNotices: string[] }): Record<string, unknown>;
      }).buildTools({ actor: "member@cloudflare.com", queuedActions: [], queueNotices: [] });
      return Object.keys(tools);
    });

    expect(toolNames).not.toContain("invite_teammate");
  });

  it("replays the created or claimed result for an idempotent activation retry", async () => {
    const room = `activation.replay-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    await runInDurableObject(stub, async (agent: GlideAgent) => {
      agent.setState({ ...agent.state, memory: { account: "legacy" } });
    });
    const identity = {
      email: "owner@cloudflare.com",
      subject: "activation-replay",
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    };
    const attemptId = crypto.randomUUID();

    await expect(stub.activateRoomAccess(identity, false, attemptId))
      .resolves.toMatchObject({ allowed: true, code: "room_claimed", access: { entry: "claimed" } });
    await expect(stub.activateRoomAccess(identity, false, attemptId))
      .resolves.toMatchObject({ allowed: true, code: "room_claimed", access: { entry: "claimed" } });
    await expect(stub.activateRoomAccess(identity, false, crypto.randomUUID()))
      .resolves.toMatchObject({ allowed: true, code: "member", access: { entry: "member" } });
  });

  it("preserves first-owner activation that races the actual cleanup alarm", async () => {
    const room = `deny-activation-race-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    const expiresAt = Math.floor(Date.now() / 1_000) + 300;
    const denied = await stub.authorizeRoomAccess({
      email: "guest@example.com",
      subject: "guest",
      expiresAt,
    });
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = 0 WHERE callback = ?",
        "destroyFreshDeniedRoomIfUnused",
      );
    });
    const [alarmRan, activated] = await Promise.all([
      runDurableObjectAlarm(stub),
      roomAccess("owner@cloudflare.com", room),
    ]);

    expect(denied.allowed).toBe(false);
    expect(alarmRan).toBe(true);
    expect(activated.status).toBe(200);
    await expect(activated.json()).resolves.toMatchObject({ entry: "created", role: "owner" });
    await evictDurableObject(await getAgentByName(env.GlideAgent, room));
    expect(await roomHadSchemaBeforeWake(room)).toBe(true);
    await expect((await getAgentByName(env.GlideAgent, room)).authorizeRoomAccess({
      email: "owner@cloudflare.com",
      subject: "owner-after-race",
      expiresAt,
    })).resolves.toMatchObject({ allowed: true, access: { role: "owner" } });
  });

  it("claims legacy data without trusting its recorded invitations as ACL grants", async () => {
    const room = `legacy.claim-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.GlideAgent, room);
    await runInDurableObject(stub, async (agent: GlideAgent) => {
      agent.setState({
        ...agent.state,
        memory: { account: "legacy" },
        invites: [
          { email: "legacy.guest@example.com", invitedBy: "legacy user", ts: Date.now() - 1_000 },
          { email: "LEGACY.GUEST@example.com", invitedBy: "duplicate", ts: Date.now() - 2_000 },
          {
            email: "legacy.second@example.com",
            invitedBy: "legacy user",
            ts: "malformed" as unknown as number,
          },
        ],
      });
    });

    expect((await roomAccess("outsider@example.com", room)).status).toBe(403);
    await evictDurableObject(stub);
    expect(await roomHadSchemaBeforeWake(room)).toBe(true);

    const claimed = await roomAccess("claimer@cloudflare.com", room);
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      entry: "claimed",
      members: [
        { email: "claimer@cloudflare.com", role: "owner" },
      ],
    });
    expect((await roomAccess("legacy.guest@example.com", room)).status).toBe(403);

    const reissued = await rpcAs<{ ok: boolean; members: RoomAccessStatus["members"] }>(
      "claimer@cloudflare.com",
      room,
      "inviteTeammate",
      ["legacy.guest@example.com", "forged actor", `https://example.com/#${room}`],
    );
    expect(reissued.ok).toBe(true);
    expect(reissued.members.map((member) => member.email)).toEqual([
      "claimer@cloudflare.com",
      "legacy.guest@example.com",
    ]);
    expect((await roomAccess("legacy.guest@example.com", room)).status).toBe(200);
  });

  it("lets only the owner revoke a member and immediately closes that member's sockets", async () => {
    const room = `member-revocation-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    const member = "member@example.com";
    expect((await roomAccess(owner, room)).status).toBe(200);
    const invited = await rpcAs<{ ok: boolean }>(owner, room, "inviteTeammate", [member, "forged actor"]);
    expect(invited.ok).toBe(true);

    const response = await asAccessUser(member, (headers) => {
      headers.set("Upgrade", "websocket");
      return exports.default.fetch(new Request(agentUrl(room), { headers }));
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for membership revocation")), 5_000);
      socket.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, reason: event.reason });
      }, { once: true });
    });

    const denied = await rpcAs<{ ok: boolean; message: string }>(
      member,
      room,
      "removeRoomMember",
      [owner],
    );
    expect(denied).toMatchObject({ ok: false, message: "Only the room owner can remove a member." });
    const ownerProtected = await rpcAs<{ ok: boolean; message: string }>(
      owner,
      room,
      "removeRoomMember",
      [owner],
    );
    expect(ownerProtected).toMatchObject({ ok: false, message: "The room owner cannot be removed." });

    const removed = await rpcAs<{ ok: boolean; members: RoomAccessStatus["members"] }>(
      owner,
      room,
      "removeRoomMember",
      [member],
    );
    expect(removed.ok).toBe(true);
    expect(removed.members.map((candidate) => candidate.email)).toEqual([owner]);
    await expect(closed).resolves.toEqual({ code: 1008, reason: "Room membership revoked" });
    expect((await roomAccess(member, room)).status).toBe(403);
  });

  it("cancels Apply when membership is revoked during the safety read", async () => {
    const room = `apply-revocation-race-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    const member = "member@example.com";
    const zoneId = "a".repeat(32);
    const phase = "http_request_firewall_custom";
    const action: PendingAction = {
      id: crypto.randomUUID(),
      product: "WAF",
      summary: "Add WAF rule",
      method: "PUT",
      path: `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
      body: { rules: [{ action: "block", expression: "true", enabled: true }] },
      mergeEntrypoint: {
        phase,
        newRules: [{ action: "block", expression: "true", enabled: true }],
      },
      zoneId,
      createdBy: member,
      status: "pending",
      ts: Date.now(),
    };
    expect((await roomAccess(owner, room)).status).toBe(200);
    await expect(rpcAs<{ ok: boolean }>(owner, room, "inviteTeammate", [member, "forged actor"]))
      .resolves.toMatchObject({ ok: true });
    await saveRoomToken(room, TOKEN_A);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
    const socket = await openAgentSocket(member, room);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      agent.setState({ ...agent.state, pendingActions: [action] });
      const connection = [...agent.getConnections()].find((candidate) =>
        (candidate.state as { glideAccessEmail?: string } | null)?.glideAccessEmail === member
      );
      if (!connection) throw new Error("Expected the member connection");
      const accessLease = accessLeaseForConnection(connection);
      const writes: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "GET" && request.url.includes("/rulesets/phases/")) {
          await Promise.resolve();
          state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
          return Response.json({ success: true, result: { rules: [] } });
        }
        if (request.method !== "GET") writes.push(`${request.method} ${request.url}`);
        return Response.json({ success: true, result: {} });
      }) as typeof fetch;
      try {
        const applyActionInternal = Reflect.get(agent, "applyActionInternal") as (
          id: string,
          by: string,
          notify: boolean,
          confirmUncertain: boolean,
          capturedCredential: undefined,
          lease: typeof accessLease,
        ) => Promise<{ status: string; detail: string }>;
        const result = await applyActionInternal.call(
          agent,
          action.id,
          member,
          false,
          false,
          undefined,
          accessLease,
        );
        return {
          result,
          writes,
          pendingStatus: agent.state.pendingActions.find((candidate) => candidate.id === action.id)?.status,
        };
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    expect(outcome.result).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/room access ended.*nothing was sent/i),
    });
    expect(outcome.writes).toEqual([]);
    expect(outcome.pendingStatus).toBe("failed");
  });

  it("does not transfer an Apply lease to a reconnect with the same connection id", async () => {
    const room = `apply-socket-lease-${crypto.randomUUID()}`;
    const member = "member@cloudflare.com";
    const connectionId = crypto.randomUUID();
    const zoneId = "b".repeat(32);
    const phase = "http_request_firewall_custom";
    const action: PendingAction = {
      id: crypto.randomUUID(),
      product: "WAF",
      summary: "Add WAF rule",
      method: "PUT",
      path: `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
      body: { rules: [{ action: "block", expression: "true", enabled: true }] },
      mergeEntrypoint: {
        phase,
        newRules: [{ action: "block", expression: "true", enabled: true }],
      },
      zoneId,
      createdBy: member,
      status: "pending",
      ts: Date.now(),
    };
    expect((await roomAccess(member, room)).status).toBe(200);
    await saveRoomToken(room, TOKEN_A);
    const initiatingSocket = await openAgentSocket(member, room, connectionId);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
    const capturedLease = await runInDurableObject(stub, async (agent: GlideAgent) => {
      const connections = [...agent.getConnections(connectionId)];
      if (connections.length !== 1) throw new Error("Expected the initiating connection");
      return accessLeaseForConnection(connections[0]!);
    });
    const replacementSocket = await openAgentSocket(member, room, connectionId);

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent) => {
      agent.setState({ ...agent.state, pendingActions: [action] });
      const connections = [...agent.getConnections(connectionId)];
      if (connections.length !== 2) throw new Error(`Expected duplicate connection ids, got ${connections.length}`);
      const initiating = connections.find((connection) =>
        (connection.state as { glideAccessLeaseId?: string } | null)?.glideAccessLeaseId === capturedLease.leaseId
      );
      const replacement = connections.find((connection) => connection !== initiating);
      if (!initiating || !replacement) throw new Error("Expected initiating and replacement connections");
      const replacementState = replacement.state as Record<string, unknown>;
      replacement.setState({ ...replacementState, glideAccessExpiresAt: capturedLease.expiresAt });
      const replacementLease = accessLeaseForConnection(replacement);
      const writes: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "GET" && request.url.includes("/rulesets/phases/")) {
          const initiatingState = initiating.state as Record<string, unknown>;
          initiating.setState({ ...initiatingState, glideAccessLeaseId: crypto.randomUUID() });
          initiating.close(1000, "reconnected");
          return Response.json({ success: true, result: { rules: [] } });
        }
        if (request.method !== "GET") writes.push(`${request.method} ${request.url}`);
        return Response.json({ success: true, result: {} });
      }) as typeof fetch;
      try {
        const applyActionInternal = Reflect.get(agent, "applyActionInternal") as (
          id: string,
          by: string,
          notify: boolean,
          confirmUncertain: boolean,
          capturedCredential: undefined,
          lease: typeof capturedLease,
        ) => Promise<{ status: string; detail: string }>;
        const result = await applyActionInternal.call(
          agent,
          action.id,
          member,
          false,
          false,
          undefined,
          capturedLease,
        );
        return { result, writes, leaseIdsDiffer: replacementLease.leaseId !== capturedLease.leaseId };
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    expect(outcome.leaseIdsDiffer).toBe(true);
    expect(outcome.result).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/room access ended.*nothing was sent/i),
    });
    expect(outcome.writes).toEqual([]);
    initiatingSocket.close(1000, "done");
    replacementSocket.close(1000, "done");
  });

  it("aborts socket-bound chat work when a duplicate connection id reconnects", async () => {
    const room = `chat-socket-replacement-${crypto.randomUUID()}`;
    const member = "member@cloudflare.com";
    const connectionId = crypto.randomUUID();
    expect((await roomAccess(member, room)).status).toBe(200);
    const initiatingSocket = await openAgentSocket(member, room, connectionId);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
    const initiatingLease = await runInDurableObject(stub, async (agent: GlideAgent) => {
      const connection = [...agent.getConnections(connectionId)][0];
      if (!connection) throw new Error("Expected the initiating connection");
      const lease = accessLeaseForConnection(connection);
      Reflect.set(agent, "testChatAbortReason", undefined);
      const registerRoomAccessAborter = Reflect.get(agent, "registerRoomAccessAborter") as (
        currentLease: typeof lease,
        abort: (reason: Error) => void,
      ) => () => void;
      registerRoomAccessAborter.call(agent, lease, (reason) => {
        Reflect.set(agent, "testChatAbortReason", reason.message);
      });
      return lease;
    });

    const replacementSocket = await openAgentSocket(member, room, connectionId);
    const outcome = await runInDurableObject(stub, async (agent: GlideAgent) => {
      const connections = [...agent.getConnections(connectionId)];
      const replacement = connections.find((connection) =>
        (connection.state as { glideAccessLeaseId?: string } | null)?.glideAccessLeaseId !== initiatingLease.leaseId
      );
      return {
        connectionCount: connections.length,
        replacementLeaseId: replacement ? accessLeaseForConnection(replacement).leaseId : undefined,
        abortReason: Reflect.get(agent, "testChatAbortReason"),
      };
    });

    expect(outcome.connectionCount).toBe(2);
    expect(outcome.replacementLeaseId).not.toBe(initiatingLease.leaseId);
    expect(outcome.abortReason).toMatch(/replaced by a reconnect/i);
    initiatingSocket.close(1000, "done");
    replacementSocket.close(1000, "done");
  });

  it("aborts a retry turn when its socket lease loses membership", async () => {
    const room = `retry-revocation-race-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    const member = "member@example.com";
    const messageId = crypto.randomUUID();
    expect((await roomAccess(owner, room)).status).toBe(200);
    await expect(rpcAs<{ ok: boolean }>(owner, room, "inviteTeammate", [member, "forged actor"]))
      .resolves.toMatchObject({ ok: true });
    const socket = await openAgentSocket(member, room);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()].find((candidate) =>
        (candidate.state as { glideAccessEmail?: string } | null)?.glideAccessEmail === member
      );
      if (!connection) throw new Error("Expected the retrying member connection");
      const accessLease = accessLeaseForConnection(connection);
      agent.messages = [{
        id: messageId,
        role: "user",
        parts: [{ type: "text", text: "Please retry this turn." }],
        metadata: { name: member },
      }];
      let markTurnStarted!: () => void;
      const turnStarted = new Promise<void>((resolve) => {
        markTurnStarted = resolve;
      });
      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      let observedLease: typeof accessLease | undefined;
      let abortedBeforeRevocation: boolean | undefined;
      let abortedAfterRevocation: boolean | undefined;
      Reflect.set(agent, "onChatMessage", async (
        _onFinish: unknown,
        options?: { abortSignal?: AbortSignal },
      ) => {
        const currentChatRoomAccessLease = Reflect.get(agent, "currentChatRoomAccessLease") as () =>
          ReturnType<typeof accessLeaseForConnection> | undefined;
        observedLease = currentChatRoomAccessLease.call(agent);
        abortedBeforeRevocation = options?.abortSignal?.aborted;
        markTurnStarted();
        await turnGate;
        abortedAfterRevocation = options?.abortSignal?.aborted;
        return undefined;
      });
      const retryInterruptedResponseInternal = Reflect.get(agent, "retryInterruptedResponseInternal") as (
        id: string,
        assistantId: string | undefined,
        lease: typeof accessLease,
      ) => Promise<{ ok: boolean; message: string }>;
      const retrying = retryInterruptedResponseInternal.call(agent, messageId, undefined, accessLease);
      await turnStarted;
      state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
      const abortRoomAccessOperations = Reflect.get(agent, "abortRoomAccessOperations") as (
        currentLease: typeof accessLease,
        reason: Error,
      ) => void;
      abortRoomAccessOperations.call(agent, accessLease, new Error("test membership revocation"));
      releaseTurn();
      const result = await retrying;
      return {
        result,
        accessLease,
        observedLease,
        abortedBeforeRevocation,
        abortedAfterRevocation,
      };
    });

    expect(outcome.result).toEqual({
      ok: false,
      message: expect.stringMatching(/room access ended/i),
    });
    expect(outcome.observedLease).toEqual(outcome.accessLease);
    expect(outcome.abortedBeforeRevocation).toBe(false);
    expect(outcome.abortedAfterRevocation).toBe(true);
    socket.close(1000, "done");
  });

  it("does not persist chat-tool state after access ends during a Cloudflare read", async () => {
    const room = `chat-tool-revocation-race-${crypto.randomUUID()}`;
    const member = "member@cloudflare.com";
    const accountId = "c".repeat(32);
    const zoneId = "d".repeat(32);
    expect((await roomAccess(member, room)).status).toBe(200);
    await saveRoomToken(room, TOKEN_A);
    const socket = await openAgentSocket(member, room);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()][0];
      if (!connection) throw new Error("Expected the member connection");
      const accessLease = accessLeaseForConnection(connection);
      const buildTools = Reflect.get(agent, "buildTools") as (turn: {
        actor: string;
        queuedActions: PendingAction[];
        queueNotices: string[];
        accessLease: typeof accessLease;
      }) => Record<string, { execute?: (input: unknown) => Promise<unknown> }>;
      const tools = buildTools.call(agent, {
        actor: member,
        queuedActions: [],
        queueNotices: [],
        accessLease,
      });
      const execute = tools.find_zone?.execute;
      if (!execute) throw new Error("Expected the find_zone tool");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.includes("/zones?name=example.com")) {
          state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
          return Response.json({
            success: true,
            result: [{ id: zoneId, name: "example.com", status: "active", account: { id: accountId } }],
          });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      try {
        const result = await execute({ name: "example.com" });
        return { result, defaultAccountId: agent.state.defaultAccountId, defaultZone: agent.state.defaultZone };
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    expect(outcome.result).toEqual(expect.stringMatching(/room access ended/i));
    expect(outcome.defaultAccountId).toBeUndefined();
    expect(outcome.defaultZone).toBeUndefined();
    socket.close(1000, "done");
  });

  it("does not persist a migration preview after its socket lease loses membership", async () => {
    const room = `migration-preview-revocation-${crypto.randomUUID()}`;
    const member = "member@cloudflare.com";
    expect((await roomAccess(member, room)).status).toBe(200);
    const socket = await openAgentSocket(member, room);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()][0];
      if (!connection) throw new Error("Expected the member connection");
      const accessLease = accessLeaseForConnection(connection);
      Reflect.set(agent, "migrationTransport", () => ({
        fetcher: {
          fetch: async () => {
            await Promise.resolve();
            state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
            return Response.json({
              provider: "akamai",
              providerLabel: "Akamai",
              totalRules: 1,
              phases: [{ key: "waf", label: "WAF", count: 1 }],
              rules: [{
                name: "Block bots",
                type: "waf_custom",
                phase: "waf",
                phaseLabel: "WAF",
                action: "block",
              }],
            });
          },
        },
      }));
      const runPreview = Reflect.get(agent, "runPreview") as (
        provider: string,
        config: unknown,
        actor: string,
        isAuthorized: () => boolean,
      ) => Promise<{ ok: boolean; message?: string }>;
      const result = await runPreview.call(
        agent,
        "akamai",
        { rules: [] },
        member,
        () => {
          const isCurrent = Reflect.get(agent, "isRoomAccessLeaseCurrent") as (lease: typeof accessLease) => boolean;
          return isCurrent.call(agent, accessLease);
        },
      );
      return {
        result,
        migrationPlan: agent.state.migrationPlan,
        sourceCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_migration_src",
        ).one().count,
      };
    });

    expect(outcome.result).toEqual({ ok: false, message: expect.stringMatching(/room access ended/i) });
    expect(outcome.migrationPlan).toBeUndefined();
    expect(outcome.sourceCount).toBe(0);
    socket.close(1000, "done");
  });

  it("does not persist a migration export after its socket lease loses membership", async () => {
    const room = `migration-export-revocation-${crypto.randomUUID()}`;
    const member = "member@cloudflare.com";
    expect((await roomAccess(member, room)).status).toBe(200);
    const socket = await openAgentSocket(member, room);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()][0];
      if (!connection) throw new Error("Expected the member connection");
      const accessLease = accessLeaseForConnection(connection);
      const sourceRevision = crypto.randomUUID();
      const plan: MigrationPlan = {
        provider: "akamai",
        providerLabel: "Akamai",
        totalRules: 0,
        phases: [],
        rules: [],
        sourceRevision,
        createdBy: member,
        ts: Date.now(),
      };
      agent.setState({ ...agent.state, migrationPlan: plan });
      state.storage.sql.exec(
        "INSERT INTO glide_migration_src (id, provider, data, ts) VALUES (?, ?, ?, ?)",
        sourceRevision,
        "akamai",
        JSON.stringify({ rules: [] }),
        Date.now(),
      );
      Reflect.set(agent, "migrationTransport", () => ({
        fetcher: {
          fetch: async () => {
            await Promise.resolve();
            state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
            return Response.json({ provider: "Akamai", files: [] });
          },
        },
      }));
      const doExportCsv = Reflect.get(agent, "doExportCsv") as (
        args: Record<string, never>,
        actor: string,
        isAuthorized: () => boolean,
      ) => Promise<{ ok: boolean; message: string }>;
      const result = await doExportCsv.call(agent, {}, member, () => {
        const isCurrent = Reflect.get(agent, "isRoomAccessLeaseCurrent") as (lease: typeof accessLease) => boolean;
        return isCurrent.call(agent, accessLease);
      });
      return { result, csv: agent.state.csv };
    });

    expect(outcome.result).toEqual({ ok: false, message: expect.stringMatching(/room access ended/i) });
    expect(outcome.csv).toBeUndefined();
    socket.close(1000, "done");
  });

  it("does not persist a Terraform export after its socket lease loses membership", async () => {
    const room = `migration-terraform-revocation-${crypto.randomUUID()}`;
    const member = "member@cloudflare.com";
    expect((await roomAccess(member, room)).status).toBe(200);
    const socket = await openAgentSocket(member, room);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()][0];
      if (!connection) throw new Error("Expected the member connection");
      const accessLease = accessLeaseForConnection(connection);
      const sourceRevision = crypto.randomUUID();
      const plan: MigrationPlan = {
        provider: "akamai",
        providerLabel: "Akamai",
        totalRules: 0,
        phases: [],
        rules: [],
        sourceRevision,
        createdBy: member,
        ts: Date.now(),
      };
      agent.setState({ ...agent.state, migrationPlan: plan });
      state.storage.sql.exec(
        "INSERT INTO glide_migration_src (id, provider, data, ts) VALUES (?, ?, ?, ?)",
        sourceRevision,
        "akamai",
        JSON.stringify({ rules: [] }),
        Date.now(),
      );
      Reflect.set(agent, "migrationTransport", () => ({
        fetcher: {
          fetch: async () => {
            await Promise.resolve();
            state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
            return Response.json({ provider: "Akamai", files: [] });
          },
        },
      }));
      const generateTerraform = Reflect.get(agent, "generateTerraform") as (
        args: Record<string, never>,
        actor: string,
        isAuthorized: () => boolean,
      ) => Promise<string>;
      const result = await generateTerraform.call(agent, {}, member, () => {
        const isCurrent = Reflect.get(agent, "isRoomAccessLeaseCurrent") as (lease: typeof accessLease) => boolean;
        return isCurrent.call(agent, accessLease);
      });
      return { result, terraform: agent.state.terraform };
    });

    expect(outcome.result).toMatch(/room access ended/i);
    expect(outcome.terraform).toBeUndefined();
    socket.close(1000, "done");
  });

  it.each(["preflight", "diff"] as const)(
    "does not persist a migration %s after its socket lease loses membership",
    async (kind) => {
      const room = `migration-${kind}-revocation-${crypto.randomUUID()}`;
      const member = "member@cloudflare.com";
      const accountId = "a".repeat(32);
      const zoneId = "b".repeat(32);
      expect((await roomAccess(member, room)).status).toBe(200);
      await saveRoomToken(room, TOKEN_A);
      const socket = await openAgentSocket(member, room);
      const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

      const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
        const connection = [...agent.getConnections()][0];
        if (!connection) throw new Error("Expected the member connection");
        const accessLease = accessLeaseForConnection(connection);
        const plan: MigrationPlan = {
          provider: "akamai",
          providerLabel: "Akamai",
          totalRules: 0,
          phases: [],
          rules: [],
          sourceRevision: crypto.randomUUID(),
          createdBy: member,
          ts: Date.now(),
        };
        agent.setState({
          ...agent.state,
          defaultAccountId: accountId,
          defaultZone: { id: zoneId, name: "example.com", accountId },
          migrationPlan: plan,
        });
        Reflect.set(agent, "migrationTransport", () => ({
          fetcher: {
            fetch: async () => {
              await Promise.resolve();
              state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
              return kind === "preflight"
                ? Response.json({
                    skipped: false,
                    tokenValid: true,
                    tokenDetail: "active",
                    checks: [{ name: "Zone", description: "Zone read", status: "passed", detail: "ok" }],
                    missing: [],
                    passed: ["Zone read"],
                    allPassed: true,
                  })
                : Response.json({
                    provider: "akamai",
                    zoneId,
                    accountId,
                    phases: {},
                    ipLists: { total: 0, names: [] },
                    loadBalancers: { pools: 0, poolNames: [], lbs: 0, lbNames: [] },
                    timestamp: new Date().toISOString(),
                  });
            },
          },
        }));
        const runCheck = Reflect.get(agent, kind === "preflight" ? "doPreflight" : "doDiff") as (
          requestedZoneId: string,
          actor: string,
          isAuthorized: () => boolean,
        ) => Promise<{ ok: boolean; summary: string }>;
        const result = await runCheck.call(agent, zoneId, member, () => {
          const isCurrent = Reflect.get(agent, "isRoomAccessLeaseCurrent") as (lease: typeof accessLease) => boolean;
          return isCurrent.call(agent, accessLease);
        });
        return { result, migrationCheck: agent.state.migrationCheck };
      });

      expect(outcome.result).toEqual({ ok: false, summary: expect.stringMatching(/room access ended/i) });
      expect(outcome.migrationCheck).toBeUndefined();
      socket.close(1000, "done");
    },
  );

  it("keeps the current token when membership is revoked during replacement verification", async () => {
    const room = `token-revocation-race-${crypto.randomUUID()}`;
    const owner = "owner@cloudflare.com";
    const member = "member@example.com";
    expect((await roomAccess(owner, room)).status).toBe(200);
    await expect(rpcAs<{ ok: boolean }>(owner, room, "inviteTeammate", [member, "forged actor"]))
      .resolves.toMatchObject({ ok: true });
    await saveRoomToken(room, TOKEN_A);
    const socket = await openAgentSocket(member, room);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()].find((candidate) =>
        (candidate.state as { glideAccessEmail?: string } | null)?.glideAccessEmail === member
      );
      if (!connection) throw new Error("Expected the member connection");
      const accessLease = accessLeaseForConnection(connection);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/user/tokens/verify")) {
          await Promise.resolve();
          state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
          return Response.json({ success: true, result: { status: "active" } });
        }
        return originalFetch(input, init);
      }) as typeof fetch;
      try {
        const setCloudflareTokenInternal = Reflect.get(agent, "setCloudflareTokenInternal") as (
          token: string,
          lease: typeof accessLease,
        ) => Promise<{ ok: boolean; message: string }>;
        const result = await setCloudflareTokenInternal.call(agent, TOKEN_B, accessLease);
        return {
          result,
          tokenLast4: agent.state.tokenLast4,
          secretCount: state.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM glide_secrets WHERE name = ?",
            "cf_api_token",
          ).one().count,
        };
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    expect(outcome).toEqual({
      result: { ok: false, message: expect.stringMatching(/room access ended/i) },
      tokenLast4: TOKEN_A.slice(-4),
      secretCount: 1,
    });
  });

  it("does not arm legacy archive deletion when membership ends during token decryption", async () => {
    const room = `archive-revocation-race-${crypto.randomUUID()}`;
    const member = "member@cloudflare.com";
    expect((await roomAccess(member, room)).status).toBe(200);
    const socket = await openAgentSocket(member, room);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));

    const outcome = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()][0];
      if (!connection) throw new Error("Expected the member connection");
      const accessLease = accessLeaseForConnection(connection);
      Reflect.set(agent, "assistantProvenanceReady", false);
      state.storage.sql.exec("DELETE FROM glide_chat_migrations WHERE id = ?", "assistant-provenance-v1");
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO glide_chat_migration_progress
          (id, last_rowid, blocked_reason, recovery_requested) VALUES (?, 0, ?, 0)`,
        "assistant-provenance-v1",
        "token_decryption_failed",
      );
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO glide_secrets (name, value, ts) VALUES (?, ?, ?)",
        "cf_api_token",
        "malformed-ciphertext",
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO glide_legacy_chat_quarantine
          (id, message, created_at, reason, quarantined_at, redacted_at)
          VALUES (?, ?, ?, NULL, NULL, NULL)`,
        "legacy-message",
        JSON.stringify({ id: "legacy-message", role: "user", parts: [{ type: "text", text: "legacy" }] }),
        new Date().toISOString(),
      );
      Reflect.set(agent, "getToken", async () => {
        await Promise.resolve();
        state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", member);
        return "";
      });
      try {
        const discard = Reflect.get(agent, "discardLegacyChatArchiveForRecoveryInternal") as (
          confirmation: string,
          lease: typeof accessLease,
        ) => Promise<{ ok: boolean; message: string }>;
        const result = await discard.call(agent, LEGACY_CHAT_RECOVERY_CONFIRMATION, accessLease);
        return {
          result,
          recoveryRequested: state.storage.sql.exec<{ recovery_requested: number }>(
            "SELECT recovery_requested FROM glide_chat_migration_progress WHERE id = ?",
            "assistant-provenance-v1",
          ).one().recovery_requested,
          archiveCount: state.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE id = ?",
            "legacy-message",
          ).one().count,
        };
      } finally {
        Reflect.deleteProperty(agent, "getToken");
      }
    });

    expect(outcome).toEqual({
      result: { ok: false, message: expect.stringMatching(/room access ended/i) },
      recoveryRequested: 0,
      archiveCount: 1,
    });
  });

  it.each(["expired", "revoked"] as const)(
    "rejects an %s connection before dispatching its RPC frame",
    async (condition) => {
      const room = `${condition}-connection-${crypto.randomUUID()}`;
      const email = "member@cloudflare.com";
      const stub = await getAgentByName(env.GlideAgent, room);
      const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
        await agent.activateRoomAccess({
          email,
          subject: `subject:${email}`,
          expiresAt: Math.floor(Date.now() / 1_000) + 300,
        }, true);
        if (condition === "revoked") {
          state.storage.sql.exec("DELETE FROM glide_room_members WHERE email = ?", email);
        }
        const frames: string[] = [];
        const closes: Array<{ code?: number; reason?: string }> = [];
        await agent.onMessage(
          protocolConnection(
            email,
            condition === "expired" ? Math.floor(Date.now() / 1_000) - 1 : Math.floor(Date.now() / 1_000) + 300,
            frames,
            closes,
          ),
          JSON.stringify({ type: "rpc", id: "rpc-1", method: "startOnboarding", args: ["forged actor"] }),
        );
        return { frames, closes, onboarding: agent.state.onboarding };
      });

      expect(result.frames).toEqual([]);
      expect(result.closes).toEqual([{ code: 1008, reason: "Room membership or Access session expired" }]);
      expect(result.onboarding).toBeUndefined();
    },
  );

  it("proactively closes an idle expired connection after hibernation", async () => {
    const room = `idle-expiry-${crypto.randomUUID()}`;
    const email = "idle-member@cloudflare.com";
    expect((await roomAccess(email, room)).status).toBe(200);

    const response = await asAccessUser(email, (headers) => {
      headers.set("Upgrade", "websocket");
      return exports.default.fetch(new Request(agentUrl(room), { headers }));
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for Access expiry close")), 5_000);
      socket.addEventListener("close", (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, reason: event.reason });
      }, { once: true });
    });

    const stub = await getAgentByName(env.GlideAgent, room);
    const scheduled = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connection = [...agent.getConnections()][0];
      if (!connection) throw new Error("Expected an active Agent connection");
      const current = connection.state && typeof connection.state === "object"
        ? connection.state as Record<string, unknown>
        : {};
      connection.setState({
        ...current,
        glideAccessExpiresAt: Math.floor(Date.now() / 1_000) - 1,
      });
      const schedules = (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "expireAccessConnection",
      );
      state.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = 0 WHERE callback = ?",
        "expireAccessConnection",
      );
      return {
        count: schedules.length,
        storedId: current.glideAccessExpiryScheduleId,
        scheduledId: schedules[0]?.id,
      };
    });
    expect(scheduled).toEqual({
      count: 1,
      storedId: scheduled.scheduledId,
      scheduledId: expect.any(String),
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "Room membership or Access session expired",
    });
  });

  it("closes every expired socket when clients reuse a connection id", async () => {
    const room = `duplicate-connection-${crypto.randomUUID()}`;
    const email = "duplicate-member@cloudflare.com";
    expect((await roomAccess(email, room)).status).toBe(200);
    const connectionId = crypto.randomUUID();

    const sockets: WebSocket[] = [];
    for (let index = 0; index < 2; index++) {
      const response = await asAccessUser(email, (headers) => {
        headers.set("Upgrade", "websocket");
        return exports.default.fetch(
          new Request(`${agentUrl(room)}?_pk=${encodeURIComponent(connectionId)}`, { headers }),
        );
      });
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      sockets.push(response.webSocket!);
    }
    const closes = sockets.map((socket) =>
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for duplicate socket close")), 5_000);
        socket.addEventListener("close", (event) => {
          clearTimeout(timeout);
          resolve({ code: event.code, reason: event.reason });
        }, { once: true });
      })
    );

    const stub = await getAgentByName(env.GlideAgent, room);
    const scheduled = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const connections = [...agent.getConnections(connectionId)];
      for (const connection of connections) {
        const current = connection.state && typeof connection.state === "object"
          ? connection.state as Record<string, unknown>
          : {};
        connection.setState({
          ...current,
          glideAccessExpiresAt: Math.floor(Date.now() / 1_000) - 1,
        });
      }
      const schedules = (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "expireAccessConnection",
      );
      state.storage.sql.exec(
        "UPDATE cf_agents_schedules SET time = 0 WHERE id = ?",
        schedules[0]!.id,
      );
      return { connections: connections.length, schedules: schedules.length };
    });
    expect(scheduled).toEqual({ connections: 2, schedules: 2 });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await expect(Promise.all(closes)).resolves.toEqual([
      { code: 1008, reason: "Room membership or Access session expired" },
      { code: 1008, reason: "Room membership or Access session expired" },
    ]);
  });
});
