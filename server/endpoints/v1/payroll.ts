import type { Context } from "@rabbit-company/web";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { okWithNames } from "../../accounts";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { downloadResponse, pdfResponse } from "../../invoice-pdf";
import { isIsoDate, isMonth } from "../../workforce/calendar";
import { requireWorkforce } from "../../workforce/access";
import { readPayrollRates, SLOVENIA_PRESETS } from "../../workforce/net-pay";
import {
	calculateLine,
	payrollCsv,
	presentLine,
	ratesFor,
	readPayrollItems,
	runTotals,
	storeRunCalculation,
	yearToDateFor,
	type PayrollCalculation,
} from "../../workforce/payroll-runs";
import { payslipsPdf } from "../../workforce/payslip-pdf";
import { isCollectiveAgreementCode, isRekKind, rekOXml, rekProblems } from "../../workforce/reko";
import { salaryTransfersXml, sepaProblems } from "../../workforce/sepa";
import { companyFor, displayNameOf } from "../../company";
import { configFor } from "../../payments/methods";
import type { AppState, PayrollLineRow, PayrollRatesRow, PayrollRunRow } from "../../database/models";

const base = "/api/v1/projects/:uuid/payroll";

async function body(ctx: Context<AppState>): Promise<Record<string, unknown> | null> {
	try {
		const value = await ctx.body<Record<string, unknown>>();
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

async function audit(ctx: Context<AppState>, action: string, entityType: string, entityId: string, value?: unknown, previous?: unknown) {
	await Audit.record(ctx, { project: Permissions.project(ctx).uuid, action, entityType, entityId, newValue: value, oldValue: previous });
}

function presentRates(row: PayrollRatesRow) {
	return {
		period: row.period,
		rates: JSON.parse(row.config),
		verified: row.verified_at !== null,
		verified_by: row.verified_by,
		verified_at: row.verified_at,
		updated: row.updated,
	};
}

async function findRun(ctx: Context<AppState>): Promise<PayrollRunRow | null> {
	if (!Validate.uuid(ctx.params.run)) return null;
	const [run] = (await Database`SELECT * FROM payroll_runs WHERE uuid = ${ctx.params.run} AND project = ${Permissions.project(ctx).uuid}`) as PayrollRunRow[];
	return run ?? null;
}

async function runLines(run: PayrollRunRow) {
	const rows = (await Database`SELECT * FROM payroll_lines WHERE run = ${run.uuid} ORDER BY person ASC`) as PayrollLineRow[];
	return rows.map(presentLine);
}

async function runState(run: PayrollRunRow) {
	const [fresh] = (await Database`SELECT * FROM payroll_runs WHERE uuid = ${run.uuid}`) as PayrollRunRow[];
	const lines = await runLines(fresh);
	const rates = await ratesFor(fresh.project, fresh.period);
	return {
		...fresh,
		rates: rates ? { period: rates.period, verified: rates.verified } : null,
		lines,
		totals: runTotals(lines.map((line) => line.calculation)),
	};
}

Server.app.get(`${base}/rates`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const rows = (await Database`SELECT * FROM payroll_rates WHERE project = ${Permissions.project(ctx).uuid} ORDER BY period DESC`) as PayrollRatesRow[];
	return await okWithNames(ctx, { tables: rows.map(presentRates), presets: SLOVENIA_PRESETS });
});

Server.app.put(`${base}/rates/:period`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const period = ctx.params.period;
	const data = await body(ctx);
	const rates = readPayrollRates(data?.rates);
	if (!isMonth(period) || !rates || typeof data?.verified !== "boolean") return Utils.fail(ctx, ErrorCode.INVALID_PAYROLL_RATES);
	const account = Auth.account(ctx);
	const now = Date.now();
	const [previous] = (await Database`SELECT * FROM payroll_rates WHERE project = ${project.uuid} AND period = ${period}`) as PayrollRatesRow[];
	const verifiedBy = data.verified ? account.username : null;
	const verifiedAt = data.verified ? now : null;
	if (previous) {
		await Database`
			UPDATE payroll_rates SET config = ${JSON.stringify(rates)}, verified_by = ${verifiedBy}, verified_at = ${verifiedAt}, updated = ${now}
			WHERE uuid = ${previous.uuid}
		`;
	} else {
		await Database`
			INSERT INTO payroll_rates(uuid, project, period, config, verified_by, verified_at, created, updated)
			VALUES(${crypto.randomUUID()}, ${project.uuid}, ${period}, ${JSON.stringify(rates)}, ${verifiedBy}, ${verifiedAt}, ${now}, ${now})
		`;
	}
	const [row] = (await Database`SELECT * FROM payroll_rates WHERE project = ${project.uuid} AND period = ${period}`) as PayrollRatesRow[];
	await audit(ctx, "payroll_rates.saved", "payroll_rates", row.uuid, { period, rates, verified: data.verified }, previous ? presentRates(previous) : undefined);
	return await okWithNames(ctx, presentRates(row));
});

