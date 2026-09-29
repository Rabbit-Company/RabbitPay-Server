import { Api, type Project, type StoreConfig, type StoreLanguage, type StoreLanguages, type StoreState } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { isUiLanguage, t, type UiKey, type UiLanguage } from "../i18n";
import { can, Permission } from "../access";
import { navigate, onLeave } from "../router";
import { confirmDialog, reportError, toast } from "../ui";
import { builtinText, placeholdersOf, storefrontStrings, type StringEntry, type StringGroupId } from "../storefront/strings";
import { storeSection } from "./store";

const GROUPS: { id: StringGroupId; label: UiKey }[] = [
	{ id: "store", label: "store.translations_group_store" },
	{ id: "customer", label: "store.translations_group_customer" },
	{ id: "labels", label: "store.translations_group_labels" },
	{ id: "errors", label: "store.translations_group_errors" },
	{ id: "general", label: "store.translations_group_general" },
];

function fallbackOf(data: StoreLanguages, language: StoreLanguage): UiLanguage {
	if (isUiLanguage(language.code)) return language.code;
	return isUiLanguage(data.default) ? data.default : "en";
}

function nativeName(code: string): string {
	try {
		const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
		if (!name || name === code) return "";
		return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
	} catch {
		return "";
	}
}

function storeLink(state: StoreState, code: string): string | null {
	if (!state.exists || !state.enabled) return null;
	return `${state.domain_url ?? state.url}?lang=${encodeURIComponent(code)}`;
}

function textsSummary(language: StoreLanguage): string {
	const filled = Object.keys(language.strings).length;
	if (language.builtin) return filled === 0 ? t("store.translations_builtin") : t("store.translations_changed", { count: filled });
	const entries = storefrontStrings(language.code);
	const done = entries.filter((entry) => language.strings[entry.key] !== undefined).length;
	return t("store.translations_progress", { done, total: entries.length });
}

function languageRows(project: Project, state: StoreState, data: StoreLanguages, onChange: (next: StoreLanguages) => void): HTMLElement {
	const editable = can(project, Permission.PROJECT_EDIT);
	const base = `/projects/${project.uuid}/store/translations`;

	const setShown = async (language: StoreLanguage, enabled: boolean) => {
		try {
			onChange(await Api.saveStoreLanguage(project.uuid, language.code, { name: language.name, enabled, strings: language.strings }));
		} catch (error) {
			reportError(error);
		}
	};

	const remove = async (language: StoreLanguage) => {
		const confirmed = await confirmDialog({
			title: t("store.translations_delete_title", { name: language.name }),
			body: t("store.translations_delete_body"),
			confirmLabel: t("ui.delete"),
			destructive: true,
		});
		if (!confirmed) return;
		try {
			onChange(await Api.removeStoreLanguage(project.uuid, language.code));
		} catch (error) {
			reportError(error);
		}
	};

	return table(
		[t("store.translations_language"), t("store.translations_status"), t("store.translations_texts"), ""],
		data.languages.map((language) => {
			const main = language.code === data.default;
			const shown = main || language.enabled;
			const status = main
				? el("span", { class: "pill pill-paid pill-sentence" }, t("store.translations_default"))
				: el(
						"span",
						{ class: `pill pill-${shown ? "active" : "draft"} pill-sentence` },
						shown ? t("store.translations_shown") : t("store.translations_hidden")
					);
			return el(
				"tr",
				{},
				el(
					"td",
					{},
					el("strong", {}, language.name),
					" ",
					el("span", { class: "muted mono" }, language.code),
					el("div", { class: "muted" }, language.builtin ? t("store.translations_kind_builtin") : t("store.translations_kind_custom"))
				),
				el("td", {}, status),
				el("td", {}, textsSummary(language)),
				el(
					"td",
					{ class: "actions" },
					editable && !main
						? el(
								"button",
								{ class: "button ghost small", type: "button", onClick: () => void setShown(language, !language.enabled) },
								language.enabled ? t("store.translations_hide") : t("store.translations_show")
							)
						: null,
					el("a", { class: "button ghost small", href: `${base}/${encodeURIComponent(language.code)}` }, t("store.translations_edit")),
					storeLink(state, language.code) && shown
						? el(
								"a",
								{ class: "button ghost small", href: storeLink(state, language.code)!, target: "_blank", rel: "noopener" },
								t("store.translations_preview")
							)
						: null,
					editable && !language.builtin && !main
						? el("button", { class: "button danger small", type: "button", onClick: () => void remove(language) }, t("ui.delete"))
						: null
				)
			);
		})
	);
}

