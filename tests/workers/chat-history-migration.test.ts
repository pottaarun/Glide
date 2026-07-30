import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName, type Connection } from "agents";

import {
  requestWithAccessIdentity,
  type AccessIdentity,
} from "../../src/access-auth";
import type { GlideAgent } from "../../src/server";
import { LEGACY_CHAT_RECOVERY_CONFIRMATION } from "../../src/shared";

type GlideStub = DurableObjectStub<GlideAgent>;
type StoredMessage = { id: string; role: "user" | "assistant"; text?: string };

const LEGACY_TOKEN = "legacy_unprefixed_token_abcdefghijklmnopqrstuvwxyz";

function serializedMessage(message: StoredMessage): string {
  return JSON.stringify({
    id: message.id,
    role: message.role,
    parts: [{ type: "text", text: message.text ?? `${message.role} ${message.id}` }],
  });
}

function chatRequestFrame(requestId: string, messageId: string, text: string): string {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id: requestId,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [{ id: messageId, role: "user", parts: [{ type: "text", text }] }],
        trigger: "submit-message",
        name: "migration-test",
        clientTools: [],
      }),
    },
  });
}

async function authorizeMigrationTest(agent: GlideAgent): Promise<AccessIdentity> {
  const identity: AccessIdentity = {
    email: "migration-test@cloudflare.com",
    subject: "migration-test-subject",
    expiresAt: Math.floor(Date.now() / 1_000) + 300,
  };
  const authorization = await agent.activateRoomAccess(identity, true);
  if (!authorization.allowed) throw new Error("Could not authorize the migration test member");
  return identity;
}

function authenticatedRequest(identity: AccessIdentity): Request {
  return requestWithAccessIdentity(new Request("https://example.com/get-messages"), identity);
}

function authenticatedConnection(identity: AccessIdentity, frames: string[]): Connection {
  return {
    id: crypto.randomUUID(),
    server: "test",
    state: {
      glideAccessEmail: identity.email,
      glideAccessSubjectDigest: `access-subject:${"a".repeat(64)}`,
      glideAccessExpiresAt: identity.expiresAt,
      glideClientRateLimitKey: `client:${"a".repeat(64)}`,
    },
    setState() {},
    send(frame: string | ArrayBuffer) {
      if (typeof frame === "string") frames.push(frame);
    },
    close() {},
  } as unknown as Connection;
}

async function seedLegacyHistory(room: string, messages: StoredMessage[]): Promise<GlideStub> {
  const stub = await getAgentByName(env.GlideAgent, room);
  await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
    state.storage.sql.exec("DROP TRIGGER IF EXISTS glide_record_accepted_user_message_id");
    state.storage.sql.exec("DROP TRIGGER IF EXISTS glide_record_chat_message_id_tombstone");
    state.storage.sql.exec("DELETE FROM cf_ai_chat_agent_messages");
    state.storage.sql.exec("DELETE FROM glide_assistant_events");
    state.storage.sql.exec("DELETE FROM glide_chat_migrations");
    state.storage.sql.exec("DELETE FROM glide_accepted_user_message_ids");
    state.storage.sql.exec("DROP TABLE IF EXISTS glide_chat_message_id_tombstones");
    state.storage.sql.exec("DROP TABLE IF EXISTS glide_legacy_chat_quarantine");
    state.storage.sql.exec("DROP TABLE IF EXISTS glide_chat_migration_progress");
    for (const message of messages) {
      state.storage.sql.exec(
        "INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)",
        message.id,
        serializedMessage(message),
      );
    }
  });
  return stub;
}

async function seedCurrentHistory(room: string, messages: StoredMessage[]): Promise<GlideStub> {
  const stub = await getAgentByName(env.GlideAgent, room);
  await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
    state.storage.sql.exec("DELETE FROM cf_ai_chat_agent_messages");
    state.storage.sql.exec("DELETE FROM glide_legacy_chat_quarantine");
    state.storage.sql.exec("DELETE FROM glide_accepted_user_message_ids");
    state.storage.sql.exec("DELETE FROM glide_chat_message_id_tombstones");
    for (const message of messages) {
      state.storage.sql.exec(
        "INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)",
        message.id,
        serializedMessage(message),
      );
    }
  });
  return stub;
}

async function setToken(stub: GlideStub, token: string): Promise<void> {
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
  expect(result.ok).toBe(true);
}

