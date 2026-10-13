import { Database } from "bun:sqlite";

export interface ViesMock {
	port: number;
	stop: () => void;
}

export function startViesMock(port: number, database: string): ViesMock {
	let sequence = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request) {
			const { countryCode, vatNumber } = (await request.json().catch(() => ({}))) as { countryCode?: string; vatNumber?: string };
			let name = "---";
			let address = "---";
			if (countryCode === "SI" && vatNumber) {
				const registry = new Database(database, { readonly: true });
				const row = registry.query("SELECT name, street, postal_code, city FROM company_registry WHERE tax_number = ?").get(vatNumber) as {
					name: string;
					street: string | null;
					postal_code: string | null;
					city: string | null;
				} | null;
				registry.close();
				if (row) {
					name = row.name;
					address = [row.street, [row.postal_code, row.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
				}
			}
			return Response.json({
				countryCode,
				vatNumber,
				valid: true,
				name,
				address,
				requestDate: new Date().toISOString(),
				requestIdentifier: `WAPIAAAAY${String(++sequence).padStart(6, "0")}HELP`,
			});
		},
	});
	return { port, stop: () => server.stop(true) };
}
