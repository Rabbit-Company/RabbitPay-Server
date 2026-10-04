import { PageState } from "../../../server/page-state";
import { pagedTable, PAGE_SIZE } from "../pagination";
import { Api, getUsername, type Member } from "../api";
import { el, field, input, select } from "../dom";
import { formatDate } from "../money";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { loadProject, projectLayout } from "./project";
import { roleHint, roleLabel, statusLabel, t } from "../i18n";
import { can, Permission } from "../access";

const ROLE_VALUES = ["owner", "admin", "manager", "accountant", "developer", "viewer", "cashier", "supervisor", "employee"];

function roleOptions() {
	return ROLE_VALUES.map((value) => ({ value, label: roleLabel(value) }));
}

function inviteLink(token: string): string {
	return `${window.location.origin}/invite/${token}`;
}

async function copyInviteLink(token: string) {
	try {
		await navigator.clipboard.writeText(inviteLink(token));
		toast(t("members.link_copied"), "success");
	} catch {
		toast(t("members.copy_failed"), "error");
	}
}

function inviteLinkBox(token: string): HTMLElement {
	return el(
		"div",
		{ class: "stack" },
		el("code", { class: "secret" }, inviteLink(token)),
		el("button", { class: "button primary", type: "button", onClick: () => void copyInviteLink(token) }, t("members.copy_link_button"))
	);
}

function inviteDialog(uuid: string, onInvited: () => void) {
	const email = input("email", { required: true, placeholder: "teammate@example.com" });
	const role = select(roleOptions(), "viewer");
	const hint = el("p", { class: "muted" }, roleHint("viewer"));

	role.addEventListener("change", () => {
		hint.textContent = roleHint(role.value);
	});

	const submit = el("button", { class: "button primary", type: "submit" }, t("members.send_invite"));

	const form = el(
		"form",
		{
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;

				try {
					const member = await Api.inviteMember(uuid, email.value.trim(), role.value);
					dialog.close();

					if (member.status === "pending" && member.invitation_token) {
						modal(
							t("members.invitation_created"),
							el(
								"div",
								{ class: "stack" },
								el(
									"p",
									{},
									member.email_queued
										? t("members.invite_emailed", { email: member.invitation_email ?? "" })
										: t("members.invite_share", { email: member.invitation_email ?? "" })
								),
								el("p", { class: "muted" }, t("members.link_warning")),
								inviteLinkBox(member.invitation_token)
							)
						);
					} else {
						toast(t("members.added"), "success");
					}

					onInvited();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		field(t("customers.email"), email),
		field(t("members.role"), role),
		hint,
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(t("members.invite_title"), form);
	email.focus();
}

function croppedSignature(canvas: HTMLCanvasElement): string | null {
	const context = canvas.getContext("2d");
	if (!context) return null;
	const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
	let left = canvas.width;
	let top = canvas.height;
	let right = -1;
	let bottom = -1;

	for (let y = 0; y < canvas.height; y++) {
		for (let x = 0; x < canvas.width; x++) {
			if (pixels[(y * canvas.width + x) * 4 + 3] < 16) continue;
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x);
			bottom = Math.max(bottom, y);
		}
	}
	if (right < left || bottom < top) return null;

	const width = right - left + 1;
	const height = bottom - top + 1;
	const padding = Math.max(8, Math.round(Math.max(width, height) * 0.04));
	const cropped = document.createElement("canvas");
	cropped.width = width + padding * 2;
	cropped.height = height + padding * 2;
	const croppedContext = cropped.getContext("2d");
	if (!croppedContext) return null;
	croppedContext.drawImage(canvas, left, top, width, height, padding, padding, width, height);
	return cropped.toDataURL("image/png").split(",", 2)[1] ?? null;
}

async function profileDialog(uuid: string, onSaved: () => void) {
	try {
		const profile = await Api.memberProfile(uuid);
		const fullName = input("text", { required: true, maxlength: "150", value: profile.full_name ?? "", autocomplete: "name" });
		const canvas = el("canvas", { class: "signature-canvas" });
		canvas.width = 720;
		canvas.height = 220;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas is unavailable");
		context.lineCap = "round";
		context.lineJoin = "round";
		context.lineWidth = 5;
		context.strokeStyle = "#111827";

		let drawing = false;
		let lastPoint: { x: number; y: number } | null = null;
		let signatureChanged = false;
		let hasInk = Boolean(profile.signature);
		let imageReady = Promise.resolve();
		if (profile.signature) {
			const image = new Image();
			imageReady = new Promise<void>((resolve) => {
				image.onload = () => {
					if (!signatureChanged) context.drawImage(image, 0, 0, canvas.width, canvas.height);
					resolve();
				};
				image.onerror = () => {
					if (!signatureChanged) hasInk = false;
					resolve();
				};
			});
			image.src = `data:image/png;base64,${profile.signature}`;
		}

		const point = (event: PointerEvent) => {
			const bounds = canvas.getBoundingClientRect();
			return { x: ((event.clientX - bounds.left) * canvas.width) / bounds.width, y: ((event.clientY - bounds.top) * canvas.height) / bounds.height };
		};
		canvas.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			drawing = true;
			signatureChanged = true;
			hasInk = true;
			canvas.setPointerCapture(event.pointerId);
			const start = point(event);
			lastPoint = start;
			context.beginPath();
			context.arc(start.x, start.y, context.lineWidth / 2, 0, Math.PI * 2);
			context.fillStyle = context.strokeStyle;
			context.fill();
		});
		canvas.addEventListener("pointermove", (event) => {
			if (!drawing || !lastPoint) return;
			const next = point(event);
			context.beginPath();
			context.moveTo(lastPoint.x, lastPoint.y);
			context.lineTo(next.x, next.y);
			context.stroke();
			lastPoint = next;
		});
		const stop = () => {
			drawing = false;
			lastPoint = null;
		};
		canvas.addEventListener("pointerup", stop);
		canvas.addEventListener("pointercancel", stop);

		const clear = el(
			"button",
			{
				class: "button ghost small",
				type: "button",
				onClick: () => {
					context.clearRect(0, 0, canvas.width, canvas.height);
					signatureChanged = true;
					hasInk = false;
				},
			},
			t("members.signature_clear")
		);
		const submit = el("button", { class: "button primary", type: "submit" }, t("ui.save"));
		const form = el(
			"form",
			{
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;
					try {
						await imageReady;
						const signature = signatureChanged || profile.signature ? (hasInk ? croppedSignature(canvas) : null) : undefined;
						await Api.updateMemberProfile(uuid, { full_name: fullName.value.trim(), signature });
						dialog.close();
						toast(t("members.profile_saved"), "success");
						onSaved();
					} catch (error) {
						reportError(error);
						submit.disabled = false;
					}
				},
			},
			field(t("members.full_name"), fullName, t("members.full_name_hint")),
			el(
				"div",
				{ class: "field" },
				el("span", { class: "field-label" }, t("members.signature")),
				el("div", { class: "signature-editor" }, canvas, clear),
				el("span", { class: "field-hint" }, t("members.signature_hint"))
			),
			el("div", { class: "dialog-actions" }, submit)
		);

		const dialog = modal(t("members.invoice_identity"), form);
		fullName.focus();
	} catch (error) {
		reportError(error);
	}
}

