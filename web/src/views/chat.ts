import { Api, ApiError, getUsername, type ChatConversation, type ChatMessage, type ChatPerson, type FileUpload, type TicketFile } from "../api";
import { el, emptyState, field, input, select } from "../dom";
import { formatBytes, formatDate, formatTime } from "../money";
import { t, tn } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { actionMenu, floatingMenu, type MenuLink } from "../menu";
import { icon } from "../storefront/icons";
import { onLeave } from "../router";
import { onRealtime, type RealtimeEvent } from "../realtime";
import { openLightbox } from "../lightbox";
import { loadProject, projectLayout } from "./project";
import { confirmRemoval, downloadFile, openViewer, uploadFiles, viewerKind } from "./files";
import { inCall, startCall } from "../calls";
import { groupCallConversation, joinGroupCall } from "../group-call";
import { MAX_GROUP_NAME_LENGTH, MAX_MESSAGE_FILES, MAX_MESSAGE_LENGTH } from "../../../server/workforce/chat-limits";
import type { DateFormat, TimeFormat } from "../../../server/formats";

const CONVERSATION_NOT_FOUND = 1316;
const NEAR_BOTTOM_PX = 120;
const LOAD_OLDER_PX = 60;
const READ_DELAY_MS = 300;
const MEETING_LENGTHS = [15, 30, 45, 60, 90, 120, 180];

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function dateInputValue(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeInputValue(timestamp: number): string {
	const date = new Date(timestamp);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function meetingInputs(startsAt: number, minutes: number) {
	const date = input("date", { value: dateInputValue(startsAt), required: true });
	const hour = input("time", { value: timeInputValue(startsAt), required: true });
	const lengths = MEETING_LENGTHS.includes(minutes) ? MEETING_LENGTHS : [...MEETING_LENGTHS, minutes].sort((first, second) => first - second);
	const length = select(
		lengths.map((value) => ({ value: String(value), label: t("meetings.minutes", { count: value }) })),
		String(minutes)
	);
	return {
		row: el("div", { class: "form-grid" }, field(t("meetings.date"), date), field(t("meetings.time"), hour), field(t("meetings.duration"), length)),
		startsAt: () => new Date(`${date.value}T${hour.value}`).getTime(),
		minutes: () => Number(length.value),
	};
}

const LINK = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/g;

function chatPath(project: string, conversation?: string | null): string {
	return `/projects/${project}/chat${conversation ? `/${conversation}` : ""}`;
}

function titleOf(conversation: ChatConversation, me: string | null): string {
	if (conversation.kind === "group") return conversation.name ?? "";
	return conversation.participants.find((participant) => participant.account !== me)?.name || t("ui.deleted_user");
}

function sortConversations(conversations: ChatConversation[]) {
	conversations.sort((first, second) => (second.last_message_at ?? second.created) - (first.last_message_at ?? first.created));
}

function linked(text: string): (Node | string)[] {
	return text.split(LINK).map((part, index) => {
		if (index % 2 === 0) return part;
		const anchor = el("a", { href: part, target: "_blank", rel: "noopener noreferrer" }, part);
		return anchor;
	});
}

function peopleChecklist(people: ChatPerson[]): { element: HTMLElement; chosen: () => string[] } {
	const boxes = people.map((person) => ({ box: input("checkbox", { value: person.account }), person }));
	const search = input("search", { placeholder: t("chat.search_people") });
	const rows = boxes.map(({ box, person }) => ({ row: el("label", { class: "switch" }, box, el("span", {}, person.name)), person }));
	search.addEventListener("input", () => {
		const wanted = search.value.trim().toLowerCase();
		for (const { row, person } of rows) row.hidden = wanted !== "" && !person.name.toLowerCase().includes(wanted);
	});
	return {
		element: el(
			"div",
			{ class: "stack chat-people-picker" },
			people.length > 8 ? search : null,
			el("div", { class: "chat-people-list" }, ...rows.map(({ row }) => row))
		),
		chosen: () => boxes.filter(({ box }) => box.checked).map(({ box }) => box.value),
	};
}

export async function chatView(uuid: string, selected?: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const me = getUsername();
	const [listing, directory] = await Promise.all([Api.chatConversations(uuid), Api.chatPeople(uuid)]);
	const conversations = listing.conversations;
	let people = directory.people;

	let current: ChatConversation | null = null;
	let messages: ChatMessage[] = [];
	let hasMore = false;
	let loadingOlder = false;
	let editing: ChatMessage | null = null;
	let threadRound = 0;
	let readTimer: ReturnType<typeof setTimeout> | null = null;
	let staged: FileUpload[] = [];
	const previews = new Map<string, string>();

	const listItems = el("nav", { class: "chat-list-items" });
	listItems.setAttribute("aria-label", t("chat.conversations"));
	const thread = el("section", { class: "chat-thread" });
	const root = el("div", { class: "chat" });

	const others = () => people.filter((person) => person.account !== me);
	const day = (timestamp: number) => formatDate(timestamp, project.date_format as DateFormat, project.timezone);
	const time = (timestamp: number) => formatTime(timestamp, project.time_format as TimeFormat, project.timezone);

	function callLabel(message: ChatMessage): string {
		const call = message.call!;
		if (call.outcome === "missed") return message.author === me ? t("calls.log_no_answer") : t("calls.log_missed");
		if (call.outcome === "declined") return t("calls.log_declined");
		if (call.outcome === "cancelled") return t("calls.log_cancelled");
		const length = `${Math.floor(call.seconds / 60)}:${String(call.seconds % 60).padStart(2, "0")}`;
		return `${call.video ? t("calls.log_video") : t("calls.log_voice")} | ${length}`;
	}

	function meetingWhen(conversation: ChatConversation): string {
		const meeting = conversation.meeting!;
		return `${day(meeting.starts_at)} ${time(meeting.starts_at)} | ${t("meetings.minutes", { count: meeting.duration_minutes })}`;
	}

	function previewOf(conversation: ChatConversation): string {
		const last = conversation.last_message;
		if (!last && conversation.meeting) return meetingWhen(conversation);
		if (!last) return t("chat.no_messages");
		if (last.call) return callLabel(last);
		if (last.deleted || last.body === null) return t("chat.message_deleted");
		const author = last.author === me ? t("chat.you") : conversation.kind === "group" ? last.author_name : null;
		const text = last.body || t("chat.attachment");
		return author ? `${author}: ${text}` : text;
	}

	function renderList() {
		sortConversations(conversations);
		if (conversations.length === 0) {
			listItems.replaceChildren(el("p", { class: "muted chat-list-empty" }, others().length === 0 ? t("chat.nobody") : t("chat.empty")));
			return;
		}
		const today = day(Date.now());
		listItems.replaceChildren(
			...conversations.map((conversation) => {
				const stamp = conversation.last_message_at;
				const active = current?.uuid === conversation.uuid;
				const link = el(
					"a",
					{ class: `chat-item${active ? " active" : ""}${conversation.unread > 0 ? " unread" : ""}`, href: chatPath(uuid, conversation.uuid) },
					el(
						"span",
						{ class: "chat-item-head" },
						el("span", { class: "chat-item-name" }, titleOf(conversation, me)),
						stamp === null ? null : el("span", { class: "chat-item-time" }, day(stamp) === today ? time(stamp) : day(stamp))
					),
					el(
						"span",
						{ class: "chat-item-foot" },
						el("span", { class: "chat-item-preview" }, conversation.call ? t("calls.in_progress") : previewOf(conversation)),
						conversation.unread > 0 ? el("span", { class: "nav-badge" }, conversation.unread > 99 ? "99+" : String(conversation.unread)) : null
					)
				);
				if (active) link.setAttribute("aria-current", "true");
				link.addEventListener("click", (event) => {
					if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
					event.preventDefault();
					event.stopPropagation();
					void select(conversation.uuid);
				});
				return link;
			})
		);
	}

	function scheduleRead() {
		if (readTimer !== null || current === null || current.unread === 0 || document.visibilityState !== "visible") return;
		readTimer = setTimeout(async () => {
			readTimer = null;
			const conversation = current;
			if (conversation === null || conversation.unread === 0 || document.visibilityState !== "visible") return;
			try {
				const result = await Api.markChatRead(uuid, conversation.uuid, conversation.last_number);
				conversation.read_number = result.read_number;
				if (result.read_number >= conversation.last_number) conversation.unread = 0;
				renderList();
			} catch {
				void 0;
			}
		}, READ_DELAY_MS);
	}

	function messageActions(message: ChatMessage): MenuLink[] {
		if (message.deleted || message.call !== null || current === null) return [];
		const own = message.author === me;
		const links: MenuLink[] = [];
		if (own) links.push({ label: t("ui.edit"), onSelect: () => startEditing(message) });
		if (own || (current.kind === "group" && current.admin)) links.push({ label: t("ui.delete"), danger: true, onSelect: () => void removeMessage(message) });
		return links;
	}

	function fileNode(message: ChatMessage, file: TicketFile): HTMLElement {
		if (file.removed) {
			const name = file.removed_by_name || null;
			return el(
				"div",
				{ class: "chat-file chat-file-removed" },
				el("span", { class: "chat-file-name" }, file.file_name),
				el("span", { class: "muted" }, name ? t("chat.attachment_deleted_by", { name }) : t("chat.attachment_deleted"))
			);
		}
		const kind = viewerKind(file);
		const open = () => {
			if (kind === "video" || kind === "pdf") void openViewer(project, file, kind);
			else void downloadFile(project, file);
		};
		const removable = file.created_by === me || (current?.kind === "group" && current.admin);
		const remove = removable
			? el(
					"button",
					{ class: "icon-button", type: "button", title: t("files.remove"), onClick: () => void confirmRemoval(project, file, true) },
					icon("trash", 16)
				)
			: null;
		if (kind === "image") {
			const image = el("img", { class: "chat-file-image", alt: file.file_name });
			const zoom = el("button", { class: "chat-file-thumb", type: "button", title: file.file_name }, image);
			zoom.addEventListener("click", () => {
				const source = previews.get(file.uuid);
				if (source) openLightbox([{ src: source, alt: file.file_name }]);
			});
			const cached = previews.get(file.uuid);
			if (cached) image.src = cached;
			else {
				zoom.disabled = true;
				void Api.file(uuid, file.uuid)
					.then(({ blob }) => {
						const url = URL.createObjectURL(blob);
						previews.set(file.uuid, url);
						for (const shown of scroller.querySelectorAll<HTMLImageElement>(`img[data-file="${file.uuid}"]`)) {
							shown.src = url;
							(shown.parentElement as HTMLButtonElement).disabled = false;
						}
					})
					.catch(() => undefined);
			}
			image.dataset.file = file.uuid;
			image.addEventListener("load", () => {
				if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX + image.height) scroller.scrollTop = scroller.scrollHeight;
			});
			return el("div", { class: "chat-file chat-file-picture" }, zoom, remove);
		}
		return el(
			"div",
			{ class: "chat-file" },
			el("button", { class: "link-button chat-file-name", type: "button", onClick: open }, file.file_name),
			el("span", { class: "muted" }, formatBytes(file.byte_size)),
			remove
		);
	}

	function messageNode(message: ChatMessage, showAuthor: boolean): HTMLElement {
		if (message.call) {
			return el("div", { class: `chat-call-log${message.call.outcome === "missed" ? " missed" : ""}` }, `${callLabel(message)} | ${time(message.created)}`);
		}
		const own = message.author === me;
		const actions = messageActions(message);
		const more =
			actions.length > 0 ? el("button", { class: "icon-button chat-message-more", type: "button", title: t("chat.message_actions") }, icon("more", 16)) : null;
		more?.addEventListener("click", () => {
			const box = more.getBoundingClientRect();
			floatingMenu({ x: box.left, y: box.bottom + 4 }, [actions], more);
		});
		const bubble = message.deleted
			? el("div", { class: "chat-bubble" }, t("chat.message_deleted"))
			: message.body
				? el("div", { class: "chat-bubble" }, ...linked(message.body))
				: null;
		const files = message.files.length > 0 ? el("div", { class: "chat-files" }, ...message.files.map((file) => fileNode(message, file))) : null;
		return el(
			"div",
			{ class: `chat-message${own ? " own" : ""}${message.deleted ? " deleted" : ""}${editing?.uuid === message.uuid ? " editing" : ""}` },
			showAuthor ? el("span", { class: "chat-message-author" }, message.author_name) : null,
			el("div", { class: "chat-message-row" }, el("div", { class: "chat-message-content" }, bubble, files), more),
			el("span", { class: "chat-message-foot" }, time(message.created), message.edited_at !== null && !message.deleted ? ` | ${t("chat.edited")}` : null)
		);
	}

	const scroller = el("div", { class: "chat-messages" });
	scroller.tabIndex = 0;
	const composerText = el("textarea", { rows: "1", maxlength: String(MAX_MESSAGE_LENGTH), placeholder: t("chat.write_message") });
	composerText.setAttribute("aria-label", t("chat.write_message"));
	const sendButton = el("button", { class: "button primary", type: "submit" }, t("chat.send"));
	const picker = input("file");
	picker.multiple = true;
	picker.hidden = true;
	const attachButton = el(
		"button",
		{ class: "icon-button chat-attach", type: "button", title: t("chat.attach"), onClick: () => picker.click() },
		icon("paperclip", 20)
	);
	attachButton.setAttribute("aria-label", t("chat.attach"));
	const uploadState = el("button", {});
	const stagedList = el("div", { class: "chat-staged" });
	stagedList.hidden = true;

	function renderStaged() {
		stagedList.hidden = staged.length === 0;
		stagedList.replaceChildren(
			...staged.map((file) =>
				el(
					"span",
					{ class: "chat-staged-file" },
					el("span", { class: "chat-file-name" }, file.file_name),
					el("span", { class: "muted" }, formatBytes(file.byte_size)),
					el(
						"button",
						{
							class: "icon-button",
							type: "button",
							title: t("files.remove"),
							onClick: () => {
								staged = staged.filter((other) => other.uuid !== file.uuid);
								void Api.removeFile(uuid, file.uuid).catch(() => undefined);
								renderStaged();
							},
						},
						icon("close", 14)
					)
				)
			)
		);
	}

	function dropStaged() {
		for (const file of staged) void Api.removeFile(uuid, file.uuid).catch(() => undefined);
		staged = [];
		renderStaged();
	}

	async function attach(files: File[]) {
		const conversation = current;
		if (conversation === null || files.length === 0) return;
		const room = MAX_MESSAGE_FILES - staged.length;
		if (files.length > room) toast(t("chat.too_many_files", { count: MAX_MESSAGE_FILES }), "error");
		const begun: FileUpload[] = [];
		attachButton.disabled = true;
		const stored = await uploadFiles(
			files.slice(0, Math.max(room, 0)),
			listing.max_file_bytes,
			async (file) => {
				const upload = await Api.beginChatFile(uuid, conversation.uuid, { name: file.name, type: file.type, size: file.size });
				begun.push(upload);
				return upload;
			},
			project,
			uploadState,
			""
		);
		attachButton.disabled = false;
		const finished = begun.slice(0, stored);
		if (current !== conversation) {
			for (const file of finished) void Api.removeFile(uuid, file.uuid).catch(() => undefined);
			return;
		}
		staged.push(...finished);
		renderStaged();
		composerText.focus();
	}

	picker.addEventListener("change", () => {
		const chosen = [...(picker.files ?? [])];
		picker.value = "";
		void attach(chosen);
	});
	composerText.addEventListener("paste", (event) => {
		const pasted = [...(event.clipboardData?.files ?? [])];
		if (pasted.length === 0) return;
		event.preventDefault();
		void attach(pasted);
	});
	const editingBar = el("div", { class: "chat-editing" });
	editingBar.hidden = true;

	function fitComposer() {
		composerText.style.height = "auto";
		composerText.style.height = `${Math.min(composerText.scrollHeight, 180)}px`;
	}

	function renderMessages(stick: "bottom" | "keep" | "auto") {
		const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;
		const previousHeight = scroller.scrollHeight;
		const previousTop = scroller.scrollTop;
		const nodes: HTMLElement[] = [];
		if (hasMore) {
			nodes.push(el("button", { class: "button ghost chat-older", type: "button", onClick: () => void loadOlder() }, t("chat.load_older")));
		}
		let lastDay = "";
		let lastAuthor: string | null | undefined;
		for (const message of messages) {
			const label = day(message.created);
			if (label !== lastDay) {
				nodes.push(el("div", { class: "chat-day" }, el("span", {}, label)));
				lastDay = label;
				lastAuthor = undefined;
			}
			const showAuthor = current?.kind === "group" && message.author !== me && message.author !== lastAuthor;
			nodes.push(messageNode(message, showAuthor));
			lastAuthor = message.call ? undefined : message.author;
		}
		if (messages.length === 0) nodes.push(el("p", { class: "muted chat-thread-empty" }, t("chat.thread_empty")));
		scroller.replaceChildren(...nodes);
		if (stick === "bottom" || (stick === "auto" && nearBottom)) scroller.scrollTop = scroller.scrollHeight;
		else if (stick === "keep") scroller.scrollTop = previousTop + (scroller.scrollHeight - previousHeight);
		else scroller.scrollTop = previousTop;
	}

	async function loadOlder() {
		if (!hasMore || loadingOlder || current === null || messages.length === 0) return;
		loadingOlder = true;
		const round = threadRound;
		try {
			const page = await Api.chatMessages(uuid, current.uuid, messages[0].number);
			if (round !== threadRound) return;
			messages = [...page.messages, ...messages];
			hasMore = page.has_more;
			renderMessages("keep");
		} catch (error) {
			reportError(error);
		} finally {
			loadingOlder = false;
		}
	}

	scroller.addEventListener("scroll", () => {
		if (scroller.scrollTop < LOAD_OLDER_PX) void loadOlder();
	});

	function stopEditing() {
		editing = null;
		editingBar.hidden = true;
		composerText.value = "";
		sendButton.textContent = t("chat.send");
		fitComposer();
		renderMessages("auto");
	}

	function startEditing(message: ChatMessage) {
		editing = message;
		editingBar.replaceChildren(
			el("span", {}, t("chat.editing")),
			el("button", { class: "button ghost", type: "button", onClick: stopEditing }, t("ui.cancel"))
		);
		editingBar.hidden = false;
		composerText.value = message.body ?? "";
		sendButton.textContent = t("ui.save");
		fitComposer();
		renderMessages("auto");
		composerText.focus();
	}

	function placeMessage(message: ChatMessage): boolean {
		if (current === null || message.conversation !== current.uuid) return false;
		const index = messages.findIndex((existing) => existing.uuid === message.uuid);
		if (index !== -1) {
			messages[index] = message;
			return false;
		}
		if (messages.length > 0 && message.number < messages[0].number) return false;
		messages.push(message);
		messages.sort((first, second) => first.number - second.number);
		return true;
	}

	function noteMessage(conversation: ChatConversation, message: ChatMessage) {
		if (message.number > conversation.last_number) {
			conversation.last_number = message.number;
			conversation.last_message = message;
			conversation.last_message_at = message.created;
			if (message.author === me) conversation.read_number = message.number;
			else if (!message.deleted) conversation.unread++;
		} else if (conversation.last_message?.uuid === message.uuid) {
			conversation.last_message = message;
		}
	}

	async function removeMessage(message: ChatMessage) {
		const confirmed = await confirmDialog({
			title: t("chat.delete_title"),
			body: t("chat.delete_body"),
			confirmLabel: t("ui.delete"),
			destructive: true,
		});
		if (!confirmed || current === null) return;
		try {
			const removed = await Api.deleteChatMessage(uuid, current.uuid, message.uuid);
			placeMessage(removed);
			noteMessage(current, removed);
			if (editing?.uuid === removed.uuid) stopEditing();
			renderMessages("auto");
			renderList();
		} catch (error) {
			reportError(error);
		}
	}

	async function submit() {
		const conversation = current;
		const body = composerText.value.trim();
		if (conversation === null || sendButton.disabled || attachButton.disabled) return;
		if (body === "" && (editing === null ? staged.length === 0 : editing.files.length === 0)) return;
		sendButton.disabled = true;
		try {
			if (editing !== null) {
				const edited = await Api.editChatMessage(uuid, conversation.uuid, editing.uuid, body);
				placeMessage(edited);
				noteMessage(conversation, edited);
				stopEditing();
			} else {
				const sent = await Api.sendChatMessage(
					uuid,
					conversation.uuid,
					body,
					staged.map((file) => file.uuid)
				);
				staged = [];
				renderStaged();
				composerText.value = "";
				fitComposer();
				placeMessage(sent);
				noteMessage(conversation, sent);
				if (current === conversation) renderMessages("bottom");
			}
			renderList();
		} catch (error) {
			reportError(error);
		} finally {
			sendButton.disabled = false;
			composerText.focus();
		}
	}

	composerText.addEventListener("input", fitComposer);
	composerText.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && editing !== null) {
			event.preventDefault();
			stopEditing();
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.isComposing || window.matchMedia("(pointer: coarse)").matches) return;
		event.preventDefault();
		void submit();
	});
	const composer = el(
		"form",
		{
			class: "chat-composer",
			onSubmit: (event) => {
				event.preventDefault();
				void submit();
			},
		},
		editingBar,
		stagedList,
		el("div", { class: "chat-composer-row" }, attachButton, composerText, sendButton),
		picker
	);

	function renderThread() {
		if (current === null) {
			thread.replaceChildren(emptyState(conversations.length === 0 ? t("chat.empty") : t("chat.pick")));
			return;
		}
		const conversation = current;
		const back = el("a", { class: "icon-button chat-back", href: chatPath(uuid), title: t("chat.back") }, icon("left", 18));
		back.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void select(null);
		});
		const inThisCall = groupCallConversation() === conversation.uuid;
		const groupCallLabel = conversation.call ? t("calls.join", { count: conversation.call.people }) : t("calls.start_group");
		const groupCall =
			conversation.kind === "group" && listing.group_calls && !inThisCall
				? el(
						"button",
						{
							class: conversation.call ? "button primary chat-join-call" : "icon-button chat-head-action",
							type: "button",
							title: groupCallLabel,
							onClick: () => void joinGroupCall(uuid, conversation.uuid, titleOf(conversation, me), inCall),
						},
						icon("video", conversation.call ? 18 : 20),
						conversation.call ? el("span", {}, String(conversation.call.people)) : null
					)
				: null;
		groupCall?.setAttribute("aria-label", groupCallLabel);
		const details =
			conversation.kind === "group"
				? el("button", { class: "button ghost", type: "button", onClick: () => groupDialog(conversation) }, t("chat.group_details"))
				: null;
		const people = tn("chat.people_count", conversation.participants.length);
		const subtitle = conversation.meeting ? `${meetingWhen(conversation)} | ${people}` : conversation.kind === "group" ? people : t("chat.direct_hint");
		const reachable = conversation.kind === "direct" && conversation.participants.some((participant) => participant.account !== me && participant.active);
		const call = (video: boolean) => {
			const label = video ? t("calls.video_call") : t("calls.call");
			const button = el(
				"button",
				{
					class: "icon-button chat-head-action",
					type: "button",
					title: label,
					onClick: () => void startCall(uuid, conversation.uuid, titleOf(conversation, me), video),
				},
				icon(video ? "video" : "phone", 20)
			);
			button.setAttribute("aria-label", label);
			return button;
		};
		thread.replaceChildren(
			el(
				"header",
				{ class: "chat-thread-head" },
				back,
				el("div", { class: "chat-thread-title" }, el("h2", {}, titleOf(conversation, me)), el("span", { class: "muted" }, subtitle)),
				reachable ? call(false) : null,
				reachable ? call(true) : null,
				groupCall,
				details
			),
			scroller,
			composer
		);
	}

	async function select(conversationId: string | null, push = true) {
		const round = ++threadRound;
		const target = conversationId === null ? null : (conversations.find((conversation) => conversation.uuid === conversationId) ?? null);
		if (push) history.pushState({}, "", chatPath(uuid, target?.uuid));
		current = target;
		messages = [];
		hasMore = false;
		editing = null;
		editingBar.hidden = true;
		composerText.value = "";
		sendButton.textContent = t("chat.send");
		dropStaged();
		root.classList.toggle("has-thread", current !== null);
		renderList();
		renderThread();
		if (target === null) return;
		scroller.replaceChildren(el("p", { class: "muted chat-thread-empty" }, t("ui.loading")));
		try {
			const page = await Api.chatMessages(uuid, target.uuid);
			if (round !== threadRound) return;
			messages = page.messages;
			hasMore = page.has_more;
			renderMessages("bottom");
			fitComposer();
			if (!window.matchMedia("(pointer: coarse)").matches) composerText.focus();
			scheduleRead();
		} catch (error) {
			if (round !== threadRound) return;
			reportError(error);
		}
	}

	async function refreshConversation(conversationId: string) {
		const indexNow = () => conversations.findIndex((conversation) => conversation.uuid === conversationId);
		try {
			const fresh = await Api.chatConversation(uuid, conversationId);
			const index = indexNow();
			if (index === -1) conversations.push(fresh);
			else if (fresh.last_number >= conversations[index].last_number) Object.assign(conversations[index], fresh);
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== CONVERSATION_NOT_FOUND) return;
			const index = indexNow();
			if (index !== -1) conversations.splice(index, 1);
			if (current?.uuid === conversationId) {
				toast(t("chat.no_longer_member"), "info");
				await select(null);
				return;
			}
		}
		renderList();
		if (current?.uuid === conversationId) renderThread();
	}

	async function openConversation(conversation: ChatConversation) {
		const existing = conversations.find((known) => known.uuid === conversation.uuid);
		if (existing) Object.assign(existing, conversation);
		else conversations.push(conversation);
		await select(conversation.uuid);
	}

	function newMessageDialog() {
		const search = input("search", { placeholder: t("chat.search_people") });
		const rows = others().map((person) => {
			const row = el("button", { class: "chat-person", type: "button" }, person.name);
			row.addEventListener("click", async () => {
				try {
					const conversation = await Api.openDirectChat(uuid, person.account);
					dialog.close();
					await openConversation(conversation);
				} catch (error) {
					reportError(error);
				}
			});
			return { row, person };
		});
		search.addEventListener("input", () => {
			const wanted = search.value.trim().toLowerCase();
			for (const { row, person } of rows) row.hidden = wanted !== "" && !person.name.toLowerCase().includes(wanted);
		});
		const dialog = modal(
			t("chat.new_message"),
			rows.length === 0
				? el("p", { class: "muted" }, t("chat.nobody"))
				: el("div", { class: "stack" }, rows.length > 8 ? search : null, el("div", { class: "chat-people-list" }, ...rows.map(({ row }) => row))),
			undefined,
			""
		);
	}

	function newGroupDialog() {
		const name = input("text", { maxlength: String(MAX_GROUP_NAME_LENGTH), required: true });
		const picker = peopleChecklist(others());
		const create = el("button", { class: "button primary", type: "submit" }, t("chat.create_group"));
		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const accounts = picker.chosen();
					if (accounts.length === 0) {
						toast(t("chat.pick_people"), "error");
						return;
					}
					create.disabled = true;
					try {
						const conversation = await Api.createChatGroup(uuid, name.value.trim(), accounts);
						dialog.close();
						await openConversation(conversation);
					} catch (error) {
						reportError(error);
						create.disabled = false;
					}
				},
			},
			field(t("chat.group_name"), name),
			el("strong", {}, t("chat.group_people")),
			picker.element,
			el("div", { class: "dialog-actions" }, create)
		);
		const dialog = modal(t("chat.new_group"), others().length === 0 ? el("p", { class: "muted" }, t("chat.nobody")) : form, undefined, "");
	}

	function meetingDialog() {
		const title = input("text", { maxlength: String(MAX_GROUP_NAME_LENGTH), required: true });
		const nextHour = Math.ceil((Date.now() + 5 * 60 * 1000) / 3600_000) * 3600_000;
		const times = meetingInputs(nextHour, 60);
		const picker = peopleChecklist(others());
		const guests = input("checkbox");
		const create = el("button", { class: "button primary", type: "submit" }, t("meetings.schedule"));
		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const startsAt = times.startsAt();
					if (!Number.isFinite(startsAt)) return;
					create.disabled = true;
					try {
						const conversation = await Api.scheduleMeeting(uuid, {
							title: title.value.trim(),
							starts_at: startsAt,
							duration_minutes: times.minutes(),
							accounts: picker.chosen(),
							guests: guests.checked,
						});
						dialog.close();
						toast(t("meetings.scheduled"), "success");
						await openConversation(conversation);
					} catch (error) {
						reportError(error);
						create.disabled = false;
					}
				},
			},
			field(t("meetings.title_label"), title),
			times.row,
			others().length > 0 ? el("strong", {}, t("meetings.people")) : null,
			others().length > 0 ? picker.element : null,
			el("label", { class: "switch" }, guests, el("span", {}, t("meetings.allow_guests"))),
			el("p", { class: "muted" }, t("meetings.allow_guests_hint")),
			el("div", { class: "dialog-actions" }, create)
		);
		const dialog = modal(t("meetings.schedule"), form, undefined, "");
	}

	function meetingSection(conversation: ChatConversation, apply: (fresh: ChatConversation) => void): HTMLElement {
		const meeting = conversation.meeting!;
		const section = el("div", { class: "stack chat-meeting" }, el("strong", {}, t("meetings.label")));
		const linkHolder = el("div", { class: "stack" });
		if (meeting.guests) {
			void Api.meetingGuestLink(uuid, conversation.uuid)
				.then(({ url }) => {
					if (url === null) return;
					const shown = input("text", { value: url });
					shown.readOnly = true;
					shown.addEventListener("focus", () => shown.select());
					const copy = el("button", { class: "button ghost", type: "button" }, t("ui.copy"));
					copy.addEventListener("click", async () => {
						try {
							await navigator.clipboard.writeText(url);
							toast(t("ui.copied"), "success");
						} catch {
							toast(t("ui.copy_failed"), "error");
							shown.focus();
						}
					});
					linkHolder.replaceChildren(el("div", { class: "chat-rename" }, field(t("meetings.guest_link"), shown), copy));
				})
				.catch(() => undefined);
		}
		if (!conversation.admin) {
			section.append(el("p", {}, meetingWhen(conversation)), linkHolder);
			return section;
		}
		const times = meetingInputs(meeting.starts_at, meeting.duration_minutes);
		const guests = input("checkbox");
		guests.checked = meeting.guests;
		const save = el("button", { class: "button ghost", type: "submit" }, t("ui.save"));
		const reset = el("button", { class: "button ghost", type: "button" }, t("meetings.reset_link"));
		reset.addEventListener("click", async () => {
			const confirmed = await confirmDialog({
				title: t("meetings.reset_title"),
				body: t("meetings.reset_body"),
				confirmLabel: t("meetings.reset_link"),
				destructive: true,
			});
			if (!confirmed) return;
			try {
				apply(await Api.updateMeeting(uuid, conversation.uuid, { reset_guest_link: true }));
			} catch (error) {
				reportError(error);
			}
		});
		section.append(
			el(
				"form",
				{
					class: "stack",
					onSubmit: async (event) => {
						event.preventDefault();
						const startsAt = times.startsAt();
						if (!Number.isFinite(startsAt)) return;
						try {
							apply(await Api.updateMeeting(uuid, conversation.uuid, { starts_at: startsAt, duration_minutes: times.minutes(), guests: guests.checked }));
							toast(t("meetings.saved"), "success");
						} catch (error) {
							reportError(error);
						}
					},
				},
				times.row,
				el("label", { class: "switch" }, guests, el("span", {}, t("meetings.allow_guests"))),
				el("div", { class: "form-actions" }, save, meeting.guests ? reset : null)
			),
			linkHolder
		);
		return section;
	}

	function groupDialog(conversation: ChatConversation) {
		const content = el("div", { class: "stack" });
		const dialog = modal(t("chat.group_details"), content, undefined, "");

		const apply = (fresh: ChatConversation) => {
			Object.assign(conversation, fresh);
			renderList();
			if (current?.uuid === conversation.uuid) renderThread();
			draw();
		};

		function draw() {
			const name = input("text", { value: conversation.name ?? "", maxlength: String(MAX_GROUP_NAME_LENGTH), required: true });
			const rename = el(
				"form",
				{
					class: "chat-rename",
					onSubmit: async (event) => {
						event.preventDefault();
						try {
							apply(await Api.renameChatGroup(uuid, conversation.uuid, name.value.trim()));
							toast(t("chat.group_renamed"), "success");
						} catch (error) {
							reportError(error);
						}
					},
				},
				field(t("chat.group_name"), name),
				el("button", { class: "button ghost", type: "submit" }, t("ui.save"))
			);

			const members = conversation.participants.map((participant) => {
				const remove =
					conversation.admin && participant.account !== me
						? el("button", { class: "icon-button chat-head-action", type: "button", title: t("chat.remove_person") }, icon("close", 18))
						: null;
				remove?.setAttribute("aria-label", `${t("chat.remove_person")}: ${participant.name}`);
				remove?.addEventListener("click", async () => {
					try {
						await Api.removeChatPerson(uuid, conversation.uuid, participant.account);
						apply(await Api.chatConversation(uuid, conversation.uuid));
					} catch (error) {
						reportError(error);
					}
				});
				return el(
					"li",
					{ class: "chat-member" },
					el("span", { class: "chat-member-name" }, participant.name || t("ui.deleted_user"), participant.account === me ? ` (${t("chat.you")})` : null),
					participant.admin ? el("span", { class: "pill" }, t("chat.admin")) : null,
					!participant.active ? el("span", { class: "pill" }, t("chat.inactive")) : null,
					remove
				);
			});

			const present = new Set(conversation.participants.map((participant) => participant.account));
			const candidates = people.filter((person) => !present.has(person.account));
			const picker = peopleChecklist(candidates);
			const add = el("button", { class: "button ghost", type: "button" }, t("chat.add_people"));
			add.addEventListener("click", async () => {
				const accounts = picker.chosen();
				if (accounts.length === 0) {
					toast(t("chat.pick_people"), "error");
					return;
				}
				try {
					apply(await Api.addChatPeople(uuid, conversation.uuid, accounts));
				} catch (error) {
					reportError(error);
				}
			});

			const leave = el("button", { class: "button danger", type: "button" }, t("chat.leave_group"));
			leave.addEventListener("click", async () => {
				const confirmed = await confirmDialog({
					title: t("chat.leave_title"),
					body: t("chat.leave_body"),
					confirmLabel: t("chat.leave_group"),
					destructive: true,
				});
				if (!confirmed || me === null) return;
				try {
					await Api.removeChatPerson(uuid, conversation.uuid, me);
					dialog.close();
					const index = conversations.indexOf(conversation);
					if (index !== -1) conversations.splice(index, 1);
					await select(null);
				} catch (error) {
					reportError(error);
				}
			});

			const adding =
				conversation.admin && candidates.length > 0 ? [el("div", { class: "stack" }, el("strong", {}, t("chat.add_people")), picker.element, add)] : [];
			content.replaceChildren(
				conversation.admin ? rename : el("p", {}, el("strong", {}, conversation.name ?? "")),
				...(conversation.meeting ? [meetingSection(conversation, apply)] : []),
				el("strong", {}, tn("chat.people_count", conversation.participants.length)),
				el("ul", { class: "chat-members" }, ...members),
				...adding,
				el("div", { class: "dialog-actions" }, leave)
			);
		}

		draw();
	}

	async function reload() {
		try {
			const [freshList, freshPeople] = await Promise.all([Api.chatConversations(uuid), Api.chatPeople(uuid)]);
			conversations.splice(0, conversations.length, ...freshList.conversations);
			people = freshPeople.people;
			const stillOpen = current === null ? null : (conversations.find((conversation) => conversation.uuid === current!.uuid) ?? null);
			if (current !== null && stillOpen === null) {
				await select(null);
				return;
			}
			if (stillOpen !== null) {
				current = stillOpen;
				const page = await Api.chatMessages(uuid, stillOpen.uuid);
				messages = page.messages;
				hasMore = page.has_more;
				renderMessages("auto");
				scheduleRead();
			}
			renderList();
		} catch {
			void 0;
		}
	}

	function onEvent(event: RealtimeEvent) {
		if (event.type === "realtime.ready") {
			if (event.reconnected) void reload();
			return;
		}
		if (event.project !== uuid || typeof event.conversation !== "string") return;
		const conversation = conversations.find((known) => known.uuid === event.conversation);

		if (event.type === "chat.conversation") {
			void refreshConversation(event.conversation);
			return;
		}
		if (event.type === "call.group") {
			if (conversation) {
				conversation.call = (event.info as ChatConversation["call"]) ?? null;
				renderList();
				if (current?.uuid === conversation.uuid) setTimeout(renderThread, 0);
			}
			return;
		}
		if (!conversation) {
			void refreshConversation(event.conversation);
			return;
		}
		if (event.type === "chat.read") {
			conversation.read_number = Number(event.read_number);
			if (conversation.read_number >= conversation.last_number) conversation.unread = 0;
			else void refreshConversation(conversation.uuid);
			renderList();
			return;
		}
		if (event.type !== "chat.message" && event.type !== "chat.message_changed") return;

		const message = event.message as ChatMessage;
		const known = current?.uuid === conversation.uuid && messages.some((existing) => existing.uuid === message.uuid);
		if (event.type === "chat.message" && !known) noteMessage(conversation, message);
		else if (conversation.last_message?.uuid === message.uuid) conversation.last_message = message;
		if (event.type === "chat.message_changed" && message.deleted && current?.uuid !== conversation.uuid) void refreshConversation(conversation.uuid);

		if (current?.uuid === conversation.uuid) {
			placeMessage(message);
			if (editing?.uuid === message.uuid && message.deleted) stopEditing();
			else renderMessages("auto");
			scheduleRead();
		}
		renderList();
	}

	const onVisible = () => scheduleRead();
	document.addEventListener("visibilitychange", onVisible);
	const stopListening = onRealtime(onEvent);
	onLeave(() => {
		stopListening();
		document.removeEventListener("visibilitychange", onVisible);
		if (readTimer !== null) clearTimeout(readTimer);
		threadRound++;
		dropStaged();
		for (const url of previews.values()) URL.revokeObjectURL(url);
	});

	const create = actionMenu(t("chat.new"), [
		[
			{ label: t("chat.new_message"), onSelect: newMessageDialog },
			{ label: t("chat.new_group"), onSelect: newGroupDialog },
			...(listing.group_calls ? [{ label: t("meetings.schedule"), onSelect: meetingDialog }] : []),
		],
	]);
	root.append(el("aside", { class: "chat-list" }, el("div", { class: "chat-list-head" }, el("h2", {}, t("nav.chat")), create), listItems), thread);

	const initial = selected && conversations.some((conversation) => conversation.uuid === selected) ? selected : null;
	if (selected && initial === null) history.replaceState({}, "", chatPath(uuid));
	void select(initial, false);

	return projectLayout(project, root);
}
