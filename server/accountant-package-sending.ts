import { createHash, randomBytes } from "node:crypto";
import Database from "./database/database";
import Validate from "./validate";
import Utils from "./utils";
import { Logger } from "./logger";
import { translator } from "./i18n";
import { formatDateIn, formatMoneyIn, type DateFormat } from "./formats";
import { legalNameParts } from "./legal-name";
import { zonedParts } from "./timezone";
import { brandFor } from "./email/messages";
import { queueEmail, deliverSoon } from "./email/outbox";
import { accountantPackageEmail } from "./email/templates";
import { accountantPackageArchive, accountantPackageOverview, collectAccountantPackage, packageSummary, type PackagePeriod } from "./accountant-package";
import type { AccountantPackage, PackageChanges } from "./accountant-package-types";
import type { ProjectRow } from "./database/models";

export const MAX_RECIPIENTS = 5;
export const LINK_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
const CHANGE_MONTHS = 12;

export interface PackageSettingsRow {
	project: string;
	recipients: string;
	send_day: number | null;
	last_run: string | null;
	updated_by: string | null;
	updated: number;
}

export interface PackageSendRow {
	uuid: string;
	project: string;
	period_from: string;
	period_to: string;
	kind: "full" | "changes";
	recipients: string;
	snapshot: string;
	included: string | null;
	changes: string | null;
	token_hash: string;
	expires_at: number;
	automatic: number;
	sent_by: string | null;
	created: number;
}

type Snapshot = Record<string, { hash: string; label: string }>;

export interface PackageDiff {
	added: string[];
	changed: string[];
	removed: string[];
	keys: string[];
}

export class NothingChanged extends Error {}
export class NeverSent extends Error {}
export class NoRecipients extends Error {}

export interface PackageSettingsInput {
	recipients: string[];
	send_day: number | null;
}

export function validPackageSettings(value: unknown): value is PackageSettingsInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const data = value as Record<string, unknown>;
	return (
		Array.isArray(data.recipients) &&
		data.recipients.length <= MAX_RECIPIENTS &&
		data.recipients.every((entry) => typeof entry === "string" && Validate.email(entry.trim())) &&
		(data.send_day === null || (Number.isInteger(data.send_day) && (data.send_day as number) >= 1 && (data.send_day as number) <= 28)) &&
		(data.send_day === null || data.recipients.length > 0)
	);
}

function recipientList(value: string): string[] {
	return value ? value.split(",").filter(Boolean) : [];
}

function monthKey(year: number, month: number): string {
	return `${year}-${String(month).padStart(2, "0")}`;
}

function nextRun(sendDay: number | null, lastRun: string | null, timezone: string, now = Date.now()): string | null {
	if (sendDay === null) return null;
	const today = zonedParts(now, timezone);
	const thisMonth = monthKey(today.year, today.month);
	const runsThisMonth = lastRun !== thisMonth;
	const [year, month] = runsThisMonth ? [today.year, today.month] : today.month === 12 ? [today.year + 1, 1] : [today.year, today.month + 1];
	const day = runsThisMonth && today.day > sendDay ? today.day : sendDay;
	return `${monthKey(year, month)}-${String(day).padStart(2, "0")}`;
}

export async function packageSettings(project: Pick<ProjectRow, "uuid" | "timezone">) {
	const [row] = (await Database`SELECT * FROM accountant_package_settings WHERE project = ${project.uuid}`) as PackageSettingsRow[];
	const sendDay = row && row.send_day !== null ? Number(row.send_day) : null;
	return {
		recipients: row ? recipientList(row.recipients) : [],
		send_day: sendDay,
		next_run: nextRun(sendDay, row?.last_run ?? null, project.timezone),
		updated: row ? Number(row.updated) : null,
	};
}

export async function savePackageSettings(project: Pick<ProjectRow, "uuid" | "timezone">, input: PackageSettingsInput, author: string) {
	const recipients = [...new Set(input.recipients.map((entry) => entry.trim().toLowerCase()))].join(",");
	const now = Date.now();
	const [previous] = (await Database`SELECT * FROM accountant_package_settings WHERE project = ${project.uuid}`) as PackageSettingsRow[];
	const today = zonedParts(now, project.timezone);
	const switchedOn = input.send_day !== null && (previous?.send_day ?? null) === null;
	const lastRun = switchedOn && today.day > input.send_day! ? monthKey(today.year, today.month) : (previous?.last_run ?? null);
	await Database`
		INSERT INTO accountant_package_settings(project, recipients, send_day, last_run, updated_by, updated)
		VALUES(${project.uuid}, ${recipients}, ${input.send_day}, ${lastRun}, ${author}, ${now})
		ON CONFLICT(project) DO UPDATE SET recipients = ${recipients}, send_day = ${input.send_day}, last_run = ${lastRun}, updated_by = ${author}, updated = ${now}
	`;
	return packageSettings(project);
}

