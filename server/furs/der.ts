export const TAG = {
	INTEGER: 0x02,
	BIT_STRING: 0x03,
	OCTET_STRING: 0x04,
	NULL: 0x05,
	OID: 0x06,
	UTF8_STRING: 0x0c,
	PRINTABLE_STRING: 0x13,
	T61_STRING: 0x14,
	IA5_STRING: 0x16,
	UTC_TIME: 0x17,
	GENERALIZED_TIME: 0x18,
	BMP_STRING: 0x1e,
	SEQUENCE: 0x30,
	SET: 0x31,
} as const;

export interface DerNode {
	tag: number;
	constructed: boolean;
	bytes: Uint8Array;
	content: Uint8Array;
	children: DerNode[];
}

export class DerError extends Error {}

function readLength(data: Uint8Array, offset: number): { length: number | null; size: number } {
	const first = data[offset];
	if (first === undefined) throw new DerError("Truncated length");
	if (first < 0x80) return { length: first, size: 1 };
	if (first === 0x80) return { length: null, size: 1 };
	const count = first & 0x7f;
	if (count > 4) throw new DerError("Length too large");
	let length = 0;
	for (let index = 1; index <= count; index++) {
		const byte = data[offset + index];
		if (byte === undefined) throw new DerError("Truncated length");
		length = length * 256 + byte;
	}
	return { length, size: 1 + count };
}

function readNode(data: Uint8Array, offset: number, end: number): { node: DerNode; next: number } {
	const tag = data[offset];
	if (tag === undefined || offset >= end) throw new DerError("Truncated element");
	if ((tag & 0x1f) === 0x1f) throw new DerError("High tag numbers are not supported");
	const constructed = (tag & 0x20) !== 0;
	const { length, size } = readLength(data, offset + 1);
	const contentStart = offset + 1 + size;

	if (length === null) {
		if (!constructed) throw new DerError("Indefinite length on a primitive element");
		const children: DerNode[] = [];
		let cursor = contentStart;
		for (;;) {
			if (cursor + 1 >= end) throw new DerError("Missing end of contents");
			if (data[cursor] === 0 && data[cursor + 1] === 0) break;
			const child = readNode(data, cursor, end);
			children.push(child.node);
			cursor = child.next;
		}
		const content = data.subarray(contentStart, cursor);
		return { node: { tag, constructed, bytes: data.subarray(offset, cursor + 2), content, children }, next: cursor + 2 };
	}

	const contentEnd = contentStart + length;
	if (contentEnd > end) throw new DerError("Element runs past its parent");
	const content = data.subarray(contentStart, contentEnd);
	const children: DerNode[] = [];
	if (constructed) {
		let cursor = contentStart;
		while (cursor < contentEnd) {
			const child = readNode(data, cursor, contentEnd);
			children.push(child.node);
			cursor = child.next;
		}
	}
	return { node: { tag, constructed, bytes: data.subarray(offset, contentEnd), content, children }, next: contentEnd };
}

export function parseDer(data: Uint8Array): DerNode {
	const { node } = readNode(data, 0, data.length);
	return node;
}

export function child(node: DerNode, index: number): DerNode {
	const found = node.children[index];
	if (!found) throw new DerError(`Missing element ${index}`);
	return found;
}

export function expect(node: DerNode, tag: number): DerNode {
	if ((node.tag & ~0x20) !== (tag & ~0x20)) throw new DerError(`Expected tag ${tag.toString(16)}, found ${node.tag.toString(16)}`);
	return node;
}

export function octets(node: DerNode): Uint8Array {
	expect(node, TAG.OCTET_STRING);
	if (!node.constructed) return node.content;
	const parts = node.children.map(octets);
	const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

export function explicit(node: DerNode, number: number): DerNode {
	if (node.tag !== (0xa0 | number)) throw new DerError(`Expected context tag [${number}]`);
	return child(node, 0);
}

export function oid(node: DerNode): string {
	const bytes = expect(node, TAG.OID).content;
	if (bytes.length === 0) throw new DerError("Empty object identifier");
	const first = bytes[0]!;
	const parts = [Math.min(Math.floor(first / 40), 2), first - Math.min(Math.floor(first / 40), 2) * 40];
	let value = 0n;
	for (let index = 1; index < bytes.length; index++) {
		const byte = bytes[index]!;
		value = (value << 7n) | BigInt(byte & 0x7f);
		if ((byte & 0x80) === 0) {
			parts.push(Number(value));
			value = 0n;
		}
	}
	return parts.join(".");
}

export function integer(node: DerNode): bigint {
	const bytes = expect(node, TAG.INTEGER).content;
	let value = 0n;
	for (const byte of bytes) value = (value << 8n) | BigInt(byte);
	if (bytes.length > 0 && (bytes[0]! & 0x80) !== 0) value -= 1n << BigInt(bytes.length * 8);
	return value;
}

export function text(node: DerNode): string {
	switch (node.tag) {
		case TAG.BMP_STRING: {
			let result = "";
			for (let index = 0; index + 1 < node.content.length; index += 2) result += String.fromCharCode((node.content[index]! << 8) | node.content[index + 1]!);
			return result;
		}
		case TAG.T61_STRING:
			return String.fromCharCode(...node.content);
		default:
			return new TextDecoder().decode(node.content);
	}
}

function encodeLength(length: number): Uint8Array {
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: number[] = [];
	for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function encode(tag: number, content: Uint8Array): Uint8Array {
	const length = encodeLength(content.length);
	const result = new Uint8Array(1 + length.length + content.length);
	result[0] = tag;
	result.set(length, 1);
	result.set(content, 1 + length.length);
	return result;
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
