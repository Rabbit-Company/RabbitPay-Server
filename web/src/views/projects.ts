import { pagedList } from "../pagination";
import { Api, type Project } from "../api";
import { el, emptyState, field, input } from "../dom";
import { formatDate } from "../money";
import { modal, reportError, secretReveal, withLoading } from "../ui";
import { sellsOnly, terminalPath } from "../access";
import { roleLabel, t } from "../i18n";

function projectCard(project: Project): HTMLElement {
	return el(
		"a",
		{ class: "card project-card", href: sellsOnly(project) ? terminalPath(project.uuid) : `/projects/${project.uuid}` },
		el("div", { class: "project-card-head" }, el("h3", {}, project.name), el("span", { class: `pill pill-${project.role}` }, roleLabel(project.role))),
		el("p", { class: "muted" }, t("projects.created", { date: formatDate(project.created) })),
		project.webhook_url ? el("p", { class: "muted mono" }, project.webhook_url) : null
	);
}

function createProjectDialog(onCreated: () => void) {
	const name = input("text", { placeholder: "my-shop", required: true });
	const submit = el("button", { class: "button primary", type: "submit" }, t("projects.create"));

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;

				try {
					const project = await Api.createProject(name.value.trim());
					dialog.close();

					modal(
						t("projects.created_title"),
						el(
							"div",
							{ class: "stack" },
							el("p", {}, t("projects.created_body", { name: project.name })),
							secretReveal(t("projects.primary_key"), project.apikey ?? ""),
							secretReveal(t("projects.secondary_key"), project.apikey2 ?? "")
						)
					);

					onCreated();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		field(t("projects.name"), name, t("login.username_hint")),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("projects.new"), form);
	name.focus();
}

export function projectsView(): HTMLElement {
	const list = el("div", { class: "stack" });

	const load = () =>
		withLoading(
			list,
			() => Api.projects(),
			(projects) => {
				if (projects.length === 0) {
					return emptyState(
						t("projects.empty"),
						el("button", { class: "button primary", type: "button", onClick: () => createProjectDialog(load) }, t("projects.create_first"))
					);
				}
				return pagedList(projects, (page) => el("div", { class: "grid" }, ...page.map(projectCard)));
			}
		);

	void load();

	return el(
		"div",
		{ class: "page" },
		el(
			"div",
			{ class: "page-head" },
			el("div", {}, el("h1", {}, t("projects.title")), el("p", { class: "muted" }, t("projects.intro"))),
			el("button", { class: "button primary", type: "button", onClick: () => createProjectDialog(load) }, t("projects.new"))
		),
		list
	);
}
