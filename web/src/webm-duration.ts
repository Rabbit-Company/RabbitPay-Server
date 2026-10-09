const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const VOID = 0xec;
const MILLISECOND_SCALE = 1_000_000;
const PLACEHOLDER = [VOID, 0x89, 0, 0, 0, 0, 0, 0, 0, 0, 0];

interface Element {
	id: number;
	sizeAt: number;
	sizeWidth: number;
	start: number;
	size: number;
	unknown: boolean;
}

export interface ReservedDuration {
	bytes: Uint8Array;
	offset: number;
}

function element(bytes: Uint8Array, at: number): Element | null {
	const lead = bytes[at];
	if (lead === undefined || lead === 0) return null;
	const idWidth = Math.clz32(lead) - 23;
	const sizeAt = at + idWidth;
	const first = bytes[sizeAt];
	if (idWidth > 4 || first === undefined || first === 0) return null;
	const sizeWidth = Math.clz32(first) - 23;
	const start = sizeAt + sizeWidth;
	if (start > bytes.length) return null;
	let id = 0;
	for (let index = at; index < sizeAt; index++) id = id * 256 + bytes[index];
	const mask = 0xff >> sizeWidth;
	let size = first & mask;
	let unknown = size === mask;
	for (let index = sizeAt + 1; index < start; index++) {
		size = size * 256 + bytes[index];
		if (bytes[index] !== 0xff) unknown = false;
	}
	return { id, sizeAt, sizeWidth, start, size, unknown };
}

function sizeField(value: number, width: number): Uint8Array {
	const field = new Uint8Array(width);
	let rest = value;
	for (let index = width - 1; index >= 0; index--) {
		field[index] = rest % 256;
		rest = Math.floor(rest / 256);
	}
	field[0] |= 0x80 >> (width - 1);
	return field;
}

export function reserveDuration(bytes: Uint8Array): ReservedDuration | null {
	const head = element(bytes, 0);
	if (!head || head.id !== EBML || head.unknown) return null;
	const segment = element(bytes, head.start + head.size);
	if (!segment || segment.id !== SEGMENT || !segment.unknown) return null;
	let at = segment.start;
	for (;;) {
		const child = element(bytes, at);
		if (!child || child.unknown) return null;
		const end = child.start + child.size;
		if (end > bytes.length) return null;
		if (child.id === VOID) {
			at = end;
			continue;
		}
		if (child.id !== INFO) return null;
		let scale = MILLISECOND_SCALE;
		for (let inner = child.start; inner < end; ) {
			const field = element(bytes, inner);
			if (!field || field.unknown || field.id === DURATION) return null;
			if (field.id === TIMECODE_SCALE) scale = bytes.subarray(field.start, field.start + field.size).reduce((sum, byte) => sum * 256 + byte, 0);
			inner = field.start + field.size;
		}
		const grown = child.size + PLACEHOLDER.length;
		if (scale !== MILLISECOND_SCALE || grown >= 2 ** (7 * child.sizeWidth) - 1) return null;
		const reserved = new Uint8Array(bytes.length + PLACEHOLDER.length);
		reserved.set(bytes.subarray(0, end));
		reserved.set(sizeField(grown, child.sizeWidth), child.sizeAt);
		reserved.set(PLACEHOLDER, end);
		reserved.set(bytes.subarray(end), end + PLACEHOLDER.length);
		return { bytes: reserved, offset: end };
	}
}
