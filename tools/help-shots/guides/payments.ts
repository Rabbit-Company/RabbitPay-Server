import { Database } from "bun:sqlite";
import { daysFromNow, projectApi, projectPath } from "../actions";
import type { Session } from "../demo";
import type { Guide } from "../run";
import type { Studio } from "../studio";

const CONTENT = ".project-content";
const WALLET = {
	bitcoin: "zpub6r8fVrJA5NAdUdA2QnuU8QdHoxMEQWDoWboBhWLGKGa7i5odP3sD6VhdNXsNedAULLibzZp4u8utoEmX75iE4qUMs83GiBn2ifgFD671TC5",
	ethereum: "xpub6CQzLyrbnUEisSnJ9eFCqahLNjxHyzxoxZtbD5apxgapJpZ5L1NjjxwiBQNhzx9oZYVxiKuywpnaeb8hkhd466R5vjCUZyWh1ocnEBXnkGH",
};
const STRIPE = { secret: "sk_live_51QhT2mKx8Yd0RabbitPayDemoKey4f7Jw2Zp9LcVn", webhook: "whsec_8dK2mPq7Rt5Vx1Zb4Nc6Hj9Lw3Ys0Ae" };
const PAYPAL = { client: "AZk3Rt8Lm2Qp7Vx1Nc5Hj9Ws4Yd6Bf0Ge", secret: "EJw7Pq2Zt9Lk4Mx6Vb1Nc8Hs3Rd5Yf0G", webhook: "8PT597110X687430L" };

type Key = Parameters<Studio["t"]>[0];

function processor(studio: Studio, name: string): string {
	return `processor:${studio.t(`processor.${name}` as Key)}`;
}

function field(studio: Studio, name: string, key: string): string {
	return `${processor(studio, name)} >> field:${studio.t(`field.${name}.${key}` as Key)}`;
}

async function save(studio: Studio, name: string) {
	await studio.browser.click(`${processor(studio, name)} >> button[type=submit]`, 1500);
}

async function switchOn(studio: Studio, name: string) {
	const { browser } = studio;
	const target = processor(studio, name);
	const on = await browser.eval<boolean>(`window.__helpShots.find(${JSON.stringify(target)}).querySelector(".switch input").checked`);
	if (!on) await browser.click(`${target} >> .switch`, 1500);
}

function allowCardsAndCrypto(studio: Studio, session: Session) {
	if (session.demo.company.country !== "SI") return;
	const database = new Database(studio.database);
	database.run("PRAGMA busy_timeout = 10000");
	const now = Date.now();
	database
		.query(
			`INSERT OR REPLACE INTO fiscal_settings(project, environment, certificate, certificate_holder, certificate_tax_number, certificate_serial,
				certificate_valid_to, enabled, online_premise, online_device, pos_premise, pos_device, operator_tax_number, created, updated)
			VALUES(?, 'production', 'help-shots', ?, ?, '2B7E151628AED2A6', ?, 1, 'PP1', 'SPLET1', 'PP1', 'BLAG1', ?, ?, ?)`
		)
		.run(
			session.project,
			session.demo.company.legalName,
			Number(session.demo.company.taxNumber),
			now + 4 * 365 * 86400000,
			Number(session.demo.company.taxNumber),
			now,
			now
		);
	database
		.query(
			`INSERT OR REPLACE INTO fiscal_premises(uuid, project, environment, premise_id, kind, premise_type, street, house_number, community, city, postal_code,
				validity_date, registered_at, created, updated)
			VALUES(?, ?, 'production', 'PP1', 'movable', 'C', 'Pod lipo', '14', 'Ljubljana', 'Ljubljana', '1000', ?, ?, ?, ?)`
		)
		.run(crypto.randomUUID(), session.project, new Date().toISOString().slice(0, 10), now, now, now);
	database.close();
}

