import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const ENDPOINTS = `${import.meta.dir}/../server/endpoints`;

describe("endpoint registry", () => {
	test("imports every endpoint file so compiled binaries register all routes", async () => {
		const files = (await readdir(ENDPOINTS, { recursive: true }))
			.filter((file) => file.endsWith(".ts") && file !== "index.ts")
			.map((file) => `./${file.replace(/\\/g, "/").replace(/\.ts$/, "")}`)
			.sort();

		const index = await Bun.file(`${ENDPOINTS}/index.ts`).text();
		const imported = [...index.matchAll(/^import "(.+)";$/gm)].map((match) => match[1]).sort();

		expect(imported).toEqual(files);
	});
});
