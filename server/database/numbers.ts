export function safeInteger(value: unknown): number {
	let integer: bigint;
	if (typeof value === "bigint") integer = value;
	else if (typeof value === "number") {
		if (Number.isSafeInteger(value)) return value;
		throw new RangeError("Database integer exceeds the supported safe integer range");
	} else if (typeof value === "string" && /^-?\d+(?:\.0+)?$/.test(value)) integer = BigInt(value.split(".")[0]);
	else throw new TypeError("Expected a database integer");
	if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError("Database integer exceeds the supported safe integer range");
	}
	return Number(integer);
}

export function addIntegers(...values: number[]): number {
	return safeInteger(values.reduce((sum, value) => sum + BigInt(safeInteger(value)), 0n));
}

export function normalizeIntegers<T>(result: T): T {
	if (result === null || typeof result !== "object") return result;
	const metadata = result as unknown as Record<string, unknown>;
	if (typeof metadata.affectedRows === "number" || typeof metadata.affectedRows === "bigint") metadata.count = safeInteger(metadata.affectedRows);
	if (!Array.isArray(result)) return result;
	for (const row of result) {
		if (row === null || typeof row !== "object" || ArrayBuffer.isView(row)) continue;
		for (const key of Object.keys(row)) {
			if (typeof row[key] === "bigint") row[key] = safeInteger(row[key]);
		}
	}
	return result;
}

export function integerFields<T>(rows: T[], ...fields: (keyof T)[]): T[] {
	for (const row of rows) {
		for (const field of fields) {
			if (row[field] !== null && row[field] !== undefined) row[field] = safeInteger(row[field]) as T[keyof T];
		}
	}
	return rows;
}
