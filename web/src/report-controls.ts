import { ApiError, type GeneratedReport, type Project, type ReportState } from "./api";
import { el } from "./dom";
import { formatDate, formatDateTime } from "./money";
import type { DateFormat, TimeFormat } from "../../server/formats";
import { reportError } from "./ui";
import { t } from "./i18n";

export function reportControls<T extends { from: number; to: number }>(options: {
	project: Project;
	utcDates?: boolean;
	read: () => Promise<ReportState<T>>;
	generate: () => Promise<GeneratedReport<T>>;
	show: (report: GeneratedReport<T>) => void;
}): HTMLElement {
	const button = el("button", { class: "button primary", type: "button", disabled: true }, t("reports.generate"));
	const status = el("p", { class: "muted" }, t("ui.loading"));
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const range = el("p", { class: "muted" });
	const hint = el("p", { class: "muted" }, t("reports.filters_hint"));
	const node = el("div", { class: "stack" }, el("div", { class: "line-actions" }, button), status, range, hint);
	let state: ReportState<T> | null = null;
	let busy = true;
	let offset = 0;
	let connected = false;
	const created = Date.now();
	let lastRead = 0;
	const dateFormat = options.project.date_format as DateFormat;
	const timeFormat = options.project.time_format as TimeFormat;
	const dateTime = (date: number) => formatDateTime(date, dateFormat, timeFormat);
	const periodDate = (timestamp: number) => {
		const date = new Date(timestamp);
		return formatDate(options.utcDates ? new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).getTime() : timestamp, dateFormat);
	};
	const update = () => {
		const waiting = state !== null && state.next_generation_at > Date.now() + offset;
		button.disabled = busy || Boolean(state?.generating) || waiting;
		button.textContent = busy && state !== null ? t("reports.generating") : t("reports.generate");
		if (!state) return;
		const messages: string[] = [];
		if (state.report) messages.push(t("reports.generated_at", { date: dateTime(state.report.generated_at) }));
		else messages.push(t("reports.not_generated"));
		if (state.generating) messages.push(t("reports.in_progress"));
		else if (waiting) messages.push(t("reports.available_at", { date: dateTime(state.next_generation_at) }));
		const message = messages.join(" ");
		if (status.textContent !== message) status.textContent = message;
	};
	const apply = (next: ReportState<T>, force = false) => {
		const previousGeneration = state?.report?.generated_at;
		state = next;
		offset = next.server_time - Date.now();
		if (next.report && (force || next.report.generated_at !== previousGeneration)) options.show(next.report);
		if (next.report) {
			const from = next.report.from === 0 ? t("stats.period_all") : periodDate(next.report.from);
			const to = next.report.to > 8640000000000000 ? t("reports.no_end") : periodDate(next.report.to);
			range.textContent = t("reports.range", { from, to });
		}
		update();
	};
	const read = async () => {
		busy = true;
		lastRead = Date.now();
		update();
		try {
			apply(await options.read());
		} catch (error) {
			reportError(error);
			status.textContent = t("ui.load_failed");
		} finally {
			busy = false;
			update();
		}
	};
	button.addEventListener("click", async () => {
		if (button.disabled) return;
		busy = true;
		update();
		try {
			const report = await options.generate();
			apply({ report, generating: false, next_generation_at: report.next_generation_at, server_time: report.generated_at }, true);
		} catch (error) {
			if (error instanceof ApiError && (error.code === 1117 || error.code === 1118)) {
				apply(error.data as ReportState<T>);
			} else {
				reportError(error);
			}
		} finally {
			busy = false;
			update();
		}
	});
	const timer = setInterval(() => {
		if (node.isConnected) connected = true;
		else if (connected || Date.now() - created > 30000) {
			clearInterval(timer);
			return;
		}
		update();
		if (state?.generating && !busy && Date.now() - lastRead >= 5000) void read();
	}, 1000);
	void read();
	return node;
}
