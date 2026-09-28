import { Server } from "../../server";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Vault from "../../crypto/vault";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { configProblem, describeProcessor, pendingConfig, serverSupports, setProcessor, statesFor } from "../../payments/methods";

interface ProcessorBody {
	enabled?: boolean;
	config?: Record<string, string>;
}

Server.app.get("/api/v1/projects/:uuid/processors", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	return Utils.ok(ctx, await statesFor(project.uuid));
});

Server.app.put("/api/v1/projects/:uuid/processors/:processor", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const account = Auth.account(ctx);

	const name = ctx.params["processor"];
	const descriptor = describeProcessor(name);
	if (!descriptor) return Utils.fail(ctx, ErrorCode.INVALID_PROCESSOR);

	let data: ProcessorBody;
	try {
		data = await ctx.body<ProcessorBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (typeof data.enabled !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const config: Record<string, string> = {};
	for (const field of descriptor.fields) {
		const value = data.config?.[field.key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length > 500) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
		config[field.key] = value.trim();
	}

	if (Object.keys(config).length > 0 && !Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	if (data.enabled && !serverSupports(name)) return Utils.fail(ctx, ErrorCode.PROCESSOR_DISABLED);

	const next = await pendingConfig(project.uuid, name, config);
	const problem = await configProblem(name, next);
	if (problem) return Utils.failWithReason(ctx, ErrorCode.INVALID_PROCESSOR_CONFIG, problem);

	if (data.enabled) {
		const missing = descriptor.fields.filter((field) => !field.optional && !next[field.key]).map((field) => field.label);
		if (missing.length > 0)
			return Utils.failWithReason(ctx, ErrorCode.INVALID_PROCESSOR_CONFIG, `Fill in ${missing.join(", ")} before switching ${descriptor.label} on.`);
	}

	try {
		await setProcessor(project.uuid, name, data.enabled, config);
	} catch (err) {
		Logger.error(`[PROCESSORS] Could not save ${name} for ${project.uuid}: ${err}`);
		return Utils.fail(ctx, ErrorCode.UNKNOWN_ERROR);
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "processor.updated",
		entityType: "payment_method",
		entityId: name,
		newValue: { enabled: data.enabled, fields_set: Object.keys(config) },
	});
	Logger.audit(`[PROCESSORS] ${account.username} ${data.enabled ? "enabled" : "disabled"} ${name} on ${project.uuid}`);

	const states = await statesFor(project.uuid);
	return Utils.ok(
		ctx,
		states.find((state) => state.processor === name)
	);
});