function addLanguageForm(project: Project, data: StoreLanguages): HTMLElement {
	const code = input("text", { required: true, maxlength: "16", placeholder: "it", class: "mono", autocomplete: "off" });
	const name = input("text", { required: true, maxlength: "60", placeholder: "Italiano" });
	let named = false;
	name.addEventListener("input", () => (named = name.value.trim() !== ""));
	code.addEventListener("input", () => {
		if (!named) name.value = nativeName(code.value.trim());
	});
	const submit = el("button", { class: "button primary", type: "submit" }, t("store.translations_add"));

	return el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				const wanted = code.value.trim();
				if (data.languages.some((language) => language.code.toLowerCase() === wanted.toLowerCase())) {
					navigate(`/projects/${project.uuid}/store/translations/${encodeURIComponent(wanted)}`);
					return;
				}
				submit.disabled = true;
				try {
					await Api.saveStoreLanguage(project.uuid, wanted, { name: name.value.trim(), enabled: false, strings: {} });
					toast(t("store.translations_added"), "success");
					navigate(`/projects/${project.uuid}/store/translations/${encodeURIComponent(wanted)}`);
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("div", { class: "form-grid" }, field(t("store.translations_code"), code, t("store.translations_code_hint")), field(t("store.translations_name"), name)),
		el("div", {}, submit)
	);
}

export async function storeTranslationsView(uuid: string): Promise<HTMLElement> {
	return storeSection(uuid, async (project, state) => {
		const list = el("div");
		const show = (data: StoreLanguages) => list.replaceChildren(languageRows(project, state, data, show));
		const data = await Api.storeLanguages(uuid);
		show(data);

		return el(
			"div",
			{ class: "stack" },
			el("p", { class: "muted intro" }, t("store.translations_intro")),
			list,
			can(project, Permission.PROJECT_EDIT)
				? el(
						"section",
						{ class: "card stack store-card" },
						el("div", {}, el("h2", {}, t("store.translations_add")), el("p", { class: "muted" }, t("store.translations_add_hint"))),
						addLanguageForm(project, data)
					)
				: null
		);
	});
}

interface TextRow {
	key: string;
	group: string;
	element: HTMLElement;
	field: HTMLInputElement | HTMLTextAreaElement;
	search: string;
	valid: () => boolean;
}

function textRow(entry: StringEntry, value: string, fallback: string, showEnglish: boolean, editable: boolean, onEdit: () => void): TextRow {
	const long = fallback.length > 70 || entry.english.length > 70 || value.length > 70;
	const control = long ? el("textarea", { rows: "3", maxlength: "1000" }) : input("text", { maxlength: "1000" });
	control.value = value;
	control.placeholder = fallback;
	control.disabled = !editable;
	control.setAttribute("aria-label", entry.english);

	const required = placeholdersOf(entry.english);
	const warning = el("span", { class: "field-error" }, t("store.translations_placeholders", { list: required.map((name) => `{${name}}`).join(", ") }));
	const valid = () => {
		const text = control.value.trim();
		return text === "" || placeholdersOf(text).join() === required.join();
	};
	const check = () => {
		const ok = valid();
		warning.hidden = ok;
		control.classList.toggle("invalid", !ok);
	};
	control.addEventListener("input", () => {
		check();
		onEdit();
	});
	check();

	const element = el(
		"div",
		{ class: "translation-row" },
		el("div", { class: "translation-source" }, showEnglish ? el("span", {}, entry.english) : null, el("span", { class: "muted mono" }, entry.key)),
		el("div", { class: "translation-target" }, control, warning)
	);
	return {
		key: entry.key,
		group: entry.group,
		element,
		field: control,
		search: `${entry.key} ${entry.english} ${fallback}`.toLocaleLowerCase(),
		valid,
	};
}

interface ContentField {
	key: string;
	label: string;
	reference: string;
	max: number;
	rows: number;
}

