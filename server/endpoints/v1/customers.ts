import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { Logger } from "../../logger";
import { companyFor } from "../../company";
import { isCustomerType, normalizeVatNumber, splitVatNumber } from "../../tax";
import { isPlausibleIban, normalizeIban } from "../../payments/bank";
import { checkVatNumber, isEnabled as viesEnabled, ViesUnavailable } from "../../vies";
import { customerStats, type CustomerInvoiceFacts } from "../../customer-stats";
import type { CustomerRow } from "../../database/models";

interface CustomerBody {
	name?: string | null;
	email?: string;
	phone?: string | null;
	address_line1?: string | null;
	address_line2?: string | null;
	city?: string | null;
	state?: string | null;
	postal_code?: string | null;
	country?: string | null;
	vat_number?: string | null;
	tax_number?: string | null;
	registration_number?: string | null;
	iban?: string | null;
	bic?: string | null;
	metadata?: Record<string, unknown> | null;
	customer_type?: string | null;
}

function cleanIban(value: string | null | undefined): string | null {
	const iban = normalizeIban(value ?? "");
	return iban === "" ? null : iban;
}

function cleanBic(value: string | null | undefined): string | null {
	const bic = (value ?? "").replace(/\s+/g, "").toUpperCase();
	return bic === "" ? null : bic;
}

function present(customer: CustomerRow) {
	return {
		...customer,
		metadata: customer.metadata === null ? null : JSON.parse(customer.metadata),
		vat_valid: customer.vat_valid === null ? null : Boolean(customer.vat_valid),
	};
}

function sameVatNumber(a: string | null, b: string | null): boolean {
	const normalize = (value: string | null) => (value ?? "").toUpperCase().replace(/[\s.\-/]/g, "");
	return normalize(a) === normalize(b);
}

function validateOptionalFields(data: CustomerBody): ErrorCode | null {
	const textFields: (keyof CustomerBody)[] = [
		"name",
		"phone",
		"address_line1",
		"address_line2",
		"city",
		"state",
		"postal_code",
		"vat_number",
		"tax_number",
		"registration_number",
		"iban",
		"bic",
	];
	for (const field of textFields) {
		if (!Validate.optionalText(data[field])) return ErrorCode.REQUIRED_DATA_MISSING;
	}
	const iban = cleanIban(data.iban);
	if (iban !== null && !isPlausibleIban(iban)) return ErrorCode.INVALID_CUSTOMER_BANK_ACCOUNT;
	const bic = cleanBic(data.bic);
	if (bic !== null && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic)) return ErrorCode.INVALID_CUSTOMER_BANK_ACCOUNT;
	if (data.country !== undefined && data.country !== null && !Validate.country(data.country)) return ErrorCode.INVALID_COUNTRY_CODE;
	if (data.customer_type !== undefined && data.customer_type !== null && !isCustomerType(data.customer_type)) return ErrorCode.INVALID_CUSTOMER_TYPE;
	return null;
}

async function findCustomer(projectId: string, customerId: string): Promise<CustomerRow | undefined> {
	const [customer] = (await Database`SELECT * FROM customers WHERE uuid = ${customerId} AND project = ${projectId}`) as CustomerRow[];
	return customer;
}

Server.app.get("/api/v1/projects/:uuid/customers", Auth.required(), Permissions.require(Permission.CUSTOMER_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();

	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const search = query.get("search");

	const searchPattern = `%${search}%`;
	const customers = search
		? ((await Database`
				SELECT * FROM customers
				WHERE project = ${project.uuid} AND (email LIKE ${searchPattern} OR name LIKE ${searchPattern} OR vat_number LIKE ${searchPattern} OR tax_number LIKE ${searchPattern})
				ORDER BY created DESC, uuid ASC LIMIT ${limit} OFFSET ${offset}
			`) as CustomerRow[])
		: ((await Database`
				SELECT * FROM customers WHERE project = ${project.uuid}
				ORDER BY created DESC, uuid ASC LIMIT ${limit} OFFSET ${offset}
			`) as CustomerRow[]);

	const searchFilter = search
		? Database`AND (email LIKE ${searchPattern} OR name LIKE ${searchPattern} OR vat_number LIKE ${searchPattern} OR tax_number LIKE ${searchPattern})`
		: Database``;
	const [total] = (await Database`SELECT COUNT(*) AS count FROM customers WHERE project = ${project.uuid} ${searchFilter}`) as { count: number }[];

	return Utils.ok(ctx, { customers: customers.map(present), total: total.count, limit, offset });
});

