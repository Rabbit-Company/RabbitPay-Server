import Database from "./database/database";
import type { ProjectCompanyRow, ProjectRow } from "./database/models";
import { isCountryCode } from "./countries";
import { localeFor } from "./formats";

export const COMPANY_FIELDS = [
	"legal_name",
	"address_line1",
	"address_line2",
	"postal_code",
	"city",
	"state",
	"country",
	"vat_number",
	"tax_number",
	"registration_number",
	"email",
	"phone",
	"website",
	"footer_note",
] as const;

export type CompanyField = (typeof COMPANY_FIELDS)[number];
export type CompanyDetails = Record<CompanyField, string | null>;

export function displayNameOf(project: Pick<ProjectRow, "name" | "display_name">): string {
	const chosen = project.display_name?.trim();
	return chosen ? chosen : project.name;
}

function empty(): CompanyDetails {
	return Object.fromEntries(COMPANY_FIELDS.map((key) => [key, null])) as CompanyDetails;
}

export function presentCompany(row: ProjectCompanyRow | undefined): CompanyDetails {
	if (!row) return empty();

	return Object.fromEntries(COMPANY_FIELDS.map((key) => [key, row[key] ?? null])) as CompanyDetails;
}

export async function companyFor(projectId: string): Promise<CompanyDetails> {
	const [row] = (await Database`SELECT * FROM project_company WHERE project = ${projectId}`) as ProjectCompanyRow[];
	return presentCompany(row);
}

export async function saveCompany(projectId: string, changes: Partial<Record<CompanyField, string | null>>): Promise<CompanyDetails> {
	const current = await companyFor(projectId);

	const merged = { ...current };
	for (const key of COMPANY_FIELDS) {
		if (!(key in changes)) continue;

		const value = changes[key];
		merged[key] = typeof value === "string" && value.trim() !== "" ? value.trim() : null;
	}

	const timestamp = Date.now();
	const [existing] = (await Database`SELECT project FROM project_company WHERE project = ${projectId}`) as { project: string }[];

	if (existing) {
		await Database`
			UPDATE project_company SET
				legal_name = ${merged.legal_name}, address_line1 = ${merged.address_line1}, address_line2 = ${merged.address_line2},
				postal_code = ${merged.postal_code}, city = ${merged.city}, state = ${merged.state}, country = ${merged.country},
				vat_number = ${merged.vat_number}, tax_number = ${merged.tax_number}, registration_number = ${merged.registration_number},
				email = ${merged.email}, phone = ${merged.phone}, website = ${merged.website}, footer_note = ${merged.footer_note},
				updated = ${timestamp}
			WHERE project = ${projectId}
		`;
		return merged;
	}

	await Database`
		INSERT INTO project_company(project, legal_name, address_line1, address_line2, postal_code, city, state, country,
			vat_number, tax_number, registration_number, email, phone, website, footer_note, created, updated)
		VALUES(${projectId}, ${merged.legal_name}, ${merged.address_line1}, ${merged.address_line2}, ${merged.postal_code},
			${merged.city}, ${merged.state}, ${merged.country}, ${merged.vat_number}, ${merged.tax_number},
			${merged.registration_number}, ${merged.email}, ${merged.phone}, ${merged.website}, ${merged.footer_note},
			${timestamp}, ${timestamp})
	`;

	return merged;
}

function countryLine(country: string | null, language: string | undefined): string | null {
	if (!country || !language || !isCountryCode(country)) return country;
	try {
		return new Intl.DisplayNames([localeFor(language)], { type: "region" }).of(country) ?? country;
	} catch {
		return country;
	}
}

export function addressLines(details: CompanyDetails, language?: string): string[] {
	const town = [details.postal_code, details.city].filter(Boolean).join(" ");

	return [details.address_line1, details.address_line2, town, details.state, countryLine(details.country, language)].filter((line): line is string =>
		Boolean(line && line.trim())
	);
}
