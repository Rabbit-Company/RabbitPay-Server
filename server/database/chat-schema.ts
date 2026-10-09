import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";

export async function createChatSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS chat_conversations(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			kind ${types.text("kind")} NOT NULL CHECK (kind IN ('direct', 'group')),
			name ${types.text("store_name")},
			direct_key ${types.text("sha256")} UNIQUE,
			last_number INTEGER NOT NULL DEFAULT 0,
			last_message_at ${types.int64},
			created_by ${types.text("created_by")},
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (created_by) REFERENCES accounts(username) ON DELETE SET NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_conversations_project ON chat_conversations(project, updated)`,
		`CREATE TABLE IF NOT EXISTS chat_participants(
			conversation ${types.text("uuid")} NOT NULL,
			account ${types.text("account")} NOT NULL,
			admin ${types.flag} NOT NULL DEFAULT 0 CHECK (admin IN (0, 1)),
			read_number INTEGER NOT NULL DEFAULT 0,
			joined ${types.int64} NOT NULL,
			PRIMARY KEY (conversation, account),
			FOREIGN KEY (conversation) REFERENCES chat_conversations(uuid) ON DELETE CASCADE,
			FOREIGN KEY (account) REFERENCES accounts(username) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_participants_account ON chat_participants(account)`,
		`CREATE TABLE IF NOT EXISTS chat_messages(
			uuid ${types.text("uuid")} PRIMARY KEY,
			conversation ${types.text("uuid")} NOT NULL,
			number INTEGER NOT NULL,
			author ${types.text("author")},
			author_name ${types.text("person")} NOT NULL,
			body ${types.text("body")},
			created ${types.int64} NOT NULL,
			edited_at ${types.int64},
			deleted_at ${types.int64},
			call_outcome ${types.text("status")} CHECK (call_outcome IN ('answered', 'missed', 'declined', 'cancelled')),
			call_seconds INTEGER,
			call_video ${types.flag} CHECK (call_video IN (0, 1)),
			FOREIGN KEY (conversation) REFERENCES chat_conversations(uuid) ON DELETE CASCADE,
			FOREIGN KEY (author) REFERENCES accounts(username) ON DELETE SET NULL,
			UNIQUE(conversation, number)
		)`,
		`CREATE TABLE IF NOT EXISTS chat_files(
			file ${types.text("file")} PRIMARY KEY,
			conversation ${types.text("uuid")} NOT NULL,
			message ${types.text("uuid")},
			recording ${types.flag} NOT NULL DEFAULT 0 CHECK (recording IN (0, 1)),
			created ${types.int64} NOT NULL,
			FOREIGN KEY (file) REFERENCES project_files(uuid) ON DELETE CASCADE,
			FOREIGN KEY (conversation) REFERENCES chat_conversations(uuid) ON DELETE CASCADE,
			FOREIGN KEY (message) REFERENCES chat_messages(uuid) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS chat_meetings(
			conversation ${types.text("uuid")} PRIMARY KEY,
			starts_at ${types.int64} NOT NULL,
			duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
			guest_token ${types.text("secret")},
			guest_token_hash ${types.text("token_hash")} UNIQUE,
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (conversation) REFERENCES chat_conversations(uuid) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_meetings_starts ON chat_meetings(starts_at)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_files_message ON chat_files(message)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_files_conversation ON chat_files(conversation, message)`,
	]);
}
