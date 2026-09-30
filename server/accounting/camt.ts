import { createHash } from "node:crypto";
import { child, children, parseXml, textOf, XmlSyntaxError, type XmlElement } from "../xml-reader";
import { isLocalDate, startOfLocalDate } from "../timezone";
import { parseImportAmount } from "./recorded-import";

export interface CamtTransaction {
	booking_date: number;
	value_date: number | null;
	amount: number;
	currency: string;
	counterparty_name: string | null;
	counterparty_iban: string | null;
	reference: string | null;
	remittance: string | null;
	bank_reference: string | null;
	fingerprint: string;
}

export interface CamtStatement {
	iban: string;
	statement_id: string;
	currency: string;
	period_from: number | null;
	period_to: number | null;
	opening_balance: number | null;
	closing_balance: number | null;
	transactions: CamtTransaction[];
}

export class CamtUnreadable extends Error {}

function day(value: string | null, timezone: string): number | null {
	const text = value?.slice(0, 10) ?? "";
	return isLocalDate(text) ? startOfLocalDate(text, timezone) : null;
}

function date(element: XmlElement | undefined, timezone: string): number | null {
	return day(textOf(element, "Dt"), timezone) ?? day(textOf(element, "DtTm"), timezone);
}

function amountOf(element: XmlElement | undefined): { amount: number; currency: string } | null {
	if (!element) return null;
	const currency = element.attributes.Ccy ?? element.attributes.ccy;
	if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
	const amount = parseImportAmount(element.text.trim(), currency);
	return amount === null ? null : { amount, currency };
}

function signed(amount: number, indicator: string | null): number {
	return indicator === "DBIT" ? -amount : amount;
}

function balance(statement: XmlElement, code: string): { amount: number; date: number | null } | null {
	for (const entry of children(statement, "Bal")) {
		const type = textOf(entry, "Tp", "CdOrPrtry", "Cd");
		if (type !== code) continue;
		const value = amountOf(child(entry, "Amt"));
		if (value) return { amount: signed(value.amount, textOf(entry, "CdtDbtInd")), date: null };
	}
	return null;
}

function party(details: XmlElement | undefined, role: "Dbtr" | "Cdtr"): { name: string | null; iban: string | null } {
	const related = child(details, "RltdPties");
	const name = textOf(related, role, "Nm") ?? textOf(related, role, "Pty", "Nm");
	const iban = textOf(related, `${role}Acct`, "Id", "IBAN");
	return { name, iban: iban ? iban.replace(/\s+/g, "").toUpperCase() : null };
}

function remittanceOf(details: XmlElement | undefined, entry: XmlElement): { reference: string | null; text: string | null } {
	const info = child(details, "RmtInf");
	const reference = textOf(info, "Strd", "CdtrRefInf", "Ref");
	const lines = [...children(info, "Ustrd").map((line) => line.text.trim()), textOf(details, "AddtlTxInf"), textOf(entry, "AddtlNtryInf")].filter(
		(line): line is string => Boolean(line)
	);
	return {
		reference: reference ? reference.replace(/\s+/g, "").toUpperCase() : null,
		text: lines.length ? [...new Set(lines)].join(" ").slice(0, 1000) : null,
	};
}

export function parseCamt053(source: string, timezone: string): CamtStatement[] {
	let root: XmlElement;
	try {
		root = parseXml(source);
	} catch (error) {
		if (error instanceof XmlSyntaxError) throw new CamtUnreadable(error.message);
		throw error;
	}
	const report = child(root, "BkToCstmrStmt");
	if (!report) throw new CamtUnreadable("The file is not a camt.053 bank statement.");

	return children(report, "Stmt").map((statement) => {
		const iban = textOf(statement, "Acct", "Id", "IBAN")?.replace(/\s+/g, "").toUpperCase();
		const statementId = textOf(statement, "Id") ?? textOf(statement, "ElctrncSeqNb");
		if (!iban || !statementId) throw new CamtUnreadable("A statement has no account IBAN or statement number.");
		const currency = textOf(statement, "Acct", "Ccy") ?? "EUR";
		const transactions: CamtTransaction[] = [];
		for (const entry of children(statement, "Ntry")) {
			const status = textOf(entry, "Sts", "Cd") ?? textOf(entry, "Sts");
			if (status && status !== "BOOK") continue;
			const indicator = textOf(entry, "CdtDbtInd");
			const total = amountOf(child(entry, "Amt"));
			const booked = date(child(entry, "BookgDt"), timezone) ?? date(child(entry, "ValDt"), timezone);
			if (!total || booked === null) throw new CamtUnreadable("An entry has no amount or booking date.");
			const valued = date(child(entry, "ValDt"), timezone);
			const bankReference = textOf(entry, "AcctSvcrRef");
			const details = children(entry, "NtryDtls").flatMap((block) => children(block, "TxDtls"));
			const parts =
				details.length > 1 && details.every((detail) => amountOf(child(detail, "Amt")) ?? amountOf(child(detail, "AmtDtls", "TxAmt", "Amt")))
					? details
					: [details[0]];
			parts.forEach((detail, index) => {
				const value = parts.length > 1 ? (amountOf(child(detail, "Amt")) ?? amountOf(child(detail, "AmtDtls", "TxAmt", "Amt")))! : total;
				const amount = signed(value.amount, textOf(detail, "CdtDbtInd") ?? indicator);
				if (amount === 0) return;
				const counterparty = party(detail, amount > 0 ? "Dbtr" : "Cdtr");
				const remittance = remittanceOf(detail, entry);
				const endToEnd = textOf(detail, "Refs", "EndToEndId");
				const fingerprint = createHash("sha256")
					.update([iban, booked, amount, value.currency, bankReference, endToEnd, remittance.reference, remittance.text, counterparty.iban, index].join("|"))
					.digest("hex");
				transactions.push({
					booking_date: booked,
					value_date: valued,
					amount,
					currency: value.currency,
					counterparty_name: counterparty.name?.slice(0, 250) ?? null,
					counterparty_iban: counterparty.iban?.slice(0, 34) ?? null,
					reference: remittance.reference?.slice(0, 64) ?? null,
					remittance: remittance.text,
					bank_reference: bankReference?.slice(0, 250) ?? null,
					fingerprint,
				});
			});
		}
		const dates = transactions.map((transaction) => transaction.booking_date);
		return {
			iban,
			statement_id: statementId.slice(0, 140),
			currency,
			period_from: day(textOf(statement, "FrToDt", "FrDtTm"), timezone) ?? (dates.length ? Math.min(...dates) : null),
			period_to: day(textOf(statement, "FrToDt", "ToDtTm"), timezone) ?? (dates.length ? Math.max(...dates) : null),
			opening_balance: balance(statement, "OPBD")?.amount ?? balance(statement, "PRCD")?.amount ?? null,
			closing_balance: balance(statement, "CLBD")?.amount ?? null,
			transactions,
		};
	});
}
