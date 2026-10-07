import {
	Api,
	getUsername,
	type FileLimits,
	type FilePeople,
	type FileUpload,
	type Project,
	type ProjectFile,
	type ProjectFiles,
	type TicketDetails,
	type TicketFile,
} from "../api";
import { el, emptyState, field, input, saveFile, select, table } from "../dom";
import { formatBytes, formatDateTime } from "../money";
import { can, Permission } from "../access";
import { t } from "../i18n";
import { accountName, confirmDialog, modal, reportError, toast } from "../ui";
import { pagination, PAGE_SIZE } from "../pagination";
import { openLightbox } from "../lightbox";
import { loadProject, projectLayout } from "./project";
import { losslessWebp } from "../image";
import { startTransfer } from "../transfers";
import {
	FILE_MB_BYTES,
	MAX_IN_PAGE_DOWNLOAD_BYTES,
	MAX_PDF_PREVIEW_BYTES,
	MAX_PREVIEW_BYTES,
	PDF_CONTENT_TYPE,
	isPlayableVideo,
	PREVIEWABLE_IMAGE_TYPES,
} from "../../../server/file-limits";
import type { DateFormat, TimeFormat } from "../../../server/formats";

function when(project: Project, timestamp: number): string {
	return formatDateTime(timestamp, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone);
}

function uploaderOf(file: TicketFile): string {
	return accountName(file.created_by_name, file.created_by) ?? "";
}

export async function uploadFiles(
	files: File[],
	maxBytes: number,
	begin: (file: File) => Promise<FileUpload>,
	project: Project,
	button: HTMLButtonElement,
	idleLabel: string
): Promise<number> {
	if (files.length === 0 || button.disabled) return 0;
	button.disabled = true;
	button.textContent = t("files.uploading");
	const accepted: File[] = [];
	for (const original of files) {
		const file = await losslessWebp(original);
		if (file.size === 0) toast(t("files.empty", { name: file.name }), "error");
		else if (file.size > maxBytes) toast(t("files.too_large", { name: file.name, size: formatBytes(maxBytes) }), "error");
		else accepted.push(file);
	}
	let stored = 0;
	for (const file of accepted) {
		const transfer = startTransfer("upload", file.name, file.size);
		try {
			const begun = await begin(file);
			try {
				for (let index = 0; index < begun.parts; index++) {
					const start = index * begun.part_bytes;
					await Api.uploadFilePart(project.uuid, begun.uuid, index, file.slice(start, start + begun.part_bytes), (sent) =>
						transfer.update(Math.min(start + sent, file.size))
					);
				}
			} catch (error) {
				void Api.removeFile(project.uuid, begun.uuid).catch(() => undefined);
				throw error;
			}
			transfer.finish();
			stored++;
		} catch (error) {
			transfer.fail();
			reportError(error);
			break;
		}
	}
	button.disabled = false;
	button.textContent = idleLabel;
	return stored;
}

export async function downloadFile(project: Project, file: TicketFile) {
	if (file.byte_size <= MAX_IN_PAGE_DOWNLOAD_BYTES) {
		const transfer = startTransfer("download", file.file_name, file.byte_size);
		try {
			saveFile(await Api.fileBytes(project.uuid, file.uuid, file.byte_size, transfer.update), file.file_name);
			transfer.finish();
		} catch (error) {
			transfer.fail();
			reportError(error);
		}
		return;
	}
	try {
		const link = await Api.fileLink(project.uuid, file.uuid);
		toast(t("transfers.browser_download"), "info");
		const anchor = el("a", { href: link.path });
		anchor.download = file.file_name;
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
	} catch (error) {
		reportError(error);
	}
}

export type ViewerKind = "image" | "video" | "pdf";

export function viewerKind(file: Pick<TicketFile, "content_type" | "byte_size" | "file_name">): ViewerKind | null {
	if (PREVIEWABLE_IMAGE_TYPES.includes(file.content_type)) return file.byte_size <= MAX_PREVIEW_BYTES ? "image" : null;
	if (isPlayableVideo(file)) return "video";
	if (file.content_type === PDF_CONTENT_TYPE) return file.byte_size <= MAX_PDF_PREVIEW_BYTES ? "pdf" : null;
	return null;
}