export async function membersView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const body = el("div", {});
	const page = new PageState();
	const me = getUsername();
	const manages = can(project, Permission.PROJECT_MEMBERS);

	const load = async () => {
		try {
			const members = await Api.members(uuid);

			const rows = members.map((member: Member) => {
				const isMe = member.account_username !== null && member.account_username === me;

				const roleSelect = select(roleOptions(), member.role);
				roleSelect.disabled = isMe;

				roleSelect.addEventListener("change", async () => {
					try {
						await Api.updateMember(uuid, member.uuid, { role: roleSelect.value });
						toast(t("members.role_updated"), "success");
						void load();
					} catch (error) {
						reportError(error);
						void load();
					}
				});

				return el(
					"tr",
					{},
					el(
						"td",
						{},
						el("strong", {}, member.full_name || member.account_email || member.invitation_email || t("members.unknown")),
						isMe ? el("span", { class: "muted" }, ` (${t("members.you")})`) : null,
						member.full_name && (member.account_email || member.invitation_email)
							? el("div", { class: "muted" }, member.account_email || member.invitation_email)
							: null,
						member.has_signature ? el("div", { class: "muted" }, t("members.signature_saved")) : null
					),
					el("td", {}, manages ? roleSelect : roleLabel(member.role)),
					el("td", {}, el("span", { class: `pill pill-${member.status}` }, statusLabel(member.status))),
					el("td", {}, formatDate(member.created)),
					el(
						"td",
						{ class: "actions" },
						isMe
							? el("button", { class: "button ghost small", type: "button", onClick: () => void profileDialog(uuid, load) }, t("members.edit_profile"))
							: null,
						member.status === "pending" && member.invitation_token
							? el(
									"button",
									{ class: "button ghost small", type: "button", onClick: () => void copyInviteLink(member.invitation_token!) },
									t("members.copy_link")
								)
							: null,
						manages && member.status === "pending" && member.invitation_token && project.email_enabled
							? el(
									"button",
									{
										class: "button ghost small",
										type: "button",
										onClick: async () => {
											try {
												await Api.emailInvitation(uuid, member.uuid);
												toast(t("members.invite_sent", { email: member.invitation_email ?? "" }), "success");
											} catch (error) {
												reportError(error);
											}
										},
									},
									t("members.email_again")
								)
							: null,
						isMe || !manages
							? null
							: el(
									"button",
									{
										class: "button danger small",
										type: "button",
										onClick: async () => {
											const confirmed = await confirmDialog({
												title: t("members.remove_title"),
												body: t("members.remove_body", { member: member.full_name || member.account_email || member.invitation_email || "" }),
												confirmLabel: t("members.remove"),
												destructive: true,
											});
											if (!confirmed) return;

											try {
												await Api.removeMember(uuid, member.uuid);
												toast(t("members.removed"), "success");
												void load();
											} catch (error) {
												reportError(error);
											}
										},
									},
									t("members.remove")
								)
					)
				);
			});

			body.replaceChildren(
				pagedTable([t("members.column_member"), t("members.role"), t("members.column_status"), t("customers.column_added"), ""], rows, PAGE_SIZE, page)
			);
		} catch (error) {
			reportError(error);
		}
	};

	void load();

	const content = el(
		"div",
		{ class: "stack" },
		el(
			"div",
			{ class: "toolbar" },
			el("p", { class: "muted" }, t("members.own_membership")),
			manages ? el("button", { class: "button primary", type: "button", onClick: () => inviteDialog(uuid, load) }, t("members.invite")) : null
		),
		body
	);

	return projectLayout(project, content);
}
