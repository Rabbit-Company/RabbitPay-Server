import type { Branding } from "./api";
import { el } from "./dom";
import { logo } from "./logo";
import logoUrl from "../favicon.svg";

const BLANK_ICON = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function setFavicon(href: string) {
	let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.removeAttribute("type");
	link.href = href;
}

export function applyBranding(branding: Branding, title: string) {
	document.title = branding.white_label ? title : `${title} | RabbitPay`;
	setFavicon(branding.white_label ? (branding.logo ?? BLANK_ICON) : logoUrl);
}

export function resetBranding() {
	document.title = "RabbitPay";
	setFavicon(logoUrl);
}

export function brandLogo(branding: Branding, merchant: string, className: string): HTMLElement | null {
	if (!branding.logo) return null;
	const image = el("img", { class: className });
	image.src = branding.logo;
	image.alt = merchant;
	return image;
}

export function poweredBy(branding: Branding, label: string): HTMLElement | null {
	if (branding.white_label) return null;
	return el("p", { class: "powered-by" }, logo(), el("span", {}, label));
}
