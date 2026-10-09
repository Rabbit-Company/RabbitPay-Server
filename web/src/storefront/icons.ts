import type { SocialNetwork } from "../../../server/store/config";

const STROKE: Record<string, string> = {
	cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 1.9-1.5L21 7H6.2"/>',
	bag: '<path d="M5 8h14l-1.2 12.1a1 1 0 0 1-1 .9H7.2a1 1 0 0 1-1-.9z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
	user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
	menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
	close: '<path d="M6 6l12 12M18 6 6 18"/>',
	image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
	play: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
	more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
	truck: '<path d="M2 6h12v10H2zM14 9h4.5L22 12.5V16h-8"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
	shield: '<path d="M12 3 4.5 6v6c0 4.6 3.2 7.9 7.5 9 4.3-1.1 7.5-4.4 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
	undo: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
	pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
	phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
	mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
	check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
	copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
	mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
	mic_off: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><path d="M4 3l16 18"/>',
	video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10.5 6-3.5v10l-6-3.5"/>',
	video_off: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10.5 6-3.5v10l-6-3.5"/><path d="M3 3l18 18"/>',
	screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M12 13V8M9.5 10.5 12 8l2.5 2.5"/>',
	message: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
	expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
	shrink: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
	fullscreen: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
	fullscreen_exit: '<path d="M19 11h-6V5M13 11l7-7M5 13h6v6M11 13l-7 7"/>',
	hang_up: '<g transform="rotate(135 12 12)"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></g>',
	record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
	record_stop: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/>',
	paperclip: '<path d="M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4L15 7"/>',
	minus: '<path d="M5 12h14"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
	right: '<path d="m9 6 6 6-6 6"/>',
	left: '<path d="m15 6-6 6 6 6"/>',
	down: '<path d="m6 9 6 6 6-6"/>',
	filter: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
	box: '<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9"/>',
	lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
	external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
	bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
	download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
	logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10"/>',
	card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
	spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
	code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
	instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.6"/>',
	x: '<path d="M4 4h4.3l11.7 16h-4.3zM19.5 4l-6.8 7.4M4.5 20l6.8-7.4"/>',
	whatsapp: '<path d="M3.5 20.5 5 16a8.5 8.5 0 1 1 3.2 3.2z"/><path d="M9.2 8.3c0 3.6 2.9 6.5 6.5 6.5l1-1.6-2.1-1-1 1a4 4 0 0 1-2.8-2.8l1-1-1-2.1z"/>',
	reddit:
		'<circle cx="12" cy="13.5" r="6.5"/><circle cx="18.5" cy="5.5" r="1.5"/><path d="m12 7 1.4-3.5 3.6 1.2M9.5 12.5h.01M14.5 12.5h.01M9.3 16c1.6 1 3.8 1 5.4 0"/>',
	twitch: '<path d="M4.5 3H20v10.5L16 17.5h-4L9 20.5H7v-3H4.5z"/><path d="M11 7.5v4M15.5 7.5v4"/>',
	mastodon:
		'<path d="M19.5 9c0-3.9-2.6-5-4-5.3C14.4 3.4 13 3.2 12 3.2s-2.4.2-3.5.5C7.1 4 4.5 5.1 4.5 9c0 2.5-.2 5.8 1.4 7.9 1.8 2.3 5.5 2.8 8.4 2.1v-2s-2.3.6-4-.4"/><path d="M8.5 13V9.8a1.8 1.8 0 0 1 3.5 0V12m0-2.2a1.8 1.8 0 0 1 3.5 0V13"/>',
	pinterest: '<circle cx="12" cy="12" r="9"/><path d="M10.8 8.3c3.2-1.1 5.7.6 5.1 3.6-.4 2.4-2.9 3.5-4.4 2M12 11l-2.4 9.5"/>',
};

