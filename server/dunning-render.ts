import { translator, type TranslationKey } from "./i18n";
import { formatDateIn, formatMoneyIn, formatPercentIn, type DateFormat } from "./formats";
import {
	CONTENT_WIDTH,
	MUTED,
	drawClosing,
	drawFooter,
	drawHeader,
	drawLines,
	drawPageFooters,
	drawParties,
	drawPayment,
	drawSection,
	drawSummary,
	prepareIssuer,
	printableLogo,
	sellerExtrasOf,
	startPdf,
	type InvoiceDocument,
	type LineColumn,
	type LogoSource,
	type TotalRow,
} from "./invoice-render";
import type { InvoiceDesign } from "./invoice-design";
import type { BankInstruction } from "./payments/bank";
import type { DunningLevel, InterestPeriod } from "./dunning-rules";

export interface DunningDocumentLine {
	reference: string;
	issue_date: string | null;
	due_on: string;
	amount: number;
	open: number;
	days: number;
	interest: number;
	compensation: number;
}

export interface DunningDocument {
	number: string;
	level: DunningLevel;
	language: string;
	currency: string;
	issue_date: string;
	deadline_date: string;
	seller: InvoiceDocument["seller"];
	buyer: NonNullable<InvoiceDocument["buyer"]>;
	vat_status: string | null;
	tax_country: string | null;
	design: InvoiceDesign;
	branding: { white_label: boolean; logo: string | null };
	date_format: string;
	lines: DunningDocumentLine[];
	totals: { principal: number; interest: number; compensation: number; total: number };
	interest_included: boolean;
	compensation_included: boolean;
	rates: Pick<InterestPeriod, "from" | "to" | "rate">[];
	note: string | null;
	issuer: InvoiceDocument["issuer"];
	bank: BankInstruction | null;
}

export const DUNNING_TITLES: Record<DunningLevel, TranslationKey> = {
	1: "dunning.title_1",
	2: "dunning.title_2",
	3: "dunning.title_3",
};

const INTROS: Record<DunningLevel, TranslationKey> = {
	1: "dunning.intro_1",
	2: "dunning.intro_2",
	3: "dunning.intro_3",
};

export function localDateStamp(date: string): number {
	return Date.parse(`${date}T12:00:00Z`);
}

function compactFormat(document: Pick<DunningDocument, "date_format" | "language">): DateFormat {
	if (document.date_format !== "auto") return document.date_format as DateFormat;
	return document.language === "sl" ? "d. m. yyyy" : "dd/mm/yyyy";
}

export async function buildDunningPdf(document: DunningDocument, logo: LogoSource | null): Promise<Uint8Array> {
	const t = translator(document.language);
	const dateOf = (value: string) => formatDateIn(localDateStamp(value), document.date_format as DateFormat, document.language, "UTC");
	const shortDateOf = (value: string) => formatDateIn(localDateStamp(value), compactFormat(document), document.language, "UTC");
	const format = (amount: number) => formatMoneyIn(amount, document.currency, document.language);
	const title = t(DUNNING_TITLES[document.level]);
	const source = { language: document.language, seller: document.seller, branding: document.branding, design: document.design };
	const { pdf, layout, output } = await startPdf(source, `${title} ${document.number}`);
	const params = { date: dateOf(document.issue_date), deadline: dateOf(document.deadline_date), amount: format(document.totals.total) };

	drawHeader(layout, title, document.number, await printableLogo(logo), [
		[t("dunning.date"), dateOf(document.issue_date)],
		[t("dunning.pay_by"), dateOf(document.deadline_date)],
	]);
	drawParties(
		layout,
		{ seller: document.seller, buyer: document.buyer, language: document.language },
		t,
		sellerExtrasOf(document.seller, document.vat_status, t, document.design.show)
	);

	layout.paragraph(t("dunning.greeting"), CONTENT_WIDTH);
	layout.cursor += layout.gap(6);
	layout.paragraph(t(INTROS[document.level], params), CONTENT_WIDTH);
	layout.cursor += layout.gap(16);

	const withInterest = document.interest_included;
	const columns: LineColumn[] = withInterest
		? [
				{ heading: t("dunning.column_issued"), offset: 295 },
				{ heading: t("dunning.column_due"), offset: 220 },
				{ heading: t("dunning.column_days"), offset: 160 },
				{ heading: t("dunning.column_open"), offset: 80 },
				{ heading: t("dunning.column_interest"), offset: 0 },
			]
		: [
				{ heading: t("dunning.column_issued"), offset: 250 },
				{ heading: t("dunning.column_due"), offset: 170 },
				{ heading: t("dunning.column_days"), offset: 100 },
				{ heading: t("dunning.column_open"), offset: 0 },
			];
	drawLines(
		layout,
		t("dunning.column_document"),
		columns,
		document.lines.map((line) => ({
			description: line.open === line.amount ? line.reference : `${line.reference}\n${t("dunning.document_amount", { amount: format(line.amount) })}`,
			cells: [
				line.issue_date ? shortDateOf(line.issue_date) : "-",
				shortDateOf(line.due_on),
				String(line.days),
				format(line.open),
				...(withInterest ? [format(line.interest)] : []),
			],
		}))
	);

	const totals: TotalRow[] = [
		{ label: t("dunning.principal"), value: format(document.totals.principal) },
		...(withInterest ? [{ label: t("dunning.interest", { date: shortDateOf(document.issue_date) }), value: format(document.totals.interest) }] : []),
		...(document.compensation_included && document.totals.compensation > 0
			? [{ label: t("dunning.compensation"), value: format(document.totals.compensation) }]
			: []),
		{ label: t("dunning.total"), value: format(document.totals.total), strong: true },
	];
	drawSummary(layout, t, [], totals, format, document.language);

	if (document.level === 3) drawSection(layout, null, t("dunning.warning_3"));
	if (document.note) drawSection(layout, null, document.note);

	const legal: string[] = [];
	if (withInterest) {
		legal.push(t("dunning.interest_note", { date: dateOf(document.issue_date) }));
		if (document.rates.length > 0) {
			const rates = document.rates
				.map((period) =>
					t("dunning.rate_period", { rate: formatPercentIn(period.rate, document.language), from: shortDateOf(period.from), to: shortDateOf(period.to) })
				)
				.join(", ");
			legal.push(t("dunning.interest_rates", { rates }));
		}
	} else {
		legal.push(t("dunning.interest_reserved"));
	}
	if (document.compensation_included && document.totals.compensation > 0) {
		legal.push(t(document.tax_country === "SI" ? "dunning.compensation_note_si" : "dunning.compensation_note_eu"));
	}

	const issuer = await prepareIssuer(layout, document, t, 260, "dunning.prepared_by");
	drawPayment(layout, { bank: document.bank, pay_qr: null, online: { card: false, crypto: false } }, t, format, false);
	drawSection(layout, null, t("dunning.paid_already"));
	for (const line of legal) layout.paragraph(line, CONTENT_WIDTH, { size: 8.5, color: MUTED });
	drawFooter(
		layout,
		{ tax: { vat_status: document.vat_status, country: document.tax_country, exemption_note: null, reporting: null, notes: [] }, ...source },
		t,
		document.currency,
		(value) => formatDateIn(value, document.date_format as DateFormat, document.language, "UTC")
	);
	drawClosing(layout, null, issuer, t);
	drawPageFooters(layout, source, t, document.number);

	pdf.end();
	return await output;
}
