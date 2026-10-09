import type { CameraQuality, ScreenShareQuality } from "./api";

export type ShareSize = "high" | "medium" | "small";
export type DeviceKind = "audioinput" | "videoinput";

export const SHARE_SIZES: ShareSize[] = ["high", "medium", "small"];
export const SHARE_PRESETS: Record<ShareSize, ScreenShareQuality> = {
	high: { height: 1080, frames_per_second: 30, kbps: 4000 },
	medium: { height: 1080, frames_per_second: 15, kbps: 2500 },
	small: { height: 720, frames_per_second: 15, kbps: 1500 },
};
export const CAMERA_PRESETS: Record<ShareSize, CameraQuality> = {
	high: { height: 1080, frames_per_second: 30, kbps: 3000 },
	medium: { height: 720, frames_per_second: 30, kbps: 1700 },
	small: { height: 360, frames_per_second: 20, kbps: 500 },
};

const SHARE_KEY = "rabbitpay.screen_share_quality";
const CAMERA_KEY = "rabbitpay.camera_quality";
const DEVICE_KEY = "rabbitpay.call_device";
const WIDE_ASPECT = 16 / 9;

function storedSize(key: string, fallback: ShareSize): ShareSize {
	try {
		const stored = localStorage.getItem(key) as ShareSize | null;
		return stored !== null && SHARE_SIZES.includes(stored) ? stored : fallback;
	} catch {
		return fallback;
	}
}

function storeSize(key: string, size: ShareSize) {
	try {
		localStorage.setItem(key, size);
	} catch {
		void 0;
	}
}

function capped(wanted: ScreenShareQuality, limits: ScreenShareQuality): ScreenShareQuality & { width: number } {
	const height = Math.min(wanted.height, limits.height);
	return {
		width: Math.round(height * WIDE_ASPECT),
		height,
		frames_per_second: Math.min(wanted.frames_per_second, limits.frames_per_second),
		kbps: Math.min(wanted.kbps, limits.kbps),
	};
}

export function shareSize(): ShareSize {
	return storedSize(SHARE_KEY, "high");
}

export function chooseShareSize(size: ShareSize) {
	storeSize(SHARE_KEY, size);
}

export function shareQuality(size: ShareSize, limits: ScreenShareQuality): ScreenShareQuality & { width: number } {
	return capped(SHARE_PRESETS[size], limits);
}

export function cameraSize(): ShareSize {
	return storedSize(CAMERA_KEY, "medium");
}

export function chooseCameraSize(size: ShareSize) {
	storeSize(CAMERA_KEY, size);
}

export function cameraQuality(size: ShareSize, limits: CameraQuality): CameraQuality & { width: number } {
	return capped(CAMERA_PRESETS[size], limits);
}

export function rememberedDevice(kind: DeviceKind): string | undefined {
	try {
		return localStorage.getItem(`${DEVICE_KEY}.${kind}`) ?? undefined;
	} catch {
		return undefined;
	}
}

export function rememberDevice(kind: DeviceKind, device: string) {
	try {
		localStorage.setItem(`${DEVICE_KEY}.${kind}`, device);
	} catch {
		void 0;
	}
}

export function namedDevices(devices: MediaDeviceInfo[]): Record<DeviceKind, MediaDeviceInfo[]> {
	const named = (kind: DeviceKind) => devices.filter((device) => device.kind === kind && device.deviceId !== "" && device.label !== "");
	return { audioinput: named("audioinput"), videoinput: named("videoinput") };
}
