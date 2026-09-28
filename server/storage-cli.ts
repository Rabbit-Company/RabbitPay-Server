import Vault from "./crypto/vault";
import { BACKUP_CONTEXT, unsealFile } from "./crypto/sealed-file";
import { S3DocumentStorage, encryptStoredDocuments } from "./document-storage";

const USAGE = `Usage:
  bun run backup:decrypt <backup.sqlite.gz.enc> [output.sqlite.gz]
  bun run documents:encrypt
  bun run logs:export <from YYYY-MM-DD> <to YYYY-MM-DD> <output.jsonl>`;

const DAY = 24 * 60 * 60 * 1000;

function utcDay(value: string | undefined): number {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(USAGE);
	return Date.parse(`${value}T00:00:00Z`);
}

async function exportAccessLogs(fromDay: string | undefined, toDay: string | undefined, output: string | undefined) {
	const from = utcDay(fromDay);
	const to = utcDay(toDay) + DAY;
	if (!output || to <= from) throw new Error(USAGE);

	const { default: Database } = await import("./database/database");
	const { integerFields } = await import("./database/numbers");
	const { archivesBetween, readArchive } = await import("./access-log-archive");
	type AccessLogEntry = import("./access-log-archive").AccessLogEntry;

	const entries: AccessLogEntry[] = [];
	for (const archive of await archivesBetween(from, to)) {
		for (const entry of await readArchive(archive)) if (entry.created >= from && entry.created < to) entries.push(entry);
	}
	const live = (await Database`
		SELECT uuid, project_id, account_username, action, resource_type, resource_id, permission_checked, granted, ip_address, user_agent, metadata, created
		FROM access_logs WHERE created >= ${from} AND created < ${to}
	`) as AccessLogEntry[];
	entries.push(...integerFields(live, "created", "granted"));
	entries.sort((left, right) => left.created - right.created || left.uuid.localeCompare(right.uuid));

	await Bun.write(output, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : ""));
	await Database.close();
	console.log(`Exported ${entries.length} access log entries to ${output}`);
}

async function decryptBackup(source: string | undefined, target: string | undefined) {
	if (!source) throw new Error(USAGE);
	const output = target ?? source.replace(/\.enc$/, "");
	if (output === source) throw new Error("Give an output path, or a backup whose name ends in .enc");
	await unsealFile(source, output, BACKUP_CONTEXT);
	console.log(`Decrypted ${source} to ${output}`);
}

async function encryptDocuments() {
	if (Bun.env.DOCUMENT_STORAGE !== "s3") throw new Error("DOCUMENT_STORAGE is not s3, so there is nothing to encrypt");
	const { encrypted, skipped } = await encryptStoredDocuments(new S3DocumentStorage());
	console.log(`Encrypted ${encrypted} documents, ${skipped} were already encrypted`);
}

Vault.requireConfigured();
const [command, ...args] = process.argv.slice(2);

try {
	if (command === "decrypt-backup") await decryptBackup(args[0], args[1]);
	else if (command === "encrypt-documents") await encryptDocuments();
	else if (command === "export-access-logs") await exportAccessLogs(args[0], args[1], args[2]);
	else throw new Error(USAGE);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
