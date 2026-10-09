import {
	Api,
	getUsername,
	type Explorer,
	type ExplorerFile,
	type ExplorerFolder,
	type ExplorerLocation,
	type ExplorerOwner,
	type ExplorerScope,
	type FolderAccess,
	type FolderChoice,
	type Project,
} from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { formatBytes, formatDateTime } from "../money";
import { can, Permission } from "../access";
import { t } from "../i18n";
import { accountName, confirmDialog, modal, reportError, toast } from "../ui";
import { icon } from "../storefront/icons";
import { loadProject, projectLayout } from "./project";
import { downloadFile, openViewer, uploadFiles, viewerKind } from "./files";
import { floatingMenu, type MenuLink } from "../menu";
import { openLightbox } from "../lightbox";
import { onLeave } from "../router";
import { startTransfer } from "../transfers";
import type { DateFormat, TimeFormat } from "../../../server/formats";

function when(project: Project, timestamp: number): string {
	return formatDateTime(timestamp, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone);
}

const SCOPE_PATHS: Record<ExplorerScope, string> = { shared: "shared", all: "everyone" };
const SCOPE_LABELS: Record<ExplorerScope, "explorer.shared_with_me" | "explorer.everyones_files"> = {
	shared: "explorer.shared_with_me",
	all: "explorer.everyones_files",
};

function scopeHref(uuid: string, scope: ExplorerScope, owner?: string): string {
	return `/projects/${uuid}/files/${SCOPE_PATHS[scope]}${owner ? `/${encodeURIComponent(owner)}` : ""}`;
}

function ownerName(owner: ExplorerOwner): string {
	return owner.name ?? owner.email ?? t("explorer.former_member");
}

function folderHref(uuid: string, folder: string | null): string {
	return folder ? `/projects/${uuid}/files/folders/${folder}` : `/projects/${uuid}/files`;
}

interface Shared {
	access: FolderAccess;
	members: string[];
	created_by?: string | null;
	created_by_name?: string | null;
}

function sharingLabel(sharing: Shared, nested: boolean): string {
	if (sharing.access === "everyone") return t("explorer.access_everyone");
	if (sharing.access === "members") return t("explorer.access_members", { count: sharing.members.length });
	if (nested) return t("explorer.access_inherit");
	if (sharing.created_by === getUsername()) return t("explorer.access_private");
	return t("explorer.access_private_other", { name: accountName(sharing.created_by_name, sharing.created_by) ?? "" });
}

function sharingPill(sharing: Shared, nested: boolean, prefix = ""): HTMLElement {
	return el("span", { class: `pill explorer-pill${sharing.access === "private" ? "" : " pill-active"}` }, `${prefix}${sharingLabel(sharing, nested)}`);
}

interface ShareTarget extends Shared {
	name: string;
	nested: boolean;
	save: (access: FolderAccess, members: string[]) => Promise<unknown>;
}

function usageMeter(used: number, limit: number): HTMLElement {
	const share = limit <= 0 ? 100 : Math.min((used / limit) * 100, 100);
	const fill = el("div", { class: "meter-fill" });
	fill.style.width = `${share}%`;
	return el("div", { class: `meter explorer-meter ${share >= 100 ? "meter-full" : share >= 80 ? "meter-high" : ""}` }, fill);
}

function nameDialog(title: string, label: string, initial: string, save: (name: string) => Promise<void>) {
	const name = input("text", { required: true, maxlength: "120", value: initial });
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const dialog = modal(
		title,
		el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;
					try {
						await save(name.value.trim());
						dialog.close();
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			field(label, name),
			el("div", { class: "form-actions" }, submit)
		),
		undefined,
		"dialog"
	);
	name.select();
}

function insideOf(choices: FolderChoice[], folder: string): Set<string> {
	const inside = new Set([folder]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const choice of choices) {
			if (choice.parent !== null && inside.has(choice.parent) && !inside.has(choice.uuid)) {
				inside.add(choice.uuid);
				grew = true;
			}
		}
	}
	return inside;
}

