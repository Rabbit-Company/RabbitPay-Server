import type { ScreenShareQuality } from "./api";

export type ShareSize = "high" | "medium" | "small";
export type DeviceKind = "audioinput" | "videoinput";

export const SHARE_SIZES: ShareSize[] = ["high", "medium", "small"];
export const SHARE_PRESETS: Record<ShareSize, ScreenShareQuality> = {
	high: { height: 1080, frames_per_second: 30, kbps: 4000 },
	medium: { height: 1080, frames_per_second: 15, kbps: 2500 },
	small: { height: 720, frames_per_second: 15, kbps: 1500 },
};

const SHARE_KEY = "rabbitpay.screen_share_quality";
const DEVICE_KEY = "rabbitpay.call_device";
const SHARE_ASPECT = 16 / 9;

export function shareSize(): ShareSize {
	try {
		const stored = localStorage.getItem(SHARE_KEY) as ShareSize | null;
		return stored !== null && SHARE_SIZES.includes(stored) ? stored : "high";
	} catch {
		return "high";
	}
}

export function chooseShareSize(size: ShareSize) {
	try {
		localStorage.setItem(SHARE_KEY, size);
	} catch {
		void 0;
	}
}

export function shareQuality(size: ShareSize, limits: ScreenShareQuality): ScreenShareQuality & { width: number } {
	const wanted = SHARE_PRESETS[size];
	const height = Math.min(wanted.height, limits.height);
	return {
		width: Math.round(height * SHARE_ASPECT),
		height,
		frames_per_second: Math.min(wanted.frames_per_second, limits.frames_per_second),
		kbps: Math.min(wanted.kbps, limits.kbps),
	};
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
