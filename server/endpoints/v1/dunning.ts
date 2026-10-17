import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { accountNames } from "../../accounts";
import { localDate } from "../../timezone";
import { outstandingOf } from "../../invoicing";
import { pdfResponse } from "../../invoice-pdf";
import { customerEmailRefusal, dunningEmails, findEmail, presentEmail, queueDunningEmail } from "../../email/messages";
import {
	compensationAvailable,
	interestAvailable,
	isDunningLevel,
	lastKnownRateEnd,
	nextLevel,
	possiblyTimeBarred,
	STATUTORY_RATES,
} from "../../dunning-rules";
import {
	debtors,
	findCustomer,
	findLetter,
	isBusinessCustomer,
	issueLetter,
	lastLetterFor,
	letterContext,
	letterDocument,
	letterLines,
	letterNumber,
	linesWithState,
	planLetter,
	presentLetter,
	renderLetter,
	storedDocument,
	todayFor,
	unpaidInvoices,
	unpaidRecordedInvoices,
	type DunningRequest,
} from "../../dunning";
import type { DunningLetterRow } from "../../database/models";

const MAX_LETTER_EMAILS = 20;

async function readBody<T>(ctx: { body<B>(): Promise<B> }): Promise<T | null> {
	try {
		return (await ctx.body<T>()) ?? null;
	} catch {
		return null;
	}
}

async function nextNumber(project: string, year: number): Promise<string> {
	const [last] = (await Database`SELECT MAX(sequence_number) AS last FROM dunning_letters WHERE project = ${project} AND year = ${year}`) as {
		last: number | null;
	}[];
	return letterNumber(year, Number(last?.last ?? 0) + 1);
}

async function emailCounts(letters: string[]): Promise<Map<string, number>> {
	if (letters.length === 0) return new Map();
	const rows = (await Database`
		SELECT dunning_letter, COUNT(*) AS count FROM email_messages WHERE dunning_letter IN ${Database(letters)} GROUP BY dunning_letter
	`) as { dunning_letter: string; count: number }[];
	return new Map(rows.map((row) => [row.dunning_letter, Number(row.count)]));
}

async function presentDetail(letter: DunningLetterRow) {
	const emails = await dunningEmails(letter.uuid);
	const names = await accountNames(
		[letter.created_by, ...emails.map((email) => email.sent_by)].filter((name): name is string => name !== null),
		letter.project
	);
	const document = storedDocument(letter);
	return {
		...presentLetter(letter, { emails: emails.length }),
		created_by_name: letter.created_by ? (names.get(letter.created_by) ?? null) : null,
		buyer: JSON.parse(letter.buyer_details),
		deadline_passed: false,
		rates: document.rates,
		lines: (await linesWithState(letter)).map((line) => ({
			uuid: line.uuid,
			invoice: line.invoice,
			recorded_invoice: line.recorded_invoice,
			reference: line.reference,
			issue_date: line.issue_date,
			due_on: line.due_on,
			amount: Number(line.amount),
			open: Number(line.open_amount),
			days: Number(line.days_overdue),
			interest: Number(line.interest),
			compensation: Number(line.compensation),
			open_now: line.open_now,
		})),
		email_history: emails.map((email) => ({ ...presentEmail(email), sent_by_name: email.sent_by ? (names.get(email.sent_by) ?? null) : null })),
	};
}

Server.app.get("/api/v1/projects/:uuid/dunning", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const customer = query.get("customer");
	if (customer && !Validate.uuid(customer)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);

	const letters = (
		customer
			? await Database`
				SELECT * FROM dunning_letters WHERE project = ${project.uuid} AND customer = ${customer}
				ORDER BY issue_date DESC, sequence_number DESC LIMIT ${limit} OFFSET ${offset}`
			: await Database`
				SELECT * FROM dunning_letters WHERE project = ${project.uuid}
				ORDER BY issue_date DESC, sequence_number DESC LIMIT ${limit} OFFSET ${offset}`
	) as DunningLetterRow[];
	const [counted] = (
		customer
			? await Database`SELECT COUNT(*) AS count FROM dunning_letters WHERE project = ${project.uuid} AND customer = ${customer}`
			: await Database`SELECT COUNT(*) AS count FROM dunning_letters WHERE project = ${project.uuid}`
	) as { count: number }[];
	const emails = await emailCounts(letters.map((letter) => letter.uuid));

	return Utils.ok(ctx, {
		letters: letters.map((letter) => presentLetter(letter, { emails: emails.get(letter.uuid) ?? 0 })),
		total: Number(counted?.count ?? 0),
		limit,
		offset,
	});
});

