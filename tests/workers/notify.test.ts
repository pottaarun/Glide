import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

import type { GlideAgent } from "../../src/server";
import { roomStorageName, type GlideState } from "../../src/shared";
import { asAccessUser } from "./access-test-helpers";

const OWNER = "owner@cloudflare.com";
const MEMBER = "member@example.com";
const SECRET_PATH = "supersecrettoken123";
const WEBHOOK = `https://hooks.slack.com/services/T000/B000/${SECRET_PATH}`;

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

async function readState(room: string): Promise<GlideState> {
  const stub = await getAgentByName(env.GlideAgent, requiredStorageRoom(room));
  return runInDurableObject(stub, (agent: GlideAgent) => agent.state as GlideState);
}

type WebhookResult = { ok: boolean; message: string; host?: string };

async function setupRoom(room: string): Promise<void> {
  expect((await roomAccess(OWNER, room)).status).toBe(200);
  expect((await rpcAs<{ ok: boolean }>(OWNER, room, "inviteTeammate", [MEMBER, OWNER])).ok).toBe(true);
}

describe("governance notifications", () => {
  it("only lets the owner configure the webhook", async () => {
    const room = `notify-owner-${crypto.randomUUID()}`;
    await setupRoom(room);
    const asMember = await rpcAs<WebhookResult>(MEMBER, room, "setNotifyWebhook", [WEBHOOK, MEMBER]);
    expect(asMember.ok).toBe(false);
    expect(asMember.message).toMatch(/owner/i);
  });

  it("rejects non-https and SSRF-unsafe webhook URLs", async () => {
    const room = `notify-validate-${crypto.randomUUID()}`;
    await setupRoom(room);
    expect((await rpcAs<WebhookResult>(OWNER, room, "setNotifyWebhook", ["http://hooks.slack.com/x", OWNER])).ok).toBe(false);
    expect((await rpcAs<WebhookResult>(OWNER, room, "setNotifyWebhook", ["https://127.0.0.1/x", OWNER])).ok).toBe(false);
    expect((await rpcAs<WebhookResult>(OWNER, room, "setNotifyWebhook", ["https://localhost/x", OWNER])).ok).toBe(false);
  });

  it("stores the webhook encrypted and never places the secret in synced state", async () => {
    const room = `notify-secret-${crypto.randomUUID()}`;
    await setupRoom(room);

    const set = await rpcAs<WebhookResult>(OWNER, room, "setNotifyWebhook", [WEBHOOK, OWNER]);
    expect(set.ok).toBe(true);
    expect(set.host).toBe("hooks.slack.com");

    const state = await readState(room);
    expect(state.notifyWebhook?.configured).toBe(true);
    expect(state.notifyWebhook?.host).toBe("hooks.slack.com");
    // The secret path must never be exposed in synced state.
    expect(JSON.stringify(state)).not.toContain(SECRET_PATH);

    // Removing it clears the synced flag.
    const cleared = await rpcAs<WebhookResult>(OWNER, room, "setNotifyWebhook", ["", OWNER]);
    expect(cleared.ok).toBe(true);
    expect((await readState(room)).notifyWebhook?.configured).toBe(false);
  });

  it("queues a test event into the in-app notifications feed", async () => {
    const room = `notify-test-${crypto.randomUUID()}`;
    await setupRoom(room);
    // Test before configuring fails cleanly.
    expect((await rpcAs<WebhookResult>(OWNER, room, "testNotifyWebhook", [OWNER])).ok).toBe(false);

    expect((await rpcAs<WebhookResult>(OWNER, room, "setNotifyWebhook", [WEBHOOK, OWNER])).ok).toBe(true);
    const test = await rpcAs<WebhookResult>(OWNER, room, "testNotifyWebhook", [OWNER]);
    expect(test.ok).toBe(true);

    const state = await readState(room);
    expect(state.notifications?.some((n) => n.kind === "test")).toBe(true);
  });
});