Server.app.post("/api/v1/projects/:uuid/customers", Auth.required(), Permissions.require(Permission.CUSTOMER_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);

	let data: CustomerBody;
	try {
		data = await ctx.body<CustomerBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.email(data.email)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);

	const invalid = validateOptionalFields(data);
	if (invalid !== null) return Utils.fail(ctx, invalid);

	const email = data.email!;

	const existing = (await Database`SELECT uuid FROM customers WHERE project = ${project.uuid} AND email = ${email}`) as CustomerRow[];
	if (existing.length > 0) return Utils.fail(ctx, ErrorCode.CUSTOMER_ALREADY_EXISTS);

	const uuid = crypto.randomUUID();
	const timestamp = Date.now();

	await Database`
		INSERT INTO customers(uuid, project, name, email, phone, address_line1, address_line2, city, state, postal_code, country, vat_number, tax_number,
			registration_number, iban, bic, metadata, customer_type, created, updated)
		VALUES(
			${uuid}, ${project.uuid}, ${data.name ?? null}, ${email}, ${data.phone ?? null}, ${data.address_line1 ?? null}, ${data.address_line2 ?? null},
			${data.city ?? null}, ${data.state ?? null}, ${data.postal_code ?? null}, ${data.country ?? null}, ${normalizeVatNumber(data.vat_number, data.country)},
			${data.tax_number?.trim() || null}, ${data.registration_number?.trim() || null}, ${cleanIban(data.iban)}, ${cleanBic(data.bic)},
			${data.metadata ? JSON.stringify(data.metadata) : null}, ${data.customer_type ?? null}, ${timestamp}, ${timestamp}
		)
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "customer.created",
		entityType: "customer",
		entityId: uuid,
		newValue: { email, name: data.name ?? null },
	});

	const created = await findCustomer(project.uuid, uuid);
	return Utils.ok(ctx, present(created!), 201);
});

Server.app.get("/api/v1/projects/:uuid/customers/:customer", Auth.required(), Permissions.require(Permission.CUSTOMER_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);

	const customerId = ctx.params["customer"];
	if (!Validate.uuid(customerId)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);

	const customer = await findCustomer(project.uuid, customerId);
	if (!customer) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);

	const invoices = (await Database`
		SELECT status, currency, total_amount, paid_amount, refunded_amount, credited_amount, due_date, paid_date, issued_at
		FROM invoices WHERE project = ${project.uuid} AND customer = ${customerId}
	`) as CustomerInvoiceFacts[];

	return Utils.ok(ctx, { ...present(customer), stats: customerStats(invoices, Date.now()) });
});

Server.app.patch("/api/v1/projects/:uuid/customers/:customer", Auth.required(), Permissions.require(Permission.CUSTOMER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const customerId = ctx.params["customer"];
	if (!Validate.uuid(customerId)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);

	const customer = await findCustomer(project.uuid, customerId);
	if (!customer) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);

	let data: CustomerBody;
	try {
		data = await ctx.body<CustomerBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (data.email !== undefined && !Validate.email(data.email)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);

	const invalid = validateOptionalFields(data);
	if (invalid !== null) return Utils.fail(ctx, invalid);

	const email = data.email ?? customer.email;

	if (email !== customer.email) {
		const clash = (await Database`SELECT uuid FROM customers WHERE project = ${project.uuid} AND email = ${email}`) as CustomerRow[];
		if (clash.length > 0) return Utils.fail(ctx, ErrorCode.CUSTOMER_ALREADY_EXISTS);
	}

	const merged = {
		name: data.name === undefined ? customer.name : data.name,
		email,
		phone: data.phone === undefined ? customer.phone : data.phone,
		address_line1: data.address_line1 === undefined ? customer.address_line1 : data.address_line1,
		address_line2: data.address_line2 === undefined ? customer.address_line2 : data.address_line2,
		city: data.city === undefined ? customer.city : data.city,
		state: data.state === undefined ? customer.state : data.state,
		postal_code: data.postal_code === undefined ? customer.postal_code : data.postal_code,
		country: data.country === undefined ? customer.country : data.country,
		vat_number: data.vat_number === undefined ? customer.vat_number : data.vat_number,
		tax_number: data.tax_number === undefined ? customer.tax_number : data.tax_number?.trim() || null,
		registration_number: data.registration_number === undefined ? customer.registration_number : data.registration_number?.trim() || null,
		iban: data.iban === undefined ? customer.iban : cleanIban(data.iban),
		bic: data.bic === undefined ? customer.bic : cleanBic(data.bic),
		metadata: data.metadata === undefined ? customer.metadata : data.metadata === null ? null : JSON.stringify(data.metadata),
		customer_type: data.customer_type === undefined ? customer.customer_type : data.customer_type,
	};

	if (data.vat_number !== undefined || data.country !== undefined) merged.vat_number = normalizeVatNumber(merged.vat_number, merged.country);

	const vatChanged =
		!sameVatNumber(normalizeVatNumber(customer.vat_number, customer.country), normalizeVatNumber(merged.vat_number, merged.country)) ||
		(customer.country ?? null) !== (merged.country ?? null);
	const check = vatChanged
		? { valid: null, at: null, name: null, address: null, reference: null }
		: {
				valid: customer.vat_valid,
				at: customer.vat_checked_at,
				name: customer.vat_checked_name,
				address: customer.vat_checked_address,
				reference: customer.vat_check_reference,
			};

	await Database`
		UPDATE customers SET
			name = ${merged.name}, email = ${merged.email}, phone = ${merged.phone},
			address_line1 = ${merged.address_line1}, address_line2 = ${merged.address_line2},
			city = ${merged.city}, state = ${merged.state}, postal_code = ${merged.postal_code},
			country = ${merged.country}, vat_number = ${merged.vat_number}, tax_number = ${merged.tax_number},
			registration_number = ${merged.registration_number}, iban = ${merged.iban}, bic = ${merged.bic}, metadata = ${merged.metadata},
				customer_type = ${merged.customer_type}, vat_valid = ${check.valid}, vat_checked_at = ${check.at},
				vat_checked_name = ${check.name}, vat_checked_address = ${check.address}, vat_check_reference = ${check.reference},
				updated = ${Date.now()}
		WHERE uuid = ${customerId}
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "customer.updated",
		entityType: "customer",
		entityId: customerId,
		oldValue: { email: customer.email, name: customer.name },
		newValue: { email: merged.email, name: merged.name },
	});

	const updated = await findCustomer(project.uuid, customerId);
	return Utils.ok(ctx, present(updated!));
});

