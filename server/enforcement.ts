import Database from "./database/database";
import { companyFor } from "./company";
import { configFor } from "./payments/methods";
import { isPlausibleIban, normalizeIban } from "./payments/bank";
import { isLocalDate, shiftLocalDate } from "./timezone";
import { compensationAllowed, interestAvailable } from "./dunning-rules";
import { findCustomer, isBusinessCustomer, linesWithState, todayFor } from "./dunning";
import {
	COURT_FEE_ELECTRONIC,
	ENFORCEMENT_CURRENCY,
	enforcementTotals,
	partyKind,
	slovenianPostalCode,
	slovenianRegistrationNumber,
	slovenianTaxNumber,
	splitPersonName,
	splitStreet,
	type EnforcementClaim,
	type EnforcementDocument,
	type EnforcementMeans,
	type EnforcementParty,
	type PartyKind,
} from "./enforcement-rules";
import type { CustomerRow, DunningLetterRow, EnforcementProposalRow, ProjectRow } from "./database/models";

export type ReadinessIssue =
	| "not_final_letter"
	| "deadline_not_passed"
	| "currency_not_eur"
	| "project_not_slovenian"
	| "creditor_name"
	| "creditor_address"
	| "creditor_postal_code"
	| "creditor_city"
	| "creditor_identifier"
	| "creditor_iban"
	| "debtor_missing"
	| "debtor_name"
	| "debtor_person_name"
	| "debtor_address"
	| "debtor_postal_code"
	| "debtor_city"
	| "debtor_country"
	| "debtor_identifier"
	| "nothing_open"
	| "issue_date_missing";

export interface EnforcementRequest {
	interest?: unknown;
	compensation?: unknown;
	bank_accounts?: unknown;
	salary?: unknown;
	issue_dates?: unknown;
}

export interface EnforcementOptions {
	interest: boolean;
	compensation: boolean;
	means: EnforcementMeans;
	issue_dates: Record<string, string>;
}

export interface PlannedClaim extends EnforcementClaim {
	line: string;
	invoice: string | null;
	original_amount: number;
	needs_issue_date: boolean;
}

export interface EnforcementPlan {
	today: string;
	issues: ReadinessIssue[];
	debtor_kind: PartyKind | null;
	commercial: boolean;
	interest_available: boolean;
	compensation_available: boolean;
	claims: PlannedClaim[];
	paid_lines: number;
	document: EnforcementDocument | null;
	proposals: { uuid: string; status: string; court_case: string | null; created: number }[];
}

function invoiceLabel(reference: string, open: number, amount: number): string {
	if (open >= amount) return `račun št. ${reference}`;
	return `račun št. ${reference}, delno plačan, terja se preostanek ${(open / 100).toFixed(2).replace(".", ",")} EUR od ${(amount / 100).toFixed(2).replace(".", ",")} EUR`;
}

function compensationLabel(reference: string, letterNumber: string): string {
	return `nadomestilo stroškov izterjave po 14. členu ZPreZP-1 za račun št. ${reference}, obračunano z opominom št. ${letterNumber}`;
}

async function creditorParty(project: ProjectRow, issues: ReadinessIssue[]): Promise<EnforcementParty> {
	const company = await companyFor(project.uuid);
	const bank = await configFor(project.uuid, "bank_transfer");
	const name = company.legal_name?.trim() ?? "";
	const street = splitStreet(company.address_line1);
	const postal = slovenianPostalCode(company.postal_code);
	const registration = slovenianRegistrationNumber(company.registration_number);
	const tax = slovenianTaxNumber(company.tax_number) ?? slovenianTaxNumber(company.vat_number);
	const iban = normalizeIban(bank.iban ?? "");
	if (!name) issues.push("creditor_name");
	if (!street) issues.push("creditor_address");
	if (!postal) issues.push("creditor_postal_code");
	if (!company.city?.trim()) issues.push("creditor_city");
	if (!registration && !tax) issues.push("creditor_identifier");
	if (!iban || !isPlausibleIban(iban)) issues.push("creditor_iban");
	return {
		kind: partyKind(name, true),
		first_name: null,
		name,
		registration_number: registration,
		tax_number: tax,
		street: street?.street ?? "",
		house_number: street?.house_number ?? "",
		postal_code: postal ?? "",
		city: company.city?.trim() ?? "",
		iban: iban || null,
	};
}

