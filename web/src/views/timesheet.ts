import {
	Api,
	type Absence,
	type AbsenceKind,
	type AbsenceStatus,
	type MonthReport,
	type Project,
	type Ticket,
	type TicketReference,
	type TimeEntry,
	type TimeEntryActivity,
	type TimeEntryKind,
	type TimesheetDayEntry,
	type WorkforceConfig,
	type WorkforceHoliday,
	type WorkforceState,
} from "../api";
import { el, emptyState, field, input, saveFile, select, table } from "../dom";
import { formatDateTime, toMajorUnits, toMinorUnits } from "../money";
import { can, Permission } from "../access";
import { t, tn, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import {
	ABSENCE_KINDS,
	absenceLabel,
	absencePill,
	defaultPerson,
	formatDay,
	formatHours,
	holidayName,
	hoursInput,
	minutesFrom,
	personPicker,
	shiftDate,
	timesheetSection,
	weekdayName,
	weekStart,
} from "./workforce-shared";
import type { DateFormat, TimeFormat } from "../../../server/formats";
import { icon } from "../storefront/icons";

function dailyMinutesOf(state: WorkforceState, member: string): number {
	if (member === state.me.member) return state.me.daily_minutes;
	return state.people.find((person) => person.member === member)?.daily_minutes ?? state.config.daily_minutes;
}

function paidBreakOf(state: WorkforceState, member: string): number {
	if (member === state.me.member) return state.me.paid_break_minutes;
	return state.people.find((person) => person.member === member)?.paid_break_minutes ?? state.config.paid_break_minutes;
}

function editableDay(state: WorkforceState, member: string, date: string): boolean {
	if (!state.license.active) return false;
	if (state.me.edit) return true;
	return state.me.own && member === state.me.member && date <= state.today && date >= shiftDate(state.today, -state.me.edit_days);
}

function ticketLabel(ticket: Pick<Ticket, "number" | "title">): string {
	return `#${ticket.number} ${ticket.title}`;
}

function rememberedRemote(uuid: string, member: string): boolean | null {
	try {
		const value = localStorage.getItem(`rabbitpay.timesheet.remote:${uuid}:${member}`);
		return value === null ? null : value === "true";
	} catch {
		return null;
	}
}

function rememberRemote(uuid: string, member: string, remote: boolean) {
	try {
		localStorage.setItem(`rabbitpay.timesheet.remote:${uuid}:${member}`, String(remote));
	} catch {
		void 0;
	}
}

async function holidaysBetween(uuid: string, from: string, to: string): Promise<Map<string, WorkforceHoliday>> {
	const years = [...new Set([from.slice(0, 4), to.slice(0, 4)])].map(Number);
	const lists = await Promise.all(years.map((year) => Api.workforceHolidays(uuid, year)));
	const days = new Map<string, WorkforceHoliday>();
	for (const list of lists) {
		for (const holiday of list.holidays) {
			if (holiday.date < from || holiday.date > to) continue;
			if (!days.get(holiday.date)?.work_free) days.set(holiday.date, holiday);
		}
	}
	return days;
}

function clockMinutes(value: string): number | null {
	const match = value.match(/^(\d{2}):(\d{2})$/);
	return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function clockAfter(value: string, minutes: number): string {
	const total = ((clockMinutes(value) ?? 0) + minutes) % 1440;
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function spanOf(start: string, end: string): { start: number; minutes: number } | null {
	const from = clockMinutes(start);
	const to = clockMinutes(end);
	if (from === null || to === null) return null;
	return { start: from, minutes: to <= from ? to + 1440 - from : to - from };
}

const ENTRY_KINDS: TimeEntryKind[] = ["regular", "overtime", "break"];
const ENTRY_ACTIVITIES: TimeEntryActivity[] = ["ticket", "internal", "administration", "training", "available", "waiting_home"];

function kindLabel(kind: TimeEntryKind): string {
	return t(`timesheet.kind_${kind}` as UiKey);
}

function activityLabel(activity: TimeEntryActivity): string {
	return t(`timesheet.activity_${activity}` as UiKey);
}

function entrySummary(entry: TimeEntry): string {
	return [
		`${entry.start}-${entry.end}${entry.overnight ? ` (${t("timesheet.next_day")})` : ""}`,
		entry.kind === "regular" ? null : kindLabel(entry.kind),
		entry.activity ? activityLabel(entry.activity) : null,
		entry.break_minutes ? t("timesheet.break_short", { minutes: entry.break_minutes }) : null,
		entry.remote ? t("timesheet.remote_short") : null,
	]
		.filter(Boolean)
		.join(" | ");
}

interface DayRow {
	node: HTMLTableRowElement;
	payload: () => TimesheetDayEntry;
	span: () => { start: number; minutes: number } | null;
	kind: () => TimeEntryKind;
	showWorked: (minutes: number | null) => void;
	legacyBreak: number;
}

function dayEditor(options: {
	uuid: string;
	project: Project;
	state: WorkforceState;
	member: string;
	date: string;
	entries: TimeEntry[];
	tickets: Map<string, TicketReference>;
	activeTickets: TicketReference[];
	notices: HTMLElement[];
	onSaved: () => void;
}) {
	const { uuid, state, member, date } = options;
	const paidBreak = paidBreakOf(state, member);
	const foreign = member !== state.me.member;
	const locked = options.entries.filter((entry) => entry.invoice !== null);
	const showTickets = options.activeTickets.length > 0 || options.entries.some((entry) => entry.ticket !== null);
	const ticketChoices = [...new Map([...options.activeTickets, ...options.tickets.values()].map((ticket) => [ticket.uuid, ticket])).values()];
	const rows: DayRow[] = [];
	let preferredRemote = rememberedRemote(uuid, member);
	const tbody = el("tbody", {});
	const total = el("strong", { class: "mono" });
	const reason = input("text", { maxlength: "500", placeholder: t("timesheet.reason_placeholder") });
	const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
	const columns = [
		t("timesheet.start"),
		t("timesheet.end"),
		t("timesheet.kind"),
		t("timesheet.remote_column"),
		showTickets ? t("timesheet.ticket") : null,
		t("timesheet.activity"),
		t("timesheet.note"),
		t("timesheet.worked"),
		"",
	].filter((column): column is string => column !== null);
	const emptyCell = el("td", { class: "muted" }, t("timesheet.day_empty"));
	emptyCell.colSpan = columns.length;
	const emptyRow = el("tr", {}, emptyCell);
	const reorderRows = () => {
		const startOf = (node: HTMLTableRowElement) => rows.find((row) => row.node === node)?.span()?.start ?? Number(node.dataset.start ?? 0);
		const nodes = [...tbody.children].filter((node): node is HTMLTableRowElement => node instanceof HTMLTableRowElement && node !== emptyRow);
		for (const node of nodes.sort((first, second) => startOf(first) - startOf(second))) tbody.append(node);
	};

	const refresh = () => {
		let paidLeft = paidBreak - locked.filter((entry) => entry.kind === "break").reduce((sum, entry) => sum + entry.worked_minutes, 0);
		let sum = locked.reduce((minutes, entry) => minutes + entry.worked_minutes, 0);
		const ordered = [...rows].sort((first, second) => (first.span()?.start ?? 0) - (second.span()?.start ?? 0));
		for (const row of ordered) {
			const span = row.span();
			if (!span) {
				row.showWorked(null);
				continue;
			}
			let worked = span.minutes - Math.max(0, row.legacyBreak - paidBreak);
			if (row.kind() === "break") {
				worked = Math.max(0, Math.min(paidLeft, span.minutes));
				paidLeft -= worked;
			}
			row.showWorked(worked);
			sum += worked;
		}
		total.textContent = formatHours(sum);
		if (rows.length === 0 && locked.length === 0) tbody.append(emptyRow);
		else emptyRow.remove();
		reorderRows();
	};

	const lockedRow = (entry: TimeEntry): HTMLTableRowElement => {
		const ticket = entry.ticket ? options.tickets.get(entry.ticket) : null;
		const node = el(
			"tr",
			{ class: "muted-row" },
			el("td", { class: "mono" }, entry.start),
			el("td", { class: "mono" }, entry.end),
			el("td", {}, kindLabel(entry.kind)),
			el("td", { class: "center" }, entry.remote ? icon("check", 16) : ""),
			showTickets ? el("td", {}, ticket ? ticketLabel(ticket) : "") : null,
			el("td", {}, entry.activity ? activityLabel(entry.activity) : ""),
			el("td", {}, entry.note ?? ""),
			el("td", { class: "numeric mono" }, formatHours(entry.worked_minutes)),
			el("td", { class: "actions" }, el("span", { class: "pill pill-paid" }, t("timesheet.invoiced")))
		);
		node.dataset.start = String(clockMinutes(entry.start) ?? 0);
		return node;
	};

	const addRow = (entry: TimeEntry | null, defaults?: { start: string; end: string; kind: TimeEntryKind }) => {
		const legacyBreak = entry?.kind === "break" ? 0 : (entry?.break_minutes ?? 0);
		const start = input("time", { value: entry?.start ?? defaults?.start ?? "08:00", required: true });
		const end = input("time", { value: entry?.end ?? defaults?.end ?? "16:00", required: true });
		const kind = select(
			ENTRY_KINDS.map((value) => ({ value, label: kindLabel(value) })),
			entry?.kind ?? defaults?.kind ?? "regular"
		);
		const remote = input("checkbox", { title: t("timesheet.remote") });
		remote.checked = entry?.remote ?? preferredRemote ?? false;
		const activityChoices = ENTRY_ACTIVITIES.filter(
			(value) => (value !== "ticket" || ticketChoices.length > 0) && (value !== "waiting_home" || state.me.edit || entry?.activity === "waiting_home")
		);
		const activity = select(
			activityChoices.map((value) => ({ value, label: activityLabel(value) })),
			entry?.activity ?? (entry?.ticket ? "ticket" : "internal")
		);
		const ticket = select(
			[{ value: "", label: t("timesheet.no_ticket") }, ...ticketChoices.map((choice) => ({ value: choice.uuid, label: ticketLabel(choice) }))],
			entry?.ticket ?? ""
		);
		const note = input("text", { maxlength: "2000", value: entry?.note ?? "" });
		const worked = el("td", { class: "numeric mono" });
		const legacyHint = legacyBreak ? el("div", { class: "field-hint" }, t("timesheet.break_short", { minutes: legacyBreak })) : null;
		const node = el(
			"tr",
			{},
			el("td", {}, start),
			el("td", {}, end),
			el("td", {}, kind),
			el("td", { class: "center" }, remote),
			showTickets ? el("td", {}, ticket) : null,
			el("td", {}, activity),
			el("td", {}, note),
			worked,
			el(
				"td",
				{ class: "actions" },
				el(
					"button",
					{
						class: "icon-button",
						type: "button",
						title: t("timesheet.insert_after"),
						onClick: () => {
							const from = clockMinutes(end.value) ?? 0;
							const next = [
								...rows.filter((candidate) => candidate !== row).map((candidate) => candidate.span()?.start),
								...locked.map((candidate) => clockMinutes(candidate.start)),
							]
								.filter((minute): minute is number => minute !== null && minute !== undefined && minute > from)
								.sort((first, second) => first - second)[0];
							addRow(null, {
								start: end.value,
								end: next === undefined ? clockAfter(end.value, 60) : clockAfter("00:00", next),
								kind: "regular",
							}).focus();
						},
					},
					icon("plus", 16)
				),
				el(
					"button",
					{
						class: "icon-button danger-text",
						type: "button",
						title: t("timesheet.remove_row"),
						onClick: () => {
							rows.splice(rows.indexOf(row), 1);
							node.remove();
							refresh();
						},
					},
					icon("close", 16)
				)
			)
		);
		const applyActivity = () => {
			const pause = kind.value === "break";
			const ticketWork = !pause && activity.value === "ticket";
			const waiting = !pause && activity.value === "waiting_home";
			ticket.disabled = !ticketWork;
			ticket.required = ticketWork;
			remote.disabled = pause || waiting;
			if (!ticketWork) ticket.value = "";
			if (waiting) {
				kind.value = "regular";
				remote.checked = true;
			}
		};
		const applyKind = () => {
			const pause = kind.value === "break";
			node.classList.toggle("break-row", pause);
			activity.disabled = pause;
			if (pause) {
				remote.checked = false;
				ticket.value = "";
			}
			applyActivity();
		};

		const row: DayRow = {
			node,
			legacyBreak,
			span: () => spanOf(start.value, end.value),
			kind: () => kind.value as TimeEntryKind,
			showWorked: (minutes) => worked.replaceChildren(minutes === null ? "" : formatHours(minutes), legacyHint ?? ""),
			payload: () => ({
				uuid: entry?.uuid,
				start: start.value,
				end: end.value,
				kind: kind.value as TimeEntryKind,
				activity: kind.value === "break" ? null : (activity.value as TimeEntryActivity),
				remote: remote.checked,
				ticket: ticket.value || null,
				note: note.value.trim() || null,
			}),
		};
		for (const control of [start, end, kind]) control.addEventListener("input", refresh);
		kind.addEventListener("change", () => {
			applyKind();
			refresh();
		});
		activity.addEventListener("change", applyActivity);
		remote.addEventListener("change", () => {
			if (kind.value !== "break" && activity.value !== "waiting_home") preferredRemote = remote.checked;
		});
		ticket.addEventListener("change", () => {
			if (ticket.value) activity.value = "ticket";
			else if (activity.value === "ticket") activity.value = "internal";
			applyActivity();
		});
		applyKind();
		rows.push(row);
		tbody.append(node);
		refresh();
		return start;
	};

	for (const entry of options.entries) {
		if (entry.invoice === null) addRow(entry);
		else tbody.append(lockedRow(entry));
	}
	if (options.entries.length === 0) addRow(null);

	const append = (kind: TimeEntryKind, minutes: number) => {
		const latest = [
			...rows.map((row) => {
				const span = row.span();
				return span ? { end: row.payload().end, total: span.start + span.minutes } : null;
			}),
			...locked.map((entry) => {
				const span = spanOf(entry.start, entry.end);
				return span ? { end: entry.end, total: span.start + span.minutes } : null;
			}),
		]
			.filter((value): value is { end: string; total: number } => value !== null)
			.sort((first, second) => second.total - first.total)[0];
		const start = latest?.end ?? "08:00";
		addRow(null, { start, end: clockAfter(start, minutes), kind }).focus();
	};

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.saveTimesheetDay(uuid, {
						member,
						work_date: date,
						entries: [...rows].sort((first, second) => (first.span()?.start ?? 0) - (second.span()?.start ?? 0)).map((row) => row.payload()),
						reason: reason.value.trim() || null,
					});
					if (preferredRemote !== null) rememberRemote(uuid, member, preferredRemote);
					toast(t("timesheet.saved"), "success");
					dialog.close();
					options.onSaved();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		options.notices.length ? el("div", { class: "stack-tight" }, ...options.notices) : null,
		el(
			"div",
			{ class: "table-wrap" },
			el("table", { class: "day-table" }, el("thead", {}, el("tr", {}, ...columns.map((column) => el("th", {}, column)))), tbody)
		),
		el(
			"div",
			{ class: "day-footer" },
			el(
				"div",
				{ class: "toolbar" },
				el("button", { class: "button ghost small", type: "button", onClick: () => append("regular", 60) }, t("timesheet.add_row")),
				el("button", { class: "button ghost small", type: "button", onClick: () => append("break", paidBreak || 30) }, t("timesheet.add_break"))
			),
			el("div", { class: "totals-row" }, el("span", {}, t("timesheet.day_worked")), total)
		),
		el("p", { class: "muted" }, t("timesheet.activity_hint"), " ", t("timesheet.overnight_hint"), " ", t("timesheet.break_hint", { minutes: paidBreak })),
		state.me.edit && (foreign || options.entries.length > 0) ? field(t("timesheet.reason"), reason, t("timesheet.reason_hint")) : null,
		el("div", { class: "form-actions" }, el("button", { class: "button ghost", type: "button", onClick: () => dialog.close() }, t("ui.cancel")), submit)
	);
	const person = foreign ? state.people.find((candidate) => candidate.member === member)?.name : null;
	const title = [`${weekdayName(date)} ${formatDay(date, options.project)}`, person].filter(Boolean).join(" | ");
	const dialog = modal(title, form, undefined, "dialog-xlarge");
}

function monthEnd(date: string): string {
	const [year, month] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function fillDialog(uuid: string, state: WorkforceState, member: string, shown: string, onDone: () => void) {
	const daily = dailyMinutesOf(state, member);
	const pause = paidBreakOf(state, member);
	const monthStart = `${shown.slice(0, 7)}-01`;
	const lastDay = monthEnd(shown);
	const from = input("date", { required: true, value: monthStart });
	const to = input("date", { required: true, value: lastDay < state.today ? lastDay : state.today < monthStart ? lastDay : state.today });
	const start = input("time", { required: true, value: "08:00" });
	const breakStart = input("time", { value: pause ? clockAfter("08:00", Math.min(240, Math.floor(daily / 2))) : "" });
	const reason = input("text", { maxlength: "500", value: t("timesheet.fill_reason") });
	const preview = el("p", { class: "muted" });
	const submit = el("button", { class: "button primary", type: "submit" }, t("timesheet.fill_submit"));
	const person = member === state.me.member ? state.me.name : (state.people.find((candidate) => candidate.member === member)?.name ?? "");

	const refresh = () => {
		const begin = clockMinutes(start.value);
		const lunch = clockMinutes(breakStart.value);
		breakStart.setCustomValidity("");
		if (begin === null) return;
		const end = clockAfter(start.value, daily);
		if (!pause || lunch === null) {
			preview.textContent = t("timesheet.fill_preview_plain", { start: start.value, end, hours: formatHours(daily) });
			return;
		}
		if (lunch <= begin || lunch + pause >= begin + daily) breakStart.setCustomValidity(t("timesheet.fill_break_outside"));
		preview.textContent = t("timesheet.fill_preview", {
			start: start.value,
			lunch: breakStart.value,
			resume: clockAfter(breakStart.value, pause),
			end,
			hours: formatHours(daily),
		});
	};
	for (const control of [start, breakStart]) control.addEventListener("input", refresh);
	refresh();

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const result = await Api.fillTimesheet(uuid, {
						member,
						from: from.value,
						to: to.value,
						start: start.value,
						break_start: pause && breakStart.value ? breakStart.value : null,
						reason: reason.value.trim() || null,
					});
					toast(t("timesheet.fill_done", { days: tn("count.days", result.filled) }), "success");
					dialog.close();
					onDone();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		el("p", {}, t("timesheet.fill_body", { person })),
		el("div", { class: "form-grid" }, field(t("absence.from"), from), field(t("absence.to"), to)),
		el(
			"div",
			{ class: "form-grid" },
			field(t("timesheet.fill_start"), start),
			pause ? field(t("timesheet.fill_break"), breakStart, t("timesheet.fill_break_hint", { minutes: pause })) : null
		),
		preview,
		field(t("timesheet.reason"), reason, t("timesheet.reason_hint")),
		el("p", { class: "muted" }, t("timesheet.fill_rules")),
		el("div", { class: "form-actions" }, el("button", { class: "button ghost", type: "button", onClick: () => dialog.close() }, t("ui.cancel")), submit)
	);
	const dialog = modal(t("timesheet.fill_title"), form);
}

function revisionSummary(value: Record<string, unknown> | null): string {
	if (!value) return "";
	const parts: string[] = [];
	if (typeof value.work_date === "string") parts.push(value.work_date);
	if (typeof value.start === "string" && typeof value.end === "string") parts.push(`${value.start}-${value.end}`);
	if (typeof value.start_minute === "number" && typeof value.end_minute === "number")
		parts.push(`${formatHours(value.start_minute)}-${formatHours(value.end_minute % 1440)}`);
	if (typeof value.starts_on === "string" && typeof value.ends_on === "string") parts.push(`${value.starts_on} - ${value.ends_on}`);
	if (typeof value.kind === "string") parts.push(value.kind);
	if (typeof value.activity === "string" && ENTRY_ACTIVITIES.includes(value.activity as TimeEntryActivity)) {
		parts.push(activityLabel(value.activity as TimeEntryActivity));
	}
	if (typeof value.status === "string") parts.push(value.status);
	return parts.join(" | ");
}

async function historyDialog(uuid: string, member: string, project: Project) {
	try {
		const result = await Api.workforceRevisions(uuid, { member, limit: 100 });
		const content =
			result.revisions.length === 0
				? emptyState(t("timesheet.history_empty"))
				: table(
						[
							t("timesheet.history_when"),
							t("timesheet.history_change"),
							t("timesheet.history_before"),
							t("timesheet.history_after"),
							t("timesheet.history_by"),
						],
						result.revisions.map((revision) =>
							el(
								"tr",
								{},
								el("td", {}, formatDateTime(revision.created, project.date_format as DateFormat, project.time_format as TimeFormat, project.timezone)),
								el("td", {}, t(`timesheet.operation_${revision.operation}` as UiKey)),
								el("td", { class: "muted" }, revisionSummary(revision.old_value)),
								el("td", {}, revisionSummary(revision.new_value)),
								el("td", {}, revision.changed_by ?? "-", revision.reason ? el("div", { class: "muted" }, revision.reason) : null)
							)
						)
					);
		modal(
			t("timesheet.history_title"),
			el("div", { class: "stack" }, el("p", { class: "muted" }, t("timesheet.history_body")), content),
			undefined,
			"dialog-large"
		);
	} catch (error) {
		reportError(error);
	}
}

async function balanceCard(uuid: string, state: WorkforceState, member: string, year: number, onChange: () => void): Promise<HTMLElement> {
	const balance = await Api.vacationBalance(uuid, { member, year });
	const editor =
		state.me.edit && state.license.active
			? (() => {
					const entitled = input("number", { min: "0", max: "366", step: "0.5", value: String(balance.entitled_days) });
					const carried = input("number", { min: "0", max: "366", step: "0.5", value: String(balance.carried_days) });
					return el(
						"form",
						{
							class: "form-grid three",
							onSubmit: async (event) => {
								event.preventDefault();
								try {
									await Api.saveVacationBalance(uuid, { member, year, entitled_days: Number(entitled.value), carried_days: Number(carried.value || 0) });
									toast(t("timesheet.balance_saved"), "success");
									onChange();
								} catch (error) {
									reportError(error);
								}
							},
						},
						field(t("timesheet.balance_entitled"), entitled),
						field(t("timesheet.balance_carried"), carried),
						el("div", { class: "form-actions" }, el("button", { class: "button ghost", type: "submit" }, t("ui.save")))
					);
				})()
			: null;
	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("timesheet.balance_title", { year })),
		el(
			"dl",
			{ class: "facts" },
			el("dt", {}, t("timesheet.balance_remaining")),
			el("dd", {}, el("strong", {}, String(balance.remaining_days))),
			el("dt", {}, t("timesheet.balance_entitled")),
			el("dd", {}, String(balance.entitled_days)),
			el("dt", {}, t("timesheet.balance_carried")),
			el("dd", {}, String(balance.carried_days)),
			el("dt", {}, t("timesheet.balance_taken")),
			el("dd", {}, String(balance.taken_days)),
			el("dt", {}, t("timesheet.balance_planned")),
			el("dd", {}, String(Math.round((balance.approved_days - balance.taken_days) * 100) / 100)),
			el("dt", {}, t("timesheet.balance_pending")),
			el("dd", {}, String(balance.pending_days))
		),
		editor
	);
}

