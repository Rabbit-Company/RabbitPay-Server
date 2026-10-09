import type { Participant, Room, Track } from "livekit-client";
import { Api, getToken, getUsername, publicRequest, type CameraQuality, type ScreenShareQuality } from "./api";
import { el } from "./dom";
import { t } from "./i18n";
import { onRealtime, type RealtimeEvent } from "./realtime";
import { reportError, toast } from "./ui";
import { canRecord, RECORDING_SIZES, recordingSize, startRecorder, type CallRecorder, type RecordingSize, type RecordingSource } from "./call-recorder";
import { callControl, controlPick, qualityPick, splitControl } from "./call-controls";
import { icon } from "./storefront/icons";
import {
	CAMERA_PRESETS,
	cameraQuality,
	cameraSize,
	chooseCameraSize,
	chooseShareSize,
	namedDevices,
	rememberDevice,
	rememberedDevice,
	SHARE_PRESETS,
	SHARE_SIZES,
	shareQuality,
	shareSize,
	type DeviceKind,
	type ShareSize,
} from "./call-preferences";

const GUEST_PREFIX = "guest-";
const CHAT_TOPIC = "chat";
const RECORDING_TOPIC = "recording";
const MAX_CHAT_LENGTH = 500;
const MAX_CHAT_LINES = 200;

interface ChatLine {
	from: string;
	text: string;
}

interface RoomTicket {
	url: string;
	token: string;
	screen_share: ScreenShareQuality;
	camera: CameraQuality;
}

interface GroupSession {
	conversation: string | null;
	title: string;
	leave: (keepalive: boolean) => void;
	closed: () => void;
	lines: ChatLine[];
	chatOpen: boolean;
	chatUnread: boolean;
	recordTarget: { project: string; conversation: string } | null;
	recorder: CallRecorder | null;
	recorderStarting: boolean;
	recordSize: RecordingSize;
	shareSize: ShareSize;
	shareLimits: ScreenShareQuality;
	cameraSize: ShareSize;
	cameraLimits: CameraQuality;
	devices: Record<DeviceKind, MediaDeviceInfo[]>;
	recordingBy: string | null;
	room: Room | null;
	stage: "connecting" | "connected" | "reconnecting";
	joinedAt: number | null;
	expanded: boolean;
	theater: boolean;
	quiet: boolean;
	focus: string | null;
}

type LiveKit = typeof import("livekit-client");

let session: GroupSession | null = null;
let livekit: LiveKit | null = null;
let panel: HTMLElement | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let listening = false;
let renderQueued = false;
let chatField: HTMLInputElement | null = null;
let nativeTheater = false;
const videos = new Map<string, HTMLVideoElement>();
const audioHost = el("div", { class: "call-audio" });
audioHost.hidden = true;

export function inGroupCall(): boolean {
	return session !== null;
}

export function groupCallConversation(): string | null {
	return session?.conversation ?? null;
}

function videoFor(track: Track): HTMLVideoElement {
	const key = track.sid ?? track.mediaStreamTrack.id;
	let video = videos.get(key);
	if (!video) {
		video = el("video", {});
		video.autoplay = true;
		video.playsInline = true;
		video.muted = true;
		track.attach(video);
		videos.set(key, video);
	}
	return video;
}

function elapsed(current: GroupSession): string {
	if (current.stage === "connecting") return t("calls.connecting");
	if (current.stage === "reconnecting") return t("calls.reconnecting");
	const seconds = Math.floor((Date.now() - (current.joinedAt ?? Date.now())) / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function nameOf(participant: Participant): string {
	const name = participant.name || participant.identity;
	return participant.identity.startsWith(GUEST_PREFIX) ? `${name} (${t("calls.guest")})` : name;
}

function chatBox(current: GroupSession): HTMLElement {
	const list = el(
		"div",
		{ class: "call-chat-lines" },
		...(current.lines.length === 0
			? [el("p", { class: "muted" }, t("calls.chat_hint"))]
			: current.lines.map((line) => el("p", {}, el("strong", {}, `${line.from}: `), line.text)))
	);
	chatField ??= el("input", { type: "text", maxlength: String(MAX_CHAT_LENGTH), placeholder: t("chat.write_message") });
	const box = chatField;
	box.setAttribute("aria-label", t("chat.write_message"));
	const form = el(
		"form",
		{
			class: "call-chat-form",
			onSubmit: (event) => {
				event.preventDefault();
				const text = box.value.trim();
				const room = current.room;
				if (text === "" || room === null) return;
				box.value = "";
				void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ text })), { reliable: true, topic: CHAT_TOPIC });
				addLine(current, t("chat.you"), text);
			},
		},
		box,
		el("button", { class: "button ghost", type: "submit" }, t("chat.send"))
	);
	requestAnimationFrame(() => {
		list.scrollTop = list.scrollHeight;
	});
	return el("div", { class: "call-chat" }, list, form);
}

