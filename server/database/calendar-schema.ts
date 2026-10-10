import type { SQL } from "bun";
import type { Dialect } from "./dialect";
import { run } from "./schema";
import { schemaTypes } from "./schema-types";

export async function createCalendarSchema(sql: SQL, dialect: Dialect) {
	const types = schemaTypes(dialect);
	const repeatColumns = [
		`repeat_unit ${types.text("interval_unit")}`,
		`repeat_interval INTEGER NOT NULL DEFAULT 1`,
		`repeat_weekdays ${types.text("kind")}`,
		`repeat_until ${types.text("ends_on")}`,
		`repeat_skips ${types.text("repeat_skips")}`,
	];
	for (const column of repeatColumns) await sql.unsafe(`ALTER TABLE chat_meetings ADD COLUMN ${column}`);
	await run(sql, dialect, [
		`CREATE TABLE IF NOT EXISTS calendar_events(
			uuid ${types.text("uuid")} PRIMARY KEY,
			project ${types.text("project")} NOT NULL,
			account ${types.text("account")} NOT NULL,
			title ${types.text("store_name")} NOT NULL,
			note ${types.text("note")},
			visibility ${types.text("kind")} NOT NULL DEFAULT 'details' CHECK (visibility IN ('details', 'busy', 'private')),
			all_day ${types.flag} NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
			starts_at ${types.int64},
			duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (duration_minutes > 0 AND duration_minutes <= 1440)),
			starts_on ${types.text("starts_on")},
			ends_on ${types.text("ends_on")},
			${repeatColumns.join(",\n\t\t\t")},
			created ${types.int64} NOT NULL,
			updated ${types.int64} NOT NULL,
			FOREIGN KEY (project) REFERENCES projects(uuid) ON DELETE CASCADE,
			FOREIGN KEY (account) REFERENCES accounts(username) ON DELETE CASCADE,
			CHECK ((all_day = 1 AND starts_on IS NOT NULL AND ends_on IS NOT NULL) OR (all_day = 0 AND starts_at IS NOT NULL AND duration_minutes IS NOT NULL))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_calendar_events_project ON calendar_events(project, starts_at)`,
		`CREATE INDEX IF NOT EXISTS idx_calendar_events_account ON calendar_events(account)`,
	]);
}
