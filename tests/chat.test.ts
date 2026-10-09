import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { Server } = await import("../server/server");
const { default: Database, initialize } = await import("../server/database/database");
const { default: Cache } = await import("../server/cache");
const { default: Auth } = await import("../server/auth");
const { Realtime, REALTIME_CLOSE_UNAUTHORIZED } = await import("../server/realtime");
const { MAX_MESSAGE_LENGTH, discardUnsentChatFiles, finishStaleRecordings } = await import("../server/workforce/chat");
const { FILE_PART_BYTES } = await import("../server/file-limits");
const { Calls, GroupCalls, iceServers } = await import("../server/workforce/calls");
const { forgetNodeLoads } = await import("../server/workforce/media-nodes");
const { createHmac } = await import("node:crypto");
const { Settings } = await import("../server/settings");

interface Result {
	status: number;
	error: number;
	info: string;
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

const tokens = { owner: "", anna: "", boris: "", cashier: "", outsider: "" };
let project = "";

const chat = () => `/projects/${project}/chat`;

async function account(username: string): Promise<string> {
	const now = Date.now();
	await Database`INSERT INTO accounts(username, email, password, created, updated, accessed) VALUES(${username}, ${`${username}@team.test`}, 'unused', ${now}, ${now}, ${now})`;
	return (await Auth.createSession(username, ""))!;
}

async function member(username: string, role: string, fullName: string) {
	const now = Date.now();
	await Database`
		INSERT INTO project_members(uuid, project_id, account_username, role, status, full_name, created, updated)
		VALUES(${crypto.randomUUID()}, ${project}, ${username}, ${role}, 'active', ${fullName}, ${now}, ${now})
	`;
}

function listen(username: string, sessionToken = "") {
	const events: any[] = [];
	const socket = {
		closed: null as number | null,
		send: (data: string) => void events.push(JSON.parse(data)),
		close(code?: number) {
			this.closed = code ?? 1000;
		},
	};
	Realtime.attach(socket, username, sessionToken);
	return { events, socket, stop: () => Realtime.detach(socket) };
}

async function direct(token: string, other: string): Promise<any> {
	return (await call("POST", `${chat()}/conversations`, token, { kind: "direct", account: other })).data;
}

beforeAll(async () => {
	await Cache.initialize();
	await initialize();
	await Server.configure();

	tokens.owner = await account("chat-owner");
	tokens.anna = await account("chat-anna");
	tokens.boris = await account("chat-boris");
	tokens.cashier = await account("chat-cashier");
	tokens.outsider = await account("chat-outsider");
	project = (await call("POST", "/projects", tokens.owner, { name: "chat-co", currency: "EUR" })).data.uuid;
	await Database`UPDATE projects SET workforce_until = ${Date.now() + 86400000} WHERE uuid = ${project}`;
	await member("chat-anna", "employee", "Anna Employee");
	await member("chat-boris", "supervisor", "Boris Supervisor");
	await member("chat-cashier", "cashier", "Cene Cashier");
});

afterAll(async () => {
	await Database.close();
});

describe("chat access", () => {
	test("needs the workforce license", async () => {
		await Database`UPDATE projects SET workforce_until = NULL WHERE uuid = ${project}`;
		expect((await call("GET", `${chat()}/conversations`, tokens.anna)).error).toBe(1189);
		await Database`UPDATE projects SET workforce_until = ${Date.now() + 86400000} WHERE uuid = ${project}`;
	});

	test("needs a project member with the chat permission", async () => {
		expect((await call("GET", `${chat()}/conversations`)).status).toBe(401);
		expect((await call("GET", `${chat()}/conversations`, tokens.outsider)).status).toBe(403);
		expect((await call("GET", `${chat()}/conversations`, tokens.cashier)).status).toBe(403);
		expect((await call("GET", `${chat()}/conversations`, tokens.anna)).data.conversations).toEqual([]);
	});

	test("lists only the people who can chat", async () => {
		const people = (await call("GET", `${chat()}/people`, tokens.anna)).data.people;
		expect(people.map((person: any) => person.account).sort()).toEqual(["chat-anna", "chat-boris", "chat-owner"]);
		expect(people.find((person: any) => person.account === "chat-anna").name).toBe("Anna Employee");
	});
});

describe("direct conversations", () => {
	test("opens one conversation per pair no matter who starts it", async () => {
		const first = await call("POST", `${chat()}/conversations`, tokens.anna, { kind: "direct", account: "chat-boris" });
		expect(first.status).toBe(201);
		expect(first.data.kind).toBe("direct");
		expect(first.data.participants.map((participant: any) => participant.name).sort()).toEqual(["Anna Employee", "Boris Supervisor"]);

		const again = await call("POST", `${chat()}/conversations`, tokens.boris, { kind: "direct", account: "chat-anna" });
		expect(again.status).toBe(200);
		expect(again.data.uuid).toBe(first.data.uuid);
	});

	test("refuses yourself and people who cannot chat", async () => {
		expect((await call("POST", `${chat()}/conversations`, tokens.anna, { kind: "direct", account: "chat-anna" })).error).toBe(1317);
		expect((await call("POST", `${chat()}/conversations`, tokens.anna, { kind: "direct", account: "chat-cashier" })).error).toBe(1321);
		expect((await call("POST", `${chat()}/conversations`, tokens.anna, { kind: "direct", account: "chat-outsider" })).error).toBe(1321);
	});

	test("hides a conversation from everyone who is not in it", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		expect((await call("GET", `${chat()}/conversations/${conversation.uuid}`, tokens.owner)).error).toBe(1316);
		expect((await call("GET", `${chat()}/conversations/${conversation.uuid}/messages`, tokens.owner)).error).toBe(1316);
		expect((await call("POST", `${chat()}/conversations/${conversation.uuid}/messages`, tokens.owner, { body: "Hello" })).error).toBe(1316);
	});

	test("cannot be renamed, joined or left", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}`;
		expect((await call("PATCH", path, tokens.anna, { name: "Renamed" })).error).toBe(1317);
		expect((await call("POST", `${path}/participants`, tokens.anna, { accounts: ["chat-owner"] })).error).toBe(1317);
		expect((await call("DELETE", `${path}/participants/chat-anna`, tokens.anna)).error).toBe(1317);
	});
});

describe("messages", () => {
	test("are numbered, delivered live and counted as unread for the other person", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}`;
		const boris = listen("chat-boris");
		const owner = listen("chat-owner");

		const first = await call("POST", `${path}/messages`, tokens.anna, { body: "  Lunch at noon?  " });
		expect(first.status).toBe(201);
		expect(first.data).toMatchObject({ number: 1, body: "Lunch at noon?", author: "chat-anna", author_name: "Anna Employee", deleted: false });
		const second = await call("POST", `${path}/messages`, tokens.anna, { body: "The usual place" });
		expect(second.data.number).toBe(2);

		expect(boris.events.map((event) => event.type)).toEqual(["chat.message", "chat.message"]);
		expect(boris.events[0]).toMatchObject({ project, conversation: conversation.uuid, message: { body: "Lunch at noon?" } });
		expect(owner.events).toEqual([]);
		boris.stop();
		owner.stop();

		const seenByBoris = (await call("GET", `${chat()}/conversations`, tokens.boris)).data.conversations[0];
		expect(seenByBoris).toMatchObject({ unread: 2, last_number: 2, read_number: 0, last_message: { body: "The usual place" } });
		expect((await call("GET", `${chat()}/unread`, tokens.boris)).data).toEqual({ messages: 2, conversations: 1 });
		expect((await call("GET", `${chat()}/unread`, tokens.anna)).data).toEqual({ messages: 0, conversations: 0 });

		expect((await call("POST", `${path}/read`, tokens.boris, { number: 99 })).data.read_number).toBe(2);
		expect((await call("POST", `${path}/read`, tokens.boris, { number: 1 })).data.read_number).toBe(2);
		expect((await call("GET", `${chat()}/unread`, tokens.boris)).data).toEqual({ messages: 0, conversations: 0 });
	});

	test("are stored encrypted", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		await call("POST", `${chat()}/conversations/${conversation.uuid}/messages`, tokens.anna, { body: "A very secret salary figure" });
		const rows = (await Database`SELECT body FROM chat_messages WHERE conversation = ${conversation.uuid}`) as { body: string }[];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row.body).not.toContain("secret");
	});

	test("reject empty and oversized text", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}/messages`;
		expect((await call("POST", path, tokens.anna, { body: "   " })).error).toBe(1318);
		expect((await call("POST", path, tokens.anna, { body: 5 })).error).toBe(1318);
		expect((await call("POST", path, tokens.anna, { body: "a".repeat(MAX_MESSAGE_LENGTH + 1) })).error).toBe(1318);
		expect((await call("POST", path, tokens.anna, { body: "a".repeat(MAX_MESSAGE_LENGTH) })).status).toBe(201);
	});

	test("page backwards from the newest", async () => {
		const conversation = await direct(tokens.owner, "chat-anna");
		const path = `${chat()}/conversations/${conversation.uuid}/messages`;
		for (let index = 1; index <= 7; index++) await call("POST", path, tokens.owner, { body: `Message ${index}` });

		const newest = (await call("GET", `${path}?limit=3`, tokens.anna)).data;
		expect(newest.messages.map((message: any) => message.number)).toEqual([5, 6, 7]);
		expect(newest.has_more).toBe(true);
		const older = (await call("GET", `${path}?limit=3&before=5`, tokens.anna)).data;
		expect(older.messages.map((message: any) => message.number)).toEqual([2, 3, 4]);
		const oldest = (await call("GET", `${path}?limit=3&before=2`, tokens.anna)).data;
		expect(oldest.messages.map((message: any) => message.body)).toEqual(["Message 1"]);
		expect(oldest.has_more).toBe(false);
	});

	test("can be edited and deleted only by their author in a direct conversation", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}/messages`;
		const message = (await call("POST", path, tokens.anna, { body: "Tpyo" })).data;
		const boris = listen("chat-boris");

		expect((await call("PATCH", `${path}/${message.uuid}`, tokens.boris, { body: "Hijacked" })).status).toBe(403);
		expect((await call("DELETE", `${path}/${message.uuid}`, tokens.boris)).status).toBe(403);

		const edited = await call("PATCH", `${path}/${message.uuid}`, tokens.anna, { body: "Typo" });
		expect(edited.data.body).toBe("Typo");
		expect(edited.data.edited_at).toBeGreaterThan(0);

		const removed = await call("DELETE", `${path}/${message.uuid}`, tokens.anna);
		expect(removed.data).toMatchObject({ deleted: true, body: null });
		expect(boris.events.map((event) => event.type)).toEqual(["chat.message_changed", "chat.message_changed"]);
		boris.stop();

		const [row] = (await Database`SELECT body FROM chat_messages WHERE uuid = ${message.uuid}`) as { body: string | null }[];
		expect(row.body).toBeNull();
		expect((await call("PATCH", `${path}/${message.uuid}`, tokens.anna, { body: "Back" })).error).toBe(1319);
		expect((await call("DELETE", `${path}/${message.uuid}`, tokens.anna)).error).toBe(1319);
	});

	test("deleted messages no longer count as unread", async () => {
		const conversation = await direct(tokens.owner, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}/messages`;
		const message = (await call("POST", path, tokens.owner, { body: "Sent to the wrong person" })).data;
		expect((await call("GET", `${chat()}/conversations/${conversation.uuid}`, tokens.boris)).data.unread).toBe(1);
		await call("DELETE", `${path}/${message.uuid}`, tokens.owner);
		expect((await call("GET", `${chat()}/conversations/${conversation.uuid}`, tokens.boris)).data.unread).toBe(0);
	});
});

describe("attachments", () => {
	const bytes = new TextEncoder().encode("quarterly figures");

	async function stage(token: string, conversation: string, name = "figures.txt"): Promise<any> {
		const begun = await call("POST", `${chat()}/conversations/${conversation}/files`, token, { name, type: "text/plain", size: bytes.length });
		expect(begun.status).toBe(201);
		const part = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1/projects/${project}/files/${begun.data.uuid}/parts/0`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: bytes,
			})
		);
		expect(part.status).toBe(200);
		return begun.data;
	}

	async function fetchFile(token: string, file: string): Promise<Response> {
		return await Server.app.handle(new Request(`http://127.0.0.1/api/v1/projects/${project}/files/${file}`, { headers: { Authorization: `Bearer ${token}` } }));
	}

	test("travel with a message and open only for the people in the conversation", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}`;
		const file = await stage(tokens.anna, conversation.uuid);
		const boris = listen("chat-boris");

		const sent = await call("POST", `${path}/messages`, tokens.anna, { files: [file.uuid] });
		expect(sent.status).toBe(201);
		expect(sent.data.body).toBe("");
		expect(sent.data.files).toMatchObject([
			{ uuid: file.uuid, file_name: "figures.txt", byte_size: bytes.length, removed: false, created_by_name: "Anna Employee" },
		]);
		expect(boris.events[0].message.files[0].file_name).toBe("figures.txt");
		boris.stop();

		expect(await (await fetchFile(tokens.boris, file.uuid)).text()).toBe("quarterly figures");
		expect((await fetchFile(tokens.owner, file.uuid)).status).toBe(404);
		expect((await call("POST", `/projects/${project}/files/${file.uuid}/link`, tokens.owner, {})).status).toBe(404);
	});

	test("cannot be sent twice, by someone else or into another conversation", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const other = await direct(tokens.anna, "chat-owner");
		const file = await stage(tokens.anna, conversation.uuid);
		const path = `${chat()}/conversations/${conversation.uuid}/messages`;

		expect((await call("POST", path, tokens.boris, { body: "Mine", files: [file.uuid] })).error).toBe(1305);
		expect((await call("POST", `${chat()}/conversations/${other.uuid}/messages`, tokens.anna, { files: [file.uuid] })).error).toBe(1305);
		expect((await call("POST", path, tokens.anna, { files: [] })).error).toBe(1318);
		expect((await call("POST", path, tokens.anna, { body: "Here", files: [file.uuid] })).status).toBe(201);
		expect((await call("POST", path, tokens.anna, { body: "Again", files: [file.uuid] })).error).toBe(1305);
	});

	test("are listed for administrators without their name and can be deleted by them", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}`;
		const file = await stage(tokens.anna, conversation.uuid, "payslip-anna.pdf");
		const message = (await call("POST", `${path}/messages`, tokens.anna, { body: "My payslip", files: [file.uuid] })).data;

		const listed = (await call("GET", `/projects/${project}/files?limit=200`, tokens.owner)).data.files.find((entry: any) => entry.uuid === file.uuid);
		expect(listed).toMatchObject({ chat: true, file_name: "", byte_size: bytes.length });

		const boris = listen("chat-boris");
		const removed = await call("DELETE", `/projects/${project}/files/${file.uuid}`, tokens.owner);
		expect(removed.data).toMatchObject({ removed: true, file_name: "" });
		expect(boris.events).toMatchObject([
			{ type: "chat.message_changed", message: { uuid: message.uuid, files: [{ removed: true, removed_by: "chat-owner" }] } },
		]);
		boris.stop();

		const shown = (await call("GET", `${path}/messages`, tokens.boris)).data.messages.find((entry: any) => entry.uuid === message.uuid);
		expect(shown.body).toBe("My payslip");
		expect(shown.files[0]).toMatchObject({ file_name: "payslip-anna.pdf", removed: true });
		expect((await fetchFile(tokens.boris, file.uuid)).status).toBe(410);
		const [audit] = await Database`SELECT old_value FROM audit_log WHERE entity_id = ${file.uuid} AND action = 'file.chat_attachment_removed'`;
		expect(audit.old_value).not.toContain("payslip");
	});

	test("free their storage when the message is deleted", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}/messages`;
		const file = await stage(tokens.anna, conversation.uuid);
		const message = (await call("POST", path, tokens.anna, { files: [file.uuid] })).data;

		expect((await call("PATCH", `${path}/${message.uuid}`, tokens.anna, { body: "" })).data.body).toBe("");
		expect((await call("DELETE", `${path}/${message.uuid}`, tokens.anna)).data).toMatchObject({ deleted: true, files: [] });
		expect((await fetchFile(tokens.anna, file.uuid)).status).toBe(410);
	});

	test("can be listed and removed in bulk by their sender, and by administrators for everyone", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const path = `${chat()}/conversations/${conversation.uuid}/messages`;
		const old = await stage(tokens.anna, conversation.uuid, "old-notes.txt");
		const recent = await stage(tokens.anna, conversation.uuid, "recent-notes.txt");
		const theirs = await stage(tokens.boris, conversation.uuid, "boris-notes.txt");
		await call("POST", path, tokens.anna, { files: [old.uuid, recent.uuid] });
		await call("POST", path, tokens.boris, { files: [theirs.uuid] });
		await Database`UPDATE project_files SET created = ${Date.now() - 40 * 86400000} WHERE uuid IN ${Database([old.uuid, theirs.uuid])}`;

		const listed = (await call("GET", `${chat()}/attachments?limit=200`, tokens.anna)).data;
		const names = listed.files.map((file: any) => file.file_name);
		expect(names).toContain("old-notes.txt");
		expect(names).toContain("recent-notes.txt");
		expect(names).not.toContain("boris-notes.txt");
		expect(listed.files.find((file: any) => file.uuid === old.uuid)).toMatchObject({ conversation: conversation.uuid, conversation_name: "Boris Supervisor" });
		expect(listed.total_bytes).toBe(listed.total * bytes.length);

		expect((await call("POST", `${chat()}/attachments/remove`, tokens.anna, { older_than_days: -1 })).error).toBe(1304);
		expect((await call("POST", `${chat()}/attachments/remove`, tokens.anna, { older_than_days: 30, everyone: true })).status).toBe(403);
		const boris = listen("chat-boris");
		const mine = await call("POST", `${chat()}/attachments/remove`, tokens.anna, { older_than_days: 30 });
		expect(mine.data.removed).toBeGreaterThanOrEqual(1);
		expect(
			boris.events.some((event) => event.type === "chat.message_changed" && event.message.files.some((file: any) => file.uuid === old.uuid && file.removed))
		).toBe(true);
		boris.stop();
		expect((await fetchFile(tokens.anna, old.uuid)).status).toBe(410);
		expect((await fetchFile(tokens.anna, recent.uuid)).status).toBe(200);
		expect((await fetchFile(tokens.boris, theirs.uuid)).status).toBe(200);

		expect((await call("POST", `${chat()}/attachments/remove`, tokens.owner, { older_than_days: 30, everyone: true })).data.removed).toBeGreaterThanOrEqual(1);
		expect((await fetchFile(tokens.boris, theirs.uuid)).status).toBe(410);
		expect((await call("POST", `${chat()}/attachments/remove`, tokens.anna, { older_than_days: 0 })).data.removed).toBeGreaterThanOrEqual(1);
		expect((await call("GET", `${chat()}/attachments`, tokens.anna)).data.total).toBe(0);
	});

	test("count toward the sender's own storage limit", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const usage = async () =>
			(await call("GET", `/projects/${project}/file-limits`, tokens.owner)).data.people.find((person: any) => person.username === "chat-anna").used;
		const before = await usage();
		const file = await stage(tokens.anna, conversation.uuid);
		await call("POST", `${chat()}/conversations/${conversation.uuid}/messages`, tokens.anna, { files: [file.uuid] });
		expect(await usage()).toBe(before + bytes.length);

		expect((await call("PUT", `/projects/${project}/file-limits/chat-anna`, tokens.owner, { max_mb: 0 })).error).toBe(0);
		const refused = await call("POST", `${chat()}/conversations/${conversation.uuid}/files`, tokens.anna, { name: "more.txt", type: "text/plain", size: 10 });
		expect(refused.error).toBe(1310);
		const group = (await call("POST", `${chat()}/conversations`, tokens.anna, { kind: "group", name: "Limited", accounts: ["chat-boris"] })).data;
		expect((await call("POST", `${chat()}/conversations/${group.uuid}/recordings`, tokens.anna, {})).error).toBe(1310);
		expect(
			(await call("POST", `${chat()}/conversations/${conversation.uuid}/files`, tokens.boris, { name: "more.txt", type: "text/plain", size: 10 })).status
		).toBe(201);
		expect((await call("PUT", `/projects/${project}/file-limits/chat-anna`, tokens.owner, { max_mb: null })).error).toBe(0);

		await call("DELETE", `/projects/${project}/files/${file.uuid}`, tokens.anna);
		expect(await usage()).toBe(before);
	});

	test("are discarded when never sent or when their group closes", async () => {
		const conversation = await direct(tokens.anna, "chat-boris");
		const unsent = await stage(tokens.anna, conversation.uuid);
		expect(await discardUnsentChatFiles(Date.now())).toBe(0);
		expect(await discardUnsentChatFiles(Date.now() + 365 * 86400000)).toBeGreaterThanOrEqual(1);
		expect((await Database`SELECT uuid FROM project_files WHERE uuid = ${unsent.uuid}`).length).toBe(0);

		const cancelled = await stage(tokens.anna, conversation.uuid);
		expect((await call("DELETE", `/projects/${project}/files/${cancelled.uuid}`, tokens.anna)).error).toBe(0);
		expect((await Database`SELECT uuid FROM project_files WHERE uuid = ${cancelled.uuid}`).length).toBe(0);

		const group = (await call("POST", `${chat()}/conversations`, tokens.anna, { kind: "group", name: "Short lived", accounts: ["chat-boris"] })).data;
		const file = await stage(tokens.anna, group.uuid);
		await call("POST", `${chat()}/conversations/${group.uuid}/messages`, tokens.anna, { files: [file.uuid] });
		await call("DELETE", `${chat()}/conversations/${group.uuid}/participants/chat-boris`, tokens.anna);
		expect((await call("DELETE", `${chat()}/conversations/${group.uuid}/participants/chat-anna`, tokens.anna)).data).toEqual({ closed: true });
		expect((await Database`SELECT uuid FROM project_files WHERE uuid = ${file.uuid}`).length).toBe(0);
	});
});

describe("groups", () => {
	let group = "";
	const path = () => `${chat()}/conversations/${group}`;

	test("need a name and at least one other person", async () => {
		expect((await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "", accounts: ["chat-anna"] })).error).toBe(1317);
		expect((await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "Solo", accounts: ["chat-owner"] })).error).toBe(1317);
		expect((await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "a".repeat(81), accounts: ["chat-anna"] })).error).toBe(1317);
		expect((await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "Tills", accounts: ["chat-cashier"] })).error).toBe(1321);
	});

	test("make their creator the admin and tell the people in them", async () => {
		const anna = listen("chat-anna");
		const created = await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "Front office", accounts: ["chat-anna", "chat-anna"] });
		expect(created.status).toBe(201);
		group = created.data.uuid;
		expect(created.data).toMatchObject({ kind: "group", name: "Front office", admin: true });
		expect(created.data.participants.map((participant: any) => [participant.account, participant.admin])).toEqual([
			["chat-anna", false],
			["chat-owner", true],
		]);
		expect(anna.events).toEqual([{ type: "chat.conversation", project, conversation: group }]);
		anna.stop();
	});

	test("let only admins rename, add and remove people", async () => {
		expect((await call("PATCH", path(), tokens.anna, { name: "Mine now" })).error).toBe(1320);
		expect((await call("POST", `${path()}/participants`, tokens.anna, { accounts: ["chat-boris"] })).error).toBe(1320);
		expect((await call("DELETE", `${path()}/participants/chat-owner`, tokens.anna)).error).toBe(1320);

		expect((await call("PATCH", path(), tokens.owner, { name: "Reception" })).data.name).toBe("Reception");
		expect((await call("POST", `${path()}/participants`, tokens.owner, { accounts: ["chat-cashier"] })).error).toBe(1321);
	});

	test("show the history to people added later without marking it unread", async () => {
		await call("POST", `${path()}/messages`, tokens.owner, { body: "Welcome" });
		const added = await call("POST", `${path()}/participants`, tokens.owner, { accounts: ["chat-boris", "chat-anna"] });
		expect(added.data.participants.map((participant: any) => participant.account).sort()).toEqual(["chat-anna", "chat-boris", "chat-owner"]);

		expect((await call("GET", `${path()}/messages`, tokens.boris)).data.messages.map((message: any) => message.body)).toEqual(["Welcome"]);
		expect((await call("GET", path(), tokens.boris)).data.unread).toBe(0);
		expect((await call("GET", path(), tokens.anna)).data.unread).toBe(1);
	});

	test("let an admin delete anyone's message but not edit it", async () => {
		const message = (await call("POST", `${path()}/messages`, tokens.anna, { body: "Off topic" })).data;
		expect((await call("PATCH", `${path()}/messages/${message.uuid}`, tokens.owner, { body: "Rewritten" })).status).toBe(403);
		expect((await call("DELETE", `${path()}/messages/${message.uuid}`, tokens.boris)).status).toBe(403);
		expect((await call("DELETE", `${path()}/messages/${message.uuid}`, tokens.owner)).data.deleted).toBe(true);
	});

	test("stop delivering to a person who was removed", async () => {
		const boris = listen("chat-boris");
		expect((await call("DELETE", `${path()}/participants/chat-boris`, tokens.owner)).data).toEqual({ closed: false });
		expect(boris.events).toEqual([{ type: "chat.conversation", project, conversation: group }]);
		await call("POST", `${path()}/messages`, tokens.owner, { body: "Without Boris" });
		expect(boris.events.length).toBe(1);
		boris.stop();
		expect((await call("GET", path(), tokens.boris)).error).toBe(1316);
	});

	test("hand the admin role on when the last admin leaves and close when empty", async () => {
		expect((await call("DELETE", `${path()}/participants/chat-owner`, tokens.owner)).data).toEqual({ closed: false });
		expect((await call("GET", path(), tokens.anna)).data.admin).toBe(true);
		expect((await call("DELETE", `${path()}/participants/chat-anna`, tokens.anna)).data).toEqual({ closed: true });
		expect((await Database`SELECT uuid FROM chat_conversations WHERE uuid = ${group}`).length).toBe(0);
		expect((await Database`SELECT uuid FROM chat_messages WHERE conversation = ${group}`).length).toBe(0);
	});

	test("stop delivering to a member who lost access to the project", async () => {
		const created = await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "Everyone", accounts: ["chat-anna", "chat-boris"] });
		await Database`UPDATE project_members SET status = 'suspended' WHERE project_id = ${project} AND account_username = 'chat-boris'`;
		const boris = listen("chat-boris");
		await call("POST", `${chat()}/conversations/${created.data.uuid}/messages`, tokens.owner, { body: "Staff only" });
		expect(boris.events).toEqual([]);
		boris.stop();

		const seen = (await call("GET", `${chat()}/conversations/${created.data.uuid}`, tokens.owner)).data;
		expect(seen.participants.find((participant: any) => participant.account === "chat-boris")).toMatchObject({ active: false, name: "Boris Supervisor" });
		await Database`UPDATE project_members SET status = 'active' WHERE project_id = ${project} AND account_username = 'chat-boris'`;
	});
});

describe("calls", () => {
	const callerClient = "a".repeat(16);
	const calleeClient = "b".repeat(16);
	let conversation: any;
	const path = () => `${chat()}/conversations/${conversation.uuid}`;
	const lastMessage = async () => (await call("GET", `${path()}/messages?limit=1`, tokens.anna)).data.messages[0];

	beforeAll(async () => {
		conversation = await direct(tokens.anna, "chat-boris");
		await call("POST", `${path()}/read`, tokens.boris, { number: 9999 });
	});

	test("ring the other person and connect the two tabs that take part", async () => {
		const anna = listen("chat-anna", tokens.anna);
		const boris = listen("chat-boris", tokens.boris);
		const started = await call("POST", `${path()}/calls`, tokens.anna, { client: callerClient, video: true });
		expect(started.status).toBe(201);
		expect(started.data.ice_servers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
		expect(started.data.screen_share).toEqual({ height: 1080, frames_per_second: 30, kbps: 5000 });
		expect(started.data.camera).toEqual({ height: 1080, frames_per_second: 30, kbps: 3000 });
		expect(boris.events).toMatchObject([
			{ type: "call.incoming", call: started.data.call, video: true, from: { account: "chat-anna", name: "Anna Employee" } },
		]);

		expect((await call("POST", `${chat()}/calls/${started.data.call}/accept`, tokens.anna, { client: callerClient })).error).toBe(1322);
		expect((await call("POST", `${chat()}/calls/${started.data.call}/accept`, tokens.boris, { client: calleeClient })).error).toBe(0);
		expect(anna.events).toMatchObject([{ type: "call.accepted", client: calleeClient, to: callerClient }]);
		expect((await call("POST", `${chat()}/calls/${started.data.call}/accept`, tokens.boris, { client: calleeClient })).error).toBe(1322);

		await Realtime.receive(
			anna.socket,
			JSON.stringify({ type: "call.signal", call: started.data.call, client: callerClient, data: { description: { type: "offer" } } })
		);
		expect(boris.events.at(-1)).toMatchObject({ type: "call.signal", to: calleeClient, data: { description: { type: "offer" } } });
		await Realtime.receive(anna.socket, JSON.stringify({ type: "call.signal", call: started.data.call, client: "c".repeat(16), data: {} }));
		const owner = listen("chat-owner", tokens.owner);
		await Realtime.receive(owner.socket, JSON.stringify({ type: "call.signal", call: started.data.call, client: callerClient, data: {} }));
		expect(boris.events.filter((event) => event.type === "call.signal").length).toBe(1);
		expect((await call("POST", `${chat()}/calls/${started.data.call}/end`, tokens.owner)).error).toBe(1322);
		owner.stop();

		expect((await call("POST", `${chat()}/calls/${started.data.call}/end`, tokens.boris)).error).toBe(0);
		expect(anna.events.find((event) => event.type === "call.ended")).toMatchObject({ reason: "answered" });
		expect((await lastMessage()).call).toMatchObject({ outcome: "answered", video: true });
		expect((await call("GET", `${chat()}/conversations/${conversation.uuid}`, tokens.boris)).data.unread).toBe(0);
		anna.stop();
		boris.stop();
	});

	test("record declined, cancelled and missed calls, and only a missed one is unread", async () => {
		const boris = listen("chat-boris", tokens.boris);
		const declined = (await call("POST", `${path()}/calls`, tokens.anna, { client: callerClient })).data.call;
		await call("POST", `${chat()}/calls/${declined}/end`, tokens.boris);
		expect((await lastMessage()).call).toEqual({ outcome: "declined", seconds: 0, video: false });

		const cancelled = (await call("POST", `${path()}/calls`, tokens.anna, { client: callerClient })).data.call;
		await call("POST", `${chat()}/calls/${cancelled}/end`, tokens.anna);
		expect((await lastMessage()).call.outcome).toBe("cancelled");
		expect((await call("GET", `${chat()}/conversations/${conversation.uuid}`, tokens.boris)).data.unread).toBe(0);

		Settings.calls.ring_seconds = 0.05;
		await call("POST", `${path()}/calls`, tokens.anna, { client: callerClient });
		await Bun.sleep(150);
		Settings.calls.ring_seconds = 45;
		expect((await lastMessage()).call.outcome).toBe("missed");
		expect(boris.events.at(-1)).toMatchObject({ type: "chat.message" });
		expect((await call("GET", `${chat()}/conversations/${conversation.uuid}`, tokens.boris)).data.unread).toBe(1);
		boris.stop();

		const message = await lastMessage();
		expect((await call("DELETE", `${path()}/messages/${message.uuid}`, tokens.anna)).error).toBe(1319);
		expect((await call("PATCH", `${path()}/messages/${message.uuid}`, tokens.anna, { body: "Edited" })).error).toBe(1319);
	});

	test("refuse a busy or offline person, groups and malformed requests", async () => {
		expect((await call("POST", `${path()}/calls`, tokens.anna, { client: callerClient })).error).toBe(1324);
		expect((await lastMessage()).call.outcome).toBe("missed");
		expect((await call("POST", `${path()}/calls`, tokens.anna, { client: "short" })).error).toBe(1325);
		const group = (await call("POST", `${chat()}/conversations`, tokens.anna, { kind: "group", name: "Callers", accounts: ["chat-boris"] })).data;
		expect((await call("POST", `${chat()}/conversations/${group.uuid}/calls`, tokens.anna, { client: callerClient })).error).toBe(1325);

		const boris = listen("chat-boris", tokens.boris);
		const anna = listen("chat-anna", tokens.anna);
		const first = (await call("POST", `${path()}/calls`, tokens.anna, { client: callerClient })).data.call;
		const other = await direct(tokens.owner, "chat-boris");
		expect((await call("POST", `${chat()}/conversations/${other.uuid}/calls`, tokens.owner, { client: "d".repeat(16) })).error).toBe(1323);

		const second = await call("POST", `${path()}/calls`, tokens.anna, { client: callerClient });
		expect(second.status).toBe(201);
		expect(Calls.find(first)).toBeNull();
		await call("POST", `${chat()}/calls/${second.data.call}/end`, tokens.anna);
		boris.stop();
		anna.stop();
		Calls.reset();
	});

	test("hand out short lived TURN credentials when a relay is configured", () => {
		Settings.calls.turn_urls = "turn:turn.rabbit.test:3478, turns:turn.rabbit.test:5349";
		Settings.calls.turn_secret = "relay-secret";
		const [stun, turn] = iceServers("chat-anna", 1_000_000_000_000);
		expect(stun).toEqual({ urls: ["stun:stun.cloudflare.com:3478"] });
		expect(turn.urls).toEqual(["turn:turn.rabbit.test:3478", "turns:turn.rabbit.test:5349"]);
		expect(turn.username).toBe("1000021600:chat-anna");
		expect(turn.credential).toBe(new Bun.CryptoHasher("sha1", "relay-secret").update("1000021600:chat-anna").digest("base64"));
		Settings.calls.turn_urls = "";
		Settings.calls.turn_secret = "";
	});
});

describe("recordings", () => {
	let group: any;
	const recordings = () => `${chat()}/conversations/${group.uuid}/recordings`;

	async function part(token: string, file: string, index: number, bytes: Uint8Array): Promise<Result> {
		const response = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1${chat()}/recordings/${file}/parts/${index}`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				body: bytes,
			})
		);
		return { status: response.status, ...((await response.json()) as Omit<Result, "status">) };
	}

	beforeAll(async () => {
		group = (await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "Board", accounts: ["chat-anna"] })).data;
	});

	test("grow part by part and land in the conversation as an attachment", async () => {
		const begun = await call("POST", recordings(), tokens.anna, { type: "video/webm;codecs=vp8,opus" });
		expect(begun.status).toBe(201);
		expect(begun.data).toMatchObject({ content_type: "video/webm", byte_size: 0, ready: false, part_bytes: FILE_PART_BYTES });
		expect(begun.data.limits).toEqual({ height: 1080, frames_per_second: 60, video_kbps: 5000, audio_kbps: 64 });
		expect(begun.data.file_name).toMatch(/^Board \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.webm$/);

		const full = new Uint8Array(FILE_PART_BYTES).fill(7);
		const tail = new TextEncoder().encode("the end of the meeting");
		expect((await part(tokens.anna, begun.data.uuid, 1, tail)).error).toBe(1308);
		expect((await part(tokens.owner, begun.data.uuid, 0, tail)).error).toBe(1331);
		expect((await part(tokens.anna, begun.data.uuid, 0, full)).data).toEqual({ byte_size: FILE_PART_BYTES, parts: 1 });
		expect((await part(tokens.anna, begun.data.uuid, 1, tail)).data).toEqual({ byte_size: FILE_PART_BYTES + tail.length, parts: 2 });
		expect((await part(tokens.anna, begun.data.uuid, 2, tail)).error).toBe(1308);

		const owner = listen("chat-owner");
		expect((await call("POST", `${chat()}/recordings/${begun.data.uuid}/finish`, tokens.owner)).error).toBe(1331);
		expect((await call("POST", `${chat()}/recordings/${begun.data.uuid}/finish`, tokens.anna)).data).toEqual({ kept: true });
		expect(owner.events).toMatchObject([{ type: "chat.message", message: { author: "chat-anna", files: [{ uuid: begun.data.uuid, ready: true }] } }]);
		owner.stop();
		expect((await call("POST", `${chat()}/recordings/${begun.data.uuid}/finish`, tokens.anna)).error).toBe(1331);

		const download = await Server.app.handle(
			new Request(`http://127.0.0.1/api/v1/projects/${project}/files/${begun.data.uuid}`, { headers: { Authorization: `Bearer ${tokens.owner}` } })
		);
		const bytes = new Uint8Array(await download.arrayBuffer());
		expect(bytes.length).toBe(FILE_PART_BYTES + tail.length);
		expect(new TextDecoder().decode(bytes.subarray(FILE_PART_BYTES))).toBe("the end of the meeting");
		expect((await call("GET", `/projects/${project}/files/${begun.data.uuid}`, tokens.boris)).status).toBe(404);
	});

	test("get their duration written into the reserved place", async () => {
		const reserved = [0xec, 0x89, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const recorded = new Uint8Array([1, 2, 3, 4, ...reserved, 5, 6, 7]);
		const download = async (file: string) =>
			new Uint8Array(
				await (
					await Server.app.handle(
						new Request(`http://127.0.0.1/api/v1/projects/${project}/files/${file}`, { headers: { Authorization: `Bearer ${tokens.owner}` } })
					)
				).arrayBuffer()
			);

		const stamped = await call("POST", recordings(), tokens.anna, { type: "video/webm" });
		await part(tokens.anna, stamped.data.uuid, 0, recorded);
		expect((await call("POST", `${chat()}/recordings/${stamped.data.uuid}/finish`, tokens.anna, { duration_offset: 4, duration_ms: 90500 })).data).toEqual({
			kept: true,
		});
		const bytes = await download(stamped.data.uuid);
		expect([...bytes.subarray(0, 7)]).toEqual([1, 2, 3, 4, 0x44, 0x89, 0x88]);
		expect(new DataView(bytes.buffer).getFloat64(7)).toBe(90500);
		expect([...bytes.subarray(15)]).toEqual([5, 6, 7]);

		const misplaced = await call("POST", recordings(), tokens.anna, { type: "video/webm" });
		await part(tokens.anna, misplaced.data.uuid, 0, recorded);
		expect((await call("POST", `${chat()}/recordings/${misplaced.data.uuid}/finish`, tokens.anna, { duration_offset: 3, duration_ms: 90500 })).data).toEqual({
			kept: true,
		});
		expect([...(await download(misplaced.data.uuid))]).toEqual([...recorded]);
	});

	test("are dropped when nothing was recorded and finished when left open", async () => {
		const empty = await call("POST", recordings(), tokens.anna, {});
		expect((await call("POST", `${chat()}/recordings/${empty.data.uuid}/finish`, tokens.anna)).data).toEqual({ kept: false });
		expect((await Database`SELECT uuid FROM project_files WHERE uuid = ${empty.data.uuid}`).length).toBe(0);

		const abandoned = await call("POST", recordings(), tokens.anna, {});
		await part(tokens.anna, abandoned.data.uuid, 0, new TextEncoder().encode("half a meeting"));
		expect(await finishStaleRecordings(() => false, Date.now())).toBe(0);
		expect(await finishStaleRecordings(() => true, Date.now() + 3600_000)).toBe(0);
		expect(await discardUnsentChatFiles(Date.now() + 365 * 86400000)).toBe(0);
		expect(await finishStaleRecordings(() => false, Date.now() + 3600_000)).toBe(1);
		const last = (await call("GET", `${chat()}/conversations/${group.uuid}/messages?limit=1`, tokens.owner)).data.messages[0];
		expect(last).toMatchObject({ author: "chat-anna", author_name: "Anna Employee", files: [{ uuid: abandoned.data.uuid, ready: true, byte_size: 14 }] });
	});

	test("work in direct conversations and stay out of reach of other people", async () => {
		const pair = await direct(tokens.anna, "chat-boris");
		const begun = await call("POST", `${chat()}/conversations/${pair.uuid}/recordings`, tokens.anna, {});
		expect(begun.status).toBe(201);
		expect(begun.data.file_name).toMatch(/^Call \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.webm$/);
		expect((await call("POST", `${chat()}/conversations/${pair.uuid}/recordings`, tokens.owner, {})).error).toBe(1316);
		await part(tokens.anna, begun.data.uuid, 0, new TextEncoder().encode("a private call"));
		expect((await call("POST", `${chat()}/recordings/${begun.data.uuid}/finish`, tokens.boris)).error).toBe(1331);
		expect((await call("POST", `${chat()}/recordings/${begun.data.uuid}/finish`, tokens.anna)).data).toEqual({ kept: true });
		const last = (await call("GET", `${chat()}/conversations/${pair.uuid}/messages?limit=1`, tokens.boris)).data.messages[0];
		expect(last).toMatchObject({ author: "chat-anna", files: [{ uuid: begun.data.uuid, ready: true }] });
	});
});

