import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  backfillAcceptedChatMessageLedger,
  initializeAcceptedChatMessageLedger,
} from "../src/chat-message-ledger.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE cf_ai_chat_agent_messages (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE glide_system_events (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      ts INTEGER
    );
  `);
  return db;
}

function message(id: string, role: "user" | "assistant"): string {
  return JSON.stringify({ id, role, parts: [{ type: "text", text: id }] });
}

test("accepted chat message ids survive transcript pruning", () => {
  const db = database();
  initializeAcceptedChatMessageLedger(db);
  const insert = db.prepare(`
    INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET message = excluded.message
  `);

  insert.run("user-1", message("user-1", "user"));
  insert.run("user-1", message("user-1", "user"));
  db.prepare("DELETE FROM cf_ai_chat_agent_messages WHERE id = ?").run("user-1");
  assert.throws(
    () => insert.run("user-1", message("user-1", "user")),
    /UNIQUE constraint failed: glide_accepted_user_message_ids.message_id/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages WHERE id = ?").get("user-1")?.count,
    0,
  );
  db.close();
});

test("ledger backfill excludes registered server-authored user events", () => {
  const db = database();
  db.prepare("INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)")
    .run("legacy-user", message("legacy-user", "user"));
  db.prepare("INSERT INTO glide_system_events (id, text, ts) VALUES (?, ?, ?)")
    .run("system-event", "Applied action", Date.now());
  db.prepare("INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)")
    .run("system-event", message("system-event", "user"));
  db.prepare("INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)")
    .run("assistant-1", message("assistant-1", "assistant"));

  initializeAcceptedChatMessageLedger(db);
  backfillAcceptedChatMessageLedger(db);

  const ids = db.prepare("SELECT message_id FROM glide_accepted_user_message_ids ORDER BY message_id")
    .all()
    .map((row) => row.message_id);
  assert.deepEqual(ids, ["legacy-user"]);
  db.prepare("DELETE FROM cf_ai_chat_agent_messages WHERE id = ?").run("system-event");
  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)")
      .run("system-event", message("system-event", "user"));
  });
  db.close();
});

test("message-id tombstones retain user and assistant ids after transcript deletion", () => {
  const db = database();
  initializeAcceptedChatMessageLedger(db);
  db.prepare("INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)")
    .run("user-tombstone", message("user-tombstone", "user"));
  db.prepare("INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)")
    .run("assistant-tombstone", message("assistant-tombstone", "assistant"));
  db.exec("DELETE FROM cf_ai_chat_agent_messages");

  const ids = db.prepare("SELECT message_id FROM glide_chat_message_id_tombstones ORDER BY message_id")
    .all()
    .map((row) => row.message_id);
  assert.deepEqual(ids, ["assistant-tombstone", "user-tombstone"]);
  db.close();
});
