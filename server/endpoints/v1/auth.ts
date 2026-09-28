import { rateLimit } from "@rabbit-company/web-middleware/rate-limit";
import { Server } from "../../server";
import Database from "../../database/database";
import Auth from "../../auth";
import Audit from "../../audit";
import Utils from "../../utils";
import Validate from "../../validate";
import Errors, { ErrorCode } from "../../errors";
import { Logger } from "../../logger";
import { Settings } from "../../settings";
import Cache from "../../cache";
import Vault from "../../crypto/vault";
import TwoFactor, { MAX_SECURITY_KEYS } from "../../two-factor";
import WebAuthn from "../../webauthn";
import { RegistrationRefused, claimRegistration, registrationGrant, registrationMode } from "../../registration";
import { pendingTerms, recordAcceptance, requiredVersions, requiresTerms, sameVersions, upcomingTerms } from "../../legal";
import { exportAccount, exportResponse } from "../../account-data";
import type { AccountRow } from "../../database/models";

interface RegisterBody {
	username?: string;
	email?: string;
	password?: string;
	invite?: unknown;
	invitation?: unknown;
	accept_terms?: unknown;
	legal_versions?: unknown;
}

interface SecondFactorBody {
	code?: string;
	credential?: unknown;
}

interface LoginBody extends SecondFactorBody {
	username?: string;
	password?: string;
}

interface PasswordAndSecondFactorBody extends SecondFactorBody {
	password?: string;
}

interface SecurityKeyBody {
	password?: string;
	name?: unknown;
	credential?: unknown;
}

const TWO_FACTOR_SETUP_TTL = 10 * 60;

async function setupCacheKey(token: string): Promise<string> {
	return `two_factor_setup_${await Utils.generateHash(token, "sha256")}`;
}

async function storedConfig(username: string): Promise<string | null> {
	const [row] = (await Database`SELECT two_factor_secret FROM accounts WHERE username = ${username}`) as Pick<AccountRow, "two_factor_secret">[];
	return row?.two_factor_secret ?? null;
}

function secondFactorError(data: SecondFactorBody): ErrorCode {
	return data.credential === undefined ? ErrorCode.INVALID_TWO_FACTOR_CODE : ErrorCode.INVALID_SECURITY_KEY;
}

async function verifySecondFactor(account: AccountRow, data: SecondFactorBody, purpose: "login" | "confirm", allowRecovery = true): Promise<boolean> {
	if (data.credential !== undefined) {
		const keys = await TwoFactor.securityKeys(account.username);
		const verified = await WebAuthn.verifyAssertion(data.credential, purpose, account.username, keys);
		if (verified === null) return false;
		const used = await Database`
			UPDATE account_security_keys SET sign_count = ${verified.signCount}, last_used = ${Date.now()}
			WHERE uuid = ${verified.credential.uuid} AND sign_count = ${verified.credential.sign_count}
		`;
		return used.count > 0;
	}

	if (account.two_factor_secret === null) return false;
	const verification = await TwoFactor.verify(data.code, TwoFactor.decode(account.two_factor_secret), allowRecovery);
	if (!verification.valid) return false;
	if (!verification.recoveryConfig) return true;

	const consumed = await Database`
		UPDATE accounts SET two_factor_secret = ${TwoFactor.encode(verification.recoveryConfig)}, updated = ${Date.now()}
		WHERE username = ${account.username} AND two_factor_secret = ${account.two_factor_secret}
	`;
	if (consumed.count === 0) return false;
	Logger.audit(`[AUTH] Recovery code used: ${account.username}`);
	return true;
}

async function secondFactorChallenge(account: AccountRow) {
	const keys = await TwoFactor.securityKeys(account.username);
	const webauthn = keys.length ? await WebAuthn.assertionOptions("login", account.username, keys) : null;
	if (keys.length && webauthn === null) return null;
	return { authenticator: TwoFactor.hasAuthenticator(account.two_factor_secret), webauthn };
}

const DUMMY_ARGON2_HASH = await Bun.password.hash(Utils.generateRandomText(128));

