import type { SQL } from "bun";
import Database from "./database/database";
import Utils from "./utils";
import { companyFor, displayNameOf, type CompanyDetails } from "./company";
import { brandingOf, invoiceDesignOf, loadLogo } from "./branding";
import type { InvoiceDesign } from "./invoice-design";
import { documentStorage } from "./document-storage";
import { availableFor, configFor } from "./payments/methods";
import { bankInstruction, type BankInstruction } from "./payments/bank";
import { taxDetailsFor } from "./document-parts";
import { outstandingOf } from "./invoicing";
import type { InvoiceIssueSnapshotRow, InvoiceItemRow, InvoiceRow, ProjectRow } from "./database/models";

const SNAPSHOT_VERSION = 1;
const RENDERER_VERSION = 1;

export interface PreparedIssuePresentation {
	seller: CompanyDetails & { name: string };
	vat_status: string | null;
	tax_country: string | null;
	vat_exemption_note: string | null;
	formats: { date: string; time: string; timezone: string };
	language: string;
	branding: { white_label: boolean; logo_storage_key: string | null; logo_content_type: string | null };
	issuer_visible: boolean;
	bank_config: Record<string, string> | null;
	online: { card: boolean; crypto: boolean };
	public_url: string;
	pdf_pay_link: boolean;
	design: InvoiceDesign;
}

export interface StoredIssueSettings {
	renderer_version: number;
	tax: ReturnType<typeof taxDetailsFor>;
	formats: { date: string; time: string; timezone?: string };
	language: string;
	branding: { white_label: boolean; logo_storage_key: string | null; logo_content_type: string | null };
	issuer_visible: boolean;
	bank_config: Record<string, string> | null;
	bank: BankInstruction | null;
	online: { card: boolean; crypto: boolean };
	pay_url: string;
	pdf_pay_link: boolean;
	design?: InvoiceDesign;
	issued_state: {
		status: string;
		paid_amount: number;
		refunded_amount: number;
		credited_amount: number;
		outstanding: number;
		paid_date: number | null;
	};
}

export interface StoredIssueSnapshot {
	seller: CompanyDetails & { name: string };
	settings: StoredIssueSettings;
}

function digest(data: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export async function prepareIssuePresentation(project: ProjectRow): Promise<PreparedIssuePresentation> {
	const company = await companyFor(project.uuid);
	const methods = await availableFor(project.uuid);
	const branding = brandingOf(project);
	const logo = branding.logo ? await loadLogo(project.uuid) : null;
	let logoStorageKey: string | null = null;

	if (logo) {
		const hash = digest(logo.bytes);
		logoStorageKey = `assets/logos/${hash}`;
		const storage = documentStorage();
		if (!(await storage.exists(logoStorageKey))) await storage.put(logoStorageKey, logo.bytes, logo.type);
	}

	return {
		seller: { ...company, name: displayNameOf(project) },
		vat_status: project.vat_status,
		tax_country: project.tax_country,
		vat_exemption_note: project.vat_exemption_note,
		formats: { date: project.date_format, time: project.time_format, timezone: project.timezone },
		language: project.language,
		branding: { white_label: branding.white_label, logo_storage_key: logoStorageKey, logo_content_type: logo?.type ?? null },
		issuer_visible: Boolean(project.invoice_issuer_details),
		bank_config: methods.some((method) => method.processor === "bank_transfer") ? await configFor(project.uuid, "bank_transfer") : null,
		online: {
			card: methods.some((method) => method.kind === "card"),
			crypto: methods.some((method) => method.kind === "crypto"),
		},
		public_url: Utils.publicUrl(),
		pdf_pay_link: Boolean(project.email_pay_link),
		design: invoiceDesignOf(project),
	};
}

export async function saveIssuePresentation(sql: SQL, invoiceId: string, prepared: PreparedIssuePresentation, created: number) {
	const [invoice] = (await sql`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	if (!invoice) throw new Error("Invoice not found while saving its issue snapshot");
	const items = (await sql`SELECT * FROM invoice_items WHERE invoice = ${invoiceId} ORDER BY sort_order`) as InvoiceItemRow[];
	const project: Pick<ProjectRow, "vat_status" | "tax_country" | "vat_exemption_note" | "language"> = {
		vat_status: prepared.vat_status,
		tax_country: prepared.tax_country,
		vat_exemption_note: prepared.vat_exemption_note,
		language: prepared.language,
	};
	const outstanding = outstandingOf(invoice);
	const bank = prepared.bank_config
		? bankInstruction({
				config: prepared.bank_config,
				company: prepared.seller,
				merchant: prepared.seller.name,
				reference: invoice.reference,
				totalMinorUnits: outstanding > 0 ? outstanding : invoice.total_amount,
				currency: invoice.currency,
				language: prepared.language,
			})
		: null;
	const settings: StoredIssueSettings = {
		renderer_version: RENDERER_VERSION,
		tax: taxDetailsFor(
			project,
			invoice,
			items.map((item) => item.tax_treatment),
			invoice.tax_amount
		),
		formats: prepared.formats,
		language: prepared.language,
		branding: prepared.branding,
		issuer_visible: prepared.issuer_visible,
		bank_config: prepared.bank_config,
		bank,
		online: prepared.online,
		pay_url: `${prepared.public_url}/pay/${invoice.uuid}`,
		pdf_pay_link: prepared.pdf_pay_link,
		design: prepared.design,
		issued_state: {
			status: invoice.status,
			paid_amount: invoice.paid_amount,
			refunded_amount: invoice.refunded_amount,
			credited_amount: invoice.credited_amount,
			outstanding,
			paid_date: invoice.paid_date,
		},
	};
	const storageKey = `invoices/${invoice.project}/${invoice.uuid}/${crypto.randomUUID()}.pdf`;

	await sql`
		INSERT INTO invoice_issue_snapshots(invoice, schema_version, seller_details, document_settings, created)
		VALUES(${invoice.uuid}, ${SNAPSHOT_VERSION}, ${JSON.stringify(prepared.seller)}, ${JSON.stringify(settings)}, ${created})
	`;
	await sql`
		INSERT INTO invoice_documents(invoice, storage_key, content_type, byte_size, sha256, status, attempts, last_error, next_attempt_at, created, updated)
		VALUES(${invoice.uuid}, ${storageKey}, ${"application/pdf"}, ${null}, ${null}, ${"pending"}, 0, ${null}, ${created}, ${created}, ${created})
	`;
}

export async function issueSnapshotFor(invoiceId: string): Promise<StoredIssueSnapshot | null> {
	const [row] = (await Database`SELECT * FROM invoice_issue_snapshots WHERE invoice = ${invoiceId}`) as InvoiceIssueSnapshotRow[];
	if (!row || row.schema_version !== SNAPSHOT_VERSION) return null;
	return {
		seller: JSON.parse(row.seller_details) as StoredIssueSnapshot["seller"],
		settings: JSON.parse(row.document_settings) as StoredIssueSettings,
	};
}

export async function snapshotLogo(invoiceId: string): Promise<{ type: string; bytes: Buffer } | null> {
	const snapshot = await issueSnapshotFor(invoiceId);
	const key = snapshot?.settings.branding.logo_storage_key;
	const type = snapshot?.settings.branding.logo_content_type;
	if (!key || !type) return null;
	return { type, bytes: Buffer.from(await documentStorage().get(key)) };
}
