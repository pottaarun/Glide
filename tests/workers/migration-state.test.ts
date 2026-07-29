import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

import type { GlideAgent } from "../../src/server";

describe("migration selection state", () => {
  it("clears a stale plan and source when the provider changes", async () => {
    const stub = await getAgentByName(env.GlideAgent, `migration-provider-${crypto.randomUUID()}`);
    await stub.startOnboarding("test");
    await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      agent.setState({
        ...agent.state,
        onboarding: {
          active: true,
          path: "migrate",
          migratingFrom: "akamai",
          migratingFromLabel: "Akamai",
          configProvided: true,
          goals: [],
          checklist: [
            { id: "preview", label: "Preview", done: true },
            { id: "migrate", label: "Migrate", done: true },
          ],
        },
        migrationPlan: {
          provider: "akamai",
          providerLabel: "Akamai",
          totalRules: 1,
          phases: [{ key: "waf", label: "WAF", count: 1 }],
          rules: [{ name: "Block", type: "waf_custom", phase: "waf", phaseLabel: "WAF", queued: true }],
          sourceRevision: "source-1",
          createdBy: "test",
          ts: Date.now(),
        },
      });
      state.storage.sql.exec(
        "INSERT INTO glide_migration_src (id, provider, data, ts) VALUES (?, ?, ?, ?)",
        "source-1",
        "akamai",
        "{}",
        Date.now(),
      );
    });

    expect(await stub.updateOnboarding({ migratingFrom: "fastly" }, "test")).toEqual({ ok: true });
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      onboarding: agent.state.onboarding,
      migrationPlan: agent.state.migrationPlan,
      sourceCount: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM glide_migration_src").one().count,
    }));

    expect(result.migrationPlan).toBeUndefined();
    expect(result.onboarding?.migratingFrom).toBe("fastly");
    expect(result.onboarding?.migratingFromLabel).toBeUndefined();
    expect(result.onboarding?.configProvided).toBe(false);
    expect(result.onboarding?.checklist.find((step) => step.id === "preview")?.done).toBe(false);
    expect(result.onboarding?.checklist.find((step) => step.id === "migrate")?.done).toBe(false);
    expect(result.sourceCount).toBe(0);
  });
});
