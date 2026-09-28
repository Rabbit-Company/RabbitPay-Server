import Database, { dialect } from "./database/database";
import { whiteLabelActive } from "./licensing";
import { DEFAULT_INVOICE_DESIGN, parseInvoiceDesign, type InvoiceDesign } from "./invoice-design";
import { DEFAULT_EMAIL_DESIGN, parseEmailDesign, type EmailDesign } from "./email-design";
import type { ProjectRow } from "./database/models";

export const MAX_LOGO_BYTES = 150 * 1024;

const SIGNATURES: { type: string; matches: (bytes: Uint8Array) => boolean }[] = [
	{ type: "image/png", matches: (bytes) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte) },
	{ type: "image/jpeg", matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
	{
		type: "image/webp",
		matches: (bytes) => new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP",
	},
];

export function readLogo(base64: unknown): { type: string; data: string } | null {
	if (typeof base64 !== "string" || base64.length === 0 || base64.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 4) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

	const bytes = Buffer.from(base64, "base64");
	if (bytes.length < 12 || bytes.length > MAX_LOGO_BYTES) return null;

	const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
	if (!signature) return null;

	return { type: signature.type, data: bytes.toString("base64") };
}

export async function saveLogo(projectId: string, logo: { type: string; data: string }): Promise<number> {
	const timestamp = Date.now();
	await Database.begin(async (tx) => {
		if (dialect === "mysql")
			await tx`
			INSERT INTO project_logos(project, content_type, data, updated) VALUES(${projectId}, ${logo.type}, ${logo.data}, ${timestamp})
			ON DUPLICATE KEY UPDATE content_type = ${logo.type}, data = ${logo.data}, updated = ${timestamp}
		`;
		else
			await tx`
			INSERT INTO project_logos(project, content_type, data, updated) VALUES(${projectId}, ${logo.type}, ${logo.data}, ${timestamp})
			ON CONFLICT(project) DO UPDATE SET content_type = ${logo.type}, data = ${logo.data}, updated = ${timestamp}
		`;
		await tx`UPDATE projects SET logo_updated = ${timestamp}, updated = ${timestamp} WHERE uuid = ${projectId}`;
	});
	return timestamp;
}

export async function removeLogo(projectId: string) {
	const timestamp = Date.now();
	await Database.begin(async (tx) => {
		await tx`DELETE FROM project_logos WHERE project = ${projectId}`;
		await tx`UPDATE projects SET logo_updated = NULL, updated = ${timestamp} WHERE uuid = ${projectId}`;
	});
}

export async function loadLogo(projectId: string): Promise<{ type: string; bytes: Buffer } | null> {
	const [row] = (await Database`SELECT content_type, data FROM project_logos WHERE project = ${projectId}`) as { content_type: string; data: string }[];
	if (!row) return null;
	return { type: row.content_type, bytes: Buffer.from(row.data, "base64") };
}

export function logoPath(project: Pick<ProjectRow, "uuid" | "logo_updated">): string | null {
	if (project.logo_updated === null) return null;
	return `/api/v1/public/projects/${project.uuid}/logo?v=${project.logo_updated}`;
}

export function brandingOf(project: Pick<ProjectRow, "uuid" | "logo_updated" | "white_label_until">) {
	const whiteLabel = whiteLabelActive(project);
	return { white_label: whiteLabel, logo: whiteLabel ? logoPath(project) : null };
}

export function invoiceDesignOf(project: Pick<ProjectRow, "invoice_design" | "white_label_until">): InvoiceDesign {
	return whiteLabelActive(project) ? parseInvoiceDesign(project.invoice_design) : DEFAULT_INVOICE_DESIGN;
}

export function emailDesignOf(project: Pick<ProjectRow, "email_design" | "white_label_until">): EmailDesign {
	return whiteLabelActive(project) ? parseEmailDesign(project.email_design) : DEFAULT_EMAIL_DESIGN;
}