describe("group calls", () => {
	const rooms = { quiet: [] as { name: string; people: string[] }[], busy: [{ name: "other", people: ["x", "y", "z"] }] };
	const seen: { node: string; method: string; grant: any }[] = [];
	const nodes: ReturnType<typeof Bun.serve>[] = [];
	let group: any;
	const path = () => `${chat()}/conversations/${group.uuid}/group-call`;

	function fakeNode(name: "quiet" | "busy") {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const [head, payload, signature] = request.headers.get("authorization")!.slice(7).split(".");
				if (createHmac("sha256", "media-secret").update(`${head}.${payload}`).digest("base64url") !== signature) return new Response("", { status: 401 });
				const method = new URL(request.url).pathname.split("/").pop()!;
				seen.push({ node: name, method, grant: JSON.parse(Buffer.from(payload, "base64url").toString()).video });
				if (method === "ListRooms") return Response.json({ rooms: rooms[name].map((room) => ({ name: room.name, num_participants: room.people.length })) });
				const wanted = ((await request.json()) as { room: string }).room;
				return Response.json({ participants: (rooms[name].find((room) => room.name === wanted)?.people ?? []).map((identity) => ({ identity })) });
			},
		});
		nodes.push(server);
		return `ws://127.0.0.1:${server.port}`;
	}

	beforeAll(async () => {
		group = (await call("POST", `${chat()}/conversations`, tokens.owner, { kind: "group", name: "Stand up", accounts: ["chat-anna", "chat-boris"] })).data;
	});

	afterAll(() => {
		for (const node of nodes) node.stop(true);
		Settings.calls.livekit_urls = "";
		GroupCalls.reset();
	});

	test("are off until media servers are configured", async () => {
		expect((await call("GET", `${chat()}/conversations`, tokens.owner)).data.group_calls).toBe(false);
		expect((await call("POST", path(), tokens.owner)).error).toBe(1326);
	});

	test("start on the least loaded media server and let the others join the same room", async () => {
		Settings.calls.livekit_api_key = "media-key";
		Settings.calls.livekit_api_secret = "media-secret";
		Settings.calls.livekit_urls = `${fakeNode("busy")}, ${fakeNode("quiet")}/`;
		forgetNodeLoads();
		expect((await call("GET", `${chat()}/conversations`, tokens.owner)).data.group_calls).toBe(true);

		const anna = listen("chat-anna");
		const started = await call("POST", path(), tokens.owner);
		expect(started.error).toBe(0);
		expect(started.data.url).toBe(`ws://127.0.0.1:${nodes[1].port}`);
		expect(
			seen
				.filter((request) => request.method === "ListRooms")
				.map((request) => request.node)
				.sort()
		).toEqual(["busy", "quiet"]);
		expect(seen[0].grant).toEqual({ roomList: true });

		const [head, payload, signature] = started.data.token.split(".");
		expect(createHmac("sha256", "media-secret").update(`${head}.${payload}`).digest("base64url")).toBe(signature);
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
		expect(claims).toMatchObject({ iss: "media-key", sub: "chat-owner", video: { room: started.data.call, roomJoin: true, canPublish: true } });
		expect(claims.exp).toBeGreaterThan(Date.now() / 1000);

		expect(anna.events).toMatchObject([{ type: "call.group", active: true, ring: true, conversation: group.uuid, info: { people: 1 } }]);
		const joined = await call("POST", path(), tokens.anna);
		expect(joined.data).toMatchObject({ call: started.data.call, url: started.data.url });
		expect(joined.data.screen_share).toEqual({ height: 1080, frames_per_second: 30, kbps: 5000 });
		expect(joined.data.camera).toEqual({ height: 1080, frames_per_second: 30, kbps: 3000 });
		expect(anna.events.at(-1)).toMatchObject({ type: "call.group", ring: false, info: { people: 2 } });
		expect((await call("GET", `${chat()}/conversations/${group.uuid}`, tokens.boris)).data.call).toMatchObject({
			people: 2,
			started_by: "chat-owner@team.test",
		});
		anna.stop();
	});

	test("refuse direct conversations, outsiders and a full call", async () => {
		const pair = await direct(tokens.anna, "chat-boris");
		expect((await call("POST", `${chat()}/conversations/${pair.uuid}/group-call`, tokens.anna)).error).toBe(1325);
		expect((await call("POST", path(), tokens.cashier)).status).toBe(403);
		Settings.calls.max_group_people = 2;
		expect((await call("POST", path(), tokens.boris)).error).toBe(1327);
		expect((await call("POST", path(), tokens.anna)).error).toBe(0);
		Settings.calls.max_group_people = 50;
	});

	test("follow who is really on the media server and end when the room is empty", async () => {
		const room = GroupCalls.infoOf(group.uuid)!.call;
		rooms.quiet.push({ name: room, people: ["chat-owner"] });
		await GroupCalls.sweep();
		expect(GroupCalls.infoOf(group.uuid)!.people).toBe(1);
		expect(seen.at(-1)).toMatchObject({ node: "quiet", method: "ListParticipants", grant: { room, roomAdmin: true } });

		rooms.quiet.length = 0;
		await GroupCalls.sweep();
		expect(GroupCalls.infoOf(group.uuid)).not.toBeNull();
		const boris = listen("chat-boris");
		await GroupCalls.sweep(Date.now() + 61_000);
		expect(GroupCalls.infoOf(group.uuid)).toBeNull();
		expect(boris.events.map((event) => event.type)).toEqual(["call.group", "chat.message"]);
		expect(boris.events[0]).toMatchObject({ active: false, info: null });
		expect(boris.events[1].message.call).toMatchObject({ outcome: "answered", video: true });
		boris.stop();
	});

	test("schedule a meeting with a guest link that works only while the call runs", async () => {
		const startsAt = Date.now() + 3600_000;
		expect((await call("POST", `${chat()}/meetings`, tokens.owner, { title: "Review", starts_at: startsAt, duration_minutes: 2 })).error).toBe(1328);
		expect((await call("POST", `${chat()}/meetings`, tokens.owner, { title: "", starts_at: startsAt, duration_minutes: 30 })).error).toBe(1328);
		const created = await call("POST", `${chat()}/meetings`, tokens.owner, {
			title: "Quarterly review",
			starts_at: startsAt,
			duration_minutes: 45,
			accounts: ["chat-anna"],
			guests: true,
		});
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ kind: "group", name: "Quarterly review", meeting: { starts_at: startsAt, duration_minutes: 45, guests: true } });
		const meeting = `${chat()}/conversations/${created.data.uuid}`;

		expect((await call("GET", `${meeting}/meeting/guest-link`, tokens.boris)).error).toBe(1316);
		const link = (await call("GET", `${meeting}/meeting/guest-link`, tokens.anna)).data.url as string;
		const token = link.split("/meet/")[1];
		expect(link).toBe(`http://127.0.0.1:8099/meet/${token}`);
		const [stored] = await Database`SELECT guest_token, guest_token_hash FROM chat_meetings WHERE conversation = ${created.data.uuid}`;
		expect(stored.guest_token).not.toContain(token);
		expect(stored.guest_token_hash).not.toBe(token);

		const shown = await call("GET", `/public/meetings/${token}`);
		expect(shown.data).toMatchObject({ title: "Quarterly review", starts_at: startsAt, duration_minutes: 45, active: false });
		expect((await call("GET", `/public/meetings/${"x".repeat(48)}`)).error).toBe(1329);
		expect((await call("POST", `/public/meetings/${token}/join`, undefined, { name: "Greta Guest" })).error).toBe(1330);

		const started = await call("POST", `${meeting}/group-call`, tokens.owner);
		expect((await call("POST", `/public/meetings/${token}/join`, undefined, { name: "  " })).error).toBe(1328);
		const guest = await call("POST", `/public/meetings/${token}/join`, undefined, { name: " Greta   Guest " });
		expect(guest.data).toMatchObject({
			call: started.data.call,
			url: started.data.url,
			screen_share: { height: 1080, frames_per_second: 30, kbps: 5000 },
			camera: { height: 1080, frames_per_second: 30, kbps: 3000 },
		});
		const claims = JSON.parse(Buffer.from(guest.data.token.split(".")[1], "base64url").toString());
		expect(claims).toMatchObject({ sub: `guest-${guest.data.guest}`, name: "Greta Guest", video: { room: started.data.call, roomJoin: true } });
		expect(GroupCalls.infoOf(created.data.uuid)!.people).toBe(2);

		await call("POST", `/public/meetings/${token}/leave`, undefined, { guest: guest.data.guest });
		expect(GroupCalls.infoOf(created.data.uuid)!.people).toBe(1);
		await call("POST", `/public/meetings/${token}/join`, undefined, { name: "Greta Guest" });
		await call("POST", `${meeting}/group-call/leave`, tokens.owner);
		expect(GroupCalls.infoOf(created.data.uuid)).toBeNull();
		await Bun.sleep(30);
		expect(seen.find((request) => request.method === "DeleteRoom")).toMatchObject({ node: "quiet", grant: { roomCreate: true } });

		expect((await call("PATCH", `${meeting}/meeting`, tokens.anna, { duration_minutes: 60 })).error).toBe(1320);
		const reset = await call("PATCH", `${meeting}/meeting`, tokens.owner, { duration_minutes: 60, reset_guest_link: true });
		expect(reset.data.meeting).toMatchObject({ starts_at: startsAt, duration_minutes: 60, guests: true });
		expect((await call("GET", `/public/meetings/${token}`)).error).toBe(1329);
		expect((await call("PATCH", `${meeting}/meeting`, tokens.owner, { guests: false })).data.meeting.guests).toBe(false);
		expect((await call("GET", `${meeting}/meeting/guest-link`, tokens.owner)).data.url).toBeNull();
		expect((await call("PATCH", `${chat()}/conversations/${group.uuid}/meeting`, tokens.owner, { guests: true })).error).toBe(1328);
	});

	test("end when the last person leaves and report an unreachable media server", async () => {
		await call("POST", path(), tokens.owner);
		await call("POST", path(), tokens.anna);
		await call("POST", `${path()}/leave`, tokens.owner);
		expect(GroupCalls.infoOf(group.uuid)!.people).toBe(1);
		await call("POST", `${path()}/leave`, tokens.anna);
		expect(GroupCalls.infoOf(group.uuid)).toBeNull();

		Settings.calls.livekit_urls = "ws://127.0.0.1:1";
		forgetNodeLoads();
		expect((await call("POST", path(), tokens.owner)).error).toBe(1326);
	});
});

