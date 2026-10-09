import { Api, type ChatAttachment, type RecordingQuality } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { chooseCustomRecording, chooseRecordingSize, qualityOf, RECORDING_FLOOR, RECORDING_SIZES, recordingSize, type RecordingSize } from "../call-recorder";
import { formatBytes, formatDateTime } from "../money";
import { t } from "../i18n";
import { confirmDialog, reportError, toast } from "../ui";
import { pagination, PAGE_SIZE } from "../pagination";
import { loadProject, projectLayout } from "./project";
import { confirmRemoval, downloadFile, openViewer, viewerKind } from "./files";
import type { DateFormat, TimeFormat } from "../../../server/formats";

export const ATTACHMENT_AGES: { days: number; label: "files.age_30" | "files.age_90" | "files.age_180" | "files.age_365" | "files.age_all" }[] = [
	{ days: 30, label: "files.age_30" },
	{ days: 90, label: "files.age_90" },
	{ days: 180, label: "files.age_180" },
	{ days: 365, label: "files.age_365" },
	{ days: 0, label: "files.age_all" },
];

export function bulkRemoval(uuid: string, everyone: boolean, onRemoved: () => void): HTMLElement {
	const age = select(
		ATTACHMENT_AGES.map((option) => ({ value: String(option.days), label: t(option.label) })),
		"365"
	);
	age.setAttribute("aria-label", t("files.chat_remove_older"));
	const remove = el("button", { class: "button danger", type: "button" }, t("files.remove"));
	remove.addEventListener("click", async () => {
		const chosen = ATTACHMENT_AGES.find((option) => String(option.days) === age.value)!;
		const confirmed = await confirmDialog({
			title: t("files.chat_remove_title"),
			body:
				chosen.days === 0
					? t(everyone ? "files.chat_remove_everyone_all" : "files.chat_remove_own_all")
					: t(everyone ? "files.chat_remove_everyone_body" : "files.chat_remove_own_body", { age: t(chosen.label) }),
			confirmLabel: t("files.remove"),
			destructive: true,
		});
		if (!confirmed) return;
		remove.disabled = true;
		try {
			const result = await Api.removeChatAttachments(uuid, chosen.days, everyone);
			toast(t("files.chat_removed", { count: result.removed, size: formatBytes(result.bytes) }), "success");
			onRemoved();
		} catch (error) {
			reportError(error);
		} finally {
			remove.disabled = false;
		}
	});
	return el("div", { class: "toolbar chat-attachment-removal" }, el("span", {}, t("files.chat_remove_older")), age, remove);
}

const BYTES_PER_HOUR_PER_KBPS = 450_000;
const RECORDING_HEIGHTS = [360, 480, 720, 1080, 1440, 2160];

