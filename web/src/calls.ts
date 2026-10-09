import { Api, getToken, type ChatCallOutcome, type IceServer } from "./api";
import { el } from "./dom";
import { t } from "./i18n";
import { onRealtime, sendRealtime, type RealtimeEvent } from "./realtime";
import { reportError, toast } from "./ui";
import { dropGroupCall, inGroupCall, watchGroupCalls } from "./group-call";
import { callControl } from "./call-controls";

const CLIENT_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const FAILED_GRACE_MS = 20 * 1000;
const RING_INTERVAL_MS = 2200;

const clientId = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => CLIENT_CHARACTERS[value % CLIENT_CHARACTERS.length]).join("");

type Stage = "outgoing" | "incoming" | "connecting" | "connected" | "reconnecting";

interface PeerState {
	camera: boolean;
	screen: boolean;
	microphone: boolean;
}

interface ActiveCall {
	id: string;
	project: string;
	conversation: string;
	peerName: string;
	caller: boolean;
	stage: Stage;
	wantsVideo: boolean;
	connection: RTCPeerConnection | null;
	iceServers: IceServer[];
	microphone: MediaStreamTrack | null;
	camera: MediaStreamTrack | null;
	screen: MediaStreamTrack | null;
	muted: boolean;
	remote: PeerState;
	pendingCandidates: RTCIceCandidateInit[];
	unsent: RealtimeEvent[];
	connectedAt: number | null;
	failTimer: ReturnType<typeof setTimeout> | null;
	restarted: boolean;
}

let active: ActiveCall | null = null;
let listening = false;
let panel: HTMLElement | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let ringer: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;

const remoteAudio = el("audio", {});
remoteAudio.autoplay = true;
const mainVideo = el("video", { class: "call-video-main" });
mainVideo.autoplay = true;
mainVideo.playsInline = true;
mainVideo.muted = true;
const sideVideo = el("video", { class: "call-video-side" });
sideVideo.autoplay = true;
sideVideo.playsInline = true;
sideVideo.muted = true;
const selfVideo = el("video", { class: "call-video-self" });
selfVideo.autoplay = true;
selfVideo.playsInline = true;
selfVideo.muted = true;

function beep() {
	try {
		audioContext ??= new AudioContext();
		const oscillator = audioContext.createOscillator();
		const gain = audioContext.createGain();
		oscillator.frequency.value = 520;
		gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.05);
		gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.9);
		oscillator.connect(gain).connect(audioContext.destination);
		oscillator.start();
		oscillator.stop(audioContext.currentTime + 1);
	} catch {
		void 0;
	}
}

function startRinging() {
	stopRinging();
	beep();
	ringer = setInterval(beep, RING_INTERVAL_MS);
}

function stopRinging() {
	if (ringer !== null) clearInterval(ringer);
	ringer = null;
}

function streamOf(track: MediaStreamTrack | null | undefined): MediaStream | null {
	return track ? new MediaStream([track]) : null;
}

function show(video: HTMLVideoElement, track: MediaStreamTrack | null | undefined) {
	const current = (video.srcObject as MediaStream | null)?.getTracks()[0] ?? null;
	if (current === (track ?? null)) return;
	video.srcObject = streamOf(track);
}

function remoteTrack(call: ActiveCall, index: number): MediaStreamTrack | null {
	return call.connection?.getTransceivers()[index]?.receiver.track ?? null;
}