export function snapshotOf(data: AccountantPackage): Snapshot {
	const snapshot: Snapshot = {};
	for (const row of data.issued) snapshot[row.key] = { hash: row.fingerprint, label: [row.reference, row.customer].filter(Boolean).join(" | ") };
	for (const row of data.credit_notes) snapshot[row.key] = { hash: row.fingerprint, label: [row.reference, row.customer].filter(Boolean).join(" | ") };
	for (const row of data.received)
		snapshot[row.key] = { hash: row.fingerprint, label: [row.invoice_number ?? row.description, row.supplier].filter(Boolean).join(" | ") };
	return snapshot;
}

export function diffSnapshots(previous: Snapshot, current: Snapshot): PackageDiff {
	const diff: PackageDiff = { added: [], changed: [], removed: [], keys: [] };
	for (const [key, entry] of Object.entries(current)) {
		const before = previous[key];
		if (!before) {
			diff.added.push(entry.label);
			diff.keys.push(key);
		} else if (before.hash !== entry.hash) {
			diff.changed.push(entry.label);
			diff.keys.push(key);
		}
	}
	for (const [key, entry] of Object.entries(previous)) if (!current[key]) diff.removed.push(entry.label);
	return diff;
}

function empty(diff: PackageDiff): boolean {
	return diff.added.length + diff.changed.length + diff.removed.length === 0;
}

export async function packageSends(project: string, period: PackagePeriod): Promise<PackageSendRow[]> {
	return (await Database`
		SELECT * FROM accountant_package_sends WHERE project = ${project} AND period_from = ${period.from} AND period_to = ${period.to}
		ORDER BY created DESC
	`) as PackageSendRow[];
}

export function presentSend(row: PackageSendRow) {
	return {
		uuid: row.uuid,
		kind: row.kind,
		recipients: recipientList(row.recipients),
		automatic: Boolean(Number(row.automatic)),
		sent_by: row.sent_by,
		created: Number(row.created),
		expires_at: Number(row.expires_at),
		changes: row.changes ? (JSON.parse(row.changes) as PackageChanges) : null,
	};
}

export async function packageStatus(project: ProjectRow, period: PackagePeriod, prepared?: AccountantPackage) {
	const sends = await packageSends(project.uuid, period);
	if (sends.length === 0) return { sends: [], changes: null };
	const data = prepared ?? (await collectAccountantPackage(project, period));
	const diff = diffSnapshots(JSON.parse(sends[0].snapshot) as Snapshot, snapshotOf(data));
	return {
		sends: sends.map(presentSend),
		changes: empty(diff) ? null : { since: Number(sends[0].created), added: diff.added, changed: diff.changed, removed: diff.removed },
	};
}

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function periodLabel(project: ProjectRow, period: PackagePeriod): string {
	const [year, month] = period.from.split("-").map(Number);
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (period.from.endsWith("-01") && period.to === `${period.from.slice(0, 8)}${String(lastDay).padStart(2, "0")}`) {
		return new Intl.DateTimeFormat(project.language === "sl" ? "sl-SI" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
			Date.UTC(year, month - 1, 1)
		);
	}
	const day = (value: string) => formatDateIn(Date.parse(`${value}T12:00:00Z`), project.date_format as DateFormat, project.language, "UTC");
	return `${day(period.from)} - ${day(period.to)}`;
}

