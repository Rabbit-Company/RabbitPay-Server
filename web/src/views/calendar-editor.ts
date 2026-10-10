import {
	Api,
	type CalendarEntry,
	type CalendarEventInput,
	type CalendarFeed,
	type CalendarRepeat,
	type CalendarRepeatUnit,
	type CalendarSeriesScope,
	type CalendarVisibility,
	type Project,
} from "../api";
import { el, field, input, select } from "../dom";
import { t, type UiKey } from "../i18n";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { formatDay } from "./workforce-shared";
import {
	avatar,
	clockOfMinutes,
	clockValue,
	DAY_MINUTES,
	isoWeekday,
	minutesOfClock,
	MINUTE_MS,
	seriesStartsOn,
	todayKey,
	weekdayOfIso,
} from "./calendar-shared";

export interface CalendarContext {
	uuid: string;
	project: Project;
	feed: () => CalendarFeed;
	reload: () => Promise<void>;
}

export interface EditorOptions {
	entry?: CalendarEntry;
	kind?: "event" | "meeting";
	date?: string;
	minutes?: number;
	accounts?: string[];
}

type Preset = "none" | "day" | "weekdays" | "week" | "biweek" | "month" | "year" | "custom";

const PRESETS: Preset[] = ["none", "day", "weekdays", "week", "biweek", "month", "year", "custom"];
const UNITS: CalendarRepeatUnit[] = ["day", "week", "month", "year"];
const VISIBILITIES: CalendarVisibility[] = ["details", "busy", "private"];
const WORK_WEEK = [1, 2, 3, 4, 5];
const DEFAULT_MINUTES = 60;
const AVAILABILITY_DELAY_MS = 250;
const MAX_TITLE_LENGTH = 80;
const MAX_NOTE_LENGTH = 2000;

function presetOf(repeat: CalendarRepeat | null): Preset {
	if (!repeat) return "none";
	const plain = repeat.weekdays === null;
	if (repeat.unit === "day" && repeat.interval === 1) return "day";
	if (repeat.unit === "week" && repeat.interval === 1 && repeat.weekdays?.join() === WORK_WEEK.join()) return "weekdays";
	if (repeat.unit === "week" && plain && repeat.interval === 1) return "week";
	if (repeat.unit === "week" && plain && repeat.interval === 2) return "biweek";
	if (repeat.unit === "month" && repeat.interval === 1) return "month";
	if (repeat.unit === "year" && repeat.interval === 1) return "year";
	return "custom";
}

function nextFullHour(): number {
	const now = new Date();
	return Math.min(now.getHours() + 1, 23) * 60;
}

function segmented<Value extends string>(options: { value: Value; label: string }[], selected: Value, onChange: (value: Value) => void): HTMLElement {
	const buttons = options.map((option) => {
		const button = el("button", { class: `subtab${option.value === selected ? " active" : ""}`, type: "button" }, option.label);
		button.addEventListener("click", () => {
			for (const other of buttons) other.classList.toggle("active", other === button);
			onChange(option.value);
		});
		return button;
	});
	return el("div", { class: "subtabs" }, ...buttons);
}