Server.app.get("/api/v1/projects/:uuid/dunning/debtors", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	return Utils.ok(ctx, { today: todayFor(project), debtors: await debtors(project) });
});

Server.app.get("/api/v1/projects/:uuid/dunning/candidates", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const customerId = ctx.query().get("customer");
	if (!customerId || !Validate.uuid(customerId)) return Utils.fail(ctx, ErrorCode.INVALID_CUSTOMER_ID);
	const customer = await findCustomer(project.uuid, customerId);
	if (!customer) return Utils.fail(ctx, ErrorCode.CUSTOMER_NOT_FOUND);

	const today = todayFor(project);
	const invoices = (await unpaidInvoices(project, customer.uuid)).map((invoice) => ({
		uuid: invoice.uuid,
		reference: invoice.reference,
		currency: invoice.currency,
		issue_date: localDate(invoice.issued_at!, project.timezone),
		due_on: localDate(invoice.due_date, project.timezone),
		amount: invoice.total_amount,
		open: outstandingOf(invoice),
	}));
	const recorded = (await unpaidRecordedInvoices(project, customer)).map((row) => ({
		uuid: row.uuid,
		reference: row.reference,
		currency: row.currency,
		issue_date: localDate(row.issued_at, project.timezone),
		due_on: localDate(row.due_date!, project.timezone),
		amount: row.total_amount,
		open: row.total_amount,
	}));
	const last = await lastLetterFor(project.uuid, customer.uuid);
	const manual = last
		? (await letterLines(last.uuid))
				.filter((line) => line.invoice === null && line.recorded_invoice === null)
				.map((line) => ({
					reference: line.reference,
					issue_date: line.issue_date,
					due_on: line.due_on,
					amount: Number(line.amount),
					open: Number(line.open_amount),
				}))
		: [];
	const lastLevel = last && isDunningLevel(last.level) ? last.level : null;
	const overdue = (line: { due_on: string }) => line.due_on < today;

	return Utils.ok(ctx, {
		today,
		customer: { uuid: customer.uuid, name: customer.name, email: customer.email, business: isBusinessCustomer(customer) },
		invoices: invoices.filter(overdue).map((line) => ({ ...line, time_barred: possiblyTimeBarred(line.due_on, today) })),
		not_due: invoices.filter((line) => !overdue(line)).length,
		recorded: recorded.filter(overdue).map((line) => ({ ...line, time_barred: possiblyTimeBarred(line.due_on, today) })),
		last_letter: last ? { uuid: last.uuid, number: last.number, level: Number(last.level), issue_date: last.issue_date } : null,
		previous_manual: manual,
		suggested_level: nextLevel(lastLevel),
		interest_available: interestAvailable(project.tax_country),
		compensation_available: compensationAvailable(project.tax_country),
		rates: STATUTORY_RATES.map((rate) => ({ from: rate.from, rate: rate.rate })),
		rates_known_until: lastKnownRateEnd(),
	});
});

Server.app.post("/api/v1/projects/:uuid/dunning/preview", Auth.required(), Permissions.require(Permission.INVOICE_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const data = await readBody<DunningRequest>(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_DUNNING_LETTER);
	const plan = await planLetter(project, data);
	if (typeof plan === "number") return Utils.fail(ctx, plan);

	const number = await nextNumber(project.uuid, Number(plan.issue_date.slice(0, 4)));
	const document = letterDocument(project, plan, number, await letterContext(project, account.username));
	return pdfResponse(await renderLetter(project, document));
});

