import type { Participant, Room, Track } from "livekit-client";
import { Api } from "./api";

const WIDTH = 1280;
const HEIGHT = 720;
const FRAMES_PER_SECOND = 10;
const SLICE_MS = 3000;
const VIDEO_BITS = 1_200_000;
const AUDIO_BITS = 64_000;
const PREFERRED_TYPES = ["video/webm;codecs=vp8,opus", "video/webm"];

type LiveKit = typeof import("livekit-client");

export interface CallRecorder {
	sync(): void;
	stop(): Promise<boolean>;
}

export function canRecord(): boolean {
	return typeof MediaRecorder !== "undefined" && PREFERRED_TYPES.some((type) => MediaRecorder.isTypeSupported(type));
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
	onFailure: () => void
): Promise<CallRecorder> {
	const type = PREFERRED_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate))!;
	const begun = await Api.beginRecording(target.project, target.conversation, type);

	const audio = new AudioContext();
	const destination = audio.createMediaStreamDestination();
	const sources = new Map<string, MediaStreamAudioSourceNode>();
	const canvas = document.createElement("canvas");
	canvas.width = WIDTH;
	canvas.height = HEIGHT;
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
		pen.fillRect(0, 0, WIDTH, HEIGHT);
		if (track && screen.videoWidth > 0) {
			const scale = Math.min(WIDTH / screen.videoWidth, HEIGHT / screen.videoHeight);
			const width = screen.videoWidth * scale;
			const height = screen.videoHeight * scale;
			pen.drawImage(screen, (WIDTH - width) / 2, (HEIGHT - height) / 2, width, height);
			return;
		}
		pen.fillStyle = "#e8eaed";
		pen.textAlign = "center";
		pen.font = "600 44px sans-serif";
		pen.fillText(target.title, WIDTH / 2, HEIGHT / 2 - 30, WIDTH - 120);
		pen.font = "26px sans-serif";
		pen.fillStyle = "#9aa1ac";
		const names = [room.localParticipant, ...room.remoteParticipants.values()].map((participant) => participant.name || participant.identity);
		pen.fillText(names.join(", "), WIDTH / 2, HEIGHT / 2 + 30, WIDTH - 120);
		pen.fillText(new Date().toLocaleTimeString(), WIDTH / 2, HEIGHT / 2 + 80);
	}

	sync();
	draw();
	const drawTimer = setInterval(draw, 1000 / FRAMES_PER_SECOND);
	const stream = new MediaStream([...canvas.captureStream(FRAMES_PER_SECOND).getVideoTracks(), ...destination.stream.getAudioTracks()]);
	const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: VIDEO_BITS, audioBitsPerSecond: AUDIO_BITS });

	let pending: Blob[] = [];
	let pendingBytes = 0;
	let partIndex = 0;
	let failed = false;
	let uploads: Promise<void> = Promise.resolve();
	let stopped: Promise<boolean> | null = null;

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

	recorder.addEventListener("dataavailable", (event) => {
		if (event.data.size === 0) return;
		pending.push(event.data);
		pendingBytes += event.data.size;
		cutParts(false);
	});
	recorder.start(SLICE_MS);

	function stop(): Promise<boolean> {
		stopped ??= new Promise<boolean>((resolve) => {
			const finishUp = async () => {
				clearInterval(drawTimer);
				shownTrack?.detach(screen);
				for (const source of sources.values()) source.disconnect();
				for (const track of stream.getTracks()) track.stop();
				void audio.close().catch(() => undefined);
				cutParts(true);
				await uploads;
				try {
					resolve((await Api.finishRecording(target.project, begun.uuid)).kept && !failed);
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
