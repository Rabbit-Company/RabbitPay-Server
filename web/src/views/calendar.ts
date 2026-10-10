import { Api, getUsername, type CalendarEntry, type CalendarFeed, type CalendarPerson, type ChatPresence } from "../api";
import { el } from "../dom";
import { t, type UiKey } from "../i18n";
import { reportError } from "../ui";
import { icon } from "../storefront/icons";
import { onLeave } from "../router";
import { onRealtime, type RealtimeEvent } from "../realtime";
import { inCall } from "../calls";
import { joinGroupCall } from "../group-call";
import { loadProject, projectLayout } from "./project";
import { formatDay, shiftDate, weekStart } from "./workforce-shared";
import { openEditor, removeEntry, type CalendarContext } from "./calendar-editor";
import {
	avatar,
	bookedMinutes,
	clock,
	coversDate,
	dateKey,
	dayStart,
	DAY_MINUTES,
	describeRepeat,
	entryTitle,
	entryWhen,
	formatLength,
	involves,
	longDayLabel,
	MINUTE_MS,
	monthLabel,
	paint,
	personColor,
	presenceDot,
	seriesStartsOn,
	statusOf,
	todayKey,
	weekdayLabel,
} from "./calendar-shared";

type Mode = "day" | "week" | "month" | "team";

interface ViewState {
	mode: Mode;
	anchor: string;
	selected: Set<string>;
}

interface Column {
	date: string;
	accounts: string[];
	person: CalendarPerson | null;
}

interface Block {
	entry: CalendarEntry;
	start: number;
	end: number;
	lane: number;
	lanes: number;
}

const MODES: Mode[] = ["day", "week", "month", "team"];
const HOUR_PX = 52;
const SLOT_MINUTES = 30;
const SHORTEST_BLOCK_MINUTES = 22;
const FIRST_SHOWN_HOUR = 7;
const TEAM_FROM_HOUR = 7;
const TEAM_TO_HOUR = 19;
const FULL_WEEK_MINUTES = 40 * 60;
const MONTH_CHIPS = 3;
const NARROW_PX = 760;
const POPOVER_WIDTH = 340;
const RELOAD_DELAY_MS = 300;

const remembered = new Map<string, ViewState>();

function isoWeek(key: string): number {
	const [year, month, day] = key.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
	const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
	return Math.ceil(((date.getTime() - yearStart) / (24 * 60 * MINUTE_MS) + 1) / 7);
}

function arrange(blocks: Block[]) {
	blocks.sort((first, second) => first.start - second.start || second.end - first.end);
	let cluster: Block[] = [];
	let clusterEnd = -Infinity;
	const close = () => {
		const lanes = Math.max(0, ...cluster.map((block) => block.lane)) + 1;
		for (const block of cluster) block.lanes = lanes;
		cluster = [];
	};
	for (const block of blocks) {
		if (cluster.length > 0 && block.start >= clusterEnd) {
			close();
			clusterEnd = -Infinity;
		}
		const taken = new Set(cluster.filter((other) => other.end > block.start).map((other) => other.lane));
		while (taken.has(block.lane)) block.lane++;
		cluster.push(block);
		clusterEnd = Math.max(clusterEnd, block.end);
	}
	close();
}

function iconButton(name: string, label: string, onClick: (event: MouseEvent) => void, className = "calendar-step"): HTMLButtonElement {
	const button = el("button", { class: className, type: "button", title: label, onClick }, icon(name, 18));
	button.setAttribute("aria-label", label);
	return button;
}

