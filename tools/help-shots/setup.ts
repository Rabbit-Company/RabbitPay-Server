import { Database } from "bun:sqlite";
import Blake2b from "@rabbit-company/blake2b";
import { fold } from "../../server/registry/furs";
import { ADMINISTRATOR, DEMOS, type Company } from "./demo";
import { rememberRegistry, type ScratchServer } from "./scratch-server";

async function call<T>(base: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
	const response = await fetch(`${base}/api/v1${path}`, {
		method,
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const payload = (await response.json()) as { error: number; info: string; data: T };
	if (payload.error !== 0) throw new Error(`${method} ${path} failed: ${payload.info}`);
	return payload.data;
}

export function taxNumberAfter(start: number, taken: (candidate: string) => boolean): string {
	for (let body = start; ; body++) {
		const digits = String(body).padStart(7, "0");
		const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * (8 - index), 0);
		const check = 11 - (sum % 11);
		if (check === 11) continue;
		const candidate = `${digits}${check === 10 ? 0 : check}`;
		if (!taken(candidate)) return candidate;
	}
}

async function inventCompanies(server: ScratchServer) {
	const registry = new Database(server.database);
	registry.run("PRAGMA busy_timeout = 10000");
	const count = () => (registry.query("SELECT COUNT(*) AS count FROM company_registry").get() as { count: number }).count;
	for (let attempt = 0; attempt < 180 && count() === 0; attempt++) await Bun.sleep(500);
	if (count() < 1000) throw new Error("The FURS company register did not load, so company lookups would come back empty. Try again in a few minutes.");
	rememberRegistry(registry);

	const taken = (candidate: string) => registry.query("SELECT 1 FROM company_registry WHERE tax_number = ?").get(candidate) !== null;
	const invented: Company[] = Object.values(DEMOS)
		.map((demo) => demo.company)
		.filter((company) => company.country === "SI");
	for (const [index, company] of invented.entries()) {
		company.taxNumber = taxNumberAfter(58_140_000 / 10 + index * 7_919, taken);
		company.vatNumber = `SI${company.taxNumber}`;
		registry
			.query(
				`INSERT INTO company_registry(tax_number, registration_number, vat_registered, kind, name, street, postal_code, city, country, activity, search, updated)
				VALUES(?, ?, 1, 'company', ?, ?, ?, ?, 'SI', ?, ?, ?)`
			)
			.run(
				company.taxNumber,
				company.registrationNumber,
				company.legalName,
				company.address,
				company.postalCode,
				company.city,
				"62.010",
				fold(company.legalName),
				Date.now()
			);
	}
	registry.close();
}

export async function prepareServer(server: ScratchServer) {
	const { base } = server;
	await inventCompanies(server);
	const password = Blake2b.hash(ADMINISTRATOR.password);
	await call(base, "POST", "/auth/register", { email: ADMINISTRATOR.email, password });
	const { token } = await call<{ token: string }>(base, "POST", "/auth/login", { email: ADMINISTRATOR.email, password });

	for (const kind of ["terms", "privacy"]) {
		const [english, slovenian] = await Promise.all(
			["en", "sl"].map((language) => call<{ content: string }>(base, "GET", `/admin/legal/${kind}/template?language=${language}`, undefined, token))
		);
		await call(base, "POST", `/admin/legal/${kind}`, { content_en: english.content, content_sl: slovenian.content }, token);
	}
}
