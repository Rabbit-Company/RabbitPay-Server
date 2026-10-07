import type { SQL } from "bun";
import Database from "./database/database";
import { Settings } from "./settings";
import Utils from "./utils";
import { emailsMetered, includedFileStorageGb, includedPayments, includedStorageGb } from "./licensing";
import type { LegalDocumentRow, LegalKind } from "./database/models";
import termsEn from "./legal-templates/terms.en.md" with { type: "text" };
import termsSl from "./legal-templates/terms.sl.md" with { type: "text" };
import privacyEn from "./legal-templates/privacy.en.md" with { type: "text" };
import privacySl from "./legal-templates/privacy.sl.md" with { type: "text" };

export const LEGAL_KINDS: LegalKind[] = ["terms", "privacy"];
export const LEGAL_LANGUAGES = ["en", "sl"] as const;
export const MAX_LEGAL_DOCUMENT_LENGTH = 100_000;
export const MAX_LEGAL_NOTICE_MS = 366 * 24 * 60 * 60 * 1000;

export type LegalLanguage = (typeof LEGAL_LANGUAGES)[number];
export type LegalVersions = Record<LegalKind, number[]>;

const TEMPLATES: Record<LegalKind, Record<LegalLanguage, string>> = {
	terms: { en: termsEn, sl: termsSl },
	privacy: { en: privacyEn, sl: privacySl },
};

const CLOUDFLARE_STORAGE = /\.r2\.cloudflarestorage\.com$/i;

export function isLegalKind(value: unknown): value is LegalKind {
	return typeof value === "string" && LEGAL_KINDS.includes(value as LegalKind);
}

export function isLegalLanguage(value: unknown): value is LegalLanguage {
	return typeof value === "string" && LEGAL_LANGUAGES.includes(value as LegalLanguage);
}

export function presentOperator() {
	const legal = Settings.legal;
	if (!legal.operator_name) return null;
	return {
		name: legal.operator_name,
		address: legal.address || null,
		register: legal.register || null,
		registration_number: legal.registration_number || null,
		tax_number: legal.tax_number || null,
		vat_status: legal.vat_status,
		vat_number: legal.vat_status === "registered" ? legal.vat_number || null : null,
		email: legal.contact_email || null,
		phone: legal.phone || null,
	};
}

export function effectiveOf(row: Pick<LegalDocumentRow, "effective" | "published">): number {
	return Number(row.effective ?? row.published);
}

export function presentDocument(row: LegalDocumentRow) {
	return {
		kind: row.kind,
		version: Number(row.version),
		content_en: row.content_en,
		content_sl: row.content_sl,
		published: Number(row.published),
		effective: effectiveOf(row),
	};
}

export async function latestDocument(kind: LegalKind, sql: SQL = Database): Promise<LegalDocumentRow | null> {
	const [row] = (await sql`SELECT * FROM legal_documents WHERE kind = ${kind} ORDER BY version DESC LIMIT 1`) as LegalDocumentRow[];
	return row ?? null;
}

export async function currentDocument(kind: LegalKind, now = Date.now(), sql: SQL = Database): Promise<LegalDocumentRow | null> {
	const [row] = (await sql`
		SELECT * FROM legal_documents WHERE kind = ${kind} AND COALESCE(effective, published) <= ${now} ORDER BY version DESC LIMIT 1
	`) as LegalDocumentRow[];
	return row ?? null;
}

export async function upcomingDocument(kind: LegalKind, now = Date.now(), sql: SQL = Database): Promise<LegalDocumentRow | null> {
	const [row] = (await sql`
		SELECT * FROM legal_documents WHERE kind = ${kind} AND COALESCE(effective, published) > ${now} ORDER BY version DESC LIMIT 1
	`) as LegalDocumentRow[];
	return row ?? null;
}

export async function requiredVersions(sql: SQL = Database, now = Date.now()): Promise<LegalVersions> {
	const versions: LegalVersions = { terms: [], privacy: [] };
	for (const kind of LEGAL_KINDS) {
		const [current, upcoming] = await Promise.all([currentDocument(kind, now, sql), upcomingDocument(kind, now, sql)]);
		versions[kind] = [current, upcoming].filter((row) => row !== null).map((row) => Number(row!.version));
	}
	return versions;
}

export function requiresTerms(versions: LegalVersions): boolean {
	return versions.terms.length > 0;
}

export function sameVersions(expected: LegalVersions, given: unknown): boolean {
	if (given === null || typeof given !== "object") return false;
	return LEGAL_KINDS.every((kind) => {
		const list = (given as Record<string, unknown>)[kind] ?? [];
		if (!Array.isArray(list) || list.length !== expected[kind].length) return false;
		return expected[kind].every((version) => list.includes(version));
	});
}

