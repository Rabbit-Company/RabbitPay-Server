import { Api, type AbsenceKind, type Project, type TicketKind, type TicketPriority, type TicketStatus, type WorkforceState } from "../api";
import { el, select } from "../dom";
import { formatDate } from "../money";
import { currentPath } from "../router";
import { can, Permission } from "../access";
import { language, t, type UiKey } from "../i18n";
import { loadProject, projectLayout } from "./project";
import type { DateFormat } from "../../../server/formats";

const SECTIONS: { id: string; label: UiKey; suffix: string; editOnly: boolean }[] = [
	{ id: "time", label: "workforce.tab_time", suffix: "", editOnly: false },
	{ id: "absences", label: "workforce.tab_absences", suffix: "/absences", editOnly: false },
	{ id: "report", label: "workforce.tab_report", suffix: "/report", editOnly: false },
	{ id: "settings", label: "workforce.tab_settings", suffix: "/settings", editOnly: true },
];

export const ABSENCE_KINDS: AbsenceKind[] = ["vacation", "sick", "injury", "paid_leave", "unpaid", "parental", "other"];
export const TICKET_KINDS: TicketKind[] = ["task", "bug", "feature", "support"];
export const TICKET_STATUSES: TicketStatus[] = ["open", "in_progress", "waiting", "resolved", "closed"];
export const TICKET_PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

const TICKET_PILLS: Record<TicketStatus, string> = {
	open: "open",
	in_progress: "partially_paid",
	waiting: "pending",
	resolved: "paid",
	closed: "draft",
};

const ABSENCE_PILLS: Record<string, string> = {
	pending: "pending",
	approved: "paid",
	rejected: "canceled",
	canceled: "draft",
};

export function formatHours(minutes: number): string {
	const sign = minutes < 0 ? "-" : "";
	const absolute = Math.abs(Math.round(minutes));
	return `${sign}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
}

export function formatDay(date: string, project: Pick<Project, "date_format">): string {
	const [year, month, day] = date.split("-").map(Number);
	return formatDate(Date.UTC(year, month - 1, day), project.date_format as DateFormat, "UTC");
}

export function weekdayName(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	return new Intl.DateTimeFormat(language() === "sl" ? "sl-SI" : "en-GB", { weekday: "short", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day));
}

export function shiftDate(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number);
	const shifted = new Date(Date.UTC(year, month - 1, day + days));
	return shifted.toISOString().slice(0, 10);
}

export function weekStart(date: string): string {
	const [year, month, day] = date.split("-").map(Number);
	const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	return shiftDate(date, -((weekday + 6) % 7));
}

export function holidayName(name: { en: string; sl: string }): string {
	return language() === "sl" ? name.sl : name.en;
}

export function absenceLabel(kind: AbsenceKind): string {
	return t(`absence.kind_${kind}` as UiKey);
}

export function absencePill(status: string): HTMLElement {
	return el("span", { class: `pill pill-${ABSENCE_PILLS[status] ?? "draft"}` }, t(`absence.status_${status}` as UiKey));
}

export function ticketPill(status: TicketStatus): HTMLElement {
	return el("span", { class: `pill pill-${TICKET_PILLS[status]}` }, t(`ticket.status_${status}` as UiKey));
}

export function ticketKindLabel(kind: TicketKind): string {
	return t(`ticket.kind_${kind}` as UiKey);
}

export function ticketPriorityLabel(priority: TicketPriority): string {
	return t(`ticket.priority_${priority}` as UiKey);
}

export function personPicker(state: WorkforceState, selected: string, includeAll: boolean): HTMLSelectElement {
	const options = state.people.map((person) => ({ value: person.member, label: person.name }));
	if (state.me.own && !options.some((option) => option.value === state.me.member)) options.unshift({ value: state.me.member, label: state.me.name });
	if (includeAll) options.unshift({ value: "all", label: t("workforce.everyone") });
	return select(options, selected);
}

export function defaultPerson(state: WorkforceState): string {
	if (state.me.own) return state.me.member;
	return state.people[0]?.member ?? state.me.member;
}

function licenseGate(project: Project, state: WorkforceState): HTMLElement {
	return el(
		"div",
		{ class: "card store-gate" },
		el("h2", {}, t("workforce.gate_title")),
		el("p", {}, t("workforce.gate_body")),
		el(
			"ul",
			{ class: "store-gate-list" },
			...(["workforce.gate_point_time", "workforce.gate_point_absences", "workforce.gate_point_tickets", "workforce.gate_point_payroll"] as UiKey[]).map(
				(key) => el("li", {}, t(key))
			)
		),
		state.license.until !== null ? el("p", { class: "warn" }, t("workforce.gate_ended", { date: formatDate(state.license.until) })) : null,
		can(project, Permission.PROJECT_EDIT)
			? el("a", { class: "button primary", href: `/projects/${project.uuid}/license` }, t("store.gate_redeem"))
			: el("p", { class: "muted" }, t("store.gate_ask_owner"))
	);
}

export function readOnlyNotice(state: WorkforceState): HTMLElement | null {
	if (state.license.active) return null;
	if (state.license.seats_exceeded) {
		const counts = { used: state.license.employees_used.toLocaleString(), limit: (state.license.employees_limit ?? 0).toLocaleString() };
		return el("div", { class: "card notice" }, el("p", {}, t("workforce.seats_exceeded", counts)));
	}
	return el("div", { class: "card notice" }, el("p", {}, t("workforce.read_only", { date: formatDate(state.license.until) })));
}

export async function workforceGate(
	uuid: string,
	render: (project: Project, state: WorkforceState) => Promise<HTMLElement> | HTMLElement
): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const state = await Api.workforce(uuid);
	if (!state.license.active && state.license.until === null) return projectLayout(project, el("div", { class: "stack" }, licenseGate(project, state)));
	return projectLayout(project, el("div", { class: "stack" }, readOnlyNotice(state), await render(project, state)));
}

export async function timesheetSection(
	uuid: string,
	render: (project: Project, state: WorkforceState) => Promise<HTMLElement> | HTMLElement
): Promise<HTMLElement> {
	return workforceGate(uuid, async (project, state) => {
		const path = currentPath();
		const base = `/projects/${project.uuid}/timesheet`;
		const tabs = el(
			"nav",
			{ class: "subtabs" },
			...SECTIONS.filter((section) => !section.editOnly || state.me.edit).map((section) => {
				const href = `${base}${section.suffix}`;
				const active = section.suffix === "" ? path === href : path.startsWith(href);
				return el("a", { class: `subtab${active ? " active" : ""}`, href }, t(section.label));
			})
		);
		return el("div", { class: "stack" }, el("div", { class: "store-bar" }, tabs), await render(project, state));
	});
}

export function hoursInput(minutes: number | null, props: { min?: string; max?: string } = {}): HTMLInputElement {
	return el("input", { type: "number", step: "0.25", min: props.min ?? "0", max: props.max, value: minutes === null ? "" : String(minutes / 60) });
}

export function minutesFrom(inputElement: HTMLInputElement): number | null {
	if (inputElement.value.trim() === "") return null;
	const hours = Number(inputElement.value);
	return Number.isFinite(hours) ? Math.round(hours * 60) : null;
}