Server.app.delete(`${base}/rates/:period`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const [row] = (await Database`SELECT * FROM payroll_rates WHERE project = ${project.uuid} AND period = ${ctx.params.period}`) as PayrollRatesRow[];
	if (!row) return Utils.fail(ctx, ErrorCode.PAYROLL_RATES_NOT_FOUND);
	await Database`DELETE FROM payroll_rates WHERE uuid = ${row.uuid}`;
	await audit(ctx, "payroll_rates.deleted", "payroll_rates", row.uuid, undefined, presentRates(row));
	return Utils.ok(ctx);
});

Server.app.get(`${base}/runs`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const runs = (await Database`SELECT * FROM payroll_runs WHERE project = ${project.uuid} ORDER BY period DESC`) as PayrollRunRow[];
	const result = [];
	for (const run of runs) {
		const lines = await runLines(run);
		result.push({ ...run, people: lines.length, totals: runTotals(lines.map((line) => line.calculation)) });
	}
	return await okWithNames(ctx, result);
});

Server.app.post(`${base}/runs`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const data = await body(ctx);
	const period = data?.period;
	const payDate = data?.pay_date ?? null;
	if (!isMonth(period) || (payDate !== null && !isIsoDate(payDate))) return Utils.fail(ctx, ErrorCode.INVALID_PAYROLL_RUN);
	const [existing] = await Database`SELECT uuid FROM payroll_runs WHERE project = ${project.uuid} AND period = ${period}`;
	if (existing) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_EXISTS);
	const uuid = crypto.randomUUID();
	const now = Date.now();
	await Database`
		INSERT INTO payroll_runs(uuid, project, period, status, pay_date, created_by, created, updated)
		VALUES(${uuid}, ${project.uuid}, ${period}, 'draft', ${payDate as string | null}, ${Auth.account(ctx).username}, ${now}, ${now})
	`;
	const [run] = (await Database`SELECT * FROM payroll_runs WHERE uuid = ${uuid}`) as PayrollRunRow[];
	await storeRunCalculation(project, run);
	await audit(ctx, "payroll_run.created", "payroll_run", uuid, { period, pay_date: payDate });
	return await okWithNames(ctx, await runState(run), 201);
});

Server.app.get(`${base}/runs/:run`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	return await okWithNames(ctx, await runState(run));
});

Server.app.patch(`${base}/runs/:run`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	if (run.status === "final") return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_FINAL);
	const data = await body(ctx);
	const payDate = data?.pay_date ?? null;
	if (payDate !== null && !isIsoDate(payDate)) return Utils.fail(ctx, ErrorCode.INVALID_PAYROLL_RUN);
	await Database`UPDATE payroll_runs SET pay_date = ${payDate as string | null}, updated = ${Date.now()} WHERE uuid = ${run.uuid}`;
	await audit(ctx, "payroll_run.updated", "payroll_run", run.uuid, { pay_date: payDate }, { pay_date: run.pay_date });
	return await okWithNames(ctx, await runState(run));
});

