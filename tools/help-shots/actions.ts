import { generateTOTP } from "@rabbit-company/totp";
import type { Session } from "./demo";
import type { Studio } from "./studio";

export const ACCOUNT_MENU = ".menu-trigger";

export async function currentCode(session: Session): Promise<string> {
	if (!session.totpSecret) throw new Error("This account has no authenticator app yet");
	const remaining = 30 - ((Date.now() / 1000) % 30);
	if (remaining < 4) await Bun.sleep((remaining + 0.5) * 1000);
	return await generateTOTP(session.totpSecret);
}

export async function fillSignIn(studio: Studio, session: Session) {
	const { browser } = studio;
	await studio.open("/login");
	await browser.fill(`field:${studio.t("login.email")}`, session.demo.owner.email);
	await browser.fill(`field:${studio.t("login.password")}`, session.demo.owner.password);
	await browser.blur();
}

export async function signIn(studio: Studio, session: Session) {
	const { browser } = studio;
	await browser.goto(`${studio.base}/login`);
	if (await browser.eval<boolean>(`localStorage.getItem("rabbitpay.token") !== null && location.pathname !== "/login"`)) return;
	await fillSignIn(studio, session);
	await browser.click(".auth-card button[type=submit]", 1200);
	if (await browser.exists(`field:${studio.t("login.two_factor_code")}`)) {
		await browser.fill(`field:${studio.t("login.two_factor_code")}`, await currentCode(session));
		await browser.click(".auth-card button[type=submit]", 1200);
	}
	await browser.waitFor(".app-header");
	await studio.clearToasts();
}

export async function signOut(studio: Studio) {
	await studio.browser.click(ACCOUNT_MENU);
	await studio.browser.click(`menu:${studio.t("app.sign_out")}`, 1000);
}

export function projectPath(session: Session, suffix = ""): string {
	if (!session.project) throw new Error("The project has not been created yet");
	return `/projects/${session.project}${suffix}`;
}

export async function api<T = any>(studio: Studio, method: string, path: string, body?: unknown): Promise<T> {
	const result = await studio.browser.eval<{ error: number; info: string; data: T }>(
		`fetch("/api/v1" + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { Authorization: "Bearer " + localStorage.getItem("rabbitpay.token"), "Content-Type": "application/json" }, body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))} }).then((response) => response.json())`
	);
	if (result.error !== 0) throw new Error(`${method} ${path} failed: ${result.info}`);
	return result.data;
}

export function projectApi<T = any>(studio: Studio, session: Session, method: string, path: string, body?: unknown): Promise<T> {
	return api<T>(studio, method, `/projects/${session.project}${path}`, body);
}

export function daysFromNow(days: number): number {
	return Date.now() + days * 24 * 60 * 60 * 1000;
}
