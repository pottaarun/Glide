import { env, exports } from "cloudflare:workers";
import { evictDurableObject, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

import type { GlideAgent } from "../../src/server";

const SYSTEM_ROOM = "__system__";

type GlideStub = DurableObjectStub<GlideAgent>;

async function systemStub(name = SYSTEM_ROOM): Promise<GlideStub> {
  return getAgentByName(env.GlideAgent, name);
}

async function clearDocsSchedules(agent: GlideAgent): Promise<void> {
  for (const schedule of await agent.listSchedules()) {
    if (schedule.callback === "docsTick") await agent.cancelSchedule(schedule.id);
  }
}

async function wakeCoordinator(stub: GlideStub): Promise<void> {
  // getAgentByName() invokes PartyServer setName(), which runs onStart() for a
  // newly-created or evicted instance before returning the native RPC stub.
  await getAgentByName(env.GlideAgent, SYSTEM_ROOM);
  await stub.ensureDocsIndex();
}

async function seedActiveRun(
  stub: GlideStub,
  runId: string,
  queueSeeded: boolean | undefined,
  seedQueue = queueSeeded === true,
): Promise<void> {
  await wakeCoordinator(stub);
  await runInDurableObject(stub, async (agent: GlideAgent, state) => {
    await clearDocsSchedules(agent);
    state.storage.sql.exec("DELETE FROM glide_docs_products");
    state.storage.sql.exec("DELETE FROM glide_docs_pages");
    state.storage.sql.exec("DELETE FROM glide_docs_product_attempts");
    if (seedQueue) {
      state.storage.sql.exec(
        `INSERT INTO glide_docs_products (product, label, url, category, enumerated)
         VALUES (?, ?, ?, ?, 1)`,
        "dns",
        "DNS",
        "https://developers.cloudflare.com/dns/llms.txt",
        "Core",
      );
    }
    agent.setState({
      ...agent.state,
      docsIndex: {
        status: "indexing",
        runId,
        ...(queueSeeded === undefined ? {} : { queueSeeded }),
        productsTotal: seedQueue ? 1 : 0,
        productsEnumerated: seedQueue ? 1 : 0,
        pagesTotal: 0,
        pagesIndexed: 0,
        pagesFailed: 0,
        chunksUpserted: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  });
}

async function inspectRun(stub: GlideStub) {
  return runInDurableObject(stub, async (agent: GlideAgent) => ({
    docsIndex: agent.state.docsIndex,
    schedules: (await agent.listSchedules()).filter((schedule) => schedule.callback === "docsTick"),
  }));
}

describe("reserved docs coordinator routing", () => {
  it.each([
    ["HTTP", {}],
    ["WebSocket", { headers: { Upgrade: "websocket" } }],
  ])("returns 404 before the %s request reaches the system Agent", async (_kind, init) => {
    const response = await exports.default.fetch(
      new Request(`https://example.com/agents/glide-agent/${SYSTEM_ROOM}`, init),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const ids = await listDurableObjectIds(env.GlideAgent);
    const systemId = env.GlideAgent.idFromName(SYSTEM_ROOM);
    expect(ids.some((id) => id.equals(systemId))).toBe(false);
  });

  it("also rejects coordinator methods on ordinary room stubs", async () => {
    const result = await (await systemStub("ordinary-room")).startDocsReindex("test");
    expect(result).toEqual({ ok: false, message: "The docs reindex coordinator is internal-only." });
  });
});

describe("docs reindex recovery", () => {
  it("re-arms a missing tick after eviction without accumulating duplicates", async () => {
    const stub = await systemStub();
    const runId = "run-recover";
    await seedActiveRun(stub, runId, true);

    await evictDurableObject(stub);
    await wakeCoordinator(stub);
    const firstWake = await inspectRun(stub);
    expect(firstWake.docsIndex?.status).toBe("indexing");
    expect(firstWake.docsIndex?.queueSeeded).toBe(true);
    expect(firstWake.schedules).toHaveLength(1);
    expect(firstWake.schedules[0]?.payload).toEqual({ runId });

    await evictDurableObject(stub);
    await wakeCoordinator(stub);
    const secondWake = await inspectRun(stub);
    expect(secondWake.schedules).toHaveLength(1);
    expect(secondWake.schedules[0]?.id).toBe(firstWake.schedules[0]?.id);
  });

  it("terminalizes an active run whose durable queue handoff never completed", async () => {
    const stub = await systemStub();
    await seedActiveRun(stub, "run-unseeded", false);

    await evictDurableObject(stub);
    await wakeCoordinator(stub);
    const recovered = await inspectRun(stub);
    expect(recovered.docsIndex?.status).toBe("error");
    expect(recovered.docsIndex?.error).toMatch(/before its work queue was ready/i);
    expect(recovered.schedules).toHaveLength(0);
  });

  it("does not trust a populated legacy queue without the durable handoff marker", async () => {
    const stub = await systemStub();
    await seedActiveRun(stub, "run-legacy-partial", undefined, true);

    await evictDurableObject(stub);
    await wakeCoordinator(stub);
    const recovered = await inspectRun(stub);
    expect(recovered.docsIndex?.status).toBe("error");
    expect(recovered.schedules).toHaveLength(0);
  });

  it("replaces the executing one-shot row with one successor tick", async () => {
    const stub = await systemStub();
    const runId = "run-chain";
    await wakeCoordinator(stub);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      await clearDocsSchedules(agent);
      state.storage.sql.exec("DELETE FROM glide_docs_products");
      state.storage.sql.exec("DELETE FROM glide_docs_pages");
      state.storage.sql.exec(
        `INSERT INTO glide_docs_products (product, label, url, category, enumerated)
         VALUES (?, ?, ?, ?, 0)`,
        "dns",
        "DNS",
        "https://developers.cloudflare.com/dns/llms.txt",
        "Core",
      );
      agent.setState({
        ...agent.state,
        docsIndex: {
          status: "enumerating",
          runId,
          queueSeeded: true,
          productsTotal: 1,
          productsEnumerated: 0,
          pagesTotal: 0,
          pagesIndexed: 0,
          pagesFailed: 0,
          chunksUpserted: 0,
        },
      });
      const executing = await agent.schedule(60, "docsTick", { runId });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          "## Reference\n- [DNS records](https://developers.cloudflare.com/dns/manage-dns-records/index.md)",
        )) as typeof fetch;
      try {
        await agent.docsTick({ runId });
      } finally {
        globalThis.fetch = originalFetch;
      }
      const schedules = (await agent.listSchedules()).filter((schedule) => schedule.callback === "docsTick");
      const pages = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM glide_docs_pages").one().n;
      return { executingId: executing.id, schedules, pages, docsIndex: agent.state.docsIndex };
    });

    expect(result.pages).toBe(1);
    expect(result.docsIndex?.status).toBe("enumerating");
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]?.id).not.toBe(result.executingId);
    expect(result.schedules[0]?.payload).toEqual({ runId });
  });
});
