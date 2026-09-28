import { Server } from "../../server";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { COMPANY_FIELDS, companyFor, saveCompany, type CompanyField } from "../../company";
import { isCountryCode } from "../../countries";

const LIMITS: Partial<Record<CompanyField, number>> = { footer_note: 2000 };

Server.app.get("/api/v1/projects/:uuid/company", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	return Utils.ok(ctx, await companyFor(project.uuid));
});

Server.app.put("/api/v1/projects/:uuid/company", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	let data: Partial<Record<CompanyField, unknown>>;
	try {
		data = await ctx.body<Partial<Record<CompanyField, unknown>>>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const changes: Partial<Record<CompanyField, string | null>> = {};

	for (const key of COMPANY_FIELDS) {
		if (!(key in data)) continue;

		const value = data[key];
		if (value === null || value === undefined) {
			changes[key] = null;
			continue;
		}

		if (typeof value !== "string") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
		if (!Validate.optionalText(value, LIMITS[key] ?? 200)) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

		if (key === "country" && value.trim() !== "") {
			const code = value.trim().toUpperCase();
			if (!isCountryCode(code)) return Utils.fail(ctx, ErrorCode.INVALID_COUNTRY_CODE);
			changes[key] = code;
			continue;
		}

		changes[key] = value;
	}

	const saved = await saveCompany(project.uuid, changes);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "project.company_updated",
		entityType: "project",
		entityId: project.uuid,
		newValue: { legal_name: saved.legal_name, vat_number: saved.vat_number },
	});

	return Utils.ok(ctx, saved);
});
