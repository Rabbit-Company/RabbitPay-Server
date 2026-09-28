const PITABLE = Uint8Array.from(
	(
		"d978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2179a59f587b34f1361456d8d09817d32" +
		"bd8f40eb86b77b0bf09521225c6b4e8254d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb626" +
		"6fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed708e8eade8052eef784aa72ac354d6a2a" +
		"961ad2715a1549744b9fd05e0418a4ecc2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731" +
		"2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a90d38341bab33ffb0bb480c5fb9b1cd2e" +
		"c5f3db47e5a59c770aa62068fe7fc1ad"
	)
		.match(/../g)!
		.map((pair) => parseInt(pair, 16))
);

function expandKey(key: Uint8Array, effectiveBits: number): Uint16Array {
	const l = new Uint8Array(128);
	l.set(key);
	for (let index = key.length; index < 128; index++) l[index] = PITABLE[(l[index - 1]! + l[index - key.length]!) & 0xff]!;
	const t8 = Math.ceil(effectiveBits / 8);
	const tm = 0xff % 2 ** (8 + effectiveBits - 8 * t8);
	l[128 - t8] = PITABLE[l[128 - t8]! & tm]!;
	for (let index = 127 - t8; index >= 0; index--) l[index] = PITABLE[l[index + 1]! ^ l[index + t8]!]!;
	const words = new Uint16Array(64);
	for (let index = 0; index < 64; index++) words[index] = l[2 * index]! | (l[2 * index + 1]! << 8);
	return words;
}

const SHIFTS = [1, 2, 3, 5];

function decryptBlock(k: Uint16Array, block: Uint8Array): Uint8Array {
	const r = [0, 1, 2, 3].map((index) => block[2 * index]! | (block[2 * index + 1]! << 8));
	let j = 63;

	const mix = () => {
		for (let i = 3; i >= 0; i--) {
			const value = r[i]! & 0xffff;
			const rotated = ((value >>> SHIFTS[i]!) | (value << (16 - SHIFTS[i]!))) & 0xffff;
			r[i] = (rotated - k[j]! - (r[(i + 3) & 3]! & r[(i + 2) & 3]!) - (~r[(i + 3) & 3]! & r[(i + 1) & 3]!)) & 0xffff;
			j--;
		}
	};
	const mash = () => {
		for (let i = 3; i >= 0; i--) r[i] = (r[i]! - k[r[(i + 3) & 3]! & 63]!) & 0xffff;
	};

	for (let round = 0; round < 5; round++) mix();
	mash();
	for (let round = 0; round < 6; round++) mix();
	mash();
	for (let round = 0; round < 5; round++) mix();

	return Uint8Array.from(r.flatMap((word) => [word & 0xff, word >> 8]));
}

export function rc2CbcDecrypt(key: Uint8Array, effectiveBits: number, iv: Uint8Array, data: Uint8Array): Uint8Array {
	if (data.length === 0 || data.length % 8 !== 0 || iv.length !== 8) throw new Error("RC2 data is not whole blocks");
	const k = expandKey(key, effectiveBits);
	const output = new Uint8Array(data.length);
	let previous = iv;
	for (let offset = 0; offset < data.length; offset += 8) {
		const block = data.subarray(offset, offset + 8);
		const plain = decryptBlock(k, block);
		for (let index = 0; index < 8; index++) output[offset + index] = plain[index]! ^ previous[index]!;
		previous = block;
	}
	const padding = output[output.length - 1]!;
	if (padding < 1 || padding > 8 || output.subarray(output.length - padding).some((byte) => byte !== padding)) throw new Error("RC2 padding is not valid");
	return output.subarray(0, output.length - padding);
}
