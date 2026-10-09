import { Api, type ChatAttachment } from "../api";
import { el, emptyState, select, table } from "../dom";
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
	const load = async (): Promise<void> => {
		const result = await Api.chatAttachments(uuid, { limit: PAGE_SIZE, offset: controls.state.offset });
		if (controls.update(result.total)) return load();
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
