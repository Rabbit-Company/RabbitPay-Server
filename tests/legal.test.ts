import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { prepareTest } from "./environment";

const databasePath = `${import.meta.dir}/.legal.sqlite`;
await prepareTest(`sqlite://${databasePath}`);

const { Server } = await import("../server/server");
const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { Settings } = await import("../server/settings");
const { setTransport } = await import("../server/email/mailer");

await Server.configure();

interface ApiResponse {
	status: number;
	error: number;
	info: string;
	data?: any;
}

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<ApiResponse> {
	const headers: Record<string, string> = { "User-Agent": "legal-test" };
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1${path}`, {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		})
	);
	return { status: response.status, ...((await response.json()) as Omit<ApiResponse, "status">) };
}

const password = (value: string) => new Bun.CryptoHasher("blake2b512").update(value).digest("hex");
let adminToken = "";
let termsVersion = 0;
let privacyVersion = 0;

async function register(username: string, extra: Record<string, unknown> = {}) {
	return await call("POST", "/api/v1/auth/register", {
		body: { username, email: `${username}@example.com`, password: password("legal-pass"), ...extra },
	});
}

beforeAll(async () => {
	await Cache.initialize();
	await initializeDatabase();
	await register("legal-admin");
	adminToken = (await call("POST", "/api/v1/auth/login", { body: { username: "legal-admin", password: password("legal-pass") } })).data.token;
});

afterAll(async () => {
	await Database.close();
	for (const suffix of ["", "-shm", "-wal"]) {
		try {
			unlinkSync(`${databasePath}${suffix}`);
		} catch {
			void 0;
		}
	}
});

describe("operator details", () => {
	test("are hidden until an operator name is set", async () => {
		const legal = await call("GET", "/api/v1/legal");
		expect(legal.error).toBe(0);
		expect(legal.data.operator).toBeNull();
		expect(legal.data.terms).toBeNull();
		expect(legal.data.privacy).toBeNull();
	});

	test("are published from the admin settings", async () => {
		const saved = await call("PATCH", "/api/v1/admin/settings", {
			token: adminToken,
			body: {
				values: {
					"legal.operator_name": "SIMONCA ZAJC S.P.",
					"legal.address": "Brilejeva ulica 9, 1000 Ljubljana, Slovenia",
					"legal.register": "Slovenian Business Register (AJPES)",
					"legal.registration_number": "1083481000",
					"legal.tax_number": "85465313",
					"legal.vat_number": "SI00000000",
					"legal.contact_email": "info@rabbitpay.net",
					"legal.business_only": true,
					"server.proxy": "cloudflare",
				},
			},
		});
		expect(saved.error).toBe(0);

		const legal = await call("GET", "/api/v1/legal");
		expect(legal.data.operator.name).toBe("SIMONCA ZAJC S.P.");
		expect(legal.data.operator.tax_number).toBe("85465313");
		expect(legal.data.operator.vat_status).toBe("not_registered");
		expect(legal.data.operator.vat_number).toBeNull();
		expect(legal.data.business_only).toBe(true);
	});
});

describe("templates", () => {
	test("fill every placeholder with the operator and server settings", async () => {
		for (const kind of ["terms", "privacy"]) {
			for (const language of ["en", "sl"]) {
				const template = await call("GET", `/api/v1/admin/legal/${kind}/template?language=${language}`, { token: adminToken });
				expect(template.error).toBe(0);
				expect(template.data.content).not.toContain("{{");
				expect(template.data.content).toContain("SIMONCA ZAJC S.P.");
				expect(template.data.content).toContain("info@rabbitpay.net");
				expect(template.data.content).toContain("Cloudflare, Inc.");
			}
		}
	});

	test("state the small business VAT exemption in the terms", async () => {
		const sl = await call("GET", "/api/v1/admin/legal/terms/template?language=sl", { token: adminToken });
		expect(sl.data.content).toContain("1. odstavka 94. člena ZDDV-1");
	});

	test("state the free emails and how long email content is kept", async () => {
		const template = async (kind: string, language: string) =>
			(await call("GET", `/api/v1/admin/legal/${kind}/template?language=${language}`, { token: adminToken })).data.content as string;
		const allowance = Settings.licensing.free_emails;
		const retention = Settings.email.body_retention_days;

		expect(await template("terms", "en")).toContain(`document storage. It also includes ${allowance} emails per month to the Customer's own customers`);
		expect(await template("terms", "sl")).toContain(`največ ${allowance} na mesec. Brezplačno kvoto`);
		expect(await template("privacy", "en")).toContain(`**Content of emails sent from the Service:** ${retention} days, after which`);
		expect(await template("privacy", "sl")).toContain(`poslanih iz storitve:** ${retention} dni, nato`);

		Settings.licensing.enabled = false;
		Settings.email.body_retention_days = 0;
		try {
			expect(await template("terms", "en")).toContain("GB of document storage. We may change");
			expect(await template("privacy", "en")).toContain("**Content of emails sent from the Service:** while the project exists.");
		} finally {
			Settings.licensing.enabled = true;
			Settings.email.body_retention_days = retention;
		}
	});

	test("rejects unknown documents and languages", async () => {
		expect((await call("GET", "/api/v1/admin/legal/cookies/template?language=en", { token: adminToken })).error).toBe(1237);
		expect((await call("GET", "/api/v1/admin/legal/terms/template?language=de", { token: adminToken })).error).toBe(1237);
	});
});