function duration(call: ActiveCall): string {
	if (call.connectedAt === null) return "";
	const seconds = Math.floor((Date.now() - call.connectedAt) / 1000);
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function statusText(call: ActiveCall): string {
	if (call.stage === "outgoing") return t("calls.calling");
	if (call.stage === "incoming") return call.wantsVideo ? t("calls.incoming_video") : t("calls.incoming");
	if (call.stage === "connecting") return t("calls.connecting");
	if (call.stage === "reconnecting") return t("calls.reconnecting");
	return duration(call);
}

function render() {
	const call = active;
	if (call === null) {
		panel?.remove();
		panel = null;
		if (clock !== null) clearInterval(clock);
		clock = null;
		for (const video of [mainVideo, sideVideo, selfVideo]) video.srcObject = null;
		remoteAudio.srcObject = null;
		return;
	}
	const expanded = panel?.classList.contains("expanded") ?? false;
	const status = el("span", { class: "call-status" }, statusText(call));
	const head = el("div", { class: "call-head" }, el("strong", { class: "call-peer" }, call.peerName), status);

	let body: HTMLElement;
	if (call.stage === "incoming") {
		body = el(
			"div",
			{ class: "call-controls" },
			callControl("phone", t("calls.accept"), () => void accept(false), { tone: "accept" }),
			callControl("video", t("calls.accept_video"), () => void accept(true), { tone: "accept" }),
			callControl("hang_up", t("calls.decline"), () => void hangUp(), { tone: "danger" })
		);
	} else if (call.stage === "outgoing") {
		body = el(
			"div",
			{ class: "call-controls" },
			callControl("hang_up", t("calls.cancel"), () => void hangUp(), { tone: "danger" })
		);
	} else {
		const remoteScreen = call.remote.screen ? remoteTrack(call, 2) : null;
		const remoteCamera = call.remote.camera ? remoteTrack(call, 1) : null;
		const main = remoteScreen ?? call.screen ?? remoteCamera;
		const side = main !== remoteCamera ? remoteCamera : null;
		show(mainVideo, main);
		show(sideVideo, side);
		show(selfVideo, call.camera);
		show(remoteAudio as unknown as HTMLVideoElement, remoteTrack(call, 0));
		mainVideo.hidden = main === null;
		sideVideo.hidden = side === null;
		selfVideo.hidden = call.camera === null;
		const sharingNote = call.screen ? t("calls.you_share") : call.remote.screen ? t("calls.they_share", { name: call.peerName }) : null;
		body = el(
			"div",
			{ class: "call-body" },
			el(
				"div",
				{ class: `call-stage${main === null ? " empty" : ""}` },
				main === null ? el("span", { class: "call-avatar" }, call.peerName.slice(0, 1).toUpperCase()) : null,
				mainVideo,
				el("div", { class: "call-thumbs" }, sideVideo, selfVideo),
				call.remote.microphone ? null : el("span", { class: "call-note" }, t("calls.they_muted", { name: call.peerName }))
			),
			sharingNote ? el("p", { class: "call-sharing muted" }, sharingNote) : null,
			el(
				"div",
				{ class: "call-controls" },
				callControl(call.muted ? "mic_off" : "mic", call.muted ? t("calls.unmute") : t("calls.mute"), toggleMicrophone, {
					tone: call.muted ? "off" : "neutral",
					pressed: call.muted,
				}),
				callControl(call.camera ? "video" : "video_off", call.camera ? t("calls.camera_off") : t("calls.camera_on"), () => void toggleCamera(), {
					tone: call.camera ? "active" : "neutral",
					pressed: call.camera !== null,
				}),
				callControl("screen", call.screen ? t("calls.stop_sharing") : t("calls.share_screen"), () => void toggleScreen(), {
					tone: call.screen ? "active" : "neutral",
					pressed: call.screen !== null,
					disabled: call.remote.screen || !("getDisplayMedia" in navigator.mediaDevices),
				}),
				callControl(expanded ? "shrink" : "expand", expanded ? t("calls.smaller") : t("calls.larger"), toggleExpanded),
				callControl("hang_up", t("calls.hang_up"), () => void hangUp(), { tone: "danger" })
			)
		);
	}

	const next = el("div", { class: `call-panel${expanded ? " expanded" : ""}`, dataset: { stage: call.stage } }, head, body, remoteAudio);
	next.setAttribute("role", "dialog");
	next.setAttribute("aria-label", t("calls.title", { name: call.peerName }));
	if (panel) panel.replaceWith(next);
	else document.body.appendChild(next);
	panel = next;

	if (clock === null) {
		clock = setInterval(() => {
			const shown = panel?.querySelector(".call-status");
			if (shown && active) shown.textContent = statusText(active);
		}, 1000);
	}
}

function toggleExpanded() {
	panel?.classList.toggle("expanded");
	render();
}

function signal(call: ActiveCall, data: Record<string, unknown>) {
	const event = { type: "call.signal", call: call.id, client: clientId, data };
	if (call.unsent.length > 0 || !sendRealtime(event)) call.unsent.push(event);
}

function flush(call: ActiveCall) {
	while (call.unsent.length > 0 && sendRealtime(call.unsent[0])) call.unsent.shift();
}

function announceState(call: ActiveCall) {
	signal(call, { state: { camera: call.camera !== null, screen: call.screen !== null, microphone: !call.muted } });
}

function cleanup(call: ActiveCall) {
	stopRinging();
	if (call.failTimer !== null) clearTimeout(call.failTimer);
	for (const track of [call.microphone, call.camera, call.screen]) track?.stop();
	call.connection?.close();
	if (active === call) active = null;
	render();
}

async function hangUp() {
	const call = active;
	if (call === null) return;
	cleanup(call);
	try {
		await Api.endChatCall(call.project, call.id);
	} catch {
		void 0;
	}
}

function watchConnection(call: ActiveCall, connection: RTCPeerConnection) {
	connection.addEventListener("icecandidate", (event) => {
		if (event.candidate) signal(call, { candidate: event.candidate.toJSON() });
	});
	connection.addEventListener("track", () => render());
	connection.addEventListener("connectionstatechange", () => {
		if (active !== call) return;
		const state = connection.connectionState;
		if (state === "connected") {
			if (call.failTimer !== null) clearTimeout(call.failTimer);
			call.failTimer = null;
			call.restarted = false;
			call.connectedAt ??= Date.now();
			call.stage = "connected";
			announceState(call);
			render();
			return;
		}
		if (state !== "disconnected" && state !== "failed") return;
		call.stage = call.connectedAt === null ? "connecting" : "reconnecting";
		render();
		if (state === "failed" && call.caller && !call.restarted) {
			call.restarted = true;
			void offer(call, true);
		}
		call.failTimer ??= setTimeout(() => {
			if (active !== call || connection.connectionState === "connected") return;
			toast(t("calls.lost"), "error");
			void hangUp();
		}, FAILED_GRACE_MS);
	});
}

function connect(call: ActiveCall): RTCPeerConnection {
	const connection = new RTCPeerConnection({ iceServers: call.iceServers });
	call.connection = connection;
	watchConnection(call, connection);
	return connection;
}

async function offer(call: ActiveCall, iceRestart = false) {
	const connection = call.connection;
	if (!connection) return;
	try {
		await connection.setLocalDescription(await connection.createOffer({ iceRestart }));
		signal(call, { description: connection.localDescription!.toJSON() });
	} catch (error) {
		reportError(error);
	}
}

async function begin(call: ActiveCall) {
	const connection = connect(call);
	connection.addTransceiver(call.microphone ?? "audio", { direction: "sendrecv" });
	connection.addTransceiver(call.camera ?? "video", { direction: "sendrecv" });
	connection.addTransceiver("video", { direction: "sendrecv" });
	await offer(call);
}

async function answer(call: ActiveCall, description: RTCSessionDescriptionInit) {
	const connection = call.connection ?? connect(call);
	await connection.setRemoteDescription(description);
	const [audio, camera, screen] = connection.getTransceivers();
	for (const transceiver of [audio, camera, screen]) if (transceiver) transceiver.direction = "sendrecv";
	await audio?.sender.replaceTrack(call.microphone);
	await camera?.sender.replaceTrack(call.camera);
	await screen?.sender.replaceTrack(call.screen);
	await connection.setLocalDescription(await connection.createAnswer());
	signal(call, { description: connection.localDescription!.toJSON() });
	await drainCandidates(call);
}

async function drainCandidates(call: ActiveCall) {
	const connection = call.connection;
	if (!connection?.remoteDescription) return;
	for (const candidate of call.pendingCandidates.splice(0)) await connection.addIceCandidate(candidate).catch(() => undefined);
}

async function onSignal(call: ActiveCall, data: Record<string, unknown>) {
	try {
		if (data.description) {
			const description = data.description as RTCSessionDescriptionInit;
			if (description.type === "offer") await answer(call, description);
			else if (call.connection) {
				await call.connection.setRemoteDescription(description);
				await drainCandidates(call);
			}
		}
		if (data.candidate) {
			call.pendingCandidates.push(data.candidate as RTCIceCandidateInit);
			await drainCandidates(call);
		}
		if (data.state) {
			const state = data.state as PeerState;
			call.remote = { camera: state.camera === true, screen: state.screen === true, microphone: state.microphone !== false };
			if (call.remote.screen && call.screen && !call.caller) await stopScreen(call);
			render();
		}
	} catch (error) {
		reportError(error);
	}
}

async function microphone(): Promise<MediaStreamTrack | null> {
	try {
		return (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0] ?? null;
	} catch {
		toast(t("calls.no_microphone"), "error");
		return null;
	}
}

async function cameraTrack(): Promise<MediaStreamTrack | null> {
	try {
		return (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })).getVideoTracks()[0] ?? null;
	} catch {
		toast(t("calls.no_camera"), "error");
		return null;
	}
}