const credentialLimit = rateLimit({
	windowMs: (Settings.security?.credential_rate_window || 900) * 1000,
	max: Settings.security?.credential_rate_limit || 10,
	message: "Too many attempts. Please try again later.",
});

const exportLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: "Too many exports. Please try again later." });

const registrationStatusLimit = rateLimit({ windowMs: 60 * 1000, max: 60, message: "Too many requests. Please slow down." });

Server.app.get("/api/v1/auth/registration", registrationStatusLimit, async (ctx) => {
	return Utils.ok(ctx, { mode: await registrationMode() });
});

Server.app.post("/api/v1/auth/register", credentialLimit, async (ctx) => {
	let data: RegisterBody;
	try {
		data = await ctx.body<RegisterBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.username(data.username)) return Utils.fail(ctx, ErrorCode.INVALID_USERNAME_FORMAT);
	if (!Validate.email(data.email)) return Utils.fail(ctx, ErrorCode.INVALID_EMAIL);
	if (!Validate.password(data.password)) return Utils.fail(ctx, ErrorCode.PASSWORD_NOT_HASHED);

	const username = data.username!;
	const email = data.email!;

	const grant = await registrationGrant({ email, invite: data.invite, invitation: data.invitation });
	if (typeof grant === "number") return Utils.fail(ctx, grant);

	const existing = (await Database`SELECT username FROM accounts WHERE username = ${username} OR email = ${email}`) as AccountRow[];
	if (existing.length > 0) return Utils.fail(ctx, ErrorCode.USERNAME_OR_EMAIL_ALREADY_EXISTS);

	const password = await Bun.password.hash(data.password!);
	const timestamp = Date.now();

	try {
		await Database.begin(async (tx) => {
			const legal = await requiredVersions(tx);
			if (requiresTerms(legal) && data.accept_terms !== true) throw new RegistrationRefused(ErrorCode.TERMS_NOT_ACCEPTED);
			if (requiresTerms(legal) && !sameVersions(legal, data.legal_versions)) throw new RegistrationRefused(ErrorCode.LEGAL_DOCUMENTS_CHANGED);

			const { admin } = await claimRegistration(tx, grant);
			await tx`
				INSERT INTO accounts(username, email, password, status, admin, created, updated, accessed)
				VALUES(${username}, ${email}, ${password}, 'active', ${admin ? 1 : 0}, ${timestamp}, ${timestamp}, ${timestamp})
			`;
			if (requiresTerms(legal)) await recordAcceptance(tx, username, legal, { ip: Utils.clientIp(ctx), userAgent: Utils.userAgent(ctx) });
		});
	} catch (err) {
		if (err instanceof RegistrationRefused) return Utils.fail(ctx, err.code);
		Logger.warn(`[AUTH] Registration rejected for "${username}": ${err}`);
		return Utils.fail(ctx, ErrorCode.USERNAME_OR_EMAIL_ALREADY_EXISTS);
	}

	const via = grant.kind === "invite" ? { invite: grant.invite.uuid } : grant.kind === "project_invitation" ? { project_invitation: grant.member } : {};
	await Audit.record(ctx, { action: "account.created", entityType: "account", entityId: username, newValue: { username, email, ...via } });
	Logger.audit(`[AUTH] Account created: ${username}`);

	return Utils.ok(ctx, { username, email, created: timestamp }, 201);
});

