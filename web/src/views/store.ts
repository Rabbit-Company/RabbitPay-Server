import { Api, type Project, type StoreConfig, type StoreState } from "../api";
import { el, field, input, select } from "../dom";
import { t, type UiKey } from "../i18n";
import { currentPath, render } from "../router";
import { confirmDialog, reportError, toast } from "../ui";
import { can, Permission } from "../access";
import { formatDate, formatMoney, toMajorUnits, toMinorUnits } from "../money";
import { convertToWebp, ImageTooLargeError, ImageUnreadableError, toBase64 } from "../image";
import { markdownEditor } from "../markdown-editor";
import { ACCENT_PRESETS } from "../../../server/colors";
import {
	RESERVED_PAGE_SLUGS,
	SOCIAL_NETWORKS,
	STORE_CARD_STYLES,
	STORE_COLUMNS,
	STORE_FONTS,
	STORE_HERO_STYLES,
	STORE_MODES,
	STORE_RADII,
	slugify,
	type StoreDayHours,
	type StorePage,
	type StoreShippingOption,
	type StoreSocial,
} from "../../../server/store/config";
import { SOCIAL_LABELS, icon } from "../storefront/icons";
import { loadProject, projectLayout } from "./project";

const STORE_TABS: { suffix: string; label: UiKey; permission: Permission }[] = [
	{ suffix: "", label: "store.tab_settings", permission: Permission.PROJECT_VIEW },
	{ suffix: "/products", label: "store.tab_products", permission: Permission.ITEM_VIEW },
	{ suffix: "/categories", label: "store.tab_categories", permission: Permission.ITEM_VIEW },
	{ suffix: "/coupons", label: "store.tab_coupons", permission: Permission.ITEM_VIEW },
	{ suffix: "/orders", label: "store.tab_orders", permission: Permission.INVOICE_VIEW },
];

export const MAX_STORE_IMAGE_BYTES = 1_500_000;

export function storeTabs(project: Project, state: StoreState): HTMLElement {
	const path = currentPath();
	const base = `/projects/${project.uuid}/store`;
	return el(
		"div",
		{ class: "store-bar" },
		el(
			"nav",
			{ class: "subtabs" },
			...STORE_TABS.filter((tab) => can(project, tab.permission)).map((tab) => {
				const href = `${base}${tab.suffix}`;
				const active = tab.suffix === "" ? path === href : path.startsWith(href);
				return el(
					"a",
					{ class: `subtab${active ? " active" : ""}`, href },
					t(tab.label),
					tab.suffix === "/orders" && state.stats.to_ship > 0 ? el("span", { class: "count-badge" }, String(state.stats.to_ship)) : null
				);
			})
		),
		state.exists && state.enabled
			? el("a", { class: "button ghost small", href: state.domain_url ?? state.url, target: "_blank", rel: "noopener" }, t("store.open_store"))
			: null
	);
}

function licenseGate(project: Project, state: StoreState): HTMLElement {
	const ended = state.license.until !== null;
	return el(
		"div",
		{ class: "card store-gate" },
		el("div", { class: "store-gate-art" }),
		el("h2", {}, t("store.gate_title")),
		el("p", {}, ended ? t("store.gate_ended", { date: formatDate(state.license.until) }) : t("store.gate_body")),
		el(
			"ul",
			{ class: "store-gate-list" },
			...(["store.gate_point_catalog", "store.gate_point_design", "store.gate_point_checkout", "store.gate_point_gdpr"] as UiKey[]).map((key) =>
				el("li", {}, t(key))
			)
		),
		can(project, Permission.PROJECT_EDIT)
			? el("a", { class: "button primary", href: `/projects/${project.uuid}/license` }, t("store.gate_redeem"))
			: el("p", { class: "muted" }, t("store.gate_ask_owner"))
	);
}