async function acceptedTerms(username: string): Promise<number> {
	const [accepted] = (await Database`
		SELECT MAX(version) AS version FROM legal_acceptances WHERE account_username = ${username} AND kind = 'terms'
	`) as { version: number | null }[];
	return accepted?.version === null || accepted?.version === undefined ? 0 : Number(accepted.version);
}

export async function pendingTerms(username: string, now = Date.now()): Promise<number | null> {
	const current = await currentDocument("terms", now);
	if (current === null) return null;
	return (await acceptedTerms(username)) >= Number(current.version) ? null : Number(current.version);
}

export async function upcomingTerms(username: string, now = Date.now()): Promise<{ version: number; effective: number } | null> {
	const upcoming = await upcomingDocument("terms", now);
	if (upcoming === null || (await acceptedTerms(username)) >= Number(upcoming.version)) return null;
	return { version: Number(upcoming.version), effective: effectiveOf(upcoming) };
}

export async function recordAcceptance(sql: SQL, username: string, versions: LegalVersions, client: { ip: string; userAgent: string }): Promise<void> {
	const timestamp = Date.now();
	for (const kind of LEGAL_KINDS) {
		for (const version of versions[kind]) {
			await sql`
				INSERT INTO legal_acceptances(uuid, account_username, kind, version, accepted, ip_address, user_agent)
				VALUES(${crypto.randomUUID()}, ${username}, ${kind}, ${version}, ${timestamp}, ${client.ip || null}, ${client.userAgent.slice(0, 500) || null})
			`;
		}
	}
}

function hostOf(endpoint: string | undefined): string | null {
	if (!endpoint) return null;
	try {
		return new URL(endpoint).hostname;
	} catch {
		return null;
	}
}

interface Processor {
	name: string;
	address: string;
	outsideEu: boolean;
	purpose: Record<LegalLanguage, string>;
}

function processors(): Processor[] {
	const cloudflare = { name: "Cloudflare, Inc.", address: "101 Townsend St, San Francisco, CA 94107, USA", outsideEu: true };
	const backups = Settings.backups.enabled && Settings.backups.destination !== "local";
	const backupHost = backups ? hostOf(Settings.backups.s3_endpoint) : null;
	const documentHost = Bun.env.DOCUMENT_STORAGE === "s3" ? hostOf(Bun.env.DOCUMENT_S3_ENDPOINT) : null;
	const cloudflareStorage = [backupHost, documentHost].filter((host) => host !== null && CLOUDFLARE_STORAGE.test(host));
	const found: Processor[] = [];

	if (Settings.server.proxy === "cloudflare") {
		found.push({
			...cloudflare,
			purpose: {
				en: "Network protection and content delivery. Every request to the service passes through Cloudflare, which processes IP addresses and request details to block attacks.",
				sl: "Zaščita omrežja in dostava vsebin. Vse zahteve do storitve gredo prek Cloudflara, ki obdeluje naslove IP in podatke o zahtevah za zaustavljanje napadov.",
			},
		});
	}
	if (cloudflareStorage.length > 0) {
		found.push({
			...cloudflare,
			name: "Cloudflare, Inc. (R2)",
			purpose: {
				en: "Off-site storage of backups and documents. Files are encrypted on our server before upload, so Cloudflare only stores data it cannot read.",
				sl: "Hramba varnostnih kopij in dokumentov zunaj naših prostorov. Datoteke so šifrirane na našem strežniku pred prenosom, zato Cloudflare hrani le podatke, ki jih ne more prebrati.",
			},
		});
	}
	for (const host of [backupHost, documentHost]) {
		if (host === null || CLOUDFLARE_STORAGE.test(host) || found.some((entry) => entry.address === host)) continue;
		found.push({
			name: host,
			address: host,
			outsideEu: false,
			purpose: {
				en: "Off-site storage of encrypted backups and documents. Review the provider name, address and location before publishing.",
				sl: "Hramba šifriranih varnostnih kopij in dokumentov zunaj naših prostorov. Pred objavo preverite ime, naslov in lokacijo ponudnika.",
			},
		});
	}
	return found;
}

function processorList(language: LegalLanguage): string {
	const found = processors();
	if (found.length === 0) {
		return language === "sl"
			? "Za obdelavo osebnih podatkov ne uporabljamo podobdelovalcev. Strežniki in pošta tečejo na naši lastni opremi."
			: "We do not use subprocessors to process personal data. Servers and email run on our own equipment.";
	}
	return found.map((entry) => `- **${entry.name}**, ${entry.address}: ${entry.purpose[language]}`).join("\n");
}

