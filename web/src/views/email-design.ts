import { Api, type Project } from "../api";
import { el, field, input, select } from "../dom";
import { t, type UiKey } from "../i18n";
import { reportError, toast } from "../ui";
import { onLeave } from "../router";
import { can, Permission } from "../access";
import { ACCENT_PRESETS } from "../../../server/colors";
import {
	CUSTOMER_EMAIL_KINDS,
	EMAIL_FIELDS,
	EMAIL_PLACEHOLDERS,
	EMAIL_TEXT_FIELDS,
	EMAIL_TEXT_LIMITS,
	type CustomerEmailKind,
	type EmailDesign,
	type EmailTextField,
	type EmailTexts,
} from "../../../server/email-design";

const PREVIEW_DELAY_MS = 900;

function text(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function toggle(label: string, checked: boolean): { input: HTMLInputElement; element: HTMLElement } {
	const box = input("checkbox");
	box.checked = checked;
	return { input: box, element: el("label", { class: "switch" }, box, el("span", {}, label)) };
}

export async function emailDesignSection(uuid: string, project: Project): Promise<HTMLElement> {
	const state = await Api.emailDesign(uuid);
	const editable = can(project, Permission.PROJECT_EDIT) && state.white_label;
	const templates: Record<CustomerEmailKind, EmailTexts> = structuredClone(state.design.templates);
	let kind: CustomerEmailKind = "invoice";

	const useAccent = toggle(t("emails.own_accent"), state.design.accent !== null);
	const accent = input("color", { value: state.design.accent ?? project.accent_color ?? "#4f46e5" });
	const swatches = el(
		"div",
		{ class: "swatches" },
		...ACCENT_PRESETS.map((preset) => {
			const swatch = el("button", {
				class: "swatch",
				type: "button",
				title: preset.label,
				onClick: () => {
					accent.value = preset.value;
					useAccent.input.checked = true;
					changed();
				},
			});
			swatch.style.background = preset.value;
			return swatch;
		})
	);
	const showLogo = toggle(t("emails.show_logo"), state.design.show_logo);
	const showAddress = toggle(t("emails.show_address"), state.design.show_address);
	const signature = el("textarea", { rows: "3", maxlength: String(EMAIL_TEXT_LIMITS.signature), placeholder: t("emails.signature_placeholder") });
	signature.value = state.design.signature ?? "";
	const footer = el("textarea", { rows: "2", maxlength: String(EMAIL_TEXT_LIMITS.footer_text), placeholder: t("emails.footer_placeholder") });
	footer.value = state.design.footer_text ?? "";

	const picker = select(
		CUSTOMER_EMAIL_KINDS.map((value) => ({ value, label: t(`email_kind.${value}` as UiKey) })),
		kind
	);
	const inputs: Record<EmailTextField, HTMLInputElement | HTMLTextAreaElement> = {
		subject: input("text", { maxlength: String(EMAIL_TEXT_LIMITS.subject) }),
		heading: input("text", { maxlength: String(EMAIL_TEXT_LIMITS.heading) }),
		intro: el("textarea", { rows: "4", maxlength: String(EMAIL_TEXT_LIMITS.intro) }),
		button: input("text", { maxlength: String(EMAIL_TEXT_LIMITS.button) }),
		closing: el("textarea", { rows: "2", maxlength: String(EMAIL_TEXT_LIMITS.closing) }),
	};
	const labels: Record<EmailTextField, UiKey> = {
		subject: "emails.subject",
		heading: "emails.heading",
		intro: "emails.message",
		button: "emails.button",
		closing: "emails.closing",
	};
	const fields: Record<EmailTextField, HTMLElement> = {
		subject: field(t(labels.subject), inputs.subject),
		heading: field(t(labels.heading), inputs.heading),
		intro: field(t(labels.intro), inputs.intro),
		button: field(t(labels.button), inputs.button),
		closing: field(t(labels.closing), inputs.closing),
	};
	let focused: HTMLInputElement | HTMLTextAreaElement = inputs.intro;
	for (const name of EMAIL_TEXT_FIELDS) inputs[name].addEventListener("focus", () => (focused = inputs[name]));

	const chips = el("div", { class: "placeholder-chips" });
	const storeFields = () => {
		for (const name of EMAIL_TEXT_FIELDS) templates[kind][name] = EMAIL_FIELDS[kind].includes(name) ? text(inputs[name].value) : null;
	};
	const showKind = () => {
		for (const name of EMAIL_TEXT_FIELDS) {
			const available = EMAIL_FIELDS[kind].includes(name);
			fields[name].hidden = !available;
			inputs[name].value = templates[kind][name] ?? "";
			inputs[name].placeholder = state.defaults[kind][name] ?? t("emails.nothing_by_default");
		}
		chips.replaceChildren(
			el("span", { class: "field-hint" }, t("emails.placeholders")),
			...EMAIL_PLACEHOLDERS[kind].map((name) =>
				el(
					"button",
					{
						class: "chip",
						type: "button",
						title: t("emails.insert"),
						onClick: () => {
							const target = focused;
							const start = target.selectionStart ?? target.value.length;
							const end = target.selectionEnd ?? start;
							target.value = `${target.value.slice(0, start)}{${name}}${target.value.slice(end)}`;
							target.focus();
							target.selectionStart = target.selectionEnd = start + name.length + 2;
							changed();
						},
					},
					`{${name}}`
				)
			)
		);
	};
	picker.addEventListener("change", () => {
		storeFields();
		kind = picker.value as CustomerEmailKind;
		showKind();
		void refresh();
	});
	showKind();

	const read = (): EmailDesign => {
		storeFields();
		return {
			accent: useAccent.input.checked ? accent.value.toLowerCase() : null,
			show_logo: showLogo.input.checked,
			show_address: showAddress.input.checked,
			signature: text(signature.value),
			footer_text: text(footer.value),
			templates: structuredClone(templates),
		};
	};

	const subjectLine = el("p", { class: "email-preview-subject" });
	const frame = el("iframe", { class: "email-preview-frame", title: t("design.preview") }) as HTMLIFrameElement;
	frame.setAttribute("sandbox", "allow-same-origin");
	frame.addEventListener("load", () => {
		const height = frame.contentDocument?.documentElement.scrollHeight;
		if (height) frame.style.height = `${height}px`;
	});
	const status = el("span", { class: "muted" });
	let timer: ReturnType<typeof setTimeout> | undefined;
	let round = 0;

	const refresh = async () => {
		const current = ++round;
		status.textContent = t("design.preview_loading");
		try {
			const preview = await Api.previewEmailDesign(uuid, read(), kind);
			if (current !== round) return;
			subjectLine.replaceChildren(el("span", { class: "muted" }, `${t("emails.subject")}: `), preview.subject);
			frame.srcdoc = preview.html;
			status.textContent = "";
		} catch (error) {
			if (current !== round) return;
			status.textContent = "";
			reportError(error);
		}
	};
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void refresh(), PREVIEW_DELAY_MS);
	};
	onLeave(() => clearTimeout(timer));

	const reset = el(
		"button",
		{
			class: "button ghost small",
			type: "button",
			onClick: () => {
				for (const name of EMAIL_TEXT_FIELDS) inputs[name].value = "";
				changed();
			},
		},
		t("emails.reset")
	);

	const save = el("button", { class: "button primary", type: "submit", disabled: !editable }, t("emails.save"));
	const form = el(
		"form",
		{
			class: "stack design-form",
			onSubmit: async (event) => {
				event.preventDefault();
				if (!editable) return;
				save.disabled = true;
				try {
					await Api.saveEmailDesign(uuid, read());
					toast(t("emails.saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		el("h3", {}, t("emails.look")),
		el(
			"div",
			{ class: "field" },
			el("span", { class: "field-label" }, t("design.accent")),
			useAccent.element,
			el("div", { class: "accent-row" }, accent, swatches),
			el("span", { class: "field-hint" }, t("emails.accent_hint"))
		),
		el("div", { class: "line-actions" }, showLogo.element, showAddress.element),
		field(t("emails.signature"), signature, t("emails.signature_hint")),
		field(t("emails.footer"), footer, t("emails.footer_hint")),
		el("h3", {}, t("emails.texts")),
		el("p", { class: "muted" }, t("emails.texts_hint")),
		el("div", { class: "toolbar" }, field(t("emails.which"), picker), reset),
		fields.subject,
		fields.heading,
		fields.intro,
		chips,
		fields.button,
		fields.closing,
		el("div", { class: "form-actions" }, state.white_label ? null : el("span", { class: "muted" }, t("design.white_label_needed")), save)
	);
	form.addEventListener("input", changed);
	form.addEventListener("change", (event) => {
		if (event.target !== picker) changed();
	});

	void refresh();

	return el(
		"div",
		{ class: "stack" },
		state.white_label
			? el("p", { class: "muted" }, t("emails.intro_text"))
			: el(
					"div",
					{ class: "notice-box" },
					el("p", {}, t("emails.locked")),
					el("a", { class: "button ghost small", href: `/projects/${uuid}/license` }, t("design.get_white_label"))
				),
		el(
			"div",
			{ class: "design-layout" },
			form,
			el(
				"div",
				{ class: "design-preview" },
				el("div", { class: "design-preview-bar" }, status),
				subjectLine,
				el("div", { class: "email-preview" }, frame),
				el("p", { class: "field-hint" }, t("emails.preview_hint"))
			)
		)
	);
}