function toggleMicrophone() {
	const call = active;
	if (call === null || call.microphone === null) return;
	call.muted = !call.muted;
	call.microphone.enabled = !call.muted;
	announceState(call);
	render();
}

async function toggleCamera() {
	const call = active;
	if (call === null || call.connection === null) return;
	const sender = call.connection.getTransceivers()[1]?.sender;
	if (call.camera) {
		call.camera.stop();
		call.camera = null;
	} else {
		call.camera = await cameraTrack();
	}
	if (active !== call) return;
	await sender?.replaceTrack(call.camera);
	announceState(call);
	render();
}

async function stopScreen(call: ActiveCall) {
	call.screen?.stop();
	call.screen = null;
	await call.connection?.getTransceivers()[2]?.sender.replaceTrack(null);
	announceState(call);
	render();
}

async function toggleScreen() {
	const call = active;
	if (call === null || call.connection === null) return;
	if (call.screen) {
		await stopScreen(call);
		return;
	}
	if (call.remote.screen) return;
	let track: MediaStreamTrack | null = null;
	try {
		track = (await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })).getVideoTracks()[0] ?? null;
	} catch {
		return;
	}
	if (track === null) return;
	if (active !== call || call.remote.screen) {
		track.stop();
		return;
	}
	call.screen = track;
	track.addEventListener("ended", () => {
		if (call.screen === track) void stopScreen(call);
	});
	await call.connection.getTransceivers()[2]?.sender.replaceTrack(track);
	announceState(call);
	render();
}