function debtorParty(customer: CustomerRow, issues: ReadinessIssue[]): EnforcementParty {
	const fullName = customer.name?.trim() ?? "";
	const kind = partyKind(fullName, isBusinessCustomer(customer));
	const person = kind === "person" ? splitPersonName(fullName) : null;
	const street = splitStreet(customer.address_line1);
	const postal = slovenianPostalCode(customer.postal_code);
	const registration = slovenianRegistrationNumber(customer.registration_number);
	const tax = slovenianTaxNumber(customer.tax_number) ?? slovenianTaxNumber(customer.vat_number);
	if (!fullName) issues.push("debtor_name");
	else if (kind === "person" && !person) issues.push("debtor_person_name");
	if (customer.country && customer.country.toUpperCase() !== "SI") issues.push("debtor_country");
	if (!street) issues.push("debtor_address");
	if (!postal) issues.push("debtor_postal_code");
	if (!customer.city?.trim()) issues.push("debtor_city");
	if (kind !== "person" && !registration && !tax) issues.push("debtor_identifier");
	return {
		kind,
		first_name: person?.first_name ?? null,
		name: person?.last_name ?? fullName,
		registration_number: registration,
		tax_number: tax,
		street: street?.street ?? "",
		house_number: street?.house_number ?? "",
		postal_code: postal ?? "",
		city: customer.city?.trim() ?? "",
		iban: null,
	};
}

export function enforcementOptions(data: EnforcementRequest, defaults: { compensation: boolean; salary: boolean }): EnforcementOptions | null {
	for (const key of ["interest", "compensation", "bank_accounts", "salary"] as const) {
		if (data[key] !== undefined && typeof data[key] !== "boolean") return null;
	}
	const issueDates: Record<string, string> = {};
	if (data.issue_dates !== undefined && data.issue_dates !== null) {
		if (typeof data.issue_dates !== "object" || Array.isArray(data.issue_dates)) return null;
		for (const [line, date] of Object.entries(data.issue_dates as Record<string, unknown>)) {
			if (!isLocalDate(date)) return null;
			issueDates[line] = date;
		}
	}
	const means = { bank_accounts: data.bank_accounts !== false, salary: typeof data.salary === "boolean" ? data.salary : defaults.salary };
	if (!means.bank_accounts && !means.salary) return null;
	return {
		interest: data.interest !== false,
		compensation: typeof data.compensation === "boolean" ? data.compensation : defaults.compensation,
		means,
		issue_dates: issueDates,
	};
}

export async function proposalsForLetter(letter: string): Promise<EnforcementProposalRow[]> {
	return (await Database`SELECT * FROM enforcement_proposals WHERE dunning_letter = ${letter} ORDER BY created DESC`) as EnforcementProposalRow[];
}

