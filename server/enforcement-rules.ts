import { legalNameParts } from "./legal-name";

export const COURT_FEE_PAPER = 5500;
export const ELECTRONIC_FEE_DISCOUNT_PERCENT = 20;
export const COURT_FEE_ELECTRONIC = (COURT_FEE_PAPER * (100 - ELECTRONIC_FEE_DISCOUNT_PERCENT)) / 100;
export const COURT_FEE_PAYMENT_DAYS = 8;
export const OBJECTION_DAYS = 8;
export const PROPOSALS_PER_HOUR = 10;
export const ENFORCEMENT_CURRENCY = "EUR";
export const ECOVL_SCHEMA_VERSION = "1.6";
export const INVOICE_CATALOGUE_NUMBER = "1";
export const MAX_COURT_CASE_LENGTH = 40;

export type EnforcementStatus = "prepared" | "filed";
export type PartyKind = "person" | "company" | "sole_trader";
export type ClaimKind = "invoice" | "compensation";

export const ENFORCEMENT_STATUSES: EnforcementStatus[] = ["prepared", "filed"];

const PARTY_CODES: Record<PartyKind, string> = { person: "001", company: "002", sole_trader: "003" };
const STREET_AND_NUMBER = /^(.*?\S)[\s,]+(\d{1,4}\s?[a-zA-Z]?(?:\s?\/\s?\d{1,4}[a-zA-Z]?)?)$/;
const SOLE_TRADER_SUFFIX = /(?:^|[\s,])s\.\s*p\.?(?:$|[\s,])/i;

export interface StreetAddress {
	street: string;
	house_number: string;
}

export interface EnforcementParty {
	kind: PartyKind;
	first_name: string | null;
	name: string;
	registration_number: string | null;
	tax_number: string | null;
	street: string;
	house_number: string;
	postal_code: string;
	city: string;
	iban: string | null;
}

export interface EnforcementClaim {
	kind: ClaimKind;
	reference: string;
	label: string;
	issue_date: string;
	due_date: string;
	amount: number;
	interest_from: string | null;
}

export interface EnforcementMeans {
	bank_accounts: boolean;
	salary: boolean;
}

export interface EnforcementDocument {
	creditor: EnforcementParty;
	debtor: EnforcementParty;
	claims: EnforcementClaim[];
	commercial: boolean;
	means: EnforcementMeans;
	court_fee: number;
}

export interface EnforcementTotals {
	principal: number;
	compensation: number;
	claims: number;
	court_fee: number;
}

export function splitStreet(line: string | null | undefined): StreetAddress | null {
	const match = STREET_AND_NUMBER.exec((line ?? "").trim().replace(/\s+/g, " "));
	if (!match) return null;
	return { street: match[1]!.replace(/,$/, "").trim(), house_number: match[2]!.replace(/\s+/g, "") };
}

export function slovenianPostalCode(value: string | null | undefined): string | null {
	const digits = (value ?? "").trim().replace(/^SI\s*-?\s*/i, "");
	return /^\d{4}$/.test(digits) ? digits : null;
}

export function slovenianTaxNumber(value: string | null | undefined): string | null {
	const digits = (value ?? "").toUpperCase().replace(/^SI/, "").replace(/\s+/g, "");
	return /^\d{8}$/.test(digits) ? digits : null;
}

export function slovenianRegistrationNumber(value: string | null | undefined): string | null {
	const digits = (value ?? "").replace(/\s+/g, "");
	return /^\d{7}(\d{3})?$/.test(digits) ? digits : null;
}

export function partyKind(name: string, business: boolean): PartyKind {
	if (!business) return "person";
	return SOLE_TRADER_SUFFIX.test(legalNameParts(name).name) || SOLE_TRADER_SUFFIX.test(name) ? "sole_trader" : "company";
}

export function splitPersonName(fullName: string): { first_name: string; last_name: string } | null {
	const words = fullName.trim().split(/\s+/).filter(Boolean);
	if (words.length < 2) return null;
	return { first_name: words.slice(0, -1).join(" "), last_name: words[words.length - 1]! };
}

export function formatSlovenianIban(iban: string): string {
	const compact = iban.replace(/\s+/g, "").toUpperCase();
	return compact.startsWith("SI56") ? `SI56 ${compact.slice(4)}` : compact;
}

export function enforcementTotals(document: Pick<EnforcementDocument, "claims" | "court_fee">): EnforcementTotals {
	const principal = document.claims.filter((claim) => claim.kind === "invoice").reduce((sum, claim) => sum + claim.amount, 0);
	const compensation = document.claims.filter((claim) => claim.kind === "compensation").reduce((sum, claim) => sum + claim.amount, 0);
	return { principal, compensation, claims: principal + compensation, court_fee: document.court_fee };
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function attributes(values: Record<string, string | null | undefined>): string {
	return Object.entries(values)
		.filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined && entry[1] !== "")
		.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
		.join("");
}