describe("publishing", () => {
	test("needs text in at least one language", async () => {
		const empty = await call("POST", "/api/v1/admin/legal/terms", { token: adminToken, body: { content_en: " ", content_sl: null } });
		expect(empty.error).toBe(1236);
		const tooLong = await call("POST", "/api/v1/admin/legal/terms", { token: adminToken, body: { content_en: "x".repeat(100_001) } });
		expect(tooLong.error).toBe(1236);
	});

	test("is limited to administrators", async () => {
		const user = await call("POST", "/api/v1/auth/register", {
			body: { username: "legal-early", email: "legal-early@example.com", password: password("legal-pass") },
		});
		expect(user.error).toBe(0);
		const token = (await call("POST", "/api/v1/auth/login", { body: { username: "legal-early", password: password("legal-pass") } })).data.token;
		expect((await call("POST", "/api/v1/admin/legal/terms", { token, body: { content_en: "# Terms" } })).error).toBe(1098);
	});

	test("creates numbered versions that are public", async () => {
		const terms = await call("POST", "/api/v1/admin/legal/terms", { token: adminToken, body: { content_en: "# Terms", content_sl: "# Pogoji" } });
		expect(terms.status).toBe(201);
		expect(terms.data.version).toBe(1);
		termsVersion = terms.data.version;

		const privacy = await call("POST", "/api/v1/admin/legal/privacy", { token: adminToken, body: { content_sl: "# Zasebnost" } });
		expect(privacy.data.version).toBe(1);
		expect(privacy.data.content_en).toBeNull();
		privacyVersion = privacy.data.version;

		const legal = await call("GET", "/api/v1/legal");
		expect(legal.data.terms.content_sl).toBe("# Pogoji");
		expect(legal.data.privacy.version).toBe(1);
	});
});

describe("registration", () => {
	test("requires accepting the current terms", async () => {
		expect((await register("legal-refused")).error).toBe(1234);
		expect((await register("legal-refused", { accept_terms: "yes", legal_versions: { terms: [termsVersion], privacy: [privacyVersion] } })).error).toBe(1234);
		expect((await register("legal-refused", { accept_terms: true, legal_versions: { terms: [termsVersion + 1], privacy: [privacyVersion] } })).error).toBe(
			1235
		);
		expect((await register("legal-refused", { accept_terms: true, legal_versions: { terms: [termsVersion] } })).error).toBe(1235);

		const [account] = (await Database`SELECT username FROM accounts WHERE username = ${"legal-refused"}`) as { username: string }[];
		expect(account).toBeUndefined();
	});

	test("records the accepted versions with the client details", async () => {
		const created = await register("legal-user", { accept_terms: true, legal_versions: { terms: [termsVersion], privacy: [privacyVersion] } });
		expect(created.error).toBe(0);

		const rows = (await Database`
			SELECT kind, version, ip_address, user_agent FROM legal_acceptances WHERE account_username = ${"legal-user"} ORDER BY kind
		`) as { kind: string; version: number; user_agent: string }[];
		expect(rows.map((row) => [row.kind, Number(row.version)])).toEqual([
			["privacy", 1],
			["terms", 1],
		]);
		expect(rows[0].user_agent).toBe("legal-test");

		const token = (await call("POST", "/api/v1/auth/login", { body: { username: "legal-user", password: password("legal-pass") } })).data.token;
		expect((await call("GET", "/api/v1/auth/me", { token })).data.pending_terms).toBeNull();
	});
});

describe("updated terms", () => {
	test("ask existing accounts to accept them", async () => {
		expect((await call("GET", "/api/v1/auth/me", { token: adminToken })).data.pending_terms).toBe(1);

		const outdated = await call("POST", "/api/v1/auth/legal/accept", {
			token: adminToken,
			body: { legal_versions: { terms: [0], privacy: [privacyVersion] } },
		});
		expect(outdated.error).toBe(1235);

		const accepted = await call("POST", "/api/v1/auth/legal/accept", {
			token: adminToken,
			body: { legal_versions: { terms: [termsVersion], privacy: [privacyVersion] } },
		});
		expect(accepted.error).toBe(0);
		expect((await call("GET", "/api/v1/auth/me", { token: adminToken })).data.pending_terms).toBeNull();
	});

	test("a new version needs acceptance again and keeps the history", async () => {
		const next = await call("POST", "/api/v1/admin/legal/terms", { token: adminToken, body: { content_en: "# Terms v2" } });
		expect(next.data.version).toBe(2);
		expect((await call("GET", "/api/v1/auth/me", { token: adminToken })).data.pending_terms).toBe(2);

		const overview = await call("GET", "/api/v1/admin/legal", { token: adminToken });
		expect(overview.data.documents.terms.latest.version).toBe(2);
		expect(overview.data.documents.terms.versions.map((row: { version: number; accepted: number }) => [row.version, row.accepted])).toEqual([
			[2, 0],
			[1, 2],
		]);
	});
});

