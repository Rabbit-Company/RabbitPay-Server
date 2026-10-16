import { Database } from "bun:sqlite";
import { daysFromNow, projectApi, projectPath } from "../actions";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";
import { storeProductNames } from "./store";

const PORTAL = {
	en: {
		ticket: {
			title: "Poster arrived with a bent corner",
			description: "The Harbour at Dawn print in my order arrived with the bottom left corner bent. Could you send a new one?",
		},
		reply: "Sorry about that. A new print is on its way today, no need to send the old one back.",
		answer: "Thank you, that is very kind.",
		newTicket: { title: "Framed version of the lighthouse print", description: "Do you also sell the Lighthouse at Night print framed, in A2?" },
		note: "Hand made framing, oak",
	},
	sl: {
		ticket: {
			title: "Plakat je prispel z zmečkanim vogalom",
			description: "Plakat Lipa ob zori iz mojega naročila je prispel z zmečkanim levim spodnjim vogalom. Ali mi lahko pošljete novega?",
		},
		reply: "Opravičujemo se. Nov plakat vam pošljemo še danes, starega ni treba vračati.",
		answer: "Hvala, zelo prijazno.",
		newTicket: { title: "Uokvirjen plakat Lipa ponoči", description: "Ali plakat Lipa ponoči prodajate tudi uokvirjen, v velikosti A2?" },
		note: "Ročno izdelan okvir, hrast",
	},
};

function local(studio: Studio) {
	return PORTAL[studio.language as "en" | "sl"];
}

async function invoiceFor(
	studio: Studio,
	session: Session,
	customer: string,
	lines: { item: number; quantity: number }[],
	options: { due: number; status: "open" | "draft" }
) {
	const names = storeProductNames(studio.language);
	const prices = [2000, 2000, 1500, 1200, 500, 900];
	return await projectApi<{ uuid: string; total_amount: number }>(studio, session, "POST", "/invoices", {
		customer,
		currency: "EUR",
		due_date: daysFromNow(options.due),
		items: lines.map(({ item, quantity }) => ({
			description: names[item],
			quantity,
			unit_price: prices[item],
			tax_rate: session.demo.vatRate,
			item: session.storeItems![item],
			unit: "C62",
		})),
		discount_amount: 0,
		notes: null,
		status: options.status,
	});
}

async function prepare(studio: Studio, session: Session) {
	await studio.open(projectPath(session), 800);
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	database.query("UPDATE projects SET workforce_until = ? WHERE uuid = ?").run(Date.now() + 365 * 86400000, session.project);
	database.close();

	const { individual } = session.demo;
	const { customers } = await projectApi<{ customers: { uuid: string; email: string | null }[] }>(
		studio,
		session,
		"GET",
		`/customers?search=${encodeURIComponent(individual.email)}`
	);
	const customer = customers.find((entry) => entry.email === individual.email)!.uuid;
	session.marks = { ...session.marks, portalCustomer: customer };

	const paid = await invoiceFor(studio, session, customer, [{ item: 1, quantity: 1 }], { due: -10, status: "open" });
	await projectApi(studio, session, "POST", "/transactions", {
		invoice: paid.uuid,
		processor: "bank_transfer",
		amount: paid.total_amount,
		fee_amount: 0,
		processor_tx_id: "SEPA 8120",
		status: "completed",
		notes: null,
		paid_at: Date.now(),
	});
	await invoiceFor(studio, session, customer, [{ item: 5, quantity: 2 }], { due: -4, status: "open" });
	await invoiceFor(
		studio,
		session,
		customer,
		[
			{ item: 2, quantity: 2 },
			{ item: 3, quantity: 1 },
		],
		{ due: 12, status: "open" }
	);
	const draft = await invoiceFor(studio, session, customer, [{ item: 0, quantity: 4 }], { due: 7, status: "draft" });
	await projectApi(studio, session, "POST", `/invoices/${draft.uuid}/proforma`, {});

	await projectApi(studio, session, "PUT", `/customers/${customer}/ticket-access`, { enabled: true, kinds: ["support", "feature"] });
	const text = local(studio);
	const ticket = await projectApi<{ uuid: string }>(studio, session, "POST", "/tickets", {
		title: text.ticket.title,
		description: text.ticket.description,
		kind: "support",
		customer,
		customer_visible: true,
	});
	await projectApi(studio, session, "POST", `/tickets/${ticket.uuid}/comments`, { body: text.reply });
}