export async function timesheetView(uuid: string): Promise<HTMLElement> {
	return timesheetSection(uuid, async (project, state) => {
		let member = defaultPerson(state);
		let start = weekStart(state.today);
		const picker = state.me.view ? personPicker(state, member, false) : null;
		const range = el("strong", {});
		const body = el("div", { class: "stack" });
		const balanceSlot = el("div", {});
		const activeTickets = can(project, Permission.TICKET_VIEW)
			? (await Api.tickets(uuid, { status: "active", limit: 200 })).tickets.map(({ uuid, number, title, status }) => ({ uuid, number, title, status }))
			: [];

		const load = async (): Promise<void> => {
			const end = shiftDate(start, 6);
			range.textContent = `${formatDay(start, project)} - ${formatDay(end, project)}`;
			try {
				const [sheet, absences, holidays] = await Promise.all([
					Api.timesheet(uuid, { from: start, to: end, member }),
					Api.absences(uuid, { from: start, to: end, member }),
					holidaysBetween(uuid, start, end),
				]);
				const tickets = new Map([...activeTickets, ...sheet.tickets].map((ticket) => [ticket.uuid, ticket]));
				const daily = dailyMinutesOf(state, member);
				let worked = 0;
				let expected = 0;
				const rows = Array.from({ length: 7 }, (_, index) => {
					const date = shiftDate(start, index);
					const holiday = holidays.get(date);
					const weekend = index >= 5;
					const dayAbsences = absences.filter(
						(absence) => absence.starts_on <= date && absence.ends_on >= date && absence.status !== "canceled" && absence.status !== "rejected"
					);
					if (!weekend && !holiday?.work_free) expected += daily;
					const entries = sheet.entries.filter((entry) => entry.work_date === date);
					const minutes = entries.reduce((sum, entry) => sum + entry.worked_minutes, 0);
					worked += minutes;
					const notices = () =>
						[
							holiday ? el("div", { class: holiday.work_free ? "warn-text" : "muted" }, holidayName(holiday.name)) : null,
							...dayAbsences.map((absence) => el("div", {}, absenceLabel(absence.kind), " ", absencePill(absence.status))),
						].filter((notice): notice is HTMLDivElement => notice !== null);
					const openDay = () =>
						dayEditor({ uuid, project, state, member, date, entries, tickets, activeTickets, notices: notices(), onSaved: () => void load() });
					return el(
						"tr",
						{ class: weekend || holiday?.work_free ? "muted-row" : "" },
						el(
							"td",
							{},
							el("strong", {}, weekdayName(date)),
							el("div", { class: "muted" }, formatDay(date, project)),
							date === state.today ? el("span", { class: "pill pill-active" }, t("timesheet.today")) : null
						),
						el("td", {}, el("div", { class: "stack-tight" }, ...notices(), ...entries.map((entry) => entryLine(entry, tickets)))),
						el("td", { class: "numeric mono" }, minutes ? formatHours(minutes) : ""),
						el(
							"td",
							{ class: "actions" },
							editableDay(state, member, date)
								? el(
										"button",
										{ class: "button ghost small", type: "button", onClick: openDay },
										entries.length ? t("timesheet.edit_day") : t("timesheet.add_time")
									)
								: null
						)
					);
				});
				body.replaceChildren(
					table([t("timesheet.day"), t("timesheet.entries"), t("timesheet.worked"), ""], rows),
					el(
						"div",
						{ class: "totals" },
						el("div", { class: "totals-row" }, el("span", {}, t("timesheet.week_worked")), el("strong", { class: "mono" }, formatHours(worked))),
						el("div", { class: "totals-row" }, el("span", {}, t("timesheet.week_expected")), el("span", { class: "mono" }, formatHours(expected)))
					),
					el(
						"p",
						{ class: "muted" },
						state.me.edit
							? t("timesheet.edit_rule_supervisor")
							: member === state.me.member
								? t("timesheet.edit_rule", { days: tn("count.days", state.me.edit_days) })
								: ""
					)
				);
				balanceSlot.replaceChildren(await balanceCard(uuid, state, member, Number(start.slice(0, 4)), () => void load()));
			} catch (error) {
				reportError(error);
			}
		};

		const entryLine = (entry: TimeEntry, tickets: Map<string, TicketReference>): HTMLElement => {
			const ticket = entry.ticket ? tickets.get(entry.ticket) : null;
			return el(
				"div",
				{ class: "entry-line" },
				el("span", { class: "mono" }, entrySummary(entry)),
				ticket ? el("a", { class: "muted", href: `/projects/${uuid}/tickets/${ticket.uuid}` }, ticketLabel(ticket)) : null,
				entry.note ? el("span", { class: "muted" }, entry.note) : null,
				entry.invoice ? el("span", { class: "pill pill-paid" }, t("timesheet.invoiced")) : null
			);
		};

		picker?.addEventListener("change", () => {
			member = picker.value;
			void load();
		});
		const move = (days: number) => {
			start = shiftDate(start, days);
			void load();
		};
		await load();

		return el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "toolbar" },
				picker,
				el("button", { class: "button ghost small", type: "button", onClick: () => move(-7) }, icon("left", 16)),
				range,
				el("button", { class: "button ghost small", type: "button", onClick: () => move(7) }, icon("right", 16)),
				el(
					"button",
					{
						class: "button ghost small",
						type: "button",
						onClick: () => {
							start = weekStart(state.today);
							void load();
						},
					},
					t("timesheet.this_week")
				),
				el("button", { class: "button ghost small", type: "button", onClick: () => void historyDialog(uuid, member, project) }, t("timesheet.history")),
				state.me.edit && state.license.active
					? el(
							"button",
							{ class: "button ghost small", type: "button", onClick: () => fillDialog(uuid, state, member, start, () => void load()) },
							t("timesheet.fill")
						)
					: null
			),
			el("div", { class: "card" }, body),
			balanceSlot
		);
	});
}