export async function calendarView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const me = getUsername() ?? "";
	const state: ViewState = remembered.get(uuid) ?? { mode: window.innerWidth < NARROW_PX ? "day" : "week", anchor: todayKey(), selected: new Set([me]) };
	remembered.set(uuid, state);

	let feed!: CalendarFeed;
	let today: CalendarEntry[] = [];
	let loadRound = 0;
	let keptScroll: number | null = null;
	let closePopover: () => void = () => {};
	let reloadTimer: ReturnType<typeof setTimeout> | null = null;

	const title = el("h2", { class: "calendar-title" });
	const subtitle = el("span", { class: "calendar-subtitle" });
	const main = el("div", { class: "calendar-main" });
	const side = el("aside", { class: "calendar-side" });
	const modeButtons = new Map<Mode, HTMLButtonElement>();

	function range(): { from: string; to: string } {
		if (state.mode === "day") return { from: state.anchor, to: state.anchor };
		const first = weekStart(state.mode === "month" ? `${state.anchor.slice(0, 8)}01` : state.anchor);
		return { from: first, to: shiftDate(first, state.mode === "month" ? 41 : 6) };
	}

	async function load() {
		const round = ++loadRound;
		const { from, to } = range();
		const key = todayKey();
		const shown = Api.calendar(uuid, from, to);
		const current = key >= from && key <= to ? shown : Api.calendar(uuid, key, key);
		const [visible, now] = await Promise.all([shown, current]);
		if (round !== loadRound) return;
		feed = visible;
		today = now.entries;
		const known = new Set(feed.people.map((person) => person.account));
		for (const account of [...state.selected]) if (!known.has(account)) state.selected.delete(account);
		if (state.selected.size === 0) state.selected.add(known.has(me) ? me : (feed.people[0]?.account ?? me));
		render();
	}

	function reloadSoon() {
		if (reloadTimer !== null) return;
		reloadTimer = setTimeout(() => {
			reloadTimer = null;
			void load().catch(() => void 0);
		}, RELOAD_DELAY_MS);
	}

	const context: CalendarContext = { uuid, project, feed: () => feed, reload: load };

	function show(next: Partial<Pick<ViewState, "mode" | "anchor">>) {
		Object.assign(state, next);
		keptScroll = null;
		void load().catch(reportError);
	}

	function step(direction: number) {
		if (state.mode === "month") {
			const [year, month] = state.anchor.split("-").map(Number);
			show({ anchor: dateKey(new Date(year, month - 1 + direction, 1)) });
		} else show({ anchor: shiftDate(state.anchor, direction * (state.mode === "day" ? 1 : 7)) });
	}

	function personOf(account: string): CalendarPerson | undefined {
		return feed.people.find((person) => person.account === account);
	}

	function colorOf(entry: CalendarEntry, among: string[]): string {
		if (entry.accounts.includes(me) && among.includes(me)) return personColor(feed, me);
		return personColor(feed, among.find((account) => entry.accounts.includes(account)) ?? entry.accounts[0] ?? me);
	}

	function entryClasses(entry: CalendarEntry): string {
		const past = entry.all_day ? entry.ends_on! < todayKey() : entry.ends_at! < Date.now();
		return [
			`is-${entry.kind}`,
			entry.title === null && (entry.kind === "meeting" || entry.kind === "event") ? "is-hidden" : "",
			entry.live ? "is-live" : "",
			entry.pending ? "is-pending" : "",
			past ? "is-past" : "",
		]
			.filter(Boolean)
			.join(" ");
	}

	function entryMarks(entry: CalendarEntry): HTMLElement | null {
		const marks = [
			entry.live ? el("span", { class: "calendar-live-dot", title: t("calendar.live") }) : null,
			entry.kind === "meeting" ? icon("video", 13) : null,
			entry.repeat ? icon("repeat", 13) : null,
			entry.mine && entry.visibility !== null && entry.visibility !== "details" ? icon("lock", 13) : null,
		].filter((mark): mark is HTMLElement => mark !== null);
		return marks.length > 0 ? el("span", { class: "calendar-marks" }, ...marks) : null;
	}

	function detailRow(name: string, ...content: (HTMLElement | string | null)[]): HTMLElement {
		return el("div", { class: "calendar-detail" }, icon(name, 16), el("div", {}, ...content));
	}

	function showDetails(entry: CalendarEntry, anchor: HTMLElement) {
		closePopover();
		const names = entry.accounts.map((account) => personOf(account)).filter((person): person is CalendarPerson => person !== undefined);
		const heading = el("strong", { class: "calendar-popover-title" }, entryTitle(entry));
		const dot = el("span", { class: "calendar-popover-dot" });
		paint(dot, entry.kind === "holiday" ? "var(--danger)" : colorOf(entry, [...state.selected, ...entry.accounts]));

		const call =
			entry.kind === "meeting" && entry.conversation
				? el(
						"button",
						{
							class: `button small ${entry.live ? "primary" : "ghost"}`,
							type: "button",
							onClick: () => {
								closePopover();
								void joinGroupCall(uuid, entry.conversation!, entry.title ?? "", inCall);
							},
						},
						icon("video", 15),
						t(entry.live ? "calendar.join_call" : "calendar.start_call")
					)
				: null;
		const chat =
			entry.kind === "meeting" && entry.conversation
				? el("a", { class: "button small ghost", href: `/projects/${uuid}/chat/${entry.conversation}`, onClick: () => closePopover() }, t("calendar.open_chat"))
				: null;
		const absences =
			entry.kind === "absence" && entry.mine
				? el("a", { class: "button small ghost", href: `/projects/${uuid}/timesheet/absences`, onClick: () => closePopover() }, t("calendar.open_absences"))
				: null;
		const edit = entry.editable
			? iconButton(
					"edit",
					t("ui.edit"),
					() => {
						closePopover();
						openEditor(context, { entry });
					},
					"calendar-popover-action"
				)
			: null;
		const remove = entry.editable
			? iconButton(
					"trash",
					t(entry.kind === "meeting" ? "calendar.cancel_meeting" : "ui.delete"),
					() => {
						closePopover();
						void removeEntry(context, entry);
					},
					"calendar-popover-action"
				)
			: null;
		const close = iconButton("close", t("ui.close"), () => closePopover(), "calendar-popover-action");

		const card = el(
			"div",
			{ class: "calendar-popover" },
			el("div", { class: "calendar-popover-head" }, dot, heading, el("div", { class: "calendar-popover-actions" }, edit, remove, close)),
			entry.live ? el("span", { class: "pill pill-paid calendar-live-pill" }, t("calendar.live")) : null,
			entry.pending ? el("span", { class: "pill pill-pending" }, t("absence.status_pending")) : null,
			detailRow("clock", entryWhen(project, entry)),
			entry.repeat ? detailRow("repeat", describeRepeat(project, entry.repeat, seriesStartsOn(entry))) : null,
			entry.kind === "holiday" ? detailRow("calendar", t(entry.work_free ? "calendar.work_free" : "calendar.holiday")) : null,
			names.length > 0
				? detailRow("users", names.map((person) => (person.account === me ? `${person.name} (${t("chat.you")})` : person.name)).join(", "))
				: null,
			entry.title === null && entry.kind !== "absence" && entry.kind !== "holiday" ? detailRow("lock", t("calendar.details_hidden")) : null,
			entry.mine && entry.visibility ? detailRow("eye", t(`calendar.visibility_${entry.visibility}` as UiKey)) : null,
			entry.guests ? detailRow("external", t("calendar.guests_allowed")) : null,
			entry.note ? detailRow("note", el("span", { class: "calendar-note" }, entry.note)) : null,
			call || chat || absences ? el("div", { class: "calendar-popover-foot" }, call, chat, absences) : null
		);
		card.setAttribute("role", "dialog");
		card.setAttribute("aria-label", entryTitle(entry));
		document.body.appendChild(card);

		const rect = anchor.getBoundingClientRect();
		const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
		let left = rect.right + 10;
		if (left + width > window.innerWidth - 8) left = rect.left - width - 10;
		if (left < 8) left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
		const top = Math.max(8, Math.min(rect.top, window.innerHeight - card.offsetHeight - 8));
		card.style.width = `${width}px`;
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;

		const onDown = (event: MouseEvent) => {
			if (!card.contains(event.target as Node)) closePopover();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") closePopover();
		};
		closePopover = () => {
			card.remove();
			document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("keydown", onKey);
			closePopover = () => {};
			if (anchor.isConnected) anchor.focus();
		};
		setTimeout(() => document.addEventListener("mousedown", onDown, true), 0);
		document.addEventListener("keydown", onKey);
		card.tabIndex = -1;
		card.focus();
	}

	function chip(entry: CalendarEntry, among: string[], withTime: boolean): HTMLButtonElement {
		const node = el(
			"button",
			{ class: `calendar-chip ${entry.all_day ? "is-all-day" : "is-timed"} ${entryClasses(entry)}`, type: "button" },
			!entry.all_day && withTime ? el("span", { class: "calendar-chip-time" }, clock(project, entry.starts_at!)) : null,
			el("span", { class: "calendar-chip-title" }, entryTitle(entry)),
			entry.all_day || !withTime ? entryMarks(entry) : null
		);
		paint(node, entry.kind === "holiday" ? "var(--danger)" : colorOf(entry, among));
		node.addEventListener("click", (event) => {
			event.stopPropagation();
			showDetails(entry, node);
		});
		return node;
	}

	function dayNotes(date: string): { weekend: boolean; holiday: CalendarEntry | undefined } {
		const weekday = new Date(dayStart(date)).getDay();
		return {
			weekend: weekday === 0 || weekday === 6,
			holiday: feed.entries.find((entry) => entry.kind === "holiday" && entry.work_free && entry.starts_on === date),
		};
	}

	function dayClasses(date: string): string {
		const notes = dayNotes(date);
		return [date === todayKey() ? "is-today" : "", notes.weekend ? "is-weekend" : "", notes.holiday ? "is-holiday" : ""].filter(Boolean).join(" ");
	}

	function timeBlock(block: Block, column: Column): HTMLElement {
		const { entry } = block;
		const minutes = Math.max(block.end - block.start, SHORTEST_BLOCK_MINUTES);
		const node = el(
			"button",
			{ class: `calendar-block ${entryClasses(entry)}${minutes < 45 ? " is-short" : minutes >= 90 ? " is-tall" : ""}`, type: "button" },
			el("span", { class: "calendar-block-title" }, entryTitle(entry)),
			el(
				"span",
				{ class: "calendar-block-time" },
				minutes < 45 ? clock(project, entry.starts_at!) : `${clock(project, entry.starts_at!)} - ${clock(project, entry.ends_at!)}`,
				entryMarks(entry)
			)
		);
		paint(node, colorOf(entry, column.accounts));
		node.style.top = `${(block.start / 60) * HOUR_PX}px`;
		node.style.height = `${(minutes / 60) * HOUR_PX - 2}px`;
		node.style.left = `calc(${(block.lane / block.lanes) * 100}% + 2px)`;
		node.style.width = `calc(${100 / block.lanes}% - 6px)`;
		node.addEventListener("click", (event) => {
			event.stopPropagation();
			showDetails(entry, node);
		});
		return node;
	}

	function timeColumn(column: Column): HTMLElement {
		const start = dayStart(column.date);
		const end = dayStart(shiftDate(column.date, 1));
		const blocks: Block[] = feed.entries
			.filter((entry) => !entry.all_day && involves(entry, column.accounts) && entry.starts_at! < end && entry.ends_at! > start)
			.map((entry) => ({
				entry,
				start: Math.max(0, Math.round((entry.starts_at! - start) / MINUTE_MS)),
				end: Math.min(DAY_MINUTES, Math.round((entry.ends_at! - start) / MINUTE_MS)),
				lane: 0,
				lanes: 1,
			}));
		arrange(blocks);

		const node = el("div", { class: `calendar-column ${dayClasses(column.date)}` }, ...blocks.map((block) => timeBlock(block, column)));
		if (column.date === todayKey()) {
			const line = el("div", { class: "calendar-now" });
			line.style.top = `${((Date.now() - start) / MINUTE_MS / 60) * HOUR_PX}px`;
			node.appendChild(line);
		}
		node.addEventListener("click", (event) => {
			if (event.target !== node) return;
			const minutes = Math.floor(((event.offsetY / HOUR_PX) * 60) / SLOT_MINUTES) * SLOT_MINUTES;
			openEditor(context, {
				date: column.date,
				minutes: Math.min(minutes, DAY_MINUTES - SLOT_MINUTES),
				accounts: column.person ? [column.person.account] : [],
			});
		});
		return node;
	}

	function allDayRow(columns: Column[]): HTMLElement {
		const rows: number[][] = [];
		const bars: HTMLElement[] = [];
		const wholeDay = feed.entries
			.filter((entry) => entry.all_day)
			.sort((first, second) => first.starts_on!.localeCompare(second.starts_on!) || second.ends_on!.localeCompare(first.ends_on!));
		for (const entry of wholeDay) {
			const covered = columns
				.map((column, index) => (coversDate(entry, column.date) && involves(entry, column.accounts) ? index : -1))
				.filter((index) => index >= 0);
			if (covered.length === 0) continue;
			const first = covered[0];
			const last = covered[covered.length - 1];
			let row = rows.findIndex((taken) => taken.every((index) => index < first || index > last));
			if (row === -1) row = rows.push([]) - 1;
			for (let index = first; index <= last; index++) rows[row].push(index);
			const bar = chip(entry, columns[first].accounts, false);
			bar.style.gridColumn = `${first + 2} / ${last + 3}`;
			bar.style.gridRow = String(row + 1);
			bars.push(bar);
		}
		const row = el("div", { class: "calendar-allday" }, el("span", { class: "calendar-allday-label" }, t("calendar.all_day")), ...bars);
		row.style.setProperty("--columns", String(columns.length));
		return row;
	}

	function renderGrid() {
		const { from } = range();
		const chosen = [...state.selected].map((account) => personOf(account)).filter((person): person is CalendarPerson => person !== undefined);
		const perPerson = state.mode === "day" && chosen.length > 1;
		const columns: Column[] = perPerson
			? chosen.map((person) => ({ date: state.anchor, accounts: [person.account], person }))
			: Array.from({ length: state.mode === "day" ? 1 : 7 }, (_, index) => ({ date: shiftDate(from, index), accounts: [...state.selected], person: null }));

		const head = el(
			"div",
			{ class: "calendar-grid-head" },
			el("span", {}),
			...columns.map((column) =>
				column.person
					? el("div", { class: "calendar-day-head is-person" }, avatar(feed, column.person, "small"), el("span", {}, column.person.name))
					: el(
							"button",
							{ class: `calendar-day-head ${dayClasses(column.date)}`, type: "button", onClick: () => show({ mode: "day", anchor: column.date }) },
							el("span", { class: "calendar-day-name" }, weekdayLabel(column.date)),
							el("span", { class: "calendar-day-number" }, String(Number(column.date.slice(8))))
						)
			)
		);
		const hours = el(
			"div",
			{ class: "calendar-hours" },
			...Array.from({ length: 23 }, (_, index) => {
				const label = el("span", {}, clock(project, dayStart(state.anchor) + (index + 1) * 60 * MINUTE_MS));
				label.style.top = `${(index + 1) * HOUR_PX}px`;
				return label;
			})
		);
		const times = el("div", { class: "calendar-times" }, hours, ...columns.map(timeColumn));
		times.style.height = `${24 * HOUR_PX}px`;
		const scroll = el("div", { class: "calendar-scroll" }, el("div", { class: "calendar-grid-top" }, head, allDayRow(columns)), times);
		scroll.addEventListener("scroll", () => (keptScroll = scroll.scrollTop));

		const grid = el("div", { class: "calendar-grid card" }, scroll);
		grid.style.setProperty("--columns", String(columns.length));
		grid.style.setProperty("--hour", `${HOUR_PX}px`);
		main.replaceChildren(grid);
		scroll.scrollTop = keptScroll ?? FIRST_SHOWN_HOUR * HOUR_PX - HOUR_PX / 4;
	}

	function renderMonth() {
		const { from } = range();
		const month = state.anchor.slice(0, 7);
		const accounts = [...state.selected];
		const head = el("div", { class: "calendar-month-head" }, ...Array.from({ length: 7 }, (_, index) => el("span", {}, weekdayLabel(shiftDate(from, index)))));
		const cells = Array.from({ length: 42 }, (_, index) => {
			const date = shiftDate(from, index);
			const entries = feed.entries
				.filter((entry) => coversDate(entry, date) && involves(entry, accounts))
				.sort((first, second) => Number(second.all_day) - Number(first.all_day) || (first.starts_at ?? 0) - (second.starts_at ?? 0));
			const hidden = entries.length - MONTH_CHIPS;
			const cell = el(
				"div",
				{ class: `calendar-cell ${dayClasses(date)}${date.startsWith(month) ? "" : " is-outside"}` },
				el(
					"button",
					{ class: "calendar-cell-day", type: "button", title: longDayLabel(date), onClick: () => show({ mode: "day", anchor: date }) },
					String(Number(date.slice(8)))
				),
				...entries.slice(0, hidden > 0 ? MONTH_CHIPS - 1 : MONTH_CHIPS).map((entry) => chip(entry, accounts, true)),
				hidden > 0
					? el(
							"button",
							{ class: "calendar-more", type: "button", onClick: () => show({ mode: "day", anchor: date }) },
							t("calendar.more", { count: hidden + 1 })
						)
					: null
			);
			cell.addEventListener("click", (event) => {
				if (event.target === cell) openEditor(context, { date, minutes: 9 * 60 });
			});
			return cell;
		});
		main.replaceChildren(el("div", { class: "calendar-month card" }, head, el("div", { class: "calendar-month-grid" }, ...cells)));
	}

	function teamCell(person: CalendarPerson, date: string): HTMLElement {
		const start = dayStart(date) + TEAM_FROM_HOUR * 60 * MINUTE_MS;
		const end = dayStart(date) + TEAM_TO_HOUR * 60 * MINUTE_MS;
		const own = feed.entries.filter((entry) => entry.accounts.includes(person.account) && coversDate(entry, date));
		const away = own.find((entry) => entry.all_day && entry.kind === "absence" && !entry.pending);
		const wholeDay = own.filter((entry) => entry.all_day && entry !== away);
		const bars = own
			.filter((entry) => !entry.all_day && entry.starts_at! < end && entry.ends_at! > start)
			.map((entry) => {
				const bar = el("button", {
					class: `calendar-team-bar ${entryClasses(entry)}`,
					type: "button",
					title: `${entryTitle(entry)} | ${entryWhen(project, entry)}`,
				});
				const left = (Math.max(entry.starts_at!, start) - start) / (end - start);
				const right = (Math.min(entry.ends_at!, end) - start) / (end - start);
				bar.style.left = `${left * 100}%`;
				bar.style.width = `${Math.max((right - left) * 100, 2)}%`;
				paint(bar, personColor(feed, person.account));
				bar.setAttribute("aria-label", entryTitle(entry));
				bar.addEventListener("click", (event) => {
					event.stopPropagation();
					showDetails(entry, bar);
				});
				return bar;
			});
		const cell = el(
			"div",
			{ class: `calendar-team-cell ${dayClasses(date)}${away ? " is-absent" : ""}` },
			away
				? el(
						"button",
						{ class: "calendar-team-absent", type: "button", onClick: (event) => showDetails(away, event.currentTarget as HTMLElement) },
						entryTitle(away)
					)
				: el("div", { class: "calendar-team-track" }, ...bars),
			wholeDay.length > 0 && !away
				? el("div", { class: "calendar-team-notes" }, ...wholeDay.slice(0, 1).map((entry) => chip(entry, [person.account], false)))
				: null
		);
		cell.addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("button")) return;
			openEditor(context, { date, minutes: 9 * 60, kind: person.account === me ? "event" : "meeting", accounts: [person.account] });
		});
		return cell;
	}

	function renderTeam() {
		const { from, to } = range();
		const dates = Array.from({ length: 7 }, (_, index) => shiftDate(from, index));
		const weekFrom = dayStart(from);
		const weekTo = dayStart(shiftDate(to, 1));
		const now = Date.now();
		const ordered = [...feed.people].sort((first, second) => Number(second.account === me) - Number(first.account === me));

		const head = el(
			"div",
			{ class: "calendar-team-row is-head" },
			el("span", { class: "calendar-team-scale" }, t("calendar.team_scale", { from: `${TEAM_FROM_HOUR}:00`, to: `${TEAM_TO_HOUR}:00` })),
			...dates.map((date) =>
				el(
					"button",
					{ class: `calendar-day-head ${dayClasses(date)}`, type: "button", onClick: () => show({ mode: "day", anchor: date }) },
					el("span", { class: "calendar-day-name" }, weekdayLabel(date)),
					el("span", { class: "calendar-day-number" }, String(Number(date.slice(8))))
				)
			)
		);
		const rows = ordered.map((person) => {
			const booked = bookedMinutes(feed.entries, person.account, weekFrom, weekTo);
			const status = statusOf(project, person, today, now);
			const load = el("span", { class: "calendar-load-fill" });
			load.style.width = `${Math.min(booked / FULL_WEEK_MINUTES, 1) * 100}%`;
			return el(
				"div",
				{ class: "calendar-team-row" },
				el(
					"div",
					{ class: "calendar-team-person" },
					el("span", { class: "calendar-avatar-wrap" }, avatar(feed, person), presenceDot(person)),
					el(
						"div",
						{ class: "calendar-team-text" },
						el("strong", {}, person.account === me ? `${person.name} (${t("chat.you")})` : person.name),
						el("span", { class: `calendar-status is-${status.tone}` }, status.text),
						el(
							"span",
							{ class: "calendar-load", title: t("calendar.booked_hint") },
							el("span", { class: "calendar-load-bar" }, load),
							t("calendar.booked", { length: formatLength(booked) })
						)
					)
				),
				...dates.map((date) => teamCell(person, date))
			);
		});
		main.replaceChildren(el("div", { class: "calendar-team card" }, el("div", { class: "calendar-team-inner" }, head, ...rows)));
	}

	function renderSide() {
		side.hidden = state.mode === "team";
		if (side.hidden) return;
		const now = Date.now();
		const ordered = [...feed.people].sort((first, second) => Number(second.account === me) - Number(first.account === me));
		const rows = ordered.map((person) => {
			const status = statusOf(project, person, today, now);
			const chosen = state.selected.has(person.account);
			const row = el(
				"button",
				{ class: "calendar-person", type: "button" },
				el("span", { class: "calendar-avatar-wrap" }, avatar(feed, person), presenceDot(person)),
				el(
					"span",
					{ class: "calendar-person-text" },
					el("strong", {}, person.account === me ? `${person.name} (${t("chat.you")})` : person.name),
					el("span", { class: `calendar-status is-${status.tone}` }, status.text)
				),
				el("span", { class: "calendar-swatch" }, icon("check", 12))
			);
			paint(row, personColor(feed, person.account));
			row.setAttribute("aria-pressed", String(chosen));
			row.addEventListener("click", () => {
				if (state.selected.has(person.account)) {
					if (state.selected.size === 1) return;
					state.selected.delete(person.account);
				} else state.selected.add(person.account);
				render();
			});
			return row;
		});

		const key = todayKey();
		const agenda = today
			.filter((entry) => (entry.kind === "holiday" || entry.accounts.includes(me)) && coversDate(entry, key))
			.sort((first, second) => Number(second.all_day) - Number(first.all_day) || (first.starts_at ?? 0) - (second.starts_at ?? 0))
			.map((entry) => {
				const row = el(
					"button",
					{ class: `calendar-agenda-item ${entryClasses(entry)}`, type: "button" },
					el("span", { class: "calendar-agenda-time" }, entry.all_day ? t("calendar.all_day") : clock(project, entry.starts_at!)),
					el("span", { class: "calendar-agenda-title" }, entryTitle(entry)),
					entryMarks(entry)
				);
				paint(row, entry.kind === "holiday" ? "var(--danger)" : personColor(feed, me));
				row.addEventListener("click", () => showDetails(entry, row));
				return row;
			});

		side.replaceChildren(
			el(
				"section",
				{ class: "card calendar-panel" },
				el("h3", {}, t("calendar.today_title")),
				el("p", { class: "muted calendar-panel-date" }, longDayLabel(key)),
				agenda.length > 0 ? el("div", { class: "calendar-agenda" }, ...agenda) : el("p", { class: "muted" }, t("calendar.nothing_today"))
			),
			el(
				"section",
				{ class: "card calendar-panel" },
				el("h3", {}, t("calendar.people")),
				el("p", { class: "muted calendar-panel-date" }, t("calendar.people_hint")),
				el("div", { class: "calendar-people" }, ...rows)
			)
		);
	}

	function render() {
		closePopover();
		const { from, to } = range();
		for (const [mode, button] of modeButtons) button.classList.toggle("active", mode === state.mode);
		if (state.mode === "day") {
			title.textContent = longDayLabel(state.anchor);
			subtitle.textContent = t("calendar.week_number", { number: isoWeek(state.anchor) });
		} else if (state.mode === "month") {
			title.textContent = monthLabel(state.anchor);
			subtitle.textContent = "";
		} else {
			title.textContent = from.slice(0, 7) === to.slice(0, 7) ? monthLabel(from) : `${formatDay(from, project)} - ${formatDay(to, project)}`;
			subtitle.textContent = t("calendar.week_number", { number: isoWeek(from) });
		}
		if (state.mode === "month") renderMonth();
		else if (state.mode === "team") renderTeam();
		else renderGrid();
		renderSide();
	}

	const modes = el(
		"div",
		{ class: "subtabs" },
		...MODES.map((mode) => {
			const button = el("button", { class: "subtab", type: "button", onClick: () => show({ mode }) }, t(`calendar.mode_${mode}` as UiKey));
			modeButtons.set(mode, button);
			return button;
		})
	);
	const toolbar = el(
		"div",
		{ class: "calendar-toolbar" },
		el(
			"div",
			{ class: "calendar-nav" },
			el("button", { class: "button ghost", type: "button", onClick: () => show({ anchor: todayKey() }) }, t("calendar.today")),
			iconButton("left", t("calendar.previous"), () => step(-1)),
			iconButton("right", t("calendar.next"), () => step(1)),
			el("div", { class: "calendar-heading" }, title, subtitle)
		),
		el(
			"div",
			{ class: "calendar-tools" },
			modes,
			el("button", { class: "button primary", type: "button", onClick: () => openEditor(context, { date: state.anchor }) }, icon("plus", 16), t("calendar.new"))
		)
	);

	function onEvent(event: RealtimeEvent) {
		if (event.type === "realtime.ready") return reloadSoon();
		if (event.type === "chat.presence") {
			const person = feed.people.find((candidate) => candidate.account === event.account);
			if (!person) return;
			person.presence = event.presence as ChatPresence;
			return reloadSoon();
		}
		if (event.project !== uuid) return;
		if (event.type === "calendar.changed" || event.type === "call.group") reloadSoon();
	}

	const stopListening = onRealtime(onEvent);
	const ticker = setInterval(() => {
		if (document.visibilityState === "visible" && document.querySelector(".overlay") === null) render();
	}, 60 * 1000);
	onLeave(() => {
		stopListening();
		clearInterval(ticker);
		if (reloadTimer !== null) clearTimeout(reloadTimer);
		loadRound++;
		closePopover();
	});

	await load();
	return projectLayout(project, el("div", { class: "calendar" }, toolbar, el("div", { class: "calendar-body" }, main, side)));
}
