import { Api, getEmail, type NotificationChange, type NotificationPreference, type PushDevice } from "../api";
import { formatDate } from "../money";
import { el } from "../dom";
import { t, type UiKey } from "../i18n";
import { onLeave } from "../router";
import { confirmDialog, reportError, toast } from "../ui";
import { icon } from "../storefront/icons";
import { desktopState, rememberPreferences, sendTestNotice, setDesktop, watchPreferences, type DesktopState } from "../notifications";
import { currentDeviceHash, deviceName, pushSupported } from "../push";
import { accountTabs } from "./account-tabs";
import { NOTIFICATION_GROUPS, type NotificationChannel, type NotificationGroup } from "../../../server/notifications/kinds";

const GROUP_ICONS: Record<NotificationGroup, string> = {
	chat: "message",
	calendar: "calendar",
	tickets: "ticket",
	time: "clock",
	sales: "bag",
	compliance: "shield",
};

const CHANNEL_ICONS: Record<NotificationChannel, string> = { browser: "desktop", email: "mail" };
const SAVED_FLASH_MS = 1800;

const DESKTOP_PILLS: Record<DesktopState, { label: UiKey; tone: string }> = {
	on: { label: "notifications.desktop_on", tone: "pill-active" },
	off: { label: "notifications.desktop_off", tone: "" },
	blocked: { label: "notifications.desktop_blocked", tone: "pill-overdue" },
	unsupported: { label: "notifications.desktop_unsupported", tone: "" },
};

function badge(name: string): HTMLElement {
	return icon(name, 20, "notify-icon");
}

function channelName(channel: NotificationChannel): string {
	return t(`notifications.${channel}`);
}

function deviceLabel(device: PushDevice): string {
	const { browser, system } = deviceName(device.user_agent);
	if (browser && system) return t("notifications.device_name", { browser, system });
	return browser ?? system ?? t("notifications.device_unknown");
}

function devicesPanel(onCurrentRemoved: () => Promise<void>): { element: HTMLElement; refresh: () => Promise<void> } {
	const list = el("ul", { class: "security-keys" });
	const element = el("div", { class: "notify-devices" }, el("span", { class: "field-label" }, t("notifications.devices_title")), list);
	element.hidden = true;

	const paint = (devices: PushDevice[], current: string | null) => {
		element.hidden = devices.length === 0;
		list.replaceChildren(
			...devices.map((device) => {
				const here = device.endpoint_hash === current;
				const remove = el("button", { class: "button ghost small", type: "button" }, t("security_key.remove"));
				remove.addEventListener("click", async () => {
					remove.disabled = true;
					try {
						if (here) await onCurrentRemoved();
						else paint((await Api.removePushDevice(device.id)).devices, current);
					} catch (error) {
						remove.disabled = false;
						reportError(error);
					}
				});
				return el(
					"li",
					{ class: "security-key" },
					el(
						"div",
						{},
						el("strong", {}, deviceLabel(device)),
						here ? el("span", { class: "pill pill-active pill-sentence notify-here" }, t("notifications.device_here")) : null,
						el("div", { class: "muted" }, t("notifications.device_seen", { date: formatDate(device.seen) }))
					),
					remove
				);
			})
		);
	};

	const refresh = async () => {
		if (!pushSupported()) return;
		try {
			const [{ devices }, current] = await Promise.all([Api.pushKey(), currentDeviceHash()]);
			paint(devices, current);
		} catch {
			void 0;
		}
	};
	return { element, refresh };
}

function browserCard(): HTMLElement {
	const toggle = el("input", { type: "checkbox" });
	const pill = el("span", { class: "pill" });
	const hint = el("p", { class: "field-hint" });
	const test = el("button", { class: "button ghost small", type: "button", onClick: sendTestNotice }, t("notifications.test"));

	const paint = (state: DesktopState) => {
		toggle.checked = state === "on";
		toggle.disabled = state === "blocked" || state === "unsupported";
		pill.className = `pill ${DESKTOP_PILLS[state].tone}`.trim();
		pill.textContent = t(DESKTOP_PILLS[state].label);
		hint.textContent = t(
			state === "blocked"
				? "notifications.desktop_blocked_hint"
				: state === "unsupported"
					? "notifications.desktop_unsupported_hint"
					: pushSupported()
						? "notifications.desktop_push_hint"
						: "notifications.desktop_hint"
		);
	};
	const change = async (enabled: boolean) => {
		paint(await setDesktop(enabled));
		await devices.refresh();
	};
	const devices = devicesPanel(() => change(false));
	toggle.addEventListener("change", () => void change(toggle.checked));
	paint(desktopState());
	void devices.refresh();

	return el(
		"section",
		{ class: "card notify-channel" },
		el(
			"div",
			{ class: "notify-channel-head" },
			badge("desktop"),
			el("div", {}, el("h2", {}, t("notifications.browser_title")), el("p", { class: "muted" }, t("notifications.browser_body")))
		),
		el(
			"div",
			{ class: "notify-device" },
			el("div", { class: "notify-device-row" }, el("label", { class: "switch" }, toggle, el("span", {}, t("notifications.desktop_label"))), pill),
			hint,
			el("div", {}, test),
			devices.element
		)
	);
}

