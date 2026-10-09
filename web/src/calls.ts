import { Api, getToken, type CameraQuality, type ChatCallOutcome, type IceServer, type ScreenShareQuality } from "./api";
import { el } from "./dom";
import { t } from "./i18n";
import { onRealtime, sendRealtime, type RealtimeEvent } from "./realtime";
import { reportError, toast } from "./ui";
import { dropGroupCall, inGroupCall, watchGroupCalls } from "./group-call";
import { callControl, controlPick, qualityPick, splitControl } from "./call-controls";
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
import { canRecord, RECORDING_SIZES, recordingSize, startRecorder, type CallRecorder, type RecordingSize } from "./call-recorder";

const CLIENT_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const FAILED_GRACE_MS = 20 * 1000;
const RING_INTERVAL_MS = 2200;

const clientId = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => CLIENT_CHARACTERS[value % CLIENT_CHARACTERS.length]).join("");

type Stage = "outgoing" | "incoming" | "connecting" | "connected" | "reconnecting";

interface PeerState {
	camera: boolean;
	screen: boolean;
	microphone: boolean;
	recording: boolean;
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
	recorder: CallRecorder | null;
	recorderStarting: boolean;
	recordSize: RecordingSize;
	shareSize: ShareSize;
	shareLimits: ScreenShareQuality;
	cameraSize: ShareSize;
	cameraLimits: CameraQuality;
	devices: Record<DeviceKind, MediaDeviceInfo[]>;
	expanded: boolean;
	theater: boolean;
	quiet: boolean;
}

let active: ActiveCall | null = null;
let listening = false;
let panel: HTMLElement | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let ringer: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;
let nativeTheater = false;

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
	const expanded = call.expanded;
	const status = el("span", { class: "call-status" }, statusText(call));
	const recordingNote = call.recorder ? t("calls.recording_you") : call.remote.recording ? t("calls.recording_by", { name: call.peerName }) : null;
	const head = el(
		"div",
		{ class: "call-head" },
		el("strong", { class: "call-peer" }, call.peerName),
		recordingNote ? el("span", { class: "call-recording" }, recordingNote) : null,
		status
	);
	call.recorder?.sync();

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
		const watching = main !== null && main !== call.screen;
		if (call.theater && !watching) {
			call.theater = false;
			leaveNativeTheater();
		}
		const theater = call.theater;
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
				{
					class: `call-stage${main === null ? " empty" : ""}`,
					onClick: (event) => {
						if (!call.theater || (event.target as Element).closest("button")) return;
						call.quiet = !call.quiet;
						panel?.classList.toggle("quiet", call.quiet);
					},
				},
				main === null ? el("span", { class: "call-avatar" }, call.peerName.slice(0, 1).toUpperCase()) : null,
				mainVideo,
				el("div", { class: "call-thumbs" }, sideVideo, selfVideo),
				watching
					? callControl(
							theater ? "fullscreen_exit" : "fullscreen",
							theater ? t("calls.exit_full_screen") : t("calls.full_screen"),
							() => setTheater(call, !theater),
							{
								pressed: theater,
								extraClass: "call-stage-action",
							}
						)
					: null,
				call.remote.microphone ? null : el("span", { class: "call-note" }, t("calls.they_muted", { name: call.peerName }))
			),
			sharingNote ? el("p", { class: "call-sharing muted" }, sharingNote) : null,
			el(
				"div",
				{ class: "call-controls" },
				withDevices(
					call,
					"audioinput",
					callControl(call.muted ? "mic_off" : "mic", call.muted ? t("calls.unmute") : t("calls.mute"), toggleMicrophone, {
						tone: call.muted ? "off" : "neutral",
						pressed: call.muted,
					})
				),
				withDevices(
					call,
					"videoinput",
					callControl(call.camera ? "video" : "video_off", call.camera ? t("calls.camera_off") : t("calls.camera_on"), () => void toggleCamera(), {
						tone: call.camera ? "active" : "neutral",
						pressed: call.camera !== null,
					}),
					qualityPick(t("calls.camera_quality"), SHARE_SIZES, call.cameraSize, false, (size) => {
						call.cameraSize = size;
						chooseCameraSize(size);
						void applyCameraQuality(call);
					})
				),
				shareControl(call),
				canRecord() ? recordControl(call) : null,
				theater ? null : callControl(expanded ? "shrink" : "expand", expanded ? t("calls.smaller") : t("calls.larger"), toggleExpanded),
				callControl("hang_up", t("calls.hang_up"), () => void hangUp(), { tone: "danger" })
			)
		);
	}

	if (panel === null) {
		panel = el("div", {});
		panel.setAttribute("role", "dialog");
		document.body.appendChild(panel);
	}
	panel.className = `call-panel${expanded ? " expanded" : ""}${call.theater ? " theater" : ""}${call.theater && call.quiet ? " quiet" : ""}`;
	panel.dataset.stage = call.stage;
	panel.setAttribute("aria-label", t("calls.title", { name: call.peerName }));
	panel.replaceChildren(head, body, remoteAudio);

	if (clock === null) {
		clock = setInterval(() => {
			const shown = panel?.querySelector(".call-status");
			if (shown && active) shown.textContent = statusText(active);
		}, 1000);
	}
}

