import type { LicenseType, ProjectLicense } from "../api";
import { el } from "../dom";
import { formatDate } from "../money";
import { t, tn } from "../i18n";

const DAY = 86400000;
const MIN_SPAN_DAYS = 90;
const MONTH_DAYS = 30.44;
const STORAGE_GB_BYTES = 1_000_000_000;

interface Span {
	from: number;
	until: number;
	label: string;
}

interface Bar extends Span {
	scheduled: boolean;
	detail: string;
}

interface Grant {
	amount: number;
	from: number;
	until: number;
}

interface Total {
	grants: Grant[];
	included: number;
	format: (amount: number) => string;
}

interface Row {
	label: string;
	key: boolean;
	bars: Bar[];
	total: Total | null;
}

interface Range {
	start: number;
	end: number;
}

function place(node: HTMLElement, span: Span, range: Range) {
	const from = Math.max(span.from, range.start);
	const until = Math.min(span.until, range.end);
	const width = range.end - range.start;
	node.style.left = `${((from - range.start) / width) * 100}%`;
	node.style.width = `calc(${(Math.max(until - from, 0) / width) * 100}% - 2px)`;
}

function tickStep(range: Range): number {
	const months = (range.end - range.start) / (MONTH_DAYS * DAY);
	if (months <= 7) return 1;
	if (months <= 20) return 3;
	if (months <= 48) return 6;
	if (months <= 120) return 12;
	return 24;
}

function ticksOf(range: Range): { at: number; label: string }[] {
	const step = tickStep(range);
	const format = new Intl.DateTimeFormat(undefined, step >= 12 ? { year: "numeric" } : { month: "short", year: "numeric" });
	const first = new Date(range.start);
	const cursor = new Date(first.getFullYear(), first.getMonth() + 1, 1);
	const ticks: { at: number; label: string }[] = [];
	while (cursor.getTime() < range.end) {
		const index = cursor.getFullYear() * 12 + cursor.getMonth();
		if (index % step === 0) ticks.push({ at: cursor.getTime(), label: format.format(cursor) });
		cursor.setMonth(cursor.getMonth() + 1);
	}
	return ticks;
}

function totalsOf({ grants, included, format }: Total, range: Range): Span[] {
	const edges = grants.flatMap((grant) => [grant.from, grant.until]).filter((edge) => edge > range.start && edge < range.end);
	const points = [...new Set([range.start, ...edges, range.end])].sort((first, second) => first - second);
	const merged: (Span & { amount: number })[] = [];
	for (let index = 0; index < points.length - 1; index++) {
		const middle = (points[index] + points[index + 1]) / 2;
		const amount = grants.filter((grant) => grant.from <= middle && grant.until > middle).reduce((total, grant) => total + grant.amount, included);
		const last = merged[merged.length - 1];
		if (last && last.amount === amount) last.until = points[index + 1];
		else merged.push({ from: points[index], until: points[index + 1], amount, label: format(amount) });
	}
	return merged;
}

function addOnRow(state: ProjectLicense, type: LicenseType, label: string, active: boolean, until: number | null, now: number): Row {
	const bars: Bar[] = [];
	if (active && until !== null) {
		const label = t("license.bar_until", { date: formatDate(until) });
		bars.push({ from: now, until, label, scheduled: false, detail: label });
	}
	for (const entry of state.scheduled.filter((scheduled) => scheduled.type === type)) {
		bars.push({
			from: entry.from,
			until: entry.until,
			label: t("license.bar_from", { date: formatDate(entry.from) }),
			scheduled: true,
			detail: periodOf(entry, now),
		});
	}
	return { label, key: false, bars, total: null };
}

function periodOf(span: { from: number; until: number }, now: number): string {
	if (span.from <= now) return t("license.bar_until", { date: formatDate(span.until) });
	return t("license.period_range", { from: formatDate(span.from), until: formatDate(span.until) });
}

function keyRow(label: string, grant: Grant, text: string, now: number): Row {
	const bar = { from: grant.from, until: grant.until, label: text, scheduled: grant.from > now, detail: `${text} | ${periodOf(grant, now)}` };
	return { label, key: true, bars: [bar], total: null };
}

function detailOf(row: Row, range: Range): string {
	if (!row.total) return row.bars.map((bar) => bar.detail).join(" | ");
	return totalsOf(row.total, range)
		.map((span, index) => (index === 0 ? span.label : `${span.label} ${t("license.bar_from", { date: formatDate(span.from) })}`))
		.join(" | ");
}