export async function planEnforcement(
	project: ProjectRow,
	letter: DunningLetterRow,
	data: EnforcementRequest = {},
	now = Date.now()
): Promise<EnforcementPlan | null> {
	const today = todayFor(project, now);
	const issues: ReadinessIssue[] = [];
	if (Number(letter.level) !== 3) issues.push("not_final_letter");
	if (letter.deadline_date >= today) issues.push("deadline_not_passed");
	if (letter.currency !== ENFORCEMENT_CURRENCY) issues.push("currency_not_eur");
	if (project.tax_country !== "SI") issues.push("project_not_slovenian");

	const customer = letter.customer ? await findCustomer(project.uuid, letter.customer) : undefined;
	if (!customer) issues.push("debtor_missing");
	const business = customer ? isBusinessCustomer(customer) : false;
	const debtor = customer ? debtorParty(customer, issues) : null;
	const creditor = await creditorParty(project, issues);
	const letterCharged = Boolean(letter.compensation_included);

	const options = enforcementOptions(data, { compensation: letterCharged, salary: debtor?.kind === "person" });
	if (!options) return null;
	const interest = options.interest && interestAvailable(project.tax_country);

	const claims: PlannedClaim[] = [];
	let paidLines = 0;
	let compensationPossible = false;
	for (const line of await linesWithState(letter)) {
		const open = line.open_now ?? Number(line.open_amount);
		if (open <= 0) {
			paidLines++;
			continue;
		}
		const issueDate = line.issue_date ?? options.issue_dates[line.uuid] ?? null;
		claims.push({
			kind: "invoice",
			line: line.uuid,
			invoice: line.invoice,
			reference: line.reference,
			label: invoiceLabel(line.reference, open, Number(line.amount)),
			issue_date: issueDate ?? "",
			due_date: line.due_on,
			amount: open,
			original_amount: Number(line.amount),
			interest_from: interest ? shiftLocalDate(line.due_on, 1) : null,
			needs_issue_date: line.issue_date === null,
		});
		const compensationStillDue =
			letterCharged && Number(line.compensation) > 0 && compensationAllowed({ currency: letter.currency, business, dueDate: line.due_on, until: today });
		if (!compensationStillDue) continue;
		compensationPossible = true;
		if (!options.compensation) continue;
		claims.push({
			kind: "compensation",
			line: line.uuid,
			invoice: line.invoice,
			reference: line.reference,
			label: compensationLabel(line.reference, letter.number),
			issue_date: letter.issue_date,
			due_date: letter.deadline_date,
			amount: Number(line.compensation),
			original_amount: Number(line.compensation),
			interest_from: interest ? shiftLocalDate(letter.deadline_date, 1) : null,
			needs_issue_date: false,
		});
	}
	if (!claims.some((claim) => claim.kind === "invoice")) issues.push("nothing_open");
	if (claims.some((claim) => claim.issue_date === "")) issues.push("issue_date_missing");

	const document: EnforcementDocument | null =
		issues.length === 0 && debtor
			? {
					creditor,
					debtor,
					claims: claims.map(({ kind, reference, label, issue_date, due_date, amount, interest_from }) => ({
						kind,
						reference,
						label,
						issue_date,
						due_date,
						amount,
						interest_from,
					})),
					commercial: business,
					means: { bank_accounts: options.means.bank_accounts, salary: options.means.salary && debtor.kind !== "company" },
					court_fee: COURT_FEE_ELECTRONIC,
				}
			: null;

	return {
		today,
		issues,
		debtor_kind: debtor?.kind ?? null,
		commercial: business,
		interest_available: interestAvailable(project.tax_country),
		compensation_available: compensationPossible,
		claims,
		paid_lines: paidLines,
		document,
		proposals: (await proposalsForLetter(letter.uuid)).map((row) => ({
			uuid: row.uuid,
			status: row.status,
			court_case: row.court_case,
			created: Number(row.created),
		})),
	};
}

export async function createProposal(
	project: ProjectRow,
	letter: DunningLetterRow,
	document: EnforcementDocument,
	createdBy: string | null
): Promise<EnforcementProposalRow> {
	const uuid = crypto.randomUUID();
	const timestamp = Date.now();
	const totals = enforcementTotals(document);
	await Database`
		INSERT INTO enforcement_proposals(uuid, project, customer, dunning_letter, status, court_case, filed_date, principal, compensation, court_fee,
			document, created_by, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${letter.customer}, ${letter.uuid}, 'prepared', ${null}, ${null}, ${totals.principal}, ${totals.compensation},
			${totals.court_fee}, ${JSON.stringify(document)}, ${createdBy}, ${timestamp}, ${timestamp})
	`;
	return (await findProposal(project.uuid, uuid))!;
}

export async function findProposal(project: string, proposal: string): Promise<EnforcementProposalRow | undefined> {
	const [row] = (await Database`SELECT * FROM enforcement_proposals WHERE uuid = ${proposal} AND project = ${project}`) as EnforcementProposalRow[];
	return row;
}

export function storedProposal(row: EnforcementProposalRow): EnforcementDocument {
	return JSON.parse(row.document) as EnforcementDocument;
}

export function proposalFilename(row: EnforcementProposalRow, letterNumber: string | null): string {
	const suffix = (letterNumber ?? row.uuid.slice(0, 8)).replace(/[^A-Za-z0-9._-]+/g, "-");
	return `predlog-za-izvrsbo-${suffix}.xml`;
}

export function presentProposal(row: EnforcementProposalRow, extras: { letter_number?: string | null; customer_name?: string | null } = {}) {
	const document = storedProposal(row);
	const totals = enforcementTotals(document);
	return {
		uuid: row.uuid,
		customer: row.customer,
		customer_name: extras.customer_name ?? ([document.debtor.first_name, document.debtor.name].filter(Boolean).join(" ") || null),
		dunning_letter: row.dunning_letter,
		letter_number: extras.letter_number ?? null,
		status: row.status,
		court_case: row.court_case,
		filed_date: row.filed_date,
		principal: totals.principal,
		compensation: totals.compensation,
		claims_total: totals.claims,
		court_fee: totals.court_fee,
		created_by: row.created_by,
		created: Number(row.created),
		updated: Number(row.updated),
	};
}
