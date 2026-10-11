import Database from "./database/database";
import { safeInteger } from "./database/numbers";
import { taxIdentity, partnerName } from "./accounting/sources";
import { isPlausibleIban, normalizeIban } from "./payments/bank";
import { escapeXml, sepaAmount, sepaText, type SepaDebtor } from "./workforce/sepa";
import type { ExpenseRow, SupplierRow } from "./database/models";

const NAMESPACE = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03";

export interface PayableExpense {
	uuid: string;
	supplier: string | null;
	invoice_number: string | null;
	description: string;
	amount: number;
	currency: string;
	due_date: number | null;
	expense_date: number;
	iban: string | null;
	reference: string | null;
	payment_ordered_at: number | null;
}

export interface PaymentProblem {
	field: "debtor_iban" | "execution_date" | "payee_iban" | "currency";
	expense?: string;
	supplier?: string | null;
}

function supplierKeys(row: Pick<SupplierRow, "name" | "tax_number">): string[] {
	const tax = taxIdentity(row.tax_number);
	return [...(tax ? [`tax:${tax}`] : []), `name:${partnerName(row.name)}`];
}

export async function payableExpenses(project: string, only: string[] | null = null): Promise<PayableExpense[]> {
	const expenses = (
		only === null
			? await Database`SELECT * FROM expenses WHERE project = ${project} AND paid_at IS NULL ORDER BY COALESCE(due_date, expense_date) ASC LIMIT 500`
			: only.length === 0
				? []
				: await Database`SELECT * FROM expenses WHERE project = ${project} AND paid_at IS NULL AND uuid IN ${Database(only)}`
	) as ExpenseRow[];
	const suppliers = (await Database`SELECT name, tax_number, iban FROM suppliers WHERE project = ${project} AND iban IS NOT NULL`) as Pick<
		SupplierRow,
		"name" | "tax_number" | "iban"
	>[];
	const ibans = new Map<string, string>();
	for (const supplier of suppliers) for (const key of supplierKeys(supplier)) ibans.set(key, supplier.iban!);
	return expenses.map((expense) => {
		const keys = expense.supplier ? supplierKeys({ name: expense.supplier, tax_number: expense.supplier_tax_number }) : [];
		const known = keys.map((key) => ibans.get(key)).find((iban) => iban !== undefined);
		return {
			uuid: expense.uuid,
			supplier: expense.supplier,
			invoice_number: expense.invoice_number,
			description: expense.description,
			amount: safeInteger(expense.total_amount),
			currency: expense.currency,
			due_date: expense.due_date === null ? null : safeInteger(expense.due_date),
			expense_date: safeInteger(expense.expense_date),
			iban: expense.payee_iban ?? known ?? null,
			reference: expense.payee_reference,
			payment_ordered_at: expense.payment_ordered_at === null ? null : safeInteger(expense.payment_ordered_at),
		};
	});
}

export function paymentProblems(expenses: PayableExpense[], debtor: SepaDebtor | null, executionDate: string | null): PaymentProblem[] {
	const problems: PaymentProblem[] = [];
	if (!debtor || !isPlausibleIban(debtor.iban)) problems.push({ field: "debtor_iban" });
	if (!executionDate) problems.push({ field: "execution_date" });
	for (const expense of expenses) {
		if (expense.currency !== "EUR") problems.push({ field: "currency", expense: expense.uuid, supplier: expense.supplier });
		else if (!expense.iban || !isPlausibleIban(expense.iban)) problems.push({ field: "payee_iban", expense: expense.uuid, supplier: expense.supplier });
	}
	return problems;
}

function remittance(expense: PayableExpense): string {
	const reference = (expense.reference ?? "").replace(/\s+/g, "").toUpperCase();
	if (/^(SI|RF)\d{2}[A-Z0-9-]{1,31}$/.test(reference)) {
		return `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${escapeXml(reference)}</Ref></CdtrRefInf></Strd></RmtInf>`;
	}
	return `<RmtInf><Ustrd>${sepaText(expense.reference ?? expense.invoice_number ?? expense.description, 140)}</Ustrd></RmtInf>`;
}

export function supplierTransfersXml(expenses: PayableExpense[], debtor: SepaDebtor, executionDate: string, createdAt: Date): string {
	const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
	const stamp = createdAt.toISOString().slice(0, 19);
	const messageId = `SUP-${executionDate}-${createdAt.getTime().toString(36)}`.slice(0, 35);
	const bic = debtor.bic?.trim().toUpperCase();
	const debtorAgent = bic
		? `<DbtrAgt><FinInstnId><BIC>${escapeXml(bic)}</BIC></FinInstnId></DbtrAgt>`
		: `<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>`;
	const transfers = expenses
		.map((expense, index) =>
			[
				"<CdtTrfTxInf>",
				`<PmtId><EndToEndId>${escapeXml(`SUP-${index + 1}-${expense.uuid.slice(0, 8)}`)}</EndToEndId></PmtId>`,
				`<Amt><InstdAmt Ccy="EUR">${sepaAmount(expense.amount)}</InstdAmt></Amt>`,
				`<Cdtr><Nm>${sepaText(expense.supplier ?? expense.description, 70)}</Nm></Cdtr>`,
				`<CdtrAcct><Id><IBAN>${normalizeIban(expense.iban!)}</IBAN></Id></CdtrAcct>`,
				"<Purp><Cd>SUPP</Cd></Purp>",
				remittance(expense),
				"</CdtTrfTxInf>",
			].join("")
		)
		.join("");
	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<Document xmlns="${NAMESPACE}"><CstmrCdtTrfInitn>` +
		`<GrpHdr><MsgId>${escapeXml(messageId)}</MsgId><CreDtTm>${stamp}</CreDtTm><NbOfTxs>${expenses.length}</NbOfTxs>` +
		`<CtrlSum>${sepaAmount(total)}</CtrlSum><InitgPty><Nm>${sepaText(debtor.name, 70)}</Nm></InitgPty></GrpHdr>` +
		`<PmtInf><PmtInfId>${escapeXml(messageId)}</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>false</BtchBookg>` +
		`<NbOfTxs>${expenses.length}</NbOfTxs><CtrlSum>${sepaAmount(total)}</CtrlSum>` +
		`<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>` +
		`<ReqdExctnDt>${executionDate}</ReqdExctnDt><Dbtr><Nm>${sepaText(debtor.name, 70)}</Nm></Dbtr>` +
		`<DbtrAcct><Id><IBAN>${normalizeIban(debtor.iban)}</IBAN></Id></DbtrAcct>${debtorAgent}<ChrgBr>SLEV</ChrgBr>` +
		`${transfers}</PmtInf></CstmrCdtTrfInitn></Document>\n`
	);
}
