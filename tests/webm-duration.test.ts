import { describe, expect, test } from "bun:test";
import { reserveDuration } from "../web/src/webm-duration";

const HEAD = [0x1a, 0x45, 0xdf, 0xa3, 0x80];
const OPEN_SEGMENT = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const MILLISECOND_SCALE = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
const TRACKS = [0x16, 0x54, 0xae, 0x6b, 0x80];
const PLACEHOLDER = [0xec, 0x89, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function info(size: number[], ...fields: number[][]): number[] {
	return [0x15, 0x49, 0xa9, 0x66, ...size, ...fields.flat()];
}

describe("reserving room for the duration of a recording", () => {
	test("grows the info element by an ignorable placeholder", () => {
		const reserved = reserveDuration(new Uint8Array([...HEAD, ...OPEN_SEGMENT, ...info([0x87], MILLISECOND_SCALE), ...TRACKS]));
		expect(reserved?.offset).toBe(29);
		expect([...reserved!.bytes]).toEqual([...HEAD, ...OPEN_SEGMENT, ...info([0x92], MILLISECOND_SCALE, PLACEHOLDER), ...TRACKS]);
	});

	test("keeps the width of a wide size field", () => {
		const reserved = reserveDuration(new Uint8Array([...HEAD, ...OPEN_SEGMENT, ...info([0x01, 0, 0, 0, 0, 0, 0, 7], MILLISECOND_SCALE), ...TRACKS]));
		expect(reserved?.offset).toBe(36);
		expect([...reserved!.bytes.subarray(21, 29)]).toEqual([0x01, 0, 0, 0, 0, 0, 0, 18]);
	});

	test("leaves files it cannot safely change alone", () => {
		const known = [0x18, 0x53, 0x80, 0x67, 0x90];
		const seekHead = [0x11, 0x4d, 0x9b, 0x74, 0x80];
		const duration = [0x44, 0x89, 0x84, 0, 0, 0, 0];
		const otherScale = [0x2a, 0xd7, 0xb1, 0x81, 0x64];
		expect(reserveDuration(new Uint8Array([...HEAD, ...known, ...info([0x87], MILLISECOND_SCALE), ...TRACKS]))).toBeNull();
		expect(reserveDuration(new Uint8Array([...HEAD, ...OPEN_SEGMENT, ...seekHead, ...info([0x87], MILLISECOND_SCALE)]))).toBeNull();
		expect(reserveDuration(new Uint8Array([...HEAD, ...OPEN_SEGMENT, ...info([0x8e], MILLISECOND_SCALE, duration)]))).toBeNull();
		expect(reserveDuration(new Uint8Array([...HEAD, ...OPEN_SEGMENT, ...info([0x85], otherScale)]))).toBeNull();
		expect(reserveDuration(new Uint8Array([...HEAD, ...OPEN_SEGMENT, ...info([0xa0], MILLISECOND_SCALE)]))).toBeNull();
		expect(reserveDuration(new TextEncoder().encode("not a recording"))).toBeNull();
	});
});