Server.app.post("/api/v1/projects/:uuid/dunning", Auth.required(), Permissions.require(Permission.INVOICE_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const data = await readBody<DunningRequest>(ctx);
	if (!data) return Utils.fail(ctx, ErrorCode.INVALID_DUNNING_LETTER);
	const plan = await planLetter(project, data);
	if (typeof plan === "number") return Utils.fail(ctx, plan);

	const letter = await issueLetter(project, plan, account.username);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "dunning.issued",
		entityType: "dunning_letter",
		entityId: letter.uuid,
		newValue: { number: letter.number, level: Number(letter.level), customer: letter.customer, total_amount: Number(letter.total_amount) },
	});
	Logger.audit(`[DUNNING] ${account.username} issued dunning letter ${letter.number} on ${project.uuid}`);

	return Utils.ok(ctx, await presentDetail(letter), 201);
});

Server.app.get("/api/v1/projects/:uuid/dunning/:letter", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const letterId = ctx.params["letter"];
	if (!Validate.uuid(letterId)) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);
	const letter = await findLetter(project.uuid, letterId);
	if (!letter) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);

	return Utils.ok(ctx, { ...(await presentDetail(letter)), deadline_passed: letter.deadline_date < todayFor(project) });
});

Server.app.get("/api/v1/projects/:uuid/dunning/:letter/pdf", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const letterId = ctx.params["letter"];
	if (!Validate.uuid(letterId)) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);
	const letter = await findLetter(project.uuid, letterId);
	if (!letter) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);

	return pdfResponse(await renderLetter(project, storedDocument(letter)));
});

Server.app.post("/api/v1/projects/:uuid/dunning/:letter/email", Auth.required(), Permissions.require(Permission.INVOICE_SEND), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const refusal = await customerEmailRefusal(project);
	if (refusal !== null) return Utils.fail(ctx, refusal);

	const letterId = ctx.params["letter"];
	if (!Validate.uuid(letterId)) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);
	const letter = await findLetter(project.uuid, letterId);
	if (!letter) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);

	const data = (await readBody<{ to?: unknown; message?: unknown }>(ctx)) ?? {};
	if (data.message !== undefined && data.message !== null && (typeof data.message !== "string" || data.message.length > 2000)) {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	let recipient = typeof data.to === "string" ? data.to.trim() : "";
	if (!recipient && letter.customer) recipient = (await findCustomer(project.uuid, letter.customer))?.email ?? "";
	if (!recipient) return Utils.fail(ctx, ErrorCode.EMAIL_RECIPIENT_MISSING);
	if (!Validate.email(recipient)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);
	if ((await emailCounts([letter.uuid])).get(letter.uuid)! >= MAX_LETTER_EMAILS) return Utils.fail(ctx, ErrorCode.EMAIL_LIMIT_REACHED);

	const uuid = await queueDunningEmail(project, letter, {
		to: recipient,
		message: typeof data.message === "string" && data.message.trim() ? data.message.trim() : null,
		sentBy: account.username,
	});
	const email = await findEmail(uuid);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "dunning.emailed",
		entityType: "dunning_letter",
		entityId: letter.uuid,
		newValue: { number: letter.number, recipient },
	});
	Logger.audit(`[EMAIL] ${account.username} emailed dunning letter ${letter.number} to ${recipient}`);

	return Utils.ok(ctx, email, 201);
});

Server.app.delete("/api/v1/projects/:uuid/dunning/:letter", Auth.required(), Permissions.require(Permission.INVOICE_DELETE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const letterId = ctx.params["letter"];
	if (!Validate.uuid(letterId)) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);
	const letter = await findLetter(project.uuid, letterId);
	if (!letter) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);

	await Database`DELETE FROM dunning_letters WHERE uuid = ${letter.uuid}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "dunning.deleted",
		entityType: "dunning_letter",
		entityId: letter.uuid,
		oldValue: { number: letter.number, total_amount: Number(letter.total_amount) },
	});
	Logger.audit(`[DUNNING] ${account.username} deleted dunning letter ${letter.number} on ${project.uuid}`);

	return Utils.ok(ctx, null);
});
