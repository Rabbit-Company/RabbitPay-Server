import { reportRoutes } from "../../report-routes";
import Database from "../../database/database";
import { addIntegers, safeInteger } from "../../database/numbers";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { convertMinor, reportingCurrency } from "../../tax-reporting";
import { isTaxTreatment, splitVatNumber, type TaxTreatment } from "../../tax";
import type { CreditNoteItemRow, InvoiceItemRow, InvoiceRow, RecordedInvoiceLineRow, RecordedInvoiceRow } from "../../database/models";

type ZeroRated = Exclude<TaxTreatment, "domestic" | "oss">;

interface BookedLine {
	net: number;
	vat: number;
	rate: number;
	treatment: string | null;
}

interface RateLine {
	rate: number;
	net: number;
	vat: number;
}

function bound(value: string | null, fallback: number): number | null {
	if (value === null || value === "") return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function addTo<K>(map: Map<K, RateLine>, key: K, rate: number, net: number, vat: number) {
	const entry = map.get(key) ?? { rate, net: 0, vat: 0 };
	entry.net = addIntegers(entry.net, net);
	entry.vat = addIntegers(entry.vat, vat);
	map.set(key, entry);
}

reportRoutes("/api/v1/projects/:uuid/reports/vat", "vat", (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const from = bound(query.get("from"), 0);
	const to = bound(query.get("to"), Number.MAX_SAFE_INTEGER);
	if (from === null || to === null || from > to) return Utils.fail(ctx, ErrorCode.INVALID_REPORT_PERIOD);

	return async () => {
		const currency = reportingCurrency(project);

		const invoices = (await Database`
			SELECT * FROM invoices
			WHERE project = ${project.uuid} AND status <> 'draft' AND issued_at IS NOT NULL
				AND issued_at >= ${from} AND issued_at <= ${to}
				AND (status <> 'canceled' OR EXISTS (SELECT 1 FROM credit_notes cn WHERE cn.invoice = invoices.uuid))
			ORDER BY issued_at ASC
		`) as InvoiceRow[];

		const invoiceLines = invoices.length
			? ((await Database`
					SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.uuid = ii.invoice
					WHERE i.project = ${project.uuid} AND i.status <> 'draft' AND i.issued_at IS NOT NULL
						AND i.issued_at >= ${from} AND i.issued_at <= ${to}
				`) as InvoiceItemRow[])
			: [];

		const notes = (await Database`
			SELECT cn.uuid AS note_uuid, cn.reference AS note_reference, cn.issued_at AS note_issued_at, i.*
			FROM credit_notes cn JOIN invoices i ON i.uuid = cn.invoice
			WHERE cn.project = ${project.uuid} AND cn.issued_at >= ${from} AND cn.issued_at <= ${to}
			ORDER BY cn.issued_at ASC
		`) as (InvoiceRow & { note_uuid: string; note_reference: string; note_issued_at: number })[];

		const noteLines = notes.length
			? ((await Database`
					SELECT cni.* FROM credit_note_items cni JOIN credit_notes cn ON cn.uuid = cni.credit_note
					WHERE cn.project = ${project.uuid} AND cn.issued_at >= ${from} AND cn.issued_at <= ${to}
				`) as CreditNoteItemRow[])
			: [];

		const grouped = <T>(rows: T[], key: (row: T) => string) => {
			const map = new Map<string, T[]>();
			for (const row of rows) {
				const list = map.get(key(row)) ?? [];
				list.push(row);
				map.set(key(row), list);
			}
			return map;
		};

		const linesByInvoice = grouped(invoiceLines, (line) => line.invoice);
		const linesByNote = grouped(noteLines, (line) => line.credit_note);

		const domestic = new Map<number, RateLine>();
		const oss = new Map<string, RateLine & { country: string }>();
		const zeroRated = new Map<ZeroRated, number>();
		const salesList = new Map<string, { vat_number: string; country: string; goods: number; services: number }>();
		const domesticReverse = new Map<string, number>();
		const missingRates: { invoice: string; reference: string; currency: string; issued_at: number | null }[] = [];
		const missingDetails: { invoice: string; reference: string; reason: string }[] = [];
		let counted = 0;
		let creditNotes = 0;

		const rateFor = (invoice: Pick<InvoiceRow, "currency" | "tax_currency" | "tax_exchange_rate">): number | null => {
			if (invoice.currency === currency) return 1;
			if (invoice.tax_currency === currency && invoice.tax_exchange_rate !== null) return invoice.tax_exchange_rate;
			return null;
		};

		const book = (
			invoice: Pick<InvoiceRow, "uuid" | "currency" | "buyer_country" | "buyer_vat_number">,
			reference: string,
			rate: number,
			lines: BookedLine[],
			sign: 1 | -1
		) => {
			const convert = (amount: number) => sign * safeInteger(convertMinor(amount, invoice.currency, rate, currency));

			for (const line of lines) {
				const net = convert(line.net);
				const vat = convert(line.vat);
				const treatment: TaxTreatment = isTaxTreatment(line.treatment) ? line.treatment : "domestic";

				if (treatment === "domestic") {
					addTo(domestic, line.rate, line.rate, net, vat);
					continue;
				}

				if (treatment === "oss") {
					const country = invoice.buyer_country ?? "";
					if (!country) missingDetails.push({ invoice: invoice.uuid, reference, reason: "OSS line without a customer country" });
					const key = `${country}|${line.rate}`;
					const entry = oss.get(key) ?? { country, rate: line.rate, net: 0, vat: 0 };
					entry.net = addIntegers(entry.net, net);
					entry.vat = addIntegers(entry.vat, vat);
					oss.set(key, entry);
					continue;
				}

				zeroRated.set(treatment, addIntegers(zeroRated.get(treatment) ?? 0, net));

				if (treatment === "domestic_reverse_charge") {
					const parts = splitVatNumber(invoice.buyer_vat_number, invoice.buyer_country);
					if (!parts) {
						missingDetails.push({ invoice: invoice.uuid, reference, reason: "Domestic reverse charge sale without a VAT number for the customer" });
						continue;
					}
					const key = `${parts.prefix}${parts.number}`;
					domesticReverse.set(key, addIntegers(domesticReverse.get(key) ?? 0, net));
				}

				if (treatment === "reverse_charge" || treatment === "intra_eu_goods") {
					const parts = splitVatNumber(invoice.buyer_vat_number, invoice.buyer_country);
					if (!parts) {
						missingDetails.push({ invoice: invoice.uuid, reference, reason: "EU sale without an EU VAT number for the customer" });
						continue;
					}
					const key = `${parts.prefix}${parts.number}`;
					const entry = salesList.get(key) ?? { vat_number: key, country: parts.country, goods: 0, services: 0 };
					if (treatment === "intra_eu_goods") entry.goods = addIntegers(entry.goods, net);
					else entry.services = addIntegers(entry.services, net);
					salesList.set(key, entry);
				}
			}
		};

		for (const invoice of invoices) {
			const rate = rateFor(invoice);
			if (rate === null) {
				missingRates.push({ invoice: invoice.uuid, reference: invoice.reference, currency: invoice.currency, issued_at: invoice.issued_at });
				continue;
			}

			counted++;
			book(
				invoice,
				invoice.reference,
				rate,
				(linesByInvoice.get(invoice.uuid) ?? []).map((line) => ({
					net: line.total_price - line.discount_amount,
					vat: line.tax_amount,
					rate: line.tax_rate,
					treatment: line.tax_treatment,
				})),
				1
			);
		}

		for (const note of notes) {
			const rate = rateFor(note);
			if (rate === null) {
				missingRates.push({ invoice: note.uuid, reference: note.note_reference, currency: note.currency, issued_at: note.note_issued_at });
				continue;
			}

			creditNotes++;
			book(
				note,
				note.note_reference,
				rate,
				(linesByNote.get(note.note_uuid) ?? []).map((line) => ({
					net: line.net_amount,
					vat: line.tax_amount,
					rate: line.tax_rate,
					treatment: line.tax_treatment,
				})),
				-1
			);
		}

		const recorded = (await Database`
			SELECT * FROM recorded_invoices WHERE project = ${project.uuid} AND issued_at >= ${from} AND issued_at <= ${to} ORDER BY issued_at ASC
		`) as RecordedInvoiceRow[];
		const recordedLines = recorded.length
			? ((await Database`
					SELECT * FROM recorded_invoice_lines WHERE recorded_invoice IN ${Database(recorded.map((row) => row.uuid))}
				`) as RecordedInvoiceLineRow[])
			: [];
		const linesByRecord = grouped(recordedLines, (line) => line.recorded_invoice);
		for (const record of recorded) {
			const rate = rateFor(record);
			if (rate === null) {
				missingRates.push({ invoice: record.uuid, reference: record.reference, currency: record.currency, issued_at: record.issued_at });
				continue;
			}
			if (record.document_type === "credit_note") creditNotes++;
			else counted++;
			book(
				record,
				record.reference,
				rate,
				(linesByRecord.get(record.uuid) ?? []).map((line) => ({
					net: line.net_amount,
					vat: line.tax_amount,
					rate: line.tax_rate,
					treatment: line.tax_treatment,
				})),
				record.document_type === "credit_note" ? -1 : 1
			);
		}

		const domesticRows = [...domestic.values()].sort((a, b) => b.rate - a.rate);
		const ossRows = [...oss.values()].sort((a, b) => a.country.localeCompare(b.country) || b.rate - a.rate);
		const zeroRows = [...zeroRated.entries()].map(([treatment, net]) => ({ treatment, net })).sort((a, b) => a.treatment.localeCompare(b.treatment));
		const listRows = [...salesList.values()].sort((a, b) => a.country.localeCompare(b.country) || a.vat_number.localeCompare(b.vat_number));

		const sum = (rows: { net: number; vat?: number }[], key: "net" | "vat") => rows.reduce((total, row) => addIntegers(total, row[key] ?? 0), 0);

		return {
			from,
			to,
			currency,
			invoices: counted,
			credit_notes: creditNotes,
			domestic: domesticRows,
			oss: ossRows,
			zero_rated: zeroRows,
			ec_sales_list: listRows,
			domestic_reverse_list: [...domesticReverse.entries()]
				.map(([vat_number, net]) => ({ vat_number, net }))
				.sort((a, b) => a.vat_number.localeCompare(b.vat_number)),
			totals: {
				net: addIntegers(sum(domesticRows, "net"), sum(ossRows, "net"), sum(zeroRows, "net")),
				domestic_vat: sum(domesticRows, "vat"),
				oss_vat: sum(ossRows, "vat"),
			},
			missing_rates: missingRates,
			missing_details: missingDetails,
		};
	};
});