export async function storeSection(uuid: string, render: (project: Project, state: StoreState) => Promise<HTMLElement> | HTMLElement): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const state = await Api.store(uuid);
	if (!state.license.active) return projectLayout(project, el("div", { class: "stack" }, licenseGate(project, state)));
	const content = await render(project, state);
	return projectLayout(project, el("div", { class: "stack" }, storeTabs(project, state), content));
}

function sectionCard(title: string, hint: string | null, ...children: (HTMLElement | null)[]): HTMLElement {
	return el("section", { class: "card stack store-card" }, el("div", {}, el("h2", {}, title), hint ? el("p", { class: "muted" }, hint) : null), ...children);
}

function toggle(label: string, checked: boolean, hint?: string): { element: HTMLElement; input: HTMLInputElement } {
	const box = input("checkbox");
	box.checked = checked;
	return {
		input: box,
		element: el(
			"div",
			{ class: "field" },
			el("label", { class: "switch" }, box, el("span", {}, label)),
			hint ? el("span", { class: "field-hint" }, hint) : null
		),
	};
}

function optionSelect<T extends string | number>(values: readonly T[], selected: T, label: (value: T) => string): HTMLSelectElement {
	return select(
		values.map((value) => ({ value: String(value), label: label(value) })),
		String(selected)
	);
}