function absenceDialog(uuid: string, state: WorkforceState, member: string, absence: Absence | null, onSaved: () => void) {
	const people = state.me.edit ? personPicker(state, absence?.member ?? member, false) : null;
	if (people && absence) people.disabled = true;
	const kind = select(
		ABSENCE_KINDS.map((value) => ({ value, label: absenceLabel(value) })),
		absence?.kind ?? "vacation"
	);
	const from = input("date", { required: true, value: absence?.starts_on ?? state.today });
	const to = input("date", { required: true, value: absence?.ends_on ?? state.today });
	const partial = hoursInput(absence?.minutes_per_day ?? null, { max: "24" });
	const note = el("textarea", { rows: "2", maxlength: "2000" });
	note.value = absence?.note ?? "";
	const submit = el("button", { class: "button primary", type: "submit" }, state.me.edit ? t("ui.save") : t("absence.request"));
	from.addEventListener("change", () => {
		if (to.value < from.value) to.value = from.value;
	});
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				const body = {
					kind: kind.value as AbsenceKind,
					starts_on: from.value,
					ends_on: to.value,
					minutes_per_day: minutesFrom(partial),
					note: note.value.trim() || null,
				};
				try {
					if (absence) await Api.updateAbsence(uuid, absence.uuid, body);
					else await Api.createAbsence(uuid, { ...body, member: people?.value ?? member });
					toast(state.me.edit ? t("absence.saved") : t("absence.requested"), "success");
					dialog.close();
					onSaved();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = false;
				}
			},
		},
		people ? field(t("workforce.person"), people) : null,
		field(t("absence.kind"), kind),
		el("div", { class: "form-grid" }, field(t("absence.from"), from), field(t("absence.to"), to)),
		field(t("absence.partial_hours"), partial, t("absence.partial_hint")),
		field(t("timesheet.note"), note),
		state.me.edit ? null : el("p", { class: "muted" }, t("absence.approval_hint")),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(absence ? t("absence.edit") : t("absence.new"), form);
}

