import logoUrl from "../favicon.svg";

export function logo(): HTMLElement {
	const node = document.createElement("img");
	node.className = "logo";
	node.src = logoUrl;
	node.alt = "";
	node.width = 32;
	node.height = 32;
	return node;
}
