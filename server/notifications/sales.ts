import { Permission } from "../roles";
import { money } from "../email/templates";
import type { InvoiceRow, ProjectRow } from "../database/models";
import { accountsWith, announce, ownerAccounts } from "./announce";

export const ONLINE_PROCESSORS = ["bitcoin", "ethereum", "monero", "stripe", "paypal"];

type AnnouncedInvoice = Pick<InvoiceRow, "uuid" | "project" | "reference" | "currency">;

export async function notifyStoreOrder(project: ProjectRow, order: { invoice: string; reference: string; customer: string; amount: number; currency: string }) {
	await announce({
		kind: "store_order",
		project,
		accounts: await accountsWith(project.uuid, Permission.INVOICE_VIEW),
		params: { reference: order.reference, customer: order.customer, amount: order.amount, currency: order.currency },
		path: `/projects/${project.uuid}/store/orders/${order.invoice}`,
		email: ({ brand, t, url }) => {
			const params = { reference: order.reference, customer: order.customer, amount: money(order.amount, order.currency, brand.language) };
			return {
				subject: t("email.notify.store_order_subject", params),
				heading: t("email.notify.store_order_heading"),
				paragraphs: [t("email.notify.store_order_intro", params)],
				button: { label: t("email.notify.open_order"), url },
			};
		},
	});
}

export async function notifyInvoicePaid(invoice: AnnouncedInvoice, amount: number) {
	await announce({
		kind: "invoice_paid",
		project: invoice.project,
		accounts: await accountsWith(invoice.project, Permission.INVOICE_VIEW),
		params: { reference: invoice.reference, amount, currency: invoice.currency },
		path: `/projects/${invoice.project}/invoices/${invoice.uuid}`,
		email: ({ brand, t, url }) => {
			const params = { reference: invoice.reference, amount: money(amount, invoice.currency, brand.language) };
			return {
				subject: t("email.notify.invoice_paid_subject", params),
				heading: t("email.notify.invoice_paid_heading"),
				paragraphs: [t("email.notify.invoice_paid_intro", params)],
				button: { label: t("email.notify.open_invoice"), url },
			};
		},
	});
}

interface OverdueInvoice {
	invoice: AnnouncedInvoice;
	outstanding: number;
}

export const OVERDUE_DIGEST_MS = 5000;
const OVERDUE_LISTED = 20;
const OVERDUE_NAMED = 3;

const overdue = new Map<string, OverdueInvoice[]>();
let overdueTimer: ReturnType<typeof setTimeout> | null = null;

export function queueOverdueNotice(invoice: AnnouncedInvoice, outstanding: number) {
	const waiting = overdue.get(invoice.project) ?? [];
	if (!waiting.some((entry) => entry.invoice.uuid === invoice.uuid)) waiting.push({ invoice, outstanding });
	overdue.set(invoice.project, waiting);
	if (overdueTimer !== null) return;
	overdueTimer = setTimeout(() => void flushOverdueNotices(), OVERDUE_DIGEST_MS);
	overdueTimer.unref?.();
}

async function announceOverdue(project: string, invoices: OverdueInvoice[]) {
	const [first] = invoices;
	const single = invoices.length === 1;
	const named = invoices.slice(0, OVERDUE_NAMED).map((entry) => entry.invoice.reference);
	const references = invoices.length > OVERDUE_NAMED ? `${named.join(", ")}, ...` : named.join(", ");
	await announce({
		kind: "invoice_overdue",
		variant: single ? undefined : "many",
		project,
		accounts: await accountsWith(project, Permission.INVOICE_VIEW),
		params: single
			? { reference: first.invoice.reference, amount: first.outstanding, currency: first.invoice.currency }
			: { count: invoices.length, references },
		path: single ? `/projects/${project}/invoices/${first.invoice.uuid}` : `/projects/${project}/invoices?status=overdue`,
		email: ({ brand, t, url }) => {
			const line = (entry: OverdueInvoice) => `${entry.invoice.reference}: ${money(entry.outstanding, entry.invoice.currency, brand.language)}`;
			if (single) {
				const params = { reference: first.invoice.reference, amount: money(first.outstanding, first.invoice.currency, brand.language) };
				return {
					subject: t("email.notify.invoice_overdue_subject", params),
					heading: t("email.notify.invoice_overdue_heading"),
					paragraphs: [t("email.notify.invoice_overdue_intro", params)],
					button: { label: t("email.notify.open_invoice"), url },
				};
			}
			const params = { count: invoices.length };
			const lines = invoices.slice(0, OVERDUE_LISTED).map(line);
			if (invoices.length > OVERDUE_LISTED) lines.push(t("email.notify.invoices_overdue_more", { count: invoices.length - OVERDUE_LISTED }));
			return {
				subject: t("email.notify.invoices_overdue_subject", params),
				heading: t("email.notify.invoices_overdue_heading"),
				paragraphs: [t("email.notify.invoices_overdue_intro", params)],
				note: { title: t("email.notify.invoices_overdue_list"), body: lines.join("\n") },
				button: { label: t("email.notify.open_invoices"), url },
			};
		},
	});
}

export async function flushOverdueNotices() {
	if (overdueTimer !== null) clearTimeout(overdueTimer);
	overdueTimer = null;
	const waiting = [...overdue];
	overdue.clear();
	for (const [project, invoices] of waiting) await announceOverdue(project, invoices);
}

export async function notifyFiscalAlert(projectId: string, documents: number) {
	await announce({
		kind: "fiscal_alert",
		project: projectId,
		accounts: await ownerAccounts(projectId),
		params: { count: documents },
		path: `/projects/${projectId}/settings#fiscal`,
	});
}