function rowsOf(state: ProjectLicense, now: number): Row[] {
	const seats = state.employee_seats.map((seat) => ({ amount: seat.employees, from: seat.from, until: seat.until }));
	const storage = state.storage_grants.map((grant) => ({ amount: grant.storage_gb, from: grant.from, until: grant.until }));
	const rows = [
		addOnRow(state, "white_label", t("license.white_label"), state.white_label, state.white_label_until, now),
		addOnRow(state, "store", t("license.store"), state.store, state.store_until, now),
		addOnRow(state, "workforce", t("license.workforce"), state.workforce, state.workforce_until, now),
		addOnRow(state, "accounting", t("license.accounting"), state.accounting, state.accounting_until, now),
	];
	const gigabytes = (amount: number) => `${amount.toLocaleString()} GB`;
	if (state.workforce || seats.length > 0) {
		const total = { grants: seats, included: state.employees_included, format: (amount: number) => tn("count.employees", amount) };
		rows.push({ label: t("license.employees"), key: false, bars: [], total });
		for (const seat of seats) rows.push(keyRow(t("license.timeline_seat_key"), seat, tn("count.employees", seat.amount), now));
	}
	rows.push({
		label: t("license.storage"),
		key: false,
		bars: [],
		total: { grants: storage, included: state.storage_included / STORAGE_GB_BYTES, format: gigabytes },
	});
	for (const grant of storage) rows.push(keyRow(t("license.timeline_storage_key"), grant, gigabytes(grant.amount), now));
	return rows;
}

function track(row: Row, range: Range, ticks: { at: number }[]): HTMLElement {
	const lines = ticks.map((tick) => {
		const line = el("div", { class: "timeline-tick" });
		line.style.left = `${((tick.at - range.start) / (range.end - range.start)) * 100}%`;
		return line;
	});

	const marks = [
		...(row.total ? totalsOf(row.total, range) : []).map((span) => {
			const node = el("div", { class: "timeline-total", title: `${row.label}: ${span.label} | ${formatDate(span.from)} - ${formatDate(span.until)}` });
			node.append(el("span", {}, span.label));
			place(node, span, range);
			return node;
		}),
		...row.bars.map((bar) => {
			const node = el("div", {
				class: `timeline-bar${bar.scheduled ? " timeline-bar-scheduled" : ""}`,
				title: `${row.label}: ${bar.detail}`,
			});
			node.append(el("span", {}, bar.label));
			place(node, bar, range);
			return node;
		}),
	];

	return el(
		"div",
		{ class: "timeline-track" },
		...lines,
		...marks,
		marks.length === 0 ? el("span", { class: "timeline-empty" }, t("license.timeline_inactive")) : null
	);
}

export function timelineCard(state: ProjectLicense): HTMLElement | null {
	if (!state.enforced) return null;

	const now = Date.now();
	const rows = rowsOf(state, now);
	const ends = rows.flatMap((row) => row.bars.map((bar) => bar.until));
	const range = { start: now, end: Math.max(now + MIN_SPAN_DAYS * DAY, ...ends) };
	const ticks = ticksOf(range);

	const axis = el(
		"div",
		{ class: "timeline-track timeline-axis" },
		...ticks
			.filter((tick) => (tick.at - range.start) / (range.end - range.start) < 0.96)
			.map((tick) => {
				const label = el("span", {}, tick.label);
				label.style.left = `${((tick.at - range.start) / (range.end - range.start)) * 100}%`;
				return label;
			})
	);

	return el(
		"div",
		{ class: "card stack" },
		el("h2", {}, t("license.timeline")),
		el("p", { class: "muted" }, t("license.timeline_hint", { from: formatDate(range.start), until: formatDate(range.end) })),
		el(
			"div",
			{ class: "timeline-legend" },
			el("span", {}, el("i", { class: "timeline-swatch" }), t("license.timeline_active")),
			el("span", {}, el("i", { class: "timeline-swatch timeline-swatch-scheduled" }), t("license.timeline_scheduled")),
			el("span", {}, el("i", { class: "timeline-swatch timeline-swatch-total" }), t("license.timeline_total"))
		),
		el(
			"div",
			{ class: "timeline" },
			el("div", { class: "timeline-label timeline-axis-label" }),
			axis,
			...rows.flatMap((row) => [
				el(
					"div",
					{ class: `timeline-label${row.key ? " timeline-key" : ""}` },
					row.label,
					el("span", { class: `timeline-detail${row.total ? " timeline-detail-total" : ""}` }, detailOf(row, range))
				),
				track(row, range, ticks),
			])
		)
	);
}