function text(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function majorInput(minor: number | null, currency: string, required = false): HTMLInputElement {
	return input("number", { min: "0", step: "0.01", value: minor === null ? "" : String(toMajorUnits(minor, currency)), required });
}

function readMinor(field: HTMLInputElement, currency: string): number | null {
	return field.value.trim() === "" ? null : toMinorUnits(Number(field.value) || 0, currency);
}

function imagePicker(uuid: string, kind: "logo" | "hero", current: string | null, editable: boolean): HTMLElement {
	const picker = input("file");
	picker.accept = "image/*";
	picker.hidden = true;
	const preview = el("div", { class: `store-image-preview store-image-${kind}` });
	const remove = el("button", { class: "button ghost small", type: "button", disabled: !editable }, t("members.remove"));
	const choose = el("button", { class: "button ghost small", type: "button", disabled: !editable, onClick: () => picker.click() });

	const show = (url: string | null) => {
		preview.replaceChildren(url ? el("img", { src: url, alt: "" }) : el("span", { class: "muted" }, t("store.no_image")));
		remove.hidden = url === null;
		choose.textContent = url ? t("store.replace_image") : t("store.upload_image");
	};
	show(current);

	picker.addEventListener("change", async () => {
		const file = picker.files?.[0];
		picker.value = "";
		if (!file) return;
		try {
			const converted = await convertToWebp(file, MAX_STORE_IMAGE_BYTES, kind === "hero" ? 2400 : 800);
			const saved = await Api.uploadStoreImage(uuid, kind, await toBase64(converted));
			show(saved.url);
			toast(t("store.image_uploaded"), "success");
		} catch (error) {
			if (error instanceof ImageUnreadableError) toast(t("license.logo_unreadable"), "error");
			else if (error instanceof ImageTooLargeError) toast(t("store.image_too_big"), "error");
			else reportError(error);
		}
	});
	remove.addEventListener("click", async () => {
		try {
			await Api.removeStoreImage(uuid, kind);
			show(null);
		} catch (error) {
			reportError(error);
		}
	});

	return el("div", { class: "store-image-field" }, preview, el("div", { class: "line-actions" }, choose, remove, picker));
}

function listEditor<T>(
	items: T[],
	row: (item: T, remove: () => void) => { element: HTMLElement; read: () => T },
	create: () => T,
	addLabel: string,
	max: number
) {
	const host = el("div", { class: "store-list" });
	const rows: { element: HTMLElement; read: () => T }[] = [];
	const add = el("button", { class: "button ghost small", type: "button" }, `+ ${addLabel}`);
	const push = (item: T) => {
		const entry = row(item, () => {
			rows.splice(rows.indexOf(entry), 1);
			entry.element.remove();
			add.disabled = rows.length >= max;
		});
		rows.push(entry);
		host.append(entry.element);
		add.disabled = rows.length >= max;
	};
	items.forEach(push);
	add.addEventListener("click", () => push(create()));
	return { element: el("div", { class: "stack-tight" }, host, add), read: () => rows.map((entry) => entry.read()) };
}

function socialRow(social: StoreSocial, remove: () => void) {
	const network = optionSelect(SOCIAL_NETWORKS, social.network, (value) => SOCIAL_LABELS[value]);
	const url = input("text", { value: social.url, placeholder: "https://discord.gg/...", required: true, maxlength: "500" });
	const sync = () =>
		(url.placeholder = network.value === "email" ? "hello@example.com" : network.value === "discord" ? "https://discord.gg/..." : "https://...");
	network.addEventListener("change", sync);
	sync();
	return {
		element: el(
			"div",
			{ class: "store-row" },
			network,
			url,
			el("button", { class: "icon-button", type: "button", title: t("members.remove"), onClick: remove }, icon("close", 16))
		),
		read: () => ({ network: network.value as StoreSocial["network"], url: url.value.trim() }),
	};
}

function shippingRow(currency: string) {
	return (option: StoreShippingOption, remove: () => void) => {
		const name = input("text", { value: option.name, required: true, maxlength: "120", placeholder: t("store.shipping_name_placeholder") });
		const price = majorInput(option.price, currency, true);
		const free = majorInput(option.free_from, currency);
		free.placeholder = t("store.shipping_free_never");
		const min = input("number", { min: "0", max: "365", step: "1", value: String(option.min_days), required: true });
		const max = input("number", { min: "0", max: "365", step: "1", value: String(option.max_days), required: true });
		const pickup = input("checkbox");
		pickup.checked = option.pickup;
		return {
			element: el(
				"div",
				{ class: "store-shipping" },
				field(t("store.shipping_name"), name),
				field(t("store.shipping_price", { currency }), price),
				field(t("store.shipping_free_from", { currency }), free),
				field(t("store.shipping_days_min"), min),
				field(t("store.shipping_days_max"), max),
				el("label", { class: "switch" }, pickup, el("span", {}, t("store.shipping_pickup"))),
				el("button", { class: "button ghost small", type: "button", onClick: remove }, t("members.remove"))
			),
			read: (): StoreShippingOption => ({
				id: option.id,
				name: name.value.trim(),
				price: readMinor(price, currency) ?? 0,
				free_from: readMinor(free, currency),
				min_days: Number(min.value) || 0,
				max_days: Number(max.value) || 0,
				pickup: pickup.checked,
			}),
		};
	};
}

function pageRow(templates: StorePage[]) {
	return (page: StorePage, remove: () => void) => pageEditor(page, templates.find((entry) => entry.slug === page.slug) ?? null, remove);
}

function pageEditor(page: StorePage, template: StorePage | null, remove: () => void) {
	const reserved = (RESERVED_PAGE_SLUGS as readonly string[]).includes(page.slug);
	const title = input("text", { value: page.title, required: true, maxlength: "120" });
	const slug = input("text", { value: page.slug, required: true, maxlength: "60", disabled: reserved });
	title.addEventListener("input", () => {
		if (!reserved && !slug.dataset.touched) slug.value = slugify(title.value, 60);
	});
	slug.addEventListener("input", () => (slug.dataset.touched = "1"));
	const footer = input("checkbox");
	footer.checked = page.footer;
	const editor = markdownEditor({ value: page.content, rows: 12, hint: t("store.markdown_hint") });
	editor.textarea.required = reserved;
	const details = el(
		"details",
		{ class: "store-page" },
		el("summary", {}, el("strong", {}, page.title), reserved ? el("span", { class: "pill pill-open" }, t("store.page_required")) : null),
		el(
			"div",
			{ class: "form-grid" },
			field(t("store.page_title"), title),
			field(t("store.page_slug"), slug, reserved ? t("store.page_slug_reserved") : undefined)
		),
		el("label", { class: "switch" }, footer, el("span", {}, t("store.page_footer"))),
		editor.element,
		template
			? el(
					"div",
					{ class: "line-actions" },
					el(
						"button",
						{
							class: "button ghost small",
							type: "button",
							onClick: async () => {
								const confirmed = await confirmDialog({
									title: t("store.page_template_title"),
									body: t("store.page_template_body"),
									confirmLabel: t("store.page_template"),
								});
								if (!confirmed) return;
								editor.textarea.value = template.content;
								toast(t("store.page_template_done"), "success");
							},
						},
						t("store.page_template")
					),
					el("span", { class: "field-hint" }, t("store.page_template_hint"))
				)
			: null,
		reserved
			? null
			: el("div", { class: "line-actions" }, el("button", { class: "button danger small", type: "button", onClick: remove }, t("store.page_remove")))
	);
	return {
		element: details,
		read: (): StorePage => ({
			slug: reserved ? page.slug : slug.value.trim(),
			title: title.value.trim(),
			content: editor.textarea.value,
			footer: footer.checked,
		}),
	};
}

function hoursEditor(hours: StoreDayHours[]) {
	const names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
	const rows = hours.map((day, index) => {
		const open = input("time", { value: day.open });
		const close = input("time", { value: day.close });
		const closed = input("checkbox");
		closed.checked = day.closed;
		const sync = () => {
			open.disabled = closed.checked;
			close.disabled = closed.checked;
		};
		closed.addEventListener("change", sync);
		sync();
		return {
			element: el(
				"div",
				{ class: "hours-row" },
				el("strong", {}, t(`store.day_${names[index]}`)),
				open,
				el("span", { class: "muted" }, "-"),
				close,
				el("label", { class: "switch" }, closed, el("span", {}, t("store.closed")))
			),
			read: (): StoreDayHours => ({ closed: closed.checked, open: open.value || "09:00", close: close.value || "17:00" }),
		};
	});
	return { element: el("div", { class: "hours-editor" }, ...rows.map((row) => row.element)), read: () => rows.map((row) => row.read()) };
}

function localizedTexts(config: StoreConfig): string {
	return JSON.stringify([
		config.hero.subtitle,
		config.hero.cta_label,
		config.shipping.map((option) => option.name),
		config.pages.map((page) => [page.title, page.content.trim()]),
	]);
}

function settingsForm(project: Project, state: StoreState): HTMLElement {
	const uuid = project.uuid;
	const config = state.config;
	const currency = project.currency;
	const editable = can(project, Permission.PROJECT_EDIT);

	const enabled = toggle(t("store.enabled"), state.exists ? state.enabled : true, t("store.enabled_hint"));
	const name = input("text", { value: config.name, required: true, maxlength: "120" });
	const tagline = input("text", { value: config.tagline ?? "", maxlength: "200", placeholder: t("store.tagline_placeholder") });
	const description = el("textarea", { rows: "2", maxlength: "500", placeholder: t("store.description_placeholder") });
	description.value = config.description ?? "";
	const slug = input("text", { value: state.slug, required: true, maxlength: "60" });
	const domain = input("text", { value: state.domain ?? "", maxlength: "253", placeholder: "shop.example.com" });
	const language = select(
		[
			{ value: "en", label: "English" },
			{ value: "sl", label: "Slovenščina" },
		],
		config.language
	);
	const announcement = input("text", { value: config.announcement ?? "", maxlength: "200", placeholder: t("store.announcement_placeholder") });
	const indexable = toggle(t("store.indexable"), config.indexable, t("store.indexable_hint"));
	const address = el("span", { class: "store-url mono" });
	const syncUrl = () => (address.textContent = `${window.location.origin}/shop/${slug.value || "..."}`);
	slug.addEventListener("input", syncUrl);
	syncUrl();

	const accent = input("color", { value: config.theme.accent });
	const presets = el(
		"div",
		{ class: "swatches" },
		...ACCENT_PRESETS.map((preset) => {
			const swatch = el("button", { class: "swatch", type: "button", title: preset.label, onClick: () => (accent.value = preset.value) });
			swatch.style.background = preset.value;
			return swatch;
		})
	);
	const mode = optionSelect(STORE_MODES, config.theme.mode, (value) => t(`store.mode_${value}`));
	const font = optionSelect(STORE_FONTS, config.theme.font, (value) => t(`store.font_${value}`));
	const radius = optionSelect(STORE_RADII, config.theme.radius, (value) => t(`store.radius_${value}`));
	const cards = optionSelect(STORE_CARD_STYLES, config.theme.card_style, (value) => t(`store.cards_${value}`));
	const columns = optionSelect(STORE_COLUMNS, config.theme.columns, (value) => t("store.columns_value", { count: value }));
	const heroStyle = optionSelect(STORE_HERO_STYLES, config.theme.hero_style, (value) => t(`store.hero_${value}`));
	const heroTitle = input("text", { value: config.hero.title ?? "", maxlength: "120" });
	const heroSubtitle = input("text", { value: config.hero.subtitle ?? "", maxlength: "300" });
	const ctaLabel = input("text", { value: config.hero.cta_label ?? "", maxlength: "40" });
	const ctaLink = input("text", { value: config.hero.cta_link ?? "", maxlength: "500", placeholder: "/shop/.../c/..." });
	const customCss = el("textarea", { rows: "6", maxlength: "20000", class: "mono", placeholder: ".sf-hero h1 { letter-spacing: -0.02em; }" });
	customCss.value = config.theme.custom_css;

	const email = input("email", { value: config.contact.email ?? "", maxlength: "254" });
	const phone = input("tel", { value: config.contact.phone ?? "", maxlength: "40" });
	const socials = listEditor(config.socials, socialRow, (): StoreSocial => ({ network: "discord", url: "" }), t("store.add_social"), 16);

	const location = toggle(t("store.location_enabled"), config.location.enabled, t("store.location_hint"));
	const locationName = input("text", { value: config.location.name ?? "", maxlength: "120", placeholder: t("store.location_name_placeholder") });
	const locationAddress = el("textarea", { rows: "3", maxlength: "500" });
	locationAddress.value = config.location.address ?? "";
	const mapUrl = input("url", { value: config.location.map_url ?? "", maxlength: "1000", placeholder: "https://maps.app.goo.gl/..." });
	const locationNote = input("text", { value: config.location.note ?? "", maxlength: "300", placeholder: t("store.location_note_placeholder") });
	const hours = hoursEditor(config.location.hours);
	const locationFields = el(
		"div",
		{ class: "stack" },
		el("div", { class: "form-grid" }, field(t("store.location_name"), locationName), field(t("store.map_url"), mapUrl)),
		field(t("store.location_address"), locationAddress),
		field(t("store.location_note"), locationNote),
		el("h3", {}, t("store.hours")),
		hours.element
	);
	const syncLocation = () => (locationFields.hidden = !location.input.checked);
	location.input.addEventListener("change", syncLocation);
	syncLocation();

	const shipping = listEditor(
		config.shipping,
		shippingRow(currency),
		() => ({ id: `ship-${Math.random().toString(36).slice(2, 8)}`, name: "", price: 0, free_from: null, min_days: 1, max_days: 3, pickup: false }),
		t("store.add_shipping"),
		10
	);
	const minDays = input("number", { min: "0", max: "365", step: "1", value: String(config.delivery.min_days), required: true });
	const maxDays = input("number", { min: "0", max: "365", step: "1", value: String(config.delivery.max_days), required: true });
	const cutoff = input("number", { min: "0", max: "24", step: "1", value: String(config.delivery.cutoff_hour), required: true });
	const businessDays = toggle(t("store.business_days"), config.delivery.business_days);

	const paymentDays = input("number", { min: "1", max: "60", step: "1", value: String(config.checkout.payment_days), required: true });
	const business = toggle(t("store.business_customers"), config.checkout.business_customers, t("store.business_customers_hint"));
	const notes = toggle(t("store.order_notes"), config.checkout.order_notes);

	const missing = state.templates.filter((template) => !config.pages.some((page) => page.slug === template.slug));
	const pages = listEditor(
		state.exists ? config.pages : [...config.pages, ...missing],
		pageRow(state.templates),
		() => ({ slug: `page-${Math.random().toString(36).slice(2, 6)}`, title: t("store.new_page"), content: "", footer: true }),
		t("store.add_page"),
		12
	);
	const footerText = el("textarea", { rows: "2", maxlength: "1000", placeholder: t("store.footer_placeholder") });
	footerText.value = config.footer_text ?? "";

	const read = (): StoreConfig => ({
		name: name.value.trim(),
		tagline: text(tagline.value),
		description: text(description.value),
		language: language.value as StoreConfig["language"],
		announcement: text(announcement.value),
		hero: { title: text(heroTitle.value), subtitle: text(heroSubtitle.value), cta_label: text(ctaLabel.value), cta_link: text(ctaLink.value) },
		theme: {
			accent: accent.value,
			mode: mode.value as StoreConfig["theme"]["mode"],
			font: font.value as StoreConfig["theme"]["font"],
			radius: radius.value as StoreConfig["theme"]["radius"],
			hero_style: heroStyle.value as StoreConfig["theme"]["hero_style"],
			card_style: cards.value as StoreConfig["theme"]["card_style"],
			columns: Number(columns.value) as StoreConfig["theme"]["columns"],
			custom_css: customCss.value,
		},
		contact: { email: text(email.value), phone: text(phone.value) },
		location: {
			enabled: location.input.checked,
			name: text(locationName.value),
			address: text(locationAddress.value),
			map_url: text(mapUrl.value),
			note: text(locationNote.value),
			hours: hours.read(),
		},
		socials: socials.read(),
		shipping: shipping.read(),
		delivery: {
			min_days: Number(minDays.value) || 0,
			max_days: Number(maxDays.value) || 0,
			business_days: businessDays.input.checked,
			cutoff_hour: Number(cutoff.value) || 0,
		},
		checkout: { payment_days: Number(paymentDays.value) || 1, business_customers: business.input.checked, order_notes: notes.input.checked },
		pages: pages.read(),
		footer_text: text(footerText.value),
		indexable: indexable.input.checked,
	});

	const submit = el("button", { class: "button primary", type: "submit", disabled: !editable }, state.exists ? t("ui.save") : t("store.create"));
	const form = el(
		"form",
		{
			class: "stack store-settings",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const submitted = read();
					const saved = await Api.saveStore(uuid, {
						slug: slug.value.trim(),
						domain: text(domain.value.toLowerCase()),
						enabled: enabled.input.checked,
						config: submitted,
					});
					toast(state.exists ? t("store.saved") : t("store.created"), "success");
					Object.assign(state, saved);
					if (localizedTexts(saved.config) !== localizedTexts(submitted)) void render();
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = !editable;
				}
			},
		},
		sectionCard(
			t("store.general"),
			null,
			enabled.element,
			el("div", { class: "form-grid" }, field(t("store.name"), name), field(t("store.language"), language, t("store.language_hint"))),
			field(t("store.tagline"), tagline),
			field(t("store.description"), description, t("store.description_hint")),
			el("div", { class: "form-grid" }, field(t("store.slug"), slug, t("store.slug_hint")), field(t("store.domain"), domain, t("store.domain_hint"))),
			el("p", { class: "muted" }, t("store.address_label"), " ", address),
			field(t("store.announcement"), announcement),
			indexable.element
		),
		sectionCard(
			t("store.appearance"),
			t("store.appearance_hint"),
			el(
				"div",
				{ class: "form-grid" },
				el("div", { class: "field" }, el("span", { class: "field-label" }, t("store.logo")), imagePicker(uuid, "logo", state.images.logo, editable)),
				el("div", { class: "field" }, el("span", { class: "field-label" }, t("store.hero_image")), imagePicker(uuid, "hero", state.images.hero, editable))
			),
			el("div", { class: "field" }, el("span", { class: "field-label" }, t("store.accent")), el("div", { class: "accent-row" }, accent, presets)),
			el(
				"div",
				{ class: "form-grid three" },
				field(t("store.mode"), mode),
				field(t("store.font"), font, t("store.font_hint")),
				field(t("store.radius"), radius)
			),
			el("div", { class: "form-grid three" }, field(t("store.cards"), cards), field(t("store.columns"), columns), field(t("store.hero_style"), heroStyle)),
			el("div", { class: "form-grid" }, field(t("store.hero_title"), heroTitle), field(t("store.hero_subtitle"), heroSubtitle)),
			el("div", { class: "form-grid" }, field(t("store.cta_label"), ctaLabel), field(t("store.cta_link"), ctaLink, t("store.cta_link_hint"))),
			el("details", { class: "store-advanced" }, el("summary", {}, t("store.custom_css")), field(t("store.custom_css"), customCss, t("store.custom_css_hint")))
		),
		sectionCard(
			t("store.contact"),
			t("store.contact_hint"),
			el("div", { class: "form-grid" }, field(t("customers.email"), email), field(t("customers.phone"), phone)),
			el("h3", {}, t("store.socials")),
			socials.element
		),
		sectionCard(t("store.location"), null, location.element, locationFields),
		sectionCard(
			t("store.shipping"),
			t("store.shipping_hint"),
			shipping.element,
			el("h3", {}, t("store.delivery_defaults")),
			el(
				"div",
				{ class: "form-grid three" },
				field(t("store.shipping_days_min"), minDays),
				field(t("store.shipping_days_max"), maxDays),
				field(t("store.cutoff"), cutoff, t("store.cutoff_hint"))
			),
			businessDays.element
		),
		sectionCard(
			t("store.checkout"),
			t("store.checkout_hint"),
			field(t("store.payment_days"), paymentDays, t("store.payment_days_hint")),
			business.element,
			notes.element
		),
		sectionCard(t("store.pages"), t("store.pages_hint"), pages.element, field(t("store.footer_text"), footerText)),
		el("div", { class: "sticky-actions" }, el("span", { class: "muted" }, t("store.save_hint")), submit)
	);
	return form;
}