function emailCard(ready: boolean): HTMLElement {
	return el(
		"section",
		{ class: "card notify-channel" },
		el(
			"div",
			{ class: "notify-channel-head" },
			badge("mail"),
			el("div", {}, el("h2", {}, t("notifications.email_title")), el("p", { class: "muted" }, t("notifications.email_body", { email: getEmail() ?? "" })))
		),
		el(
			"div",
			{ class: "notify-device" },
			ready ? null : el("p", { class: "warn-text" }, t("notifications.email_unavailable")),
			el("div", {}, el("a", { class: "button ghost small", href: "/account" }, t("notifications.email_change")))
		)
	);
}

function columnHead(channel: NotificationChannel): HTMLElement {
	return el("span", { class: "notify-column" }, icon(CHANNEL_ICONS[channel], 14), el("span", {}, channelName(channel)));
}

export async function notificationsView(): Promise<HTMLElement> {
	const loaded = await Api.notificationPreferences();
	let preferences = loaded.preferences;
	rememberPreferences(preferences);

	const groups = el("div", { class: "stack" });
	const status = el("span", { class: "notify-status" }, t("notifications.autosave"));
	let flash: ReturnType<typeof setTimeout> | null = null;

	const saved = () => {
		status.replaceChildren(icon("check", 14), el("span", {}, t("notifications.saved")));
		status.classList.add("saved");
		if (flash !== null) clearTimeout(flash);
		flash = setTimeout(() => {
			status.textContent = t("notifications.autosave");
			status.classList.remove("saved");
		}, SAVED_FLASH_MS);
	};

	const save = async (change: NotificationChange, toggle: HTMLInputElement) => {
		try {
			preferences = (await Api.saveNotificationPreferences([change])).preferences;
			rememberPreferences(preferences);
			saved();
		} catch (error) {
			toggle.checked = !change.enabled;
			reportError(error);
		}
	};

	const cell = (preference: NotificationPreference, channel: NotificationChannel): HTMLElement => {
		const state = preference[channel];
		const label = el("span", { class: "notify-cell-label" }, channelName(channel));
		if (state === null) {
			const none = el("span", { class: "notify-none", title: t("notifications.no_email") }, "-");
			none.setAttribute("aria-label", t("notifications.no_email"));
			return el("div", { class: "notify-cell" }, label, none);
		}
		const toggle = el("input", { type: "checkbox" });
		toggle.checked = state.enabled;
		toggle.disabled = state.locked;
		toggle.setAttribute("aria-label", t("notifications.switch_label", { name: t(`notifications.kind.${preference.kind}`), channel: channelName(channel) }));
		toggle.addEventListener("change", () => void save({ kind: preference.kind, channel, enabled: toggle.checked }, toggle));
		const control = el("label", { class: "switch" }, toggle);
		if (!state.locked) return el("div", { class: "notify-cell" }, label, control);
		control.title = t("notifications.locked");
		return el("div", { class: "notify-cell locked" }, label, control, icon("lock", 13, "notify-lock"));
	};

	const row = (preference: NotificationPreference): HTMLElement =>
		el(
			"div",
			{ class: "notify-row" },
			el(
				"div",
				{ class: "notify-row-text" },
				el("strong", {}, t(`notifications.kind.${preference.kind}`)),
				el("span", { class: "muted" }, t(`notifications.kind.${preference.kind}_hint`))
			),
			cell(preference, "browser"),
			cell(preference, "email")
		);

	const paint = () => {
		const relevant = preferences.filter((preference) => preference.relevant);
		const shown = relevant.length > 0 ? relevant : preferences;
		groups.replaceChildren(
			...NOTIFICATION_GROUPS.map((group) => {
				const rows = shown.filter((preference) => preference.group === group);
				if (rows.length === 0) return null;
				return el(
					"section",
					{ class: "card notify-group" },
					el(
						"header",
						{ class: "notify-group-head" },
						el(
							"div",
							{ class: "notify-group-title" },
							badge(GROUP_ICONS[group]),
							el("div", {}, el("h2", {}, t(`notifications.group.${group}`)), el("p", { class: "muted" }, t(`notifications.group.${group}_hint`)))
						),
						columnHead("browser"),
						columnHead("email")
					),
					...rows.map(row)
				);
			}).filter((section): section is HTMLElement => section !== null)
		);
	};
	paint();

	const reset = async () => {
		const confirmed = await confirmDialog({
			title: t("notifications.reset_title"),
			body: t("notifications.reset_body"),
			confirmLabel: t("notifications.reset"),
		});
		if (!confirmed) return;
		try {
			preferences = (await Api.resetNotificationPreferences()).preferences;
			rememberPreferences(preferences);
			paint();
			toast(t("notifications.reset_done"), "success");
		} catch (error) {
			reportError(error);
		}
	};

	onLeave(
		watchPreferences((latest) => {
			if (JSON.stringify(latest) === JSON.stringify(preferences)) return;
			preferences = latest;
			paint();
		})
	);

	return el(
		"div",
		{ class: "page" },
		el("div", { class: "page-head" }, el("div", {}, el("h1", {}, t("notifications.title")), el("p", { class: "muted" }, t("notifications.intro")))),
		accountTabs("notifications"),
		el(
			"div",
			{ class: "notify-content" },
			el("div", { class: "notify-channels" }, browserCard(), emailCard(loaded.email_ready)),
			el(
				"div",
				{ class: "notify-toolbar" },
				status,
				el("button", { class: "button ghost small", type: "button", onClick: () => void reset() }, t("notifications.reset"))
			),
			groups,
			el("p", { class: "notify-footnote muted" }, icon("bell_off", 16), el("span", {}, t("notifications.dnd_note")))
		)
	);
}
