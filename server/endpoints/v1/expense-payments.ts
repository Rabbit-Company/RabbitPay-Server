import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { companyFor, displayNameOf } from "../../company";
import { downloadResponse } from "../../invoice-pdf";
import { configFor } from "../../payments/methods";
import { isLocalDate, localDate } from "../../timezone";
import { payableExpenses, paymentProblems, supplierTransfersXml } from "../../expense-payments";

const base = "/api/v1/projects/:uuid/expense-payments";

Server.app.get(base, Auth.required(), Permissions.require(Permission.EXPENSE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const bank = await configFor(project.uuid, "bank_transfer");
	const expenses = await payableExpenses(project.uuid);
	return Utils.ok(ctx, {
		debtor_iban: bank.iban || null,
		today: localDate(Date.now(), project.timezone),
		expenses: expenses.map((expense) => ({
			...expense,
			due_date: expense.due_date === null ? null : localDate(expense.due_date, project.timezone),
			expense_date: localDate(expense.expense_date, project.timezone),
		})),
	});
});

Server.app.post(`${base}/file`, Auth.required(), Permissions.require(Permission.EXPENSE_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const data = await ctx.body<Record<string, unknown>>().catch(() => null);
	const ids = Array.isArray(data?.expenses) ? [...new Set(data.expenses.filter((value): value is string => Validate.uuid(value as string)))] : [];
	if (ids.length === 0 || ids.length > 500) return Utils.fail(ctx, ErrorCode.NO_PAYABLE_EXPENSES);
	const expenses = await payableExpenses(project.uuid, ids);
	if (expenses.length !== ids.length) return Utils.fail(ctx, ErrorCode.NO_PAYABLE_EXPENSES);
	const bank = await configFor(project.uuid, "bank_transfer");
	const company = await companyFor(project.uuid);
	const iban = (typeof data?.iban === "string" ? data.iban.trim() : "") || bank.iban || "";
	const debtor = iban ? { name: bank.account_holder || company.legal_name || displayNameOf(project), iban, bic: bank.bic || null } : null;
	const today = localDate(Date.now(), project.timezone);
	const executionDate = isLocalDate(data?.execution_date) && data.execution_date >= today ? data.execution_date : null;
	const problems = paymentProblems(expenses, debtor, executionDate);
	if (problems.length) return Utils.failWithReason(ctx, ErrorCode.SEPA_DATA_INCOMPLETE, "The payment file needs more data first.", { problems });
	const xml = supplierTransfersXml(expenses, debtor!, executionDate!, new Date());
	const now = Date.now();
	await Database`UPDATE expenses SET payment_ordered_at = ${now} WHERE project = ${project.uuid} AND uuid IN ${Database(ids)}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "expense.payment_file_exported",
		entityType: "expense",
		entityId: ids[0],
		newValue: {
			expenses: ids.length,
			total: expenses.reduce((sum, expense) => sum + expense.amount, 0),
			debtor_iban: debtor!.iban,
			execution_date: executionDate,
		},
	});
	return downloadResponse({ name: `placila-${executionDate}.xml`, data: new TextEncoder().encode(xml) }, "application/xml; charset=utf-8");
});
