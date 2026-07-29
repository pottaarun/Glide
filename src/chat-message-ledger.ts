interface SqlExecutor {
  exec(query: string): unknown;
}

export const CREATE_ACCEPTED_CHAT_MESSAGE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS glide_accepted_user_message_ids (
    message_id TEXT PRIMARY KEY
  ) WITHOUT ROWID
`;

export const CREATE_CHAT_MESSAGE_ID_TOMBSTONES_SQL = `
  CREATE TABLE IF NOT EXISTS glide_chat_message_id_tombstones (
    message_id TEXT PRIMARY KEY
  ) WITHOUT ROWID
`;

export const CREATE_CHAT_MESSAGE_ID_TOMBSTONE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS glide_record_chat_message_id_tombstone
  AFTER INSERT ON cf_ai_chat_agent_messages
  BEGIN
    INSERT OR IGNORE INTO glide_chat_message_id_tombstones (message_id) VALUES (NEW.id);
  END
`;

export const CREATE_ACCEPTED_CHAT_MESSAGE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS glide_record_accepted_user_message_id
  AFTER INSERT ON cf_ai_chat_agent_messages
  WHEN json_valid(NEW.message)
    AND json_extract(NEW.message, '$.role') = 'user'
    AND NOT EXISTS (
      SELECT 1 FROM glide_system_events WHERE id = NEW.id
    )
  BEGIN
    INSERT INTO glide_accepted_user_message_ids (message_id) VALUES (NEW.id);
  END
`;

export const BACKFILL_ACCEPTED_CHAT_MESSAGE_LEDGER_SQL = `
  INSERT OR IGNORE INTO glide_accepted_user_message_ids (message_id)
  SELECT messages.id
  FROM cf_ai_chat_agent_messages AS messages
  LEFT JOIN glide_system_events AS events ON events.id = messages.id
  WHERE json_valid(messages.message)
    AND json_extract(messages.message, '$.role') = 'user'
    AND events.id IS NULL
`;

export function initializeAcceptedChatMessageLedger(sql: SqlExecutor): void {
  sql.exec(CREATE_ACCEPTED_CHAT_MESSAGE_LEDGER_SQL);
  sql.exec(CREATE_CHAT_MESSAGE_ID_TOMBSTONES_SQL);
  sql.exec(CREATE_ACCEPTED_CHAT_MESSAGE_TRIGGER_SQL);
  sql.exec(CREATE_CHAT_MESSAGE_ID_TOMBSTONE_TRIGGER_SQL);
}

export function backfillAcceptedChatMessageLedger(sql: SqlExecutor): void {
  sql.exec(BACKFILL_ACCEPTED_CHAT_MESSAGE_LEDGER_SQL);
}
