import { el } from "./dom";
import { t } from "./i18n";
import { icon } from "./storefront/icons";
import { onLeave } from "./router";

export interface LightboxImage {
	src: string;
	alt: string;
}

export function openLightbox(images: LightboxImage[], start = 0, onStep?: (index: number) => void) {
	if (images.length === 0) return;
	let index = start;
	const big = el("img", { src: images[index].src, alt: images[index].alt });
	big.setAttribute("referrerpolicy", "no-referrer");
	const step = (delta: number) => {
		index = (index + delta + images.length) % images.length;
		big.src = images[index].src;
		big.alt = images[index].alt;
		onStep?.(index);
	};
	const close = () => {
		overlay.remove();
		window.removeEventListener("keydown", onKey, true);
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key === "Escape") close();
		else if (event.key === "ArrowRight" && images.length > 1) step(1);
		else if (event.key === "ArrowLeft" && images.length > 1) step(-1);
		else return;
		event.preventDefault();
		event.stopPropagation();
	};
	const closeButton = el("button", { class: "sf-lightbox-close sf-icon-button", type: "button", title: t("ui.close"), onClick: close }, icon("close", 26));
	const overlay = el(
		"div",
		{ class: "sf-lightbox" },
		big,
		closeButton,
		images.length > 1 ? el("button", { class: "sf-lightbox-prev sf-icon-button", type: "button", onClick: () => step(-1) }, icon("left", 28)) : null,
		images.length > 1 ? el("button", { class: "sf-lightbox-next sf-icon-button", type: "button", onClick: () => step(1) }, icon("right", 28)) : null
	);
	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) close();
	});
	window.addEventListener("keydown", onKey, true);
	onLeave(close);
	(document.querySelector(".sf") ?? document.body).append(overlay);
	closeButton.focus();
}

export function zoomableImages(container: HTMLElement) {
	const images = [...container.querySelectorAll("img")].filter((image) => !image.closest("a"));
	images.forEach((image, position) => {
		image.classList.add("zoomable");
		image.title = t("shop.zoom");
		image.addEventListener("click", () =>
			openLightbox(
				images.map((candidate) => ({ src: candidate.src, alt: candidate.alt })),
				position
			)
		);
	});
}