Server.app.post(`${base}/runs/:run/recalculate`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	if (run.status === "final") return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_FINAL);
	await storeRunCalculation(Permissions.project(ctx), run);
	return await okWithNames(ctx, await runState(run));
});

Server.app.put(`${base}/runs/:run/lines/:line/items`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	if (run.status === "final") return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_FINAL);
	const [line] = (await Database`SELECT * FROM payroll_lines WHERE uuid = ${ctx.params.line} AND run = ${run.uuid}`) as PayrollLineRow[];
	if (!line || !line.member) return Utils.fail(ctx, ErrorCode.PAYROLL_LINE_NOT_FOUND);
	const data = await body(ctx);
	const items = readPayrollItems(data?.items);
	if (!items) return Utils.fail(ctx, ErrorCode.INVALID_PAYROLL_ITEMS);
	const [employee] = await Database`SELECT * FROM employees WHERE member = ${line.member}`;
	if (!employee) return Utils.fail(ctx, ErrorCode.PAYROLL_LINE_NOT_FOUND);
	const previous = JSON.parse(line.calculation) as PayrollCalculation;
	const calculation = calculateLine(
		previous.hours,
		employee,
		run.period,
		items,
		await ratesFor(run.project, run.period),
		await yearToDateFor(Permissions.project(ctx), run, line.member),
		previous.leave ?? null
	);
	await Database`
		UPDATE payroll_lines SET items = ${JSON.stringify(items)}, calculation = ${JSON.stringify(calculation)}, updated = ${Date.now()} WHERE uuid = ${line.uuid}
	`;
	await audit(ctx, "payroll_line.items_updated", "payroll_run", run.uuid, { person: line.person, items }, { items: previous.items });
	return await okWithNames(ctx, await runState(run));
});

Server.app.post(`${base}/runs/:run/finalize`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const project = Permissions.project(ctx);
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	if (run.status === "final") return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_FINAL);
	const rates = await ratesFor(project.uuid, run.period);
	if (!rates) return Utils.fail(ctx, ErrorCode.PAYROLL_RATES_NOT_FOUND);
	if (!rates.verified) return Utils.fail(ctx, ErrorCode.PAYROLL_RATES_UNVERIFIED);
	await storeRunCalculation(project, run);
	const now = Date.now();
	await Database`
		UPDATE payroll_runs SET status = 'final', finalized_by = ${Auth.account(ctx).username}, finalized_at = ${now}, updated = ${now} WHERE uuid = ${run.uuid}
	`;
	const state = await runState(run);
	await audit(ctx, "payroll_run.finalized", "payroll_run", run.uuid, { period: run.period, totals: state.totals });
	return await okWithNames(ctx, state);
});

Server.app.post(`${base}/runs/:run/reopen`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	await Database`UPDATE payroll_runs SET status = 'draft', finalized_by = NULL, finalized_at = NULL, updated = ${Date.now()} WHERE uuid = ${run.uuid}`;
	await audit(ctx, "payroll_run.reopened", "payroll_run", run.uuid, { period: run.period }, { finalized_by: run.finalized_by, finalized_at: run.finalized_at });
	return await okWithNames(ctx, await runState(run));
});

Server.app.delete(`${base}/runs/:run`, Auth.required(), Permissions.require(Permission.EMPLOYEE_EDIT), requireWorkforce(), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	if (run.status === "final") return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_FINAL);
	await Database`DELETE FROM payroll_runs WHERE uuid = ${run.uuid}`;
	await audit(ctx, "payroll_run.deleted", "payroll_run", run.uuid, undefined, { period: run.period });
	return Utils.ok(ctx);
});

Server.app.get(`${base}/runs/:run/export`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	const lines = (await runLines(run)).map((line) => line.calculation);
	await audit(ctx, "payroll_run.exported", "payroll_run", run.uuid, { format: "csv" });
	return downloadResponse({ name: `payroll-${run.period}.csv`, data: new TextEncoder().encode(payrollCsv(run, lines)) }, "text/csv; charset=utf-8");
});

