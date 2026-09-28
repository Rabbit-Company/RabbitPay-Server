import { Api, ApiError, type Project, type StoreCoupon, type StoreCouponInput, type StoreCouponKind } from "../api";
import { el, emptyState, field, input, select, table } from "../dom";
import { t, type UiKey } from "../i18n";
import { can, Permission } from "../access";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { dayStartFromDateInput, formatDate, formatMoney, fromDateInput, toDateInput, toMajorUnits, toMinorUnits } from "../money";
import { storeSection } from "./store";

const KINDS: StoreCouponKind[] = ["percent", "amount", "free_shipping"];

function couponValue(coupon: Pick<StoreCoupon, "kind" | "amount">, currency: string): string {
	if (coupon.kind === "percent") return `${coupon.amount} %`;
	if (coupon.kind === "amount") return formatMoney(coupon.amount, currency);
	return t("store.coupon_kind_free_shipping");
}

function couponState(coupon: StoreCoupon): { label: string; pill: string } {
	const now = Date.now();
	if (!coupon.enabled) return { label: t("store.coupon_disabled"), pill: "canceled" };
	if (coupon.ends_at !== null && now >= coupon.ends_at) return { label: t("store.coupon_expired"), pill: "overdue" };
	if (coupon.max_uses !== null && coupon.uses >= coupon.max_uses) return { label: t("store.coupon_used_up"), pill: "overdue" };
	if (coupon.starts_at !== null && now < coupon.starts_at) return { label: t("store.coupon_scheduled"), pill: "open" };
	return { label: t("store.coupon_active"), pill: "paid" };
}

function randomCode(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function couponForm(project: Project, existing: StoreCoupon | null, onSaved: () => void) {
	const currency = project.currency;
	const timezone = project.timezone;
	const code = input("text", {
		required: true,
		maxlength: "32",
		value: existing?.code ?? "",
		placeholder: "SUMMER25",
		class: "mono",
	});
	code.addEventListener("input", () => (code.value = code.value.toUpperCase()));
	const generate = el("button", { class: "button ghost small", type: "button", onClick: () => (code.value = randomCode()) }, t("store.coupon_generate"));
	const kind = select(
		KINDS.map((value) => ({ value, label: t(`store.coupon_kind_${value}` as UiKey) })),
		existing?.kind ?? "percent"
	);
	const percent = input("number", {
		min: "1",
		max: "100",
		step: "1",
		value: existing?.kind === "percent" ? String(existing.amount) : "10",
	});
	const amount = input("number", {
		min: "0.01",
		step: "0.01",
		value: existing?.kind === "amount" ? String(toMajorUnits(existing.amount, currency)) : "",
	});
	const minimum = input("number", { min: "0", step: "0.01", value: existing?.minimum ? String(toMajorUnits(existing.minimum, currency)) : "" });
	const starts = input("date", { value: existing?.starts_at ? toDateInput(existing.starts_at, timezone) : "" });
	const ends = input("date", { value: existing?.ends_at ? toDateInput(existing.ends_at - 1000, timezone) : "" });
	const maxUses = input("number", { min: "1", step: "1", value: existing?.max_uses ? String(existing.max_uses) : "" });
	const once = input("checkbox");
	once.checked = existing?.once_per_customer ?? false;
	const enabled = input("checkbox");
	enabled.checked = existing?.enabled ?? true;
	const note = input("text", { maxlength: "500", value: existing?.note ?? "" });
	const percentField = field(t("store.coupon_percent"), percent);
	const amountField = field(t("store.coupon_amount", { currency }), amount);
	const sync = () => {
		percentField.hidden = kind.value !== "percent";
		amountField.hidden = kind.value !== "amount";
		percent.required = kind.value === "percent";
		amount.required = kind.value === "amount";
	};
	kind.addEventListener("change", sync);
	sync();
	const submit = el("button", { class: "button primary", type: "submit" }, existing ? t("ui.save") : t("store.new_coupon"));

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				const chosen = kind.value as StoreCouponKind;
				const body: StoreCouponInput = {
					code: code.value.trim().toUpperCase(),
					kind: chosen,
					amount: chosen === "percent" ? Math.round(Number(percent.value)) : chosen === "amount" ? toMinorUnits(Number(amount.value), currency) : 0,
					minimum: minimum.value.trim() === "" || Number(minimum.value) <= 0 ? null : toMinorUnits(Number(minimum.value), currency),
					starts_at: starts.value ? dayStartFromDateInput(starts.value, timezone) : null,
					ends_at: ends.value ? fromDateInput(ends.value, timezone) + 1000 : null,
					max_uses: maxUses.value.trim() === "" ? null : Math.round(Number(maxUses.value)),
					once_per_customer: once.checked,
					enabled: enabled.checked,
					note: note.value.trim() || null,
				};
				try {
					if (existing) await Api.updateStoreCoupon(project.uuid, existing.uuid, body);
					else await Api.createStoreCoupon(project.uuid, body);
					dialog.close();
					toast(t("store.coupon_saved"), "success");
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "form-grid" },
			field(t("store.coupon_code"), el("div", { class: "line-actions" }, code, generate), t("store.coupon_code_hint")),
			field(t("store.coupon_kind"), kind)
		),
		el("div", { class: "form-grid" }, percentField, amountField, field(t("store.coupon_minimum", { currency }), minimum, t("forms.optional"))),
		el(
			"div",
			{ class: "form-grid" },
			field(t("store.coupon_starts"), starts, t("forms.optional")),
			field(t("store.coupon_ends"), ends, t("store.coupon_ends_hint"))
		),
		el(
			"div",
			{ class: "form-grid" },
			field(t("store.coupon_max_uses"), maxUses, t("store.coupon_max_uses_hint")),
			field(t("store.coupon_note"), note, t("store.coupon_note_hint"))
		),
		el("label", { class: "switch" }, once, el("span", {}, t("store.coupon_once"))),
		el("label", { class: "switch" }, enabled, el("span", {}, t("store.coupon_enabled"))),
		el("p", { class: "muted" }, t("store.coupon_rules")),
		el("div", { class: "dialog-actions" }, submit)
	);
	const dialog = modal(existing ? t("store.edit_coupon") : t("store.new_coupon"), form);
	code.focus();
}

