import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Permissions from "../../permissions";
import Utils from "../../utils";
import Validate from "../../validate";
import { ErrorCode } from "../../errors";
import { Permission } from "../../roles";
import { Logger } from "../../logger";
import { Settings } from "../../settings";
import { Pkcs12Error } from "../../furs/pkcs12";
import { certificateInfo, credentialsFromPkcs12, openCredentials, sealCredentials } from "../../furs/credentials";
import { echo, FursRejected, FursUnavailable, fursEndpoint, registerPremise, type BusinessPremise, type FursEnvironment } from "../../furs/client";
import { fursTime } from "../../furs/zoi";
import { activeFiscal, fiscalSettings, isFiscalCountry, MARK_PATTERN, openPremise } from "../../fiscal/config";
import { findFiscalDocument, retryDocument } from "../../fiscal/documents";
import { DUE_SOON_MS } from "../../fiscal/alerts";
import type { FiscalDocumentRow, FiscalPremiseRow, FiscalSettingsRow, ProjectRow } from "../../database/models";

const MAX_CERTIFICATE_BYTES = 64 * 1024;

interface CertificateBody {
	file?: unknown;
	password?: unknown;
}

interface SettingsBody {
	enabled?: unknown;
	online_premise?: unknown;
	online_device?: unknown;
	pos_premise?: unknown;
	pos_device?: unknown;
	operator_tax_number?: unknown;
}

interface PremiseBody {
	premise_id?: unknown;
	kind?: unknown;
	premise_type?: unknown;
	cadastral_number?: unknown;
	building_number?: unknown;
	building_section_number?: unknown;
	street?: unknown;
	house_number?: unknown;
	house_number_additional?: unknown;
	community?: unknown;
	city?: unknown;
	postal_code?: unknown;
	validity_date?: unknown;
}

async function readBody<T>(ctx: Parameters<typeof Utils.fail>[0]): Promise<T | null> {
	try {
		const body = await ctx.body<T>();
		return body && typeof body === "object" ? body : null;
	} catch {
		return null;
	}
}

function presentPremise(premise: FiscalPremiseRow) {
	return {
		uuid: premise.uuid,
		environment: premise.environment,
		premise_id: premise.premise_id,
		kind: premise.kind,
		premise_type: premise.premise_type,
		cadastral_number: premise.cadastral_number,
		building_number: premise.building_number,
		building_section_number: premise.building_section_number,
		street: premise.street,
		house_number: premise.house_number,
		house_number_additional: premise.house_number_additional,
		community: premise.community,
		city: premise.city,
		postal_code: premise.postal_code,
		validity_date: premise.validity_date,
		registered_at: premise.registered_at,
		closed_at: premise.closed_at,
	};
}

export function presentFiscalDocument(document: FiscalDocumentRow & { reference?: string | null }) {
	return {
		uuid: document.uuid,
		invoice: document.invoice,
		credit_note: document.credit_note,
		reference: document.reference ?? `${document.premise_id}-${document.device_id}-${document.invoice_number}`,
		environment: document.environment,
		premise_id: document.premise_id,
		device_id: document.device_id,
		invoice_number: document.invoice_number,
		issued_at: document.issued_at,
		amount: document.amount,
		zoi: document.zoi,
		eor: document.eor,
		status: document.status,
		attempts: document.attempts,
		subsequent: document.subsequent === 1,
		next_attempt_at: document.next_attempt_at,
		deadline: document.deadline,
		error_code: document.error_code,
		last_error: document.last_error,
		verified_at: document.verified_at,
		created: document.created,
	};
}

