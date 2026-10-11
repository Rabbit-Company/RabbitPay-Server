import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Auth } = await import("../server/auth");
const { announce } = await import("../server/notifications/announce");
const { isPushEndpoint, pushKeys, setPushTransport, PUSH_DEVICE_IDLE_MS } = await import("../server/notifications/push");
const { encryptPush, fromBase64Url, toBase64Url, vapidHeader } = await import("../server/notifications/push-crypto");
const { fillNotice, readableParams } = await import("../server/notifications/format");

interface Result {
	status: number;
	error: number;
	data: any;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await Server.app.handle(
		new Request(`http://127.0.0.1/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
	);
	return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
}

interface Device {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	privateKey: CryptoKey;
}

async function device(name: string): Promise<Device> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	return {
		endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${name}`,
		keys: {
			p256dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
			auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
		},
		privateKey: pair.privateKey,
	};
}

const encoder = new TextEncoder();

async function expand(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
	const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function decrypt(receiver: Device, body: Uint8Array<ArrayBuffer>): Promise<string> {
	const salt = body.slice(0, 16);
	const senderPublic = body.slice(21, 21 + body[20]);
	const sealed = body.slice(21 + body[20]);
	const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, receiver.privateKey, 256));
	const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...fromBase64Url(receiver.keys.p256dh), ...senderPublic]);
	const material = await expand(shared, fromBase64Url(receiver.keys.auth), info, 32);
	const contentKey = await expand(material, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await expand(material, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
	expect(plain[plain.length - 1]).toBe(2);
	return new TextDecoder().decode(plain.slice(0, -1));
}

const sent: { url: string; init: RequestInit }[] = [];
let answer = 201;
const tokens = { owner: "", anna: "" };
let project = "";
let laptop: Device;
let phone: Device;

async function account(username: string): Promise<string> {
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES(${username}, ${`${username}@team.test`}, 'unused', ${now}, ${now}, ${now})`;
	return (await Auth.createSession(username, ""))!;
}

async function settle() {
	await Bun.sleep(50);
}

const subscriptions = async (username: string) =>
	Number((await Database`SELECT COUNT(*) AS count FROM push_subscriptions WHERE account = ${username}`)[0].count);

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();
	setPushTransport(async (url, init) => {
		sent.push({ url, init });
		return new Response(null, { status: answer });
	});
	tokens.owner = await account("push-owner");
	tokens.anna = await account("push-anna");
	project = (await call("POST", "/projects", tokens.owner, { name: "push-co", currency: "EUR" })).data.uuid;
	const now = Date.now();
	await Database`
		INSERT INTO project_members(uuid, project_id, account_username, role, status, full_name, created, updated)
		VALUES(${crypto.randomUUID()}, ${project}, 'push-anna', 'employee', 'active', 'Anna Employee', ${now}, ${now})
	`;
	laptop = await device("laptop");
	phone = await device("phone");
});

afterAll(async () => {
	setPushTransport(null);
	await Database.close();
});

describe("push encryption", () => {
	test("can be read by the browser that holds the keys", async () => {
		const body = await encryptPush({ p256dh: laptop.keys.p256dh, auth: laptop.keys.auth }, '{"title":"Planning"}');
		expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
		expect(await decrypt(laptop, body)).toBe('{"title":"Planning"}');
		await expect(decrypt(phone, body)).rejects.toThrow();
	});

	test("signs who is sending for the push service", async () => {
		const keys = await pushKeys();
		expect(await pushKeys()).toEqual(keys);
		const header = await vapidHeader(keys, laptop.endpoint, "https://pay.example", 1_800_000_000_000);
		const [, token, key] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
		expect(key).toBe(keys.publicKey);
		const [head, claims, signature] = token.split(".");
		expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
			aud: "https://updates.push.services.mozilla.com",
			exp: 1_800_000_000 + 12 * 60 * 60,
			sub: "https://pay.example",
		});
		const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromBase64Url(signature), encoder.encode(`${head}.${claims}`));
		expect(valid).toBe(true);
	});

	test("the private key is stored sealed", async () => {
		const [row] = (await Database`SELECT public_key, private_key FROM push_keys WHERE slot = 1`) as { public_key: string; private_key: string }[];
		expect(row.public_key).toBe((await pushKeys()).publicKey);
		expect(row.private_key).not.toBe((await pushKeys()).privateKey);
	});
});

describe("push endpoints", () => {
	test("only known push services are accepted", () => {
		expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
		expect(isPushEndpoint("https://jmt17.google.com/fcm/send/abc:APA91b")).toBe(true);
		expect(isPushEndpoint("https://jmt18.google.com/fcm/send/abc")).toBe(true);
		expect(isPushEndpoint("https://script.google.com/macros/s/abc/exec")).toBe(false);
		expect(isPushEndpoint("https://google.com.attacker.test/fcm/send/abc")).toBe(false);
		expect(isPushEndpoint("https://jmt17.google.com/fcm/send/../../macros/s/abc")).toBe(false);
		expect(isPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
		expect(isPushEndpoint("https://db5p.notify.windows.com/w/?token=abc")).toBe(true);
		for (const refused of [
			"http://fcm.googleapis.com/fcm/send/abc",
			"https://127.0.0.1/hook",
			"https://fcm.googleapis.com.attacker.test/abc",
			"https://attacker.test/fcm.googleapis.com",
			"https://fcm.googleapis.com:8443/abc",
			"https://user@fcm.googleapis.com/abc",
			"not a url",
		]) {
			expect(isPushEndpoint(refused)).toBe(false);
		}
	});

	test("a device registers, moves between accounts and is removed", async () => {
		expect((await call("GET", "/auth/push", tokens.anna)).data.public_key).toBe((await pushKeys()).publicKey);
		expect((await call("GET", "/auth/push")).status).toBe(401);
		const refused = await call("PUT", "/auth/push", tokens.anna, { endpoint: "https://attacker.test/x", keys: laptop.keys, language: "sl" });
		expect(refused.error).toBe(1338);
		expect((await call("PUT", "/auth/push", tokens.anna, { endpoint: laptop.endpoint, keys: { p256dh: "short", auth: "x" } })).error).toBe(1338);

		expect((await call("PUT", "/auth/push", tokens.owner, { endpoint: laptop.endpoint, keys: laptop.keys, language: "en" })).status).toBe(200);
		expect((await call("PUT", "/auth/push", tokens.anna, { endpoint: laptop.endpoint, keys: laptop.keys, language: "sl" })).status).toBe(200);
		expect(await subscriptions("push-owner")).toBe(0);
		expect(await subscriptions("push-anna")).toBe(1);

		await call("DELETE", "/auth/push", tokens.owner, { endpoint: laptop.endpoint });
		expect(await subscriptions("push-anna")).toBe(1);
		await call("DELETE", "/auth/push", tokens.anna, { endpoint: laptop.endpoint });
		expect(await subscriptions("push-anna")).toBe(0);
	});
});

describe("push delivery", () => {
	const remind = () =>
		announce({
			kind: "meeting_reminder",
			project,
			accounts: ["push-anna"],
			params: { title: "Planning", starts_at: 1_800_000_000_000 },
			ttl: 600,
			path: `/projects/${project}/calendar`,
		});

	test("reaches every device of the person in the language of that device", async () => {
		await call("PUT", "/auth/push", tokens.anna, { endpoint: laptop.endpoint, keys: laptop.keys, language: "sl" });
		await call("PUT", "/auth/push", tokens.anna, { endpoint: phone.endpoint, keys: phone.keys, language: "en" });
		sent.length = 0;
		await remind();
		await settle();
		expect(sent.map((request) => request.url).sort()).toEqual([laptop.endpoint, phone.endpoint].sort());

		const toLaptop = sent.find((request) => request.url === laptop.endpoint)!;
		const headers = toLaptop.init.headers as Record<string, string>;
		expect(headers.TTL).toBe("600");
		expect(headers["Content-Encoding"]).toBe("aes128gcm");
		expect(headers.Authorization).toStartWith("vapid t=");
		const payload = JSON.parse(await decrypt(laptop, toLaptop.init.body as Uint8Array<ArrayBuffer>));
		expect(payload).toMatchObject({
			kind: "meeting_reminder",
			language: "sl",
			title: "Sestanek se kmalu začne",
			body: "{title} se začne ob {time}",
			params: { title: "Planning", starts_at: 1_800_000_000_000 },
			path: `/projects/${project}/calendar`,
		});
		expect(fillNotice(payload.body, readableParams(payload.params, "sl", 1_800_000_000_000))).toMatch(/^Planning se začne ob \d{2}:\d{2}$/);

		const toPhone = JSON.parse(await decrypt(phone, sent.find((request) => request.url === phone.endpoint)!.init.body as Uint8Array<ArrayBuffer>));
		expect(toPhone.title).toBe("Meeting starts soon");
	});

	test("follows the browser switch and Do not disturb", async () => {
		sent.length = 0;
		await call("PATCH", "/auth/notifications", tokens.anna, { changes: [{ kind: "meeting_reminder", channel: "browser", enabled: false }] });
		await remind();
		await settle();
		expect(sent).toEqual([]);

		await call("DELETE", "/auth/notifications", tokens.anna);
		await call("PUT", "/realtime/status", tokens.anna, { status: "dnd" });
		await remind();
		await settle();
		expect(sent).toEqual([]);

		await call("PUT", "/realtime/status", tokens.anna, { status: "auto" });
		await remind();
		await settle();
		expect(sent.length).toBe(2);
	});

	test("tells about chat messages without telling the author", async () => {
		await Database`UPDATE projects SET workforce_until = ${Date.now() + 86400000} WHERE uuid = ${project}`;
		await call("PUT", "/auth/push", tokens.owner, { endpoint: `${laptop.endpoint}-owner`, keys: laptop.keys, language: "en" });
		const conversation = await call("POST", `/projects/${project}/chat/conversations`, tokens.owner, { kind: "direct", account: "push-anna" });
		expect(conversation.status).toBeLessThan(300);
		sent.length = 0;
		const posted = await call("POST", `/projects/${project}/chat/conversations/${conversation.data.uuid}/messages`, tokens.owner, {
			body: "Lunch at **noon**?",
		});
		expect(posted.status).toBeLessThan(300);
		await settle();
		expect(sent.map((request) => request.url).sort()).toEqual([laptop.endpoint, phone.endpoint].sort());
		const payload = JSON.parse(await decrypt(phone, sent.find((request) => request.url === phone.endpoint)!.init.body as Uint8Array<ArrayBuffer>));
		expect(payload).toMatchObject({
			id: posted.data.uuid,
			kind: "chat_message",
			title: "{author}",
			body: "{preview}",
			params: { preview: "Lunch at noon?" },
			path: `/projects/${project}/chat/${conversation.data.uuid}`,
		});
	});

	test("lists the devices of a person and lets them remove one from anywhere", async () => {
		const agent = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
		const response = await Server.app.handle(
			new Request("http://127.0.0.1/api/v1/auth/push", {
				method: "PUT",
				headers: { Authorization: `Bearer ${tokens.anna}`, "Content-Type": "application/json", "User-Agent": agent },
				body: JSON.stringify({ endpoint: laptop.endpoint, keys: laptop.keys, language: "sl" }),
			})
		);
		expect(response.status).toBe(200);
		const listed = (await call("GET", "/auth/push", tokens.anna)).data.devices;
		expect(listed.length).toBe(2);
		const shown = listed.find((entry: any) => entry.user_agent === agent);
		expect(shown).toMatchObject({ language: "sl" });
		expect(shown.endpoint_hash).toBe(new Bun.CryptoHasher("sha256").update(laptop.endpoint).digest("hex"));
		expect(shown.seen).toBeGreaterThanOrEqual(shown.created);
		expect(JSON.stringify(listed)).not.toContain("wpush");

		expect((await call("DELETE", "/auth/push", tokens.owner, { device: shown.id })).data.devices.map((entry: any) => entry.id)).not.toContain(shown.id);
		expect(await subscriptions("push-anna")).toBe(2);
		const left = (await call("DELETE", "/auth/push", tokens.anna, { device: shown.id })).data.devices;
		expect(left.map((entry: any) => entry.id)).not.toContain(shown.id);
		expect(await subscriptions("push-anna")).toBe(1);
		await call("PUT", "/auth/push", tokens.anna, { endpoint: laptop.endpoint, keys: laptop.keys, language: "sl" });
	});

	test("a browser whose session expired can still take itself off the list", async () => {
		expect(await subscriptions("push-anna")).toBe(2);
		expect((await call("POST", "/push/forget", undefined, { endpoint: "https://attacker.test/x" })).status).toBe(200);
		expect((await call("POST", "/push/forget", undefined, { endpoint: `${laptop.endpoint}-unknown` })).status).toBe(200);
		expect(await subscriptions("push-anna")).toBe(2);
		expect((await call("POST", "/push/forget", undefined, { endpoint: laptop.endpoint })).status).toBe(200);
		expect(await subscriptions("push-anna")).toBe(1);
		await call("PUT", "/auth/push", tokens.anna, { endpoint: laptop.endpoint, keys: laptop.keys, language: "sl" });
		expect((await call("GET", "/auth/push", tokens.anna)).data.devices.length).toBe(2);
	});

	test("stops reaching a device nobody has signed in on for 30 days", async () => {
		const hash = new Bun.CryptoHasher("sha256").update(phone.endpoint).digest("hex");
		await Database`UPDATE push_subscriptions SET updated = ${Date.now() - PUSH_DEVICE_IDLE_MS - 60_000} WHERE endpoint_hash = ${hash}`;
		sent.length = 0;
		await remind();
		await settle();
		expect(sent.map((request) => request.url)).toEqual([laptop.endpoint]);
		expect((await call("GET", "/auth/push", tokens.anna)).data.devices.length).toBe(1);

		await call("PUT", "/auth/push", tokens.anna, { endpoint: laptop.endpoint, keys: laptop.keys, language: "sl" });
		expect(await subscriptions("push-anna")).toBe(1);
		await call("PUT", "/auth/push", tokens.anna, { endpoint: phone.endpoint, keys: phone.keys, language: "en" });
		expect(await subscriptions("push-anna")).toBe(2);
	});

	test("forgets a device the push service no longer knows", async () => {
		answer = 410;
		await remind();
		await settle();
		answer = 201;
		expect(await subscriptions("push-anna")).toBe(0);
	});
});