Server.app.post("/api/v1/auth/login", credentialLimit, async (ctx) => {
	let data: LoginBody;
	try {
		data = await ctx.body<LoginBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	if (!Validate.username(data.username)) return Utils.fail(ctx, ErrorCode.INVALID_USERNAME);
	if (!Validate.password(data.password)) return Utils.fail(ctx, ErrorCode.INVALID_PASSWORD);

	const [account] = (await Database`SELECT * FROM accounts WHERE username = ${data.username!}`) as AccountRow[];

	const valid = await Bun.password.verify(data.password!, account?.password ?? DUMMY_ARGON2_HASH);
	if (!account || !valid) {
		Logger.audit(`[AUTH] Failed login for "${data.username}" from ${Utils.clientIp(ctx)}`);
		return Utils.fail(ctx, ErrorCode.INCORRECT_PASSWORD);
	}

	if (account.status !== "active") return Utils.fail(ctx, ErrorCode.ACCOUNT_SUSPENDED);
	if (account.two_factor_secret !== null) {
		if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
		if (data.code === undefined && data.credential === undefined) {
			const challenge = await secondFactorChallenge(account);
			if (challenge === null) return Utils.fail(ctx, ErrorCode.REDIS_CONNECTION_ERROR);
			return Utils.failWithReason(ctx, ErrorCode.TWO_FACTOR_REQUIRED, Errors.get(ErrorCode.TWO_FACTOR_REQUIRED).message, challenge);
		}

		if (!(await verifySecondFactor(account, data, "login"))) {
			Logger.audit(`[AUTH] Failed two-factor login for "${account.username}" from ${Utils.clientIp(ctx)}`);
			return Utils.fail(ctx, secondFactorError(data));
		}
	}

	const token = await Auth.createSession(account.username, Utils.clientIp(ctx));
	if (token === null) return Utils.fail(ctx, ErrorCode.REDIS_CONNECTION_ERROR);

	await Database`UPDATE accounts SET accessed = ${Date.now()} WHERE username = ${account.username}`;
	Logger.audit(`[AUTH] Login: ${account.username} from ${Utils.clientIp(ctx)}`);

	ctx.set("account", account);

	return Utils.ok(ctx, {
		token,
		username: account.username,
		email: account.email,
		admin: Number(account.admin) === 1,
		expires_in: Auth.ttlSeconds(),
	});
});

Server.app.post("/api/v1/auth/logout", Auth.required(), async (ctx) => {
	const token = ctx.get("sessionToken");
	if (token) await Auth.destroySession(token);

	return Utils.ok(ctx);
});

Server.app.get("/api/v1/auth/me", Auth.required(), async (ctx) => {
	const account = Auth.account(ctx);

	const [projects] = (await Database`
		SELECT COUNT(*) AS count FROM project_members pm
		JOIN projects p ON p.uuid = pm.project_id
		WHERE pm.account_username = ${account.username} AND pm.status = 'active' AND p.status != 'deleted'
	`) as { count: number }[];

	return Utils.ok(ctx, {
		username: account.username,
		email: account.email,
		status: account.status,
		admin: Number(account.admin) === 1,
		two_factor_enabled: account.two_factor_secret !== null,
		authenticator_enabled: TwoFactor.hasAuthenticator(account.two_factor_secret),
		security_keys: (await TwoFactor.securityKeys(account.username)).map(TwoFactor.presentSecurityKey),
		pending_terms: await pendingTerms(account.username),
		upcoming_terms: await upcomingTerms(account.username),
		projects: projects.count,
		created: account.created,
		accessed: account.accessed,
	});
});

Server.app.get("/api/v1/auth/export", Auth.required(), exportLimit, async (ctx) => {
	const account = Auth.account(ctx);
	await Audit.record(ctx, { action: "account.data_exported", entityType: "account", entityId: account.username });
	return exportResponse(await exportAccount(account), account.username);
});

Server.app.post("/api/v1/auth/two-factor/setup", Auth.required(), async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	const account = Auth.account(ctx);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	if (TwoFactor.hasAuthenticator(account.two_factor_secret)) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_ALREADY_ENABLED);

	const token = ctx.get("sessionToken")!;
	const secret = TwoFactor.generateSecret();
	const stored = await Cache.setString(await setupCacheKey(token), Vault.encrypt(secret), TWO_FACTOR_SETUP_TTL, TWO_FACTOR_SETUP_TTL);
	if (!stored) return Utils.fail(ctx, ErrorCode.REDIS_CONNECTION_ERROR);

	return Utils.ok(ctx, {
		secret,
		...TwoFactor.provisioning(secret, account.email || account.username),
		expires_in: TWO_FACTOR_SETUP_TTL,
	});
});

