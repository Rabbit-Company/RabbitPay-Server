import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Settings } from "../settings";

export interface TargetCheck {
	allowed: boolean;
	reason?: string;
}

export interface ResolvedTarget extends TargetCheck {
	url?: URL;
	address?: string;
	family?: 4 | 6;
}

export type TargetResolver = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;

function parseIPv4(address: string): number[] | null {
	const parts = address.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
	const bytes = parts.map(Number);
	return bytes.some((part) => part < 0 || part > 255) ? null : bytes;
}

function ipv4Number(bytes: number[]): number {
	return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

function inIPv4Range(value: number, network: number, bits: number): boolean {
	if (bits === 0) return true;
	const mask = (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) === (network & mask);
}

function isPrivateIPv4(address: string): boolean {
	const bytes = parseIPv4(address);
	if (bytes === null) return true;
	const value = ipv4Number(bytes);
	const blocked: [string, number][] = [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.88.99.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 3],
	];

	return blocked.some(([network, bits]) => inIPv4Range(value, ipv4Number(parseIPv4(network)!), bits));
}

function parseIPv6(address: string): number[] | null {
	let normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
	const zone = normalized.indexOf("%");
	if (zone !== -1) normalized = normalized.slice(0, zone);

	const dotted = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) {
		const bytes = parseIPv4(dotted[1]);
		if (bytes === null) return null;
		const replacement = `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
		normalized = `${normalized.slice(0, -dotted[1].length)}${replacement}`;
	}

	if ((normalized.match(/::/g) ?? []).length > 1) return null;
	const compressed = normalized.includes("::");
	const [leftText, rightText = ""] = normalized.split("::");
	const left = leftText === "" ? [] : leftText.split(":");
	const right = rightText === "" ? [] : rightText.split(":");
	if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
	if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) return null;

	const zeros = compressed ? Array(8 - left.length - right.length).fill("0") : [];
	return [...left, ...zeros, ...right].map((part) => parseInt(part, 16));
}

function isPrivateIPv6(address: string): boolean {
	const words = parseIPv6(address);
	if (words === null || words.length !== 8) return true;

	const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
	if (mapped) {
		const embedded = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
		return isPrivateIPv4(embedded);
	}

	// Public IPv6 unicast currently comes from 2000::/3. Fail closed for every
	// other allocation, then exclude the special-purpose ranges inside it.
	if ((words[0] & 0xe000) !== 0x2000) return true;
	if (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) return true;
	if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
	if (words[0] === 0x2002) return true;
	if ((words[0] & 0xfff0) === 0x3ff0) return true;

	return false;
}

export function isPrivateAddress(address: string): boolean {
	const normalized = address.replace(/^\[|\]$/g, "");
	const family = isIP(normalized);
	if (family === 4) return isPrivateIPv4(normalized);
	if (family === 6) return isPrivateIPv6(normalized);
	return true;
}

export function allowsPrivateTargets(): boolean {
	return Settings.webhooks?.allow_private_targets === true;
}

function parseTarget(rawUrl: string): { url?: URL; error?: TargetCheck } {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { error: { allowed: false, reason: "Target is not a valid URL" } };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { error: { allowed: false, reason: `Unsupported scheme ${url.protocol}` } };
	}
	if (url.username || url.password) return { error: { allowed: false, reason: "Target URL cannot contain credentials" } };

	return { url };
}

export async function resolveTarget(rawUrl: string, allowPrivate = allowsPrivateTargets(), resolver: TargetResolver = lookup): Promise<ResolvedTarget> {
	const parsed = parseTarget(rawUrl);
	if (parsed.error) return parsed.error;
	const url = parsed.url!;
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const literalFamily = isIP(hostname);

	if (literalFamily !== 0) {
		if (!allowPrivate && isPrivateAddress(hostname)) {
			return { allowed: false, reason: `Target resolves to the private address ${hostname}` };
		}
		return { allowed: true, url, address: hostname, family: literalFamily as 4 | 6 };
	}

	let resolved: { address: string; family: number }[];
	try {
		resolved = await resolver(hostname, { all: true });
	} catch {
		return { allowed: false, reason: `Could not resolve ${hostname}` };
	}

	if (resolved.length === 0 || resolved.some((entry) => (entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family)) {
		return { allowed: false, reason: `Could not resolve ${hostname}` };
	}

	if (!allowPrivate) {
		for (const entry of resolved) {
			if (isPrivateAddress(entry.address)) return { allowed: false, reason: `Target resolves to the private address ${entry.address}` };
		}
	}

	const selected = resolved[0];
	return { allowed: true, url, address: selected.address, family: selected.family as 4 | 6 };
}

export function pinnedLookup(target: ResolvedTarget): LookupFunction {
	if (!target.address || !target.family) throw new Error("Cannot pin an unresolved target");
	return (_hostname, options, callback) => {
		if (options.all) callback(null, [{ address: target.address!, family: target.family! }]);
		else callback(null, target.address!, target.family);
	};
}

export async function checkTarget(rawUrl: string, allowPrivate = allowsPrivateTargets()): Promise<TargetCheck> {
	const parsed = parseTarget(rawUrl);
	if (parsed.error) return parsed.error;
	if (allowPrivate) return { allowed: true };
	return await resolveTarget(rawUrl, false);
}
