import { createHash, createSign, type KeyObject } from "node:crypto";

export const FURS_TIMEZONE = "Europe/Ljubljana";

export interface FursTime {
	iso: string;
	printed: string;
	compact: string;
}

export function fursTime(timestamp: number): FursTime {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", {
			timeZone: FURS_TIMEZONE,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(timestamp)
			.map((part) => [part.type, part.value])
	) as Record<string, string>;
	const { year, month, day, hour, minute, second } = parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
	return {
		iso: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
		printed: `${day}.${month}.${year} ${hour}:${minute}:${second}`,
		compact: `${year.slice(2)}${month}${day}${hour}${minute}${second}`,
	};
}

export function fursAmount(minor: number): string {
	const sign = minor < 0 ? "-" : "";
	const absolute = Math.abs(minor);
	return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export interface ProtectedIdInput {
	taxNumber: number;
	issuedAt: number;
	invoiceNumber: string;
	premise: string;
	device: string;
	amount: number;
}

export function protectedId(privateKey: KeyObject, input: ProtectedIdInput): string {
	const data = `${input.taxNumber}${fursTime(input.issuedAt).printed}${input.invoiceNumber}${input.premise}${input.device}${fursAmount(input.amount)}`;
	const signature = createSign("RSA-SHA256").update(data, "utf8").sign(privateKey);
	return createHash("md5").update(signature).digest("hex");
}

export function verificationCode(zoi: string, taxNumber: number, issuedAt: number): string {
	const record = `${BigInt(`0x${zoi}`).toString().padStart(39, "0")}${String(taxNumber).padStart(8, "0")}${fursTime(issuedAt).compact}`;
	const control = [...record].reduce((sum, digit) => sum + Number(digit), 0) % 10;
	return `${record}${control}`;
}
