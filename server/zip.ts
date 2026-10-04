export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
const UTF8_NAMES = 0x800;

function dosDateTime(timestamp: number): { date: number; time: number } {
	const value = new Date(timestamp);
	return {
		date: ((Math.max(1980, value.getUTCFullYear()) - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate(),
		time: (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2),
	};
}

export function zipArchive(entries: ZipEntry[], timestamp = Date.now()): Uint8Array {
	if (entries.length > MAX_ENTRIES) throw new Error("A zip archive holds at most 65535 files");
	const stamp = dosDateTime(timestamp);
	const files = entries.map((entry) => ({ name: new TextEncoder().encode(entry.name), data: entry.data, checksum: Bun.hash.crc32(entry.data) }));
	const localSize = files.reduce((sum, file) => sum + LOCAL_HEADER_SIZE + file.name.length + file.data.length, 0);
	const centralSize = files.reduce((sum, file) => sum + CENTRAL_HEADER_SIZE + file.name.length, 0);
	if (localSize + centralSize > MAX_OFFSET) throw new Error("A zip archive holds at most 4 GB");

	const output = new Uint8Array(localSize + centralSize + END_RECORD_SIZE);
	const view = new DataView(output.buffer);
	let offset = 0;
	const write16 = (value: number) => {
		view.setUint16(offset, value, true);
		offset += 2;
	};
	const write32 = (value: number) => {
		view.setUint32(offset, value, true);
		offset += 4;
	};
	const writeBytes = (bytes: Uint8Array) => {
		output.set(bytes, offset);
		offset += bytes.length;
	};

	const starts: number[] = [];
	for (const file of files) {
		starts.push(offset);
		write32(0x04034b50);
		write16(20);
		write16(UTF8_NAMES);
		write16(0);
		write16(stamp.time);
		write16(stamp.date);
		write32(file.checksum);
		write32(file.data.length);
		write32(file.data.length);
		write16(file.name.length);
		write16(0);
		writeBytes(file.name);
		writeBytes(file.data);
	}

	files.forEach((file, index) => {
		write32(0x02014b50);
		write16(20);
		write16(20);
		write16(UTF8_NAMES);
		write16(0);
		write16(stamp.time);
		write16(stamp.date);
		write32(file.checksum);
		write32(file.data.length);
		write32(file.data.length);
		write16(file.name.length);
		write16(0);
		write16(0);
		write16(0);
		write16(0);
		write32(0);
		write32(starts[index]);
		writeBytes(file.name);
	});

	write32(0x06054b50);
	write16(0);
	write16(0);
	write16(files.length);
	write16(files.length);
	write32(centralSize);
	write32(localSize);
	write16(0);
	return output;
}