export async function storeCouponsView(uuid: string): Promise<HTMLElement> {
	return storeSection(uuid, async (project) => {
		const body = el("div");
		const editable = can(project, Permission.ITEM_EDIT);
		const creatable = can(project, Permission.ITEM_CREATE);
		const deletable = can(project, Permission.ITEM_DELETE);

		const load = async () => {
			const coupons = await Api.storeCoupons(uuid);
			if (coupons.length === 0) {
				body.replaceChildren(
					emptyState(
						t("store.coupons_empty"),
						creatable
							? el("button", { class: "button primary", type: "button", onClick: () => couponForm(project, null, () => void load()) }, t("store.new_coupon"))
							: undefined
					)
				);
				return;
			}
			body.replaceChildren(
				table(
					[
						t("store.coupon_code"),
						t("store.coupon_discount"),
						t("store.coupon_valid"),
						t("store.coupon_uses"),
						t("store.coupon_given"),
						t("store.coupon_status"),
						"",
					],
					coupons.map((coupon) => {
						const state = couponState(coupon);
						const window = [coupon.starts_at ? formatDate(coupon.starts_at) : null, coupon.ends_at ? formatDate(coupon.ends_at - 1000) : null];
						return el(
							"tr",
							{},
							el("td", {}, el("strong", { class: "mono" }, coupon.code), coupon.note ? el("div", { class: "muted" }, coupon.note) : null),
							el(
								"td",
								{},
								couponValue(coupon, project.currency),
								coupon.minimum
									? el("div", { class: "muted" }, t("store.coupon_minimum_short", { amount: formatMoney(coupon.minimum, project.currency) }))
									: null
							),
							el(
								"td",
								{},
								window[0] || window[1]
									? `${window[0] ?? t("store.coupon_now")} ${t("store.coupon_until")} ${window[1] ?? t("store.coupon_no_end")}`
									: el("span", { class: "muted" }, t("store.coupon_always"))
							),
							el(
								"td",
								{ class: "mono" },
								coupon.max_uses === null ? String(coupon.uses) : `${coupon.uses} / ${coupon.max_uses}`,
								coupon.once_per_customer ? el("div", { class: "muted" }, t("store.coupon_once_short")) : null
							),
							el("td", { class: "numeric mono" }, formatMoney(coupon.discount_total, project.currency)),
							el("td", {}, el("span", { class: `pill pill-${state.pill}` }, state.label)),
							el(
								"td",
								{ class: "actions" },
								editable
									? el("button", { class: "button ghost small", type: "button", onClick: () => couponForm(project, coupon, () => void load()) }, t("ui.edit"))
									: null,
								deletable
									? el(
											"button",
											{
												class: "button danger small",
												type: "button",
												onClick: async () => {
													const confirmed = await confirmDialog({
														title: t("store.delete_coupon_title"),
														body: t("store.delete_coupon_body", { code: coupon.code }),
														confirmLabel: t("ui.delete"),
														destructive: true,
													});
													if (!confirmed) return;
													try {
														await Api.deleteStoreCoupon(uuid, coupon.uuid);
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
						);
					})
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
			el("p", { class: "muted intro" }, t("store.coupons_intro")),
			creatable
				? el(
						"div",
						{ class: "toolbar" },
						el("span"),
						el("button", { class: "button primary", type: "button", onClick: () => couponForm(project, null, () => void load()) }, t("store.new_coupon"))
					)
				: null,
			body
		);
	});
}