async function moveDialog(
	project: Project,
	name: string,
	current: string | null,
	options: { movingFolder: string | null; topLevel: boolean },
	save: (target: string | null) => Promise<void>
) {
	const choices = await Api.explorerFolders(project.uuid);
	const blocked = options.movingFolder ? insideOf(choices, options.movingFolder) : new Set<string>();
	const targets = [
		...(options.topLevel ? [{ value: "", label: t("explorer.top_level") }] : []),
		...choices.filter((choice) => !blocked.has(choice.uuid)).map((choice) => ({ value: choice.uuid, label: choice.path.join(" / ") })),
	].filter((target) => target.value !== (current ?? ""));
	if (targets.length === 0) {
		toast(t("explorer.move_nowhere"), "info");
		return;
	}
	const target = select(targets);
	const submit = el("button", { class: "button primary", type: "submit" }, t("explorer.move"));
	const dialog = modal(
		t("explorer.move_title", { name }),
		el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;
					try {
						await save(target.value || null);
						dialog.close();
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			field(t("explorer.move_to"), target),
			el("div", { class: "form-actions" }, submit)
		),
		undefined,
		"dialog"
	);
}

async function shareDialog(project: Project, folder: ShareTarget, onSaved: () => void) {
	const members = (await Api.members(project.uuid)).filter(
		(member) => member.status === "active" && member.account_username !== null && member.account_username !== folder.created_by
	);
	const access = select(
		[
			{
				value: "private",
				label: folder.nested
					? t("explorer.share_inherit")
					: folder.created_by === getUsername()
						? t("explorer.access_private")
						: t("explorer.share_owner_only"),
			},
			{ value: "everyone", label: t("explorer.access_everyone") },
			{ value: "members", label: t("explorer.share_chosen") },
		],
		folder.access
	);
	const boxes = members.map((member) => {
		const box = input("checkbox", { value: member.account_username! });
		box.checked = folder.members.includes(member.account_username!);
		return { box, label: member.full_name?.trim() || member.account_email || member.account_username! };
	});
	const people = el(
		"div",
		{ class: "stack" },
		el("strong", {}, t("explorer.share_people")),
		...(boxes.length
			? boxes.map(({ box, label }) => el("label", { class: "switch" }, box, el("span", {}, label)))
			: [el("p", { class: "muted" }, t("explorer.share_nobody"))])
	);
	const sync = () => {
		people.hidden = access.value !== "members";
	};
	access.addEventListener("change", sync);
	sync();
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const dialog = modal(
		t("explorer.share_title", { name: folder.name }),
		el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;
					try {
						await folder.save(
							access.value as FolderAccess,
							boxes.filter(({ box }) => box.checked).map(({ box }) => box.value)
						);
						toast(t("explorer.saved"), "success");
						dialog.close();
						onSaved();
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			field(t("explorer.share_who"), access, t("explorer.share_hint")),
			people,
			el("div", { class: "form-actions" }, submit)
		),
		undefined,
		"dialog"
	);
}

