import type { SQL } from "bun";
import type { FiscalPremiseRow, FiscalSettingsRow, ProjectRow } from "../database/models";

export const FISCAL_PROCESSORS = new Set(["cash", "stripe", "bitcoin", "ethereum", "monero"]);

export const MARK_PATTERN = /^[0-9a-zA-Z]{1,20}$/;

export type FiscalChannel = "invoice" | "pos";

export interface FiscalPlace {
	premise: string;
	device: string;
}

export function isFiscalCountry(project: Pick<ProjectRow, "tax_country">): boolean {
	return project.tax_country === "SI";
}

export async function fiscalSettings(sql: SQL, projectId: string): Promise<FiscalSettingsRow | null> {
	const [row] = (await sql`SELECT * FROM fiscal_settings WHERE project = ${projectId}`) as FiscalSettingsRow[];
	return row ?? null;
}

export async function openPremise(sql: SQL, projectId: string, environment: string, premiseId: string): Promise<FiscalPremiseRow | null> {
	const [row] = (await sql`
		SELECT * FROM fiscal_premises
		WHERE project = ${projectId} AND environment = ${environment} AND premise_id = ${premiseId} AND closed_at IS NULL
	`) as FiscalPremiseRow[];
	return row ?? null;
}

export function placeFor(settings: FiscalSettingsRow, channel: FiscalChannel): FiscalPlace | null {
	if (channel === "pos" && settings.pos_premise && settings.pos_device) return { premise: settings.pos_premise, device: settings.pos_device };
	if (settings.online_premise && settings.online_device) return { premise: settings.online_premise, device: settings.online_device };
	return null;
}

export interface ActiveFiscal {
	settings: FiscalSettingsRow;
	taxNumber: number;
}

export async function activeFiscal(sql: SQL, project: Pick<ProjectRow, "uuid" | "tax_country">): Promise<ActiveFiscal | null> {
	if (!isFiscalCountry(project)) return null;
	const settings = await fiscalSettings(sql, project.uuid);
	if (!settings || settings.enabled !== 1 || !settings.certificate || !settings.certificate_tax_number) return null;
	const online = placeFor(settings, "invoice");
	if (!online || !(await openPremise(sql, project.uuid, settings.environment, online.premise))) return null;
	return { settings, taxNumber: settings.certificate_tax_number };
}

export async function activeFiscalFor(sql: SQL, projectId: string): Promise<ActiveFiscal | null> {
	const [project] = (await sql`SELECT uuid, tax_country FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "uuid" | "tax_country">[];
	return project ? await activeFiscal(sql, project) : null;
}

export async function fiscalBlocked(sql: SQL, projectId: string): Promise<boolean> {
	const [project] = (await sql`SELECT uuid, tax_country FROM projects WHERE uuid = ${projectId}`) as Pick<ProjectRow, "uuid" | "tax_country">[];
	if (!project || !isFiscalCountry(project)) return false;
	return (await activeFiscal(sql, project)) === null;
}
