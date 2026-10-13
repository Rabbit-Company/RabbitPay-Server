import { daysFromNow, projectApi, projectPath } from "../actions";
import type { DemoCustomer, Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";

interface Line {
	item: number;
	quantity: number;
}

const CONTENT = ".project-content";

function lines(session: Session, chosen: Line[]) {
	return chosen.map(({ item, quantity }) => {
		const entry = session.demo.items[item];
		return { description: entry.name, quantity, unit_price: entry.price, tax_rate: session.demo.vatRate, item: session.items![item], unit: entry.unit };
	});
}

async function createInvoice(
	studio: Studio,
	session: Session,
	customer: string,
	chosen: Line[],
	options: { status?: "draft" | "open"; due?: number; notes?: string } = {}
) {
	return await projectApi<{ uuid: string; reference: string; total_amount: number }>(studio, session, "POST", "/invoices", {
		customer,
		currency: "EUR",
		due_date: daysFromNow(options.due ?? 14),
		items: lines(session, chosen),
		discount_amount: 0,
		notes: options.notes ?? null,
		status: options.status ?? "open",
	});
}

async function pay(studio: Studio, session: Session, invoice: string, amount: number, reference: string) {
	await projectApi(studio, session, "POST", "/transactions", {
		invoice,
		processor: "bank_transfer",
		amount,
		fee_amount: 0,
		processor_tx_id: reference,
		status: "completed",
		notes: null,
		paid_at: Date.now(),
	});
}

async function customerDetails(studio: Studio, customer: DemoCustomer) {
	if (!customer.search) {
		return {
			name: customer.name,
			email: customer.email,
			customer_type: customer.type,
			address_line1: customer.address,
			postal_code: customer.postalCode,
			city: customer.city,
			country: customer.country,
		};
	}
	const { results } = await studio.browser.eval<{ results: any[] }>(
		`fetch("/api/v1/registry/companies?q=" + encodeURIComponent(${JSON.stringify(customer.search)}), { headers: { Authorization: "Bearer " + localStorage.getItem("rabbitpay.token") } }).then((response) => response.json()).then((payload) => payload.data)`
	);
	const wanted = customer.search.toUpperCase();
	const found = results.find((result) => String(result.name).toUpperCase().startsWith(wanted));
	if (!found) throw new Error(`The company register has no ${customer.search}`);
	return {
		name: found.name,
		email: customer.email,
		customer_type: customer.type,
		address_line1: found.address_line1,
		postal_code: found.postal_code,
		city: found.city,
		country: found.country,
		vat_number: found.vat_number,
		tax_number: found.tax_number,
		registration_number: found.registration_number,
	};
}

async function seed(studio: Studio, session: Session) {
	const { demo } = session;
	await studio.open(projectPath(session), 800);
	session.items = [];
	for (const item of demo.items) {
		const created = await projectApi<{ uuid: string }>(studio, session, "POST", "/items", {
			name: item.name,
			sku: item.sku,
			unit_price: item.price,
			currency: "EUR",
			tax_rate: demo.vatRate,
			supply_type: "services",
			tax_category: "standard",
			unit: item.unit,
		});
		session.items.push(created.uuid);
	}
	session.customers = [];
	session.customerNames = [];
	for (const customer of demo.customers) {
		const created = await projectApi<{ uuid: string; name: string }>(studio, session, "POST", "/customers", await customerDetails(studio, customer));
		session.customers.push(created.uuid);
		session.customerNames.push(created.name);
	}

	const paid = await createInvoice(studio, session, session.customers[0], [{ item: 2, quantity: 1 }]);
	await pay(studio, session, paid.uuid, paid.total_amount, "SEPA 4471");
	const partial = await createInvoice(studio, session, session.customers[1], [
		{ item: 0, quantity: 1 },
		{ item: 1, quantity: 6 },
	]);
	await pay(studio, session, partial.uuid, Math.round(partial.total_amount / 2), "SEPA 4502");
	session.partial = partial.uuid;
	await createInvoice(studio, session, session.customers[2], [{ item: 1, quantity: 12 }], { due: -3 });
}

async function items(studio: Studio, session: Session) {
	const { browser } = studio;
	const { newItem } = session.demo;
	const page = "items";

	await studio.open(projectPath(session, "/items"), 1200);
	await studio.shot(page, "open-items", { mark: `.project-nav >> link:${studio.t("nav.items")}` });
	await studio.shot(page, "items", { target: CONTENT, mark: `button:${studio.t("items.new")}` });

	await browser.click(`button:${studio.t("items.new")}`);
	const input = (key: Parameters<Studio["t"]>[0]) => `.dialog >> field:${studio.t(key)}`;
	await browser.fill(input("customers.name"), newItem.name);
	await browser.fill(input("items.sku"), newItem.sku);
	await browser.fill(input("items.unit_price"), (newItem.price / 100).toFixed(2));
	await browser.choose(input("editor.unit"), newItem.unit);
	await browser.blur();
	await studio.shot(page, "new-item", { target: ".dialog", padding: 32, mark: `button:${studio.t("items.add")}` });
	await browser.click(`button:${studio.t("items.add")}`, 1200);
	await studio.shot(page, "item-added", { target: CONTENT });
	await studio.shot(page, "row-actions", { target: `${CONTENT} table`, mark: `${CONTENT} tbody tr:first-child td.actions` });

	await studio.open(projectPath(session, "/invoices/new"), 1200);
	await browser.click(".item-row .combo-input");
	await browser.waitFor(".item-row .combo-option");
	await studio.shot(page, "pick-item", { target: `card:${studio.t("editor.line_items")}`, mark: ".item-row .combo-list" });
}

async function customers(studio: Studio, session: Session) {
	const { browser } = studio;
	const { individual } = session.demo;
	const page = "customers";

	await studio.open(projectPath(session, "/customers"), 1200);
	await studio.shot(page, "open-customers", { mark: `.project-nav >> link:${studio.t("nav.customers")}` });
	await studio.shot(page, "customers", { target: CONTENT, mark: `button:${studio.t("customers.new")}` });

	await browser.click(`button:${studio.t("customers.new")}`);
	const input = (key: Parameters<Studio["t"]>[0]) => `.dialog >> field:${studio.t(key)}`;
	await browser.fill(input("customers.name"), individual.name);
	await browser.click(".dialog h2");
	await browser.fill(input("customers.email"), individual.email);
	await browser.choose(input("customers.type"), "individual");
	await browser.fill(input("customers.address"), individual.address!);
	await browser.fill(input("customers.city"), individual.city!);
	await browser.fill(input("customers.postal_code"), individual.postalCode!);
	await browser.pick(input("customers.country"), individual.countryName);
	await browser.blur();
	await studio.shot(page, "new-customer", { target: ".dialog", padding: 32, mark: `button:${studio.t("customers.create")}` });
	await browser.click(`button:${studio.t("customers.create")}`, 1500);
	await studio.shot(page, "row-actions", { target: `${CONTENT} table`, mark: `${CONTENT} tbody tr:first-child td.actions` });

	await browser.fill(`${CONTENT} input[type=search], ${CONTENT} input[type=text]`, session.demo.customerSearch);
	await browser.wait(900);
	await studio.shot(page, "search", { target: CONTENT });

	await studio.open(projectPath(session, `/customers/${session.customers![1]}`), 1500);
	await studio.shot(page, "profile", { target: CONTENT });
	await studio.shot(page, "profile-actions", { target: `${CONTENT} .page-head, ${CONTENT} .line-actions`, padding: 12 });
}

async function chooseCustomer(studio: Studio, name: string) {
	const { browser } = studio;
	await browser.fill(".combo-customer .combo-input", name.slice(0, 6));
	await browser.waitFor(".combo-customer .combo-option");
}

async function addLine(studio: Studio, row: number, itemName: string) {
	const { browser } = studio;
	const line = `.items .item-line:nth-child(${row})`;
	await browser.fill(`${line} .combo-input`, itemName.slice(0, 8));
	await browser.waitFor(`${line} .combo-option`);
	await browser.click(`${line} .combo-option`);
}

async function invoiceId(studio: Studio): Promise<string> {
	await studio.browser.waitFor(`button:${studio.t("invoices.menu_documents")}`);
	return (await studio.browser.eval<string>(`location.pathname`)).split("/").pop()!;
}

async function createAndDraft(studio: Studio, session: Session) {
	const { browser } = studio;
	const { demo } = session;
	const page = "create-invoice";
	const details = `card:${studio.t("customer.details")}`;
	const lineItems = `card:${studio.t("editor.line_items")}`;

	await studio.open(projectPath(session, "/invoices"), 1200);
	await studio.shot(page, "invoices", { target: CONTENT, mark: `button:${studio.t("invoices.new")}` });
	await browser.click(`button:${studio.t("invoices.new")}`, 1200);
	await studio.shot(page, "empty-form", { target: CONTENT });

	await chooseCustomer(studio, session.customerNames![0]);
	await studio.shot(page, "choose-customer", { target: details, mark: ".combo-customer .combo-option" });
	await browser.click(".combo-customer .combo-option");

	await addLine(studio, 1, demo.items[0].name);
	await browser.click(`button:${studio.t("editor.add_line")}`);
	await addLine(studio, 2, demo.items[1].name);
	await browser.fill(".items .item-line:nth-child(2) .item-row > input:nth-child(2)", "4");
	await browser.click(`${lineItems} >> h2`);
	await studio.shot(page, "lines", { target: lineItems, mark: `button:${studio.t("editor.add_line")}` });

	await browser.fill(`${details} >> field:${studio.t("editor.discount")}`, "100");
	await browser.fill(`${details} >> textarea`, demo.notes);
	await browser.click(`${details} >> h2`);
	await studio.shot(page, "details", { target: details });
	await studio.shot(page, "totals", { target: ".totals", padding: 20 });

	await browser.click(`button:${studio.t("invoices.reference_document")}`);
	await browser.choose(`${details} >> field:${studio.t("invoices.reference_type")}`, studio.t("invoices.reference_order"));
	await browser.fill(`${details} >> field:${studio.t("invoices.reference_number")}`, demo.orderNumber);
	await browser.blur();
	await studio.shot(page, "reference-document", { target: details });

	await studio.shot(page, "buttons", { target: [`button:${studio.t("ui.cancel")}`, `button:${studio.t("invoices.create_and_issue")}`], padding: 14 });
	await studio.shot(page, "form", { target: CONTENT });
	await browser.click(`button:${studio.t("invoices.create_draft")}`, 2000);

	const drafts = "drafts";
	const draft = await invoiceId(studio);
	await studio.shot(drafts, "draft", { target: CONTENT, mark: `button:${studio.t("invoices.issue")}` });
	await browser.click(`button:${studio.t("invoices.menu_more")}`);
	await studio.shot(drafts, "draft-more", { mark: ".menu-panel-floating, .menu-panel" });
	await browser.click(`menu:${studio.t("ui.edit")}`, 1500);
	await browser.click(`card:${studio.t("editor.line_items")} >> h2`);
	await studio.shot(drafts, "edit-draft", { target: CONTENT });

	await studio.open(projectPath(session, `/invoices/${draft}`), 1200);
	await browser.click(`button:${studio.t("invoices.issue")}`, 2000);
	await studio.shot(drafts, "issued", { target: CONTENT });
	session.marks = { ...session.marks, created: draft };

	const [individual] = (await projectApi<{ customers: { uuid: string }[] }>(studio, session, "GET", "/customers?limit=1")).customers;
	await createInvoice(studio, session, individual.uuid, [{ item: 1, quantity: 3 }], { status: "draft" });
	await studio.open(projectPath(session, "/invoices"), 1200);
	await studio.shot(drafts, "list", { target: CONTENT });
	await browser.choose(`${CONTENT} select:nth-of-type(2), ${CONTENT} .toolbar select + select`, "draft");
	await browser.wait(900);
	await studio.shot(drafts, "filter-drafts", { target: CONTENT });
}

async function send(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "send";
	await studio.open(projectPath(session, `/invoices/${session.marks!.created}`), 1200);
	await browser.click(`button:${studio.t("invoices.menu_send")}`);
	await studio.shot(page, "send-menu", { mark: ".menu-panel-floating, .menu-panel" });
	await browser.click(`menu:${studio.t("invoices.email_invoice")}`, 800);
	await browser.fill(`.dialog >> field:${studio.t("invoices.email_message")}`, session.demo.notes);
	await browser.blur();
	await studio.shot(page, "email-invoice", { target: ".dialog", padding: 32, mark: `button:${studio.t("invoices.send_invoice")}` });
	await browser.click(`button:${studio.t("invoices.send_invoice")}`, 2500);
	await browser.wait(17000);
	await studio.open(projectPath(session, `/invoices/${session.marks!.created}`), 1500);
	await studio.shot(page, "emails-on-invoice", { target: `card:${studio.t("invoices.emails")}` });

	await browser.click(`button:${studio.t("invoices.menu_send")}`);
	await browser.click(`menu:${studio.t("invoices.send_reminder")}`, 800);
	await studio.shot(page, "reminder", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");

	await studio.open(projectPath(session, "/emails"), 1500);
	await studio.shot(page, "emails", { target: CONTENT });
	await studio.open(projectPath(session, "/settings"), 1500);
	const email = `card:${studio.t("settings.email")}`;
	const reminders = `${email} >> text:${studio.t("settings.reminders_switch")}`;
	if (!(await browser.eval<boolean>(`window.__helpShots.find(${JSON.stringify(reminders)}).closest("label").querySelector("input").checked`)))
		await browser.click(reminders, 600);
	await studio.shot(page, "email-settings", { target: email });
}

async function printAndDownload(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "print-and-download";
	const invoice = session.marks!.created;
	await studio.open(projectPath(session, `/invoices/${invoice}`), 1200);
	await browser.click(`button:${studio.t("invoices.menu_documents")}`);
	await studio.shot(page, "documents-menu", { mark: ".menu-panel-floating, .menu-panel" });
	await studio.open(projectPath(session, `/invoices/${invoice}/print`), 2000);
	await studio.shot(page, "printed-invoice", { full: true });

	await studio.open(projectPath(session, "/invoices"), 1200);
	await studio.shot(page, "download-button", { target: CONTENT, mark: `button:${studio.t("export.open")}` });
	await browser.click(`button:${studio.t("export.open")}`, 800);
	await browser.choose(`.dialog >> field:${studio.t("export.period")}`, studio.t("export.preset_this_month"));
	await browser.wait(900);
	await studio.shot(page, "download-by-date", { target: ".dialog", padding: 32 });
	await browser.click(`.dialog >> button:${studio.t("export.mode_numbers")}`, 600);
	for (const [index, digits] of [
		[1, "0002"],
		[2, "0005"],
	] as const) {
		await browser.fill(`.dialog .field:nth-of-type(${index}) .combo-input, .dialog .form-grid .field:nth-child(${index}) .combo-input`, digits);
		await browser.waitFor(".dialog .combo-option");
		await browser.click(".dialog .combo-option", 600);
	}
	await browser.wait(900);
	await studio.shot(page, "download-by-number", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");
}

async function recordPayment(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "record-payment";
	const invoice = session.marks!.created;
	await studio.open(projectPath(session, `/invoices/${invoice}`), 1200);
	await studio.shot(page, "record-button", { target: CONTENT, mark: `button:${studio.t("payments.record")}` });
	await browser.click(`button:${studio.t("payments.record")}`, 600);
	await browser.fill(`.dialog >> field:${studio.t("payments.reference")}`, "SEPA 4618");
	await browser.blur();
	await studio.shot(page, "record-dialog", { target: ".dialog", padding: 32, mark: `.dialog >> button[type=submit]` });
	await browser.click(`.dialog >> button[type=submit]`, 2000);
	await studio.shot(page, "paid", { target: CONTENT });

	await studio.open(projectPath(session, `/invoices/${session.partial}`), 1200);
	await studio.shot(page, "partially-paid", { target: CONTENT });
	await browser.click(`button:${studio.t("payments.refund")}`, 600);
	await browser.fill(`.dialog >> field:${studio.t("payments.reason")}`, session.demo.creditReason);
	await browser.blur();
	await studio.shot(page, "refund", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");
}

async function creditNotes(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "credit-notes";
	const credits = `card:${studio.t("credits.card_title")}`;

	await studio.open(projectPath(session, `/invoices/${session.partial}`), 1200);
	await studio.shot(page, "credit-notes-card", { target: credits, mark: `button:${studio.t("credits.issue")}` });
	await browser.click(`button:${studio.t("credits.issue")}`, 600);
	await studio.shot(page, "what-to-credit", { target: ".dialog", padding: 32 });
	await browser.choose(`.dialog >> field:${studio.t("credits.what")}`, studio.t("credits.mode_lines"));
	await browser.wait(400);
	await studio.shot(page, "chosen-lines", { target: ".dialog", padding: 32 });
	await browser.choose(`.dialog >> field:${studio.t("credits.what")}`, studio.t("credits.mode_amount"));
	await browser.fill(`.dialog >> field:${studio.t("credits.amount_label")}`, "184.50");
	await browser.fill(`.dialog >> field:${studio.t("payments.reason")}`, session.demo.creditReason);
	await browser.blur();
	await studio.shot(page, "amount", { target: ".dialog", padding: 32, mark: `.dialog >> button[type=submit]` });
	await browser.click(`.dialog >> button[type=submit]`, 2500);
	await studio.shot(page, "credit-note-issued", { target: credits });
	await studio.shot(page, "invoice-after-credit", { target: CONTENT });

	const mistake = await createInvoice(studio, session, session.customers![2], [{ item: 2, quantity: 1 }]);
	await studio.open(projectPath(session, `/invoices/${mistake.uuid}`), 1200);
	await browser.click(`button:${studio.t("invoices.menu_more")}`);
	await studio.shot(page, "more-menu", { mark: `menu:${studio.t("invoices.cancel_title")}` });
	await browser.click(`menu:${studio.t("invoices.cancel_title")}`, 600);
	await studio.shot(page, "cancel-confirm", { target: ".dialog", padding: 32 });
	await browser.click(`.dialog >> button:${studio.t("invoices.cancel_title")}`, 2500);
	await studio.shot(page, "canceled", { target: CONTENT });
}

async function proForma(studio: Studio, session: Session) {
	const { browser } = studio;
	const { demo } = session;
	const page = "pro-forma";

	await studio.open(projectPath(session, "/invoices/new"), 1200);
	await chooseCustomer(studio, session.customerNames![1]);
	await browser.click(".combo-customer .combo-option");
	await addLine(studio, 1, demo.items[0].name);
	await browser.click(`button:${studio.t("invoices.proforma_options")}`);
	await browser.blur();
	await studio.shot(page, "options", { target: `card:${studio.t("customer.details")}` });
	await studio.shot(page, "create-button", {
		target: [`button:${studio.t("ui.cancel")}`, `button:${studio.t("invoices.create_and_issue")}`],
		padding: 14,
		mark: `button:${studio.t("invoices.create_proforma")}`,
	});
	await browser.click(`button:${studio.t("invoices.create_proforma")}`, 2500);
	const proforma = await invoiceId(studio);
	await studio.shot(page, "pro-forma", { target: CONTENT });
	await browser.click(`button:${studio.t("invoices.menu_more")}`);
	await studio.shot(page, "more-menu", { mark: ".menu-panel-floating, .menu-panel" });
	await browser.click(`menu:${studio.t("invoices.change_settlement")}`, 600);
	await studio.shot(page, "what-happens-on-payment", { target: ".dialog", padding: 32 });
	await browser.click(".dialog .icon-button");
	await browser.click(`button:${studio.t("invoices.menu_send")}`);
	await studio.shot(page, "send-menu", { mark: ".menu-panel-floating, .menu-panel" });
	await browser.press("Escape", 27);

	const current = await projectApi<{ total_amount: number }>(studio, session, "GET", `/invoices/${proforma}`);
	await pay(studio, session, proforma, current.total_amount, "SEPA 4633");
	await studio.open(projectPath(session, `/invoices/${proforma}`), 1500);
	await studio.shot(page, "became-invoice", { target: CONTENT });

	const draft = await createInvoice(studio, session, session.customers![0], [{ item: 0, quantity: 1 }], { status: "draft" });
	await projectApi(studio, session, "POST", `/invoices/${draft.uuid}/proforma`, { settlement: "advance" });
	await pay(studio, session, draft.uuid, Math.round(draft.total_amount * 0.4), "SEPA 4650");
	await studio.open(projectPath(session, `/invoices/${draft.uuid}`), 1500);
	await studio.shot(page, "advance-invoices", { target: CONTENT });
	await browser.click(`button:${studio.t("invoices.menu_more")}`);
	await studio.shot(page, "issue-final", { mark: `menu:${studio.t("invoices.issue_final")}` });
	await browser.press("Escape", 27);

	await studio.open(projectPath(session, "/invoices"), 1200);
	await browser.choose(`${CONTENT} select`, studio.t("invoices.filter_proforma"));
	await browser.wait(900);
	await studio.shot(page, "filter", { target: CONTENT });
}

async function recurring(studio: Studio, session: Session) {
	const { browser } = studio;
	const { demo } = session;
	const page = "recurring";
	const schedule = `card:${studio.t("recurring.schedule")}`;

	await studio.open(projectPath(session, "/recurring"), 1200);
	await studio.shot(page, "open-recurring", { mark: `.project-nav >> link:${studio.t("nav.recurring")}` });
	await studio.shot(page, "empty", { target: CONTENT });
	await studio.open(projectPath(session, "/recurring/new"), 1200);
	await browser.fill(`${schedule} >> field:${studio.t("customers.name")}`, demo.recurringTitle);
	await browser.fill(`${schedule} >> .combo-input`, session.customerNames![2].slice(0, 6));
	await browser.waitFor(`${schedule} >> .combo-option`);
	await browser.click(`${schedule} >> .combo-option`);
	await browser.blur();
	await studio.shot(page, "schedule", { target: schedule });

	await browser.fill(".item-row .combo-input", demo.recurringLine);
	await browser.click(`card:${studio.t("editor.line_items")} >> h2`);
	await browser.fill(".item-row > input:nth-child(4)", (demo.newItem.price / 100).toFixed(2));
	await browser.blur();
	await studio.shot(page, "lines", { target: `card:${studio.t("editor.line_items")}` });
	await studio.shot(page, "form", { target: CONTENT, mark: `button:${studio.t("recurring.start")}` });
	await browser.click(`button:${studio.t("recurring.start")}`, 2500);
	await studio.shot(page, "started", { target: CONTENT });
	await studio.shot(page, "actions", { target: `button:${studio.t("recurring.run_now")}`, padding: 60, mark: `button:${studio.t("recurring.run_now")}` });
	await browser.click(`button:${studio.t("recurring.run_now")}`, 600);
	await studio.shot(page, "create-now", { target: ".dialog", padding: 32 });
	await browser.click(`.dialog >> button:${studio.t("recurring.run_now_confirm")}`, 3000);
	await studio.shot(page, "invoice-created", { target: CONTENT });
	await studio.open(projectPath(session, "/recurring"), 1200);
	await studio.shot(page, "list", { target: CONTENT });
}

async function numberingAndDesign(studio: Studio, session: Session) {
	const { browser } = studio;
	const numbers = `card:${studio.t("settings.document_numbers")}`;
	await studio.open(projectPath(session, "/settings"), 1500);
	await studio.shot("numbering", "document-numbers", { target: numbers });
	await browser.fill(`${numbers} >> input`, "INV-YYYY-XXXX");
	await browser.blur();
	await browser.wait(900);
	await studio.shot("numbering", "own-format", { target: [`${numbers} >> h3`, `${numbers} >> .form-actions`] });

	await studio.open(projectPath(session, "/settings"), 1500);
	await studio.shot("design", "invoice-design", { target: `card:${studio.t("design.title")}` });
	await studio.shot("design", "email-design", { target: `card:${studio.t("emails.title")}` });
}

export const invoices: Guide = {
	module: "invoices",
	steps: [
		["seed", seed],
		["items", items],
		["customers", customers],
		["create-invoice", createAndDraft],
		["send", send],
		["print-and-download", printAndDownload],
		["record-payment", recordPayment],
		["credit-notes", creditNotes],
		["pro-forma", proForma],
		["recurring", recurring],
		["numbering-and-design", numberingAndDesign],
	],
};