async function presentSettings(project: ProjectRow) {
	const settings = await fiscalSettings(Database, project.uuid);
	const environment = settings?.environment ?? "test";
	const premises = (await Database`
		SELECT * FROM fiscal_premises WHERE project = ${project.uuid} ORDER BY environment ASC, premise_id ASC
	`) as FiscalPremiseRow[];
	const now = Date.now();
	const [counts] = (await Database`
		SELECT
			COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
			COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
			COALESCE(SUM(CASE WHEN status = 'pending' AND deadline < ${now} THEN 1 ELSE 0 END), 0) AS late,
			COALESCE(SUM(CASE WHEN status = 'pending' AND deadline >= ${now} AND deadline <= ${now + DUE_SOON_MS} THEN 1 ELSE 0 END), 0) AS due_soon
		FROM fiscal_documents WHERE project = ${project.uuid}
	`) as { pending: number; rejected: number; late: number; due_soon: number }[];
	const operators = (await Database`
		SELECT pm.account_username AS username, a.email, pm.full_name, pm.role, fo.tax_number
		FROM project_members pm JOIN accounts a ON a.username = pm.account_username
		LEFT JOIN fiscal_operators fo ON fo.project = pm.project_id AND fo.username = pm.account_username
		WHERE pm.project_id = ${project.uuid} AND pm.status = 'active' AND pm.account_username IS NOT NULL
		ORDER BY pm.created ASC
	`) as { username: string; email: string; full_name: string | null; role: string; tax_number: number | null }[];

	return {
		required: isFiscalCountry(project),
		active: (await activeFiscal(Database, project)) !== null,
		environment,
		enabled: settings?.enabled === 1,
		certificate: settings?.certificate
			? {
					holder: settings.certificate_holder,
					tax_number: settings.certificate_tax_number,
					serial: settings.certificate_serial,
					valid_to: settings.certificate_valid_to,
				}
			: null,
		online_premise: settings?.online_premise ?? null,
		online_device: settings?.online_device ?? null,
		pos_premise: settings?.pos_premise ?? null,
		pos_device: settings?.pos_device ?? null,
		operator_tax_number: settings?.operator_tax_number ?? null,
		premises: premises.map(presentPremise),
		pending: Number(counts?.pending ?? 0),
		rejected: Number(counts?.rejected ?? 0),
		late: Number(counts?.late ?? 0),
		due_soon: Number(counts?.due_soon ?? 0),
		operators: operators.map((operator) => ({
			username: operator.username,
			name: operator.full_name?.trim() || operator.email,
			email: operator.email,
			role: operator.role,
			tax_number: operator.tax_number === null ? null : Number(operator.tax_number),
		})),
	};
}

async function saveSettings(projectId: string, changes: Partial<FiscalSettingsRow>) {
	const current = await fiscalSettings(Database, projectId);
	const timestamp = Date.now();
	const merged = {
		environment: changes.environment ?? current?.environment ?? "test",
		certificate: changes.certificate !== undefined ? changes.certificate : (current?.certificate ?? null),
		certificate_holder: changes.certificate_holder !== undefined ? changes.certificate_holder : (current?.certificate_holder ?? null),
		certificate_tax_number: changes.certificate_tax_number !== undefined ? changes.certificate_tax_number : (current?.certificate_tax_number ?? null),
		certificate_serial: changes.certificate_serial !== undefined ? changes.certificate_serial : (current?.certificate_serial ?? null),
		certificate_valid_to: changes.certificate_valid_to !== undefined ? changes.certificate_valid_to : (current?.certificate_valid_to ?? null),
		enabled: changes.enabled ?? current?.enabled ?? 0,
		online_premise: changes.online_premise !== undefined ? changes.online_premise : (current?.online_premise ?? null),
		online_device: changes.online_device !== undefined ? changes.online_device : (current?.online_device ?? null),
		pos_premise: changes.pos_premise !== undefined ? changes.pos_premise : (current?.pos_premise ?? null),
		pos_device: changes.pos_device !== undefined ? changes.pos_device : (current?.pos_device ?? null),
		operator_tax_number: changes.operator_tax_number !== undefined ? changes.operator_tax_number : (current?.operator_tax_number ?? null),
	};

	if (current) {
		await Database`
			UPDATE fiscal_settings SET environment = ${merged.environment}, certificate = ${merged.certificate},
				certificate_holder = ${merged.certificate_holder}, certificate_tax_number = ${merged.certificate_tax_number},
				certificate_serial = ${merged.certificate_serial}, certificate_valid_to = ${merged.certificate_valid_to}, enabled = ${merged.enabled},
				online_premise = ${merged.online_premise}, online_device = ${merged.online_device}, pos_premise = ${merged.pos_premise},
				pos_device = ${merged.pos_device}, operator_tax_number = ${merged.operator_tax_number}, updated = ${timestamp}
			WHERE project = ${projectId}
		`;
	} else {
		await Database`
			INSERT INTO fiscal_settings(project, environment, certificate, certificate_holder, certificate_tax_number, certificate_serial,
				certificate_valid_to, enabled, online_premise, online_device, pos_premise, pos_device, operator_tax_number, created, updated)
			VALUES(${projectId}, ${merged.environment}, ${merged.certificate}, ${merged.certificate_holder}, ${merged.certificate_tax_number},
				${merged.certificate_serial}, ${merged.certificate_valid_to}, ${merged.enabled}, ${merged.online_premise}, ${merged.online_device},
				${merged.pos_premise}, ${merged.pos_device}, ${merged.operator_tax_number}, ${timestamp}, ${timestamp})
		`;
	}
}

