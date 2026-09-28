import { Server } from "../../server";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Permission } from "../../roles";
import { Pkcs12Error } from "../../furs/pkcs12";
import {
	readSigningCertificate,
	removeSigningCertificate,
	saveSigningCertificate,
	SigningCertificateRejected,
	signingCertificate,
} from "../../einvoice-signing";

const MAX_CERTIFICATE_BYTES = 64 * 1024;

interface CertificateBody {
	file?: unknown;
	password?: unknown;
}

Server.app.get("/api/v1/projects/:uuid/einvoice/signing-certificate", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	return Utils.ok(ctx, { certificate: await signingCertificate(project.uuid) });
});

Server.app.put("/api/v1/projects/:uuid/einvoice/signing-certificate", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);

	let body: CertificateBody | null;
	try {
		body = await ctx.body<CertificateBody>();
	} catch {
		body = null;
	}
	if (!body || typeof body.file !== "string" || typeof body.password !== "string" || body.password.length > 200) {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const file = Buffer.from(body.file, "base64");
	if (file.length === 0 || file.length > MAX_CERTIFICATE_BYTES) return Utils.fail(ctx, ErrorCode.SIGNING_CERTIFICATE_INVALID);

	let credentials;
	try {
		credentials = readSigningCertificate(new Uint8Array(file), body.password);
	} catch (err) {
		if (err instanceof Pkcs12Error) return Utils.failWithReason(ctx, ErrorCode.SIGNING_CERTIFICATE_INVALID, err.message);
		if (err instanceof SigningCertificateRejected) return Utils.failWithReason(ctx, ErrorCode.SIGNING_CERTIFICATE_REJECTED, err.message);
		throw err;
	}

	const certificate = await saveSigningCertificate(project.uuid, credentials);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "einvoice.signing_certificate_uploaded",
		entityType: "project",
		entityId: project.uuid,
		newValue: certificate,
	});
	Logger.audit(`[ESLOG] ${Auth.account(ctx).username} uploaded the signing certificate of ${certificate.holder} for ${project.uuid}`);

	return Utils.ok(ctx, { certificate });
});

Server.app.delete("/api/v1/projects/:uuid/einvoice/signing-certificate", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const previous = await signingCertificate(project.uuid);
	await removeSigningCertificate(project.uuid);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "einvoice.signing_certificate_removed",
		entityType: "project",
		entityId: project.uuid,
		oldValue: previous,
	});

	return Utils.ok(ctx, { certificate: null });
});