function addLine(current: GroupSession, from: string, text: string) {
	current.lines.push({ from, text: text.slice(0, MAX_CHAT_LENGTH) });
	if (current.lines.length > MAX_CHAT_LINES) current.lines.shift();
	if (!current.chatOpen || current.theater) current.chatUnread = true;
	render();
}

async function refreshDevices(current: GroupSession) {
	if (livekit === null) return;
	try {
		current.devices = namedDevices(await livekit.Room.getLocalDevices(undefined, false));
		queueRender();
	} catch {
		void 0;
	}
}

async function switchDevice(current: GroupSession, kind: DeviceKind, device: string) {
	try {
		await current.room?.switchActiveDevice(kind, device);
		rememberDevice(kind, device);
	} catch {
		toast(t(kind === "audioinput" ? "calls.no_microphone" : "calls.no_camera"), "error");
	}
	queueRender();
}

function withDevices(current: GroupSession, kind: DeviceKind, main: HTMLElement, ...picks: HTMLElement[]): HTMLElement {
	const devices = current.devices[kind];
	if (devices.length < 2 || current.room === null) return picks.length > 0 ? splitControl(main, ...picks) : main;
	return splitControl(
		main,
		...picks,
		controlPick(
			t(kind === "audioinput" ? "calls.microphone_source" : "calls.camera_source"),
			devices.map((device) => ({ value: device.deviceId, label: device.label })),
			current.room.getActiveDevice(kind) ?? devices[0].deviceId,
			false,
			(device) => void switchDevice(current, kind, device)
		)
	);
}

function recordControl(current: GroupSession): HTMLElement {
	const record = callControl(
		current.recorder ? "record_stop" : "record",
		current.recorder ? t("calls.record_stop") : t("calls.record"),
		() => void toggleRecording(current),
		{
			tone: current.recorder ? "off" : "neutral",
			pressed: current.recorder !== null,
			disabled: current.recorderStarting || (current.recorder === null && current.recordingBy !== null),
		}
	);
	if (current.recorder) return record;
	return splitControl(
		record,
		qualityPick(t("calls.record_quality"), RECORDING_SIZES, current.recordSize, current.recorderStarting || current.recordingBy !== null, (size) => {
			current.recordSize = size;
		})
	);
}

function shareControl(current: GroupSession, sharing: boolean, disabled: boolean): HTMLElement {
	const share = callControl("screen", sharing ? t("calls.stop_sharing") : t("calls.share_screen"), () => void toggle("screen"), {
		tone: sharing ? "active" : "neutral",
		pressed: sharing,
		disabled,
	});
	if (sharing) return share;
	return splitControl(
		share,
		qualityPick(t("calls.share_quality"), SHARE_SIZES, current.shareSize, disabled, (size) => {
			current.shareSize = size;
			chooseShareSize(size);
		})
	);
}

function markSpeakers() {
	const room = session?.room;
	if (!room || panel === null) return;
	const speaking = new Set(room.activeSpeakers.map((participant) => participant.identity));
	for (const node of panel.querySelectorAll<HTMLElement>(".call-tile")) node.classList.toggle("speaking", speaking.has(node.dataset.identity ?? ""));
}

function leaveNativeTheater() {
	if (panel !== null && document.fullscreenElement === panel) void document.exitFullscreen().catch(() => undefined);
}