function fursFailure(ctx: Parameters<typeof Utils.fail>[0], err: unknown) {
	if (err instanceof FursRejected) return Utils.failWithReason(ctx, ErrorCode.FURS_REJECTED, `FURS rejected the request (${err.code}): ${err.message}`);
	if (err instanceof FursUnavailable) return Utils.failWithReason(ctx, ErrorCode.FURS_UNAVAILABLE, err.message);
	throw err;
}

async function credentialsFor(projectId: string) {
	const settings = await fiscalSettings(Database, projectId);
	if (!settings?.certificate) return null;
	return { settings, credentials: openCredentials(settings.certificate) };
}

function softwareSupplier(): BusinessPremise["SoftwareSupplier"] {
	const taxNumber = Number(Settings.fiscal?.software_supplier_tax_number ?? 0);
	if (Number.isInteger(taxNumber) && taxNumber >= 10000000 && taxNumber <= 99999999) return [{ TaxNumber: taxNumber }];
	return [{ NameForeign: (Settings.fiscal?.software_supplier_name || "RabbitPay").slice(0, 1000) }];
}

function text(value: unknown, max: number, min = 1): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function whole(value: unknown, max: number): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function premiseFrom(
	body: PremiseBody
): Omit<FiscalPremiseRow, "uuid" | "project" | "environment" | "registered_at" | "closed_at" | "created" | "updated"> | null {
	const premiseId = typeof body.premise_id === "string" && MARK_PATTERN.test(body.premise_id) ? body.premise_id : null;
	const validity = body.validity_date === undefined ? fursTime(Date.now()).iso.slice(0, 10) : body.validity_date;
	if (!premiseId || typeof validity !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(validity) || Number.isNaN(Date.parse(validity))) return null;

	const empty = {
		premise_type: null,
		cadastral_number: null,
		building_number: null,
		building_section_number: null,
		street: null,
		house_number: null,
		house_number_additional: null,
		community: null,
		city: null,
		postal_code: null,
	};

	if (body.kind === "movable") {
		if (body.premise_type !== "A" && body.premise_type !== "B" && body.premise_type !== "C") return null;
		return { ...empty, premise_id: premiseId, kind: "movable", premise_type: body.premise_type, validity_date: validity };
	}
	if (body.kind !== "real_estate") return null;

	const cadastral = whole(body.cadastral_number, 9999);
	const building = whole(body.building_number, 99999);
	const section = whole(body.building_section_number, 9999);
	const street = text(body.street, 100);
	const house = text(body.house_number, 10);
	const additional =
		body.house_number_additional === undefined || body.house_number_additional === null || body.house_number_additional === ""
			? null
			: text(body.house_number_additional, 10);
	const community = text(body.community, 100);
	const city = text(body.city, 100);
	const postal = typeof body.postal_code === "string" && /^\d{4}$/.test(body.postal_code.trim()) ? body.postal_code.trim() : null;
	if (cadastral === null || building === null || section === null || !street || !house || !community || !city || !postal) return null;
	if (additional === null && body.house_number_additional !== undefined && body.house_number_additional !== null && body.house_number_additional !== "")
		return null;

	return {
		...empty,
		premise_id: premiseId,
		kind: "real_estate",
		cadastral_number: cadastral,
		building_number: building,
		building_section_number: section,
		street,
		house_number: house,
		house_number_additional: additional,
		community,
		city,
		postal_code: postal,
		validity_date: validity,
	};
}