async function methods(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "payment-methods";
	allowCardsAndCrypto(studio, session);

	await studio.open(projectPath(session), 1200);
	await studio.shot(page, "overview-card", { target: `card:${studio.t("overview.methods_title")}` });
	await studio.open(projectPath(session, "/settings"), 1500);
	const card = `card:${studio.t("overview.methods_title")}`;
	await studio.shot(page, "open-settings", { mark: `.project-nav >> link:${studio.t("nav.settings")}` });
	await studio.shot(page, "card", { target: card });
	await studio.shot(page, "needs-setup", { target: `${processor(studio, "paypal")} >> .processor-head` });
	await studio.shot(page, "ready", {
		target: `${processor(studio, "bank_transfer")} >> .processor-head`,
		mark: `${processor(studio, "bank_transfer")} >> .switch`,
	});
	void browser;
}

async function bankTransfer(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "bank-transfer";
	await studio.open(projectPath(session, "/settings"), 1500);
	await studio.shot(page, "details", { target: processor(studio, "bank_transfer") });
	await studio.shot(page, "payment-code", { target: field(studio, "bank_transfer", "qr_format").replace("field:", "fieldbox:") });

	const open = await openInvoice(studio, session);
	await studio.open(`/pay/${open}`, 1500);
	await studio.shot(page, "choose", { target: ".pay", mark: `.methods >> button:${studio.t("processor.bank_transfer")}` });
	await browser.click(`.methods >> button:${studio.t("processor.bank_transfer")}`, 1500);
	await studio.shot(page, "pay-by-transfer", { target: ".pay" });
	await studio.open(projectPath(session, `/invoices/${open}/print`), 2000);
	await studio.shot(page, "on-the-invoice", { full: true });
}

async function openInvoice(studio: Studio, session: Session): Promise<string> {
	if (session.marks?.payable) return session.marks.payable;
	const invoice = await projectApi<{ uuid: string }>(studio, session, "POST", "/invoices", {
		customer: session.customers![0],
		currency: "EUR",
		due_date: daysFromNow(14),
		items: [
			{
				description: session.demo.items[2].name,
				quantity: 1,
				unit_price: session.demo.items[2].price,
				tax_rate: session.demo.vatRate,
				item: session.items![2],
				unit: session.demo.items[2].unit,
			},
		],
		discount_amount: 0,
		notes: null,
		status: "open",
	});
	session.marks = { ...session.marks, payable: invoice.uuid };
	return invoice.uuid;
}

async function cards(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "cards";
	await studio.open(projectPath(session, "/settings"), 1500);
	await studio.shot(page, "stripe-empty", { target: processor(studio, "stripe") });
	await browser.fill(field(studio, "stripe", "secret_key"), STRIPE.secret);
	await browser.fill(field(studio, "stripe", "webhook_secret"), STRIPE.webhook);
	await browser.blur();
	await studio.shot(page, "stripe-keys", { target: processor(studio, "stripe"), mark: `${processor(studio, "stripe")} >> button[type=submit]` });
	await save(studio, "stripe");
	await switchOn(studio, "stripe");
	await studio.shot(page, "stripe-on", { target: processor(studio, "stripe"), mark: `${processor(studio, "stripe")} >> .switch` });
	await studio.open(`/pay/${await openInvoice(studio, session)}`, 1500);
	await studio.shot(page, "pay-by-card", { target: ".pay", mark: `.methods >> button:${studio.t("processor.stripe")}` });
}

async function paypal(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "paypal";
	await studio.open(projectPath(session, "/settings"), 1500);
	await browser.fill(field(studio, "paypal", "client_id"), PAYPAL.client);
	await browser.fill(field(studio, "paypal", "client_secret"), PAYPAL.secret);
	await browser.fill(field(studio, "paypal", "webhook_id"), PAYPAL.webhook);
	await browser.blur();
	await studio.shot(page, "paypal-keys", { target: processor(studio, "paypal"), mark: `${processor(studio, "paypal")} >> button[type=submit]` });
	await save(studio, "paypal");
	await switchOn(studio, "paypal");
	await studio.shot(page, "paypal-on", { target: processor(studio, "paypal"), mark: `${processor(studio, "paypal")} >> .switch` });
	await studio.open(`/pay/${await openInvoice(studio, session)}`, 1500);
	await studio.shot(page, "pay-with-paypal", { target: ".pay", mark: `.methods >> button:${studio.t("processor.paypal")}` });
}