function setTheater(current: GroupSession, on: boolean, focus: string | null = null) {
	current.theater = on;
	current.quiet = false;
	current.focus = on ? focus : null;
	render();
	if (!on) leaveNativeTheater();
	else if (panel !== null && document.fullscreenEnabled) void panel.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
}

function onFullscreenChange() {
	if (panel !== null && document.fullscreenElement === panel) {
		nativeTheater = true;
		return;
	}
	if (!nativeTheater) return;
	nativeTheater = false;
	if (session?.theater) {
		session.theater = false;
		session.focus = null;
		render();
	}
}

function cameraOf(participant: Participant, source: LiveKit["Track"]["Source"]): Track | null {
	const camera = participant.getTrackPublication(source.Camera)?.track ?? null;
	return participant.isCameraEnabled ? camera : null;
}

function tile(participant: Participant, own: boolean, source: LiveKit["Track"]["Source"], staged: boolean, maximize: () => void): HTMLElement {
	const camera = staged ? null : cameraOf(participant, source);
	const showsVideo = camera !== null;
	const name = own ? t("chat.you") : nameOf(participant);
	const video = showsVideo ? videoFor(camera) : null;
	if (video) video.className = `call-tile-video${own ? " own" : ""}`;
	return el(
		"div",
		{ class: `call-tile${participant.isSpeaking ? " speaking" : ""}`, dataset: { identity: participant.identity } },
		video ?? el("span", { class: "call-avatar" }, (participant.name || participant.identity).slice(0, 1).toUpperCase()),
		el(
			"span",
			{ class: "call-tile-name", title: participant.isMicrophoneEnabled ? name : `${name} | ${t("calls.muted")}` },
			participant.isMicrophoneEnabled ? null : icon("mic_off", 12, "call-tile-muted"),
			name
		),
		video && !own ? callControl("fullscreen", t("calls.full_screen"), maximize, { extraClass: "call-stage-action call-tile-action" }) : null
	);
}

