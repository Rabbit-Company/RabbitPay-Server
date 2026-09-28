import { generateTOTPSecret, verifyTOTP } from "@rabbit-company/totp";
import { toSVG } from "@rabbit-company/qrcode";
import { totp as totpPayload } from "@rabbit-company/qrcode/payload";
import Vault from "./crypto/vault";
import Database from "./database/database";
import Utils from "./utils";
import type { SecurityKeyRow } from "./database/models";

const RECOVERY_CODE_COUNT = 10;
export const MAX_SECURITY_KEYS = 10;

export interface TwoFactorConfig {
	version: 1;
	secret: string | null;
	recovery_hashes: string[];
}

export interface TwoFactorVerification {
	valid: boolean;
	recoveryConfig?: TwoFactorConfig;
}

function normalizedRecoveryCode(value: string): string {
	return value.trim().toUpperCase().replace(/[\s-]/g, "");
}

async function recoveryHash(value: string): Promise<string> {
	return await Utils.generateHash(normalizedRecoveryCode(value), "sha256");
}

export default class TwoFactor {
	static generateSecret(): string {
		return generateTOTPSecret(32);
	}

	static provisioning(secret: string, account: string): { uri: string; qr_svg: string } {
		const uri = totpPayload({ secret, account, issuer: "RabbitPay" });
		return { uri, qr_svg: toSVG(uri, { scale: 6 }) };
	}

	static encode(config: TwoFactorConfig): string {
		return Vault.encrypt(JSON.stringify(config));
	}

	static decode(payload: string): TwoFactorConfig {
		const parsed = JSON.parse(Vault.decrypt(payload)) as Partial<TwoFactorConfig>;
		if (parsed.version !== 1 || (typeof parsed.secret !== "string" && parsed.secret !== null) || !Array.isArray(parsed.recovery_hashes)) {
			throw new Error("Invalid two-factor configuration");
		}
		if (!parsed.recovery_hashes.every((hash) => typeof hash === "string")) throw new Error("Invalid two-factor recovery configuration");
		return parsed as TwoFactorConfig;
	}

	static hasAuthenticator(payload: string | null): boolean {
		if (payload === null) return false;
		try {
			return TwoFactor.decode(payload).secret !== null;
		} catch {
			return false;
		}
	}

	static async securityKeys(username: string): Promise<SecurityKeyRow[]> {
		return (await Database`
			SELECT * FROM account_security_keys WHERE account_username = ${username} ORDER BY created ASC, uuid ASC
		`) as SecurityKeyRow[];
	}

	static presentSecurityKey(key: SecurityKeyRow) {
		return { uuid: key.uuid, name: key.name, created: key.created, last_used: key.last_used };
	}

	static async reset(username: string): Promise<void> {
		await Database.begin(async (tx) => {
			await tx`DELETE FROM account_security_keys WHERE account_username = ${username}`;
			await tx`UPDATE accounts SET two_factor_secret = NULL, updated = ${Date.now()} WHERE username = ${username}`;
		});
	}

	static async createConfig(secret: string | null): Promise<{ config: TwoFactorConfig; recovery_codes: string[] }> {
		const recovery_codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
			const value = generateTOTPSecret(10);
			return `${value.slice(0, 5)}-${value.slice(5)}`;
		});
		const recovery_hashes = await Promise.all(recovery_codes.map(recoveryHash));
		return { config: { version: 1, secret, recovery_hashes }, recovery_codes };
	}

	static async verify(value: unknown, config: TwoFactorConfig, allowRecovery = true): Promise<TwoFactorVerification> {
		if (typeof value !== "string") return { valid: false };
		const token = value.trim();
		if (/^\d{6}$/.test(token)) return { valid: config.secret !== null && (await verifyTOTP(token, config.secret, { window: 1 })) };
		if (!allowRecovery || !/^[A-Z2-7]{5}-?[A-Z2-7]{5}$/i.test(token)) return { valid: false };

		const hash = await recoveryHash(token);
		const index = config.recovery_hashes.indexOf(hash);
		if (index === -1) return { valid: false };

		return {
			valid: true,
			recoveryConfig: { ...config, recovery_hashes: config.recovery_hashes.filter((_, position) => position !== index) },
		};
	}
}