function premiseMessage(
	premise: Pick<
		FiscalPremiseRow,
		| "premise_id"
		| "kind"
		| "premise_type"
		| "cadastral_number"
		| "building_number"
		| "building_section_number"
		| "street"
		| "house_number"
		| "house_number_additional"
		| "community"
		| "city"
		| "postal_code"
		| "validity_date"
	>,
	taxNumber: number,
	closing: boolean
): BusinessPremise {
	const identifier: BusinessPremise["BPIdentifier"] =
		premise.kind === "movable"
			? { PremiseType: premise.premise_type! }
			: {
					RealEstateBP: {
						PropertyID: {
							CadastralNumber: premise.cadastral_number!,
							BuildingNumber: premise.building_number!,
							BuildingSectionNumber: premise.building_section_number!,
						},
						Address: {
							Street: premise.street!,
							HouseNumber: premise.house_number!,
							...(premise.house_number_additional ? { HouseNumberAdditional: premise.house_number_additional } : {}),
							Community: premise.community!,
							City: premise.city!,
							PostalCode: premise.postal_code!,
						},
					},
				};
	return {
		TaxNumber: taxNumber,
		BusinessPremiseID: premise.premise_id,
		BPIdentifier: identifier,
		ValidityDate: premise.validity_date,
		...(closing ? { ClosingTag: "Z" as const } : {}),
		SoftwareSupplier: softwareSupplier(),
	};
}

Server.app.get("/api/v1/projects/:uuid/fiscal", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
	return Utils.ok(ctx, await presentSettings(Permissions.project(ctx)));
});

Server.app.put("/api/v1/projects/:uuid/fiscal/certificate", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const body = await readBody<CertificateBody>(ctx);
	if (!body || typeof body.file !== "string" || typeof body.password !== "string" || body.password.length > 200) {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const file = Buffer.from(body.file, "base64");
	if (file.length === 0 || file.length > MAX_CERTIFICATE_BYTES) return Utils.fail(ctx, ErrorCode.FISCAL_CERTIFICATE_INVALID);

	let credentials;
	try {
		credentials = credentialsFromPkcs12(new Uint8Array(file), body.password);
	} catch (err) {
		if (err instanceof Pkcs12Error) return Utils.failWithReason(ctx, ErrorCode.FISCAL_CERTIFICATE_INVALID, err.message);
		throw err;
	}

	const info = certificateInfo(credentials.certificate);
	if (info.taxNumber === null) return Utils.failWithReason(ctx, ErrorCode.FISCAL_CERTIFICATE_REJECTED, "The certificate does not name a Slovenian tax number.");
	if (info.validTo < Date.now()) return Utils.failWithReason(ctx, ErrorCode.FISCAL_CERTIFICATE_REJECTED, "The certificate has expired.");

	const environment: FursEnvironment = info.test ? "test" : "production";
	const current = await fiscalSettings(Database, project.uuid);
	const switched = current !== null && (current.environment !== environment || current.certificate_tax_number !== info.taxNumber);

	await saveSettings(project.uuid, {
		environment,
		certificate: sealCredentials(credentials),
		certificate_holder: info.holder,
		certificate_tax_number: info.taxNumber,
		certificate_serial: info.serial,
		certificate_valid_to: info.validTo,
		...(switched ? { enabled: 0 } : {}),
	});

	await Audit.record(ctx, {
		project: project.uuid,
		action: "fiscal.certificate_uploaded",
		entityType: "project",
		entityId: project.uuid,
		newValue: { holder: info.holder, tax_number: info.taxNumber, serial: info.serial, environment, valid_to: info.validTo },
	});
	Logger.audit(`[FURS] ${Auth.account(ctx).username} uploaded the ${environment} certificate of ${info.holder} for ${project.uuid}`);

	return Utils.ok(ctx, await presentSettings(project));
});

