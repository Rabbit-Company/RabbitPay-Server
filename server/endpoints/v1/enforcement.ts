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
import { isLocalDate } from "../../timezone";
import { findLetter, todayFor } from "../../dunning";
import { createProposal, findProposal, planEnforcement, presentProposal, proposalFilename, storedProposal, type EnforcementRequest } from "../../enforcement";
import {
	COURT_FEE_ELECTRONIC,
	COURT_FEE_PAPER,
	COURT_FEE_PAYMENT_DAYS,
	isEnforcementStatus,
	MAX_COURT_CASE_LENGTH,
	OBJECTION_DAYS,
	PROPOSALS_PER_HOUR,
	proposalXml,
} from "../../enforcement-rules";
import type { EnforcementProposalRow } from "../../database/models";

async function readBody<T>(ctx: { body<B>(): Promise<B> }): Promise<T | null> {
	try {
		return (await ctx.body<T>()) ?? null;
	} catch {
		return null;
	}
}

async function letterNumbers(letters: string[]): Promise<Map<string, string>> {
	if (letters.length === 0) return new Map();
	const rows = (await Database`SELECT uuid, number FROM dunning_letters WHERE uuid IN ${Database(letters)}`) as { uuid: string; number: string }[];
	return new Map(rows.map((row) => [row.uuid, row.number]));
}

async function presentDetail(row: EnforcementProposalRow) {
	const numbers = await letterNumbers(row.dunning_letter ? [row.dunning_letter] : []);
	const names = await accountNames(row.created_by ? [row.created_by] : [], row.project);
	const document = storedProposal(row);
	return {
		...presentProposal(row, { letter_number: row.dunning_letter ? (numbers.get(row.dunning_letter) ?? null) : null }),
		created_by_name: row.created_by ? (names.get(row.created_by) ?? null) : null,
		creditor: document.creditor,
		debtor: document.debtor,
		claims: document.claims,
		means: document.means,
		commercial: document.commercial,
		fee_payment_days: COURT_FEE_PAYMENT_DAYS,
		objection_days: OBJECTION_DAYS,
	};
}

const letterBase = "/api/v1/projects/:uuid/dunning/:letter/enforcement";
const base = "/api/v1/projects/:uuid/enforcement";

Server.app.post(`${letterBase}/plan`, Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const letterId = ctx.params["letter"];
	if (!Validate.uuid(letterId)) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);
	const letter = await findLetter(project.uuid, letterId);
	if (!letter) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);

	const data = (await readBody<EnforcementRequest>(ctx)) ?? {};
	const plan = await planEnforcement(project, letter, data);
	if (!plan) return Utils.fail(ctx, ErrorCode.INVALID_ENFORCEMENT_PROPOSAL);

	const { document: _document, ...rest } = plan;
	return Utils.ok(ctx, {
		...rest,
		letter: { uuid: letter.uuid, number: letter.number, level: Number(letter.level), deadline_date: letter.deadline_date },
		ready: plan.document !== null,
		court_fee: COURT_FEE_ELECTRONIC,
		court_fee_paper: COURT_FEE_PAPER,
		fee_payment_days: COURT_FEE_PAYMENT_DAYS,
		proposals_per_hour: PROPOSALS_PER_HOUR,
	});
});

Server.app.post(letterBase, Auth.required(), Permissions.require(Permission.INVOICE_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const letterId = ctx.params["letter"];
	if (!Validate.uuid(letterId)) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);
	const letter = await findLetter(project.uuid, letterId);
	if (!letter) return Utils.fail(ctx, ErrorCode.DUNNING_LETTER_NOT_FOUND);

	const data = (await readBody<EnforcementRequest>(ctx)) ?? {};
	const plan = await planEnforcement(project, letter, data);
	if (!plan) return Utils.fail(ctx, ErrorCode.INVALID_ENFORCEMENT_PROPOSAL);
	if (!plan.document) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_NOT_READY);

	const proposal = await createProposal(project, letter, plan.document, account.username);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "enforcement.prepared",
		entityType: "enforcement_proposal",
		entityId: proposal.uuid,
		newValue: { dunning_letter: letter.number, customer: letter.customer, principal: Number(proposal.principal) },
	});
	Logger.audit(`[ENFORCEMENT] ${account.username} prepared an enforcement proposal from ${letter.number} on ${project.uuid}`);

	return Utils.ok(ctx, await presentDetail(proposal), 201);
});

