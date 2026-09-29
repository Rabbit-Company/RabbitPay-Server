import { buildCreditNotePdf, buildInvoicePdf, type CreditNoteDocument, type InvoiceDocument, type LogoSource } from "./invoice-render";
import { buildPayslipsPdf, type PayslipsInput } from "./workforce/payslip-render";
import { buildMonthReportPdf, type MonthReportInput } from "./workforce/report-render";

export type RenderJob =
	| { kind: "invoice"; document: InvoiceDocument; logo: LogoSource | null; payLink: boolean }
	| { kind: "credit_note"; document: CreditNoteDocument; logo: LogoSource | null }
	| { kind: "payslips"; input: PayslipsInput }
	| { kind: "month_report"; input: MonthReportInput };

export async function renderJob(job: RenderJob): Promise<Uint8Array> {
	switch (job.kind) {
		case "invoice":
			return await buildInvoicePdf(job.document, job.logo, { payLink: job.payLink });
		case "credit_note":
			return await buildCreditNotePdf(job.document, job.logo);
		case "payslips":
			return await buildPayslipsPdf(job.input);
		case "month_report":
			return await buildMonthReportPdf(job.input);
	}
}