function render() {
	renderQueued = false;
	const current = session;
	if (current === null) {
		panel?.remove();
		panel = null;
		if (clock !== null) clearInterval(clock);
		clock = null;
		videos.clear();
		audioHost.replaceChildren();
		chatField = null;
		return;
	}
	const typing = chatField !== null && document.activeElement === chatField;
	const recordingNote = current.recorder ? t("calls.recording_you") : current.recordingBy ? t("calls.recording_by", { name: current.recordingBy }) : null;
	const head = el(
		"div",
		{ class: "call-head" },
		el("strong", { class: "call-peer" }, current.title),
		recordingNote ? el("span", { class: "call-recording" }, recordingNote) : null,
		el("span", { class: "call-status" }, elapsed(current))
	);
	current.recorder?.sync();
	let body: HTMLElement;
	const room = current.room;
	if (room === null || livekit === null) {
		body = el(
			"div",
			{ class: "call-controls" },
			callControl("hang_up", t("calls.leave"), () => void leaveGroupCall(), { tone: "danger" })
		);
	} else {
		const source = livekit.Track.Source;
		const local = room.localParticipant;
		const everyone: Participant[] = [local, ...room.remoteParticipants.values()];
		const sharer = everyone.find((participant) => participant.isScreenShareEnabled && participant.getTrackPublication(source.ScreenShare)?.track);
		const shared = sharer?.getTrackPublication(source.ScreenShare)?.track ?? null;
		const focused = everyone.find((participant) => participant !== local && participant.identity === current.focus && cameraOf(participant, source));
		const staged = (focused ? cameraOf(focused, source) : null) ?? shared;
		const sharedVideo = staged ? videoFor(staged) : null;
		if (sharedVideo) sharedVideo.className = "call-video-main";
		const tiles = everyone.map((participant) =>
			tile(participant, participant === local, source, participant === focused, () => setTheater(current, true, participant.identity))
		);
		const used = new Set<HTMLVideoElement>([...(sharedVideo ? [sharedVideo] : []), ...tiles.flatMap((node) => [...node.querySelectorAll("video")])]);
		for (const [key, video] of videos) if (!used.has(video)) videos.delete(key);
		const watching = sharedVideo !== null && (focused !== undefined || sharer !== local);
		if (current.theater && (!watching || (current.focus !== null && !focused))) {
			current.theater = false;
			leaveNativeTheater();
		}
		if (!current.theater) current.focus = null;
		const theater = current.theater;
		const stage = sharedVideo
			? el(
					"div",
					{
						class: "call-stage",
						onClick: (event) => {
							if (!current.theater || (event.target as Element).closest("button")) return;
							current.quiet = !current.quiet;
							panel?.classList.toggle("quiet", current.quiet);
						},
					},
					sharedVideo,
					watching
						? callControl(
								theater ? "fullscreen_exit" : "fullscreen",
								theater ? t("calls.exit_full_screen") : t("calls.full_screen"),
								() => setTheater(current, !theater),
								{ pressed: theater, extraClass: "call-stage-action" }
							)
						: null
				)
			: null;
		const sharingNote = sharer ? (sharer === local ? t("calls.you_share") : t("calls.they_share", { name: nameOf(sharer) })) : null;
		body = el(
			"div",
			{ class: "call-body" },
			stage
				? el("div", { class: "call-group" }, stage, el("div", { class: "call-strip" }, ...tiles))
				: el("div", { class: `call-grid people-${Math.min(everyone.length, 9)}` }, ...tiles),
			sharingNote ? el("p", { class: "call-sharing muted" }, sharingNote) : null,
			current.chatOpen ? chatBox(current) : null,
			el(
				"div",
				{ class: "call-controls" },
				withDevices(
					current,
					"audioinput",
					callControl(
						local.isMicrophoneEnabled ? "mic" : "mic_off",
						local.isMicrophoneEnabled ? t("calls.mute") : t("calls.unmute"),
						() => void toggle("microphone"),
						{
							tone: local.isMicrophoneEnabled ? "neutral" : "off",
							pressed: !local.isMicrophoneEnabled,
						}
					)
				),
				withDevices(
					current,
					"videoinput",
					callControl(
						local.isCameraEnabled ? "video" : "video_off",
						local.isCameraEnabled ? t("calls.camera_off") : t("calls.camera_on"),
						() => void toggle("camera"),
						{
							tone: local.isCameraEnabled ? "active" : "neutral",
							pressed: local.isCameraEnabled,
						}
					),
					qualityPick(t("calls.camera_quality"), SHARE_SIZES, current.cameraSize, false, (size) => void changeCameraQuality(current, size))
				),
				shareControl(current, local.isScreenShareEnabled, (sharer !== undefined && sharer !== local) || !("getDisplayMedia" in navigator.mediaDevices)),
				current.recordTarget && canRecord() ? recordControl(current) : null,
				callControl(
					"message",
					current.chatUnread ? t("calls.chat_new") : t("nav.chat"),
					() => {
						current.chatOpen = theater || !current.chatOpen;
						current.chatUnread = false;
						if (theater) setTheater(current, false);
						else render();
						if (current.chatOpen) chatField?.focus();
					},
					{ tone: current.chatOpen && !theater ? "active" : "neutral", pressed: current.chatOpen && !theater, badge: current.chatUnread }
				),
				theater
					? null
					: callControl(current.expanded ? "shrink" : "expand", current.expanded ? t("calls.smaller") : t("calls.larger"), () => {
							current.expanded = !current.expanded;
							render();
						}),
				callControl("hang_up", t("calls.leave"), () => void leaveGroupCall(), { tone: "danger" })
			)
		);
	}
	if (panel === null) {
		panel = el("div", {});
		panel.setAttribute("role", "dialog");
		document.body.appendChild(panel);
	}
	panel.className = `call-panel call-panel-group${current.expanded ? " expanded" : ""}${current.theater ? " theater" : ""}${current.theater && current.quiet ? " quiet" : ""}`;
	panel.dataset.stage = current.stage;
	panel.setAttribute("aria-label", t("calls.title", { name: current.title }));
	panel.replaceChildren(head, body, audioHost);
	if (typing && chatField?.isConnected) chatField.focus({ preventScroll: true });
	clock ??= setInterval(() => {
		const shown = panel?.querySelector(".call-status");
		if (shown && session) shown.textContent = elapsed(session);
	}, 1000);
}

function queueRender() {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(render);
}

