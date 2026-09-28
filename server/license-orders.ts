import Database from "./database/database";
import { Logger } from "./logger";
import { isLicenseIssuer } from "./license-signing";
import { issueLicenses } from "./licensing";
import type { LicenseGrant } from "./license-pricing";
import type { CustomerRow, InvoiceItemRow, InvoiceRow, LicenseOrderRow } from "./database/models";

export interface OrderedLicense extends LicenseGrant {
	position: number;
	quantity: number;
	unit_price: number;
	server_id: string | null;
}

export async function licenseSalesOpen(projectId: string): Promise<boolean> {
	if (!isLicenseIssuer()) return false;
	const [owner] = (await Database`
		SELECT a.username FROM project_members m JOIN accounts a ON a.username = m.account_username
		WHERE m.project_id = ${projectId} AND m.role = 'owner' AND m.status = 'active' AND a.admin = 1 AND a.status = 'active'
		LIMIT 1
	`) as { username: string }[];
	return owner !== undefined;
}

export async function recordLicenseOrder(invoiceId: string, projectId: string, licenses: OrderedLicense[]) {
	if (licenses.length === 0) return;
	await Database`
		INSERT INTO license_orders(invoice, project, server_id, grants, minted_at, created)
		VALUES(${invoiceId}, ${projectId}, ${licenses.find((license) => license.server_id !== null)?.server_id ?? null}, ${JSON.stringify(licenses)},
			NULL, ${Date.now()})
	`;
}

export async function pendingLicenseOrders(limit: number): Promise<string[]> {
	const rows = (await Database`
		SELECT o.invoice AS invoice FROM license_orders o JOIN invoices i ON i.uuid = o.invoice
		WHERE o.minted_at IS NULL AND i.status = 'paid'
		ORDER BY o.created ASC LIMIT ${limit}
	`) as { invoice: string }[];
	return rows.map((row) => row.invoice);
}

export async function issueLicenseOrder(invoiceId: string): Promise<number> {
	const [order] = (await Database`SELECT * FROM license_orders WHERE invoice = ${invoiceId}`) as LicenseOrderRow[];
	if (!order || order.minted_at !== null) return 0;
	const [invoice] = (await Database`SELECT * FROM invoices WHERE uuid = ${invoiceId}`) as InvoiceRow[];
	if (!invoice || invoice.status !== "paid") return 0;

	if (!isLicenseIssuer()) {
		Logger.error(`[LICENSE] Order ${invoice.reference} is paid, but this server is not the license issuer, so its keys cannot be created`);
		return 0;
	}

	const [customer] = invoice.customer
		? ((await Database`SELECT name, email FROM customers WHERE uuid = ${invoice.customer}`) as Pick<CustomerRow, "name" | "email">[])
		: [];
	const lines = (await Database`SELECT uuid, item, sort_order FROM invoice_items WHERE invoice = ${invoiceId}`) as Pick<
		InvoiceItemRow,
		"uuid" | "item" | "sort_order"
	>[];
	const licenses = JSON.parse(order.grants) as OrderedLicense[];
	const timestamp = Date.now();

	const created = await Database.begin(async (tx) => {
		const claimed = await tx`UPDATE license_orders SET minted_at = ${timestamp} WHERE invoice = ${invoiceId} AND minted_at IS NULL`;
		if (claimed.count === 0) return 0;

		let count = 0;
		for (const license of licenses) {
			const line = lines.find((row) => Number(row.sort_order) === license.position);
			if (!line?.item) throw new Error(`Invoice ${invoice.reference} has no line ${license.position} for a license`);

			const keys = await issueLicenses(
				tx,
				{
					type: license.type,
					transactions: license.transactions,
					duration_days: license.duration_days,
					storage_gb: license.storage_gb,
					employees: license.employees,
					price: license.unit_price,
					currency: invoice.currency,
					buyer_name: customer?.name ?? null,
					buyer_email: customer?.email ?? null,
					note: `Store order ${invoice.reference}`,
				},
				license.quantity,
				null,
				license.server_id,
				timestamp
			);
			for (const [index, key] of keys.entries()) {
				await tx`
					INSERT INTO item_keys(uuid, project, item, secret, sequence, status, invoice, invoice_item, reserved_at, created, created_by)
					VALUES(${crypto.randomUUID()}, ${order.project}, ${line.item}, ${key.signed_key ?? key.code}, ${index}, 'reserved', ${invoiceId}, ${line.uuid},
						${timestamp}, ${timestamp}, NULL)
				`;
				count++;
			}
		}
		return count;
	});

	if (created > 0) Logger.info(`[LICENSE] Created ${created} license keys for order ${invoice.reference}`);
	return created;
}