function newCall(values: Pick<ActiveCall, "id" | "project" | "conversation" | "peerName" | "caller" | "stage" | "wantsVideo">): ActiveCall {
	return {
		...values,
		connection: null,
		iceServers: [],
		microphone: null,
		camera: null,
		screen: null,
		muted: false,
		remote: { camera: false, screen: false, microphone: true },
		pendingCandidates: [],
		unsent: [],
		connectedAt: null,
		failTimer: null,
		restarted: false,
	};
}

export function inCall(): boolean {
	return active !== null;
}

export async function startCall(project: string, conversation: string, peerName: string, video: boolean) {
	if (active !== null || inGroupCall()) {
		toast(t("calls.already"), "error");
		return;
	}
	watchCalls();
	const call = newCall({ id: "", project, conversation, peerName, caller: true, stage: "outgoing", wantsVideo: video });
	active = call;
	render();
	call.microphone = await microphone();
	if (call.microphone === null) {
		cleanup(call);
		return;
	}
	if (video) call.camera = await cameraTrack();
	if (active !== call) {
		cleanup(call);
		return;
	}
	try {
		const started = await Api.startChatCall(project, conversation, clientId, video);
		call.id = started.call;
		call.iceServers = started.ice_servers;
		if (active !== call) await Api.endChatCall(project, started.call).catch(() => undefined);
	} catch (error) {
		cleanup(call);
		reportError(error);
	}
}

async function accept(video: boolean) {
	const call = active;
	if (call === null || call.stage !== "incoming") return;
	stopRinging();
	call.stage = "connecting";
	render();
	call.microphone = await microphone();
	if (call.microphone === null) {
		await hangUp();
		return;
	}
	if (video) call.camera = await cameraTrack();
	if (active !== call) {
		cleanup(call);
		return;
	}
	try {
		call.iceServers = (await Api.acceptChatCall(call.project, call.id, clientId)).ice_servers;
	} catch (error) {
		cleanup(call);
		reportError(error);
	}
}

const ENDED_TEXT: Record<ChatCallOutcome, "calls.ended" | "calls.missed_toast" | "calls.declined_toast" | "calls.ended"> = {
	answered: "calls.ended",
	missed: "calls.missed_toast",
	declined: "calls.declined_toast",
	cancelled: "calls.ended",
};

function onEvent(event: RealtimeEvent) {
	if (event.type === "realtime.ready") {
		if (active) flush(active);
		return;
	}
	if (!event.type.startsWith("call.") || typeof event.call !== "string") return;

	if (event.type === "call.incoming") {
		if (active !== null) return;
		if (inGroupCall()) {
			void Api.endChatCall(String(event.project), event.call).catch(() => undefined);
			return;
		}
		const from = event.from as { account: string; name: string };
		active = newCall({
			id: event.call,
			project: String(event.project),
			conversation: String(event.conversation),
			peerName: from.name,
			caller: false,
			stage: "incoming",
			wantsVideo: event.video === true,
		});
		startRinging();
		render();
		return;
	}

	const call = active;
	if (call === null || call.id !== event.call) return;
	if (event.type === "call.ended") {
		const mine = call.stage === "incoming" && event.reason !== "declined";
		cleanup(call);
		if (!mine) toast(t(ENDED_TEXT[event.reason as ChatCallOutcome] ?? "calls.ended"), "info");
		return;
	}
	if (event.type === "call.accepted") {
		if (call.caller && event.to === clientId) {
			call.stage = "connecting";
			render();
			void begin(call);
		} else if (!call.caller && event.client !== clientId) {
			cleanup(call);
		}
		return;
	}
	if (event.type === "call.signal" && event.to === clientId) void onSignal(call, event.data as Record<string, unknown>);
}

export function watchCalls() {
	if (listening) return;
	listening = true;
	onRealtime(onEvent);
	watchGroupCalls();
	window.addEventListener("pagehide", () => {
		const call = active;
		const token = getToken();
		if (call === null || call.id === "" || token === null) return;
		void fetch(`/api/v1/projects/${call.project}/chat/calls/${call.id}/end`, {
			method: "POST",
			keepalive: true,
			headers: { Authorization: `Bearer ${token}` },
		});
	});
}

export function dropCall() {
	dropGroupCall();
	if (active) cleanup(active);
}
