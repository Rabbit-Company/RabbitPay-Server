import { ProjectRole } from "./roles";
import { isCountryCode } from "./countries";

export default class Validate {
	static username(username: string | null | undefined): boolean {
		if (typeof username !== "string") return false;
		return /^([a-z][a-z0-9\-]{3,29})$/.test(username);
	}

	static email(email: string | null | undefined): boolean {
		if (typeof email !== "string" || email.length > 254) return false;
		return /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email);
	}

	static project(project: string | null | undefined): boolean {
		if (typeof project !== "string") return false;
		return /^([a-z][a-z0-9\-]{3,29})$/.test(project);
	}

	static password(password: string | null | undefined): boolean {
		if (typeof password !== "string") return false;
		return /^([a-z0-9]{128})$/.test(password);
	}

	static uuid(uuid: string | null | undefined): boolean {
		if (typeof uuid !== "string") return false;
		return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
	}

	static token(token: string | null | undefined): boolean {
		if (typeof token !== "string") return false;
		if (token.length !== 128) return false;
		return /^[A-Za-z0-9]{128}$/.test(token);
	}

	static role(role: string | null | undefined): role is ProjectRole {
		if (typeof role !== "string") return false;
		return (Object.values(ProjectRole) as string[]).includes(role);
	}

	static webhookUrl(url: string | null | undefined): boolean {
		if (typeof url !== "string" || url.length > 2048) return false;
		try {
			const parsed = new URL(url);
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	}

	static currency(currency: string | null | undefined): boolean {
		if (typeof currency !== "string") return false;
		return /^[A-Z]{3}$/.test(currency);
	}

	static country(country: string | null | undefined): boolean {
		return isCountryCode(country);
	}

	static minorUnitAmount(amount: unknown): amount is number {
		return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0;
	}

	static quantity(quantity: unknown): quantity is number {
		return typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0;
	}

	static taxRate(rate: unknown): rate is number {
		return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 100;
	}

	static shortText(text: unknown, maxLength = 255): text is string {
		return typeof text === "string" && text.trim().length > 0 && text.length <= maxLength;
	}

	static optionalText(text: unknown, maxLength = 255): boolean {
		if (text === null || text === undefined) return true;
		return typeof text === "string" && text.length <= maxLength;
	}
}