Server.app.post("/api/v1/auth/two-factor/enable", Auth.required(), credentialLimit, async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	let data: PasswordAndSecondFactorBody;
	try {
		data = await ctx.body<PasswordAndSecondFactorBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const account = Auth.account(ctx);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	if (TwoFactor.hasAuthenticator(account.two_factor_secret)) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_ALREADY_ENABLED);
	if (!Validate.password(data.password)) return Utils.fail(ctx, ErrorCode.INVALID_PASSWORD);
	if (!(await Bun.password.verify(data.password!, account.password))) return Utils.fail(ctx, ErrorCode.INCORRECT_PASSWORD);

	const token = ctx.get("sessionToken")!;
	const key = await setupCacheKey(token);
	const pending = await Cache.getString(key);
	if (pending === null) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_SETUP_EXPIRED);

	const secret = Vault.decrypt(pending);
	const setupVerification = await TwoFactor.verify(data.code, { version: 1, secret, recovery_hashes: [] }, false);
	if (!setupVerification.valid) return Utils.fail(ctx, ErrorCode.INVALID_TWO_FACTOR_CODE);

	let recovery_codes: string[] | null = null;
	let enabled;
	if (account.two_factor_secret === null) {
		const created = await TwoFactor.createConfig(secret);
		recovery_codes = created.recovery_codes;
		enabled = await Database`
			UPDATE accounts SET two_factor_secret = ${TwoFactor.encode(created.config)}, updated = ${Date.now()}
			WHERE username = ${account.username} AND two_factor_secret IS NULL
		`;
	} else {
		const current = TwoFactor.decode(account.two_factor_secret);
		enabled = await Database`
			UPDATE accounts SET two_factor_secret = ${TwoFactor.encode({ ...current, secret })}, updated = ${Date.now()}
			WHERE username = ${account.username} AND two_factor_secret = ${account.two_factor_secret}
		`;
	}
	if (enabled.count === 0) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_ALREADY_ENABLED);
	await Cache.deleteString(key);
	await Audit.record(ctx, { action: "account.two_factor_enabled", entityType: "account", entityId: account.username, newValue: { method: "authenticator" } });
	Logger.audit(`[AUTH] Authenticator app added: ${account.username}`);

	return Utils.ok(ctx, { recovery_codes });
});

Server.app.post("/api/v1/auth/two-factor/recovery-codes", Auth.required(), credentialLimit, async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	let data: SecondFactorBody;
	try {
		data = await ctx.body<SecondFactorBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const account = Auth.account(ctx);
	if (account.two_factor_secret === null) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_NOT_ENABLED);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	if (!(await verifySecondFactor(account, data, "confirm", false))) return Utils.fail(ctx, secondFactorError(data));

	const { config, recovery_codes } = await TwoFactor.createConfig(TwoFactor.decode(account.two_factor_secret).secret);
	const changed = await Database`
		UPDATE accounts SET two_factor_secret = ${TwoFactor.encode(config)}, updated = ${Date.now()}
		WHERE username = ${account.username} AND two_factor_secret = ${account.two_factor_secret}
	`;
	if (changed.count === 0) return Utils.fail(ctx, secondFactorError(data));

	await Audit.record(ctx, { action: "account.two_factor_recovery_codes_regenerated", entityType: "account", entityId: account.username });
	return Utils.ok(ctx, { recovery_codes });
});