async function publishCamera(current: GroupSession, room: Room) {
	const quality = cameraQuality(current.cameraSize, current.cameraLimits);
	await room.localParticipant.setCameraEnabled(
		true,
		{ resolution: { width: quality.width, height: quality.height, frameRate: quality.frames_per_second } },
		{
			videoEncoding: { maxBitrate: quality.kbps * 1000, maxFramerate: quality.frames_per_second },
			videoCodec: livekit?.supportsVP9() ? "vp9" : "vp8",
			backupCodec: true,
		}
	);
}

async function changeCameraQuality(current: GroupSession, size: ShareSize) {
	current.cameraSize = size;
	chooseCameraSize(size);
	const room = current.room;
	if (!room || livekit === null) return;
	const local = room.localParticipant;
	const published = local.getTrackPublication(livekit.Track.Source.Camera)?.track;
	if (!published) return;
	const shown = local.isCameraEnabled;
	try {
		await local.unpublishTrack(published, true);
		if (shown) await publishCamera(current, room);
	} catch {
		toast(t("calls.no_camera"), "error");
	}
	queueRender();
}

async function toggle(kind: "microphone" | "camera" | "screen") {
	const room = session?.room;
	if (!room || livekit === null) return;
	const local = room.localParticipant;
	try {
		if (kind === "microphone") await local.setMicrophoneEnabled(!local.isMicrophoneEnabled);
		else if (kind === "camera") {
			if (local.isCameraEnabled) await local.setCameraEnabled(false);
			else if (session) await publishCamera(session, room);
		} else {
			const source = livekit.Track.Source.ScreenShare;
			const someoneElse = [...room.remoteParticipants.values()].some(
				(participant) => participant.isScreenShareEnabled && participant.getTrackPublication(source)
			);
			if (!local.isScreenShareEnabled && someoneElse) return;
			if (local.isScreenShareEnabled) await local.setScreenShareEnabled(false);
			else {
				const quality = shareQuality(session?.shareSize ?? "high", session?.shareLimits ?? SHARE_PRESETS.high);
				await local.setScreenShareEnabled(
					true,
					{ audio: false, resolution: { width: quality.width, height: quality.height, frameRate: quality.frames_per_second } },
					{
						screenShareEncoding: { maxBitrate: quality.kbps * 1000, maxFramerate: quality.frames_per_second },
						videoCodec: livekit.supportsVP9() ? "vp9" : "vp8",
						backupCodec: true,
					}
				);
			}
		}
	} catch {
		if (kind === "microphone") toast(t("calls.no_microphone"), "error");
		if (kind === "camera") toast(t("calls.no_camera"), "error");
	}
	if (session && kind !== "screen") void refreshDevices(session);
	queueRender();
}

function yieldScreen(room: Room, kit: LiveKit) {
	const source = kit.Track.Source.ScreenShare;
	const local = room.localParticipant;
	if (!local.isScreenShareEnabled) return;
	const mine = local.getTrackPublication(source);
	const earlier = [...room.remoteParticipants.values()].some((participant) => {
		const theirs = participant.getTrackPublication(source);
		return participant.isScreenShareEnabled && theirs !== undefined && participant.identity < local.identity && mine !== undefined;
	});
	if (earlier) void local.setScreenShareEnabled(false);
}

function announceRecording(current: GroupSession, active: boolean) {
	void current.room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ active })), { reliable: true, topic: RECORDING_TOPIC });
}

async function stopRecording(current: GroupSession) {
	const recorder = current.recorder;
	if (recorder === null) return;
	current.recorder = null;
	announceRecording(current, false);
	queueRender();
	toast((await recorder.stop()) ? t("calls.recording_saved") : t("calls.recording_failed"), "info");
}

function recordingSource(room: Room, kit: LiveKit): RecordingSource {
	const everyone = (): Participant[] => [room.localParticipant, ...room.remoteParticipants.values()];
	return {
		audioTracks: () =>
			everyone().flatMap((participant) =>
				[...participant.audioTrackPublications.values()].flatMap((publication) => (publication.track ? [publication.track.mediaStreamTrack] : []))
			),
		screen: () => {
			for (const participant of everyone()) {
				const track = participant.getTrackPublication(kit.Track.Source.ScreenShare)?.track;
				if (participant.isScreenShareEnabled && track) return track.mediaStreamTrack;
			}
			return null;
		},
		names: () => everyone().map((participant) => participant.name || participant.identity),
	};
}

