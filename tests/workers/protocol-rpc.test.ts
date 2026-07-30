import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { asAccessUser } from "./access-test-helpers";

describe("Agent WebSocket protocol", () => {
  it("delegates valid callable RPC frames to the Agents SDK", async () => {
    const room = `rpc-${crypto.randomUUID()}`;
    const access = await asAccessUser("rpc-test@cloudflare.com", (headers) =>
      exports.default.fetch(new Request(
        `https://example.com/api/room-access?room=${encodeURIComponent(room)}`,
        { headers, method: "POST" },
      )));
    expect(access.status).toBe(200);
    const response = await asAccessUser("rpc-test@cloudflare.com", async (headers) => {
      headers.set("Upgrade", "websocket");
      return exports.default.fetch(
        new Request(`https://example.com/agents/glide-agent/${room}`, { headers }),
      );
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    socket!.accept();

    const reply = new Promise<Record<string, unknown>>((resolve) => {
      socket!.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.type === "rpc" && message.id === "rpc-1") resolve(message);
      });
    });
    socket!.send(JSON.stringify({ type: "rpc", id: "rpc-1", method: "startOnboarding", args: ["test"] }));

    await expect(reply).resolves.toMatchObject({
      type: "rpc",
      id: "rpc-1",
      success: true,
      result: { ok: true },
    });
    socket!.close(1000, "done");
  });
});
