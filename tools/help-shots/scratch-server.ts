import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../..");
const REGISTRY_COLUMNS = "tax_number, registration_number, vat_registered, kind, name, street, postal_code, city, country, activity, search";
const REGISTRY_TABLE = `CREATE TABLE IF NOT EXISTS company_registry(
	tax_number TEXT PRIMARY KEY,
	registration_number TEXT,
	vat_registered INTEGER NOT NULL DEFAULT 0 CHECK (vat_registered IN (0, 1)),
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	street TEXT,
	postal_code TEXT,
	city TEXT,
	country TEXT,
	activity TEXT,
	search TEXT NOT NULL,
	updated INTEGER NOT NULL,
	CHECK (kind IN ('company', 'sole_trader'))
)`;

export const REGISTRY_CACHE = join(tmpdir(), "rabbitpay-help-shots-cache", "registry.sqlite");

export function rememberRegistry(database: Database) {
	if (existsSync(REGISTRY_CACHE)) return;
	mkdirSync(dirname(REGISTRY_CACHE), { recursive: true });
	database.run(`ATTACH '${REGISTRY_CACHE}' AS cache`);
	database.run(`CREATE TABLE cache.company_registry AS SELECT * FROM main.company_registry`);
	database.run(`DETACH cache`);
}

function recallRegistry(database: Database) {
	if (!existsSync(REGISTRY_CACHE)) return;
	database.run(REGISTRY_TABLE);
	database.run(`ATTACH '${REGISTRY_CACHE}' AS cache`);
	database.run(
		`INSERT OR IGNORE INTO main.company_registry(${REGISTRY_COLUMNS}, updated) SELECT ${REGISTRY_COLUMNS}, ${Date.now()} FROM cache.company_registry`
	);
	database.run(`DETACH cache`);
}

export interface ScratchServer {
	base: string;
	database: string;
	stop: () => Promise<void>;
}

export async function startScratchServer(work: string, port: number, mailPort: number, fresh: boolean): Promise<ScratchServer> {
	if (fresh) rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	const database = join(work, "help-shots.sqlite");
	const base = `http://localhost:${port}`;

	const running = await fetch(`${base}/api/v1/help/en`)
		.then((response) => response.ok)
		.catch(() => false);
	if (running) {
		if (fresh) throw new Error(`Something already answers on ${base}. Stop it or choose another --port.`);
		return { base, database, stop: async () => {} };
	}

	const settings = new Database(database);
	settings.run(`CREATE TABLE IF NOT EXISTS settings("key" TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)`);
	const store = settings.prepare(`INSERT OR REPLACE INTO settings("key", value, updated) VALUES(?, ?, ?)`);
	const values: Record<string, unknown> = {
		"server.port": port,
		"server.public_url": base,
		"security.credential_rate_limit": 10000,
		"security.session_ttl": 86400,
		"email.enabled": true,
		"email.host": "127.0.0.1",
		"email.port": mailPort,
		"email.from_address": "no-reply@rabbitpay.net",
		"btc.enabled": true,
		"eth.enabled": true,
		"xmr.enabled": true,
		"stripe.enabled": true,
		"paypal.enabled": true,
	};
	for (const [key, value] of Object.entries(values)) store.run(key, JSON.stringify(value), Date.now());
	if (fresh) recallRegistry(settings);
	settings.close();

	const child = Bun.spawn(["bun", "run", "server/index.ts"], {
		cwd: REPOSITORY,
		env: {
			...Bun.env,
			RABBITPAY_DB: `sqlite://${database}`,
			RABBITPAY_MASTER_KEY: "help-shots-scratch-master-key-0123456789-abcdefghij",
			DOCUMENT_STORAGE: "local",
			DOCUMENT_LOCAL_PATH: join(work, "documents"),
		},
		stdout: Bun.file(join(work, "server.log")),
		stderr: Bun.file(join(work, "server.log")),
	});

	for (let attempt = 0; attempt < 120; attempt++) {
		await Bun.sleep(500);
		if (child.exitCode !== null) throw new Error(`The scratch server stopped. See ${join(work, "server.log")}`);
		const ready = await fetch(`${base}/api/v1/help/en`)
			.then((response) => response.ok)
			.catch(() => false);
		if (ready) {
			return {
				base,
				database,
				stop: async () => {
					child.kill();
					await child.exited;
				},
			};
		}
	}
	child.kill();
	throw new Error(`The scratch server did not answer on ${base}`);
}
