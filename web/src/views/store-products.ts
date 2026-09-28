import { Api, ApiError, type Project, type StoreAttribute, type StoreCategory, type StoreImage, type StoreProductDetails, type StoreState } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { t } from "../i18n";
import { navigate } from "../router";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { can, Permission } from "../access";
import { dayStartFromDateInput, formatMoney, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { pagination, PAGE_SIZE } from "../pagination";
import { convertToWebp, ImageTooLargeError, ImageUnreadableError, toBase64 } from "../image";
import { renderMarkdown } from "../../../server/markdown";
import { slugify } from "../../../server/store/config";
import { MAX_STORE_IMAGE_BYTES, storeSection } from "./store";
import { icon } from "../storefront/icons";

const MAX_IMAGES = 12;

function grossOf(net: number, rate: number): number {
	return net + Math.round((net * rate) / 100);
}

function categoryOptions(categories: StoreCategory[], emptyLabel: string, exclude: string | null = null): { value: string; label: string }[] {
	const byParent = new Map<string | null, StoreCategory[]>();
	for (const category of categories) {
		const list = byParent.get(category.parent) ?? [];
		list.push(category);
		byParent.set(category.parent, list);
	}
	const options: { value: string; label: string }[] = [{ value: "", label: emptyLabel }];
	const walk = (parent: string | null, depth: number) => {
		for (const category of byParent.get(parent) ?? []) {
			if (category.uuid === exclude) continue;
			options.push({ value: category.uuid, label: `${"  ".repeat(depth)}${depth ? "↳ " : ""}${category.name}` });
			walk(category.uuid, depth + 1);
		}
	};
	walk(null, 0);
	return options;
}

function statusPill(listed: boolean, published: boolean): HTMLElement {
	if (!listed) return el("span", { class: "pill pill-draft" }, t("store.status_unlisted"));
	return published ? el("span", { class: "pill pill-active" }, t("store.status_published")) : el("span", { class: "pill pill-open" }, t("store.status_hidden"));
}

export async function storeProductsView(uuid: string): Promise<HTMLElement> {
	return storeSection(uuid, async (project) => {
		const categories = await Api.storeCategories(uuid);
		const names = new Map(categories.map((category) => [category.uuid, category.name]));
		const search = input("search", { placeholder: t("items.search_placeholder") });
		const status = select(
			[
				{ value: "", label: t("store.filter_all") },
				{ value: "published", label: t("store.status_published") },
				{ value: "draft", label: t("store.status_hidden") },
				{ value: "unlisted", label: t("store.status_unlisted") },
			],
			""
		);
		const category = select([...categoryOptions(categories, t("store.filter_any_category")), { value: "none", label: t("store.no_category") }], "");
		const body = el("div");
		const controls = pagination(() => load());
		let debounce: ReturnType<typeof setTimeout>;

		const load = async (): Promise<void> => {
			const round = controls.state.begin();
			try {
				const result = await Api.storeProducts(uuid, {
					search: search.value.trim() || undefined,
					status: status.value || undefined,
					category: category.value || undefined,
					limit: PAGE_SIZE,
					offset: controls.state.offset,
				});
				if (!controls.state.current(round)) return;
				if (controls.update(result.total)) return await load();
				if (result.products.length === 0) {
					body.replaceChildren(
						emptyState(
							t("store.products_empty"),
							can(project, Permission.ITEM_CREATE)
								? el("a", { class: "button primary", href: `/projects/${uuid}/items` }, t("store.products_create"))
								: undefined
						)
					);
					return;
				}
				body.replaceChildren(
					table(
						["", t("items.column_item"), t("items.column_price"), t("store.category"), t("store.stock"), t("payments.status"), ""],
						result.products.map((product) =>
							el(
								"tr",
								{},
								el(
									"td",
									{ class: "thumb-cell" },
									product.image ? el("img", { class: "thumb", src: product.image, alt: "" }) : el("span", { class: "thumb thumb-empty" })
								),
								el(
									"td",
									{},
									el("a", { href: `/projects/${uuid}/store/products/${product.uuid}` }, el("strong", {}, product.name)),
									product.sku ? el("div", { class: "muted mono" }, product.sku) : null
								),
								el("td", { class: "mono" }, formatMoney(grossOf(product.unit_price, product.tax_rate), product.currency)),
								el("td", {}, product.category ? (names.get(product.category) ?? "-") : el("span", { class: "muted" }, "-")),
								el(
									"td",
									{},
									product.stock === null
										? el("span", { class: "muted" }, product.delivers_keys && !product.license ? "0" : t("store.stock_untracked"))
										: product.stock === 0
											? el("span", { class: "pill pill-overdue" }, t("items.out_of_stock"))
											: el("span", { class: "mono" }, String(product.stock))
								),
								el(
									"td",
									{},
									statusPill(product.listed, product.published),
									product.featured ? el("span", { class: "pill pill-paid" }, t("store.featured_short")) : null
								),
								el(
									"td",
									{ class: "actions" },
									el(
										"a",
										{ class: "button ghost small", href: `/projects/${uuid}/store/products/${product.uuid}` },
										product.listed ? t("ui.edit") : t("store.list_product")
									)
								)
							)
						)
					)
				);
			} catch (error) {
				if (controls.state.current(round)) {
					controls.fail();
					reportError(error);
				}
			}
		};

		const reload = () => {
			controls.reset();
			void load();
		};
		search.addEventListener("input", () => {
			clearTimeout(debounce);
			debounce = setTimeout(reload, 250);
		});
		status.addEventListener("change", reload);
		category.addEventListener("change", reload);
		void load();

		return el(
			"div",
			{ class: "stack" },
			el("p", { class: "muted intro" }, t("store.products_intro")),
			el(
				"div",
				{ class: "toolbar" },
				search,
				status,
				category,
				can(project, Permission.ITEM_CREATE) ? el("a", { class: "button ghost", href: `/projects/${uuid}/items` }, t("store.manage_items")) : null
			),
			body,
			controls.element
		);
	});
}

function attributeEditor(values: StoreAttribute[], known: { name: string; values: string[] }[]) {
	const nameList = el(
		"datalist",
		{ id: `attribute-names-${Math.random().toString(36).slice(2)}` },
		...known.map((entry) => el("option", { value: entry.name }))
	);
	const host = el("div", { class: "attribute-rows" });
	const rows: { element: HTMLElement; name: HTMLInputElement; value: HTMLInputElement }[] = [];

	const valueList = (name: string) => known.find((entry) => entry.name === name)?.values ?? [];
	const push = (attribute: StoreAttribute) => {
		const name = input("text", { value: attribute.name, maxlength: "100", placeholder: t("store.attribute_name_placeholder"), required: true });
		name.setAttribute("list", nameList.id);
		const valuesId = `attribute-values-${Math.random().toString(36).slice(2)}`;
		const suggestions = el("datalist", { id: valuesId });
		const value = input("text", { value: attribute.value, maxlength: "200", placeholder: t("store.attribute_value_placeholder"), required: true });
		value.setAttribute("list", valuesId);
		const fillSuggestions = () => suggestions.replaceChildren(...valueList(name.value.trim()).map((entry) => el("option", { value: entry })));
		name.addEventListener("change", fillSuggestions);
		fillSuggestions();
		const move = (delta: number) => {
			const index = rows.indexOf(entry);
			const target = index + delta;
			if (target < 0 || target >= rows.length) return;
			rows.splice(index, 1);
			rows.splice(target, 0, entry);
			host.replaceChildren(...rows.map((row) => row.element));
		};
		const entry = {
			name,
			value,
			element: el(
				"div",
				{ class: "attribute-row" },
				name,
				value,
				suggestions,
				el("button", { class: "icon-button", type: "button", title: t("store.move_up"), onClick: () => move(-1) }, "↑"),
				el("button", { class: "icon-button", type: "button", title: t("store.move_down"), onClick: () => move(1) }, "↓"),
				el(
					"button",
					{
						class: "icon-button",
						type: "button",
						title: t("members.remove"),
						onClick: () => {
							rows.splice(rows.indexOf(entry), 1);
							entry.element.remove();
						},
					},
					icon("close", 16)
				)
			),
		};
		rows.push(entry);
		host.append(entry.element);
		return entry;
	};
	values.forEach(push);

	return {
		element: el(
			"div",
			{ class: "stack-tight" },
			nameList,
			host,
			el("button", { class: "button ghost small", type: "button", onClick: () => push({ name: "", value: "" }).name.focus() }, `+ ${t("store.add_attribute")}`)
		),
		read: (): StoreAttribute[] => rows.map((row) => ({ name: row.name.value.trim(), value: row.value.value.trim() })).filter((row) => row.name && row.value),
	};
}

function imageManager(uuid: string, item: string, images: StoreImage[], editable: boolean) {
	let current = [...images];
	const grid = el("div", { class: "image-grid" });
	const picker = input("file");
	picker.accept = "image/*";
	picker.multiple = true;
	picker.hidden = true;
	const upload = el("button", { class: "button ghost", type: "button", disabled: !editable, onClick: () => picker.click() }, `+ ${t("store.add_images")}`);
	const progress = el("span", { class: "muted" });

	const persistOrder = async () => {
		try {
			const saved = await Api.arrangeStoreProductImages(
				uuid,
				item,
				current.map((image) => ({ uuid: image.uuid, alt: image.alt }))
			);
			current = saved.images;
		} catch (error) {
			reportError(error);
		}
	};

	const render = () => {
		upload.disabled = !editable || current.length >= MAX_IMAGES;
		grid.replaceChildren(
			...current.map((image, index) => {
				const alt = input("text", { value: image.alt ?? "", maxlength: "200", placeholder: t("store.image_alt") });
				alt.addEventListener("change", () => {
					image.alt = alt.value.trim() || null;
					void persistOrder();
				});
				const move = (delta: number) => {
					const target = index + delta;
					if (target < 0 || target >= current.length) return;
					current.splice(index, 1);
					current.splice(target, 0, image);
					render();
					void persistOrder();
				};
				return el(
					"figure",
					{ class: `image-tile${index === 0 ? " primary" : ""}` },
					el("img", { src: image.url, alt: image.alt ?? "" }),
					index === 0 ? el("span", { class: "image-badge" }, t("store.main_image")) : null,
					el(
						"figcaption",
						{},
						alt,
						el(
							"div",
							{ class: "line-actions" },
							el("button", { class: "icon-button", type: "button", title: t("store.move_left"), disabled: index === 0, onClick: () => move(-1) }, "←"),
							el(
								"button",
								{ class: "icon-button", type: "button", title: t("store.move_right"), disabled: index === current.length - 1, onClick: () => move(1) },
								"→"
							),
							el(
								"button",
								{
									class: "icon-button danger-text",
									type: "button",
									title: t("members.remove"),
									disabled: !editable,
									onClick: async () => {
										try {
											await Api.removeStoreProductImage(uuid, item, image.uuid);
											current = current.filter((entry) => entry.uuid !== image.uuid);
											render();
										} catch (error) {
											reportError(error);
										}
									},
								},
								icon("close", 16)
							)
						)
					)
				);
			}),
			...(current.length === 0 ? [el("div", { class: "image-empty muted" }, t("store.no_images"))] : [])
		);
	};

	picker.addEventListener("change", async () => {
		const files = [...(picker.files ?? [])].slice(0, MAX_IMAGES - current.length);
		picker.value = "";
		for (const [index, file] of files.entries()) {
			progress.textContent = t("store.uploading", { current: index + 1, total: files.length });
			try {
				const converted = await convertToWebp(file, MAX_STORE_IMAGE_BYTES, 1600);
				current.push(await Api.addStoreProductImage(uuid, item, await toBase64(converted), null));
				render();
			} catch (error) {
				if (error instanceof ImageUnreadableError) toast(t("store.image_unreadable", { name: file.name }), "error");
				else if (error instanceof ImageTooLargeError) toast(t("store.image_too_big"), "error");
				else reportError(error);
			}
		}
		progress.textContent = "";
	});

	render();
	return el(
		"div",
		{ class: "stack-tight" },
		grid,
		el("div", { class: "line-actions" }, upload, progress, picker),
		el("span", { class: "field-hint" }, t("store.images_hint"))
	);
}

function productEditor(
	project: Project,
	state: StoreState,
	details: StoreProductDetails,
	categories: StoreCategory[],
	known: { name: string; values: string[] }[]
): HTMLElement {
	const uuid = project.uuid;
	const item = details.item;
	const editable = can(project, Permission.ITEM_EDIT);
	const currency = item.currency;

	const published = input("checkbox");
	published.checked = details.listed ? details.published : true;
	const featured = input("checkbox");
	featured.checked = details.featured;
	const slug = input("text", { value: details.slug, required: true, maxlength: "80" });
	const category = select(categoryOptions(categories, t("store.no_category")), details.category ?? "");
	const summary = el("textarea", { rows: "2", maxlength: "300", placeholder: t("store.summary_placeholder") });
	summary.value = details.summary ?? "";
	const description = el("textarea", { rows: "14", maxlength: "50000", placeholder: t("store.description_markdown_placeholder") });
	description.value = details.description ?? "";
	const preview = el("div", { class: "markdown-preview sf-prose" });
	const syncPreview = () => (preview.innerHTML = renderMarkdown(description.value) || `<p class="muted">${t("store.preview_empty")}</p>`);
	description.addEventListener("input", syncPreview);
	syncPreview();

	const compare = input("number", {
		min: "0",
		step: "0.01",
		value: details.compare_price === null ? "" : String(toMajorUnits(details.compare_price, currency)),
		placeholder: t("forms.optional"),
	});
	const tracked = input("checkbox");
	tracked.checked = details.stock !== null;
	const stock = input("number", { min: "0", step: "1", value: String(details.stock ?? 0) });
	const backorder = input("checkbox");
	backorder.checked = details.allow_backorder;
	const restock = input("date", { value: details.restock_at ? toDateInput(details.restock_at) : "" });
	const customDelivery = input("checkbox");
	customDelivery.checked = details.delivery_min_days !== null;
	const minDays = input("number", { min: "0", max: "365", step: "1", value: String(details.delivery_min_days ?? state.config.delivery.min_days) });
	const maxDays = input("number", { min: "0", max: "365", step: "1", value: String(details.delivery_max_days ?? state.config.delivery.max_days) });
	const sortOrder = input("number", { step: "1", value: String(details.sort_order) });

	const stockFields = el("div", { class: "form-grid" }, field(t("store.stock_quantity"), stock));
	const deliveryFields = el("div", { class: "form-grid" }, field(t("store.shipping_days_min"), minDays), field(t("store.shipping_days_max"), maxDays));
	const sync = () => {
		stockFields.hidden = !tracked.checked || item.delivers_keys;
		deliveryFields.hidden = !customDelivery.checked;
	};
	tracked.addEventListener("change", sync);
	customDelivery.addEventListener("change", sync);
	sync();

	const attributes = attributeEditor(details.attributes, known);
	const gross = grossOf(item.unit_price, item.tax_rate);

	const submit = el("button", { class: "button primary", type: "submit", disabled: !editable }, details.listed ? t("ui.save") : t("store.list_product"));
	const unlist = details.listed
		? el(
				"button",
				{
					class: "button danger",
					type: "button",
					disabled: !editable,
					onClick: async () => {
						const confirmed = await confirmDialog({
							title: t("store.unlist_title"),
							body: t("store.unlist_body", { item: item.name }),
							confirmLabel: t("store.unlist"),
							destructive: true,
						});
						if (!confirmed) return;
						try {
							await Api.unlistStoreProduct(uuid, item.uuid);
							toast(t("store.unlisted"), "success");
							navigate(`/projects/${uuid}/store/products`);
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("store.unlist")
			)
		: null;

	const storeLink = state.enabled && details.listed && details.published ? `${state.domain_url ?? state.url}/p/${details.slug}` : null;

	const form = el(
		"form",
		{
			class: "product-editor",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await Api.saveStoreProduct(uuid, item.uuid, {
						slug: slug.value.trim(),
						published: published.checked,
						featured: featured.checked,
						category: category.value || null,
						summary: summary.value.trim() || null,
						description: description.value.trim() || null,
						compare_price: compare.value.trim() === "" ? null : toMinorUnits(Number(compare.value) || 0, currency),
						stock: tracked.checked && !item.delivers_keys ? Math.max(0, Math.round(Number(stock.value) || 0)) : null,
						allow_backorder: backorder.checked,
						delivery_min_days: customDelivery.checked ? Number(minDays.value) || 0 : null,
						delivery_max_days: customDelivery.checked ? Number(maxDays.value) || 0 : null,
						restock_at: restock.value ? dayStartFromDateInput(restock.value) : null,
						sort_order: Math.round(Number(sortOrder.value) || 0),
						attributes: attributes.read(),
					});
					toast(t("store.product_saved"), "success");
					if (!details.listed) navigate(`/projects/${uuid}/store/products/${item.uuid}`, true);
				} catch (error) {
					reportError(error);
				} finally {
					submit.disabled = !editable;
				}
			},
		},
		el(
			"div",
			{ class: "product-editor-main stack" },
			el(
				"section",
				{ class: "card stack" },
				el("h2", {}, t("store.product_content")),
				field(t("store.summary"), summary, t("store.summary_hint")),
				el(
					"div",
					{ class: "field" },
					el("span", { class: "field-label" }, t("store.product_description")),
					el("div", { class: "markdown-split" }, description, preview),
					el("span", { class: "field-hint" }, t("store.markdown_hint"))
				)
			),
			el(
				"section",
				{ class: "card stack" },
				el("h2", {}, t("store.images")),
				details.listed ? imageManager(uuid, item.uuid, details.images, editable) : el("p", { class: "muted" }, t("store.images_after_listing"))
			),
			el("section", { class: "card stack" }, el("h2", {}, t("store.attributes")), el("p", { class: "muted" }, t("store.attributes_hint")), attributes.element)
		),
		el(
			"aside",
			{ class: "product-editor-side stack" },
			el(
				"section",
				{ class: "card stack" },
				el("h2", {}, t("store.visibility")),
				el("label", { class: "switch" }, published, el("span", {}, t("store.published"))),
				el("label", { class: "switch" }, featured, el("span", {}, t("store.featured"))),
				field(t("store.category"), category),
				field(t("store.product_slug"), slug),
				field(t("store.sort_order"), sortOrder, t("store.sort_order_hint")),
				storeLink ? el("a", { href: storeLink, target: "_blank", rel: "noopener" }, t("store.view_in_store")) : null
			),
			el(
				"section",
				{ class: "card stack" },
				el("h2", {}, t("store.pricing")),
				el("div", { class: "price-preview" }, el("span", { class: "muted" }, t("store.price_customers_see")), el("strong", {}, formatMoney(gross, currency))),
				el("p", { class: "muted" }, t("store.price_from_item"), " ", el("a", { href: `/projects/${uuid}/items` }, t("nav.items"))),
				field(t("store.compare_price", { currency }), compare, t("store.compare_price_hint"))
			),
			el(
				"section",
				{ class: "card stack" },
				el("h2", {}, t("store.inventory")),
				item.license
					? el("p", { class: "muted" }, t("store.inventory_license"))
					: item.delivers_keys
						? el("p", { class: "muted" }, t("store.inventory_keys", { count: item.keys_available ?? 0 }))
						: el("label", { class: "switch" }, tracked, el("span", {}, t("store.track_stock"))),
				stockFields,
				el("label", { class: "switch" }, backorder, el("span", {}, t("store.allow_backorder"))),
				field(t("store.restock_at"), restock, t("store.restock_hint"))
			),
			el(
				"section",
				{ class: "card stack" },
				el("h2", {}, t("store.delivery_time")),
				el("label", { class: "switch" }, customDelivery, el("span", {}, t("store.custom_delivery"))),
				deliveryFields,
				el("p", { class: "field-hint" }, t("store.delivery_default", { min: state.config.delivery.min_days, max: state.config.delivery.max_days }))
			),
			el("div", { class: "form-actions" }, unlist, submit)
		)
	);

	slug.addEventListener("input", () => (slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, "-")));
	return el(
		"div",
		{ class: "stack" },
		el(
			"div",
			{ class: "page-head" },
			el(
				"div",
				{},
				el("a", { class: "back-link", href: `/projects/${uuid}/store/products` }, t("store.back_to_products")),
				el("h2", {}, item.name),
				el("p", { class: "muted" }, item.sku ?? "")
			),
			statusPill(details.listed, details.published)
		),
		form
	);
}

export async function storeProductView(uuid: string, itemId: string): Promise<HTMLElement> {
	return storeSection(uuid, async (project, state) => {
		const [details, categories, known] = await Promise.all([Api.storeProduct(uuid, itemId), Api.storeCategories(uuid), Api.storeAttributes(uuid)]);
		return productEditor(project, state, details, categories, known);
	});
}

function categoryForm(uuid: string, categories: StoreCategory[], existing: StoreCategory | null, onSaved: () => void) {
	const name = input("text", { value: existing?.name ?? "", required: true, maxlength: "120" });
	const slug = input("text", { value: existing?.slug ?? "", maxlength: "80", placeholder: t("store.slug_auto") });
	let touched = Boolean(existing);
	name.addEventListener("input", () => {
		if (!touched) slug.value = slugify(name.value, 80);
	});
	slug.addEventListener("input", () => (touched = true));
	const parent = select(categoryOptions(categories, t("store.no_parent"), existing?.uuid ?? null), existing?.parent ?? "");
	const description = el("textarea", { rows: "3", maxlength: "2000" });
	description.value = existing?.description ?? "";
	const order = input("number", { step: "1", value: String(existing?.sort_order ?? 0) });
	const submit = el("button", { class: "button primary", type: "submit" }, existing ? t("ui.save") : t("store.add_category"));

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				const body = {
					name: name.value.trim(),
					slug: slug.value.trim() || undefined,
					parent: parent.value || null,
					description: description.value.trim() || null,
					sort_order: Math.round(Number(order.value) || 0),
				};
				try {
					if (existing) await Api.updateStoreCategory(uuid, existing.uuid, body);
					else await Api.createStoreCategory(uuid, body);
					dialog.close();
					toast(t("store.category_saved"), "success");
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("div", { class: "form-grid" }, field(t("store.category_name"), name), field(t("store.product_slug"), slug)),
		el("div", { class: "form-grid" }, field(t("store.parent_category"), parent), field(t("store.sort_order"), order)),
		field(t("store.category_description"), description, t("forms.optional")),
		el("div", { class: "dialog-actions" }, submit)
	);
	const dialog = modal(existing ? t("store.edit_category") : t("store.new_category"), form);
	name.focus();
}

export async function storeCategoriesView(uuid: string): Promise<HTMLElement> {
	return storeSection(uuid, async (project) => {
		const body = el("div");
		const editable = can(project, Permission.ITEM_EDIT);
		let categories: StoreCategory[] = [];

		const load = async () => {
			categories = await Api.storeCategories(uuid);
			if (categories.length === 0) {
				body.replaceChildren(
					emptyState(
						t("store.categories_empty"),
						editable
							? el(
									"button",
									{ class: "button primary", type: "button", onClick: () => categoryForm(uuid, categories, null, () => void load()) },
									t("store.add_category")
								)
							: undefined
					)
				);
				return;
			}
			const depth = (category: StoreCategory): number => {
				let level = 0;
				for (let parent = category.parent; parent && level < 10; level++) parent = categories.find((entry) => entry.uuid === parent)?.parent ?? null;
				return level;
			};
			const ordered: StoreCategory[] = [];
			const walk = (parent: string | null) => {
				for (const category of categories.filter((entry) => entry.parent === parent)) {
					ordered.push(category);
					walk(category.uuid);
				}
			};
			walk(null);
			body.replaceChildren(
				table(
					[t("store.category_name"), t("store.product_slug"), t("store.tab_products"), t("store.sort_order"), ""],
					ordered.map((category) =>
						el(
							"tr",
							{},
							el(
								"td",
								{},
								el("span", { class: "tree-indent" }, "   ".repeat(depth(category))),
								depth(category) ? el("span", { class: "muted" }, "↳ ") : null,
								el("strong", {}, category.name)
							),
							el("td", { class: "mono muted" }, category.slug),
							el("td", {}, String(category.products)),
							el("td", { class: "mono" }, String(category.sort_order)),
							el(
								"td",
								{ class: "actions" },
								editable
									? el(
											"button",
											{ class: "button ghost small", type: "button", onClick: () => categoryForm(uuid, categories, category, () => void load()) },
											t("ui.edit")
										)
									: null,
								can(project, Permission.ITEM_DELETE)
									? el(
											"button",
											{
												class: "button danger small",
												type: "button",
												onClick: async () => {
													const confirmed = await confirmDialog({
														title: t("store.delete_category_title"),
														body: t("store.delete_category_body", { name: category.name }),
														confirmLabel: t("ui.delete"),
														destructive: true,
													});
													if (!confirmed) return;
													try {
														await Api.deleteStoreCategory(uuid, category.uuid);
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
		};

		try {
			await load();
		} catch (error) {
			if (!(error instanceof ApiError)) throw error;
			reportError(error);
		}

		return el(
			"div",
			{ class: "stack" },
			el("p", { class: "muted intro" }, t("store.categories_intro")),
			editable
				? el(
						"div",
						{ class: "toolbar" },
						el("span"),
						el(
							"button",
							{ class: "button primary", type: "button", onClick: () => categoryForm(uuid, categories, null, () => void load()) },
							t("store.new_category")
						)
					)
				: null,
			body
		);
	});
}