async function toggleRecording(current: GroupSession) {
	if (current.recorder) {
		await stopRecording(current);
		return;
	}
	const room = current.room;
	if (room === null || livekit === null || current.recordTarget === null || current.recorderStarting || current.recordingBy !== null) return;
	current.recorderStarting = true;
	queueRender();
	try {
		const recorder = await startRecorder(
			recordingSource(room, livekit),
			{ ...current.recordTarget, title: current.title },
			current.recordSize,
			() => void stopRecording(current)
		);
		if (session !== current || current.room !== room) {
			void recorder.stop();
			return;
		}
		current.recorder = recorder;
		announceRecording(current, true);
	} catch (error) {
		reportError(error);
	} finally {
		current.recorderStarting = false;
		queueRender();
	}
}

function finish(current: GroupSession, tellServer: boolean) {
	if (session !== current) return;
	session = null;
	const room = current.room;
	const recorder = current.recorder;
	current.recorder = null;
	if (recorder) {
		void room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ active: false })), { reliable: true, topic: RECORDING_TOPIC });
		void recorder.stop().then((kept) => toast(kept ? t("calls.recording_saved") : t("calls.recording_failed"), "info"));
	}
	current.room = null;
	void room?.disconnect();
	render();
	if (tellServer) current.leave(false);
	current.closed();
}

export async function leaveGroupCall() {
	if (session) finish(session, true);
}

export function dropGroupCall() {
	if (session) finish(session, false);
}

interface RoomOptions {
	conversation: string | null;
	title: string;
	expanded: boolean;
	ticket: () => Promise<RoomTicket>;
	leave: (keepalive: boolean) => void;
	closed?: () => void;
	recordTarget?: { project: string; conversation: string };
}

async function openRoom(options: RoomOptions): Promise<boolean> {
	watchGroupCalls();
	const current: GroupSession = {
		conversation: options.conversation,
		title: options.title,
		leave: options.leave,
		closed: options.closed ?? (() => undefined),
		lines: [],
		chatOpen: false,
		chatUnread: false,
		recordTarget: options.recordTarget ?? null,
		recorder: null,
		recorderStarting: false,
		recordSize: recordingSize(),
		shareSize: shareSize(),
		shareLimits: SHARE_PRESETS.high,
		cameraSize: cameraSize(),
		cameraLimits: CAMERA_PRESETS.high,
		devices: { audioinput: [], videoinput: [] },
		recordingBy: null,
		room: null,
		stage: "connecting",
		joinedAt: null,
		expanded: options.expanded,
		theater: false,
		quiet: false,
		focus: null,
	};
	session = current;
	render();
	let ticketed = false;
	try {
		const [kit, ticket] = await Promise.all([import("livekit-client"), options.ticket()]);
		ticketed = true;
		current.shareLimits = ticket.screen_share;
		current.cameraLimits = ticket.camera;
		livekit = kit;
		if (session !== current) {
			options.leave(false);
			return false;
		}
		const room = new kit.Room({
			adaptiveStream: true,
			dynacast: true,
			audioCaptureDefaults: { deviceId: rememberedDevice("audioinput") },
			videoCaptureDefaults: { deviceId: rememberedDevice("videoinput") },
		});
		room.on(kit.RoomEvent.MediaDevicesChanged, () => void refreshDevices(current));
		room.on(kit.RoomEvent.ActiveDeviceChanged, queueRender);
		current.room = room;
		const events = kit.RoomEvent;
		for (const event of [
			events.ParticipantConnected,
			events.ParticipantDisconnected,
			events.TrackMuted,
			events.TrackUnmuted,
			events.LocalTrackPublished,
			events.LocalTrackUnpublished,
			events.TrackUnpublished,
		]) {
			room.on(event, queueRender);
		}
		room.on(events.ActiveSpeakersChanged, markSpeakers);
		room.on(events.TrackSubscribed, (track) => {
			if (track.kind === kit.Track.Kind.Audio) audioHost.appendChild(track.attach());
			yieldScreen(room, kit);
			queueRender();
		});
		room.on(events.TrackUnsubscribed, (track) => {
			for (const element of track.detach()) if (element.parentElement === audioHost) element.remove();
			queueRender();
		});
		room.on(events.ParticipantConnected, () => {
			if (current.recorder) announceRecording(current, true);
		});
		room.on(events.ParticipantDisconnected, (participant) => {
			if (current.recordingBy !== null && current.recordingBy === nameOf(participant)) current.recordingBy = null;
		});
		room.on(events.DataReceived, (payload, participant, _kind, topic) => {
			if (topic === RECORDING_TOPIC && participant) {
				try {
					const active = (JSON.parse(new TextDecoder().decode(payload)) as { active?: unknown }).active === true;
					const name = nameOf(participant);
					if (active && current.recordingBy !== name) toast(t("calls.recording_by", { name }), "info");
					current.recordingBy = active ? name : current.recordingBy === name ? null : current.recordingBy;
					queueRender();
				} catch {
					void 0;
				}
				return;
			}
			if (topic !== CHAT_TOPIC || !participant) return;
			try {
				const text = (JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown }).text;
				if (typeof text === "string" && text.trim() !== "") addLine(current, nameOf(participant), text);
			} catch {
				void 0;
			}
		});
		room.on(events.Reconnecting, () => {
			current.stage = "reconnecting";
			queueRender();
		});
		room.on(events.Reconnected, () => {
			current.stage = "connected";
			queueRender();
		});
		room.on(events.Disconnected, () => {
			if (session !== current) return;
			toast(t("calls.ended"), "info");
			finish(current, true);
		});
		await room.connect(ticket.url, ticket.token);
		if (session !== current) {
			void room.disconnect();
			return false;
		}
		current.stage = "connected";
		current.joinedAt = Date.now();
		render();
		try {
			await room.localParticipant.setMicrophoneEnabled(true);
		} catch {
			toast(t("calls.no_microphone"), "error");
		}
		void refreshDevices(current);
		queueRender();
		return true;
	} catch (error) {
		if (session === current) finish(current, ticketed);
		reportError(error);
		return false;
	}
}