function contentFields(config: StoreConfig): ContentField[] {
	const fields: ContentField[] = [
		{ key: "tagline", label: t("store.tagline"), reference: config.tagline ?? "", max: 200, rows: 1 },
		{ key: "description", label: t("store.description"), reference: config.description ?? "", max: 500, rows: 3 },
		{ key: "announcement", label: t("store.announcement"), reference: config.announcement ?? "", max: 200, rows: 1 },
		{ key: "hero.title", label: t("store.hero_title"), reference: config.hero.title ?? config.name, max: 120, rows: 1 },
		{ key: "hero.subtitle", label: t("store.hero_subtitle"), reference: config.hero.subtitle ?? "", max: 300, rows: 3 },
		{ key: "hero.cta_label", label: t("store.cta_label"), reference: config.hero.cta_label ?? "", max: 40, rows: 1 },
		...(config.location.enabled
			? [
					{ key: "location.name", label: t("store.location_name"), reference: config.location.name ?? "", max: 120, rows: 1 },
					{ key: "location.note", label: t("store.location_note"), reference: config.location.note ?? "", max: 300, rows: 1 },
				]
			: []),
		...config.shipping.map((option) => ({
			key: `shipping.${option.id}`,
			label: t("store.translations_shipping_name"),
			reference: option.name,
			max: 120,
			rows: 1,
		})),
		{ key: "footer_text", label: t("store.footer_text"), reference: config.footer_text ?? "", max: 1000, rows: 3 },
		...config.pages.flatMap((page) => [
			{ key: `page.${page.slug}.title`, label: t("store.translations_page_title"), reference: page.title, max: 120, rows: 1 },
			{ key: `page.${page.slug}.content`, label: t("store.translations_page_content", { page: page.title }), reference: page.content, max: 50000, rows: 12 },
		]),
	];
	return fields;
}

function contentRow(entry: ContentField, value: string, editable: boolean, onEdit: () => void): TextRow {
	const control = entry.rows > 1 ? el("textarea", { rows: String(entry.rows), maxlength: String(entry.max) }) : input("text", { maxlength: String(entry.max) });
	control.value = value;
	control.placeholder = entry.rows > 3 ? t("store.translation_fallback") : entry.reference;
	control.disabled = !editable;
	control.setAttribute("aria-label", entry.label);
	control.addEventListener("input", onEdit);
	const reference =
		entry.rows > 3
			? el("details", {}, el("summary", {}, t("store.translations_show_original")), el("pre", { class: "translation-original" }, entry.reference))
			: el("span", {}, entry.reference);
	const element = el(
		"div",
		{ class: "translation-row" },
		el("div", { class: "translation-source" }, el("strong", {}, entry.label), reference),
		el("div", { class: "translation-target" }, control)
	);
	return {
		key: entry.key,
		group: "content",
		element,
		field: control,
		search: `${entry.label} ${entry.reference}`.toLocaleLowerCase(),
		valid: () => true,
	};
}