function overviewCard(project: Project, state: StoreState): HTMLElement {
	const stat = (value: string, label: string) =>
		el("div", { class: "card stat" }, el("span", { class: "stat-value" }, value), el("span", { class: "stat-label" }, label));
	const license = !state.license.enforced ? t("store.license_unlimited") : t("store.license_until", { date: formatDate(state.license.until) });
	return el(
		"div",
		{ class: "stack" },
		el(
			"div",
			{ class: "card store-hero-card" },
			el(
				"div",
				{},
				el("h2", {}, state.exists ? state.config.name : t("store.setup_title")),
				el("p", { class: "muted" }, state.exists ? (state.enabled ? t("store.live") : t("store.offline")) : t("store.setup_body")),
				state.exists ? el("a", { class: "mono", href: state.domain_url ?? state.url, target: "_blank", rel: "noopener" }, state.domain_url ?? state.url) : null
			),
			el(
				"span",
				{ class: `pill pill-${state.exists && state.enabled ? "active" : "draft"}` },
				state.exists && state.enabled ? t("store.status_live") : t("store.status_offline")
			)
		),
		state.exists
			? el(
					"div",
					{ class: "grid stats" },
					stat(String(state.stats.published), t("store.stat_published")),
					stat(String(state.stats.products), t("store.stat_listed")),
					stat(String(state.stats.orders), t("store.stat_orders")),
					stat(String(state.stats.to_ship), t("store.stat_to_ship"))
				)
			: null,
		el("p", { class: "muted" }, license, " | ", t("store.currency_note", { currency: project.currency, example: formatMoney(1999, project.currency) }))
	);
}

export async function storeSettingsView(uuid: string): Promise<HTMLElement> {
	return storeSection(uuid, (project, state) => el("div", { class: "stack" }, overviewCard(project, state), settingsForm(project, state)));
}