function decisionDialog(uuid: string, absence: Absence, status: "approved" | "rejected", onSaved: () => void) {
	const note = input("text", { maxlength: "500" });
	const submit = el(
		"button",
		{ class: `button ${status === "approved" ? "primary" : "danger"}`, type: "submit" },
		t(`absence.${status === "approved" ? "approve" : "reject"}`)
	);
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				try {
					await Api.decideAbsence(uuid, absence.uuid, status, note.value.trim() || null);
					dialog.close();
					onSaved();
				} catch (error) {
					reportError(error);
				}
			},
		},
		el("p", {}, `${absence.person}: ${absenceLabel(absence.kind)}, ${absence.starts_on} - ${absence.ends_on}`),
		field(t("absence.decision_note"), note),
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(t(`absence.${status === "approved" ? "approve" : "reject"}_title`), form);
}

export async function absencesView(uuid: string): Promise<HTMLElement> {
	return timesheetSection(uuid, async (project, state) => {
		let member = state.me.view ? "all" : defaultPerson(state);
		const year = Number(state.today.slice(0, 4));
		const picker = state.me.view ? personPicker(state, member, true) : null;
		const years = select(
			[year + 1, year, year - 1, year - 2].map((value) => ({ value: String(value), label: String(value) })),
			String(year)
		);
		const status = select(
			[
				{ value: "", label: t("absence.status_any") },
				...(["pending", "approved", "rejected", "canceled"] as AbsenceStatus[]).map((value) => ({ value, label: t(`absence.status_${value}` as UiKey) })),
			],
			state.me.edit ? "pending" : ""
		);
		const body = el("div", {});
		const balanceSlot = el("div", {});

		const load = async (): Promise<void> => {
			const selectedYear = Number(years.value);
			try {
				const list = await Api.absences(uuid, {
					from: `${selectedYear}-01-01`,
					to: `${selectedYear}-12-31`,
					member,
					status: (status.value || undefined) as AbsenceStatus | undefined,
				});
				body.replaceChildren(
					list.length === 0
						? emptyState(t("absence.empty"))
						: table(
								[t("workforce.person"), t("absence.kind"), t("absence.dates"), t("absence.days"), t("absence.status"), t("timesheet.note"), ""],
								list.map((absence) => absenceRow(absence))
							)
				);
				balanceSlot.replaceChildren(member === "all" ? el("div") : await balanceCard(uuid, state, member, selectedYear, () => void load()));
			} catch (error) {
				reportError(error);
			}
		};

		const absenceRow = (absence: Absence): HTMLElement => {
			const own = absence.member === state.me.member && state.me.own;
			const active = state.license.active;
			const actions: HTMLElement[] = [];
			if (active && state.me.edit && absence.status === "pending") {
				actions.push(
					el(
						"button",
						{ class: "button primary small", type: "button", onClick: () => decisionDialog(uuid, absence, "approved", () => void load()) },
						t("absence.approve")
					),
					el(
						"button",
						{ class: "button ghost small", type: "button", onClick: () => decisionDialog(uuid, absence, "rejected", () => void load()) },
						t("absence.reject")
					)
				);
			}
			if (active && ((own && absence.status === "pending") || (state.me.edit && (absence.status === "pending" || absence.status === "approved")))) {
				actions.push(
					el(
						"button",
						{ class: "button ghost small", type: "button", onClick: () => absenceDialog(uuid, state, member, absence, () => void load()) },
						t("ui.edit")
					),
					el(
						"button",
						{
							class: "button ghost small",
							type: "button",
							onClick: async () => {
								const confirmed = await confirmDialog({
									title: t("absence.cancel_title"),
									body: t("absence.cancel_body"),
									confirmLabel: t("absence.cancel"),
									destructive: true,
								});
								if (!confirmed) return;
								try {
									await Api.cancelAbsence(uuid, absence.uuid);
									void load();
								} catch (error) {
									reportError(error);
								}
							},
						},
						t("absence.cancel")
					)
				);
			}
			return el(
				"tr",
				{},
				el("td", {}, absence.person),
				el(
					"td",
					{},
					absenceLabel(absence.kind),
					absence.minutes_per_day ? el("div", { class: "muted" }, t("absence.hours_per_day", { hours: formatHours(absence.minutes_per_day) })) : null
				),
				el("td", {}, `${formatDay(absence.starts_on, project)} - ${formatDay(absence.ends_on, project)}`),
				el("td", { class: "numeric" }, absence.working_days === null ? "" : String(absence.working_days)),
				el("td", {}, absencePill(absence.status), absence.decided_by ? el("div", { class: "muted" }, absence.decided_by) : null),
				el("td", {}, absence.note ?? "", absence.decision_note ? el("div", { class: "muted" }, absence.decision_note) : null),
				el("td", { class: "actions" }, ...actions)
			);
		};

		picker?.addEventListener("change", () => {
			member = picker.value;
			void load();
		});
		years.addEventListener("change", () => void load());
		status.addEventListener("change", () => void load());
		await load();

		const canRequest = state.license.active && (state.me.own || state.me.edit);
		return el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "toolbar" },
				picker,
				years,
				status,
				canRequest
					? el(
							"button",
							{
								class: "button primary",
								type: "button",
								onClick: () => absenceDialog(uuid, state, member === "all" ? defaultPerson(state) : member, null, () => void load()),
							},
							state.me.edit ? t("absence.new") : t("absence.request")
						)
					: null
			),
			el("div", { class: "card" }, body),
			balanceSlot
		);
	});
}