function viewerDialog(project: Project, file: TicketFile, content: HTMLElement, onClose: () => void) {
	modal(
		file.file_name,
		el(
			"div",
			{ class: "stack" },
			content,
			el(
				"div",
				{ class: "form-actions" },
				el("button", { class: "button ghost", type: "button", onClick: () => void downloadFile(project, file) }, t("files.download"))
			)
		),
		onClose,
		"dialog-viewer"
	);
}

export async function openViewer(project: Project, file: TicketFile, kind: "video" | "pdf") {
	if (kind === "video") {
		try {
			const link = await Api.fileLink(project.uuid, file.uuid, true);
			const video = el("video", { class: "file-viewer-video", src: link.path });
			video.controls = true;
			video.autoplay = true;
			video.playsInline = true;
			const holder = el("div", {}, video);
			video.addEventListener("error", () => holder.replaceChildren(el("p", { class: "warn" }, t("files.video_unplayable"))));
			viewerDialog(project, file, holder, () => {
				video.pause();
				video.removeAttribute("src");
				video.load();
			});
		} catch (error) {
			reportError(error);
		}
		return;
	}

	const transfer = startTransfer("download", file.file_name, file.byte_size);
	try {
		const bytes = await Api.fileBytes(project.uuid, file.uuid, file.byte_size, transfer.update);
		transfer.finish();
		const url = URL.createObjectURL(new Blob([bytes], { type: PDF_CONTENT_TYPE }));
		const frame = el("iframe", { class: "file-viewer-frame", src: url, title: file.file_name });
		viewerDialog(project, file, frame, () => URL.revokeObjectURL(url));
	} catch (error) {
		transfer.fail();
		reportError(error);
	}
}

async function confirmRemoval(project: Project, file: TicketFile): Promise<boolean> {
	const confirmed = await confirmDialog({
		title: t("files.remove_title"),
		body: t("files.remove_body", { name: file.file_name }),
		confirmLabel: t("files.remove"),
		destructive: true,
	});
	if (!confirmed) return false;
	try {
		await Api.removeFile(project.uuid, file.uuid);
		toast(t("files.removed_toast"), "success");
		return true;
	} catch (error) {
		reportError(error);
		return false;
	}
}

function removalNote(project: Project, file: TicketFile): string {
	const date = when(project, file.removed_at ?? 0);
	const name = accountName(file.removed_by_name, file.removed_by);
	return name ? t("files.removed_by", { name, date }) : t("files.removed_on", { date });
}

export interface TicketFilesOptions {
	upload: boolean;
	removeAny: boolean;
	previews: Map<string, string>;
	onChanged: () => void;
}

