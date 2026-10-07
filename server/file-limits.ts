export const DEFAULT_MAX_FILE_BYTES = 25_000_000;
export const FILE_PART_BYTES = 16_000_000;
export const FILE_MB_BYTES = 1_000_000;
export const MAX_FILE_NAME_LENGTH = 250;
export const MAX_PREVIEW_BYTES = 10_000_000;
export const MAX_IN_PAGE_DOWNLOAD_BYTES = 100_000_000;
export const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const DOWNLOAD_LINK_SECONDS = 300;
export const PLAYBACK_LINK_SECONDS = 3600;
export const MAX_PDF_PREVIEW_BYTES = 50_000_000;
export const PREVIEWABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const PLAYABLE_VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-matroska", "video/matroska"];
export const PLAYABLE_VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "ogv", "mov", "mkv"];
export const UNTYPED_CONTENT_TYPE = "application/octet-stream";

export function isPlayableVideo(file: { content_type: string; file_name: string }): boolean {
	if (PLAYABLE_VIDEO_TYPES.includes(file.content_type)) return true;
	const extension = file.file_name.split(".").pop()?.toLowerCase() ?? "";
	return file.content_type === UNTYPED_CONTENT_TYPE && PLAYABLE_VIDEO_EXTENSIONS.includes(extension);
}
export const PDF_CONTENT_TYPE = "application/pdf";

export function partCount(bytes: number): number {
	return Math.max(1, Math.ceil(bytes / FILE_PART_BYTES));
}

export function partLength(bytes: number, index: number): number {
	return Math.min(FILE_PART_BYTES, bytes - index * FILE_PART_BYTES);
}