function reportCard(project: Project, person: MonthReport["people"][number]): HTMLElement {
	const totals = person.totals;
	const absences = ABSENCE_KINDS.filter((kind) => totals.absence_minutes[kind] > 0);
	const activities = ENTRY_ACTIVITIES.filter((activity) => totals.activity_minutes[activity] > 0);
	const facts: [string, string][] = [
		[t("report.fund"), formatHours(totals.fund_minutes)],
		[t("report.paid_time"), formatHours(totals.worked_minutes)],
		[t("report.onsite"), formatHours(totals.onsite_minutes)],
		...activities.map((activity): [string, string] => [activityLabel(activity), formatHours(totals.activity_minutes[activity])]),
		[t("report.overtime"), formatHours(totals.overtime_minutes)],
		[t("report.holidays"), formatHours(totals.holiday_minutes)],
		...absences.map((kind): [string, string] => [absenceLabel(kind), formatHours(totals.absence_minutes[kind])]),
		[t("report.night"), formatHours(totals.night_minutes)],
		[t("report.sunday"), formatHours(totals.sunday_minutes)],
		[t("report.holiday_work"), formatHours(totals.holiday_work_minutes)],
		[t("report.days_worked"), String(totals.days_worked)],
		[t("report.meal_days"), String(totals.meal_days)],
		[t("report.commute_days"), String(totals.commute_days)],
		[t("report.balance"), formatHours(totals.balance_minutes)],
	];
	const rows = person.days.map((day) => {
		const notes = [
			day.holiday ? holidayName(day.holiday.name) : null,
			...day.absences.map((absence) => `${absenceLabel(absence.kind)}${absence.status === "pending" ? ` (${t("absence.status_pending")})` : ""}`),
		].filter(Boolean);
		const activitySummary = ENTRY_ACTIVITIES.filter((activity) => day.activity_minutes[activity] > 0)
			.map((activity) => `${activityLabel(activity)}: ${formatHours(day.activity_minutes[activity])}`)
			.join(", ");
		return el(
			"tr",
			{ class: day.working_day ? "" : "muted-row" },
			el("td", {}, `${weekdayName(day.date)} ${formatDay(day.date, project)}`),
			el("td", {}, notes.join(", ")),
			el("td", {}, activitySummary),
			el("td", { class: "numeric mono" }, day.onsite_minutes ? formatHours(day.onsite_minutes) : ""),
			el("td", { class: "numeric mono" }, day.worked_minutes ? formatHours(day.worked_minutes) : ""),
			el("td", { class: "numeric mono" }, day.overtime_minutes ? formatHours(day.overtime_minutes) : ""),
			el("td", { class: "numeric mono" }, day.night_minutes ? formatHours(day.night_minutes) : ""),
			el("td", { class: "numeric mono" }, day.break_minutes ? String(day.break_minutes) : "")
		);
	});
	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, person.person),
		el("dl", { class: "facts" }, ...facts.flatMap(([label, value]) => [el("dt", {}, label), el("dd", { class: "mono" }, value)])),
		el(
			"details",
			{},
			el("summary", {}, t("report.daily")),
			table(
				[
					t("timesheet.day"),
					t("report.notes"),
					t("timesheet.activity"),
					t("report.onsite"),
					t("report.paid_time"),
					t("report.overtime"),
					t("report.night"),
					t("report.breaks"),
				],
				rows
			)
		)
	);
}

