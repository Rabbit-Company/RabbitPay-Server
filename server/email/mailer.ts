import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import Vault from "../crypto/vault";
import Validate from "../validate";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { whiteLabelActive } from "../licensing";
import type { ProjectRow } from "../database/models";

export interface OutgoingEmail {
	to: string;
	senderName: string;
	replyTo: string | null;
	subject: string;
	text: string;
	html: string;
	attachments?: EmailAttachment[];
}

export interface EmailAttachment {
	filename: string;
	contentType: string;
	content: Buffer;
}

export interface EmailServer {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
	from_address: string;
}

let override: Transporter | null = null;
let defaultTransport: { signature: string; transport: Transporter } | null = null;
const projectTransports = new Map<string, { signature: string; transport: Transporter }>();

export function isEnabled(): boolean {
	const email = Settings.email;
	return email?.enabled === true && Boolean(email.host) && Boolean(email.from_address);
}

export function setTransport(replacement: Transporter | null) {
	override = replacement;
	defaultTransport = null;
	projectTransports.clear();
}

export function isEmailServer(value: unknown): value is EmailServer {
	if (value === null || typeof value !== "object") return false;
	const server = value as Partial<EmailServer>;
	return (
		typeof server.host === "string" &&
		server.host.trim().length > 0 &&
		server.host.length <= 255 &&
		Number.isInteger(server.port) &&
		server.port! >= 1 &&
		server.port! <= 65535 &&
		typeof server.secure === "boolean" &&
		typeof server.username === "string" &&
		server.username.length <= 255 &&
		typeof server.password === "string" &&
		server.password.length <= 500 &&
		Validate.email(server.from_address)
	);
}

export function sealEmailServer(server: EmailServer): string {
	return Vault.encrypt(JSON.stringify(server));
}

export function storedEmailServer(project: Pick<ProjectRow, "uuid" | "email_server">): EmailServer | null {
	if (!project.email_server) return null;
	try {
		const parsed = JSON.parse(Vault.decrypt(project.email_server)) as unknown;
		return isEmailServer(parsed) ? parsed : null;
	} catch (err) {
		Logger.error(`[EMAIL] Could not read the email server of ${project.uuid}: ${err}`);
		return null;
	}
}

export function projectEmailServer(project: Pick<ProjectRow, "uuid" | "email_server" | "white_label_until">): EmailServer | null {
	if (!whiteLabelActive(project)) return null;
	return storedEmailServer(project);
}

export function canEmail(project: Pick<ProjectRow, "uuid" | "email_server" | "white_label_until">): boolean {
	return isEnabled() || projectEmailServer(project) !== null;
}

function createTransport(server: Omit<EmailServer, "from_address">): Transporter {
	return nodemailer.createTransport({
		host: server.host,
		port: server.port || 587,
		secure: server.secure === true,
		auth: server.username ? { user: server.username, pass: server.password } : undefined,
		connectionTimeout: 15000,
		greetingTimeout: 15000,
		socketTimeout: 30000,
	});
}

function defaultTransporter(): Transporter {
	if (override) return override;

	const signature = JSON.stringify(Settings.email);
	if (defaultTransport && defaultTransport.signature === signature) return defaultTransport.transport;

	defaultTransport = { signature, transport: createTransport(Settings.email) };
	return defaultTransport.transport;
}

function projectTransporter(projectId: string, server: EmailServer): Transporter {
	if (override) return override;

	const signature = JSON.stringify(server);
	const cached = projectTransports.get(projectId);
	if (cached && cached.signature === signature) return cached.transport;

	const created = createTransport(server);
	projectTransports.set(projectId, { signature, transport: created });
	return created;
}

export async function sendEmail(message: OutgoingEmail, route: { projectId: string; server: EmailServer } | null = null): Promise<string> {
	const sender = route ? projectTransporter(route.projectId, route.server) : defaultTransporter();
	const info = await sender.sendMail({
		from: { name: message.senderName, address: route ? route.server.from_address : Settings.email.from_address },
		to: message.to,
		replyTo: message.replyTo ?? undefined,
		subject: message.subject,
		text: message.text,
		html: message.html,
		attachments: message.attachments && message.attachments.length > 0 ? message.attachments : undefined,
	});
	return String(info.messageId ?? "");
}
