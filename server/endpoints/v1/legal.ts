import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Admin from "../../admin";
import Audit from "../../audit";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Settings } from "../../settings";
import {
	LEGAL_KINDS,
	MAX_LEGAL_DOCUMENT_LENGTH,
	MAX_LEGAL_NOTICE_MS,
	currentDocument,
	effectiveOf,
	isLegalKind,
	isLegalLanguage,
	latestDocument,
	legalTemplate,
	presentDocument,
	presentOperator,
	recordAcceptance,
	requiredVersions,
	requiresTerms,
	sameVersions,
	upcomingDocument,
} from "../../legal";
import { notifyAccounts } from "../../legal-notice";
import type { LegalDocumentRow, LegalKind } from "../../database/models";

const guard = [Auth.required(), Admin.required()] as const;
const publicLimit = rateLimit({ windowMs: 60 * 1000, max: 60, message: "Too many requests. Please slow down." });
const EFFECTIVE_GRACE_MS = 5 * 60 * 1000;

interface AcceptBody {
	legal_versions?: unknown;
}

interface PublishBody {
	content_en?: unknown;
	content_sl?: unknown;
	effective?: unknown;
	notify?: unknown;
}

function documentText(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length > MAX_LEGAL_DOCUMENT_LENGTH) return undefined;
	return value.trim() || null;
}

Server.app.get("/api/v1/legal", publicLimit, async (ctx) => {
	const now = Date.now();
	const [terms, privacy, upcomingTerms, upcomingPrivacy, required] = await Promise.all([
		currentDocument("terms", now),
		currentDocument("privacy", now),
		upcomingDocument("terms", now),
		upcomingDocument("privacy", now),
		requiredVersions(Database, now),
	]);
	return Utils.ok(ctx, {
		operator: presentOperator(),
		business_only: Settings.legal.business_only,
		terms: terms ? presentDocument(terms) : null,
		privacy: privacy ? presentDocument(privacy) : null,
		upcoming_terms: upcomingTerms ? presentDocument(upcomingTerms) : null,
		upcoming_privacy: upcomingPrivacy ? presentDocument(upcomingPrivacy) : null,
		required_versions: required,
	});
});

Server.app.post("/api/v1/auth/legal/accept", Auth.required(), async (ctx) => {
	let data: AcceptBody;
	try {
		data = await ctx.body<AcceptBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const account = Auth.account(ctx);
	const required = await requiredVersions();
	if (!requiresTerms(required)) return Utils.fail(ctx, ErrorCode.LEGAL_DOCUMENT_NOT_FOUND);
	if (!sameVersions(required, data.legal_versions)) return Utils.fail(ctx, ErrorCode.LEGAL_DOCUMENTS_CHANGED);

	await recordAcceptance(Database, account.username, required, { ip: Utils.clientIp(ctx), userAgent: Utils.userAgent(ctx) });
	await Audit.record(ctx, { action: "account.terms_accepted", entityType: "account", entityId: account.username, newValue: required });
	return Utils.ok(ctx, { pending_terms: null, upcoming_terms: null });
});

Server.app.get("/api/v1/admin/legal", ...guard, async (ctx) => {
	const rows = (await Database`
		SELECT d.*, (SELECT COUNT(DISTINCT a.account_username) FROM legal_acceptances a WHERE a.kind = d.kind AND a.version = d.version) AS accepted
		FROM legal_documents d ORDER BY d.kind ASC, d.version DESC
	`) as (LegalDocumentRow & { accepted: number })[];
	const [accounts] = (await Database`SELECT COUNT(*) AS count FROM accounts`) as { count: number }[];
	const now = Date.now();

	const documents = Object.fromEntries(
		LEGAL_KINDS.map((kind) => {
			const versions = rows.filter((row) => row.kind === kind);
			return [
				kind,
				{
					latest: versions[0] ? presentDocument(versions[0]) : null,
					versions: versions.map((row) => ({
						version: Number(row.version),
						published: Number(row.published),
						effective: effectiveOf(row),
						upcoming: effectiveOf(row) > now,
						published_by: row.published_by,
						accepted: Number(row.accepted),
					})),
				},
			];
		})
	);

	return Utils.ok(ctx, {
		operator: presentOperator(),
		business_only: Settings.legal.business_only,
		accounts: Number(accounts.count),
		email_enabled: Settings.email.enabled,
		documents,
	});
});

Server.app.get("/api/v1/admin/legal/:kind/template", ...guard, async (ctx) => {
	const kind = ctx.params["kind"];
	const language = ctx.query().get("language");
	if (!isLegalKind(kind) || !isLegalLanguage(language)) return Utils.fail(ctx, ErrorCode.LEGAL_DOCUMENT_NOT_FOUND);
	return Utils.ok(ctx, { content: legalTemplate(kind, language) });
});

Server.app.post("/api/v1/admin/legal/:kind", ...guard, async (ctx) => {
	const kind = ctx.params["kind"];
	if (!isLegalKind(kind)) return Utils.fail(ctx, ErrorCode.LEGAL_DOCUMENT_NOT_FOUND);

	let data: PublishBody;
	try {
		data = await ctx.body<PublishBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const contentEn = documentText(data.content_en);
	const contentSl = documentText(data.content_sl);
	if (contentEn === undefined || contentSl === undefined || (contentEn === null && contentSl === null)) {
		return Utils.fail(ctx, ErrorCode.INVALID_LEGAL_DOCUMENT);
	}

	const now = Date.now();
	const effective = data.effective === undefined || data.effective === null ? now : data.effective;
	if (typeof effective !== "number" || !Number.isInteger(effective) || effective < now - EFFECTIVE_GRACE_MS || effective > now + MAX_LEGAL_NOTICE_MS) {
		return Utils.fail(ctx, ErrorCode.INVALID_EFFECTIVE_DATE);
	}

	const actor = Auth.account(ctx);
	let published: LegalDocumentRow | ErrorCode;
	try {
		published = await Database.begin(async (tx) => {
			const previous = await latestDocument(kind as LegalKind, tx);
			if (previous && effectiveOf(previous) > Math.max(effective, now)) return ErrorCode.INVALID_EFFECTIVE_DATE;
			const row: LegalDocumentRow = {
				uuid: crypto.randomUUID(),
				kind: kind as LegalKind,
				version: (previous ? Number(previous.version) : 0) + 1,
				content_en: contentEn,
				content_sl: contentSl,
				published: now,
				published_by: actor.username,
				effective: Math.max(effective, now),
			};
			await tx`
				INSERT INTO legal_documents(uuid, kind, version, content_en, content_sl, published, published_by, effective)
				VALUES(${row.uuid}, ${row.kind}, ${row.version}, ${row.content_en}, ${row.content_sl}, ${row.published}, ${row.published_by}, ${row.effective})
			`;
			return row;
		});
	} catch (err) {
		Logger.warn(`[LEGAL] Publishing ${kind} failed: ${err}`);
		return Utils.fail(ctx, ErrorCode.LEGAL_DOCUMENTS_CHANGED);
	}
	if (typeof published === "number") return Utils.fail(ctx, published);

	const notified = data.notify === true ? await notifyAccounts(published) : null;

	await Audit.record(ctx, {
		action: "legal.published",
		entityType: "legal_document",
		entityId: published.uuid,
		newValue: { kind, version: published.version, effective: published.effective, notified },
	});
	Logger.audit(`[ADMIN] ${actor.username} published ${kind} version ${published.version}`);

	return Utils.ok(ctx, { ...presentDocument(published), notified }, 201);
});