Server.app.get(`${base}/runs/:run/payslips`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	const only = ctx.query().get("line");
	const lines = (await runLines(run)).filter((line) => !only || line.uuid === only);
	if (only && lines.length === 0) return Utils.fail(ctx, ErrorCode.PAYROLL_LINE_NOT_FOUND);
	await audit(ctx, "payroll_run.payslips_downloaded", "payroll_run", run.uuid, { line: only });
	const name = lines.length === 1 ? `payslip-${run.period}-${lines[0].person}.pdf` : `payslips-${run.period}.pdf`;
	return pdfResponse({
		name,
		data: await payslipsPdf(
			Permissions.project(ctx),
			run,
			lines.map((line) => line.calculation)
		),
	});
});

Server.app.get(`${base}/runs/:run/rek-o`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	if (run.status !== "final") return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FINAL);
	const query = ctx.query();
	const responsible = query.get("responsible")?.trim() ?? "";
	const contact = query.get("contact")?.trim() ?? "";
	const taxpayerType = query.get("taxpayer_type") === "SP" ? "SP" : "PO";
	const collectiveAgreement = query.get("collective_agreement") ?? "";
	const kind = query.get("kind") ?? "salary";
	if (!isRekKind(kind) || !responsible || responsible.length > 100 || !contact || contact.length > 200 || !isCollectiveAgreementCode(collectiveAgreement)) {
		return Utils.fail(ctx, ErrorCode.REK_DATA_INCOMPLETE);
	}
	const company = await companyFor(project.uuid);
	const lines = (await runLines(run)).map((line) => line.calculation);
	const problems = rekProblems(company, run, lines, kind);
	if (problems.length) return Utils.failWithReason(ctx, ErrorCode.REK_DATA_INCOMPLETE, "The REK-O file needs more data first.", { problems });
	const xml = rekOXml(company, displayNameOf(project), run, lines, {
		kind,
		responsible_person: responsible,
		contact,
		taxpayer_type: taxpayerType,
		collective_agreement: collectiveAgreement,
	});
	await audit(ctx, "payroll_run.rek_o_exported", "payroll_run", run.uuid, { period: run.period, kind });
	return downloadResponse({ name: `REK-O-${kind}-${run.period}.xml`, data: new TextEncoder().encode(xml) }, "application/xml; charset=utf-8");
});

Server.app.get(`${base}/runs/:run/sepa`, Auth.required(), Permissions.require(Permission.EMPLOYEE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const run = await findRun(ctx);
	if (!run) return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FOUND);
	if (run.status !== "final") return Utils.fail(ctx, ErrorCode.PAYROLL_RUN_NOT_FINAL);
	const query = ctx.query();
	const bank = await configFor(project.uuid, "bank_transfer");
	const company = await companyFor(project.uuid);
	const iban = query.get("iban")?.trim() || bank.iban || "";
	const debtor = iban
		? {
				name: query.get("name")?.trim() || bank.account_holder || company.legal_name || displayNameOf(project),
				iban,
				bic: query.get("bic")?.trim() || bank.bic || null,
			}
		: null;
	const lines = (await runLines(run)).map((line) => line.calculation);
	const problems = sepaProblems(run, lines, debtor, project.currency);
	if (problems.length) return Utils.failWithReason(ctx, ErrorCode.SEPA_DATA_INCOMPLETE, "The payment file needs more data first.", { problems });
	const xml = salaryTransfersXml(run, lines, debtor!, new Date());
	await audit(ctx, "payroll_run.sepa_exported", "payroll_run", run.uuid, { period: run.period, debtor_iban: debtor!.iban });
	return downloadResponse({ name: `salaries-${run.period}.xml`, data: new TextEncoder().encode(xml) }, "application/xml; charset=utf-8");
});