Server.app.delete("/api/v1/auth/two-factor/authenticator", Auth.required(), credentialLimit, async (ctx) => {
	let data: PasswordAndSecondFactorBody;
	try {
		data = await ctx.body<PasswordAndSecondFactorBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const account = Auth.account(ctx);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	if (!TwoFactor.hasAuthenticator(account.two_factor_secret)) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_NOT_ENABLED);
	if (!Validate.password(data.password)) return Utils.fail(ctx, ErrorCode.INVALID_PASSWORD);
	if (!(await Bun.password.verify(data.password!, account.password))) return Utils.fail(ctx, ErrorCode.INCORRECT_PASSWORD);
	if (!(await verifySecondFactor(account, data, "confirm"))) return Utils.fail(ctx, secondFactorError(data));

	const keys = await TwoFactor.securityKeys(account.username);
	if (keys.length === 0) {
		await TwoFactor.reset(account.username);
	} else {
		const payload = await storedConfig(account.username);
		if (payload !== null) {
			await Database`
				UPDATE accounts SET two_factor_secret = ${TwoFactor.encode({ ...TwoFactor.decode(payload), secret: null })}, updated = ${Date.now()}
				WHERE username = ${account.username} AND two_factor_secret = ${payload}
			`;
		}
	}
	await Audit.record(ctx, { action: "account.two_factor_authenticator_removed", entityType: "account", entityId: account.username });
	Logger.audit(`[AUTH] Authenticator app removed: ${account.username}`);

	return Utils.ok(ctx, { two_factor_enabled: keys.length > 0 });
});

Server.app.post("/api/v1/auth/two-factor/security-keys/options", Auth.required(), async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	const account = Auth.account(ctx);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);

	const keys = await TwoFactor.securityKeys(account.username);
	if (keys.length >= MAX_SECURITY_KEYS) return Utils.fail(ctx, ErrorCode.SECURITY_KEY_LIMIT);

	const options = await WebAuthn.registrationOptions(account, keys);
	if (options === null) return Utils.fail(ctx, ErrorCode.REDIS_CONNECTION_ERROR);
	return Utils.ok(ctx, options);
});

Server.app.post("/api/v1/auth/two-factor/security-keys", Auth.required(), credentialLimit, async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	let data: SecurityKeyBody;
	try {
		data = await ctx.body<SecurityKeyBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const account = Auth.account(ctx);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	const name = typeof data.name === "string" ? data.name.trim() : "";
	if (name.length < 1 || name.length > 64) return Utils.fail(ctx, ErrorCode.INVALID_SECURITY_KEY_NAME);
	if (!Validate.password(data.password)) return Utils.fail(ctx, ErrorCode.INVALID_PASSWORD);
	if (!(await Bun.password.verify(data.password!, account.password))) return Utils.fail(ctx, ErrorCode.INCORRECT_PASSWORD);
	if ((await TwoFactor.securityKeys(account.username)).length >= MAX_SECURITY_KEYS) return Utils.fail(ctx, ErrorCode.SECURITY_KEY_LIMIT);

	const verified = await WebAuthn.verifyRegistration(data.credential, account.username);
	if (verified === null) return Utils.fail(ctx, ErrorCode.INVALID_SECURITY_KEY);

	const uuid = crypto.randomUUID();
	const timestamp = Date.now();
	const fresh = account.two_factor_secret === null ? await TwoFactor.createConfig(null) : null;
	let recovery_codes: string[] | null = null;
	try {
		await Database.begin(async (tx) => {
			await tx`
				INSERT INTO account_security_keys(uuid, account_username, credential_hash, credential_id, public_key, algorithm, sign_count, transports, name, created)
				VALUES(${uuid}, ${account.username}, ${await Utils.generateHash(verified.credentialId, "sha256")}, ${verified.credentialId}, ${verified.publicKey},
					${verified.algorithm}, ${verified.signCount}, ${verified.transports.join(",") || null}, ${name}, ${timestamp})
			`;
			if (fresh === null) return;
			const enabled = await tx`
				UPDATE accounts SET two_factor_secret = ${TwoFactor.encode(fresh.config)}, updated = ${timestamp}
				WHERE username = ${account.username} AND two_factor_secret IS NULL
			`;
			if (enabled.count > 0) recovery_codes = fresh.recovery_codes;
		});
	} catch (err) {
		Logger.warn(`[AUTH] Security key rejected for "${account.username}": ${err}`);
		return Utils.fail(ctx, ErrorCode.INVALID_SECURITY_KEY);
	}

	await Audit.record(ctx, { action: "account.security_key_added", entityType: "account", entityId: account.username, newValue: { uuid, name } });
	Logger.audit(`[AUTH] Security key added: ${account.username}`);

	const key = (await TwoFactor.securityKeys(account.username)).find((candidate) => candidate.uuid === uuid)!;
	return Utils.ok(ctx, { key: TwoFactor.presentSecurityKey(key), recovery_codes }, 201);
});

