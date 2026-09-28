import Database, { dialect } from "./database/database";
import { Settings } from "./settings";
import { ErrorCode } from "./errors";
import type { GeneratedReport, ReportKind, ReportState } from "./report-types";

const LEASE_MS = 60 * 60 * 1000;

interface SnapshotRow {
	data: string | null;
	generated_at: number | null;
	claim_token: string | null;
	claimed_at: number | null;
}

export class ReportUnavailable extends Error {
	constructor(public readonly code: ErrorCode.REPORT_COOLDOWN | ErrorCode.REPORT_GENERATING) {
		super(code === ErrorCode.REPORT_COOLDOWN ? "This report was generated recently." : "This report is being generated.");
	}
}

function cooldown(): number {
	return Settings.reports.cooldown_minutes * 60 * 1000;
}

export async function savedReport<T>(project: string, kind: ReportKind): Promise<ReportState<T>> {
	const [row] =
		(await Database`SELECT data, generated_at, claim_token, claimed_at FROM report_snapshots WHERE project = ${project} AND kind = ${kind}`) as SnapshotRow[];
	const now = Date.now();
	const next = row?.generated_at === null || row?.generated_at === undefined ? 0 : Number(row.generated_at) + cooldown();
	return {
		report: row?.data && row.generated_at !== null ? { ...JSON.parse(row.data), generated_at: Number(row.generated_at), next_generation_at: next } : null,
		generating: Boolean(row?.claim_token && row.claimed_at !== null && Number(row.claimed_at) > now - LEASE_MS),
		next_generation_at: next,
		server_time: now,
	};
}

export async function generateReport<T>(project: string, kind: ReportKind, build: () => Promise<T>): Promise<GeneratedReport<T>> {
	const now = Date.now();
	const token = crypto.randomUUID();
	let ownsClaim: boolean;
	if (dialect === "mysql") {
		await Database`
			INSERT INTO report_snapshots(project, kind, claim_token, claimed_at) VALUES(${project}, ${kind}, ${token}, ${now})
			ON DUPLICATE KEY UPDATE claim_token = IF(
				(claim_token IS NULL OR claimed_at <= ${now - LEASE_MS}) AND (generated_at IS NULL OR generated_at <= ${now - cooldown()}),
				${token}, claim_token), claimed_at = IF(claim_token = ${token}, ${now}, claimed_at)
		`;
		const [row] = await Database`SELECT claim_token FROM report_snapshots WHERE project = ${project} AND kind = ${kind}`;
		ownsClaim = row?.claim_token === token;
	} else {
		const claimed = await Database`
		INSERT INTO report_snapshots(project, kind, claim_token, claimed_at) VALUES(${project}, ${kind}, ${token}, ${now})
		ON CONFLICT(project, kind) DO UPDATE SET claim_token = ${token}, claimed_at = ${now}
		WHERE (report_snapshots.claim_token IS NULL OR report_snapshots.claimed_at <= ${now - LEASE_MS})
			AND (report_snapshots.generated_at IS NULL OR report_snapshots.generated_at <= ${now - cooldown()})
		RETURNING project
		`;
		ownsClaim = claimed.length > 0;
	}
	if (!ownsClaim) {
		const state = await savedReport(project, kind);
		throw new ReportUnavailable(state.generating ? ErrorCode.REPORT_GENERATING : ErrorCode.REPORT_COOLDOWN);
	}
	try {
		const report = await build();
		const data = JSON.stringify(report);
		const generated = Date.now();
		const stored =
			dialect === "mysql"
				? await Database`
			UPDATE report_snapshots SET data = ${data}, generated_at = ${generated}, claim_token = NULL, claimed_at = NULL
			WHERE project = ${project} AND kind = ${kind} AND claim_token = ${token}
		`
				: await Database`
			UPDATE report_snapshots SET data = ${data}, generated_at = ${generated}, claim_token = NULL, claimed_at = NULL
			WHERE project = ${project} AND kind = ${kind} AND claim_token = ${token}
			RETURNING project
		`;
		if ((dialect === "mysql" ? stored.count : stored.length) === 0) throw new ReportUnavailable(ErrorCode.REPORT_GENERATING);
		return { ...report, generated_at: generated, next_generation_at: generated + cooldown() };
	} catch (error) {
		await Database`UPDATE report_snapshots SET claim_token = NULL, claimed_at = NULL WHERE project = ${project} AND kind = ${kind} AND claim_token = ${token}`;
		throw error;
	}
}