export function ticketFilesCard(
	project: Project,
	ticket: TicketDetails,
	options: TicketFilesOptions
): { element: HTMLElement; upload: (files: File[]) => Promise<void> } {
	const username = getUsername();
	const picker = input("file");
	picker.multiple = true;
	picker.hidden = true;
	const attach = el("button", { class: "button ghost small", type: "button", onClick: () => picker.click() }, t("files.attach"));

	const upload = async (files: File[]) => {
		const stored = await uploadFiles(
			files,
			ticket.max_file_bytes,
			(file) => Api.beginTicketFile(project.uuid, ticket.uuid, { name: file.name, type: file.type, size: file.size }),
			project,
			attach,
			t("files.attach")
		);
		if (stored > 0) options.onChanged();
	};

	picker.addEventListener("change", () => {
		const chosen = [...(picker.files ?? [])];
		picker.value = "";
		void upload(chosen);
	});

	const images = ticket.files.filter((file) => !file.removed && file.byte_size <= MAX_PREVIEW_BYTES && PREVIEWABLE_IMAGE_TYPES.includes(file.content_type));
	const zoom = (file: TicketFile) => {
		const loaded = images.filter((image) => options.previews.has(image.uuid));
		openLightbox(
			loaded.map((image) => ({ src: options.previews.get(image.uuid)!, alt: image.file_name })),
			Math.max(loaded.indexOf(file), 0)
		);
	};

	const thumbnail = (file: TicketFile): HTMLElement => {
		const image = el("img", { class: "file-thumb-image", alt: file.file_name });
		const button = el("button", { class: "file-thumb", type: "button", title: file.file_name, onClick: () => zoom(file) }, image);
		const cached = options.previews.get(file.uuid);
		if (cached) image.src = cached;
		else {
			button.disabled = true;
			void Api.file(project.uuid, file.uuid)
				.then(({ blob }) => {
					const url = URL.createObjectURL(blob);
					options.previews.set(file.uuid, url);
					image.src = url;
					button.disabled = false;
				})
				.catch(() => undefined);
		}
		return button;
	};

	const watchable = (file: TicketFile): boolean => viewerKind(file) === "video" || viewerKind(file) === "pdf";

	const row = (file: TicketFile): HTMLElement => {
		if (file.removed) {
			return el(
				"li",
				{ class: "file-row file-row-removed" },
				el("div", { class: "file-info" }, el("span", { class: "file-name" }, file.file_name), el("span", { class: "muted" }, removalNote(project, file)))
			);
		}
		const removable = options.removeAny || (file.created_by !== null && file.created_by === username);
		return el(
			"li",
			{ class: "file-row" },
			images.includes(file) ? thumbnail(file) : null,
			el(
				"div",
				{ class: "file-info" },
				el(
					"button",
					{
						class: "link-button file-name",
						type: "button",
						title: watchable(file) ? t("explorer.preview") : t("files.download"),
						onClick: () => {
							const kind = viewerKind(file);
							if (kind === "video" || kind === "pdf") void openViewer(project, file, kind);
							else void downloadFile(project, file);
						},
					},
					file.file_name
				),
				el("span", { class: "muted" }, [formatBytes(file.byte_size), uploaderOf(file), when(project, file.created)].filter(Boolean).join(" | "))
			),
			removable
				? el(
						"button",
						{
							class: "button ghost small",
							type: "button",
							onClick: async () => {
								if (await confirmRemoval(project, file)) options.onChanged();
							},
						},
						t("files.remove")
					)
				: null
		);
	};

	const element = el(
		"div",
		{ class: "card stack" },
		el("div", { class: "toolbar" }, el("h2", {}, t("files.title")), options.upload ? attach : null),
		ticket.files.length ? el("ul", { class: "file-list" }, ...ticket.files.map(row)) : el("p", { class: "muted" }, t("files.none")),
		options.upload ? el("p", { class: "muted" }, t("files.hint", { size: formatBytes(ticket.max_file_bytes) })) : null,
		picker
	);
	return { element, upload };
}