function withDevices(call: ActiveCall, kind: DeviceKind, main: HTMLElement, ...picks: HTMLElement[]): HTMLElement {
	const devices = call.devices[kind];
	if (devices.length < 2) return picks.length > 0 ? splitControl(main, ...picks) : main;
	const track = kind === "audioinput" ? call.microphone : call.camera;
	const chosen = track?.getSettings().deviceId ?? rememberedDevice(kind);
	return splitControl(
		main,
		...picks,
		controlPick(
			t(kind === "audioinput" ? "calls.microphone_source" : "calls.camera_source"),
			devices.map((device) => ({ value: device.deviceId, label: device.label })),
			devices.find((device) => device.deviceId === chosen)?.deviceId ?? devices[0].deviceId,
			false,
			(device) => void switchDevice(call, kind, device)
		)
	);
}

function shareControl(call: ActiveCall): HTMLElement {
	const disabled = call.remote.screen || !("getDisplayMedia" in navigator.mediaDevices);
	const share = callControl("screen", call.screen ? t("calls.stop_sharing") : t("calls.share_screen"), () => void toggleScreen(), {
		tone: call.screen ? "active" : "neutral",
		pressed: call.screen !== null,
		disabled,
	});
	if (call.screen) return share;
	return splitControl(
		share,
		qualityPick(t("calls.share_quality"), SHARE_SIZES, call.shareSize, disabled, (size) => {
			call.shareSize = size;
			chooseShareSize(size);
		})
	);
}

async function refreshDevices(call: ActiveCall) {
	try {
		call.devices = namedDevices(await navigator.mediaDevices.enumerateDevices());
		if (active === call) render();
	} catch {
		void 0;
	}
}

async function switchDevice(call: ActiveCall, kind: DeviceKind, device: string) {
	rememberDevice(kind, device);
	const current = kind === "audioinput" ? call.microphone : call.camera;
	if (current === null || call.connection === null) return;
	const next = kind === "audioinput" ? await microphone() : await cameraTrack(call);
	if (next === null) return;
	if (active !== call || (kind === "videoinput" && call.camera === null)) {
		next.stop();
		return;
	}
	current.stop();
	if (kind === "audioinput") {
		next.enabled = !call.muted;
		call.microphone = next;
	} else call.camera = next;
	await call.connection.getTransceivers()[kind === "audioinput" ? 0 : 1]?.sender.replaceTrack(next);
	if (kind === "videoinput") await applyCameraQuality(call);
	render();
}

function recordControl(call: ActiveCall): HTMLElement {
	const record = callControl(
		call.recorder ? "record_stop" : "record",
		call.recorder ? t("calls.record_stop") : t("calls.record"),
		() => void toggleRecording(call),
		{
			tone: call.recorder ? "off" : "neutral",
			pressed: call.recorder !== null,
			disabled: call.recorderStarting || (call.recorder === null && call.remote.recording),
		}
	);
	if (call.recorder) return record;
	return splitControl(
		record,
		qualityPick(t("calls.record_quality"), RECORDING_SIZES, call.recordSize, call.recorderStarting || call.remote.recording, (size) => {
			call.recordSize = size;
		})
	);
}

async function stopRecording(call: ActiveCall) {
	const recorder = call.recorder;
	if (recorder === null) return;
	call.recorder = null;
	if (active === call) {
		announceState(call);
		render();
	}
	toast((await recorder.stop()) ? t("calls.recording_saved") : t("calls.recording_failed"), "info");
}

async function toggleRecording(call: ActiveCall) {
	if (call.recorder) {
		await stopRecording(call);
		return;
	}
	if (call.recorderStarting || call.remote.recording || call.stage === "incoming" || call.stage === "outgoing") return;
	call.recorderStarting = true;
	render();
	try {
		const recorder = await startRecorder(
			{
				audioTracks: () => [call.microphone, remoteTrack(call, 0)].filter((track) => track !== null),
				screen: () => (call.remote.screen ? remoteTrack(call, 2) : call.screen),
				names: () => [],
			},
			{ project: call.project, conversation: call.conversation, title: t("calls.title", { name: call.peerName }) },
			call.recordSize,
			() => void stopRecording(call)
		);
		if (active !== call || call.remote.recording) {
			void recorder.stop();
			return;
		}
		call.recorder = recorder;
		announceState(call);
	} catch (error) {
		reportError(error);
	} finally {
		call.recorderStarting = false;
		if (active === call) render();
	}
}

function toggleExpanded() {
	if (active) active.expanded = !active.expanded;
	render();
}

function leaveNativeTheater() {
	if (panel !== null && document.fullscreenElement === panel) void document.exitFullscreen().catch(() => undefined);
}

function setTheater(call: ActiveCall, on: boolean) {
	call.theater = on;
	call.quiet = false;
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
	if (active?.theater) {
		active.theater = false;
		render();
	}
}

function signal(call: ActiveCall, data: Record<string, unknown>) {
	const event = { type: "call.signal", call: call.id, client: clientId, data };
	if (call.unsent.length > 0 || !sendRealtime(event)) call.unsent.push(event);
}