Server.app.post("/api/v1/auth/two-factor/security-keys/challenge", Auth.required(), async (ctx) => {
	ctx.header("Cache-Control", "no-store");
	const account = Auth.account(ctx);
	const keys = await TwoFactor.securityKeys(account.username);
	if (keys.length === 0) return Utils.fail(ctx, ErrorCode.SECURITY_KEY_NOT_FOUND);

	const options = await WebAuthn.assertionOptions("confirm", account.username, keys);
	if (options === null) return Utils.fail(ctx, ErrorCode.REDIS_CONNECTION_ERROR);
	return Utils.ok(ctx, options);
});

Server.app.delete("/api/v1/auth/two-factor/security-keys/:key", Auth.required(), credentialLimit, async (ctx) => {
	let data: PasswordAndSecondFactorBody;
	try {
		data = await ctx.body<PasswordAndSecondFactorBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const account = Auth.account(ctx);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);
	const keys = await TwoFactor.securityKeys(account.username);
	const target = keys.find((key) => key.uuid === ctx.params["key"]);
	if (!target) return Utils.fail(ctx, ErrorCode.SECURITY_KEY_NOT_FOUND);
	if (!Validate.password(data.password)) return Utils.fail(ctx, ErrorCode.INVALID_PASSWORD);
	if (!(await Bun.password.verify(data.password!, account.password))) return Utils.fail(ctx, ErrorCode.INCORRECT_PASSWORD);
	if (!(await verifySecondFactor(account, data, "confirm"))) return Utils.fail(ctx, secondFactorError(data));

	await Database`DELETE FROM account_security_keys WHERE uuid = ${target.uuid} AND account_username = ${account.username}`;
	if (keys.length === 1) {
		const payload = await storedConfig(account.username);
		if (payload !== null && !TwoFactor.hasAuthenticator(payload)) {
			await Database`UPDATE accounts SET two_factor_secret = NULL, updated = ${Date.now()} WHERE username = ${account.username} AND two_factor_secret = ${payload}`;
		}
	}
	await Audit.record(ctx, {
		action: "account.security_key_removed",
		entityType: "account",
		entityId: account.username,
		oldValue: { uuid: target.uuid, name: target.name },
	});
	Logger.audit(`[AUTH] Security key removed: ${account.username}`);

	return Utils.ok(ctx, { two_factor_enabled: (await storedConfig(account.username)) !== null });
});

Server.app.delete("/api/v1/auth/two-factor", Auth.required(), credentialLimit, async (ctx) => {
	let data: PasswordAndSecondFactorBody;
	try {
		data = await ctx.body<PasswordAndSecondFactorBody>();
	} catch {
		return Utils.fail(ctx, ErrorCode.REQUIRED_DATA_MISSING);
	}

	const account = Auth.account(ctx);
	if (account.two_factor_secret === null) return Utils.fail(ctx, ErrorCode.TWO_FACTOR_NOT_ENABLED);
	if (!Validate.password(data.password)) return Utils.fail(ctx, ErrorCode.INVALID_PASSWORD);
	if (!Vault.isConfigured()) return Utils.fail(ctx, ErrorCode.MASTER_KEY_NOT_CONFIGURED);

	const validPassword = await Bun.password.verify(data.password!, account.password);
	if (!validPassword) return Utils.fail(ctx, ErrorCode.INCORRECT_PASSWORD);
	if (!(await verifySecondFactor(account, data, "confirm"))) return Utils.fail(ctx, secondFactorError(data));

	await TwoFactor.reset(account.username);
	await Audit.record(ctx, { action: "account.two_factor_disabled", entityType: "account", entityId: account.username });
	Logger.audit(`[AUTH] Two-factor authentication disabled: ${account.username}`);

	return Utils.ok(ctx);
});
