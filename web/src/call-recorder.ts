import type { Participant, Room, Track } from "livekit-client";
import { Api, type RecordingQuality } from "./api";
import { reserveDuration } from "./webm-duration";

const SLICE_MS = 3000;
const ASPECT = 16 / 9;
const TITLE_HEIGHT = 720;
const SIZE_KEY = "rabbitpay.recording_size";
const CUSTOM_KEY = "rabbitpay.recording_custom";
const PREFERRED_TYPES = ["video/webm;codecs=vp8,opus", "video/webm"];

export type RecordingSize = "high" | "medium" | "small" | "custom";
export type RecordingPicture = Omit<RecordingQuality, "audio_kbps">;
export const RECORDING_SIZES: RecordingSize[] = ["high", "medium", "small", "custom"];
export const RECORDING_FLOOR: RecordingPicture = { height: 360, frames_per_second: 5, video_kbps: 300 };

const PRESETS: Record<Exclude<RecordingSize, "custom">, RecordingPicture> = {
	high: { height: 1080, frames_per_second: 30, video_kbps: 3000 },
	medium: { height: 1080, frames_per_second: 15, video_kbps: 2000 },
	small: { height: 720, frames_per_second: 10, video_kbps: 1200 },
};

export function recordingSize(): RecordingSize {
	try {
		const stored = localStorage.getItem(SIZE_KEY) as RecordingSize | null;
		return stored !== null && RECORDING_SIZES.includes(stored) ? stored : "high";
	} catch {
		return "high";
	}
}

export function chooseRecordingSize(size: RecordingSize) {
	try {
		localStorage.setItem(SIZE_KEY, size);
	} catch {
		void 0;
	}
}

export function customRecording(): RecordingPicture {
	try {
		const stored = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "null") as Partial<RecordingPicture> | null;
		const kept = (key: keyof RecordingPicture) => (typeof stored?.[key] === "number" && Number.isFinite(stored[key]) ? stored[key] : PRESETS.high[key]);
		return { height: kept("height"), frames_per_second: kept("frames_per_second"), video_kbps: kept("video_kbps") };
	} catch {
		return PRESETS.high;
	}
}

export function chooseCustomRecording(picture: RecordingPicture) {
	try {
		localStorage.setItem(CUSTOM_KEY, JSON.stringify(picture));
	} catch {
		void 0;
	}
}

export function qualityOf(size: RecordingSize, limits: RecordingQuality): RecordingQuality {
	const wanted = size === "custom" ? customRecording() : PRESETS[size];
	const within = (key: keyof RecordingPicture) => Math.max(RECORDING_FLOOR[key], Math.min(limits[key], Math.round(wanted[key])));
	return { height: within("height"), frames_per_second: within("frames_per_second"), video_kbps: within("video_kbps"), audio_kbps: limits.audio_kbps };
}

type LiveKit = typeof import("livekit-client");

export interface CallRecorder {
	sync(): void;
	stop(): Promise<boolean>;
}

export function canRecord(): boolean {
	return typeof MediaRecorder !== "undefined" && PREFERRED_TYPES.some((type) => MediaRecorder.isTypeSupported(type));
}