Server.app.delete("/api/v1/projects/:uuid/fiscal/certificate", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	await saveSettings(project.uuid, {
		certificate: null,
		certificate_holder: null,
		certificate_tax_number: null,
		certificate_serial: null,
		certificate_valid_to: null,
		enabled: 0,
	});
	await Audit.record(ctx, { project: project.uuid, action: "fiscal.certificate_removed", entityType: "project", entityId: project.uuid });
	return Utils.ok(ctx, await presentSettings(project));
});

Server.app.patch("/api/v1/projects/:uuid/fiscal", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const body = await readBody<SettingsBody>(ctx);
	if (!body) return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);

	const changes: Partial<FiscalSettingsRow> = {};
	for (const key of ["online_premise", "online_device", "pos_premise", "pos_device"] as const) {
		const value = body[key];
		if (value === undefined) continue;
		if (value === null || value === "") changes[key] = null;
		else if (typeof value === "string" && MARK_PATTERN.test(value)) changes[key] = value;
		else return Utils.fail(ctx, ErrorCode.FISCAL_INVALID_PREMISE);
	}
	if (body.operator_tax_number !== undefined) {
		const value = body.operator_tax_number;
		if (value === null || value === "") changes.operator_tax_number = null;
		else if (typeof value === "number" && Number.isInteger(value) && value >= 10000000 && value <= 99999999) changes.operator_tax_number = value;
		else return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
		changes.enabled = body.enabled ? 1 : 0;
	}

	const current = await fiscalSettings(Database, project.uuid);
	const environment = current?.environment ?? "test";
	const next = { ...current, ...changes } as FiscalSettingsRow;
	if (Boolean(next.pos_premise) !== Boolean(next.pos_device)) {
		return Utils.failWithReason(ctx, ErrorCode.FISCAL_INVALID_PREMISE, "Choose both the premise and the device for the terminal.");
	}
	for (const premise of [changes.online_premise, changes.pos_premise]) {
		if (premise && !(await openPremise(Database, project.uuid, environment, premise))) return Utils.fail(ctx, ErrorCode.FISCAL_PREMISE_NOT_REGISTERED);
	}
	if (next.enabled === 1) {
		if (!next.certificate) return Utils.fail(ctx, ErrorCode.FISCAL_CERTIFICATE_REQUIRED);
		if (!next.online_premise || !next.online_device) {
			return Utils.failWithReason(ctx, ErrorCode.FISCAL_INVALID_PREMISE, "Choose the premise and device for invoices before turning fiscal verification on.");
		}
		if (!(await openPremise(Database, project.uuid, environment, next.online_premise))) return Utils.fail(ctx, ErrorCode.FISCAL_PREMISE_NOT_REGISTERED);
	}

	await saveSettings(project.uuid, changes);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "fiscal.settings_updated",
		entityType: "project",
		entityId: project.uuid,
		newValue: changes,
	});

	return Utils.ok(ctx, await presentSettings(project));
});

Server.app.put("/api/v1/projects/:uuid/fiscal/operators/:username", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const username = ctx.params["username"];
	const [member] = (await Database`
		SELECT account_username FROM project_members
		WHERE project_id = ${project.uuid} AND account_username = ${username ?? ""} AND status = 'active'
	`) as { account_username: string }[];
	if (!member) return Utils.fail(ctx, ErrorCode.MEMBER_NOT_FOUND);

	const body = await readBody<{ tax_number?: unknown }>(ctx);
	const value = body?.tax_number;
	if (value !== null && !(typeof value === "number" && Number.isInteger(value) && value >= 10000000 && value <= 99999999)) {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const timestamp = Date.now();
	await Database.begin(async (tx) => {
		await tx`DELETE FROM fiscal_operators WHERE project = ${project.uuid} AND username = ${member.account_username}`;
		if (value !== null) {
			await tx`
				INSERT INTO fiscal_operators(project, username, tax_number, created, updated)
				VALUES(${project.uuid}, ${member.account_username}, ${value}, ${timestamp}, ${timestamp})
			`;
		}
	});
	await Audit.record(ctx, {
		project: project.uuid,
		action: "fiscal.operator_updated",
		entityType: "project",
		entityId: project.uuid,
		newValue: { username: member.account_username, tax_number_set: value !== null },
	});
	return Utils.ok(ctx, await presentSettings(project));
});