function flush(call: ActiveCall) {
	while (call.unsent.length > 0 && sendRealtime(call.unsent[0])) call.unsent.shift();
}

function announceState(call: ActiveCall) {
	signal(call, { state: { camera: call.camera !== null, screen: call.screen !== null, microphone: !call.muted, recording: call.recorder !== null } });
}

function cleanup(call: ActiveCall) {
	stopRinging();
	if (call.failTimer !== null) clearTimeout(call.failTimer);
	if (active === call) active = null;
	void stopRecording(call);
	for (const track of [call.microphone, call.camera, call.screen]) track?.stop();
	call.connection?.close();
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
			void applyCameraQuality(call);
			void refreshDevices(call);
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
			if (state.recording === true && !call.remote.recording) toast(t("calls.recording_by", { name: call.peerName }), "info");
			call.remote = {
				camera: state.camera === true,
				screen: state.screen === true,
				microphone: state.microphone !== false,
				recording: state.recording === true,
			};
			if (call.remote.recording && call.recorder && !call.caller) await stopRecording(call);
			if (call.remote.screen && call.screen && !call.caller) await stopScreen(call);
			render();
		}
	} catch (error) {
		reportError(error);
	}
}

async function microphone(): Promise<MediaStreamTrack | null> {
	try {
		const device = rememberedDevice("audioinput");
		return (await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: device } : true })).getAudioTracks()[0] ?? null;
	} catch {
		toast(t("calls.no_microphone"), "error");
		return null;
	}
}

function cameraShape(quality: CameraQuality & { width: number }): MediaTrackConstraints {
	return { width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.frames_per_second } };
}

async function limitSender(sender: RTCRtpSender | undefined, quality: CameraQuality) {
	try {
		const parameters = sender?.getParameters();
		if (sender && parameters?.encodings?.[0]) {
			parameters.encodings[0].maxBitrate = quality.kbps * 1000;
			parameters.encodings[0].maxFramerate = quality.frames_per_second;
			await sender.setParameters(parameters);
		}
	} catch {
		void 0;
	}
}

async function applyCameraQuality(call: ActiveCall) {
	const quality = cameraQuality(call.cameraSize, call.cameraLimits);
	try {
		await call.camera?.applyConstraints(cameraShape(quality));
	} catch {
		void 0;
	}
	await limitSender(call.connection?.getTransceivers()[1]?.sender, quality);
}

async function cameraTrack(call: ActiveCall): Promise<MediaStreamTrack | null> {
	try {
		const video = { ...cameraShape(cameraQuality(call.cameraSize, call.cameraLimits)), deviceId: rememberedDevice("videoinput") };
		return (await navigator.mediaDevices.getUserMedia({ video })).getVideoTracks()[0] ?? null;
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
		call.camera = await cameraTrack(call);
	}
	if (active !== call) return;
	await sender?.replaceTrack(call.camera);
	await applyCameraQuality(call);
	announceState(call);
	render();
	void refreshDevices(call);
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
	const quality = shareQuality(call.shareSize, call.shareLimits);
	let track: MediaStreamTrack | null = null;
	try {
		const video = {
			width: { ideal: quality.width },
			height: { ideal: quality.height },
			frameRate: { ideal: quality.frames_per_second, max: quality.frames_per_second },
		};
		track = (await navigator.mediaDevices.getDisplayMedia({ video, audio: false })).getVideoTracks()[0] ?? null;
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
	const sender = call.connection.getTransceivers()[2]?.sender;
	await sender?.replaceTrack(track);
	await limitSender(sender, quality);
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
		remote: { camera: false, screen: false, microphone: true, recording: false },
		pendingCandidates: [],
		unsent: [],
		connectedAt: null,
		failTimer: null,
		restarted: false,
		recorder: null,
		recorderStarting: false,
		recordSize: recordingSize(),
		shareSize: shareSize(),
		shareLimits: SHARE_PRESETS.high,
		cameraSize: cameraSize(),
		cameraLimits: CAMERA_PRESETS.high,
		devices: { audioinput: [], videoinput: [] },
		expanded: false,
		theater: false,
		quiet: false,
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
	if (video) call.camera = await cameraTrack(call);
	if (active !== call) {
		cleanup(call);
		return;
	}
	try {
		const started = await Api.startChatCall(project, conversation, clientId, video);
		call.id = started.call;
		call.iceServers = started.ice_servers;
		call.shareLimits = started.screen_share;
		call.cameraLimits = started.camera;
		void applyCameraQuality(call);
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
	if (video) call.camera = await cameraTrack(call);
	if (active !== call) {
		cleanup(call);
		return;
	}
	try {
		const accepted = await Api.acceptChatCall(call.project, call.id, clientId);
		call.iceServers = accepted.ice_servers;
		call.shareLimits = accepted.screen_share;
		call.cameraLimits = accepted.camera;
		void applyCameraQuality(call);
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
	document.addEventListener("fullscreenchange", onFullscreenChange);
	navigator.mediaDevices?.addEventListener("devicechange", () => {
		if (active) void refreshDevices(active);
	});
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