function transfers(language: LegalLanguage): string {
	if (!processors().some((entry) => entry.outsideEu)) {
		return language === "sl"
			? "Osebnih podatkov ne prenašamo v države zunaj Evropskega gospodarskega prostora."
			: "We do not transfer personal data to countries outside the European Economic Area.";
	}
	return language === "sl"
		? "Cloudflare, Inc. ima sedež v ZDA. Prenos temelji na okviru EU-ZDA za zasebnost podatkov (Data Privacy Framework), v katerega je Cloudflare vključen, in na standardnih pogodbenih klavzulah Evropske komisije."
		: "Cloudflare, Inc. is based in the United States. Transfers rely on the EU-U.S. Data Privacy Framework, under which Cloudflare is certified, and on the European Commission's standard contractual clauses.";
}

function operatorBlock(language: LegalLanguage): string {
	const legal = Settings.legal;
	const labels =
		language === "sl"
			? { register: "Vpis", registration: "Matična številka", tax: "Davčna številka", vat: "ID za DDV", email: "E-pošta", phone: "Telefon" }
			: { register: "Registered in", registration: "Registration number", tax: "Tax number", vat: "VAT number", email: "Email", phone: "Phone" };
	const lines = [
		`**${legal.operator_name || "[Operator name]"}**`,
		legal.address || "[Address]",
		legal.register ? `${labels.register}: ${legal.register}` : "",
		legal.registration_number ? `${labels.registration}: ${legal.registration_number}` : "",
		legal.tax_number ? `${labels.tax}: ${legal.tax_number}` : "",
		legal.vat_status === "registered" && legal.vat_number ? `${labels.vat}: ${legal.vat_number}` : "",
		`${labels.email}: ${legal.contact_email || "[email]"}`,
		legal.phone ? `${labels.phone}: ${legal.phone}` : "",
	];
	return lines.filter(Boolean).join("  \n");
}

function vatClause(language: LegalLanguage): string {
	if (Settings.legal.vat_status === "registered") {
		return language === "sl"
			? "Cene ne vključujejo DDV. DDV obračunamo, kadar to zahteva zakon."
			: "Prices exclude VAT. VAT is charged where the law requires it.";
	}
	return language === "sl"
		? "Ponudnik ni zavezanec za DDV. Računi so izdani brez DDV na podlagi 1. odstavka 94. člena ZDDV-1."
		: "The provider is not registered for VAT. Invoices are issued without VAT under Article 94(1) of the Slovenian VAT Act (ZDDV-1).";
}

export function formatLegalDate(language: LegalLanguage, timestamp: number): string {
	const date = new Date(timestamp);
	return language === "sl"
		? `${date.getUTCDate()}. ${date.getUTCMonth() + 1}. ${date.getUTCFullYear()}`
		: date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function emailAllowanceClause(language: LegalLanguage): string {
	if (!emailsMetered()) return "";
	const emails = Settings.licensing.free_emails;
	return language === "sl"
		? ` Vključuje tudi e-poštna sporočila naročnikovim kupcem, poslana prek našega poštnega strežnika, največ ${emails} na mesec.`
		: ` It also includes ${emails} emails per month to the Customer's own customers, sent through our email server.`;
}

function emailContentRetention(language: LegalLanguage): string {
	const days = Settings.email.body_retention_days;
	if (days <= 0) return language === "sl" ? "dokler projekt obstaja." : "while the project exists.";
	return language === "sl"
		? `${days} dni, nato ostane samo zapis o tem, kaj je bilo komu poslano.`
		: `${days} days, after which only the record of what was sent to whom is kept.`;
}

export function legalTemplate(kind: LegalKind, language: LegalLanguage): string {
	const backupDays = Math.max(1, Math.round((Settings.backups.keep * Settings.backups.interval_hours) / 24));
	const values: Record<string, string> = {
		operator: operatorBlock(language),
		operator_name: Settings.legal.operator_name || "[Operator name]",
		email: Settings.legal.contact_email || "[email]",
		service_url: Utils.publicUrl(),
		vat_clause: vatClause(language),
		free_payments: String(includedPayments()),
		free_storage: String(includedStorageGb()),
		free_file_storage: String(includedFileStorageGb()),
		email_allowance: emailAllowanceClause(language),
		email_content_retention: emailContentRetention(language),
		access_log_days: String(Settings.access_logs.online_days),
		access_log_years: String(Settings.access_logs.retention_years),
		backup_days: String(backupDays),
		session_minutes: String(Math.max(1, Math.round(Settings.security.session_ttl / 60))),
		processors: processorList(language),
		transfers: transfers(language),
	};
	return TEMPLATES[kind][language].replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match).trim() + "\n";
}