export async function timesheetReportView(uuid: string): Promise<HTMLElement> {
	return timesheetSection(uuid, async (project, state) => {
		const month = input("month", { value: state.today.slice(0, 7) });
		const picker = state.me.view ? personPicker(state, "all", true) : null;
		const body = el("div", { class: "stack" });
		const member = () => (picker ? picker.value : state.me.member);

		const load = async (): Promise<void> => {
			if (!month.value) return;
			try {
				const report = await Api.timesheetReport(uuid, month.value, member());
				body.replaceChildren(...(report.people.length ? report.people.map((person) => reportCard(project, person)) : [emptyState(t("report.empty"))]));
			} catch (error) {
				reportError(error);
			}
		};
		month.addEventListener("change", () => void load());
		picker?.addEventListener("change", () => void load());
		await load();

		return el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "toolbar" },
				month,
				picker,
				el(
					"button",
					{
						class: "button ghost",
						type: "button",
						onClick: async () => {
							try {
								const file = await Api.timesheetReportCsv(uuid, month.value, member());
								saveFile(file.blob, file.name);
							} catch (error) {
								reportError(error);
							}
						},
					},
					t("report.download_csv")
				),
				el(
					"button",
					{
						class: "button ghost",
						type: "button",
						onClick: async () => {
							try {
								const file = await Api.timesheetReportPdf(uuid, month.value, member());
								saveFile(file.blob, file.name);
							} catch (error) {
								reportError(error);
							}
						},
					},
					t("report.download_pdf")
				)
			),
			el("p", { class: "muted" }, t("report.hint")),
			body
		);
	});
}