export async function joinGroupCall(project: string, conversation: string, title: string, busy: () => boolean) {
	if (session !== null || busy()) {
		toast(t("calls.already"), "error");
		return;
	}
	await openRoom({
		conversation,
		title,
		expanded: false,
		recordTarget: { project, conversation },
		ticket: () => Api.joinGroupCall(project, conversation),
		leave: (keepalive) => {
			const token = getToken();
			if (token === null) return;
			void fetch(`/api/v1/projects/${project}/chat/conversations/${conversation}/group-call/leave`, {
				method: "POST",
				keepalive,
				headers: { Authorization: `Bearer ${token}` },
			}).catch(() => undefined);
		},
	});
}

export async function joinAsGuest(meetingToken: string, name: string, title: string, closed: () => void): Promise<boolean> {
	if (session !== null) return false;
	let guest: string | null = null;
	return await openRoom({
		conversation: null,
		title,
		expanded: true,
		closed,
		ticket: async () => {
			const joined = await publicRequest<RoomTicket & { guest: string }>("POST", `/meetings/${meetingToken}/join`, { name });
			guest = joined.guest;
			return joined;
		},
		leave: (keepalive) => {
			if (guest === null) return;
			void fetch(`/api/v1/public/meetings/${meetingToken}/leave`, {
				method: "POST",
				keepalive,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ guest }),
			}).catch(() => undefined);
		},
	});
}

function onEvent(event: RealtimeEvent) {
	if (event.type !== "call.group") return;
	if (event.active === true && event.ring === true) {
		const info = event.info as { started_by: string } | null;
		if (info && session === null && event.starter !== getUsername()) toast(t("calls.group_started", { name: info.started_by }), "info");
		return;
	}
	if (event.active === false && session !== null && session.conversation === event.conversation) finish(session, false);
}

export function watchGroupCalls() {
	if (listening) return;
	listening = true;
	onRealtime(onEvent);
	document.addEventListener("fullscreenchange", onFullscreenChange);
	window.addEventListener("pagehide", () => session?.leave(true));
}