export async function sendAccountantPackage(
	project: ProjectRow,
	period: PackagePeriod,
	options: { kind: "full" | "changes"; recipients?: string[]; author: string | null; automatic: boolean }
) {
	const recipients = options.recipients ?? (await packageSettings(project)).recipients;
	if (recipients.length === 0) throw new NoRecipients();
	const data = await collectAccountantPackage(project, period);
	const current = snapshotOf(data);
	const previous = (await packageSends(project.uuid, period))[0];
	let included: string[] | null = null;
	if (options.kind === "changes") {
		if (!previous) throw new NeverSent();
		const diff = diffSnapshots(JSON.parse(previous.snapshot) as Snapshot, current);
		if (empty(diff)) throw new NothingChanged();
		data.changes = { since: Number(previous.created), added: diff.added, changed: diff.changed, removed: diff.removed };
		included = diff.keys;
	}

	const overview = await accountantPackageOverview(project, period, data);
	const token = randomBytes(32).toString("base64url");
	const uuid = crypto.randomUUID();
	const now = Date.now();
	const expires = now + LINK_LIFETIME_MS;
	await Database`
		INSERT INTO accountant_package_sends(uuid, project, period_from, period_to, kind, recipients, snapshot, included, changes, token_hash, expires_at, automatic, sent_by, created)
		VALUES(${uuid}, ${project.uuid}, ${period.from}, ${period.to}, ${options.kind}, ${recipients.join(",")}, ${JSON.stringify(current)},
			${included ? JSON.stringify(included) : null}, ${data.changes ? JSON.stringify(data.changes) : null}, ${tokenHash(token)}, ${expires},
			${options.automatic ? 1 : 0}, ${options.author}, ${now})
	`;

	const brand = await brandFor(project, "team");
	const t = translator(project.language);
	const summary = packageSummary(data);
	const amount = (value: number) => formatMoneyIn(value, data.currency, project.language);
	const rows = data.changes
		? [
				{ label: t("email.package.added"), value: String(data.changes.added.length) },
				{ label: t("email.package.changed"), value: String(data.changes.changed.length) },
				{ label: t("email.package.removed"), value: String(data.changes.removed.length) },
			]
		: [
				{ label: t("package.issued"), value: `${summary.issued.count} | ${amount(summary.issued.total)}` },
				{ label: t("package.credit_notes"), value: `${summary.credit_notes.count} | ${amount(summary.credit_notes.total)}` },
				{
					label: t("email.package.received"),
					value: `${summary.received_domestic.count + summary.received_foreign.count + summary.received_on_spot.count} | ${amount(
						summary.received_domestic.total + summary.received_foreign.total + summary.received_on_spot.total
					)}`,
				},
				...(summary.vat_return
					? [
							{
								label: t(summary.vat_return.fields["52"] > 0 ? "package.ddvo_52" : "package.ddvo_51"),
								value: amount(summary.vat_return.fields[summary.vat_return.fields["52"] > 0 ? "52" : "51"]),
							},
						]
					: []),
				...(summary.checks.length > 0 ? [{ label: t("package.checks"), value: String(summary.checks.length) }] : []),
			];
	const content = accountantPackageEmail(brand, {
		company: legalNameParts(data.company.name).name,
		period: periodLabel(project, period),
		url: `${Utils.publicUrl()}/api/v1/accountant-package/${token}`,
		expires: formatDateIn(expires, project.date_format as DateFormat, project.language, project.timezone),
		changes: data.changes ? { added: data.changes.added.length, changed: data.changes.changed.length, removed: data.changes.removed.length } : null,
		rows,
	});
	for (const recipient of recipients) {
		await queueEmail(Database, {
			project: project.uuid,
			kind: "accountant_package",
			to: recipient,
			senderName: brand.merchant,
			replyTo: brand.replyTo,
			...content,
			attachment: { name: overview.name, data: overview.data },
			sentBy: options.author,
		});
	}
	deliverSoon();
	const [row] = (await Database`SELECT * FROM accountant_package_sends WHERE uuid = ${uuid}`) as PackageSendRow[];
	return presentSend(row);
}

export async function packageByToken(token: string): Promise<{ name: string; data: Uint8Array } | null> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const [send] = (await Database`SELECT * FROM accountant_package_sends WHERE token_hash = ${tokenHash(token)}`) as PackageSendRow[];
	if (!send || Number(send.expires_at) < Date.now()) return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${send.project} AND status <> 'deleted'`) as ProjectRow[];
	if (!project) return null;
	const period = { from: send.period_from, to: send.period_to };
	const data = await collectAccountantPackage(project, period);
	data.changes = send.changes ? (JSON.parse(send.changes) as PackageChanges) : null;
	const only = send.included ? new Set(JSON.parse(send.included) as string[]) : null;
	const archive = await accountantPackageArchive(project, period, { data, only });
	return { name: archive.name, data: archive.data };
}

function monthPeriod(year: number, month: number): PackagePeriod {
	const start = new Date(Date.UTC(year, month - 1, 1));
	const end = new Date(Date.UTC(year, month, 0));
	return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export async function runScheduledPackages(now = Date.now()): Promise<number> {
	const due = (await Database`
		SELECT s.*, p.timezone FROM accountant_package_settings s JOIN projects p ON p.uuid = s.project
		WHERE s.send_day IS NOT NULL AND s.recipients <> '' AND p.status <> 'deleted'
	`) as (PackageSettingsRow & { timezone: string })[];
	let sent = 0;
	for (const settings of due) {
		const today = zonedParts(now, settings.timezone);
		const month = monthKey(today.year, today.month);
		if (today.day < Number(settings.send_day) || settings.last_run === month) continue;
		const claimed = await Database`
			UPDATE accountant_package_settings SET last_run = ${month}
			WHERE project = ${settings.project} AND (last_run IS NULL OR last_run <> ${month})
		`;
		if (claimed.count === 0) continue;
		const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${settings.project}`) as ProjectRow[];
		if (!project) continue;
		const previous = monthPeriod(today.month === 1 ? today.year - 1 : today.year, today.month === 1 ? 12 : today.month - 1);
		try {
			if ((await packageSends(project.uuid, previous)).length === 0) {
				await sendAccountantPackage(project, previous, { kind: "full", author: null, automatic: true });
				sent++;
			}
			const earliest = monthPeriod(today.year, today.month - CHANGE_MONTHS).from;
			const periods = (await Database`
				SELECT DISTINCT period_from, period_to FROM accountant_package_sends
				WHERE project = ${project.uuid} AND period_from >= ${earliest} AND NOT (period_from = ${previous.from} AND period_to = ${previous.to})
			`) as { period_from: string; period_to: string }[];
			for (const row of periods) {
				try {
					await sendAccountantPackage(project, { from: row.period_from, to: row.period_to }, { kind: "changes", author: null, automatic: true });
					sent++;
				} catch (error) {
					if (!(error instanceof NothingChanged)) throw error;
				}
			}
		} catch (error) {
			Logger.error(`[PACKAGE] Automatic accountant package for ${project.uuid} failed: ${error}`);
		}
	}
	return sent;
}
