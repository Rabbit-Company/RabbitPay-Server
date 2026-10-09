import { ApiError, PublicApi, type GuestMeeting } from "../api";
import { el, field, input } from "../dom";
import { authBrand, authPage } from "../auth-page";
import { errorText, locale, t } from "../i18n";
import { onLeave } from "../router";
import { inGroupCall, joinAsGuest, leaveGroupCall } from "../group-call";

const POLL_MS = 5000;
const MAX_NAME_LENGTH = 60;
const NAME_KEY = "rabbitpay.guest_name";

function remembered(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "";
	} catch {
		return "";
	}
}

function remember(name: string) {
	try {
		localStorage.setItem(NAME_KEY, name);
	} catch {
		void 0;
	}
}

function card(...children: (HTMLElement | null)[]): HTMLElement {
	return authPage(el("div", { class: "auth-card invite-card" }, authBrand(), ...children));
}

export async function guestMeetingView(token: string): Promise<HTMLElement> {
	let meeting: GuestMeeting;
	try {
		meeting = await PublicApi.meeting(token);
	} catch (error) {
		return card(
			el("h1", {}, t("meetings.guest_invalid_title")),
			el("p", { class: "muted" }, error instanceof ApiError ? errorText(error.code, error.message) : t("ui.error_generic"))
		);
	}

	const when = new Intl.DateTimeFormat(locale(), { dateStyle: "full", timeStyle: "short" }).format(new Date(meeting.starts_at));
	const status = el("p", { class: "muted" });
	status.setAttribute("role", "status");
	const name = input("text", { maxlength: String(MAX_NAME_LENGTH), required: true, value: remembered(), autocomplete: "name" });
	const join = el("button", { class: "button primary wide", type: "submit" }, t("meetings.guest_join"));
	let left = false;
	let joining = false;

	const show = () => {
		join.disabled = !meeting.active || joining || inGroupCall();
		status.textContent = inGroupCall()
			? t("meetings.guest_in_call")
			: left
				? t("meetings.guest_left")
				: meeting.active
					? t("meetings.guest_ready")
					: t("meetings.guest_waiting");
	};

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				const given = name.value.trim();
				if (given === "" || joining) return;
				remember(given);
				joining = true;
				left = false;
				show();
				await joinAsGuest(token, given, meeting.title, () => {
					left = true;
					show();
				});
				joining = false;
				show();
			},
		},
		field(t("meetings.guest_name"), name),
		join
	);

	const poller = setInterval(async () => {
		if (inGroupCall()) return;
		try {
			meeting = await PublicApi.meeting(token);
			show();
		} catch {
			void 0;
		}
	}, POLL_MS);
	onLeave(() => {
		clearInterval(poller);
		void leaveGroupCall();
	});

	show();
	return card(
		el("h1", {}, meeting.title),
		el("p", { class: "muted" }, t("meetings.guest_summary", { organisation: meeting.organisation, when, minutes: meeting.duration_minutes })),
		status,
		form,
		el("p", { class: "muted" }, t("meetings.guest_privacy"))
	);
}
