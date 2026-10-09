import type { Participant, Room, Track } from "livekit-client";
import { Api, getToken, getUsername, publicRequest } from "./api";
import { el } from "./dom";
import { t } from "./i18n";
import { onRealtime, type RealtimeEvent } from "./realtime";
import { reportError, toast } from "./ui";
import { canRecord, startRecorder, type CallRecorder } from "./call-recorder";
import { callControl } from "./call-controls";
import { icon } from "./storefront/icons";

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
				callControl(
					local.isMicrophoneEnabled ? "mic" : "mic_off",
					local.isMicrophoneEnabled ? t("calls.mute") : t("calls.unmute"),
					() => void toggle("microphone"),
					{
						tone: local.isMicrophoneEnabled ? "neutral" : "off",
						pressed: !local.isMicrophoneEnabled,
					}
				),
				callControl(
					local.isCameraEnabled ? "video" : "video_off",
					local.isCameraEnabled ? t("calls.camera_off") : t("calls.camera_on"),
					() => void toggle("camera"),
					{
						tone: local.isCameraEnabled ? "active" : "neutral",
						pressed: local.isCameraEnabled,
					}
				),
				callControl("screen", local.isScreenShareEnabled ? t("calls.stop_sharing") : t("calls.share_screen"), () => void toggle("screen"), {
					tone: local.isScreenShareEnabled ? "active" : "neutral",
					pressed: local.isScreenShareEnabled,
					disabled: (sharer !== undefined && sharer !== local) || !("getDisplayMedia" in navigator.mediaDevices),
				}),
				current.recordTarget && canRecord()
					? callControl(
							current.recorder ? "record_stop" : "record",
							current.recorder ? t("calls.record_stop") : t("calls.record"),
							() => void toggleRecording(current),
							{
								tone: current.recorder ? "off" : "neutral",
								pressed: current.recorder !== null,
								disabled: current.recorderStarting || (current.recorder === null && current.recordingBy !== null),
							}
						)
					: null,
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

async function toggle(kind: "microphone" | "camera" | "screen") {
	const room = session?.room;
	if (!room || livekit === null) return;
	const local = room.localParticipant;
	try {
		if (kind === "microphone") await local.setMicrophoneEnabled(!local.isMicrophoneEnabled);
		else if (kind === "camera") await local.setCameraEnabled(!local.isCameraEnabled);
		else {
			const source = livekit.Track.Source.ScreenShare;
			const someoneElse = [...room.remoteParticipants.values()].some(
				(participant) => participant.isScreenShareEnabled && participant.getTrackPublication(source)
			);
			if (!local.isScreenShareEnabled && someoneElse) return;
			await local.setScreenShareEnabled(!local.isScreenShareEnabled, { audio: false });
		}
	} catch {
		if (kind === "microphone") toast(t("calls.no_microphone"), "error");
		if (kind === "camera") toast(t("calls.no_camera"), "error");
	}
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
		const recorder = await startRecorder(room, livekit, { ...current.recordTarget, title: current.title }, () => void stopRecording(current));
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
		livekit = kit;
		if (session !== current) {
			options.leave(false);
			return false;
		}
		const room = new kit.Room({ adaptiveStream: true, dynacast: true });
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
