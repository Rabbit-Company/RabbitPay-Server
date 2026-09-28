import { isPlausibleIban, normalizeIban } from "../payments/bank";
import type { PayrollCalculation } from "./payroll-runs";
import type { PayrollRunRow } from "../database/models";

const NAMESPACE = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.03";

export interface SepaDebtor {
	name: string;
	iban: string;
	bic: string | null;
}

export interface SepaProblem {
	field: "debtor_iban" | "pay_date" | "employee_iban" | "currency" | "no_payments";
	person?: string;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sepaText(value: string, limit: number): string {
	const latin = value
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return escapeXml(latin.slice(0, limit).trim() || "-");
}

function amount(cents: number): string {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function payable(lines: PayrollCalculation[]): PayrollCalculation[] {
	return lines.filter((line) => line.payout !== null && line.payout > 0);
}

export function sepaProblems(run: PayrollRunRow, lines: PayrollCalculation[], debtor: SepaDebtor | null, currency: string): SepaProblem[] {
	const problems: SepaProblem[] = [];
	if (!debtor || !isPlausibleIban(debtor.iban)) problems.push({ field: "debtor_iban" });
	if (!run.pay_date) problems.push({ field: "pay_date" });
	if (currency !== "EUR") problems.push({ field: "currency" });
	const payments = payable(lines);
	if (payments.length === 0) problems.push({ field: "no_payments" });
	for (const line of payments) {
		if (!line.employee.iban || !isPlausibleIban(line.employee.iban)) problems.push({ field: "employee_iban", person: line.person });
	}
	return problems;
}

export function salaryTransfersXml(run: PayrollRunRow, lines: PayrollCalculation[], debtor: SepaDebtor, createdAt: Date): string {
	const payments = payable(lines);
	const total = payments.reduce((sum, line) => sum + line.payout!, 0);
	const stamp = createdAt.toISOString().slice(0, 19);
	const messageId = `PAY-${run.period}-${run.uuid.slice(0, 8)}-${createdAt.getTime().toString(36)}`.slice(0, 35);
	const [year, month] = run.period.split("-");
	const bic = debtor.bic?.trim().toUpperCase();
	const debtorAgent = bic
		? `<DbtrAgt><FinInstnId><BIC>${escapeXml(bic)}</BIC></FinInstnId></DbtrAgt>`
		: `<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>`;

	const transfers = payments
		.map((line, index) =>
			[
				"<CdtTrfTxInf>",
				`<PmtId><EndToEndId>${escapeXml(`SAL-${run.period}-${index + 1}`)}</EndToEndId></PmtId>`,
				`<Amt><InstdAmt Ccy="EUR">${amount(line.payout!)}</InstdAmt></Amt>`,
				`<Cdtr><Nm>${sepaText(line.person, 70)}</Nm></Cdtr>`,
				`<CdtrAcct><Id><IBAN>${normalizeIban(line.employee.iban!)}</IBAN></Id></CdtrAcct>`,
				"<Purp><Cd>SALA</Cd></Purp>",
				`<RmtInf><Ustrd>${sepaText(`Placa ${month}/${year}`, 140)}</Ustrd></RmtInf>`,
				"</CdtTrfTxInf>",
			].join("")
		)
		.join("");

	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<Document xmlns="${NAMESPACE}"><CstmrCdtTrfInitn>` +
		`<GrpHdr><MsgId>${escapeXml(messageId)}</MsgId><CreDtTm>${stamp}</CreDtTm><NbOfTxs>${payments.length}</NbOfTxs>` +
		`<CtrlSum>${amount(total)}</CtrlSum><InitgPty><Nm>${sepaText(debtor.name, 70)}</Nm></InitgPty></GrpHdr>` +
		`<PmtInf><PmtInfId>${escapeXml(messageId)}</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg>` +
		`<NbOfTxs>${payments.length}</NbOfTxs><CtrlSum>${amount(total)}</CtrlSum>` +
		`<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><CtgyPurp><Cd>SALA</Cd></CtgyPurp></PmtTpInf>` +
		`<ReqdExctnDt>${run.pay_date}</ReqdExctnDt><Dbtr><Nm>${sepaText(debtor.name, 70)}</Nm></Dbtr>` +
		`<DbtrAcct><Id><IBAN>${normalizeIban(debtor.iban)}</IBAN></Id></DbtrAcct>${debtorAgent}<ChrgBr>SLEV</ChrgBr>` +
		`${transfers}</PmtInf></CstmrCdtTrfInitn></Document>\n`
	);
}
