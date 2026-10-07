import { el } from "./dom";
import { formatBytes } from "./money";
import { t } from "./i18n";

export interface Transfer {
	update(done: number): void;
	finish(): void;
	fail(): void;
}

const FINISHED_VISIBLE_MS = 1500;

function host(): HTMLElement {
	const existing = document.querySelector<HTMLElement>(".transfers");
	if (existing) return existing;
	const created = el("div", { class: "transfers" });
	created.setAttribute("aria-live", "polite");
	document.body.appendChild(created);
	return created;
}

export function startTransfer(kind: "upload" | "download", name: string, total: number): Transfer {
	const fill = el("div", { class: "meter-fill" });
	const bar = el("div", { class: "meter" }, fill);
	bar.setAttribute("role", "progressbar");
	bar.setAttribute("aria-valuemin", "0");
	bar.setAttribute("aria-valuemax", "100");
	const detail = el("span", { class: "muted transfer-detail" });
	const node = el(
		"div",
		{ class: "transfer" },
		el("span", { class: "transfer-name" }, t(kind === "upload" ? "transfers.uploading" : "transfers.downloading", { name })),
		bar,
		detail
	);

	const update = (done: number) => {
		const percent = total <= 0 ? 100 : Math.min(Math.floor((done / total) * 100), 100);
		fill.style.width = `${percent}%`;
		bar.setAttribute("aria-valuenow", String(percent));
		detail.textContent = t("transfers.progress", { percent, done: formatBytes(Math.min(done, total)), total: formatBytes(total) });
	};
	update(0);
	host().appendChild(node);

	return {
		update,
		finish() {
			update(total);
			node.classList.add("transfer-done");
			setTimeout(() => node.remove(), FINISHED_VISIBLE_MS);
		},
		fail() {
			node.remove();
		},
	};
}