export async function explorerView(uuid: string, location: ExplorerLocation): Promise<HTMLElement> {
	const folderId = location.folder ?? null;
	const browsing = location.scope !== undefined;
	const project = await loadProject(uuid);
	const username = getUsername();
	const content = el("div", { class: "stack explorer" });
	const picker = input("file");
	picker.multiple = true;
	picker.hidden = true;
	const uploadButton = el("button", { class: "button primary", type: "button", onClick: () => picker.click() }, t("explorer.upload"));
	let maxFileBytes = 0;

	const reload = async () => {
		try {
			render(await Api.explorer(uuid, location));
		} catch (error) {
			reportError(error);
		}
	};

	const upload = async (files: File[]) => {
		if (browsing) return;
		const stored = await uploadFiles(
			files,
			maxFileBytes,
			(file) => Api.beginExplorerFile(uuid, { name: file.name, type: file.type, size: file.size, folder: folderId }),
			project,
			uploadButton,
			t("explorer.upload")
		);
		if (stored > 0) await reload();
	};

	picker.addEventListener("change", () => {
		const chosen = [...(picker.files ?? [])];
		picker.value = "";
		void upload(chosen);
	});
	content.addEventListener("dragover", (event) => {
		if (!event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault();
		content.classList.add("explorer-dropping");
	});
	content.addEventListener("dragleave", () => content.classList.remove("explorer-dropping"));
	content.addEventListener("drop", (event) => {
		const dropped = [...(event.dataTransfer?.files ?? [])];
		content.classList.remove("explorer-dropping");
		if (dropped.length === 0) return;
		event.preventDefault();
		void upload(dropped);
	});
	content.addEventListener("paste", (event) => {
		const pasted = [...(event.clipboardData?.files ?? [])];
		if (pasted.length === 0) return;
		event.preventDefault();
		void upload(pasted);
	});

	const added = (item: { created_by: string | null; created_by_name?: string | null; created: number }): HTMLElement =>
		el(
			"td",
			{},
			el("div", {}, accountName(item.created_by_name, item.created_by) ?? ""),
			el("div", { class: "muted explorer-date" }, when(project, item.created))
		);

	const previews = new Map<string, string>();
	onLeave(() => {
		for (const url of previews.values()) URL.revokeObjectURL(url);
	});
	const previewable = (file: ExplorerFile): boolean => viewerKind(file) !== null;
	const preview = async (file: ExplorerFile) => {
		const kind = viewerKind(file);
		if (kind === "video" || kind === "pdf") return await openViewer(project, file, kind);
		let url = previews.get(file.uuid);
		if (!url) {
			const transfer = startTransfer("download", file.file_name, file.byte_size);
			try {
				url = URL.createObjectURL(await Api.fileBytes(uuid, file.uuid, file.byte_size, transfer.update));
				previews.set(file.uuid, url);
				transfer.finish();
			} catch (error) {
				transfer.fail();
				reportError(error);
				return;
			}
		}
		openLightbox([{ src: url, alt: file.file_name }]);
	};

	const removal = async (title: string, body: string, remove: () => Promise<unknown>) => {
		const confirmed = await confirmDialog({ title, body, confirmLabel: t("ui.delete"), destructive: true });
		if (!confirmed) return;
		try {
			await remove();
			toast(t("explorer.deleted"), "success");
			await reload();
		} catch (error) {
			reportError(error);
		}
	};

	const folderMenu = (folder: ExplorerFolder): MenuLink[][] => [
		[{ label: t("explorer.open"), href: folderHref(uuid, folder.uuid) }],
		folder.can_manage
			? [
					{
						label: t("explorer.share"),
						onSelect: () =>
							void shareDialog(
								project,
								{ ...folder, nested: folder.parent !== null, save: (access, members) => Api.updateFolder(uuid, folder.uuid, { access, members }) },
								() => void reload()
							).catch(reportError),
					},
					{
						label: t("explorer.rename"),
						onSelect: () =>
							nameDialog(t("explorer.rename"), t("explorer.folder_name"), folder.name, async (name) => {
								await Api.updateFolder(uuid, folder.uuid, { name });
								await reload();
							}),
					},
					{
						label: t("explorer.move"),
						onSelect: () =>
							void moveDialog(project, folder.name, folder.parent, { movingFolder: folder.uuid, topLevel: true }, async (target) => {
								await Api.updateFolder(uuid, folder.uuid, { parent: target });
								await reload();
							}).catch(reportError),
					},
				]
			: [],
		folder.can_manage
			? [
					{
						label: t("ui.delete"),
						danger: true,
						onSelect: () =>
							void removal(t("explorer.delete_folder_title"), t("explorer.delete_folder_body", { name: folder.name }), () =>
								Api.deleteFolder(uuid, folder.uuid)
							),
					},
				]
			: [],
	];

	const fileMenu = (file: ExplorerFile): MenuLink[][] => [
		[
			...(previewable(file) ? [{ label: t("explorer.preview"), onSelect: () => void preview(file) }] : []),
			{ label: t("files.download"), onSelect: () => void downloadFile(project, file) },
		],
		file.can_manage
			? [
					{
						label: t("explorer.share"),
						onSelect: () =>
							void shareDialog(
								project,
								{
									...file,
									name: file.file_name,
									nested: file.folder !== null,
									save: (access, members) => Api.updateExplorerFile(uuid, file.uuid, { access, members }),
								},
								() => void reload()
							).catch(reportError),
					},
					{
						label: t("explorer.rename"),
						onSelect: () =>
							nameDialog(t("explorer.rename"), t("explorer.name_label"), file.file_name, async (name) => {
								await Api.updateExplorerFile(uuid, file.uuid, { name });
								await reload();
							}),
					},
					{
						label: t("explorer.move"),
						onSelect: () =>
							void moveDialog(project, file.file_name, file.folder, { movingFolder: null, topLevel: file.created_by === username }, async (target) => {
								await Api.updateExplorerFile(uuid, file.uuid, { folder: target });
								await reload();
							}).catch(reportError),
					},
				]
			: [],
		file.can_manage
			? [
					{
						label: t("ui.delete"),
						danger: true,
						onSelect: () =>
							void removal(t("explorer.delete_file_title"), t("explorer.delete_file_body", { name: file.file_name }), () => Api.removeFile(uuid, file.uuid)),
					},
				]
			: [],
	];

	const withMenu = (row: HTMLTableRowElement, name: string, sections: () => MenuLink[][]): HTMLTableRowElement => {
		const more = el("button", { class: "icon-button explorer-more", type: "button", title: t("explorer.actions", { name }) }, icon("more", 18));
		more.setAttribute("aria-haspopup", "menu");
		more.addEventListener("click", () => {
			const box = more.getBoundingClientRect();
			floatingMenu({ x: box.right - 220, y: box.bottom + 4 }, sections(), more);
		});
		row.append(el("td", { class: "actions" }, more));
		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			floatingMenu({ x: event.clientX, y: event.clientY }, sections(), more);
		});
		return row;
	};

	const folderRow = (folder: ExplorerFolder): HTMLElement =>
		withMenu(
			el(
				"tr",
				{},
				el(
					"td",
					{},
					el(
						"a",
						{ class: "explorer-name", href: folderHref(uuid, folder.uuid) },
						icon("folder", 18, "explorer-icon explorer-icon-folder"),
						el("span", { class: "explorer-label" }, folder.name)
					)
				),
				el("td", { class: "mono" }, ""),
				el("td", {}, sharingPill(folder, folder.parent !== null)),
				added(folder)
			),
			folder.name,
			() => folderMenu(folder)
		);

	const fileRow = (file: ExplorerFile): HTMLElement =>
		withMenu(
			el(
				"tr",
				{},
				el(
					"td",
					{},
					el(
						"button",
						{
							class: "link-button explorer-name",
							type: "button",
							title: previewable(file) ? t("explorer.preview") : t("files.download"),
							onClick: () => void (previewable(file) ? preview(file) : downloadFile(project, file)),
						},
						icon(viewerKind(file) === "image" ? "image" : viewerKind(file) === "video" ? "play" : "file", 18, "explorer-icon"),
						el("span", { class: "explorer-label" }, file.file_name)
					)
				),
				el("td", { class: "mono" }, formatBytes(file.byte_size)),
				el("td", {}, sharingPill(file, file.folder !== null)),
				added(file)
			),
			file.file_name,
			() => fileMenu(file)
		);

	const render = (state: Explorer) => {
		maxFileBytes = state.max_file_bytes;
		const atTop = state.folder === null;
		const scope = state.origin?.scope ?? state.scope;
		const steps: { label: string; href: string }[] = [
			{ label: t("explorer.title"), href: folderHref(uuid, null) },
			...(scope ? [{ label: t(SCOPE_LABELS[scope]), href: scopeHref(uuid, scope) }] : []),
			...(state.origin ? [{ label: ownerName(state.origin.owner), href: scopeHref(uuid, state.origin.scope, state.origin.owner.username) }] : []),
			...state.path.map((step) => ({ label: step.name, href: folderHref(uuid, step.uuid) })),
		];
		const crumbs = steps.flatMap((step, index) => [
			index === 0 ? null : el("span", { class: "muted" }, " / "),
			index === steps.length - 1 ? el("span", {}, step.label) : el("a", { href: step.href }, step.label),
		]);
		const builtIn = (target: ExplorerScope, people: number): HTMLElement =>
			el(
				"tr",
				{},
				el(
					"td",
					{},
					el(
						"a",
						{ class: "explorer-name", href: scopeHref(uuid, target) },
						icon(target === "shared" ? "user" : "globe", 18, "explorer-icon explorer-icon-built-in"),
						el("span", { class: "explorer-label" }, t(SCOPE_LABELS[target]))
					)
				),
				el("td", {}, ""),
				el("td", { class: "muted" }, t("explorer.people_count", { count: people })),
				el("td", {}, ""),
				el("td", {}, "")
			);
		const chatAttachmentsRow = (): HTMLElement =>
			el(
				"tr",
				{},
				el(
					"td",
					{},
					el(
						"a",
						{ class: "explorer-name", href: `/projects/${uuid}/files/chat-attachments` },
						icon("message", 18, "explorer-icon explorer-icon-built-in"),
						el("span", { class: "explorer-label" }, t("files.chat_title"))
					)
				),
				el("td", {}, ""),
				el("td", {}, ""),
				el("td", {}, ""),
				el("td", {}, "")
			);
		const personRow = (person: NonNullable<Explorer["people"]>[number]): HTMLElement =>
			el(
				"tr",
				{},
				el(
					"td",
					{},
					el(
						"a",
						{ class: "explorer-name", href: scopeHref(uuid, state.scope!, person.username) },
						icon("user", 18, "explorer-icon explorer-icon-folder"),
						el(
							"span",
							{ class: "explorer-label" },
							el("span", { class: "explorer-person" }, ownerName(person)),
							person.name && person.email ? el("span", { class: "muted explorer-date" }, person.email) : null
						)
					)
				),
				el("td", { class: "mono" }, String(person.items))
			);
		const headers = state.people
			? [t("workforce.person"), t("explorer.column_items")]
			: [t("explorer.column_name"), t("explorer.column_size"), t("explorer.column_shared"), t("explorer.column_added"), ""];
		const rows = state.people
			? state.people.map(personRow)
			: [
					...(atTop && !browsing ? [builtIn("shared", state.shared_people)] : []),
					...(atTop && !browsing && state.everyone_people !== null ? [builtIn("all", state.everyone_people)] : []),
					...(atTop && !browsing && can(project, Permission.CHAT_USE) && (project.workforce || project.workforce_until !== null) ? [chatAttachmentsRow()] : []),
					...state.folders.map((folder) => folderRow(folder)),
					...state.files.map((file) => fileRow(file)),
				];
		const usage =
			state.limit === null
				? t("explorer.usage_unlimited", { used: formatBytes(state.used) })
				: t("explorer.usage", { used: formatBytes(state.used), limit: formatBytes(state.limit) });
		const full = state.file_storage_remaining !== null && state.file_storage_remaining <= 0;

		content.replaceChildren(
			el(
				"div",
				{ class: "page-head" },
				el("h2", { class: "explorer-crumbs" }, ...crumbs),
				can(project, Permission.PROJECT_EDIT) ? el("a", { class: "button ghost small", href: `/projects/${uuid}/file-storage` }, t("explorer.manage")) : null
			),
			el(
				"div",
				{ class: browsing ? "toolbar explorer-hidden" : "toolbar" },
				el(
					"button",
					{
						class: "button ghost",
						type: "button",
						onClick: () =>
							nameDialog(t("explorer.new_folder"), t("explorer.folder_name"), "", async (name) => {
								await Api.createFolder(uuid, name, folderId);
								await reload();
							}),
					},
					t("explorer.new_folder")
				),
				uploadButton,
				el("div", { class: "explorer-usage" }, el("span", { class: "muted" }, usage), state.limit === null ? null : usageMeter(state.used, state.limit))
			),
			browsing
				? el("p", { class: "muted" }, t(state.scope === "all" ? "explorer.everyone_hint" : "explorer.shared_hint"))
				: atTop
					? el("p", { class: "muted" }, t("explorer.root_hint"))
					: el(
							"p",
							{ class: "muted explorer-sharing" },
							t("explorer.shared_label"),
							...(state.sharing.length
								? state.sharing.map((source) => sharingPill(source, false, state.sharing.length > 1 || source.uuid !== folderId ? `${source.name}: ` : ""))
								: [el("span", { class: "pill explorer-pill" }, t("explorer.access_none"))])
						),
			full ? el("p", { class: "warn" }, t("license.files_full")) : "",
			el(
				"div",
				{ class: "card" },
				rows.length
					? el("div", { class: "explorer-table" }, table(headers, rows))
					: emptyState(browsing ? t("explorer.shared_empty") : atTop ? t("explorer.empty_root") : t("explorer.empty"))
			),
			browsing ? "" : el("p", { class: "muted" }, t("files.hint", { size: formatBytes(state.max_file_bytes) })),
			picker
		);
	};

	render(await Api.explorer(uuid, location));
	return projectLayout(project, content);
}