describe("scheduled versions", () => {
	const DAY = 24 * 60 * 60 * 1000;

	test("reject effective dates in the past, too far ahead or before the previous version", async () => {
		const publish = (effective: unknown) => call("POST", "/api/v1/admin/legal/terms", { token: adminToken, body: { content_en: "# Later", effective } });
		expect((await publish(Date.now() - DAY)).error).toBe(1238);
		expect((await publish(Date.now() + 400 * DAY)).error).toBe(1238);
		expect((await publish("tomorrow")).error).toBe(1238);
	});

	test("keep the current version in force until the new one takes effect", async () => {
		await call("POST", "/api/v1/auth/legal/accept", { token: adminToken, body: { legal_versions: { terms: [2], privacy: [privacyVersion] } } });
		const effective = Date.now() + 30 * DAY;
		const scheduled = await call("POST", "/api/v1/admin/legal/terms", {
			token: adminToken,
			body: { content_en: "# Terms v3", content_sl: "# Pogoji v3", effective },
		});
		expect(scheduled.error).toBe(0);
		expect(scheduled.data.version).toBe(3);
		expect(scheduled.data.effective).toBe(effective);
		expect(scheduled.data.notified).toBeNull();

		const legal = await call("GET", "/api/v1/legal");
		expect(legal.data.terms.version).toBe(2);
		expect(legal.data.upcoming_terms.version).toBe(3);
		expect(legal.data.required_versions).toEqual({ terms: [2, 3], privacy: [1] });

		const me = await call("GET", "/api/v1/auth/me", { token: adminToken });
		expect(me.data.pending_terms).toBeNull();
		expect(me.data.upcoming_terms).toEqual({ version: 3, effective });

		const earlier = await call("POST", "/api/v1/admin/legal/terms", { token: adminToken, body: { content_en: "# Sooner", effective: Date.now() + DAY } });
		expect(earlier.error).toBe(1238);
	});

	test("new accounts accept both the current and the upcoming version", async () => {
		expect((await register("legal-later", { accept_terms: true, legal_versions: { terms: [2], privacy: [1] } })).error).toBe(1235);
		expect((await register("legal-later", { accept_terms: true, legal_versions: { terms: [2, 3], privacy: [1] } })).error).toBe(0);
		const token = (await call("POST", "/api/v1/auth/login", { body: { username: "legal-later", password: password("legal-pass") } })).data.token;
		const me = await call("GET", "/api/v1/auth/me", { token });
		expect(me.data.upcoming_terms).toBeNull();
	});

	test("existing accounts can accept the upcoming version early", async () => {
		const accepted = await call("POST", "/api/v1/auth/legal/accept", {
			token: adminToken,
			body: { legal_versions: { terms: [2, 3], privacy: [1] } },
		});
		expect(accepted.error).toBe(0);
		expect((await call("GET", "/api/v1/auth/me", { token: adminToken })).data.upcoming_terms).toBeNull();
	});

	test("email every active account about a change when asked", async () => {
		const sent: { to: string; subject: string; text: string; html: string; replyTo?: string }[] = [];
		setTransport({
			sendMail: async (message: { to: string; subject: string; text: string; html: string; replyTo?: string }) => (sent.push(message), { messageId: "x" }),
		} as never);
		Settings.email.enabled = true;
		try {
			const published = await call("POST", "/api/v1/admin/legal/privacy", {
				token: adminToken,
				body: { content_en: "# Privacy v2", effective: Date.now() + 30 * DAY, notify: true },
			});
			expect(published.data.notified).toBe(4);
			await Bun.sleep(50);
			expect(sent.map((message) => message.to).sort()).toEqual([
				"legal-admin@example.com",
				"legal-early@example.com",
				"legal-later@example.com",
				"legal-user@example.com",
			]);
			expect(sent[0].subject).toBe("Spremembe Politike zasebnosti | Changes to the Privacy Policy");
			expect(sent[0].text).toContain("/privacy?upcoming=1");
			expect(sent[0].replyTo).toBe("info@rabbitpay.net");
			expect(sent[0].text).toContain("Posodabljamo Politiko zasebnosti");
			expect(sent[0].text).toContain("We are updating our Privacy Policy");
			expect(sent[0].text.indexOf("Posodabljamo")).toBeLessThan(sent[0].text.indexOf("We are updating"));
			expect(sent[0].text).toContain("Poslal SIMONCA ZAJC S.P.\n");
			expect(sent[0].html).toContain('<html lang="sl">');
			expect(sent[0].html).toContain('<div lang="en">');
			expect(sent[0].html).toContain("Ukrepanje ni potrebno");
			expect(sent[0].html).toContain("No action needed");
			expect(sent[0].html).toContain("Različica 2");
			expect(sent[0].html).toContain("Version 2");
		} finally {
			Settings.email.enabled = false;
			setTransport(null);
		}
	});
});
