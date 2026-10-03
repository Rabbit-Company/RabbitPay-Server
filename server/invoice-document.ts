import Utils from "./utils";
import { url as urlPayload } from "@rabbit-company/qrcode/payload";
import { displayNameOf, type CompanyDetails } from "./company";
import { bankInstruction, type BankInstruction } from "./payments/bank";
import { availableFor, configFor } from "./payments/methods";
import { loadItems } from "./invoice-service";
import { outstandingOf } from "./invoicing";
import { partiesFor, taxDetailsFor } from "./document-parts";
import { brandingOf, invoiceDesignOf } from "./branding";
import { withDesignDefaults } from "./invoice-design";
import { draftInvoiceIssuer } from "./invoice-issuer";
import { issueSnapshotFor } from "./invoice-snapshot";
import { fiscalMarks } from "./fiscal/documents";
import { referenceDocumentOf } from "./reference-document";
import Database from "./database/database";
import { documentKindOf, proformaFor } from "./proformas";
import type { InvoiceItemRow, InvoiceRow, ProjectRow } from "./database/models";

export async function invoiceBank(
	project: ProjectRow,
	invoice: InvoiceRow,
	company: CompanyDetails,
	methods: Awaited<ReturnType<typeof availableFor>>
): Promise<BankInstruction | null> {
	if (!methods.some((method) => method.processor === "bank_transfer")) return null;

	const outstanding = outstandingOf(invoice);
	if (outstanding <= 0) return null;
	return bankInstruction({
		config: await configFor(project.uuid, "bank_transfer"),
		company,
		merchant: displayNameOf(project),
		reference: invoice.reference,
		totalMinorUnits: outstanding,
		currency: invoice.currency,
		language: project.language,
	});
}

export async function invoiceDocument(project: ProjectRow, invoice: InvoiceRow, options: { archival?: boolean; items?: InvoiceItemRow[] } = {}) {
	const items = options.items ?? (await loadItems(invoice.uuid));
	const kind = await documentKindOf(invoice);
	const proforma = kind === "proforma" ? await proformaFor(invoice.uuid) : null;
	const sourceProforma = (
		kind === "advance" && invoice.proforma ? await Database`SELECT reference FROM proformas WHERE invoice = ${invoice.proforma}` : []
	)[0] as { reference: string } | undefined;
	const snapshot = invoice.status === "draft" ? null : await issueSnapshotFor(invoice.uuid);
	if (invoice.status !== "draft" && !snapshot) throw new Error("Issued invoice snapshot is missing");
	const { company, seller, buyer } = await partiesFor(project, invoice, snapshot?.seller);

	const issuedState = options.archival ? snapshot?.settings.issued_state : null;
	const outstanding = issuedState?.outstanding ?? outstandingOf(invoice);
	const methods = snapshot ? [] : await availableFor(project.uuid);
	const online = snapshot?.settings.online ?? {
		card: methods.some((method) => method.kind === "card"),
		crypto: methods.some((method) => method.kind === "crypto"),
	};
	const bank = snapshot
		? options.archival
			? snapshot.settings.bank
			: snapshot.settings.bank_config && outstanding > 0
				? bankInstruction({
						config: snapshot.settings.bank_config,
						company,
						merchant: seller.name,
						reference: invoice.reference,
						totalMinorUnits: outstanding,
						currency: invoice.currency,
						language: snapshot.settings.language,
					})
				: null
		: await invoiceBank(project, invoice, company, methods);
	const showIssuer = snapshot?.settings.issuer_visible ?? Boolean(project.invoice_issuer_details);
	const liveIssuer = showIssuer && invoice.status === "draft" ? await draftInvoiceIssuer(project.uuid, invoice.created_by) : null;
	const [savedSignature] =
		!showIssuer || invoice.status === "draft"
			? []
			: ((await Database`
				SELECT asset.data
				FROM invoice_issuer_signature_versions invoice_signature
				JOIN project_member_signature_versions version ON version.uuid = invoice_signature.signature_version
				JOIN signature_assets asset ON asset.signature_hash = version.signature_hash
				WHERE invoice_signature.invoice = ${invoice.uuid}
			`) as { data: string }[]);
	const issuer = !showIssuer
		? null
		: invoice.issuer_name
			? { name: invoice.issuer_name, signature: savedSignature ? `data:image/png;base64,${savedSignature.data}` : null }
			: liveIssuer
				? { name: liveIssuer.name, signature: liveIssuer.signature ? `data:image/png;base64,${liveIssuer.signature}` : null }
				: null;

	const payUrl = snapshot?.settings.pay_url ?? `${Utils.publicUrl()}/pay/${invoice.uuid}`;
	const status = issuedState?.status ?? invoice.status;
	const payable = outstanding > 0 && status !== "canceled" && (status !== "draft" || kind === "proforma" || kind === "order") && (online.card || online.crypto);
	const branding = snapshot
		? {
				white_label: snapshot.settings.branding.white_label,
				logo: snapshot.settings.branding.logo_storage_key ? `/api/v1/public/projects/${project.uuid}/logo?invoice=${encodeURIComponent(invoice.uuid)}` : null,
			}
		: brandingOf(project);
	const design = snapshot ? withDesignDefaults(snapshot.settings.design) : invoiceDesignOf(project);

	return {
		kind,
		proforma: proforma ? { reference: proforma.reference, settlement: proforma.settlement, issued_at: proforma.issued_at } : null,
		source_proforma: sourceProforma?.reference ?? null,
		seller,
		buyer,
		invoice: {
			reference: invoice.reference,
			status,
			currency: invoice.currency,
			subtotal: invoice.subtotal,
			discount_amount: invoice.discount_amount,
			tax_amount: invoice.tax_amount,
			total_amount: invoice.total_amount,
			paid_amount: issuedState?.paid_amount ?? invoice.paid_amount,
			refunded_amount: issuedState?.refunded_amount ?? invoice.refunded_amount,
			credited_amount: issuedState?.credited_amount ?? invoice.credited_amount,
			outstanding,
			notes: invoice.notes,
			issued: invoice.issued_at ?? proforma?.issued_at ?? invoice.created,
			advanced_amount: invoice.advanced_amount,
			due_date: invoice.source === "pos" ? null : invoice.due_date,
			supply_date: invoice.supply_date,
			paid_date: issuedState?.paid_date ?? invoice.paid_date,
			reference_document: referenceDocumentOf(invoice),
		},
		items: items.map((item) => ({
			description: item.description,
			quantity: item.quantity,
			unit: item.unit,
			unit_price: item.unit_price,
			tax_rate: item.tax_rate,
			tax_amount: item.tax_amount,
			total_price: item.total_price,
			tax_treatment: item.tax_treatment,
			discount_amount: item.discount_amount,
		})),
		tax:
			snapshot?.settings.tax ??
			taxDetailsFor(
				project,
				invoice,
				items.map((item) => item.tax_treatment),
				invoice.tax_amount
			),
		formats: snapshot
			? { timezone: project.timezone, ...snapshot.settings.formats }
			: { date: project.date_format, time: project.time_format, timezone: project.timezone },
		language: snapshot?.settings.language ?? project.language,
		branding,
		design,
		closing_note: invoice.source === "pos" ? design.notes.receipt : design.notes.invoice,
		issuer,
		bank,
		online,
		fiscal: await fiscalMarks({ invoice: invoice.uuid }),
		pay_url: payUrl,
		pay_qr: payable ? { format: "url", payload: urlPayload(payUrl, { compact: false }), encoding: "utf8" } : null,
	};
}
