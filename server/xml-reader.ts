export interface XmlElement {
	name: string;
	attributes: Record<string, string>;
	children: XmlElement[];
	text: string;
}

export class XmlSyntaxError extends Error {}

interface BunXmlNode {
	name: string;
	attributes: Record<string, string>;
	children: (string | BunXmlNode | { comment: string } | { target: string; data: string })[];
}

function localName(name: string): string {
	const colon = name.indexOf(":");
	return colon === -1 ? name : name.slice(colon + 1);
}

function isElement(node: BunXmlNode["children"][number]): node is BunXmlNode {
	return typeof node === "object" && "name" in node;
}

function toElement(node: BunXmlNode): XmlElement {
	return {
		name: localName(node.name),
		attributes: node.attributes,
		children: node.children.filter(isElement).map(toElement),
		text: node.children.filter((child): child is string => typeof child === "string").join(""),
	};
}

export function parseXml(source: string): XmlElement {
	try {
		return toElement(Bun.XML.parse(source, { compact: false }) as BunXmlNode);
	} catch (err) {
		if (err instanceof SyntaxError || err instanceof RangeError) throw new XmlSyntaxError(err.message.replace(/^XML Parse error: /, ""));
		throw err;
	}
}

export function child(element: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
	let current = element;
	for (const name of path) current = current?.children.find((candidate) => candidate.name === name);
	return current;
}

export function children(element: XmlElement | undefined, name: string): XmlElement[] {
	return element ? element.children.filter((candidate) => candidate.name === name) : [];
}

export function textOf(element: XmlElement | undefined, ...path: string[]): string | null {
	const found = child(element, ...path);
	const value = found?.text.trim();
	return value ? value : null;
}

export function decodeXmlBytes(bytes: Uint8Array): string {
	const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
	const declared = /^﻿?<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
	try {
		return new TextDecoder((declared ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0], { fatal: true }).decode(bytes);
	} catch {
		throw new XmlSyntaxError(declared ? `The file is not valid ${declared} text.` : "The file is not valid UTF-8 text.");
	}
}