export async function storeTranslationView(uuid: string, code: string): Promise<HTMLElement> {
	return storeSection(uuid, async (project, state) => {
		const data = await Api.storeLanguages(uuid);
		const language = data.languages.find((entry) => entry.code === code);
		const back = `/projects/${project.uuid}/store/translations`;
		if (!language) {
			navigate(back, true);
			return el("div");
		}

		const editable = can(project, Permission.PROJECT_EDIT);
		const fallback = fallbackOf(data, language);
		const fallbackName = data.languages.find((entry) => entry.code === fallback)?.name ?? fallback;
		let dirty = false;
		const status = el("span", { class: "muted" });
		const markDirty = () => {
			dirty = true;
			status.textContent = t("store.translations_unsaved");
		};

		const rows = storefrontStrings(language.code).map((entry) =>
			textRow(entry, language.strings[entry.key] ?? "", builtinText(fallback, entry.key), language.code !== "en", editable, markDirty)
		);
		const translatesContent = language.code !== data.default;
		const contentRows = translatesContent
			? contentFields(state.config)
					.filter((entry) => entry.reference.trim() !== "" || language.content[entry.key] !== undefined)
					.map((entry) => contentRow(entry, language.content[entry.key] ?? "", editable, markDirty))
			: [];

		const name = input("text", { required: true, maxlength: "60", value: language.name, disabled: !editable });
		name.addEventListener("input", markDirty);
		const search = input("search", { placeholder: t("store.translations_search"), maxlength: "100" });
		search.setAttribute("aria-label", t("store.translations_search"));
		const filter = select(
			[
				{ value: "all", label: t("store.translations_filter_all") },
				{ value: "default", label: t("store.translations_filter_default") },
				{ value: "custom", label: t("store.translations_filter_custom") },
			],
			"all"
		);
		filter.setAttribute("aria-label", t("store.translations_filter"));

		const contentSection = el(
			"section",
			{ class: "card stack store-card" },
			el("div", {}, el("h2", {}, t("store.translations_group_content")), el("p", { class: "muted" }, t("store.translations_content_hint"))),
			...contentRows.map((row) => row.element)
		);
		const sections = [
			...(contentRows.length ? [{ section: contentSection, members: contentRows }] : []),
			...GROUPS.map((group) => {
				const members = rows.filter((row) => row.group === group.id);
				const section = el("section", { class: "card stack store-card" }, el("h2", {}, t(group.label)), ...members.map((row) => row.element));
				return { section, members };
			}),
		];
		const nothing = emptyState(t("ui.no_matches"));

		const applyFilter = () => {
			const query = search.value.trim().toLocaleLowerCase();
			let visible = 0;
			for (const { section, members } of sections) {
				let shown = 0;
				for (const row of members) {
					const filled = row.field.value.trim() !== "";
					const match =
						(query === "" || row.search.includes(query) || row.field.value.toLocaleLowerCase().includes(query)) &&
						(filter.value === "all" || (filter.value === "custom" ? filled : !filled));
					row.element.hidden = !match;
					if (match) shown++;
				}
				section.hidden = shown === 0;
				visible += shown;
			}
			nothing.hidden = visible > 0;
		};
		search.addEventListener("input", applyFilter);
		filter.addEventListener("change", applyFilter);
		applyFilter();

		const leave = (event: BeforeUnloadEvent) => {
			if (dirty) event.preventDefault();
		};
		window.addEventListener("beforeunload", leave);
		onLeave(() => window.removeEventListener("beforeunload", leave));

		const submit = el("button", { class: "button primary", type: "submit", disabled: !editable }, t("ui.save"));
		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const broken = rows.find((row) => !row.valid());
					if (broken) {
						toast(t("store.translations_invalid"), "error");
						search.value = "";
						filter.value = "all";
						applyFilter();
						broken.field.focus();
						return;
					}
					const strings: Record<string, string> = {};
					for (const row of rows) {
						const text = row.field.value.trim();
						if (text !== "") strings[row.key] = text;
					}
					const content: Record<string, string> = {};
					for (const row of contentRows) {
						const text = row.field.value.trim();
						if (text !== "") content[row.key] = text;
					}
					submit.disabled = true;
					try {
						await Api.saveStoreLanguage(project.uuid, language.code, {
							name: language.builtin ? null : name.value.trim(),
							enabled: language.enabled,
							strings,
							...(translatesContent ? { content } : {}),
						});
						dirty = false;
						status.textContent = "";
						toast(t("store.translations_saved"), "success");
					} catch (error) {
						reportError(error);
					} finally {
						submit.disabled = !editable;
					}
				},
			},
			el(
				"section",
				{ class: "card stack store-card" },
				el(
					"div",
					{},
					el("h2", {}, language.name, " ", el("span", { class: "muted mono" }, language.code)),
					el("p", { class: "muted" }, language.builtin ? t("store.translations_builtin_hint") : t("store.translations_custom_hint", { language: fallbackName }))
				),
				language.builtin ? null : field(t("store.translations_name"), name),
				el("div", { class: "toolbar translation-tools" }, search, filter)
			),
			...sections.map((entry) => entry.section),
			nothing,
			el("div", { class: "translation-save" }, status, submit)
		);

		return el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "toolbar" },
				el("a", { class: "button ghost small", href: back }, t("store.translations_back")),
				storeLink(state, language.code) && (language.enabled || language.code === data.default)
					? el("a", { class: "button ghost small", href: storeLink(state, language.code)!, target: "_blank", rel: "noopener" }, t("store.translations_preview"))
					: null
			),
			form
		);
	});
}