describe("realtime connections", () => {
	test("hand out single use tickets to signed in accounts only", async () => {
		expect((await call("POST", "/realtime/ticket")).status).toBe(401);
		const issued = await call("POST", "/realtime/ticket", tokens.anna);
		expect(issued.data.ticket).toMatch(/^[A-Za-z0-9]{64}$/);
		expect(await Realtime.redeemTicket(issued.data.ticket)).toEqual({ username: "chat-anna", sessionToken: tokens.anna });
		expect(await Realtime.redeemTicket(issued.data.ticket)).toBeNull();
		expect(await Realtime.redeemTicket("not-a-ticket")).toBeNull();
	});

	test("refuse a ticket once its session is gone", async () => {
		const token = (await Auth.createSession("chat-anna", ""))!;
		const issued = await call("POST", "/realtime/ticket", token);
		await Auth.destroySession(token);
		expect(await Realtime.redeemTicket(issued.data.ticket)).toBeNull();
	});

	test("answer pings and ignore anything malformed", async () => {
		const anna = listen("chat-anna", tokens.anna);
		await Realtime.receive(anna.socket, JSON.stringify({ type: "ping" }));
		await Realtime.receive(anna.socket, "not json");
		await Realtime.receive(anna.socket, JSON.stringify({ kind: "ping" }));
		await Realtime.receive(anna.socket, JSON.stringify({ type: "unknown" }));
		expect(anna.events).toEqual([{ type: "pong" }]);
		anna.stop();
	});

	test("close the sockets of a session that signs out", async () => {
		const token = (await Auth.createSession("chat-anna", ""))!;
		const leaving = listen("chat-anna", token);
		const staying = listen("chat-anna", tokens.anna);
		expect((await call("POST", "/auth/logout", token)).error).toBe(0);
		expect(leaving.socket.closed).toBe(REALTIME_CLOSE_UNAUTHORIZED);
		expect(staying.socket.closed).toBeNull();
		expect(Realtime.isOnline("chat-anna")).toBe(true);
		staying.stop();
		expect(Realtime.isOnline("chat-anna")).toBe(false);
	});

	test("carry chat messages over a real WebSocket", async () => {
		const port = 8100 + Math.floor(Math.random() * 400);
		await Server.initialize("127.0.0.1", port);
		try {
			const refused = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime?ticket=${"a".repeat(64)}`);
			expect(await new Promise<number>((resolve) => (refused.onclose = (event) => resolve(event.code)))).toBe(REALTIME_CLOSE_UNAUTHORIZED);

			const ticket = (await call("POST", "/realtime/ticket", tokens.boris)).data.ticket;
			const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime?ticket=${ticket}`);
			const received: any[] = [];
			const waiters: (() => void)[] = [];
			socket.onmessage = (event) => {
				received.push(JSON.parse(String(event.data)));
				waiters.splice(0).forEach((resume) => resume());
			};
			const next = async (type: string) => {
				while (!received.some((event) => event.type === type)) await new Promise<void>((resolve) => waiters.push(resolve));
				return received.find((event) => event.type === type);
			};
			await next("ready");

			socket.send(JSON.stringify({ type: "ping" }));
			await next("pong");

			const conversation = await direct(tokens.anna, "chat-boris");
			await call("POST", `${chat()}/conversations/${conversation.uuid}/messages`, tokens.anna, { body: "Over the wire" });
			expect((await next("chat.message")).message.body).toBe("Over the wire");

			const closing = new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)));
			await Server.stop();
			expect(await closing).toBe(4503);
		} finally {
			await Server.stop();
		}
	});
});