export function openEditor(context: CalendarContext, options: EditorOptions = {}) {
	const { uuid, project } = context;
	const feed = context.feed();
	const entry = options.entry;
	const editing = entry !== undefined;
	let kind: "event" | "meeting" = entry ? (entry.kind === "meeting" ? "meeting" : "event") : (options.kind ?? "event");
	if (kind === "meeting" && !editing && !feed.meetings) kind = "event";

	const firstDate = entry ? seriesStartsOn(entry) : (options.date ?? todayKey());
	const firstMinutes = entry?.series_starts_at ? minutesOfClock(clockValue(entry.series_starts_at)) : (options.minutes ?? nextFullHour());
	let length = entry && !entry.all_day ? Math.round((entry.ends_at! - entry.starts_at!) / MINUTE_MS) : DEFAULT_MINUTES;

	const title = input("text", { maxlength: String(MAX_TITLE_LENGTH), required: true, value: entry?.title ?? "" });
	const allDay = input("checkbox");
	allDay.checked = entry?.all_day ?? false;
	const date = input("date", { value: firstDate, required: true });
	const startTime = input("time", { value: clockOfMinutes(firstMinutes), required: true, step: "300" });
	const endTime = input("time", { value: clockOfMinutes((firstMinutes + length) % DAY_MINUTES), required: true, step: "300" });
	const endDate = input("date", { value: entry?.series_ends_on ?? firstDate, required: true });

	const preset = select(
		PRESETS.map((value) => ({ value, label: t(`calendar.preset_${value}` as UiKey) })),
		presetOf(entry?.repeat ?? null)
	);
	const until = input("date", { value: entry?.repeat?.until ?? "" });
	const interval = input("number", { min: "1", max: "99", step: "1", value: String(entry?.repeat?.interval ?? 1) });
	const unit = select(
		UNITS.map((value) => ({ value, label: t(`calendar.unit_${value}` as UiKey) })),
		entry?.repeat?.unit ?? "week"
	);
	const chosenWeekdays = new Set<number>(entry?.repeat?.weekdays ?? [isoWeekday(firstDate)]);
	const weekdayButtons = [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
		const button = el("button", { class: "calendar-weekday", type: "button", title: weekdayOfIso(weekday, "long") }, weekdayOfIso(weekday));
		button.setAttribute("aria-pressed", String(chosenWeekdays.has(weekday)));
		button.addEventListener("click", () => {
			if (chosenWeekdays.has(weekday)) chosenWeekdays.delete(weekday);
			else chosenWeekdays.add(weekday);
			button.setAttribute("aria-pressed", String(chosenWeekdays.has(weekday)));
		});
		return button;
	});

	const visibility = select(
		VISIBILITIES.map((value) => ({ value, label: t(`calendar.visibility_${value}` as UiKey) })),
		entry?.visibility ?? "details"
	);
	const visibilityHint = el("span", { class: "field-hint" });
	const note = el("textarea", { rows: "3", maxlength: String(MAX_NOTE_LENGTH) }, entry?.note ?? "");
	const guests = input("checkbox");
	guests.checked = entry?.guests ?? false;

	const invited = new Set(options.accounts?.filter((account) => account !== feed.me) ?? []);
	const availability = new Map<string, HTMLElement>();
	const peopleRows = feed.people
		.filter((person) => person.account !== feed.me)
		.map((person) => {
			const box = input("checkbox", { value: person.account });
			box.checked = invited.has(person.account);
			box.addEventListener("change", () => (box.checked ? invited.add(person.account) : invited.delete(person.account)));
			const tag = el("span", { class: "calendar-availability" });
			availability.set(person.account, tag);
			return el("label", { class: "calendar-invitee" }, box, avatar(feed, person, "small"), el("span", { class: "calendar-invitee-name" }, person.name), tag);
		});

	const timedRow = el(
		"div",
		{ class: "form-grid three" },
		field(t("meetings.date"), date),
		field(t("calendar.starts"), startTime),
		field(t("calendar.ends"), endTime)
	);
	const firstDay = input("date", { value: firstDate, required: true });
	const dayRow = el("div", { class: "form-grid" }, field(t("calendar.first_day"), firstDay), field(t("calendar.last_day"), endDate));
	firstDay.addEventListener("change", () => {
		date.value = firstDay.value;
		if (endDate.value < firstDay.value) endDate.value = firstDay.value;
	});
	date.addEventListener("change", () => {
		firstDay.value = date.value;
		if (endDate.value < date.value) endDate.value = date.value;
	});

	const untilField = field(t("calendar.repeat_until"), until, t("calendar.repeat_until_hint"));
	const weekdayRow = el("div", { class: "calendar-weekdays" }, ...weekdayButtons);
	const customRow = el(
		"div",
		{ class: "calendar-custom" },
		el("div", { class: "form-grid" }, field(t("calendar.every"), interval), field(t("calendar.unit"), unit)),
		weekdayRow
	);
	const allDayRow = el("label", { class: "switch" }, allDay, el("span", {}, t("calendar.all_day")));
	const eventOnly = el(
		"div",
		{ class: "calendar-editor-part" },
		el("label", { class: "field" }, el("span", { class: "field-label" }, t("calendar.visibility")), visibility, visibilityHint),
		field(t("calendar.note"), note)
	);
	const peoplePart = el(
		"div",
		{ class: "calendar-editor-part" },
		el("strong", {}, t("meetings.people")),
		peopleRows.length === 0 ? el("p", { class: "muted" }, t("chat.nobody")) : el("div", { class: "calendar-invitees" }, ...peopleRows)
	);
	const guestsPart = el(
		"div",
		{ class: "calendar-editor-part" },
		el("label", { class: "switch" }, guests, el("span", {}, t("meetings.allow_guests"))),
		el("p", { class: "muted" }, t("meetings.allow_guests_hint"))
	);
	const seriesHint = entry?.repeat ? el("p", { class: "calendar-series-hint" }, t("calendar.series_hint", { date: formatDay(firstDate, project) })) : null;
	const save = el(
		"button",
		{ class: "button primary", type: "submit" },
		editing ? t("ui.save") : kind === "meeting" ? t("meetings.schedule") : t("calendar.add_event")
	);

	function timed(): { starts_at: number; duration_minutes: number } | null {
		const startsAt = new Date(`${date.value}T${startTime.value}`).getTime();
		return Number.isFinite(startsAt) && length > 0 ? { starts_at: startsAt, duration_minutes: length } : null;
	}

	function repeat(): CalendarRepeat | null {
		const chosen = preset.value as Preset;
		const end = until.value === "" ? null : until.value;
		if (chosen === "none") return null;
		if (chosen === "day") return { unit: "day", interval: 1, weekdays: null, until: end };
		if (chosen === "weekdays") return { unit: "week", interval: 1, weekdays: WORK_WEEK, until: end };
		if (chosen === "week") return { unit: "week", interval: 1, weekdays: null, until: end };
		if (chosen === "biweek") return { unit: "week", interval: 2, weekdays: null, until: end };
		if (chosen === "month") return { unit: "month", interval: 1, weekdays: null, until: end };
		if (chosen === "year") return { unit: "year", interval: 1, weekdays: null, until: end };
		const weekly = unit.value === "week";
		return {
			unit: unit.value as CalendarRepeatUnit,
			interval: Math.min(Math.max(Math.round(Number(interval.value)) || 1, 1), 99),
			weekdays: weekly && chosenWeekdays.size > 0 ? [...chosenWeekdays].sort() : null,
			until: end,
		};
	}

	let availabilityTimer: ReturnType<typeof setTimeout> | null = null;
	let availabilityRound = 0;

	function checkAvailability() {
		if (editing || kind !== "meeting" || peopleRows.length === 0) return;
		if (availabilityTimer !== null) clearTimeout(availabilityTimer);
		availabilityTimer = setTimeout(async () => {
			const times = timed();
			if (!times || date.value === "") return;
			const round = ++availabilityRound;
			try {
				const day = await Api.calendar(uuid, date.value, date.value);
				if (round !== availabilityRound) return;
				const end = times.starts_at + times.duration_minutes * MINUTE_MS;
				for (const [account, tag] of availability) {
					const own = day.entries.filter((other) => other.accounts.includes(account));
					const absent = own.some((other) => other.kind === "absence" && !other.pending && other.starts_on! <= date.value && other.ends_on! >= date.value);
					const busy = own.some((other) => !other.all_day && other.starts_at! < end && other.ends_at! > times.starts_at);
					tag.textContent = absent ? t("calendar.absent") : busy ? t("calendar.busy") : t("calendar.free");
					tag.className = `calendar-availability ${absent || busy ? "is-busy" : "is-free"}`;
				}
			} catch {
				for (const tag of availability.values()) tag.textContent = "";
			}
		}, AVAILABILITY_DELAY_MS);
	}

	function refresh() {
		const meeting = kind === "meeting";
		const wholeDay = !meeting && allDay.checked;
		allDayRow.hidden = meeting;
		timedRow.hidden = wholeDay;
		dayRow.hidden = !wholeDay;
		eventOnly.hidden = meeting;
		peoplePart.hidden = !meeting || editing;
		guestsPart.hidden = !meeting;
		untilField.hidden = preset.value === "none";
		customRow.hidden = preset.value !== "custom";
		weekdayRow.hidden = unit.value !== "week";
		visibilityHint.textContent = t(`calendar.visibility_${visibility.value}_hint` as UiKey);
		if (!editing) save.textContent = meeting ? t("meetings.schedule") : t("calendar.add_event");
		checkAvailability();
	}

	startTime.addEventListener("change", () => {
		endTime.value = clockOfMinutes((minutesOfClock(startTime.value) + length) % DAY_MINUTES);
		checkAvailability();
	});
	endTime.addEventListener("change", () => {
		const minutes = minutesOfClock(endTime.value) - minutesOfClock(startTime.value);
		length = minutes > 0 ? minutes : minutes + DAY_MINUTES;
		checkAvailability();
	});
	date.addEventListener("change", checkAvailability);
	for (const control of [allDay, preset, unit, visibility]) control.addEventListener("change", refresh);

	async function submit() {
		const name = title.value.trim();
		const rule = repeat();
		if (kind === "meeting") {
			const times = timed();
			if (!times) return;
			if (entry) {
				if (name !== entry.title) await Api.renameChatGroup(uuid, entry.series!, name);
				await Api.updateMeeting(uuid, entry.series!, { ...times, guests: guests.checked, repeat: rule });
				toast(t("meetings.saved"), "success");
			} else {
				await Api.scheduleMeeting(uuid, { title: name, ...times, accounts: [...invited], guests: guests.checked, repeat: rule });
				toast(t("meetings.scheduled"), "success");
			}
			return;
		}
		const shared = { title: name, note: note.value.trim() || null, visibility: visibility.value as CalendarVisibility, repeat: rule };
		const event: CalendarEventInput | null = allDay.checked
			? { ...shared, all_day: true, starts_on: date.value, ends_on: endDate.value < date.value ? date.value : endDate.value }
			: timed()
				? { ...shared, all_day: false, ...timed()! }
				: null;
		if (!event) return;
		if (entry) await Api.updateCalendarEvent(uuid, entry.series!, event);
		else await Api.createCalendarEvent(uuid, event);
		toast(t(entry ? "calendar.event_saved" : "calendar.event_added"), "success");
	}

	const form = el(
		"form",
		{
			class: "stack calendar-editor",
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;
				try {
					await submit();
					dialog.close();
					await context.reload();
				} catch (error) {
					reportError(error);
					save.disabled = false;
				}
			},
		},
		!editing && feed.meetings
			? segmented(
					[
						{ value: "event", label: t("calendar.kind_event") },
						{ value: "meeting", label: t("calendar.kind_meeting") },
					],
					kind,
					(value) => {
						kind = value;
						refresh();
					}
				)
			: null,
		field(t("meetings.title_label"), title),
		allDayRow,
		timedRow,
		dayRow,
		el("div", { class: "form-grid" }, field(t("calendar.repeat"), preset), untilField),
		customRow,
		eventOnly,
		peoplePart,
		guestsPart,
		seriesHint,
		el("div", { class: "dialog-actions" }, save)
	);
	refresh();
	const heading = editing ? (kind === "meeting" ? t("calendar.edit_meeting") : t("calendar.edit_event")) : t("calendar.new");
	const dialog = modal(heading, form, () => availabilityTimer !== null && clearTimeout(availabilityTimer), "dialog-wide");
	title.focus();
}

