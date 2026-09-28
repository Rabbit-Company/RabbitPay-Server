import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { availableFor, configFor } from "../../payments/methods";
import { companyFor, displayNameOf } from "../../company";
import { bankInstruction } from "../../payments/bank";
import { rateFor } from "../../rates/forex";
import { assignAddress as assignBitcoin, paymentUri as bitcoinUri, requiredConfirmations as bitcoinConfirmations } from "../../payments/bitcoin";
import {
	assignAddress as assignEthereum,
	chainId,
	paymentUri as ethereumUri,
	requiredConfirmations as ethereumConfirmations,
	WEI_PER_GWEI,
} from "../../payments/ethereum";
import { assignAddress as assignMonero, paymentUri as moneroUri, requiredConfirmations as moneroConfirmations } from "../../payments/monero";
import { createPaypalOrder, createStripeCheckout } from "../../payments/checkout";
import { paypalClient, stripeClient } from "../../crypto/chains";
import { outstandingOf } from "../../invoicing";
import { groupKeys, heldKeysOf } from "../../key-delivery";
import { whiteLabelActive } from "../../licensing";
import { brandingOf, loadLogo } from "../../branding";
import { invoicePdf, pdfResponse } from "../../invoice-pdf";
import { issueSnapshotFor, snapshotLogo } from "../../invoice-snapshot";
import { creditNoteSnapshotFor, creditNoteSnapshotLogo } from "../../credit-note-snapshot";
import { acceptsPayment, awaitsStorePayment } from "../../payments/recorded";
import type { CreditNoteRow, InvoiceItemRow, InvoiceRow, ProjectRow } from "../../database/models";

const publicLimit = rateLimit({ windowMs: 60 * 1000, max: 60, message: "Too many requests. Please slow down." });
const documentLimit = rateLimit({ windowMs: 60 * 1000, max: 10, message: "Too many requests. Please slow down." });

interface PublicContext {
	project: ProjectRow;
	invoice: InvoiceRow;
}

async function load(invoiceId: string): Promise<PublicContext | null> {
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	if (!invoice) return null;

	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${invoice.project} AND status != 'deleted'`) as ProjectRow[];
	if (!project) return null;

	return { project, invoice };
}

Server.app.get("/api/v1/public/projects/:uuid/logo", publicLimit, async (ctx) => {
	const projectId = ctx.params["uuid"];
	if (!Validate.uuid(projectId)) return Utils.fail(ctx, ErrorCode.INVALID_PROJECT);

	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${projectId} AND status != 'deleted'`) as ProjectRow[];
	if (!project) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);

	const creditNoteId = ctx.query().get("credit_note");
	if (creditNoteId !== null) {
		if (!Validate.uuid(creditNoteId)) return Utils.fail(ctx, ErrorCode.INVALID_CREDIT_NOTE_ID);
		const [note] = (await Database`SELECT uuid FROM credit_notes WHERE uuid = ${creditNoteId} AND project = ${projectId}`) as Pick<CreditNoteRow, "uuid">[];
		const snapshot = note ? await creditNoteSnapshotFor(creditNoteId) : null;
		if (!snapshot?.settings.branding.white_label) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);
		const logo = await creditNoteSnapshotLogo(creditNoteId);
		if (!logo) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);
		return new Response(logo.bytes, {
			headers: {
				"Content-Type": logo.type,
				"Cache-Control": "public, max-age=31536000, immutable",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'",
			},
		});
	}

	const invoiceId = ctx.query().get("invoice");
	if (invoiceId !== null) {
		if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);
		const [invoice] = (await Database`SELECT uuid FROM invoices WHERE uuid = ${invoiceId} AND project = ${projectId} AND status != 'draft'`) as {
			uuid: string;
		}[];
		const snapshot = invoice ? await issueSnapshotFor(invoiceId) : null;
		if (!snapshot?.settings.branding.white_label) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);
		const logo = await snapshotLogo(invoiceId);
		if (!logo) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);
		return new Response(logo.bytes, {
			headers: {
				"Content-Type": logo.type,
				"Cache-Control": "public, max-age=31536000, immutable",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'",
			},
		});
	}

	if (!whiteLabelActive(project)) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);

	const logo = await loadLogo(project.uuid);
	if (!logo) return Utils.fail(ctx, ErrorCode.PROJECT_NOT_FOUND);

	return new Response(logo.bytes, {
		headers: {
			"Content-Type": logo.type,
			"Cache-Control": "public, max-age=300",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'",
		},
	});
});

