import { pagedList } from "../pagination";
import { Api, type Project } from "../api";
import { el, emptyState, field, input } from "../dom";
import { formatDate } from "../money";
import { modal, reportError, toast, withLoading } from "../ui";
import { navigate } from "../router";
import { headingAnchor } from "../../../server/markdown";
import { can, Permission, sellsOnly, terminalPath } from "../access";
import { roleLabel, t } from "../i18n";

function projectCard(project: Project): HTMLElement {
	return el(
		"a",
		{ class: "card project-card", href: sellsOnly(project) ? terminalPath(project.uuid) : `/projects/${project.uuid}` },
		el("div", { class: "project-card-head" }, el("h3", {}, project.public_name), el("span", { class: `pill pill-${project.role}` }, roleLabel(project.role))),
		el("p", { class: "muted" }, t("projects.created", { date: formatDate(project.created) })),
		project.webhook_url ? el("p", { class: "muted mono" }, project.webhook_url) : null
	);
}

const SLUG_LENGTH = 30;
const SLUG_MINIMUM = 4;

export function projectSlug(businessName: string): string {
	const words = headingAnchor(businessName);
	const lettered = /^[a-z]/.test(words) || words === "" ? words : `project-${words}`;
	const padded = lettered !== "" && lettered.length < SLUG_MINIMUM ? `${lettered}-project` : lettered;
	return padded.slice(0, SLUG_LENGTH).replace(/-+$/, "");
}

export function projectNameFields(): { business: HTMLInputElement; name: HTMLInputElement; fields: HTMLElement[] } {
	const business = input("text", { placeholder: t("projects.business_placeholder"), required: true, maxlength: "120", autocomplete: "organization" });
	const name = input("text", { placeholder: "my-shop", required: true, maxlength: String(SLUG_LENGTH) });
	let chosen = false;
	name.addEventListener("input", () => {
		chosen = name.value !== "";
	});
	business.addEventListener("input", () => {
		if (!chosen) name.value = projectSlug(business.value);
	});
	return {
		business,
		name,
		fields: [field(t("projects.business_name"), business, t("projects.business_hint")), field(t("projects.name"), name, t("projects.name_hint"))],
	};
}

function createProjectDialog() {
	const { business, name, fields } = projectNameFields();
	const submit = el("button", { class: "button primary", type: "submit" }, t("projects.create"));

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;

				try {
					const project = await Api.createProject(name.value.trim(), business.value.trim());
					dialog.close();
					toast(t("projects.created_toast", { name: project.public_name }), "success");
					navigate(`/projects/${project.uuid}`);
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		...fields,
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("projects.new"), form);
	business.focus();
}

export function projectsView(): HTMLElement {
	const list = el("div", { class: "stack" });
	const clients = el("a", { class: "button ghost", href: "/accounting" }, t("accounting.clients"));
	clients.hidden = true;

	const load = () =>
		withLoading(
			list,
			() => Api.projects(),
			(projects) => {
				clients.hidden = projects.filter((project) => can(project, Permission.LEDGER_EDIT)).length < 2;
				if (projects.length === 0) {
					return emptyState(
						t("projects.empty"),
						el("button", { class: "button primary", type: "button", onClick: () => createProjectDialog() }, t("projects.create_first"))
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
			el(
				"div",
				{ class: "line-actions" },
				clients,
				el("button", { class: "button primary", type: "button", onClick: () => createProjectDialog() }, t("projects.new"))
			)
		),
		list
	);
}