Server.app.get(base, Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);

	const rows = (await Database`
		SELECT * FROM enforcement_proposals WHERE project = ${project.uuid} ORDER BY created DESC LIMIT ${limit} OFFSET ${offset}
	`) as EnforcementProposalRow[];
	const [counted] = (await Database`SELECT COUNT(*) AS count FROM enforcement_proposals WHERE project = ${project.uuid}`) as { count: number }[];
	const numbers = await letterNumbers(rows.map((row) => row.dunning_letter).filter((id): id is string => id !== null));

	return Utils.ok(ctx, {
		proposals: rows.map((row) => presentProposal(row, { letter_number: row.dunning_letter ? (numbers.get(row.dunning_letter) ?? null) : null })),
		total: Number(counted?.count ?? 0),
		limit,
		offset,
	});
});

Server.app.get(`${base}/:proposal`, Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const proposalId = ctx.params["proposal"];
	if (!Validate.uuid(proposalId)) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);
	const proposal = await findProposal(project.uuid, proposalId);
	if (!proposal) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);

	return Utils.ok(ctx, await presentDetail(proposal));
});

Server.app.get(`${base}/:proposal/xml`, Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const proposalId = ctx.params["proposal"];
	if (!Validate.uuid(proposalId)) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);
	const proposal = await findProposal(project.uuid, proposalId);
	if (!proposal) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);

	const numbers = await letterNumbers(proposal.dunning_letter ? [proposal.dunning_letter] : []);
	const name = proposalFilename(proposal, proposal.dunning_letter ? (numbers.get(proposal.dunning_letter) ?? null) : null);
	return new Response(proposalXml(storedProposal(proposal)), {
		headers: { "Content-Type": "application/xml;charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
	});
});

Server.app.patch(`${base}/:proposal`, Auth.required(), Permissions.require(Permission.INVOICE_CREATE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const proposalId = ctx.params["proposal"];
	if (!Validate.uuid(proposalId)) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);
	const proposal = await findProposal(project.uuid, proposalId);
	if (!proposal) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);

	const data = (await readBody<{ status?: unknown; court_case?: unknown; filed_date?: unknown }>(ctx)) ?? {};
	if (!isEnforcementStatus(data.status)) return Utils.fail(ctx, ErrorCode.INVALID_ENFORCEMENT_PROPOSAL);
	const courtCase = typeof data.court_case === "string" && data.court_case.trim() ? data.court_case.trim() : null;
	if (data.court_case !== undefined && data.court_case !== null && typeof data.court_case !== "string") {
		return Utils.fail(ctx, ErrorCode.INVALID_ENFORCEMENT_PROPOSAL);
	}
	if (courtCase !== null && courtCase.length > MAX_COURT_CASE_LENGTH) return Utils.fail(ctx, ErrorCode.INVALID_ENFORCEMENT_PROPOSAL);
	const filedDate = data.status === "filed" ? (data.filed_date ?? todayFor(project)) : null;
	if (filedDate !== null && (!isLocalDate(filedDate) || filedDate > todayFor(project))) return Utils.fail(ctx, ErrorCode.INVALID_ENFORCEMENT_PROPOSAL);
	const keptCase = data.status === "filed" ? courtCase : null;

	await Database`
		UPDATE enforcement_proposals SET status = ${data.status}, court_case = ${keptCase}, filed_date = ${filedDate}, updated = ${Date.now()}
		WHERE uuid = ${proposal.uuid}
	`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: data.status === "filed" ? "enforcement.filed" : "enforcement.reopened",
		entityType: "enforcement_proposal",
		entityId: proposal.uuid,
		oldValue: { status: proposal.status, court_case: proposal.court_case },
		newValue: { status: data.status, court_case: keptCase, filed_date: filedDate },
	});
	Logger.audit(`[ENFORCEMENT] ${account.username} marked enforcement proposal ${proposal.uuid} as ${data.status} on ${project.uuid}`);

	return Utils.ok(ctx, await presentDetail((await findProposal(project.uuid, proposal.uuid))!));
});

Server.app.delete(`${base}/:proposal`, Auth.required(), Permissions.require(Permission.INVOICE_DELETE), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);
	const proposalId = ctx.params["proposal"];
	if (!Validate.uuid(proposalId)) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);
	const proposal = await findProposal(project.uuid, proposalId);
	if (!proposal) return Utils.fail(ctx, ErrorCode.ENFORCEMENT_PROPOSAL_NOT_FOUND);

	await Database`DELETE FROM enforcement_proposals WHERE uuid = ${proposal.uuid}`;
	await Audit.record(ctx, {
		project: project.uuid,
		action: "enforcement.deleted",
		entityType: "enforcement_proposal",
		entityId: proposal.uuid,
		oldValue: { status: proposal.status, court_case: proposal.court_case, principal: Number(proposal.principal) },
	});
	Logger.audit(`[ENFORCEMENT] ${account.username} deleted enforcement proposal ${proposal.uuid} on ${project.uuid}`);

	return Utils.ok(ctx, null);
});
