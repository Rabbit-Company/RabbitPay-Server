import { Api } from "../api";
import { el, field, input } from "../dom";
import { formatDate } from "../money";
import { confirmDialog, reportError, toast } from "../ui";
import { t } from "../i18n";
import { base64Of } from "./fiscal";
import type { SigningCertificateSummary } from "../../../server/einvoice-signing";

export function signingSection(uuid: string): HTMLElement {
	const container = el("div", { class: "stack" });

	const render = (certificate: SigningCertificateSummary | null) => {
		const file = input("file");
		file.accept = ".p12,.pfx,application/x-pkcs12";
		file.required = true;
		const password = input("password", { autocomplete: "off", required: true });
		const submit = el("button", { class: "button primary", type: "submit" }, certificate ? t("einvoice.replace") : t("einvoice.upload"));

		const form = el(
			"form",
			{
				class: "stack",
				onSubmit: async (event) => {
					event.preventDefault();
					const chosen = file.files?.[0];
					if (!chosen) return;
					submit.disabled = true;
					try {
						render((await Api.uploadSigningCertificate(uuid, await base64Of(chosen), password.value)).certificate);
						toast(t("einvoice.uploaded"), "success");
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			el("div", { class: "form-grid" }, field(t("fiscal.certificate_file"), file), field(t("fiscal.certificate_password"), password)),
			el("div", { class: "form-actions" }, submit)
		);

		const remove = el("button", { class: "button danger", type: "button" }, t("einvoice.remove"));
		remove.addEventListener("click", async () => {
			const confirmed = await confirmDialog({
				title: t("einvoice.remove_title"),
				body: t("einvoice.remove_body"),
				confirmLabel: t("einvoice.remove"),
				destructive: true,
			});
			if (!confirmed) return;
			try {
				render((await Api.removeSigningCertificate(uuid)).certificate);
			} catch (error) {
				reportError(error);
			}
		});

		const expired = certificate !== null && certificate.valid_to < Date.now();
		const current = certificate
			? el(
					"div",
					{ class: "fiscal-facts" },
					el("p", {}, el("span", { class: "muted" }, `${t("fiscal.holder")}: `), certificate.holder ?? ""),
					el("p", {}, el("span", { class: "muted" }, `${t("einvoice.issuer")}: `), certificate.issuer ?? ""),
					el("p", { class: expired ? "warn" : "" }, el("span", { class: "muted" }, `${t("fiscal.valid_to")}: `), formatDate(certificate.valid_to)),
					expired ? el("p", { class: "warn" }, t("einvoice.expired")) : null,
					el("div", { class: "form-actions" }, remove)
				)
			: el("p", { class: "muted" }, t("einvoice.none"));

		container.replaceChildren(current, certificate ? el("details", {}, el("summary", {}, t("einvoice.replace")), form) : form);
	};

	Api.signingCertificate(uuid)
		.then((result) => render(result.certificate))
		.catch(reportError);

	return container;
}
