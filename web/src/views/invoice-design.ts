import { Api, type InvoiceDesign, type Project } from "../api";
import { el, field, input, select } from "../dom";
import { t } from "../i18n";
import { reportError, toast } from "../ui";
import { onLeave } from "../router";
import { can, Permission } from "../access";
import { creditNoteDocumentView, invoiceDocumentView } from "./print";
import { ACCENT_PRESETS } from "../../../server/colors";
import {
	INVOICE_FONTS,
	INVOICE_LAYOUTS,
	INVOICE_LOGO_POSITIONS,
	INVOICE_LOGO_SIZES,
	INVOICE_TEXT_LIMITS,
	type InvoiceFont,
	type InvoiceLayout,
	type InvoiceLogoPosition,
	type InvoiceLogoSize,
} from "../../../server/invoice-design";

type PreviewKind = "invoice" | "receipt" | "credit_note";

const PREVIEW_DELAY_MS = 1200;

function text(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function area(value: string | null, max: number, placeholder = ""): HTMLTextAreaElement {
	const node = el("textarea", { rows: "2", maxlength: String(max), placeholder });
	node.value = value ?? "";
	return node;
}

function checkbox(label: string, checked: boolean): { input: HTMLInputElement; element: HTMLElement } {
	const box = input("checkbox");
	box.checked = checked;
	return { input: box, element: el("label", { class: "switch" }, box, el("span", {}, label)) };
}

export async function invoiceDesignSection(uuid: string, project: Project): Promise<HTMLElement> {
	const state = await Api.invoiceDesign(uuid);
	const design = state.design;
	const editable = can(project, Permission.PROJECT_EDIT) && state.white_label;

	const layout = select(
		INVOICE_LAYOUTS.map((value) => ({ value, label: t(`design.layout_${value}`) })),
		design.layout
	);
	const font = select(
		INVOICE_FONTS.map((value) => ({ value, label: t(`design.font_${value}`) })),
		design.font
	);
	const logoSize = select(
		INVOICE_LOGO_SIZES.map((value) => ({ value, label: t(`design.logo_${value}`) })),
		design.logo_size
	);
	const logoPosition = select(
		INVOICE_LOGO_POSITIONS.map((value) => ({ value, label: t(`design.position_${value}`) })),
		design.logo_position
	);

	const useAccent = checkbox(t("design.use_accent"), design.accent !== null);
	const accent = input("color", { value: design.accent ?? project.accent_color ?? "#4f46e5" });
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

	const header = input("text", {
		value: design.header_text ?? "",
		maxlength: String(INVOICE_TEXT_LIMITS.header_text),
		placeholder: t("design.header_placeholder"),
	});
	const footer = area(design.footer_text, INVOICE_TEXT_LIMITS.footer_text, t("design.footer_placeholder"));
	const invoiceNote = area(design.notes.invoice, INVOICE_TEXT_LIMITS.note, t("design.note_invoice_placeholder"));
	const receiptNote = area(design.notes.receipt, INVOICE_TEXT_LIMITS.note, t("design.note_receipt_placeholder"));
	const creditNote = area(design.notes.credit_note, INVOICE_TEXT_LIMITS.note, t("design.note_credit_placeholder"));
	const showEmail = checkbox(t("design.show_email"), design.show.email);
	const showPhone = checkbox(t("design.show_phone"), design.show.phone);
	const showWebsite = checkbox(t("design.show_website"), design.show.website);

	const read = (): InvoiceDesign => ({
		layout: layout.value as InvoiceLayout,
		font: font.value as InvoiceFont,
		accent: useAccent.input.checked ? accent.value.toLowerCase() : null,
		logo_size: logoSize.value as InvoiceLogoSize,
		logo_position: logoPosition.value as InvoiceLogoPosition,
		header_text: text(header.value),
		footer_text: text(footer.value),
		notes: { invoice: text(invoiceNote.value), credit_note: text(creditNote.value), receipt: text(receiptNote.value) },
		show: { email: showEmail.input.checked, phone: showPhone.input.checked, website: showWebsite.input.checked },
	});

	const sheet = el("div", { class: "design-preview-sheet" });
	const viewport = el("div", { class: "design-preview-viewport" }, sheet);
	const previewStatus = el("span", { class: "muted" });
	let previewKind: PreviewKind = "invoice";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let round = 0;

	const fit = () => {
		const scale = viewport.clientWidth / sheet.offsetWidth || 0.5;
		sheet.style.transform = `scale(${scale})`;
		viewport.style.height = `${sheet.offsetHeight * scale}px`;
	};
	const resize = new ResizeObserver(fit);
	resize.observe(viewport);

	const refresh = async () => {
		const current = ++round;
		previewStatus.textContent = t("design.preview_loading");
		try {
			const preview = await Api.previewInvoiceDocument(uuid, read(), previewKind);
			if (current !== round) return;
			const actions = el("div");
			const rendered = preview.kind === "credit_note" ? creditNoteDocumentView(preview.document, actions) : invoiceDocumentView(preview.document, actions);
			sheet.replaceChildren(rendered.querySelector(".document") ?? rendered);
			document.title = t("design.title");
			previewStatus.textContent = "";
			requestAnimationFrame(fit);
		} catch (error) {
			if (current !== round) return;
			previewStatus.textContent = "";
			reportError(error);
		}
	};
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void refresh(), PREVIEW_DELAY_MS);
	};
	onLeave(() => {
		clearTimeout(timer);
		resize.disconnect();
	});

	const openPdf = el("button", { class: "button ghost small", type: "button" }, t("design.open_pdf"));
	openPdf.addEventListener("click", async () => {
		const opened = window.open("", "_blank");
		openPdf.disabled = true;
		try {
			const blob = await Api.previewInvoiceDesign(uuid, read(), previewKind);
			const url = URL.createObjectURL(blob);
			if (opened) opened.location.href = url;
			else window.location.href = url;
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (error) {
			opened?.close();
			reportError(error);
		} finally {
			openPdf.disabled = false;
		}
	});

	const kinds = el("div", { class: "segmented" });
	const kindButtons = (["invoice", "receipt", "credit_note"] as PreviewKind[]).map((kind) => {
		const button = el("button", { class: `segment${kind === previewKind ? " active" : ""}`, type: "button" }, t(`design.preview_${kind}`));
		button.addEventListener("click", () => {
			previewKind = kind;
			kindButtons.forEach((entry, index) => entry.classList.toggle("active", ["invoice", "receipt", "credit_note"][index] === kind));
			void refresh();
		});
		kinds.append(button);
		return button;
	});

	const save = el("button", { class: "button primary", type: "submit", disabled: !editable }, t("design.save"));
	const form = el(
		"form",
		{
			class: "stack design-form",
			onSubmit: async (event) => {
				event.preventDefault();
				if (!editable) return;
				save.disabled = true;
				try {
					await Api.saveInvoiceDesign(uuid, read());
					toast(t("design.saved"), "success");
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		el("div", { class: "form-grid" }, field(t("design.layout"), layout), field(t("design.font"), font, t("design.font_hint"))),
		el(
			"div",
			{ class: "field" },
			el("span", { class: "field-label" }, t("design.accent")),
			useAccent.element,
			el("div", { class: "accent-row" }, accent, swatches),
			el("span", { class: "field-hint" }, t("design.accent_hint"))
		),
		el("div", { class: "form-grid" }, field(t("design.logo_size"), logoSize), field(t("design.logo_position"), logoPosition, t("design.logo_hint"))),
		field(t("design.header_text"), header, t("design.header_hint")),
		field(t("design.footer_text"), footer, t("design.footer_hint")),
		el("h3", {}, t("design.notes")),
		el("p", { class: "muted" }, t("design.notes_hint")),
		field(t("design.note_invoice"), invoiceNote),
		field(t("design.note_receipt"), receiptNote),
		field(t("design.note_credit"), creditNote),
		el("h3", {}, t("design.show")),
		el("p", { class: "muted" }, t("design.show_hint")),
		el("div", { class: "line-actions" }, showEmail.element, showPhone.element, showWebsite.element),
		el("div", { class: "form-actions" }, state.white_label ? null : el("span", { class: "muted" }, t("design.white_label_needed")), save)
	);
	form.addEventListener("input", changed);
	form.addEventListener("change", changed);

	void refresh();

	return el(
		"div",
		{ class: "stack" },
		state.white_label
			? el("p", { class: "muted" }, t("design.intro_text"))
			: el(
					"div",
					{ class: "notice-box" },
					el("p", {}, t("design.locked")),
					el("a", { class: "button ghost small", href: `/projects/${uuid}/license` }, t("design.get_white_label"))
				),
		el(
			"div",
			{ class: "design-layout" },
			form,
			el(
				"div",
				{ class: "design-preview" },
				el("div", { class: "design-preview-bar" }, kinds, previewStatus, openPdf),
				viewport,
				el("p", { class: "field-hint" }, t("design.preview_hint"))
			)
		)
	);
}
