import { buildCreditNotePdf, buildInvoicePdf, type CreditNoteDocument, type InvoiceDocument, type LogoSource } from "./invoice-render";
import { buildPayslipsPdf, type PayslipsInput } from "./workforce/payslip-render";
import { buildMonthReportPdf, type MonthReportInput } from "./workforce/report-render";
import { buildDunningPdf, type DunningDocument } from "./dunning-render";
import { buildAccountantPackagePdf } from "./accountant-package-render";
import type { AccountantPackage } from "./accountant-package-types";

export type RenderJob =
	| { kind: "invoice"; document: InvoiceDocument; logo: LogoSource | null; payLink: boolean }
	| { kind: "credit_note"; document: CreditNoteDocument; logo: LogoSource | null }
	| { kind: "dunning_letter"; document: DunningDocument; logo: LogoSource | null }
	| { kind: "payslips"; input: PayslipsInput }
	| { kind: "month_report"; input: MonthReportInput }
	| { kind: "accountant_package"; input: AccountantPackage };

export async function renderJob(job: RenderJob): Promise<Uint8Array> {
	switch (job.kind) {
		case "invoice":
			return await buildInvoicePdf(job.document, job.logo, { payLink: job.payLink });
		case "credit_note":
			return await buildCreditNotePdf(job.document, job.logo);
		case "dunning_letter":
			return await buildDunningPdf(job.document, job.logo);
		case "payslips":
			return await buildPayslipsPdf(job.input);
		case "month_report":
			return await buildMonthReportPdf(job.input);
		case "accountant_package":
			return await buildAccountantPackagePdf(job.input);
	}
}