const FILL: Record<string, string> = {
	discord:
		'<path d="M19.3 5.4A17 17 0 0 0 15 4l-.5 1a15.6 15.6 0 0 0-5 0L9 4a17 17 0 0 0-4.3 1.4C2 9.5 1.3 13.5 1.6 17.4A17 17 0 0 0 6.9 20l1.1-1.8a11 11 0 0 1-1.7-.8l.4-.3a12.2 12.2 0 0 0 10.6 0l.4.3a11 11 0 0 1-1.7.8l1.1 1.8a17 17 0 0 0 5.3-2.6c.4-4.6-.7-8.5-2.9-12zM8.7 15c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z"/>',
	facebook: '<path d="M13.5 21v-7.5h2.6l.4-3.2h-3V8.4c0-.9.3-1.6 1.6-1.6h1.6V4a21 21 0 0 0-2.4-.1c-2.4 0-4 1.4-4 4.1v2.3H7.7v3.2h2.6V21z"/>',
	youtube:
		'<path fill-rule="evenodd" d="M22 8.2a3 3 0 0 0-2.1-2.1C18 5.6 12 5.6 12 5.6s-6 0-7.9.5A3 3 0 0 0 2 8.2 31 31 0 0 0 1.6 12 31 31 0 0 0 2 15.8a3 3 0 0 0 2.1 2.1c1.9.5 7.9.5 7.9.5s6 0 7.9-.5a3 3 0 0 0 2.1-2.1c.3-1.2.4-2.5.4-3.8s-.1-2.6-.4-3.8zM10 15.1V8.9l5.2 3.1z"/>',
	tiktok: '<path d="M16.5 3a4.8 4.8 0 0 0 4 4v3.2a8 8 0 0 1-4-1.2v6.3A6.3 6.3 0 1 1 10.2 9v3.3a3 3 0 1 0 3 3V3z"/>',
	linkedin:
		'<path d="M4 9h4v12H4zM6 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM10 9h3.8v1.7c.6-1 1.9-2 3.9-2 4 0 4.3 2.6 4.3 6V21h-4v-5.5c0-1.4 0-3.1-1.9-3.1s-2.2 1.5-2.2 3V21h-4z"/>',
	telegram:
		'<path fill-rule="evenodd" d="M21.5 3.5 2.8 10.7c-1 .4-1 1.2 0 1.5l4.7 1.5 1.8 5.6c.2.6.9.8 1.4.4l2.6-2.2 4.9 3.6c.6.4 1.4.1 1.5-.6l3.2-15.4c.2-1-.5-1.6-1.4-1.1zM9 13.9l9-6.2-7 7.2-.3 3.2z"/>',
};

const SOCIAL_ICON: Record<SocialNetwork, string> = {
	discord: "discord",
	instagram: "instagram",
	facebook: "facebook",
	x: "x",
	youtube: "youtube",
	tiktok: "tiktok",
	linkedin: "linkedin",
	github: "code",
	telegram: "telegram",
	whatsapp: "whatsapp",
	reddit: "reddit",
	twitch: "twitch",
	mastodon: "mastodon",
	pinterest: "pinterest",
	email: "mail",
	website: "globe",
};

export const SOCIAL_LABELS: Record<SocialNetwork, string> = {
	discord: "Discord",
	instagram: "Instagram",
	facebook: "Facebook",
	x: "X",
	youtube: "YouTube",
	tiktok: "TikTok",
	linkedin: "LinkedIn",
	github: "GitHub",
	telegram: "Telegram",
	whatsapp: "WhatsApp",
	reddit: "Reddit",
	twitch: "Twitch",
	mastodon: "Mastodon",
	pinterest: "Pinterest",
	email: "Email",
	website: "Website",
};

export function svg(name: string, size = 20): string {
	if (FILL[name]) return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${FILL[name]}</svg>`;
	const body = STROKE[name] ?? STROKE.spark;
	return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function icon(name: string, size = 20, className = "sf-icon"): HTMLElement {
	const span = document.createElement("span");
	span.className = className;
	span.innerHTML = svg(name, size);
	return span;
}

export function socialIcon(network: SocialNetwork, size = 20): HTMLElement {
	return icon(SOCIAL_ICON[network], size);
}