Server.app.post("/api/v1/projects/:uuid/fiscal/echo", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const stored = await credentialsFor(project.uuid);
	if (!stored) return Utils.fail(ctx, ErrorCode.FISCAL_CERTIFICATE_REQUIRED);
	try {
		await echo(fursEndpoint(stored.settings.environment), stored.credentials);
	} catch (err) {
		return fursFailure(ctx, err);
	}
	return Utils.ok(ctx, { environment: stored.settings.environment });
});

Server.app.post("/api/v1/projects/:uuid/fiscal/premises", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const stored = await credentialsFor(project.uuid);
	if (!stored || !stored.settings.certificate_tax_number) return Utils.fail(ctx, ErrorCode.FISCAL_CERTIFICATE_REQUIRED);

	const body = await readBody<PremiseBody>(ctx);
	const premise = body ? premiseFrom(body) : null;
	if (!premise) return Utils.fail(ctx, ErrorCode.FISCAL_INVALID_PREMISE);

	const environment = stored.settings.environment;
	try {
		await registerPremise(fursEndpoint(environment), stored.credentials, premiseMessage(premise, stored.settings.certificate_tax_number, false));
	} catch (err) {
		return fursFailure(ctx, err);
	}

	const timestamp = Date.now();
	const [existing] = (await Database`
		SELECT uuid FROM fiscal_premises WHERE project = ${project.uuid} AND environment = ${environment} AND premise_id = ${premise.premise_id}
	`) as { uuid: string }[];
	if (existing) {
		await Database`
			UPDATE fiscal_premises SET kind = ${premise.kind}, premise_type = ${premise.premise_type}, cadastral_number = ${premise.cadastral_number},
				building_number = ${premise.building_number}, building_section_number = ${premise.building_section_number}, street = ${premise.street},
				house_number = ${premise.house_number}, house_number_additional = ${premise.house_number_additional}, community = ${premise.community},
				city = ${premise.city}, postal_code = ${premise.postal_code}, validity_date = ${premise.validity_date}, registered_at = ${timestamp},
				closed_at = NULL, updated = ${timestamp}
			WHERE uuid = ${existing.uuid}
		`;
	} else {
		await Database`
			INSERT INTO fiscal_premises(uuid, project, environment, premise_id, kind, premise_type, cadastral_number, building_number,
				building_section_number, street, house_number, house_number_additional, community, city, postal_code, validity_date, registered_at,
				closed_at, created, updated)
			VALUES(${crypto.randomUUID()}, ${project.uuid}, ${environment}, ${premise.premise_id}, ${premise.kind}, ${premise.premise_type},
				${premise.cadastral_number}, ${premise.building_number}, ${premise.building_section_number}, ${premise.street}, ${premise.house_number},
				${premise.house_number_additional}, ${premise.community}, ${premise.city}, ${premise.postal_code}, ${premise.validity_date}, ${timestamp},
				NULL, ${timestamp}, ${timestamp})
		`;
	}

	await Audit.record(ctx, {
		project: project.uuid,
		action: "fiscal.premise_registered",
		entityType: "project",
		entityId: project.uuid,
		newValue: { premise_id: premise.premise_id, environment, kind: premise.kind },
	});
	Logger.audit(`[FURS] Registered premise ${premise.premise_id} in ${environment} for ${project.uuid}`);

	return Utils.ok(ctx, await presentSettings(project), 201);
});

