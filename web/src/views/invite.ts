import { Api, getToken, getUsername, type Invitation } from "../api";
import { el } from "../dom";
import { navigate } from "../router";
import { confirmDialog, reportError, toast } from "../ui";
import { invalidateProject } from "./project";
import { authBrand, authPage } from "../auth-page";
import { roleHint, roleLabel, t } from "../i18n";

function card(...children: (HTMLElement | null)[]): HTMLElement {
	return authPage(el("div", { class: "auth-card invite-card" }, authBrand(), ...children));
}

function authLink(mode: "login" | "register", token: string, invitation: Invitation): string {
	const query = new URLSearchParams({ next: `/invite/${token}` });
	if (mode === "register") {
		query.set("mode", "register");
		if (invitation.invitation_email) query.set("email", invitation.invitation_email);
	}
	return `/login?${query}`;
}

export async function inviteView(token: string): Promise<HTMLElement> {
	let invitation: Invitation;
	try {
		invitation = await Api.invitation(token);
	} catch {
		return card(
			el("h1", {}, t("invite.invalid_title")),
			el("p", { class: "muted" }, t("invite.invalid_body")),
			el("a", { class: "button primary wide", href: "/" }, t("invite.go_home"))
		);
	}

	const heading = el("h1", {}, t("invite.heading", { project: invitation.project_name }));
	const summary = el(
		"p",
		{},
		invitation.invited_by ? t("invite.invited_by", { inviter: invitation.invited_by }) : t("invite.invited"),
		el("strong", {}, roleLabel(invitation.role)),
		"."
	);
	const role = el("p", { class: "muted" }, roleHint(invitation.role));
	const expired = invitation.expired ? el("p", { class: "warn" }, t("invite.expired")) : null;

	if (getToken() === null) {
		const registration = await Api.registration().then(
			(status) => status.mode,
			() => "open"
		);
		return card(
			heading,
			summary,
			role,
			expired,
			el("a", { class: "button primary wide", href: authLink("login", token, invitation) }, t("invite.sign_in_to_accept")),
			registration === "closed" ? null : el("a", { class: "button ghost wide", href: authLink("register", token, invitation) }, t("login.create_account"))
		);
	}

	const accept = el("button", { class: "button primary wide", type: "button" }, t("invite.accept"));
	accept.disabled = invitation.expired;

	accept.addEventListener("click", async () => {
		accept.disabled = true;
		try {
			const joined = await Api.acceptInvitation(token);
			invalidateProject(joined.project);
			toast(t("invite.joined", { project: joined.project_name }), "success");
			navigate(`/projects/${joined.project}`);
		} catch (error) {
			reportError(error);
			accept.disabled = false;
		}
	});

	const decline = el(
		"button",
		{
			class: "link-button",
			type: "button",
			onClick: async () => {
				const confirmed = await confirmDialog({
					title: t("invite.decline_title"),
					body: t("invite.decline_body", { project: invitation.project_name }),
					confirmLabel: t("invite.decline"),
					destructive: true,
				});
				if (!confirmed) return;

				try {
					await Api.declineInvitation(token);
					toast(t("invite.declined"), "success");
					navigate("/");
				} catch (error) {
					reportError(error);
				}
			},
		},
		t("invite.decline")
	);

	return card(heading, summary, role, expired, el("p", { class: "muted" }, t("invite.signed_in_as", { username: getUsername() ?? "" })), accept, decline);
}
