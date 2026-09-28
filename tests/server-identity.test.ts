import { describe, expect, test } from "bun:test";
import { prepareTest } from "./environment";

await prepareTest();

const { default: Database, initialize: initializeDatabase } = await import("../server/database/database");
const { forgetServerId, normalizeServerId, serverId } = await import("../server/server-identity");

await initializeDatabase();

describe("server identity", () => {
	test("instances starting at the same time agree on one Server ID", async () => {
		const ids = await Promise.all(
			Array.from({ length: 8 }, async () => {
				forgetServerId();
				return await serverId();
			})
		);
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toMatch(/^RPS(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);

		const [count] = (await Database`SELECT COUNT(*) AS count FROM server_identity`) as { count: number }[];
		expect(Number(count.count)).toBe(1);
	});

	test("keeps the same ID for every instance that shares the database", async () => {
		const first = await serverId();
		forgetServerId();
		expect(await serverId()).toBe(first);
	});

	test("a second row cannot be added next to the Server ID", async () => {
		const extra = async () => await Database`INSERT INTO server_identity(slot, id, created) VALUES(2, 'RPS-00000-00000-00000-00000', 1)`;
		expect(extra()).rejects.toThrow();
	});

	test("accepts Server IDs typed in lowercase and rejects anything else", () => {
		expect(normalizeServerId(" rps-80yc7-ktkmn-6nnp6-vhg0s ")).toBe("RPS-80YC7-KTKMN-6NNP6-VHG0S");
		expect(normalizeServerId("RPS-80YC7-KTKMN-6NNP6")).toBeNull();
		expect(normalizeServerId("RPS-ILOU0-KTKMN-6NNP6-VHG0S")).toBeNull();
		expect(normalizeServerId(42)).toBeNull();
	});
});