function recordingSizeChoice(limits: RecordingQuality): HTMLElement {
	const detail = (quality: RecordingQuality) =>
		t("files.recording_size_detail", {
			height: quality.height,
			frames: quality.frames_per_second,
			size: formatBytes((quality.video_kbps + quality.audio_kbps) * BYTES_PER_HOUR_PER_KBPS),
		});
	const size = select(
		RECORDING_SIZES.map((option) => ({
			value: option,
			label: option === "custom" ? t("files.recording_size_custom") : `${t(`files.recording_size_${option}`)} | ${detail(qualityOf(option, limits))}`,
		})),
		recordingSize()
	);
	const chosen = qualityOf("custom", limits);
	const heights = [...new Set([...RECORDING_HEIGHTS.filter((height) => height < limits.height), limits.height, chosen.height])].sort((a, b) => a - b);
	const height = select(
		heights.map((value) => ({ value: String(value), label: `${value}p` })),
		String(chosen.height)
	);
	const frames = input("number", {
		min: String(RECORDING_FLOOR.frames_per_second),
		max: String(limits.frames_per_second),
		step: "1",
		value: String(chosen.frames_per_second),
	});
	const bitrate = input("number", {
		min: String(RECORDING_FLOOR.video_kbps),
		max: String(limits.video_kbps),
		step: "100",
		value: String(chosen.video_kbps),
	});
	const estimate = el("p", { class: "muted" });
	const custom = el(
		"div",
		{ class: "chat-recording-custom" },
		field(t("files.recording_resolution"), height),
		field(t("files.recording_frames"), frames, t("files.recording_up_to", { limit: limits.frames_per_second })),
		field(t("files.recording_bitrate"), bitrate, t("files.recording_up_to", { limit: limits.video_kbps })),
		estimate
	);
	const show = () => {
		custom.hidden = size.value !== "custom";
		estimate.textContent = detail(qualityOf("custom", limits));
	};
	const keep = () => {
		const wanted = { height: Number(height.value), frames_per_second: Number(frames.value), video_kbps: Number(bitrate.value) };
		if (Object.values(wanted).every((value) => Number.isFinite(value) && value > 0)) chooseCustomRecording(wanted);
		show();
	};
	size.addEventListener("change", () => {
		chooseRecordingSize(size.value as RecordingSize);
		show();
	});
	for (const control of [height, frames, bitrate]) control.addEventListener("input", keep);
	for (const control of [frames, bitrate]) {
		control.addEventListener("change", () => {
			const kept = qualityOf("custom", limits);
			frames.value = String(kept.frames_per_second);
			bitrate.value = String(kept.video_kbps);
		});
	}
	show();
	return el("div", { class: "chat-recording-size" }, field(t("files.recording_size"), size, t("files.recording_size_hint")), custom);
}

export async function chatAttachmentsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const body = el("div", {});
	const summary = el("p", { class: "muted" });
	const when = (timestamp: number) => formatDateTime(timestamp, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone);

	const row = (file: ChatAttachment): HTMLElement =>
		el(
			"tr",
			{},
			el(
				"td",
				{},
				el(
					"button",
					{
						class: "link-button",
						type: "button",
						onClick: () => {
							const kind = viewerKind(file);
							if (kind === "video" || kind === "pdf") void openViewer(project, file, kind);
							else void downloadFile(project, file);
						},
					},
					file.file_name
				)
			),
			el("td", { class: "mono" }, formatBytes(file.byte_size)),
			el("td", {}, el("a", { href: `/projects/${uuid}/chat/${file.conversation}` }, file.conversation_name)),
			el("td", {}, when(file.created)),
			el(
				"td",
				{},
				el(
					"button",
					{
						class: "button ghost small",
						type: "button",
						onClick: async () => {
							if (await confirmRemoval(project, file, true)) await load();
						},
					},
					t("files.remove")
				)
			)
		);

	const controls = pagination(() => load());
	const recording = el("div", {});
	const load = async (): Promise<void> => {
		const result = await Api.chatAttachments(uuid, { limit: PAGE_SIZE, offset: controls.state.offset });
		if (controls.update(result.total)) return load();
		if (!recording.hasChildNodes()) recording.appendChild(recordingSizeChoice(result.recording_limits));
		summary.textContent = t("files.chat_summary", { count: result.total, size: formatBytes(result.total_bytes) });
		body.replaceChildren(
			result.files.length
				? table([t("files.column_name"), t("files.column_size"), t("files.chat_conversation"), t("files.column_uploaded"), ""], result.files.map(row))
				: emptyState(t("files.chat_none"))
		);
	};
	await load();

	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack file-page" },
			el(
				"div",
				{ class: "page-head" },
				el("div", {}, el("a", { class: "back-link", href: `/projects/${uuid}/files` }, t("files.chat_back")), el("h2", {}, t("files.chat_title")))
			),
			el("p", { class: "muted" }, t("files.chat_hint")),
			recording,
			summary,
			bulkRemoval(uuid, false, () => {
				controls.reset();
				void load().catch(reportError);
			}),
			el("div", { class: "card" }, body),
			controls.element
		)
	);
}