async function signIn(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "sign-in";
	const { individual } = session.demo;
	await browser.eval(`localStorage.removeItem("rabbitpay.customer.token")`);
	await studio.open("/customer/login", 1500);
	await browser.fill(".auth-card input[type=email]", individual.email);
	await browser.blur();
	await studio.shot(page, "request", { mark: ".auth-card >> button[type=submit]" });
	studio.mailbox.length = 0;
	await browser.click(".auth-card >> button[type=submit]", 2000);
	await studio.shot(page, "sent");
	for (let attempt = 0; attempt < 40 && !studio.mailbox.some((message) => message.includes("/customer/login#token=")); attempt++) await Bun.sleep(500);
	await browser.goto(`${studio.base}${studio.linkFromEmail("/customer/login")}`, 2000);
	await studio.shot(page, "confirm", { mark: ".auth-card >> button[type=submit]" });
	await browser.click(".auth-card >> button[type=submit]", 2500);
}

async function invoices(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "invoices";
	await studio.open("/customer", 2000);
	await studio.shot(page, "list", { full: true });
	await browser.choose("main select, .portal select", "unpaid");
	await browser.wait(1200);
	await studio.shot(page, "unpaid", { full: true });
	const open = await browser.eval<string>(`[...document.querySelectorAll("a[href^='/customer/invoices/']")].map((link) => link.getAttribute("href"))[0]`);
	await studio.open(open, 2000);
	await studio.shot(page, "invoice", { full: true });
}

async function orders(studio: Studio, session: Session) {
	await studio.open("/customer/orders", 2000);
	await studio.shot("orders-and-profile", "orders", { full: true });
	await studio.open("/customer/profile", 2000);
	await studio.shot("orders-and-profile", "profile", { full: true });
}

async function tickets(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "tickets";
	const text = local(studio);
	await studio.open("/customer/tickets", 2000);
	await studio.shot(page, "list", { full: true });
	const ticket = await browser.eval<string>(`[...document.querySelectorAll("a[href^='/customer/tickets/']")].map((link) => link.getAttribute("href"))[0]`);
	await studio.open(ticket, 2000);
	await browser.fill("textarea", text.answer);
	await browser.blur();
	await studio.shot(page, "ticket", { full: true });
	await browser.click(`button:${studio.t("portal_tickets.reply")}`, 1500);
	await studio.open("/customer/tickets", 2000);
	await browser.click(`button:${studio.t("portal_tickets.new")}`, 800);
	await browser.fill(`field:${studio.t("portal_tickets.title_label")}`, text.newTicket.title);
	await browser.fill(`field:${studio.t("portal_tickets.description")}`, text.newTicket.description);
	await browser.blur();
	await studio.shot(page, "new", { full: true });
}

async function business(studio: Studio, session: Session) {
	const { browser } = studio;
	await studio.open(projectPath(session, `/customers/${session.marks!.portalCustomer}`), 2000);
	if (await browser.exists(`card:${studio.t("ticket.portal_title")}`)) {
		await studio.shot("tickets", "access", { target: `card:${studio.t("ticket.portal_title")}` });
	}
}

export const customerPortal: Guide = {
	module: "customer-portal",
	steps: [
		["prepare", prepare],
		["sign-in", signIn],
		["invoices", invoices],
		["orders", orders],
		["tickets", tickets],
		["business", business],
	],
};