function settingsForm(project: Project, uuid: string, config: WorkforceConfig): HTMLElement {
	const number = (value: number, min: string, max: string, step = "1") => input("number", { min, max, step, value: String(value), required: true });
	const clock = (minutes: number) =>
		input("time", { value: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`, required: true });
	const editDays = number(config.edit_days, "0", "60");
	const paidBreak = number(config.paid_break_minutes, "0", "120");
	const daily = hoursInput(config.daily_minutes, { min: "1", max: "12" });
	const nightFrom = clock(config.night_from);
	const nightTo = clock(config.night_to);
	const rates = {
		overtime: number(config.rates.overtime, "0", "500", "0.01"),
		night: number(config.rates.night, "0", "500", "0.01"),
		sunday: number(config.rates.sunday, "0", "500", "0.01"),
		holiday: number(config.rates.holiday, "0", "500", "0.01"),
		waiting_home: number(config.rates.waiting_home, "0", "500", "0.01"),
		sick: number(config.rates.sick, "0", "500", "0.01"),
		injury: number(config.rates.injury, "0", "500", "0.01"),
	};
	const sickDays = number(config.sick_employer_days, "0", "366");
	const seniority = number(config.seniority_rate, "0", "5", "0.01");
	const meal = input("number", { min: "0", step: "0.01", value: String(toMajorUnits(config.meal_allowance, project.currency)) });
	const mealMinimum = hoursInput(config.meal_min_minutes, { max: "24" });
	const ticketRate = input("number", {
		min: "0",
		step: "0.01",
		value: config.ticket_hourly_rate === null ? "" : String(toMajorUnits(config.ticket_hourly_rate, project.currency)),
	});
	const ticketTax = number(config.ticket_tax_rate, "0", "100", "0.01");
	const notifications = input("checkbox");
	notifications.checked = config.email_notifications;
	const toMinutes = (value: string) => {
		const [hours, minutes] = value.split(":").map(Number);
		return hours * 60 + minutes;
	};

	return el(
		"form",
		{
			class: "card stack",
			onSubmit: async (event) => {
				event.preventDefault();
				try {
					await Api.saveWorkforceSettings(uuid, {
						edit_days: Number(editDays.value),
						paid_break_minutes: Number(paidBreak.value),
						daily_minutes: minutesFrom(daily) ?? 480,
						night_from: toMinutes(nightFrom.value),
						night_to: toMinutes(nightTo.value),
						rates: {
							overtime: Number(rates.overtime.value),
							night: Number(rates.night.value),
							sunday: Number(rates.sunday.value),
							holiday: Number(rates.holiday.value),
							waiting_home: Number(rates.waiting_home.value),
							sick: Number(rates.sick.value),
							injury: Number(rates.injury.value),
						},
						sick_employer_days: Number(sickDays.value),
						seniority_rate: Number(seniority.value),
						meal_allowance: toMinorUnits(Number(meal.value || 0), project.currency),
						meal_min_minutes: minutesFrom(mealMinimum) ?? 0,
						ticket_hourly_rate: ticketRate.value === "" ? null : toMinorUnits(Number(ticketRate.value), project.currency),
						ticket_tax_rate: Number(ticketTax.value),
						email_notifications: notifications.checked,
					});
					toast(t("workforce.settings_saved"), "success");
				} catch (error) {
					reportError(error);
				}
			},
		},
		el("h2", {}, t("workforce.settings_title")),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("workforce.edit_days"), editDays, t("workforce.edit_days_hint")),
			field(t("workforce.paid_break"), paidBreak, t("workforce.paid_break_hint")),
			field(t("workforce.daily_hours"), daily, t("workforce.daily_hours_hint"))
		),
		el("div", { class: "form-grid" }, field(t("workforce.night_from"), nightFrom), field(t("workforce.night_to"), nightTo)),
		el("h3", {}, t("workforce.rates_title")),
		el("p", { class: "muted" }, t("workforce.rates_hint")),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("workforce.rate_overtime"), rates.overtime),
			field(t("workforce.rate_night"), rates.night),
			field(t("workforce.rate_sunday"), rates.sunday),
			field(t("workforce.rate_holiday"), rates.holiday),
			field(t("workforce.rate_waiting_home"), rates.waiting_home),
			field(t("workforce.rate_sick"), rates.sick),
			field(t("workforce.rate_injury"), rates.injury)
		),
		el(
			"div",
			{ class: "form-grid three" },
			field(t("workforce.sick_days"), sickDays, t("workforce.sick_days_hint")),
			field(t("workforce.seniority_rate"), seniority, t("workforce.seniority_rate_hint")),
			field(t("workforce.meal_allowance", { currency: project.currency }), meal),
			field(t("workforce.meal_minimum"), mealMinimum)
		),
		el("h3", {}, t("workforce.ticket_billing")),
		el(
			"div",
			{ class: "form-grid" },
			field(t("workforce.ticket_rate", { currency: project.currency }), ticketRate, t("workforce.ticket_rate_hint")),
			field(t("workforce.ticket_tax"), ticketTax)
		),
		el("h3", {}, t("workforce.notifications_title")),
		el(
			"div",
			{ class: "field" },
			el("label", { class: "switch" }, notifications, el("span", {}, t("workforce.notifications"))),
			el("span", { class: "field-hint" }, t("workforce.notifications_hint"))
		),
		el("div", { class: "form-actions" }, el("button", { class: "button primary", type: "submit" }, t("ui.save")))
	);
}

async function holidaysCard(uuid: string, project: Project, year: number): Promise<HTMLElement> {
	const card = el("div", { class: "card stack" });
	const years = select(
		[year - 1, year, year + 1].map((value) => ({ value: String(value), label: String(value) })),
		String(year)
	);
	const list = el("div", {});
	const date = input("date", { required: true });
	const name = input("text", { required: true, maxlength: "200", placeholder: t("workforce.holiday_name_placeholder") });

	const load = async () => {
		try {
			const result = await Api.workforceHolidays(uuid, Number(years.value));
			list.replaceChildren(
				result.holidays.length === 0
					? emptyState(t("workforce.holidays_none"))
					: table(
							[t("timesheet.date"), t("workforce.holiday"), t("workforce.holiday_type"), ""],
							result.holidays.map((holiday) =>
								el(
									"tr",
									{ class: holiday.work_free ? "" : "muted-row" },
									el("td", {}, `${weekdayName(holiday.date)} ${formatDay(holiday.date, project)}`),
									el("td", {}, holidayName(holiday.name)),
									el(
										"td",
										{},
										t(
											holiday.source === "project"
												? "workforce.holiday_company"
												: holiday.work_free
													? "workforce.holiday_work_free"
													: "workforce.holiday_working"
										)
									),
									el(
										"td",
										{ class: "actions" },
										holiday.uuid
											? el(
													"button",
													{
														class: "link-button danger-text",
														type: "button",
														onClick: async () => {
															try {
																await Api.removeWorkforceHoliday(uuid, holiday.uuid!);
																void load();
															} catch (error) {
																reportError(error);
															}
														},
													},
													t("ui.delete")
												)
											: null
									)
								)
							)
						)
			);
		} catch (error) {
			reportError(error);
		}
	};
	years.addEventListener("change", () => void load());
	await load();

	card.append(
		el("div", { class: "toolbar" }, el("h2", { class: "toolbar-title" }, t("workforce.holidays_title")), years),
		el("p", { class: "muted" }, project.tax_country === "SI" ? t("workforce.holidays_hint_si") : t("workforce.holidays_hint_other")),
		list,
		el(
			"form",
			{
				class: "form-grid three",
				onSubmit: async (event) => {
					event.preventDefault();
					try {
						await Api.addWorkforceHoliday(uuid, date.value, name.value.trim());
						name.value = "";
						void load();
					} catch (error) {
						reportError(error);
					}
				},
			},
			field(t("timesheet.date"), date),
			field(t("workforce.holiday"), name),
			el("div", { class: "form-actions" }, el("button", { class: "button ghost", type: "submit" }, t("workforce.holiday_add")))
		)
	);
	return card;
}

export async function timesheetSettingsView(uuid: string): Promise<HTMLElement> {
	return timesheetSection(uuid, async (project, state) => {
		if (!state.me.edit) return emptyState(t("access.denied"));
		return el("div", { class: "stack" }, settingsForm(project, uuid, state.config), await holidaysCard(uuid, project, Number(state.today.slice(0, 4))));
	});
}