async function wake(room: string, stub: GlideStub): Promise<GlideStub> {
  await evictDurableObject(stub);
  return getAgentByName(env.GlideAgent, room);
}

async function runDueMigrationAlarm(stub: GlideStub): Promise<void> {
  await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
    state.storage.sql.exec(
      "UPDATE cf_agents_schedules SET time = 0 WHERE callback = ?",
      "continueLegacyChatMigration",
    );
  });
  await runDurableObjectAlarm(stub);
}

describe("legacy chat history migration", () => {
  it("swaps and archives the pre-upgrade transcript idempotently", async () => {
    const room = `chat-migration-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
      { id: "user-2", role: "user" },
      { id: "assistant-2", role: "assistant" },
    ]);

    stub = await wake(room, stub);
    const first = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      activeCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
      ).one().count,
      archive: state.storage.sql.exec<{ id: string; reason: string }>(
        "SELECT id, reason FROM glide_legacy_chat_quarantine ORDER BY id",
      ).toArray(),
      acceptedCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_accepted_user_message_ids",
      ).one().count,
      migrationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_chat_migrations",
      ).one().count,
      inMemoryCount: agent.messages.length,
    }));
    expect(first).toEqual({
      activeCount: 0,
      archive: [
        { id: "assistant-1", reason: "unverified_legacy_assistant" },
        { id: "assistant-2", reason: "unverified_legacy_assistant" },
        { id: "user-1", reason: "legacy_transcript" },
        { id: "user-2", reason: "legacy_transcript" },
      ],
      acceptedCount: 2,
      migrationCount: 1,
      inMemoryCount: 0,
    });

    stub = await wake(room, stub);
    const second = await runInDurableObject(stub, async (_agent: GlideAgent, state) => ({
      activeCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
      ).one().count,
      archiveCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine",
      ).one().count,
      migrationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_chat_migrations",
      ).one().count,
    }));
    expect(second).toEqual({ activeCount: 0, archiveCount: 4, migrationCount: 1 });
  });

  it("redacts the exact room token before completing the archive", async () => {
    const room = `chat-quarantine-redaction-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, [
      { id: "assistant-token", role: "assistant", text: `Stored token: ${LEGACY_TOKEN}` },
      { id: "user-1", role: "user" },
    ]);
    await setToken(stub, LEGACY_TOKEN);

    stub = await wake(room, stub);
    const archived = await runInDurableObject(stub, async (_agent: GlideAgent, state) =>
      state.storage.sql.exec<{ message: string; reason: string; redacted_at: number }>(
        "SELECT message, reason, redacted_at FROM glide_legacy_chat_quarantine WHERE id = ?",
        "assistant-token",
      ).one());
    expect(archived.reason).toBe("unverified_legacy_assistant");
    expect(archived.message).not.toContain(LEGACY_TOKEN);
    expect(archived.message).toContain("Cloudflare API token redacted");
    expect(archived.redacted_at).toBeGreaterThan(0);
  });

  it("does not trust stale provenance attached to a legacy assistant", async () => {
    const room = `chat-stale-provenance-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, [
      { id: "legacy-user", role: "user" },
      { id: "legacy-assistant", role: "assistant" },
    ]);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        "INSERT INTO glide_assistant_events (id, response_to, ts) VALUES (?, ?, ?)",
        "legacy-assistant",
        "legacy-user",
        Date.now(),
      );
    });

    stub = await wake(room, stub);
    const result = await runInDurableObject(stub, async (_agent: GlideAgent, state) => ({
      reason: state.storage.sql.exec<{ reason: string }>(
        "SELECT reason FROM glide_legacy_chat_quarantine WHERE id = 'legacy-assistant'",
      ).one().reason,
      eventCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_assistant_events",
      ).one().count,
    }));
    expect(result).toEqual({ reason: "unverified_legacy_assistant", eventCount: 0 });
  });

  it("keeps a redacted archive, blocks reads, and retries in the same activation", async () => {
    const room = `chat-migration-failure-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, [
      { id: "assistant-fail", role: "assistant" },
      { id: "user-fail", role: "user" },
    ]);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_assistant_provenance_migration
        BEFORE INSERT ON glide_chat_migrations
        BEGIN
          SELECT RAISE(ABORT, 'forced migration failure');
        END
      `);
    });

    stub = await wake(room, stub);
    const failed = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const identity = await authorizeMigrationTest(agent);
      const blocked = await agent.onRequest(authenticatedRequest(identity));
      const result = {
        blockedStatus: blocked.status,
        activeCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
        ).one().count,
        archivedCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE redacted_at IS NOT NULL",
        ).one().count,
        migrationCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_chat_migrations",
        ).one().count,
      };
      state.storage.sql.exec("DROP TRIGGER fail_assistant_provenance_migration");
      state.storage.sql.exec(`
        CREATE TRIGGER fail_legacy_archive_rescan
        BEFORE UPDATE ON glide_legacy_chat_quarantine
        BEGIN
          SELECT RAISE(ABORT, 'legacy archive was rescanned');
        END
      `);
      return result;
    });
    expect(failed).toEqual({ blockedStatus: 503, activeCount: 0, archivedCount: 2, migrationCount: 0 });

    const recovered = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const identity = await authorizeMigrationTest(agent);
      await agent.continueLegacyChatMigration();
      const history = await agent.onRequest(authenticatedRequest(identity));
      return {
        historyStatus: history.status,
        cacheControl: history.headers.get("cache-control"),
        migrationCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_chat_migrations",
        ).one().count,
        migrationSchedules: (await agent.listSchedules()).filter(
          (schedule) => schedule.callback === "continueLegacyChatMigration",
        ).length,
      };
    });
    expect(recovered).toEqual({
      historyStatus: 200,
      cacheControl: "private, no-store",
      migrationCount: 1,
      migrationSchedules: 0,
    });
  });

  it("offers explicit archive-discard recovery when the old token cannot decrypt", async () => {
    const room = `chat-migration-token-failure-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, [
      { id: "assistant-secret", role: "assistant", text: "Unrecoverable room secret" },
      { id: "user-secret", role: "user" },
    ]);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO glide_secrets (name, value, ts) VALUES (?, ?, ?)",
        "cf_api_token",
        "malformed-ciphertext",
        Date.now(),
      );
    });

    stub = await wake(room, stub);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const identity = await authorizeMigrationTest(agent);
      const blocked = await agent.onRequest(authenticatedRequest(identity));
      const blockedBody = await blocked.json<{
        code: string;
        error: string;
        message: string;
        status: string;
        recoveryAllowed: boolean;
        recoveryConfirmation: string;
      }>();
      const before = await agent.legacyChatMigrationStatus();
      const rejectedFrames: string[] = [];
      await agent.onMessage(
        authenticatedConnection(identity, rejectedFrames),
        chatRequestFrame("blocked-request", "blocked-user", "This must not be persisted."),
      );
      const rejected = await agent.discardLegacyChatArchiveForRecovery("wrong confirmation");
      const recovered = await agent.discardLegacyChatArchiveForRecovery(LEGACY_CHAT_RECOVERY_CONFIRMATION);
      const history = await agent.onRequest(authenticatedRequest(identity));
      const after = await agent.legacyChatMigrationStatus();
      const replayFrames: string[] = [];
      await agent.onMessage(
        authenticatedConnection(identity, replayFrames),
        chatRequestFrame("replay-request", "user-secret", "Replay the discarded legacy id."),
      );
      const cleared = await agent.clearCloudflareToken();
      return {
        blockedStatus: blocked.status,
        blockedBody,
        blockedChat: JSON.parse(rejectedFrames[0] ?? "null") as { body?: string; error?: boolean },
        replayChat: JSON.parse(replayFrames[0] ?? "null") as { body?: string; error?: boolean },
        before: before.status,
        rejected: rejected.ok,
        recovered: recovered.ok,
        after: after.status,
        historyStatus: history.status,
        cleared: cleared.ok,
        archiveCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine",
        ).one().count,
        migrationCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_chat_migrations",
        ).one().count,
        tombstoneCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_chat_message_id_tombstones",
        ).one().count,
        activeCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
        ).one().count,
      };
    });
    expect(result).toEqual({
      blockedStatus: 503,
      blockedBody: {
        code: "legacy_chat_migration_incomplete",
        error: "The legacy archive cannot be redacted because the room token cannot be decrypted.",
        message: "The legacy archive cannot be redacted because the room token cannot be decrypted.",
        status: "recovery_required",
        recoveryAllowed: true,
        recoveryConfirmation: LEGACY_CHAT_RECOVERY_CONFIRMATION,
      },
      blockedChat: {
        body: "Chat history migration must finish before sending messages.",
        done: true,
        error: true,
        id: "blocked-request",
        type: "cf_agent_use_chat_response",
      },
      replayChat: {
        body: "New chat message has already been accepted.",
        done: true,
        error: true,
        id: "replay-request",
        type: "cf_agent_use_chat_response",
      },
      before: "recovery_required",
      rejected: false,
      recovered: true,
      after: "ready",
      historyStatus: 200,
      cleared: true,
      archiveCount: 0,
      migrationCount: 1,
      tombstoneCount: 2,
      activeCount: 0,
    });
  });

  it("discards an unrecoverable archive in bounded batches while preserving retention rows and tombstones", async () => {
    const room = `chat-bounded-recovery-${crypto.randomUUID()}`;
    const messages = Array.from({ length: 120 }, (_, index) => ({
      id: `recover-user-${String(index).padStart(3, "0")}`,
      role: "user" as const,
    }));
    let stub = await seedLegacyHistory(room, messages);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO glide_secrets (name, value, ts) VALUES (?, ?, ?)",
        "cf_api_token",
        "malformed-ciphertext",
        Date.now(),
      );
    });

    stub = await wake(room, stub);
    const first = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO glide_legacy_chat_quarantine
          (id, message, created_at, reason, quarantined_at, redacted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "retained-current-message",
        serializedMessage({ id: "retained-current-message", role: "assistant" }),
        null,
        "retention_limit",
        now,
        now,
      );
      const recovery = await agent.discardLegacyChatArchiveForRecovery(LEGACY_CHAT_RECOVERY_CONFIRMATION);
      const status = await agent.legacyChatMigrationStatus();
      return {
        recovery: recovery.ok,
        status: status.status,
        legacyCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE reason IS NULL OR reason <> 'retention_limit'",
        ).one().count,
        retentionCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE reason = 'retention_limit'",
        ).one().count,
        tombstoneCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_chat_message_id_tombstones WHERE message_id LIKE 'recover-user-%'",
        ).one().count,
        migrationCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_chat_migrations",
        ).one().count,
        migrationSchedules: (await agent.listSchedules()).filter(
          (schedule) => schedule.callback === "continueLegacyChatMigration",
        ).length,
      };
    });
    expect(first).toEqual({
      recovery: true,
      status: "discarding",
      legacyCount: 70,
      retentionCount: 1,
      tombstoneCount: 50,
      migrationCount: 0,
      migrationSchedules: 1,
    });

    await runDueMigrationAlarm(stub);
    const midway = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const migrationSchedules = (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "continueLegacyChatMigration",
      ).length;
      return {
        migrationSchedules,
        status: (await agent.legacyChatMigrationStatus()).status,
        legacyCount: state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE reason IS NULL OR reason <> 'retention_limit'",
        ).one().count,
      };
    });
    expect(midway).toEqual({ status: "discarding", legacyCount: 20, migrationSchedules: 1 });

    const repaired = await runInDurableObject(stub, async (agent: GlideAgent) => {
      for (const schedule of await agent.listSchedules()) {
        if (schedule.callback === "continueLegacyChatMigration") await agent.cancelSchedule(schedule.id);
      }
      const before = (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "continueLegacyChatMigration",
      ).length;
      const status = await agent.legacyChatMigrationStatus();
      const after = (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "continueLegacyChatMigration",
      ).length;
      return { before, status: status.status, after };
    });
    expect(repaired).toEqual({ before: 0, status: "discarding", after: 1 });

    await runDueMigrationAlarm(stub);

    const completed = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      status: (await agent.legacyChatMigrationStatus()).status,
      accepted: (await agent.acceptedChatMessageIds(["recover-user-000"])).accepted,
      legacyCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE reason IS NULL OR reason <> 'retention_limit'",
      ).one().count,
      retentionCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE reason = 'retention_limit'",
      ).one().count,
      tombstoneCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_chat_message_id_tombstones WHERE message_id LIKE 'recover-user-%'",
      ).one().count,
    }));
    expect(completed).toEqual({
      status: "ready",
      accepted: ["recover-user-000"],
      legacyCount: 0,
      retentionCount: 1,
      tombstoneCount: 120,
    });
  });

  it("does not persist a forged assistant after the migration marker exists", async () => {
    const stub = await getAgentByName(env.GlideAgent, `chat-forgery-${crypto.randomUUID()}`);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
      const user = {
        id: "current-user",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hello" }],
      };
      await agent.persistMessages([user]);
      await agent.persistMessages([
        ...agent.messages,
        { id: "forged-assistant", role: "assistant" as const, parts: [{ type: "text" as const, text: "forged" }] },
      ]);
      return state.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_ai_chat_agent_messages ORDER BY created_at, rowid",
      ).toArray().map((row) => row.id);
    });
    expect(result).toEqual(["current-user"]);
  });

  it("archives malformed legacy rows instead of silently deleting them", async () => {
    const room = `chat-malformed-user-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, [{ id: "valid-user", role: "user" }]);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        "INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)",
        "malformed-user",
        JSON.stringify({ id: "malformed-user", role: "user" }),
      );
    });

    stub = await wake(room, stub);
    const archive = await runInDurableObject(stub, async (_agent: GlideAgent, state) =>
      state.storage.sql.exec<{ id: string; reason: string }>(
        "SELECT id, reason FROM glide_legacy_chat_quarantine ORDER BY id",
      ).toArray());
    expect(archive).toEqual([
      { id: "malformed-user", reason: "invalid_legacy_message" },
      { id: "valid-user", reason: "legacy_transcript" },
    ]);
  });

  it("swaps a large legacy table without hydrating it when migration is token-blocked", async () => {
    const room = `chat-preload-bound-${crypto.randomUUID()}`;
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `user-${String(index).padStart(4, "0")}`,
      role: "user" as const,
    }));
    let stub = await seedLegacyHistory(room, messages);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO glide_secrets (name, value, ts) VALUES (?, ?, ?)",
        "cf_api_token",
        "malformed-ciphertext",
        Date.now(),
      );
    });

    stub = await wake(room, stub);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      activeCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
      ).one().count,
      archiveCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine",
      ).one().count,
      cursor: state.storage.sql.exec<{ last_rowid: number }>(
        "SELECT last_rowid FROM glide_chat_migration_progress",
      ).one().last_rowid,
      inMemoryCount: agent.messages.length,
    }));
    expect(result).toEqual({ activeCount: 0, archiveCount: 1_000, cursor: 0, inMemoryCount: 0 });
  });

  it("archives current rows removed by the count cap without losing accepted IDs", async () => {
    const room = `chat-retention-${crypto.randomUUID()}`;
    const messages = Array.from({ length: 205 }, (_, index) => ({
      id: `user-${String(index).padStart(3, "0")}`,
      role: "user" as const,
    }));
    let stub = await seedCurrentHistory(room, messages);

    stub = await wake(room, stub);
    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      activeCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
      ).one().count,
      archivedCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE reason = 'retention_limit'",
      ).one().count,
      acceptedCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_accepted_user_message_ids",
      ).one().count,
      recoveryAllowed: (await agent.discardLegacyChatArchiveForRecovery(LEGACY_CHAT_RECOVERY_CONFIRMATION)).ok,
    }));
    expect(result).toEqual({ activeCount: 200, archivedCount: 5, acceptedCount: 205, recoveryAllowed: false });
  });

  it("continues byte-bounded archive redaction through Durable Object alarms", async () => {
    const room = `chat-staged-batches-${crypto.randomUUID()}`;
    const messages = Array.from({ length: 8 }, (_, index) => ({
      id: `batch-user-${String(index).padStart(2, "0")}`,
      role: "user" as const,
      text: "x".repeat(900_000),
    }));
    let stub = await seedLegacyHistory(room, messages);

    stub = await wake(room, stub);
    const first = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      pendingCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE redacted_at IS NULL",
      ).one().count,
      migrationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_chat_migrations",
      ).one().count,
      migrationSchedules: (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "continueLegacyChatMigration",
      ).length,
    }));
    expect(first.pendingCount).toBeGreaterThan(0);
    expect(first.migrationCount).toBe(0);
    expect(first.migrationSchedules).toBe(1);

    await evictDurableObject(stub);
    await runDueMigrationAlarm(stub);
    const afterAlarm = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      pendingCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE redacted_at IS NULL",
      ).one().count,
      migrationSchedules: (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "continueLegacyChatMigration",
      ).length,
    }));
    expect(afterAlarm.pendingCount).toBeLessThan(first.pendingCount);
    expect(afterAlarm.migrationSchedules).toBe(1);

    for (let step = 0; step < 8; step += 1) {
      const complete = await runInDurableObject(stub, async (agent: GlideAgent, state) => {
        await agent.continueLegacyChatMigration();
        return state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM glide_chat_migrations",
        ).one().count === 1;
      });
      if (complete) break;
    }

    const result = await runInDurableObject(stub, async (agent: GlideAgent, state) => ({
      pendingCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE redacted_at IS NULL",
      ).one().count,
      archiveCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine",
      ).one().count,
      acceptedCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_accepted_user_message_ids",
      ).one().count,
      migrationCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_chat_migrations",
      ).one().count,
      migrationSchedules: (await agent.listSchedules()).filter(
        (schedule) => schedule.callback === "continueLegacyChatMigration",
      ).length,
    }));
    expect(result).toEqual({
      pendingCount: 0,
      archiveCount: 8,
      acceptedCount: 8,
      migrationCount: 1,
      migrationSchedules: 0,
    });
  });

  it("archives current rows removed by the byte cap", async () => {
    const room = `chat-byte-retention-${crypto.randomUUID()}`;
    const messages = Array.from({ length: 200 }, (_, index) => ({
      id: `large-user-${String(index).padStart(3, "0")}`,
      role: "user" as const,
      text: "x".repeat(20_000),
    }));
    let stub = await seedCurrentHistory(room, messages);

    stub = await wake(room, stub);
    const result = await runInDurableObject(stub, async (_agent: GlideAgent, state) => ({
      active: state.storage.sql.exec<{ count: number; bytes: number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(message AS BLOB))), 0) AS bytes
         FROM cf_ai_chat_agent_messages`,
      ).one(),
      archivedCount: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM glide_legacy_chat_quarantine WHERE reason = 'retention_limit'",
      ).one().count,
    }));
    expect(result.active.count).toBeLessThan(200);
    expect(result.active.bytes + result.active.count + 1).toBeLessThanOrEqual(4_000_000);
    expect(result.archivedCount).toBe(200 - result.active.count);
  });

  it("replaces an oversized legacy archive body with a bounded placeholder", async () => {
    const room = `chat-oversized-archive-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, [
      { id: "oversized-user", role: "user", text: "x".repeat(1_850_000) },
    ]);

    stub = await wake(room, stub);
    const archived = await runInDurableObject(stub, async (_agent: GlideAgent, state) =>
      state.storage.sql.exec<{ message: string; reason: string }>(
        "SELECT message, reason FROM glide_legacy_chat_quarantine WHERE id = 'oversized-user'",
      ).one());
    expect(archived.reason).toBe("oversized_legacy_message");
    expect(archived.message).toContain("oversized legacy message omitted");
  });

  it("uses a bounded placeholder when redaction expands an otherwise bounded legacy row", async () => {
    const room = `chat-redaction-expansion-${crypto.randomUUID()}`;
    const recognizedToken = `cfat_${"a".repeat(20)}`;
    let stub = await seedLegacyHistory(room, [
      { id: "expanding-token-row", role: "user", text: `${recognizedToken} `.repeat(65_000) },
    ]);

    stub = await wake(room, stub);
    const archived = await runInDurableObject(stub, async (_agent: GlideAgent, state) =>
      state.storage.sql.exec<{ message_bytes: number; message: string; reason: string }>(
        `SELECT
          length(CAST(message AS BLOB)) AS message_bytes,
          message,
          reason
         FROM glide_legacy_chat_quarantine`,
      ).one());
    expect(archived.message_bytes).toBeLessThan(1_000);
    expect(archived.message).toContain("oversized legacy message omitted");
    expect(archived.reason).toBe("oversized_legacy_message");
  });

  it("does not materialize a pathological legacy id or oversized body into the rewritten archive payload", async () => {
    const room = `chat-pathological-id-${crypto.randomUUID()}`;
    let stub = await seedLegacyHistory(room, []);
    const legacyId = "x".repeat(50_000);
    await runInDurableObject(stub, async (_agent: GlideAgent, state) => {
      state.storage.sql.exec(
        "INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)",
        legacyId,
        serializedMessage({ id: legacyId, role: "user", text: "x".repeat(1_755_000) }),
      );
    });

    stub = await wake(room, stub);
    const archived = await runInDurableObject(stub, async (_agent: GlideAgent, state) =>
      state.storage.sql.exec<{ id_bytes: number; message_bytes: number; message: string; reason: string }>(
        `SELECT
          length(CAST(id AS BLOB)) AS id_bytes,
          length(CAST(message AS BLOB)) AS message_bytes,
          message,
          reason
         FROM glide_legacy_chat_quarantine`,
      ).one());
    expect(archived.id_bytes).toBe(50_000);
    expect(archived.message_bytes).toBeLessThan(1_000);
    expect(archived.message).toContain("legacy-row-");
    expect(archived.reason).toBe("oversized_legacy_message");
  });
});