export async function fileStorageView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const body = el("div", {});
	const summary = el("p", { class: "muted" });
	const sort = select(
		[
			{ value: "size", label: t("files.sort_size") },
			{ value: "created", label: t("files.sort_created") },
		],
		"size"
	);
	const showTickets = can(project, Permission.TICKET_VIEW);

	const row = (file: ProjectFile): HTMLElement =>
		el(
			"tr",
			{},
			el("td", {}, el("button", { class: "link-button", type: "button", onClick: () => void downloadFile(project, file) }, file.file_name)),
			el("td", { class: "mono" }, formatBytes(file.byte_size)),
			el("td", {}, [uploaderOf(file), when(project, file.created)].filter(Boolean).join(" | ")),
			el(
				"td",
				{},
				file.location ? el("div", {}, [t("explorer.title"), ...file.location].join(" / ")) : null,
				...file.tickets.map((ticket) =>
					showTickets
						? el("div", {}, el("a", { href: `/projects/${uuid}/tickets/${ticket.uuid}` }, `#${ticket.number} ${ticket.title}`))
						: el("div", {}, `#${ticket.number} ${ticket.title}`)
				)
			),
			el(
				"td",
				{},
				el(
					"button",
					{
						class: "button ghost small",
						type: "button",
						onClick: async () => {
							if (await confirmRemoval(project, file)) await load();
						},
					},
					t("files.remove")
				)
			)
		);

	const limit = input("number", { min: "1", step: "1", required: true });
	const perPerson = input("number", { min: "0", step: "1" });
	const limitField = el("div", {});
	const saveLimit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const limitForm = el(
		"form",
		{
			class: "card stack",
			onSubmit: async (event) => {
				event.preventDefault();
				saveLimit.disabled = true;
				try {
					showLimits(
						await Api.saveFileSettings(uuid, {
							max_file_mb: Number(limit.value),
							max_member_file_mb: perPerson.value === "" ? null : Number(perPerson.value),
						})
					);
					toast(t("files.limit_saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					saveLimit.disabled = false;
				}
			},
		},
		el("h2", {}, t("files.limit_title")),
		limitField,
		el("div", { class: "form-actions" }, saveLimit)
	);
	const showLimits = (limits: FileLimits) => {
		limit.max = String(Math.floor(limits.max_file_bytes_ceiling / FILE_MB_BYTES));
		limit.value = String(Math.floor(limits.max_file_bytes / FILE_MB_BYTES));
		perPerson.value = limits.max_member_file_bytes === null ? "" : String(Math.floor(limits.max_member_file_bytes / FILE_MB_BYTES));
		limitField.replaceChildren(
			el(
				"div",
				{ class: "form-grid" },
				field(t("files.limit_label"), limit, t("files.limit_hint", { max: formatBytes(limits.max_file_bytes_ceiling) })),
				field(t("files.person_default_label"), perPerson, t("files.person_default_hint"))
			)
		);
	};
	let limitsShown = false;

	const render = (result: ProjectFiles) => {
		if (!limitsShown) showLimits(result);
		limitsShown = true;
		summary.textContent =
			result.file_storage_limit === null
				? t("files.usage_unlimited", { used: formatBytes(result.file_storage_used) })
				: t("files.usage", { used: formatBytes(result.file_storage_used), limit: formatBytes(result.file_storage_limit) });
		body.replaceChildren(
			result.files.length
				? table([t("files.column_name"), t("files.column_size"), t("files.column_uploaded"), t("files.column_tickets"), ""], result.files.map(row))
				: emptyState(t("files.none_stored"))
		);
	};

	const peopleBody = el("div", {});
	const personRow = (person: FilePeople["people"][number]): HTMLElement => {
		const own = input("number", { min: "0", step: "1", value: person.max_bytes === null ? "" : String(Math.floor(person.max_bytes / FILE_MB_BYTES)) });
		own.setAttribute("aria-label", t("files.people_limit"));
		own.addEventListener("change", async () => {
			try {
				await Api.saveMemberFileLimit(uuid, person.username, own.value === "" ? null : Number(own.value));
				toast(t("files.people_saved"), "success");
			} catch (error) {
				reportError(error);
			}
		});
		return el("tr", {}, el("td", {}, person.name), el("td", { class: "mono" }, formatBytes(person.used)), el("td", {}, own));
	};
	const loadPeople = async () => {
		const result = await Api.fileLimits(uuid);
		peopleBody.replaceChildren(table([t("workforce.person"), t("files.people_used"), t("files.people_limit")], result.people.map(personRow)));
	};

	const controls = pagination(() => load());
	const load = async () => {
		const result = await Api.files(uuid, { limit: PAGE_SIZE, offset: controls.state.offset, sort: sort.value as "size" | "created" });
		if (controls.update(result.total)) return load();
		render(result);
	};
	sort.addEventListener("change", () => {
		controls.reset();
		void load().catch(reportError);
	});
	await Promise.all([load(), loadPeople()]);

	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "page-head" },
				el("div", {}, el("a", { class: "back-link", href: `/projects/${uuid}/license` }, t("files.back")), el("h2", {}, t("files.manage_title")))
			),
			el("p", { class: "muted" }, t("files.manage_hint")),
			el("div", { class: "toolbar" }, summary, sort),
			el("div", { class: "card" }, body),
			controls.element,
			limitForm,
			el("div", { class: "card stack" }, el("h2", {}, t("files.people_title")), el("p", { class: "muted" }, t("files.people_limit_hint")), peopleBody)
		)
	);
}