Server.app.get("/api/v1/public/invoices/:invoice", publicLimit, async (ctx) => {
	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const found = await load(invoiceId);
	const order = found ? await awaitsStorePayment(found.invoice) : false;
	if (!found || (found.invoice.status === "draft" && !order)) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	const items = (await Database`
		SELECT description, quantity, unit, unit_price, tax_rate, tax_amount, total_price FROM invoice_items WHERE invoice = ${invoiceId} ORDER BY sort_order
	`) as InvoiceItemRow[];

	const methods = found.invoice.status === "paid" || found.invoice.status === "canceled" ? [] : await availableFor(found.project.uuid);

	const keys = found.invoice.status === "paid" ? await heldKeysOf(invoiceId, "delivered") : [];
	const pending = found.invoice.status === "paid" && keys.length === 0 ? (await heldKeysOf(invoiceId, "reserved")).length > 0 : false;

	return Utils.ok(ctx, {
		reference: found.invoice.reference,
		document: order ? "order" : "invoice",
		merchant: displayNameOf(found.project),
		status: found.invoice.status,
		currency: found.invoice.currency,
		subtotal: found.invoice.subtotal,
		discount_amount: found.invoice.discount_amount,
		tax_amount: found.invoice.tax_amount,
		total_amount: found.invoice.total_amount,
		paid_amount: found.invoice.paid_amount,
		outstanding: outstandingOf(found.invoice),
		due_date: found.invoice.due_date,
		notes: found.invoice.notes,
		date_format: found.project.date_format,
		time_format: found.project.time_format,
		timezone: found.project.timezone,
		language: found.project.language,
		accent_color: found.project.accent_color,
		branding: brandingOf(found.project),
		items,
		methods: methods.map((method) => ({ processor: method.processor, label: method.label, kind: method.kind })),
		keys: groupKeys(keys).map((group) => ({ name: group.name, codes: group.codes })),
		keys_pending: pending,
	});
});

Server.app.get("/api/v1/public/invoices/:invoice/pdf", documentLimit, async (ctx) => {
	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const found = await load(invoiceId);
	if (!found || found.invoice.status === "draft") return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);

	return pdfResponse(await invoicePdf(found.project, found.invoice, { payLink: Boolean(found.project.email_pay_link) }));
});

Server.app.post("/api/v1/public/invoices/:invoice/pay/:processor", publicLimit, async (ctx) => {
	const invoiceId = ctx.params["invoice"];
	if (!Validate.uuid(invoiceId)) return Utils.fail(ctx, ErrorCode.INVALID_INVOICE_ID);

	const found = await load(invoiceId);
	if (!found) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_FOUND);
	if (!(await acceptsPayment(found.invoice))) return Utils.fail(ctx, ErrorCode.INVOICE_NOT_PAYABLE);

	const processor = ctx.params["processor"];
	const available = await availableFor(found.project.uuid);
	if (!available.some((method) => method.processor === processor)) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

	const needsRate = processor === "bitcoin" || processor === "ethereum" || processor === "monero";
	let rate = 0;

	if (needsRate) {
		const resolved = await rateFor(found.invoice.currency, processor);
		if (resolved === null) return Utils.fail(ctx, ErrorCode.RATE_UNAVAILABLE);
		rate = resolved;
	}

	try {
		if (processor === "bitcoin") {
			const assigned = await assignBitcoin(found.project, found.invoice, rate);
			return Utils.ok(ctx, {
				processor,
				kind: "crypto",
				address: assigned.address,
				amount: assigned.expected_amount,
				unit: "satoshi",
				uri: bitcoinUri(assigned.address, assigned.expected_amount ?? 0, found.invoice.reference),
				confirmations_required: bitcoinConfirmations(),
				exchange_rate: assigned.exchange_rate ?? undefined,
				expires_at: assigned.expires_at,
			});
		}

		if (processor === "ethereum") {
			const assigned = await assignEthereum(found.project, found.invoice, rate);
			const wei = BigInt(assigned.expected_amount ?? 0) * WEI_PER_GWEI;
			return Utils.ok(ctx, {
				processor,
				kind: "crypto",
				address: assigned.address,
				amount: wei.toString(),
				unit: "wei",
				chain_id: chainId(),
				uri: ethereumUri(assigned.address, wei),
				confirmations_required: ethereumConfirmations(),
				exchange_rate: assigned.exchange_rate ?? undefined,
				expires_at: assigned.expires_at,
			});
		}

		if (processor === "monero") {
			const assigned = await assignMonero(found.project, found.invoice, rate);
			const piconero = BigInt(assigned.expected_amount ?? 0);
			return Utils.ok(ctx, {
				processor,
				kind: "crypto",
				address: assigned.address,
				amount: piconero.toString(),
				unit: "piconero",
				uri: moneroUri(assigned.address, piconero, found.invoice.reference),
				confirmations_required: moneroConfirmations(),
				exchange_rate: assigned.exchange_rate ?? undefined,
				expires_at: assigned.expires_at,
			});
		}

		if (processor === "bank_transfer") {
			const instruction = bankInstruction({
				config: await configFor(found.project.uuid, "bank_transfer"),
				company: await companyFor(found.project.uuid),
				merchant: displayNameOf(found.project),
				reference: found.invoice.reference,
				totalMinorUnits: outstandingOf(found.invoice),
				currency: found.invoice.currency,
				language: found.project.language,
			});

			if (!instruction) return Utils.fail(ctx, ErrorCode.PROCESSOR_UNAVAILABLE);

			return Utils.ok(ctx, { processor, kind: "bank", ...instruction });
		}

		const credentials = await configFor(found.project.uuid, processor);
		const hosted =
			processor === "stripe"
				? await createStripeCheckout(stripeClient(credentials), found.project, found.invoice)
				: await createPaypalOrder(paypalClient(credentials), found.project, found.invoice);

		return Utils.ok(ctx, { processor, kind: "card", checkout_url: hosted.checkoutUrl, expires_at: hosted.session.expires_at });
	} catch (err) {
		Logger.error(`[PUBLIC] Could not start a ${processor} payment for ${found.invoice.reference}: ${err}`);
		return Utils.fail(ctx, ErrorCode.PROCESSOR_UNAVAILABLE);
	}
});
