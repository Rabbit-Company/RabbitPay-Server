import { ApiError, type CreditNoteDocument, type InvoiceDocument, type StoreAddress, type StoreFulfillment, type TicketKind, type TicketStatus } from "./api";
import { navigate } from "./router";
import { language } from "./i18n";

const TOKEN_KEY = "rabbitpay.customer.token";

export function customerToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function storeCustomerSession(token: string) {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearCustomerSession() {
	localStorage.removeItem(TOKEN_KEY);
}

export async function customerFetch(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<Response> {
	const headers: Record<string, string> = {};
	const token = customerToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	try {
		return await fetch(`/api/v1${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			cache: "no-store",
		});
	} catch {
		throw new ApiError(-1, 0, "Could not reach the server.");
	}
}

function send(path: string, body?: unknown, method?: string): Promise<Response> {
	return customerFetch(`/customer${path}`, body, method);
}

async function payload<T>(response: Response, authenticated: boolean): Promise<T> {
	const result = (await response.json()) as { error: number; info: string; data: T };
	if (result.error !== 0) {
		if (authenticated && [1000, 1016, 1017].includes(result.error)) {
			clearCustomerSession();
			navigate("/customer/login", true);
		}
		throw new ApiError(result.error, response.status, result.info);
	}
	return result.data;
}

async function request<T>(path: string, body?: unknown, authenticated = true, method?: string): Promise<T> {
	return await payload<T>(await send(path, body, method), authenticated);
}

export interface CustomerProfile extends StoreAddress {
	email: string;
	customer_type: "individual" | "business";
	company: string | null;
	vat_number: string | null;
	tax_number: string | null;
	shipping_same: boolean;
	shipping: StoreAddress | null;
	saved: boolean;
	updated: number | null;
}

export type CustomerProfileInput = Omit<CustomerProfile, "email" | "saved" | "updated">;

export interface CustomerOrder {
	invoice: string;
	reference: string;
	store: string;
	store_url: string | null;
	fulfillment: StoreFulfillment;
	payment_status: string;
	currency: string;
	total_amount: number;
	outstanding: number;
	tracking_url: string | null;
	created: number;
}

export interface CustomerInvoice {
	uuid: string;
	reference: string;
	merchant: string;
	status: string;
	currency: string;
	total_amount: number;
	outstanding: number;
	issued: number;
	due_date: number;
	language: string;
	date_format: string;
	timezone: string;
}

export interface CustomerInvoiceDetails {
	document: InvoiceDocument;
	credit_notes: { uuid: string; reference: string; currency: string; total_amount: number; issued: number; reason: string | null }[];
}

async function documentFile(kind: "invoices" | "credit-notes", uuid: string, format: "pdf" | "eslog", contentType: string): Promise<Blob> {
	const response = await send(`/${kind}/${encodeURIComponent(uuid)}/${format}`);
	if (!response.ok || !response.headers.get("Content-Type")?.includes(contentType)) {
		await payload<never>(response, true);
		throw new ApiError(-1, response.status, "The server returned an unreadable response.");
	}
	return await response.blob();
}

export interface CustomerTicket {
	uuid: string;
	number: number;
	title: string;
	description: string | null;
	kind: TicketKind;
	status: TicketStatus;
	priority: string;
	merchant: string;
	assignees: (string | null)[];
	due_on: string | null;
	reported_by_me: boolean;
	closed_at: number | null;
	created: number;
	updated: number;
}

export interface CustomerTicketComment {
	uuid: string;
	author_name: string;
	from_customer: boolean;
	body: string;
	mine: boolean;
	created: number;
}

export interface CustomerTicketDetails extends CustomerTicket {
	can_comment: boolean;
	comments: CustomerTicketComment[];
}

export interface CustomerTicketAccess {
	project: string;
	merchant: string;
	kinds: TicketKind[];
}

export const CustomerApi = {
	requestLogin(email: string, options: { store?: string; return?: string } = {}) {
		return request<void>("/auth/request", { email, language: language(), ...options }, false);
	},
	verify(token: string) {
		return request<{ token: string; email: string; expires_in: number }>("/auth/verify", { token }, false);
	},
	me() {
		return request<{ email: string; tickets: boolean }>("/auth/me");
	},
	logout() {
		return request<void>("/auth/logout", {});
	},
	invoices(status: string, offset: number, limit: number) {
		const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
		if (status) query.set("status", status);
		return request<{ invoices: CustomerInvoice[]; total: number }>(`/invoices?${query}`);
	},
	invoice(uuid: string) {
		return request<CustomerInvoiceDetails>(`/invoices/${encodeURIComponent(uuid)}`);
	},
	profile() {
		return request<CustomerProfile>("/profile");
	},
	saveProfile(profile: CustomerProfileInput) {
		return request<CustomerProfile>("/profile", profile, true, "PUT");
	},
	clearProfile() {
		return request<CustomerProfile>("/profile", undefined, true, "DELETE");
	},
	orders(offset: number, limit: number) {
		return request<{ orders: CustomerOrder[]; total: number }>(`/orders?offset=${offset}&limit=${limit}`);
	},
	async exportData(): Promise<Blob> {
		const response = await send("/export");
		if (!response.ok || !response.headers.get("Content-Disposition")) {
			await payload<never>(response, true);
			throw new ApiError(-1, response.status, "The server returned an unreadable response.");
		}
		return await response.blob();
	},
	tickets(status: string) {
		return request<CustomerTicket[]>(`/tickets${status ? `?status=${encodeURIComponent(status)}` : ""}`);
	},
	ticket(uuid: string) {
		return request<CustomerTicketDetails>(`/tickets/${encodeURIComponent(uuid)}`);
	},
	commentTicket(uuid: string, body: string) {
		return request<CustomerTicketComment>(`/tickets/${encodeURIComponent(uuid)}/comments`, { body });
	},
	ticketAccess() {
		return request<CustomerTicketAccess[]>("/ticket-access");
	},
	createTicket(ticket: { project: string; kind: TicketKind; title: string; description: string | null }) {
		return request<CustomerTicket>("/tickets", ticket);
	},
	deleteAccount() {
		return request<void>("/account", undefined, true, "DELETE");
	},
	creditNote(uuid: string) {
		return request<CreditNoteDocument>(`/credit-notes/${encodeURIComponent(uuid)}`);
	},
	pdf(kind: "invoices" | "credit-notes", uuid: string): Promise<Blob> {
		return documentFile(kind, uuid, "pdf", "application/pdf");
	},
	eslog(kind: "invoices" | "credit-notes", uuid: string): Promise<Blob> {
		return documentFile(kind, uuid, "eslog", "application/xml");
	},
};