function steadyTimer(milliseconds: number, tick: () => void): () => void {
	try {
		const source = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${milliseconds});`], { type: "text/javascript" }));
		const worker = new Worker(source);
		worker.onmessage = tick;
		return () => {
			worker.terminate();
			URL.revokeObjectURL(source);
		};
	} catch {
		const timer = setInterval(tick, milliseconds);
		return () => clearInterval(timer);
	}
}

function sharedScreen(room: Room, kit: LiveKit): Track | null {
	const everyone: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
	for (const participant of everyone) {
		const track = participant.getTrackPublication(kit.Track.Source.ScreenShare)?.track;
		if (participant.isScreenShareEnabled && track) return track;
	}
	return null;
}

export async function startRecorder(
	room: Room,
	kit: LiveKit,
	target: { project: string; conversation: string; title: string },
	size: RecordingSize,
	onFailure: () => void
): Promise<CallRecorder> {
	const type = PREFERRED_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate))!;
	const begun = await Api.beginRecording(target.project, target.conversation, type);
	const quality = qualityOf(size, begun.limits);
	const frameHeight = quality.height;
	const frameWidth = Math.round((frameHeight * ASPECT) / 2) * 2;
	const titleScale = frameHeight / TITLE_HEIGHT;

	const audio = new AudioContext();
	const destination = audio.createMediaStreamDestination();
	const sources = new Map<string, MediaStreamAudioSourceNode>();
	const canvas = document.createElement("canvas");
	canvas.width = frameWidth;
	canvas.height = frameHeight;
	const pen = canvas.getContext("2d")!;
	const screen = document.createElement("video");
	screen.muted = true;
	screen.playsInline = true;
	let shownTrack: Track | null = null;

	function sync() {
		const wanted = new Map<string, MediaStreamTrack>();
		const everyone: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
		for (const participant of everyone) {
			for (const publication of participant.audioTrackPublications.values()) {
				const track = publication.track?.mediaStreamTrack;
				if (track && track.readyState === "live") wanted.set(track.id, track);
			}
		}
		for (const [id, source] of sources) {
			if (wanted.has(id)) continue;
			source.disconnect();
			sources.delete(id);
		}
		for (const [id, track] of wanted) {
			if (sources.has(id)) continue;
			const source = audio.createMediaStreamSource(new MediaStream([track]));
			source.connect(destination);
			sources.set(id, source);
		}
	}

	function draw() {
		const track = sharedScreen(room, kit);
		if (track !== shownTrack) {
			shownTrack?.detach(screen);
			shownTrack = track;
			if (track) {
				track.attach(screen);
				void screen.play().catch(() => undefined);
			}
		}
		pen.fillStyle = "#101215";
		pen.fillRect(0, 0, frameWidth, frameHeight);
		if (track && screen.videoWidth > 0) {
			const scale = Math.min(frameWidth / screen.videoWidth, frameHeight / screen.videoHeight);
			const width = screen.videoWidth * scale;
			const height = screen.videoHeight * scale;
			pen.drawImage(screen, (frameWidth - width) / 2, (frameHeight - height) / 2, width, height);
			return;
		}
		pen.fillStyle = "#e8eaed";
		pen.textAlign = "center";
		pen.font = `600 ${44 * titleScale}px sans-serif`;
		pen.fillText(target.title, frameWidth / 2, frameHeight / 2 - 30 * titleScale, frameWidth - 120 * titleScale);
		pen.font = `${26 * titleScale}px sans-serif`;
		pen.fillStyle = "#9aa1ac";
		const names = [room.localParticipant, ...room.remoteParticipants.values()].map((participant) => participant.name || participant.identity);
		pen.fillText(names.join(", "), frameWidth / 2, frameHeight / 2 + 30 * titleScale, frameWidth - 120 * titleScale);
		pen.fillText(new Date().toLocaleString("sv-SE"), frameWidth / 2, frameHeight / 2 + 80 * titleScale);
	}

	sync();
	draw();
	const stopDrawing = steadyTimer(1000 / quality.frames_per_second, draw);
	const stream = new MediaStream([...canvas.captureStream(quality.frames_per_second).getVideoTracks(), ...destination.stream.getAudioTracks()]);
	const recorder = new MediaRecorder(stream, {
		mimeType: type,
		videoBitsPerSecond: quality.video_kbps * 1000,
		audioBitsPerSecond: quality.audio_kbps * 1000,
	});

	let pending: Blob[] = [];
	let pendingBytes = 0;
	let partIndex = 0;
	let failed = false;
	let uploads: Promise<void> = Promise.resolve();
	let stopped: Promise<boolean> | null = null;
	let intake: Promise<void> = Promise.resolve();
	let opening = type.startsWith("video/webm");
	let durationOffset: number | null = null;
	let startedAt = performance.now();
	let endedAt: number | null = null;

	function upload(part: Blob) {
		const index = partIndex++;
		uploads = uploads.then(async () => {
			if (failed) return;
			try {
				await Api.uploadRecordingPart(target.project, begun.uuid, index, part);
			} catch {
				failed = true;
				onFailure();
			}
		});
	}

	function cutParts(final: boolean) {
		while (pendingBytes >= begun.part_bytes || (final && pendingBytes > 0)) {
			const all = new Blob(pending);
			const part = all.slice(0, begun.part_bytes);
			const rest = all.slice(begun.part_bytes);
			pending = rest.size > 0 ? [rest] : [];
			pendingBytes = rest.size;
			upload(part);
		}
	}

	async function opened(data: Blob): Promise<Blob> {
		if (!opening) return data;
		opening = false;
		const reserved = reserveDuration(new Uint8Array(await data.arrayBuffer()));
		if (reserved === null) return data;
		durationOffset = reserved.offset;
		return new Blob([reserved.bytes as BlobPart]);
	}

	recorder.addEventListener("dataavailable", (event) => {
		if (event.data.size === 0) return;
		intake = intake.then(async () => {
			const data = await opened(event.data).catch(() => event.data);
			pending.push(data);
			pendingBytes += data.size;
			cutParts(false);
		});
	});
	recorder.addEventListener("start", () => {
		startedAt = performance.now();
	});
	recorder.addEventListener("stop", () => {
		endedAt ??= performance.now();
	});
	recorder.start(SLICE_MS);

	function stop(): Promise<boolean> {
		stopped ??= new Promise<boolean>((resolve) => {
			const finishUp = async () => {
				stopDrawing();
				shownTrack?.detach(screen);
				for (const source of sources.values()) source.disconnect();
				for (const track of stream.getTracks()) track.stop();
				void audio.close().catch(() => undefined);
				await intake;
				cutParts(true);
				await uploads;
				const duration = durationOffset === null ? null : { offset: durationOffset, milliseconds: Math.round((endedAt ?? performance.now()) - startedAt) };
				try {
					resolve((await Api.finishRecording(target.project, begun.uuid, duration)).kept && !failed);
				} catch {
					resolve(false);
				}
			};
			if (recorder.state === "inactive") void finishUp();
			else {
				recorder.addEventListener("stop", () => void finishUp(), { once: true });
				recorder.stop();
			}
		});
		return stopped;
	}

	return { sync, stop };
}
