import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { GlideAgent } from "../../src/server";
import { roomStorageName, type RoomAuditEntry } from "../../src/shared";
import { asAccessUser } from "./access-test-helpers";

const OWNER = "owner@cloudflare.com";
const EMPLOYEE = "inspector@cloudflare.com";
const OUTSIDER = "outsider@example.com";

function requiredStorageRoom(room: string): string {
  const storageRoom = roomStorageName(room);
  if (!storageRoom) throw new Error(`Invalid test room: ${room}`);
  return storageRoom;
}

function agentUrl(room: string): string {
  return `https://example.com/agents/glide-agent/${requiredStorageRoom(room)}`;
}

/** Activate a room as its owner (creates the owner membership). */
async function createRoom(room: string): Promise<void> {
  const res = await asAccessUser(OWNER, (headers) => {
    headers.set("Origin", "https://example.com");
    return exports.default.fetch(
      new Request(`https://example.com/api/room-access?room=${encodeURIComponent(room)}`, {
        headers,
        method: "POST",
      }),
    );
  });
  expect(res.status).toBe(200);
}

async function roomInspect(email: string, room: string): Promise<Response> {
  return asAccessUser(email, (headers) => {
    headers.set("Origin", "https://example.com");
    return exports.default.fetch(
      new Request(`https://example.com/api/room-inspect?room=${encodeURIComponent(room)}`, {
        headers,
        method: "POST",
      }),
    );
  });
}

/** Read the room's persisted audit trail via the DO's internal reader. */
async function auditEntries(room: string): Promise<RoomAuditEntry[]> {
  const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
  return runInDurableObject(stub, async (agent: GlideAgent) =>
    (agent as unknown as { roomAuditEntries(limit: number): RoomAuditEntry[] }).roomAuditEntries(1000),
  );
}

describe("room inspection (read-only admin for employees)", () => {
  it("gives a member normal access and no snapshot (they use the live socket)", async () => {
    const room = `inspect-member-${crypto.randomUUID()}`;
    await createRoom(room);

    const res = await roomInspect(OWNER, room);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ email: OWNER, role: "owner", entry: "member" });
    expect(body.snapshot).toBeUndefined();
  });

  it("gives a non-member Cloudflare employee an audited read-only snapshot", async () => {
    const room = `inspect-employee-${crypto.randomUUID()}`;
    await createRoom(room);

    const res = await roomInspect(EMPLOYEE, room);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      role: string;
      entry: string;
      snapshot?: { state?: unknown; messages?: unknown; audit?: unknown };
    };
    expect(body).toMatchObject({ email: EMPLOYEE, role: "inspector", entry: "inspect" });
    expect(body.snapshot).toBeTruthy();
    expect(body.snapshot!.state && typeof body.snapshot!.state === "object").toBe(true);
    expect(Array.isArray(body.snapshot!.messages)).toBe(true);
    expect(Array.isArray(body.snapshot!.audit)).toBe(true);

    // The inspection itself is recorded in the audit trail.
    const audit = body.snapshot!.audit as RoomAuditEntry[];
    const inspectEntry = audit.find((e) => e.action === "inspect");
    expect(inspectEntry).toBeTruthy();
    expect(inspectEntry!.actor).toBe(EMPLOYEE);
  });

  it("denies a non-member who is not a Cloudflare employee", async () => {
    const room = `inspect-outsider-${crypto.randomUUID()}`;
    await createRoom(room);

    const res = await roomInspect(OUTSIDER, room);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("room_membership_required");
  });

  it("treats a never-activated room as non-existent (no junk room, no snapshot)", async () => {
    const room = `inspect-missing-${crypto.randomUUID()}`;
    // No createRoom(): the room has never been activated.
    const res = await roomInspect(EMPLOYEE, room);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("room_membership_required");
    expect(body.message ?? "").toMatch(/does not exist/i);
  });

  it("persists the inspect entry in the room's audit trail", async () => {
    const room = `inspect-audit-${crypto.randomUUID()}`;
    await createRoom(room);
    expect((await roomInspect(EMPLOYEE, room)).status).toBe(200);

    const entries = await auditEntries(room);
    const inspectEntry = entries.find((e) => e.action === "inspect" && e.actor === EMPLOYEE);
    expect(inspectEntry).toBeTruthy();
  });
});