async function cryptocurrencies(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "crypto";
	await studio.open(projectPath(session, "/settings"), 1500);
	await studio.shot(page, "bitcoin-empty", { target: processor(studio, "bitcoin") });
	await browser.fill(field(studio, "bitcoin", "xpub"), WALLET.bitcoin);
	await browser.blur();
	await studio.shot(page, "bitcoin-key", { target: processor(studio, "bitcoin"), mark: `${processor(studio, "bitcoin")} >> button[type=submit]` });
	await save(studio, "bitcoin");
	await switchOn(studio, "bitcoin");
	await studio.shot(page, "bitcoin-on", { target: processor(studio, "bitcoin") });

	await browser.fill(field(studio, "ethereum", "xpub"), WALLET.ethereum);
	await browser.blur();
	await save(studio, "ethereum");
	await switchOn(studio, "ethereum");
	await studio.shot(page, "ethereum-on", { target: processor(studio, "ethereum") });

	await browser.fill(field(studio, "monero", "wallet_rpc_url"), "https://wallet.example.com/json_rpc");
	await browser.fill(field(studio, "monero", "rpc_username"), "rabbitpay");
	await browser.fill(field(studio, "monero", "account_index"), "0");
	await browser.blur();
	await studio.shot(page, "monero", { target: processor(studio, "monero") });

	await studio.open(`/pay/${await openInvoice(studio, session)}`, 1500);
	await studio.shot(page, "choose-coin", { target: ".pay", mark: `.methods >> button:${studio.t("processor.bitcoin")}` });
	await browser.click(`.methods >> button:${studio.t("processor.bitcoin")}`, 4000);
	await studio.shot(page, "pay-with-bitcoin", { target: ".pay" });
}

async function paymentPage(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "payment-page";
	const open = await openInvoice(studio, session);
	await studio.open(projectPath(session, `/invoices/${open}`), 1200);
	await browser.click(`button:${studio.t("invoices.menu_send")}`);
	await studio.shot(page, "copy-link", { mark: `menu:${studio.t("invoices.copy_pay_link")}` });
	await studio.open(`/pay/${open}`, 1500);
	await studio.shot(page, "page", { target: ".pay" });
	await studio.shot(page, "summary", { target: ".pay-summary" });
	await studio.shot(page, "methods", { target: ".methods", padding: 28 });
	await browser.viewport(390, 800);
	await studio.open(`/pay/${open}`, 1500);
	await studio.shot(page, "phone", { target: ".pay" });
	await browser.viewport(1280, 800);

	await studio.open(`/pay/${session.marks!.created}`, 1500);
	await studio.shot(page, "paid", { target: ".pay" });
}

async function followPayments(studio: Studio, session: Session) {
	const { browser } = studio;
	const page = "follow-payments";
	const { transactions } = await projectApi<{ transactions: { uuid: string; amount: number; type: string }[] }>(
		studio,
		session,
		"GET",
		"/transactions?limit=50"
	);
	const smallest = transactions.filter((entry) => entry.type === "payment").sort((left, right) => left.amount - right.amount)[0];
	await projectApi(studio, session, "POST", `/transactions/${smallest.uuid}/refund`, { amount: 6150, reason: session.demo.creditReason, credit_note: true });
	await studio.open(projectPath(session, "/transactions"), 1500);
	await studio.shot(page, "open-payments", { mark: `.project-nav >> link:${studio.t("nav.payments")}` });
	await studio.shot(page, "payments", { target: CONTENT });
	await browser.choose(`${CONTENT} select`, studio.t("payments.type_refunds"));
	await browser.wait(900);
	await studio.shot(page, "refunds", { target: CONTENT });
	await studio.open(projectPath(session), 1200);
	await studio.shot(page, "overview", { target: CONTENT });
}

export const payments: Guide = {
	module: "payments",
	steps: [
		["payment-methods", methods],
		["bank-transfer", bankTransfer],
		["cards", cards],
		["paypal", paypal],
		["crypto", cryptocurrencies],
		["payment-page", paymentPage],
		["follow-payments", followPayments],
	],
};
