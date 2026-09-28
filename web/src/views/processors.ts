import { Api, type ProcessorState } from "../api";
import { el, field, input, select } from "../dom";
import { reportError, toast } from "../ui";
import { processorChoiceLabel, processorFieldHint, processorFieldLabel, processorKindLabel } from "../options";
import { has, processorLabel, t } from "../i18n";

function credentialForm(uuid: string, state: ProcessorState, onSaved: () => void): HTMLElement {
	const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

	const rows = state.fields.map((definition) => {
		const control = definition.choices
			? select(
					definition.choices.map((choice) => ({
						value: choice.value,
						label: processorChoiceLabel(state.processor, definition.key, choice.value, choice.label),
					})),
					definition.value ?? definition.choices[0].value
				)
			: input(definition.secret ? "password" : "text", {
					value: definition.value ?? "",
					placeholder: definition.secret && definition.set ? t("processors.secret_set") : "",
				});

		inputs.set(definition.key, control);

		return field(
			processorFieldLabel(state.processor, definition.key, definition.label),
			control,
			processorFieldHint(state.processor, definition.key, definition.hint)
		);
	});

	const save = el("button", { class: "button primary small", type: "submit" }, t("processors.save"));

	return el(
		"form",
		{
			class: "processor-config",
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;

				const config: Record<string, string> = {};
				for (const [key, control] of inputs) config[key] = control.value.trim();

				try {
					await Api.saveProcessor(uuid, state.processor, state.enabled, config);
					toast(t("processors.updated", { processor: processorLabel(state.processor) }), "success");
					onSaved();
				} catch (error) {
					reportError(error);
				} finally {
					save.disabled = false;
				}
			},
		},
		...rows,
		el("div", { class: "form-actions" }, save)
	);
}

const SETUP_HELP = new Set(["bitcoin", "ethereum", "monero", "stripe", "paypal"]);

function setupHelp(processor: string): string | null {
	if (!SETUP_HELP.has(processor)) return null;
	const key = `processors.help_${processor}`;
	return has(key) ? t(key) : null;
}

function processorCard(uuid: string, state: ProcessorState, onChanged: () => void): HTMLElement {
	const toggle = input("checkbox");
	toggle.checked = state.enabled;
	toggle.disabled = !state.server_available;

	toggle.addEventListener("change", async () => {
		try {
			await Api.saveProcessor(uuid, state.processor, toggle.checked, {});
			toast(
				toggle.checked
					? t("processors.switched_on", { processor: processorLabel(state.processor) })
					: t("processors.switched_off", { processor: processorLabel(state.processor) }),
				"success"
			);
			onChanged();
		} catch (error) {
			toggle.checked = !toggle.checked;
			reportError(error);
		}
	});

	const status = !state.server_available
		? el("span", { class: "muted" }, t("processors.server_off"))
		: state.problem
			? el("span", { class: "pill pill-canceled" }, t("processors.check_settings"))
			: state.configured
				? el("span", { class: "pill pill-active" }, state.enabled ? t("processors.ready") : t("processors.set_up"))
				: el("span", { class: "pill pill-open" }, t("processors.needs_setup"));

	const details = !state.server_available
		? [el("p", { class: "muted" }, t("processors.not_enabled"))]
		: [
				setupHelp(state.processor) ? el("p", { class: "muted processor-help" }, setupHelp(state.processor)) : null,
				state.problem ? el("p", { class: "warn processor-help" }, state.problem) : null,
				state.preview
					? el(
							"p",
							{ class: "processor-help" },
							`${t("processors.first_address")} `,
							el("code", { class: "mono" }, state.preview),
							el("span", { class: "muted" }, t("processors.first_address_hint"))
						)
					: null,
				credentialForm(uuid, state, onChanged),
			];

	return el(
		"div",
		{ class: "processor" },
		el(
			"div",
			{ class: "processor-head" },
			el("label", { class: "switch" }, toggle, el("span", {}, processorLabel(state.processor))),
			el("div", { class: "processor-status" }, el("span", { class: "muted" }, processorKindLabel(state.kind)), status)
		),
		...details
	);
}

export function processorsSection(uuid: string): HTMLElement {
	const container = el("div", { class: "stack" });

	const load = async () => {
		try {
			const states = await Api.processors(uuid);
			container.replaceChildren(el("p", { class: "muted" }, t("processors.intro")), ...states.map((state) => processorCard(uuid, state, load)));
		} catch {
			container.replaceChildren(el("p", { class: "muted" }, t("processors.no_permission")));
		}
	};

	void load();
	return container;
}
