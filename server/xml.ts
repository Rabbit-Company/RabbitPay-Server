export type XmlChild = XmlNode | string;

export interface XmlNode {
	name: string;
	attributes: Record<string, string>;
	namespaces: Record<string, string>;
	children: XmlChild[];
	compact: boolean;
}

interface CanonicalScope {
	declared: Map<string, string>;
	rendered: Map<string, string>;
}

export function node(name: string, ...children: (XmlChild | null | undefined | false)[]): XmlNode {
	return {
		name,
		attributes: {},
		namespaces: {},
		children: children.filter((child): child is XmlChild => child !== null && child !== undefined && child !== false),
		compact: false,
	};
}

export function withAttributes(target: XmlNode, attributes: Record<string, string>): XmlNode {
	return { ...target, attributes: { ...target.attributes, ...attributes } };
}

export function withNamespaces(target: XmlNode, namespaces: Record<string, string>): XmlNode {
	return { ...target, namespaces: { ...target.namespaces, ...namespaces } };
}

export function compact(target: XmlNode): XmlNode {
	return { ...target, compact: true };
}

export function withChild(target: XmlNode, child: XmlNode): XmlNode {
	return { ...target, children: [...target.children, child] };
}

function withoutControlCharacters(value: string): string {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}

function escapeText(value: string): string {
	return withoutControlCharacters(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
}

function escapeAttribute(value: string): string {
	return withoutControlCharacters(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/"/g, "&quot;")
		.replace(/\t/g, "&#x9;")
		.replace(/\n/g, "&#xA;")
		.replace(/\r/g, "&#xD;");
}

function prefixOf(name: string): string {
	const colon = name.indexOf(":");
	return colon === -1 ? "" : name.slice(0, colon);
}

function declaration(prefix: string, uri: string): string {
	return ` ${prefix ? `xmlns:${prefix}` : "xmlns"}="${escapeAttribute(uri)}"`;
}

function declarations(target: XmlNode, scope: CanonicalScope | null): { text: string; scope: CanonicalScope | null } {
	const own = Object.entries(target.namespaces).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	if (!scope) return { text: own.map(([prefix, uri]) => declaration(prefix, uri)).join(""), scope: null };

	const declared = new Map(scope.declared);
	for (const [prefix, uri] of own) declared.set(prefix, uri);
	const prefix = prefixOf(target.name);
	const uri = declared.get(prefix) ?? "";
	if ((scope.rendered.get(prefix) ?? "") === uri) return { text: "", scope: { declared, rendered: scope.rendered } };
	return { text: declaration(prefix, uri), scope: { declared, rendered: new Map(scope.rendered).set(prefix, uri) } };
}

function render(target: XmlNode, depth: number, pretty: boolean, scope: CanonicalScope | null): string {
	const namespaces = declarations(target, scope);
	const attributes = Object.keys(target.attributes)
		.sort()
		.map((key) => ` ${key}="${escapeAttribute(target.attributes[key])}"`)
		.join("");
	const open = `<${target.name}${namespaces.text}${attributes}>`;
	const close = `</${target.name}>`;
	const [only] = target.children;
	if (target.children.length === 1 && typeof only === "string") return `${open}${escapeText(only)}${close}`;

	const layout = pretty && !target.compact;
	const rendered = target.children.map((child) => (typeof child === "string" ? escapeText(child) : render(child, depth + 1, layout, namespaces.scope)));
	if (!layout) return `${open}${rendered.join("")}${close}`;

	const indent = `\n${"\t".repeat(depth + 1)}`;
	return `${open}${rendered.map((child) => `${indent}${child}`).join("")}\n${"\t".repeat(depth)}${close}`;
}

export function serialize(root: XmlNode): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n${render(root, 0, true, null)}\n`;
}

function pathTo(root: XmlNode, target: XmlNode): XmlNode[] | null {
	if (root === target) return [root];
	for (const child of root.children) {
		if (typeof child === "string") continue;
		const path = pathTo(child, target);
		if (path) return [root, ...path];
	}
	return null;
}

export function exclusiveCanonical(root: XmlNode, target: XmlNode): string {
	const path = pathTo(root, target);
	if (!path) throw new Error(`${target.name} is not part of the document`);

	const ancestors = path.slice(0, -1);
	const declared = new Map<string, string>();
	for (const ancestor of ancestors) for (const [prefix, uri] of Object.entries(ancestor.namespaces)) declared.set(prefix, uri);
	const pretty = ancestors.every((ancestor) => !ancestor.compact);

	return render(target, ancestors.length, pretty, { declared, rendered: new Map() });
}
