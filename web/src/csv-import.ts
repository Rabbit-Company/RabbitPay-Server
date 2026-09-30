import { el, field, input, saveFile, table } from "./dom";
import { language, t, type UiKey } from "./i18n";
import { modal, reportError, toast } from "./ui";

export interface CsvImportError {
	row: number | null;
	column: string | null;
	reference: string | null;
	code: string;
}

export interface CsvImportPlan<T> {
	documents: T[];
	errors: CsvImportError[];
}

export interface CsvImportConfig<T> {
	title: string;
	hint: string;
	fileName: string;
	columns: string[];
	columnLabel: (column: string) => string;
	example: { sl: string[]; en: string[] };
	headers: string[];
	row: (document: T) => (string | HTMLElement)[];
	preview: (content: string) => Promise<CsvImportPlan<T>>;
	commit: (content: string) => Promise<{ imported: number }>;
	onImported: () => void;
}

function errorText(error: CsvImportError, columnLabel: (column: string) => string): string {
	const message = t(`csv.error_${error.code}` as UiKey, { column: error.column ? columnLabel(error.column) : "" });
	const where = [error.row === null ? null : t("csv.row", { row: error.row }), error.reference].filter(Boolean).join(" | ");
	return where ? `${where}: ${message}` : message;
}

export function csvImportDialog<T>(config: CsvImportConfig<T>) {
	const file = input("file", { required: true });
	file.accept = ".csv,text/csv";
	const summary = el("div", { class: "stack" });
	const submit = el("button", { class: "button primary", type: "submit", disabled: true }, t("csv.submit"));
	let content = "";

	const template = () => {
		const slovenian = language() === "sl";
		const header = config.columns.map((column) => (slovenian ? config.columnLabel(column) : column));
		const delimiter = slovenian ? ";" : ",";
		const example = slovenian ? config.example.sl : config.example.en;
		saveFile(new Blob([`﻿${header.join(delimiter)}\n${example.join(delimiter)}\n`], { type: "text/csv;charset=utf-8" }), config.fileName);
	};

	const show = (plan: CsvImportPlan<T>) => {
		submit.disabled = plan.errors.length > 0 || plan.documents.length === 0;
		const parts: HTMLElement[] = [el("p", {}, t("csv.ready", { count: plan.documents.length }))];
		if (plan.errors.length) {
			parts.push(
				el(
					"div",
					{ class: "stack" },
					el("p", { class: "warn" }, t("csv.errors", { count: plan.errors.length })),
					el("ul", {}, ...plan.errors.slice(0, 100).map((error) => el("li", {}, errorText(error, config.columnLabel))))
				)
			);
		}
		if (plan.documents.length) {
			parts.push(
				table(
					config.headers,
					plan.documents.map((document) => el("tr", {}, ...config.row(document).map((value) => el("td", {}, value))))
				)
			);
		}
		summary.replaceChildren(...parts);
	};

	file.addEventListener("change", async () => {
		const selected = file.files?.[0];
		submit.disabled = true;
		summary.replaceChildren();
		if (!selected) return;
		try {
			content = await selected.text();
			show(await config.preview(content));
		} catch (error) {
			reportError(error);
		}
	});

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const result = await config.commit(content);
					dialog.close();
					toast(t("csv.imported", { count: result.imported }));
					config.onImported();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "muted" }, config.hint),
		el("div", { class: "line-actions" }, el("button", { class: "button ghost small", type: "button", onClick: template }, t("csv.template"))),
		field(t("csv.file"), file),
		summary,
		el("div", { class: "form-actions" }, submit)
	);
	const dialog = modal(config.title, form);
}
