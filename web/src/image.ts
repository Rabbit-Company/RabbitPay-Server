const MAX_DIMENSION = 1024;
const MIN_DIMENSION = 64;
const QUALITIES = [0.9, 0.8, 0.7, 0.6];
const SHRINK_FACTOR = 0.75;
const FALLBACK_SIZE = 512;

export class ImageUnreadableError extends Error {}
export class ImageTooLargeError extends Error {}

function decodeImage(file: Blob): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(url);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new ImageUnreadableError());
		};
		image.src = url;
	});
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ImageUnreadableError())), "image/webp", quality);
	});
}

function draw(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new ImageUnreadableError();
	context.imageSmoothingQuality = "high";
	context.drawImage(image, 0, 0, width, height);
	return canvas;
}

export async function convertToWebp(file: Blob, maxBytes: number, maxDimension = MAX_DIMENSION): Promise<Blob> {
	const image = await decodeImage(file);
	const naturalWidth = image.naturalWidth || FALLBACK_SIZE;
	const naturalHeight = image.naturalHeight || FALLBACK_SIZE;

	let scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
	let smallest: Blob | null = null;

	while (Math.max(naturalWidth, naturalHeight) * scale >= MIN_DIMENSION) {
		const canvas = draw(image, Math.max(1, Math.round(naturalWidth * scale)), Math.max(1, Math.round(naturalHeight * scale)));
		for (const quality of QUALITIES) {
			const blob = await encode(canvas, quality);
			if (!smallest || blob.size < smallest.size) smallest = blob;
			if (blob.size <= maxBytes) break;
			if (blob.type !== "image/webp") break;
		}
		if (smallest && smallest.size <= maxBytes) break;
		scale *= SHRINK_FACTOR;
	}

	if (!smallest || smallest.size > maxBytes) throw new ImageTooLargeError();
	if (file.type === "image/webp" && file.size <= smallest.size) return file;
	return smallest;
}

export function toBase64(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}