function chooseScope(entry: CalendarEntry, project: Project): Promise<CalendarSeriesScope | null> {
	return new Promise((resolve) => {
		let chosen: CalendarSeriesScope | null = null;
		const day = formatDay(entry.occurrence, project);
		const choices: { scope: CalendarSeriesScope; label: string; hint: string }[] = [
			{ scope: "one", label: t("calendar.remove_one"), hint: t("calendar.remove_one_hint", { date: day }) },
			{ scope: "following", label: t("calendar.remove_following"), hint: t("calendar.remove_following_hint", { date: day }) },
			{ scope: "all", label: t("calendar.remove_all"), hint: t(entry.kind === "meeting" ? "calendar.remove_meeting_hint" : "calendar.remove_all_hint") },
		];
		const list = el(
			"div",
			{ class: "calendar-choices" },
			...choices.map((choice) =>
				el(
					"button",
					{
						class: "calendar-choice",
						type: "button",
						onClick: () => {
							chosen = choice.scope;
							dialog.close();
						},
					},
					el("strong", {}, choice.label),
					el("span", { class: "muted" }, choice.hint)
				)
			)
		);
		const dialog = modal(t(entry.kind === "meeting" ? "calendar.cancel_meeting" : "calendar.remove_event"), list, () => resolve(chosen), "");
	});
}

export async function removeEntry(context: CalendarContext, entry: CalendarEntry): Promise<boolean> {
	const meeting = entry.kind === "meeting";
	const scope = entry.repeat
		? await chooseScope(entry, context.project)
		: (await confirmDialog({
					title: t(meeting ? "calendar.cancel_meeting" : "calendar.remove_event"),
					body: t(meeting ? "calendar.remove_meeting_hint" : "calendar.remove_event_body", { title: entry.title ?? "" }),
					confirmLabel: t(meeting ? "calendar.cancel_meeting" : "ui.delete"),
					destructive: true,
			  }))
			? "all"
			: null;
	if (scope === null) return false;
	const occurrence = scope === "all" ? undefined : entry.occurrence;
	const partial = scope === "all" ? undefined : scope;
	try {
		if (meeting) await Api.cancelMeeting(context.uuid, entry.series!, occurrence, partial);
		else await Api.removeCalendarEvent(context.uuid, entry.series!, occurrence, partial);
		toast(t(meeting ? "calendar.meeting_cancelled" : "calendar.event_removed"), "success");
		await context.reload();
		return true;
	} catch (error) {
		reportError(error);
		return false;
	}
}