function euros(minor: number): string {
	return (minor / 100).toFixed(2);
}

function participantXml(id: string, party: EnforcementParty, indent: string): string {
	const person = party.kind === "person";
	const head = `${indent}<VLUdelezenec${attributes({
		idUdelezenec: id,
		"ime-naziv": person ? party.first_name : null,
		"priimek-naziv": party.name,
		vrsta: PARTY_CODES[party.kind],
		drzavljanstvo: "SVN",
		maticnaSt: person ? null : party.registration_number,
		davcnaStevilka: party.tax_number,
	})}>`;
	const address = `${indent}\t<VLNaslov${attributes({
		ulica: party.street,
		hisnaStevilka: party.house_number,
		sifPosta: party.postal_code,
		nazivPosta: party.city,
		drzava: "SVN",
	})}/>`;
	const account = party.iban
		? `${indent}\t<VLTransakcijskiRacun${attributes({
				stevilkaRacuna: formatSlovenianIban(party.iban),
				vrstaRacuna: party.iban.replace(/\s+/g, "").toUpperCase().startsWith("SI56") ? "SI_IBAN" : "Ostalo",
				naziv: person ? null : party.name,
				ime: person ? party.first_name : null,
				priimek: person ? party.name : null,
			})}/>`
		: null;
	return [head, address, account, `${indent}</VLUdelezenec>`].filter((line): line is string => line !== null).join("\n");
}

function claimXml(claim: EnforcementClaim, indent: string): string {
	const opening = `${indent}<VerodostojnaListina${attributes({
		sifListina: INVOICE_CATALOGUE_NUMBER,
		oznaka: claim.label,
		datum: claim.issue_date,
		datumZapadlosti: claim.due_date,
		znesek: euros(claim.amount),
		valuta: ENFORCEMENT_CURRENCY,
	})}`;
	if (!claim.interest_from) return `${opening}/>`;
	return [
		`${opening}>`,
		`${indent}\t<ZamudneObresti>`,
		`${indent}\t\t<ObrestZakonska odDatuma="${claim.interest_from}"/>`,
		`${indent}\t</ZamudneObresti>`,
		`${indent}</VerodostojnaListina>`,
	].join("\n");
}

function meansXml(means: EnforcementMeans, debtorKind: PartyKind, indent: string): string {
	const lines: string[] = [];
	if (means.salary && debtorKind !== "company") lines.push(`${indent}<StalniDenarniPrejemki placa="true" ostalo="true" vec="false" izbrano="true"/>`);
	if (means.bank_accounts) lines.push(`${indent}<DenarnaSredstvaOPP vec="false" izbrano="true"/>`);
	return lines.join("\n");
}

export function proposalXml(document: EnforcementDocument): string {
	const multipleClaims = document.claims.length > 1 ? "true" : "false";
	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<Predlog gospodarskaZadeva="${document.commercial ? "true" : "false"}" verzijaSheme="${ECOVL_SCHEMA_VERSION}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="eCOVL.xsd">`,
		`\t<VsiUdelezenci>`,
		participantXml("1", document.creditor, "\t\t"),
		participantXml("2", document.debtor, "\t\t"),
		`\t</VsiUdelezenci>`,
		`\t<Upniki vec="false">`,
		`\t\t<VLUpnik refUdelezenec="1"/>`,
		`\t</Upniki>`,
		`\t<Dolzniki vec="false">`,
		`\t\t<VLDolznik refUdelezenec="2">`,
		`\t\t\t<PredlaganaIzvrsba>`,
		meansXml(document.means, document.debtor.kind, "\t\t\t\t"),
		`\t\t\t</PredlaganaIzvrsba>`,
		`\t\t</VLDolznik>`,
		`\t</Dolzniki>`,
		`\t<OznakaZahtevka>`,
		`\t\t<VerodostojneListine vec="${multipleClaims}">`,
		...document.claims.map((claim) => claimXml(claim, "\t\t\t")),
		`\t\t</VerodostojneListine>`,
		`\t\t<StroskiUpnika zakonskeZamudneObresti="true">`,
		`\t\t\t<StrosekTaksa zahtevani="true"/>`,
		`\t\t</StroskiUpnika>`,
		`\t</OznakaZahtevka>`,
		`</Predlog>`,
		``,
	].join("\n");
}

export function isEnforcementStatus(value: unknown): value is EnforcementStatus {
	return value === "prepared" || value === "filed";
}