Server.app.delete("/api/v1/projects/:uuid/customers/:customer", Auth.required(), Permissions.require(Permission.CUSTOMER_DELETE), async (ctx) => {
	const project = Permissions.project(ctx);

	const customerId = ctx.params["customer"];
	if (!Validate.uuid(customerId)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);

	const customer = await findCustomer(project.uuid, customerId);
	if (!customer) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);

	const [linked] = (await Database`SELECT COUNT(*) AS count FROM invoices WHERE customer = ${customerId}`) as { count: number }[];
	if (linked.count > 0) return Utils.fail(ctx, ErrorCode.CUSTOMER_HAS_INVOICES);

	const [recurring] = (await Database`SELECT COUNT(*) AS count FROM recurring_invoices WHERE customer = ${customerId}`) as { count: number }[];
	if (recurring.count > 0) return Utils.fail(ctx, ErrorCode.CUSTOMER_HAS_RECURRING);

	await Database`DELETE FROM customers WHERE uuid = ${customerId}`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "customer.deleted",
		entityType: "customer",
		entityId: customerId,
		oldValue: { email: customer.email, name: customer.name },
	});

	return Utils.ok(ctx);
});

Server.app.post("/api/v1/projects/:uuid/customers/:customer/vat-check", Auth.required(), Permissions.require(Permission.CUSTOMER_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	const customerId = ctx.params["customer"];
	if (!Validate.uuid(customerId)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);

	const customer = await findCustomer(project.uuid, customerId);
	if (!customer) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);

	const vat = splitVatNumber(customer.vat_number, customer.country);
	if (!vat) return Utils.fail(ctx, ErrorCode.VAT_CHECK_NOT_POSSIBLE);
	if (!viesEnabled()) return Utils.fail(ctx, ErrorCode.VAT_CHECK_UNAVAILABLE);

	const company = await companyFor(project.uuid);
	const requester = project.vat_status === "registered" ? splitVatNumber(company.vat_number, project.tax_country) : null;

	let result;
	try {
		result = await checkVatNumber(vat, requester);
	} catch (err) {
		Logger.warn(`[VIES] Could not check ${vat.prefix}${vat.number} for ${project.uuid}: ${err instanceof ViesUnavailable ? err.reason : err}`);
		return Utils.fail(ctx, ErrorCode.VAT_CHECK_UNAVAILABLE);
	}

	const customerType = result.valid && customer.customer_type === null ? "business" : customer.customer_type;
	const country = result.valid && customer.country === null ? vat.country : customer.country;

	await Database`
		UPDATE customers SET
			vat_valid = ${result.valid ? 1 : 0}, vat_checked_at = ${result.checkedAt}, vat_checked_name = ${result.name},
			vat_checked_address = ${result.address}, vat_check_reference = ${result.reference}, customer_type = ${customerType}, country = ${country},
			updated = ${Date.now()}
		WHERE uuid = ${customerId}
	`;

	await Audit.record(ctx, {
		project: project.uuid,
		action: "customer.vat_checked",
		entityType: "customer",
		entityId: customerId,
		newValue: { vat_number: `${vat.prefix}${vat.number}`, valid: result.valid, reference: result.reference },
	});

	return Utils.ok(ctx, present((await findCustomer(project.uuid, customerId))!));
});