Server.app.post("/api/v1/projects/:uuid/fiscal/premises/:premise/close", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const stored = await credentialsFor(project.uuid);
	if (!stored || !stored.settings.certificate_tax_number) return Utils.fail(ctx, ErrorCode.FISCAL_CERTIFICATE_REQUIRED);

	const premiseId = ctx.params["premise"];
	const premise = premiseId && MARK_PATTERN.test(premiseId) ? await openPremise(Database, project.uuid, stored.settings.environment, premiseId) : null;
	if (!premise) return Utils.fail(ctx, ErrorCode.FISCAL_PREMISE_NOT_REGISTERED);

	try {
		await registerPremise(fursEndpoint(premise.environment), stored.credentials, premiseMessage(premise, stored.settings.certificate_tax_number, true));
	} catch (err) {
		return fursFailure(ctx, err);
	}

	const timestamp = Date.now();
	await Database`UPDATE fiscal_premises SET closed_at = ${timestamp}, updated = ${timestamp} WHERE uuid = ${premise.uuid}`;
	const changes: Partial<FiscalSettingsRow> = {};
	if (stored.settings.online_premise === premise.premise_id) Object.assign(changes, { online_premise: null, online_device: null, enabled: 0 });
	if (stored.settings.pos_premise === premise.premise_id) Object.assign(changes, { pos_premise: null, pos_device: null });
	if (Object.keys(changes).length > 0) await saveSettings(project.uuid, changes);

	await Audit.record(ctx, {
		project: project.uuid,
		action: "fiscal.premise_closed",
		entityType: "project",
		entityId: project.uuid,
		newValue: { premise_id: premise.premise_id, environment: premise.environment },
	});

	return Utils.ok(ctx, await presentSettings(project));
});

Server.app.get("/api/v1/projects/:uuid/fiscal/documents", Auth.required(), Permissions.require(Permission.INVOICE_VIEW), async (ctx) => {
	const project = Permissions.project(ctx);
	const query = ctx.query();
	const limit = Math.min(Math.max(Number(query.get("limit")) || 50, 1), 200);
	const offset = Math.max(Number(query.get("offset")) || 0, 0);
	const status = query.get("status");
	if (status !== null && status !== "pending" && status !== "verified" && status !== "rejected") return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	const statusFilter = status === null ? Database`` : Database`AND d.status = ${status}`;

	const rows = (await Database`
		SELECT d.*, COALESCE(i.reference, n.reference) AS reference
		FROM fiscal_documents d
		LEFT JOIN invoices i ON i.uuid = d.invoice
		LEFT JOIN credit_notes n ON n.uuid = d.credit_note
		WHERE d.project = ${project.uuid} ${statusFilter}
		ORDER BY d.created DESC, d.uuid ASC LIMIT ${limit} OFFSET ${offset}
	`) as (FiscalDocumentRow & { reference: string | null })[];
	const [total] = (await Database`SELECT COUNT(*) AS count FROM fiscal_documents d WHERE d.project = ${project.uuid} ${statusFilter}`) as { count: number }[];

	return Utils.ok(ctx, { documents: rows.map(presentFiscalDocument), total: Number(total?.count ?? 0), limit, offset });
});

Server.app.post("/api/v1/projects/:uuid/fiscal/documents/:document/retry", Auth.required(), Permissions.require(Permission.PROJECT_EDIT), async (ctx) => {
	const project = Permissions.project(ctx);
	const documentId = ctx.params["document"];
	if (!Validate.uuid(documentId)) return Utils.fail(ctx, ErrorCode.FISCAL_DOCUMENT_NOT_FOUND);
	const document = await findFiscalDocument(documentId);
	if (!document || document.project !== project.uuid) return Utils.fail(ctx, ErrorCode.FISCAL_DOCUMENT_NOT_FOUND);
	if (document.status === "verified") return Utils.ok(ctx, presentFiscalDocument(document));

	const result = await retryDocument(document.uuid);
	await Audit.record(ctx, {
		project: project.uuid,
		action: "fiscal.document_retried",
		entityType: "invoice",
		entityId: document.invoice ?? document.credit_note ?? document.uuid,
		newValue: { status: result?.status ?? null },
	});
	return Utils.ok(ctx, presentFiscalDocument(result ?? document));
});
