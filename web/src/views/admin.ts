import {
	AdminApi,
	ApiError,
	getUsername,
	type AdminAccount,
	type AdminLegal,
	type DeletionPlan,
	type LegalKind,
	type AdminBackups,
	type AdminProject,
	type AdminSettings,
	type ConnectionStatus,
	type License,
	type LicenseInput,
	type LicenseType,
	type RegistrationInvite,
	type RegistrationMode,
	type SettingValue,
} from "../api";
import { el, emptyState, field, input, saveFile, select, table } from "../dom";
import { formatBytes, formatDate, formatDateTime, formatMoney, toMajorUnits, toMinorUnits } from "../money";
import { currentPath } from "../router";
import { confirmDialog, modal, reportError, toast } from "../ui";
import { SETTING_GROUPS, type SettingField } from "../../../server/settings-schema";
import { markdownEditor } from "../markdown-editor";
import { LICENSE_VENDOR } from "../../../server/license-vendor";
import { redeemFlow } from "./license";

const PAGE_SIZE = 50;

const ADMIN_TABS = [
	{ label: "Overview", href: "/admin" },
	{ label: "License keys", href: "/admin/licenses" },
	{ label: "Projects", href: "/admin/projects" },
	{ label: "Accounts", href: "/admin/accounts" },
	{ label: "Invite codes", href: "/admin/invites" },
	{ label: "Legal", href: "/admin/legal" },
	{ label: "Settings", href: "/admin/settings" },
];

const REGISTRATION_MODES: Record<RegistrationMode, string> = {
	open: "Anyone can register right now. Invite codes are not needed until you switch registrations to invite only.",
	invite: "Registration needs one of these codes. People invited to a project can register with their invitation link.",
	closed: "Registration is closed, so these codes cannot be used right now.",
};

const INVITE_STATES: Record<RegistrationInvite["state"], { label: string; pill: string }> = {
	active: { label: "active", pill: "active" },
	used_up: { label: "used up", pill: "open" },
	expired: { label: "expired", pill: "canceled" },
	revoked: { label: "revoked", pill: "canceled" },
};

const LICENSE_STATUS_FILTERS = [
	{ value: "", label: "All statuses" },
	{ value: "available", label: "Available" },
	{ value: "redeemed", label: "Redeemed" },
	{ value: "revoked", label: "Revoked" },
];

const LICENSE_TYPE_FILTERS = [
	{ value: "", label: "All types" },
	{ value: "transactions", label: "Transactions" },
	{ value: "white_label", label: "White label" },
	{ value: "storage", label: "Storage" },
	{ value: "store", label: "Online store" },
	{ value: "workforce", label: "Workforce" },
	{ value: "employees", label: "Employee seats" },
	{ value: "accounting", label: "Accounting" },
];

const LICENSE_PILLS: Record<License["status"], string> = { available: "open", redeemed: "active", revoked: "canceled" };

function adminLayout(content: HTMLElement): HTMLElement {
	const path = currentPath();
	const tabs = ADMIN_TABS.map((tab) => {
		const active = tab.href === "/admin" ? path === "/admin" : path.startsWith(tab.href);
		return el("a", { class: `tab ${active ? "active" : ""}`, href: tab.href }, tab.label);
	});

	return el(
		"div",
		{ class: "page page-admin" },
		el(
			"div",
			{ class: "page-head" },
			el(
				"div",
				{},
				el("a", { class: "back-link", href: "/" }, "All projects"),
				el("h1", {}, "Administration"),
				el("p", { class: "muted" }, "Settings and licenses for this whole server.")
			)
		),
		el("nav", { class: "tabs" }, ...tabs),
		content
	);
}

function serverIdPanel(identity: { license_issuer: boolean; server_id: string }): HTMLElement {
	return el(
		"section",
		{ class: "card stack" },
		el(
			"div",
			{ class: "security-head" },
			el("h2", {}, "Server ID"),
			identity.license_issuer ? el("span", { class: "pill pill-active" }, "license issuer") : null
		),
		el(
			"div",
			{ class: "copy-row" },
			el("code", { class: "secret mono" }, identity.server_id),
			el("button", { class: "button ghost small", type: "button", onClick: () => void copyText(identity.server_id, "Server ID") }, "Copy")
		),
		identity.license_issuer
			? el(
					"p",
					{ class: "muted" },
					"This server signs license keys. Enter a customer's Server ID when creating keys to sign them for their self-hosted server."
				)
			: el(
					"p",
					{ class: "muted" },
					`Buy license keys for this server from ${LICENSE_VENDOR.name} at `,
					el("a", { href: LICENSE_VENDOR.url, target: "_blank", rel: "noopener" }, LICENSE_VENDOR.url.replace(/^https:\/\//, "")),
					" or ",
					el("a", { href: `mailto:${LICENSE_VENDOR.email}` }, LICENSE_VENDOR.email),
					" and give this Server ID with your order. Each key only works on this server."
				)
	);
}

function statCard(label: string, value: string): HTMLElement {
	return el("div", { class: "card stat" }, el("span", { class: "stat-value" }, value), el("span", { class: "stat-label" }, label));
}

export function describeLicense(license: Pick<License, "type" | "transactions" | "duration_days" | "storage_gb" | "employees">): string {
	if (license.type === "transactions") return `${(license.transactions ?? 0).toLocaleString()} payments`;
	const days = license.duration_days ?? 0;
	if (license.type === "storage") return `${(license.storage_gb ?? 0).toLocaleString()} GB storage for ${days} ${days === 1 ? "day" : "days"}`;
	if (license.type === "employees") {
		const employees = license.employees ?? 0;
		return `${employees.toLocaleString()} ${employees === 1 ? "employee" : "employees"} for ${days} ${days === 1 ? "day" : "days"}`;
	}
	const names: Record<string, string> = { store: "Online store", workforce: "Workforce", accounting: "Accounting" };
	const name = names[license.type] ?? "White label";
	return `${name} for ${days} ${days === 1 ? "day" : "days"}`;
}

async function copyText(text: string, label: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast(`${label} copied`, "success");
	} catch {
		toast("Could not copy automatically. Select the text and copy it.", "error");
	}
}

function pager<T>(load: (offset: number) => Promise<{ items: T[]; total: number }>, row: (item: T) => HTMLElement, headers: string[], empty: string) {
	const container = el("div", { class: "stack" });

	const render = async () => {
		container.replaceChildren(el("div", { class: "spinner" }, el("span", {})));
		try {
			const first = await load(0);
			if (first.items.length === 0) {
				container.replaceChildren(emptyState(empty));
				return;
			}

			const rows = first.items.map(row);
			const listing = table(headers, rows);
			const body = listing.querySelector("tbody")!;
			let loaded = first.items.length;

			const more = el("button", { class: "button ghost", type: "button" });
			const footer = el("div", { class: "line-actions" }, more);
			const sync = () => {
				footer.hidden = loaded >= first.total;
				more.textContent = `Load more (${first.total - loaded} left)`;
			};

			more.addEventListener("click", async () => {
				more.disabled = true;
				try {
					const next = await load(loaded);
					for (const item of next.items) body.appendChild(row(item));
					loaded = next.items.length === 0 ? first.total : loaded + next.items.length;
				} catch (error) {
					reportError(error);
				}
				more.disabled = false;
				sync();
			});

			sync();
			container.replaceChildren(el("p", { class: "muted" }, `${first.total.toLocaleString()} in total`), listing, footer);
		} catch (error) {
			container.replaceChildren(emptyState(error instanceof Error ? error.message : "Could not load this list."));
		}
	};

	return { element: container, refresh: render };
}

function debounce(run: () => void, wait = 250) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return () => {
		clearTimeout(timer);
		timer = setTimeout(run, wait);
	};
}

export async function adminOverviewView(): Promise<HTMLElement> {
	const overview = await AdminApi.overview();

	const revenue =
		overview.revenue.length === 0
			? el("p", { class: "muted" }, "No sold license keys have a price yet.")
			: el(
					"ul",
					{ class: "recent" },
					...overview.revenue.map((entry) =>
						el(
							"li",
							{},
							el("span", {}, `${entry.count} ${entry.count === 1 ? "key" : "keys"}`),
							el("span", { class: "mono" }, formatMoney(entry.amount, entry.currency))
						)
					)
				);

	return adminLayout(
		el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "grid stats" },
				statCard("Accounts", overview.accounts.toLocaleString()),
				statCard("Projects", overview.projects.toLocaleString()),
				statCard(`Payments in ${overview.period}`, overview.payments_this_month.toLocaleString()),
				statCard("White labeled projects", overview.white_labeled.toLocaleString()),
				statCard("Open online stores", overview.stores.toLocaleString()),
				statCard("Unused license keys", overview.licenses_available.toLocaleString()),
				statCard("Redeemed license keys", overview.licenses_redeemed.toLocaleString())
			),
			serverIdPanel(overview),
			el(
				"div",
				{ class: "card" },
				el("h2", {}, "License sales"),
				el("p", { class: "muted" }, "Totals of every key that was not revoked, by the price you recorded."),
				revenue,
				el("a", { class: "button ghost", href: "/admin/licenses" }, "Manage license keys")
			)
		)
	);
}

function licenseForm(onCreated: (licenses: License[]) => void) {
	const type = select(
		[
			{ value: "transactions", label: "Transactions" },
			{ value: "white_label", label: "White label" },
			{ value: "storage", label: "Storage" },
			{ value: "store", label: "Online store" },
			{ value: "workforce", label: "Workforce (timesheets, tickets, employees)" },
			{ value: "employees", label: "Employee seats" },
			{ value: "accounting", label: "Accounting (ledger, books, year end)" },
		],
		"transactions"
	);
	const transactions = input("number", { min: "1", step: "1", value: "10000", required: true });
	const days = input("number", { min: "1", max: "3650", step: "1", value: "30", required: true });
	const storage = input("number", { min: "1", max: "1000000", step: "1", value: "10", required: true });
	const employees = input("number", { min: "1", max: "1000000", step: "1", value: "10", required: true });
	const quantity = input("number", { min: "1", max: "100", step: "1", value: "1", required: true });
	const server = input("text", { placeholder: "Leave empty for a key used on this server", autocomplete: "off", maxlength: "27" });
	const price = input("number", { min: "0", step: "0.01", placeholder: "Optional" });
	const currency = input("text", { value: "EUR", maxlength: "3" });
	const buyerName = input("text", { placeholder: "Optional", maxlength: "120" });
	const buyerEmail = input("email", { placeholder: "Optional" });
	const note = el("textarea", { rows: "2", maxlength: "500", placeholder: "Optional, for example an order number" }) as HTMLTextAreaElement;
	const submit = el("button", { class: "button primary", type: "submit" }, "Create keys");

	const transactionsField = field("Payments", transactions, "Added to the project's paid balance. They never expire.");
	const daysField = field(
		"Days",
		days,
		"Starts when the key is redeemed. Add-on keys add to any time left, and each employee seat or storage key runs on its own."
	);
	const storageField = field("Storage in GB", storage, "Added to the project's document storage capacity, for the days below.");
	const employeesField = field("Employees", employees, "Added to the people the workforce license covers, for the days below.");

	const sync = () => {
		const transactionsSelected = type.value === "transactions";
		const storageSelected = type.value === "storage";
		const white =
			type.value === "white_label" ||
			type.value === "store" ||
			type.value === "workforce" ||
			type.value === "employees" ||
			type.value === "accounting" ||
			storageSelected;
		const employeesSelected = type.value === "employees";
		transactionsField.hidden = !transactionsSelected;
		daysField.hidden = !white;
		storageField.hidden = !storageSelected;
		employeesField.hidden = !employeesSelected;
		transactions.required = transactionsSelected;
		days.required = white;
		storage.required = storageSelected;
		employees.required = employeesSelected;
	};
	type.addEventListener("change", sync);
	sync();

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;

				const code = currency.value.trim().toUpperCase();
				const body: LicenseInput = {
					type: type.value as LicenseType,
					quantity: Number(quantity.value),
					price: price.value === "" ? null : toMinorUnits(Number(price.value), code),
					currency: price.value === "" ? null : code,
					buyer_name: buyerName.value.trim() || null,
					buyer_email: buyerEmail.value.trim() || null,
					note: note.value.trim() || null,
					server_id: server.value.trim() || null,
				};
				if (body.type === "transactions") body.transactions = Number(transactions.value);
				else body.duration_days = Number(days.value);
				if (body.type === "storage") body.storage_gb = Number(storage.value);
				if (body.type === "employees") body.employees = Number(employees.value);

				try {
					const created = await AdminApi.createLicenses(body);
					dialog.close();
					onCreated(created);
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "form-grid" },
			field("Type", type),
			transactionsField,
			employeesField,
			daysField,
			storageField,
			field("How many keys", quantity, "Up to 100 at once")
		),
		field("For a self-hosted server", server, "The customer's Server ID from their Admin overview. The key is signed and only works on that server."),
		el("h3", {}, "Purchase"),
		el("div", { class: "form-grid" }, field("Price per key", price), field("Currency", currency), field("Buyer", buyerName), field("Buyer email", buyerEmail)),
		field("Note", note),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal("New license keys", form);
}

function licenseText(license: License): string {
	return license.signed_key ?? license.code;
}

function createdDialog(licenses: License[]) {
	const codes = licenses.map(licenseText).join("\n");
	const signedFor = licenses[0].server_id;
	modal(
		licenses.length === 1 ? "License key created" : `${licenses.length} license keys created`,
		el(
			"div",
			{ class: "stack" },
			el(
				"p",
				{},
				`${describeLicense(licenses[0])}${signedFor ? ` for server ${signedFor}` : ""}. Give ${licenses.length === 1 ? "this key" : "these keys"} to the buyer. They redeem it under License in their project.`
			),
			el(
				"code",
				{ class: "secret license-key-text" },
				...licenses.flatMap((license, index) => (index === 0 ? [licenseText(license)] : [el("br", {}), licenseText(license)]))
			),
			el("button", { class: "button primary", type: "button", onClick: () => void copyText(codes, licenses.length === 1 ? "Key" : "Keys") }, "Copy")
		)
	);
}

function editLicenseDialog(license: License, onSaved: () => void) {
	const price = input("number", {
		min: "0",
		step: "0.01",
		value: license.price !== null && license.currency ? String(toMajorUnits(license.price, license.currency)) : "",
		placeholder: "Not recorded",
	});
	const currency = input("text", { value: license.currency ?? "EUR", maxlength: "3" });
	const buyerName = input("text", { value: license.buyer_name ?? "", maxlength: "120" });
	const buyerEmail = input("email", { value: license.buyer_email ?? "" });
	const note = el("textarea", { rows: "2", maxlength: "500" }) as HTMLTextAreaElement;
	note.value = license.note ?? "";
	const submit = el("button", { class: "button primary", type: "submit" }, "Save");

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				const code = currency.value.trim().toUpperCase();
				try {
					await AdminApi.updateLicense(license.uuid, {
						price: price.value === "" ? null : toMinorUnits(Number(price.value), code),
						currency: price.value === "" ? null : code,
						buyer_name: buyerName.value.trim() || null,
						buyer_email: buyerEmail.value.trim(),
						note: note.value.trim() || null,
					});
					dialog.close();
					toast("License updated", "success");
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("p", { class: "mono" }, license.code),
		el("div", { class: "form-grid" }, field("Price", price), field("Currency", currency), field("Buyer", buyerName), field("Buyer email", buyerEmail)),
		field("Note", note),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal("Purchase details", form);
}

export async function adminLicensesView(): Promise<HTMLElement> {
	const identity = await AdminApi.settings();
	const status = select(LICENSE_STATUS_FILTERS, "");
	const type = select(LICENSE_TYPE_FILTERS, "");
	const search = input("search", { placeholder: "Search code, buyer or note" });

	const row = (license: License): HTMLElement => {
		const actions: HTMLElement[] = [
			el("button", { class: "button ghost small", type: "button", onClick: () => void copyText(licenseText(license), "Key") }, "Copy"),
			el("button", { class: "button ghost small", type: "button", onClick: () => editLicenseDialog(license, list.refresh) }, "Edit"),
		];

		if (license.status === "available" && license.signed_key === null) {
			actions.push(
				el(
					"button",
					{
						class: "button danger small",
						type: "button",
						onClick: async () => {
							const confirmed = await confirmDialog({
								title: "Revoke license key",
								body: `${license.code} can no longer be redeemed. This cannot be undone.`,
								confirmLabel: "Revoke",
								destructive: true,
							});
							if (!confirmed) return;
							try {
								await AdminApi.revokeLicense(license.uuid);
								toast("License key revoked", "success");
								void list.refresh();
							} catch (error) {
								reportError(error);
							}
						},
					},
					"Revoke"
				)
			);
		}

		const redeemed =
			license.status === "redeemed"
				? el(
						"div",
						{},
						license.project_name ?? "Deleted project",
						el("div", { class: "muted" }, `${license.redeemed_by ?? ""} on ${formatDate(license.redeemed_at)}`)
					)
				: license.status === "revoked"
					? el("span", { class: "muted" }, `Revoked ${formatDate(license.revoked_at)}`)
					: el("span", { class: "muted" }, "Not used yet");

		return el(
			"tr",
			{},
			el("td", { class: "mono" }, license.code, license.server_id ? el("div", { class: "muted" }, `Signed for ${license.server_id}`) : null),
			el("td", {}, describeLicense(license)),
			el("td", {}, el("span", { class: `pill pill-${LICENSE_PILLS[license.status]}` }, license.status)),
			el(
				"td",
				{},
				license.buyer_name ?? "",
				license.buyer_email ? el("div", { class: "muted" }, license.buyer_email) : null,
				license.note ? el("div", { class: "muted" }, license.note) : null
			),
			el("td", { class: "mono" }, license.price !== null && license.currency ? formatMoney(license.price, license.currency) : ""),
			el("td", {}, redeemed),
			el("td", {}, formatDate(license.created)),
			el("td", {}, el("div", { class: "line-actions" }, ...actions))
		);
	};

	const list = pager(
		async (offset) => {
			const result = await AdminApi.licenses({ status: status.value, type: type.value, search: search.value.trim(), limit: PAGE_SIZE, offset });
			return { items: result.licenses, total: result.total };
		},
		row,
		["Key", "Grants", "Status", "Buyer", "Price", "Used by", "Created", ""],
		"No license keys match."
	);

	status.addEventListener("change", () => void list.refresh());
	type.addEventListener("change", () => void list.refresh());
	search.addEventListener(
		"input",
		debounce(() => void list.refresh())
	);
	void list.refresh();

	const create = el(
		"button",
		{
			class: "button primary",
			type: "button",
			onClick: () =>
				licenseForm((created) => {
					createdDialog(created);
					void list.refresh();
				}),
		},
		"New license keys"
	);

	return adminLayout(
		el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "card" },
				el("h2", {}, "How licenses work"),
				el(
					"p",
					{ class: "muted" },
					"Every project gets free completed payments each month and included document storage. Transaction keys add paid payments, storage keys permanently add capacity, and white label keys unlock branding for a number of days."
				)
			),
			serverIdPanel(identity),
			el("div", { class: "toolbar" }, status, type, search, identity.license_issuer ? create : el("span", {})),
			list.element
		)
	);
}

function freeLimitDialog(project: AdminProject, defaultAllowance: () => number, onSaved: () => void) {
	const custom = input("checkbox");
	custom.checked = project.free_transactions !== null;
	const amount = input("number", { min: "0", step: "1", value: String(project.free_transactions ?? project.free_allowance), required: true });
	const amountField = field("Free payments per month", amount);
	const submit = el("button", { class: "button primary", type: "submit" }, "Save");

	const sync = () => {
		amountField.hidden = !custom.checked;
	};
	custom.addEventListener("change", sync);
	sync();

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					await AdminApi.updateProject(project.uuid, { free_transactions: custom.checked ? Number(amount.value) : null });
					dialog.close();
					toast("Free payments updated", "success");
					onSaved();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el("label", { class: "switch" }, custom, el("span", {}, "Use a custom limit for this project")),
		el("p", { class: "muted" }, `Without one, the server default of ${defaultAllowance().toLocaleString()} applies.`),
		amountField,
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(`Free payments for ${project.name}`, form);
}

function applyLicenseDialog(project: AdminProject, onApplied: () => void) {
	const code = input("text", { placeholder: "RPAY-XXXXX-XXXXX-XXXXX-XXXXX", required: true, autocomplete: "off" });
	const check = el("button", { class: "button primary", type: "submit" }, "Check key");
	const { panel, onSubmit } = redeemFlow(
		code,
		check,
		(value) => AdminApi.previewLicense(project.uuid, value),
		async (value, startsAt) => {
			await AdminApi.applyLicense(project.uuid, value, startsAt);
			dialog.close();
			toast("License applied", "success");
			onApplied();
		}
	);

	const form = el(
		"form",
		{ class: "stack", onSubmit },
		el("p", { class: "muted" }, "Redeems an unused key on this project, as if a member had entered it. Check the key to choose when it starts."),
		el("div", { class: "toolbar redeem-row" }, code, check),
		panel
	);

	const dialog = modal(`Apply a license to ${project.name}`, form);
	code.focus();
}

export async function adminProjectsView(): Promise<HTMLElement> {
	const settings = await AdminApi.settings();
	const defaultAllowance = () => Number((settings.license_issuer ? settings.values : settings.defaults)["licensing.free_transactions"]);
	const search = input("search", { placeholder: "Search name, owner or id" });

	const row = (project: AdminProject): HTMLElement => {
		const whiteLabel = project.white_label_until && project.white_label_until > Date.now() ? `Until ${formatDate(project.white_label_until)}` : "No";
		const store = project.store_until && project.store_until > Date.now() ? `Until ${formatDate(project.store_until)}` : "No";
		const workforce = project.workforce_until && project.workforce_until > Date.now() ? `Until ${formatDate(project.workforce_until)}` : "No";
		const accounting = project.accounting_until && project.accounting_until > Date.now() ? `Until ${formatDate(project.accounting_until)}` : "No";
		const storage =
			project.storage_limit === null
				? `${formatBytes(project.storage_used)} / unlimited`
				: `${formatBytes(project.storage_used)} / ${formatBytes(project.storage_limit)}`;

		return el(
			"tr",
			{},
			el("td", {}, el("strong", {}, project.display_name ?? project.name), el("div", { class: "muted mono" }, project.uuid)),
			el("td", {}, project.created_by),
			el(
				"td",
				{ class: "mono" },
				`${project.free_used.toLocaleString()} / ${project.free_allowance.toLocaleString()}`,
				project.free_transactions !== null ? el("div", { class: "muted" }, "custom limit") : null
			),
			el("td", { class: project.paid_balance < 0 ? "mono warn" : "mono" }, project.paid_balance.toLocaleString()),
			el("td", { class: "mono" }, storage),
			el("td", {}, whiteLabel),
			el("td", {}, store),
			el("td", {}, workforce),
			el("td", {}, accounting),
			el("td", {}, formatDate(project.created)),
			el(
				"td",
				{},
				el(
					"div",
					{ class: "line-actions" },
					settings.license_issuer
						? el(
								"button",
								{ class: "button ghost small", type: "button", onClick: () => freeLimitDialog(project, defaultAllowance, list.refresh) },
								"Free limit"
							)
						: null,
					el("button", { class: "button ghost small", type: "button", onClick: () => applyLicenseDialog(project, list.refresh) }, "Apply key")
				)
			)
		);
	};

	const list = pager(
		async (offset) => {
			const result = await AdminApi.projects({ search: search.value.trim(), limit: PAGE_SIZE, offset });
			return { items: result.projects, total: result.total };
		},
		row,
		["Project", "Owner", "Free used this month", "Paid balance", "Storage", "White label", "Online store", "Workforce", "Accounting", "Created", ""],
		"No projects match."
	);

	search.addEventListener(
		"input",
		debounce(() => void list.refresh())
	);
	void list.refresh();

	return adminLayout(
		el(
			"div",
			{ class: "stack" },
			el(
				"p",
				{ class: "muted" },
				settings.license_issuer
					? `Projects get ${defaultAllowance().toLocaleString()} free completed payments a month unless you set their own limit. A negative paid balance means payments arrived after the project ran out, and the next key covers them.`
					: `Projects get ${defaultAllowance().toLocaleString()} free completed payments a month. A negative paid balance means payments arrived after the project ran out, and the next key covers them.`
			),
			el("div", { class: "toolbar" }, search, el("span", {})),
			list.element
		)
	);
}

async function exportAccountData(username: string) {
	try {
		const file = await AdminApi.exportAccount(username);
		saveFile(file.blob, file.name);
	} catch (error) {
		reportError(error);
	}
}

async function deleteAccountDialog(username: string, onDeleted: () => void) {
	let plan: DeletionPlan;
	try {
		plan = await AdminApi.deletionPlan(username);
	} catch (error) {
		reportError(error);
		return;
	}

	const projectList = (projects: DeletionPlan["shared"]) => el("ul", {}, ...projects.map((project) => el("li", {}, el("strong", {}, project.name))));

	if (plan.shared.length > 0) {
		modal(
			`${username} cannot be deleted yet`,
			el(
				"div",
				{ class: "stack" },
				el("p", {}, `${username} is the only owner of these projects, and other people still use them:`),
				projectList(plan.shared),
				el("p", { class: "muted" }, "Ask them to make another member an owner, or remove the other members, then try again.")
			)
		);
		return;
	}

	const confirmation = input("text", { autocomplete: "off", placeholder: username });
	const submit = el("button", { class: "button danger", type: "submit", disabled: true }, "Delete account");
	confirmation.addEventListener("input", () => {
		submit.disabled = confirmation.value.trim() !== username;
	});

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				if (confirmation.value.trim() !== username) return;
				submit.disabled = true;
				try {
					await AdminApi.deleteAccount(username);
					dialog.close();
					toast(`${username} was deleted`, "success");
					onDeleted();
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"p",
			{},
			"This permanently deletes the sign-in, email address, two-factor settings, security keys, accepted terms and access logs of this account, and removes the IP addresses from its audit entries. It cannot be undone."
		),
		el(
			"p",
			{ class: "muted" },
			"Business records stay with their projects. Invoices, timesheets and payroll the account worked on keep the name recorded on them, because the business must keep those records."
		),
		plan.closing.length > 0 ? el("p", {}, "These projects have no other members and will be closed:") : null,
		plan.closing.length > 0 ? projectList(plan.closing) : null,
		el("p", { class: "muted" }, "Export the data first if the person asked for a copy."),
		field(`Type ${username} to confirm`, confirmation),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal(`Delete ${username}`, form);
	confirmation.focus();
}

export function adminAccountsView(): HTMLElement {
	const me = getUsername();
	const search = input("search", { placeholder: "Search username or email" });

	const update = async (account: AdminAccount, changes: { admin?: boolean; status?: string }, message: string) => {
		try {
			await AdminApi.updateAccount(account.username, changes);
			toast(message, "success");
			void list.refresh();
		} catch (error) {
			reportError(error);
		}
	};

	const row = (account: AdminAccount): HTMLElement => {
		const self = account.username === me;
		const actions = self
			? [el("span", { class: "muted" }, "This is you")]
			: [
					el(
						"button",
						{
							class: "button ghost small",
							type: "button",
							onClick: () => void update(account, { admin: !account.admin }, account.admin ? "Administrator access removed" : "Made an administrator"),
						},
						account.admin ? "Remove admin" : "Make admin"
					),
					el(
						"button",
						{
							class: `button ${account.status === "active" ? "danger" : "ghost"} small`,
							type: "button",
							onClick: async () => {
								if (account.status === "active") {
									const confirmed = await confirmDialog({
										title: `Suspend ${account.username}`,
										body: "They are signed out on their next request and cannot sign in until you reactivate them. Their projects keep working.",
										confirmLabel: "Suspend",
										destructive: true,
									});
									if (!confirmed) return;
								}
								void update(
									account,
									{ status: account.status === "active" ? "suspended" : "active" },
									account.status === "active" ? "Account suspended" : "Account reactivated"
								);
							},
						},
						account.status === "active" ? "Suspend" : "Reactivate"
					),
					account.two_factor_enabled
						? el(
								"button",
								{
									class: "button ghost small",
									type: "button",
									onClick: async () => {
										const confirmed = await confirmDialog({
											title: `Reset two-factor authentication for ${account.username}`,
											body: "This removes their security keys, authenticator app and recovery codes so they can sign in with only their password. Only do this after you have confirmed who is asking. They can set up two-factor authentication again from their account page.",
											confirmLabel: "Reset 2FA",
											destructive: true,
										});
										if (!confirmed) return;
										try {
											await AdminApi.resetTwoFactor(account.username);
											toast("Two-factor authentication reset", "success");
											void list.refresh();
										} catch (error) {
											reportError(error);
										}
									},
								},
								"Reset 2FA"
							)
						: null,
					el("button", { class: "button ghost small", type: "button", onClick: () => void exportAccountData(account.username) }, "Export data"),
					el(
						"button",
						{ class: "button danger small", type: "button", onClick: () => void deleteAccountDialog(account.username, () => void list.refresh()) },
						"Delete"
					),
				];

		return el(
			"tr",
			{},
			el("td", {}, el("strong", {}, account.username), account.admin ? el("span", { class: "pill pill-owner" }, "admin") : null),
			el("td", {}, account.email),
			el("td", {}, String(account.projects)),
			el("td", {}, el("span", { class: `pill pill-${account.status === "active" ? "active" : "canceled"}` }, account.status)),
			el("td", {}, account.two_factor_enabled ? el("span", { class: "pill pill-active" }, "on") : el("span", { class: "muted" }, "off")),
			el("td", {}, formatDate(account.created)),
			el("td", {}, formatDate(account.accessed)),
			el("td", {}, el("div", { class: "line-actions" }, ...actions))
		);
	};

	const list = pager(
		async (offset) => {
			const result = await AdminApi.accounts({ search: search.value.trim(), limit: PAGE_SIZE, offset });
			return { items: result.accounts, total: result.total };
		},
		row,
		["Account", "Email", "Projects", "Status", "2FA", "Registered", "Last seen", ""],
		"No accounts match."
	);

	search.addEventListener(
		"input",
		debounce(() => void list.refresh())
	);
	void list.refresh();

	return adminLayout(el("div", { class: "stack" }, el("div", { class: "toolbar" }, search, el("span", {})), list.element));
}

function inviteLink(code: string): string {
	return `${window.location.origin}/login?${new URLSearchParams({ mode: "register", invite: code })}`;
}

function inviteForm(onCreated: (invite: RegistrationInvite) => void) {
	const uses = input("number", { min: "1", max: "100000", step: "1", value: "1", placeholder: "Unlimited" });
	const days = input("number", { min: "1", max: "3650", step: "1", value: "14", placeholder: "Never" });
	const note = el("textarea", { rows: "2", maxlength: "500", placeholder: "Optional, for example who it is for" }) as HTMLTextAreaElement;
	const submit = el("button", { class: "button primary", type: "submit" }, "Create code");

	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: async (event) => {
				event.preventDefault();
				submit.disabled = true;
				try {
					const created = await AdminApi.createInvite({
						max_uses: uses.value === "" ? null : Number(uses.value),
						expires_at: days.value === "" ? null : Date.now() + Number(days.value) * 24 * 60 * 60 * 1000,
						note: note.value.trim() || null,
					});
					dialog.close();
					onCreated(created);
				} catch (error) {
					reportError(error);
					submit.disabled = false;
				}
			},
		},
		el(
			"div",
			{ class: "form-grid" },
			field("Uses", uses, "How many accounts can register with it. Leave empty for unlimited."),
			field("Valid for days", days, "Leave empty to never expire.")
		),
		field("Note", note),
		el("div", { class: "dialog-actions" }, submit)
	);

	const dialog = modal("New invite code", form);
}

function inviteCreatedDialog(invite: RegistrationInvite) {
	const link = inviteLink(invite.code);
	modal(
		"Invite code created",
		el(
			"div",
			{ class: "stack" },
			el("p", {}, "Share the code, or the link that fills it in on the registration form."),
			el("code", { class: "secret" }, invite.code),
			el("code", { class: "secret" }, link),
			el(
				"div",
				{ class: "line-actions" },
				el("button", { class: "button primary", type: "button", onClick: () => void copyText(invite.code, "Code") }, "Copy code"),
				el("button", { class: "button ghost", type: "button", onClick: () => void copyText(link, "Link") }, "Copy link")
			)
		)
	);
}

export async function adminInvitesView(): Promise<HTMLElement> {
	const settings = await AdminApi.settings();
	const mode = settings.values["registrations.mode"] as RegistrationMode;
	const search = input("search", { placeholder: "Search code or note" });

	const row = (invite: RegistrationInvite): HTMLElement => {
		const state = INVITE_STATES[invite.state];
		const actions: HTMLElement[] = [
			el("button", { class: "button ghost small", type: "button", onClick: () => void copyText(invite.code, "Code") }, "Copy"),
			el("button", { class: "button ghost small", type: "button", onClick: () => void copyText(inviteLink(invite.code), "Link") }, "Copy link"),
		];

		if (invite.state !== "revoked") {
			actions.push(
				el(
					"button",
					{
						class: "button danger small",
						type: "button",
						onClick: async () => {
							const confirmed = await confirmDialog({
								title: "Revoke invite code",
								body: `${invite.code} can no longer be used to register. Accounts already created with it stay. This cannot be undone.`,
								confirmLabel: "Revoke",
								destructive: true,
							});
							if (!confirmed) return;
							try {
								await AdminApi.revokeInvite(invite.uuid);
								toast("Invite code revoked", "success");
								void list.refresh();
							} catch (error) {
								reportError(error);
							}
						},
					},
					"Revoke"
				)
			);
		}

		return el(
			"tr",
			{},
			el("td", { class: "mono" }, invite.code),
			el("td", {}, el("span", { class: `pill pill-${state.pill}` }, state.label)),
			el("td", { class: "mono" }, invite.max_uses === null ? `${invite.uses} / unlimited` : `${invite.uses} / ${invite.max_uses}`),
			el("td", {}, invite.expires_at === null ? el("span", { class: "muted" }, "Never") : formatDateTime(invite.expires_at)),
			el("td", {}, invite.note ?? ""),
			el("td", {}, formatDate(invite.created), invite.created_by ? el("div", { class: "muted" }, invite.created_by) : null),
			el("td", {}, el("div", { class: "line-actions" }, ...actions))
		);
	};

	const list = pager(
		async (offset) => {
			const result = await AdminApi.invites({ search: search.value.trim(), limit: PAGE_SIZE, offset });
			return { items: result.invites, total: result.total };
		},
		row,
		["Code", "Status", "Used", "Expires", "Note", "Created", ""],
		"No invite codes yet."
	);

	search.addEventListener(
		"input",
		debounce(() => void list.refresh())
	);
	void list.refresh();

	const create = el(
		"button",
		{
			class: "button primary",
			type: "button",
			onClick: () =>
				inviteForm((created) => {
					inviteCreatedDialog(created);
					void list.refresh();
				}),
		},
		"New invite code"
	);

	return adminLayout(
		el(
			"div",
			{ class: "stack" },
			el(
				"div",
				{ class: "card" },
				el("h2", {}, "Registrations"),
				el("p", { class: "muted" }, REGISTRATION_MODES[mode] ?? REGISTRATION_MODES.open),
				el("a", { class: "button ghost", href: "/admin/settings?section=registrations" }, "Change who can register")
			),
			el("div", { class: "toolbar" }, search, create),
			list.element
		)
	);
}

function settingControl(
	definition: SettingField,
	state: AdminSettings
): { control: HTMLInputElement | HTMLSelectElement; read: () => SettingValue | null | undefined } {
	const value = state.values[definition.key];

	switch (definition.kind) {
		case "boolean": {
			const control = input("checkbox");
			control.checked = value === true;
			return { control, read: () => control.checked };
		}
		case "choice": {
			const control = select(definition.choices ?? [], String(value));
			return { control, read: () => control.value };
		}
		case "number": {
			const control = input("number", {
				value: String(value),
				step: "1",
				min: definition.min === undefined ? undefined : String(definition.min),
				max: definition.max === undefined ? undefined : String(definition.max),
				required: true,
			});
			return { control, read: () => Number(control.value) };
		}
		case "secret": {
			const set = state.secrets[definition.key];
			const control = input("password", { placeholder: set ? "Set, leave blank to keep" : "Not set", autocomplete: "new-password" });
			return { control, read: () => (control.value === "" ? undefined : control.value) };
		}
		default: {
			const control = input("text", { value: String(value ?? "") });
			return { control, read: () => control.value.trim() };
		}
	}
}

function settingsGroup(group: (typeof SETTING_GROUPS)[number], state: AdminSettings, onSaved: (next: AdminSettings) => void): HTMLElement {
	const readers = new Map<string, () => SettingValue | null | undefined>();
	const clears = new Set<string>();

	const rows = group.fields.map((definition) => {
		const { control, read } = settingControl(definition, state);
		readers.set(definition.key, read);

		const hintParts = [definition.hint, definition.restart ? "Takes effect after a restart." : null].filter(Boolean).join(" ");

		if (definition.kind === "boolean") {
			return el(
				"div",
				{ class: "field" },
				el("label", { class: "switch" }, control, el("span", {}, definition.label)),
				hintParts ? el("span", { class: "field-hint" }, hintParts) : null
			);
		}

		const wrapper = field(definition.label, control, hintParts || undefined);
		if (definition.kind === "secret" && state.secrets[definition.key]) {
			const clear = el(
				"button",
				{
					class: "link-button",
					type: "button",
					onClick: () => {
						clears.add(definition.key);
						(control as HTMLInputElement).value = "";
						(control as HTMLInputElement).placeholder = "Will be cleared when you save";
						clear.remove();
					},
				},
				"Clear"
			);
			wrapper.appendChild(clear);
		}
		return wrapper;
	});

	const changes = () => {
		const values: Record<string, SettingValue | null> = {};
		for (const [key, read] of readers) {
			if (clears.has(key)) {
				values[key] = null;
				continue;
			}
			const value = read();
			if (value !== undefined && String(value) !== String(state.values[key])) values[key] = value;
		}
		return values;
	};

	const save = el("button", { class: "button primary", type: "submit" }, `Save ${group.label.toLowerCase()}`);
	const extras = group.id === "backups" ? backupPanel() : group.testable ? connectionPanel(group.id, group.label, changes) : null;

	return el(
		"form",
		{
			class: "card stack",
			onSubmit: async (event) => {
				event.preventDefault();
				save.disabled = true;

				const values = changes();

				if (Object.keys(values).length === 0) {
					toast("Nothing changed", "info");
					save.disabled = false;
					return;
				}

				try {
					const next = await AdminApi.updateSettings(values);
					const restart = next.restart_required ?? [];
					toast(restart.length > 0 ? "Saved. Restart the server to apply everything." : "Settings saved", "success");
					onSaved(next);
				} catch (error) {
					reportError(error);
					save.disabled = false;
				}
			},
		},
		el("h2", {}, group.label),
		el("p", { class: "muted" }, group.description),
		el("div", { class: "form-grid" }, ...rows),
		extras?.status ?? null,
		el("div", { class: "form-actions" }, save, extras?.run ?? null)
	);
}

function connectionSummary(label: string, result: ConnectionStatus): string {
	if (result.network === null && result.height === null) return "The API answers address lookups.";
	const chain = result.network === null ? label : `${label} ${result.network}`;
	return result.height === null ? `${chain}.` : `${chain} at block ${result.height.toLocaleString()}.`;
}

function connectionPanel(group: string, label: string, changes: () => Record<string, SettingValue | null>): { status: HTMLElement; run: HTMLButtonElement } {
	const status = el("div", { class: "stack-tight" });
	status.hidden = true;

	const show = (pill: string, outcome: string, lines: string[]) =>
		status.replaceChildren(el("div", {}, el("span", { class: `pill ${pill}` }, outcome)), ...lines.map((line) => el("p", { class: "muted" }, line)));

	const run = el(
		"button",
		{
			class: "button",
			type: "button",
			onClick: async () => {
				run.disabled = true;
				status.hidden = false;
				status.replaceChildren(el("p", { class: "muted" }, "Testing the connection"));
				try {
					const result = await AdminApi.testSettings(group, changes());
					show(result.warnings.length > 0 ? "pill-pending" : "pill-active", "Connected", [connectionSummary(label, result), ...result.warnings]);
				} catch (error) {
					show("pill-overdue", "Failed", [error instanceof ApiError ? error.message : "The server could not be reached."]);
				} finally {
					run.disabled = false;
				}
			},
		},
		"Test connection"
	) as HTMLButtonElement;

	return { status, run };
}

const DESTINATION_LABELS: Record<string, string> = { directory: "Directory", s3: "S3" };

function backupPanel(): { status: HTMLElement; run: HTMLButtonElement } {
	const status = el("div", { class: "stack" }, el("p", { class: "muted" }, "Loading backups"));

	const show = (state: AdminBackups) => {
		if (!state.supported) {
			status.replaceChildren(el("p", { class: "muted" }, "This server does not use a SQLite database file, so automatic backups are not available."));
			run.disabled = true;
			return;
		}
		run.disabled = state.running;
		const lines = state.destinations.map((destination) => {
			const label = DESTINATION_LABELS[destination.target] ?? destination.target;
			if (destination.error) return el("p", { class: "muted" }, `${label}: could not be read. ${destination.error}`);
			const [latest] = destination.backups;
			return el(
				"p",
				{ class: "muted" },
				latest ? `${label}: ${destination.backups.length} backups, latest ${formatDateTime(latest.created)}` : `${label}: no backups yet`
			);
		});
		status.replaceChildren(...(state.problem ? [el("p", { class: "muted" }, state.problem)] : lines));
	};

	const refresh = () => void AdminApi.backups().then(show, () => status.replaceChildren(el("p", { class: "muted" }, "Could not load backups")));

	const run = el(
		"button",
		{
			class: "button",
			type: "button",
			onClick: async () => {
				run.disabled = true;
				try {
					const result = await AdminApi.runBackup();
					const partial = result.failed.length > 0 ? ` Failed for ${result.failed.map((failure) => failure.target).join(", ")}.` : "";
					toast(`Backup ${result.name} stored (${formatBytes(result.size)}).${partial}`, partial ? "info" : "success");
				} catch (error) {
					reportError(error);
				} finally {
					run.disabled = false;
					refresh();
				}
			},
		},
		"Back up now"
	) as HTMLButtonElement;

	refresh();
	return { status, run };
}

export async function adminSettingsView(): Promise<HTMLElement> {
	const container = el("div", { class: "stack" });
	const filter = select(
		[{ value: "", label: "All sections" }, ...SETTING_GROUPS.map((group) => ({ value: group.id, label: group.label }))],
		new URLSearchParams(window.location.search).get("section") ?? ""
	);

	const render = (state: AdminSettings) => {
		const shown = SETTING_GROUPS.filter((group) => filter.value === "" || group.id === filter.value);
		container.replaceChildren(
			state.master_key_configured
				? el("span", {})
				: el(
						"div",
						{ class: "card notice" },
						el("h2", {}, "No master key"),
						el(
							"p",
							{},
							"RABBITPAY_MASTER_KEY is not set, so secret settings and project payment credentials cannot be stored. Generate one with openssl rand -base64 48, add it to the .env file next to the server and restart."
						)
					),
			...shown.map((group) =>
				group.id === "licensing" && !state.license_issuer
					? el(
							"section",
							{ class: "card stack" },
							el("h2", {}, group.label),
							el(
								"p",
								{ class: "muted" },
								`Every project gets ${Number(state.defaults["licensing.free_transactions"]).toLocaleString()} free completed payments a month and ${Number(state.defaults["licensing.free_storage_gb"]).toLocaleString()} GB of document storage, and a workforce license covers ${Number(state.defaults["licensing.free_employees"]).toLocaleString()} employees. More is added with license keys that ${LICENSE_VENDOR.name} signs for this server's ID, shown on the Overview tab.`
							)
						)
					: settingsGroup(group, state, (next) => render(next))
			)
		);
	};

	filter.addEventListener("change", () => {
		const url = new URL(window.location.href);
		if (filter.value) url.searchParams.set("section", filter.value);
		else url.searchParams.delete("section");
		history.replaceState({}, "", url);
		void AdminApi.settings().then(render, reportError);
	});

	render(await AdminApi.settings());

	return adminLayout(
		el(
			"div",
			{ class: "stack" },
			el(
				"p",
				{ class: "muted" },
				"Stored in the database and shared by every instance that uses it. Only the master key and the database connection live in the environment."
			),
			el("div", { class: "toolbar" }, filter, el("span", {})),
			container
		)
	);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LEGAL_NOTICE_DAYS = 30;

function dateInputValue(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

const LEGAL_TITLES: Record<LegalKind, string> = { terms: "Terms of Service", privacy: "Privacy Policy" };
const LEGAL_LANGUAGES = [
	{ value: "en", label: "English" },
	{ value: "sl", label: "Slovenščina" },
] as const;

function operatorPanel(legal: AdminLegal): HTMLElement {
	const operator = legal.operator;
	if (!operator) {
		return el(
			"section",
			{ class: "card notice stack" },
			el("h2", {}, "Operator details"),
			el(
				"p",
				{ class: "muted" },
				"Businesses selling online must show who they are. Set the operator name, address, registration and tax numbers and a contact email first. They fill the legal notice page and the templates below."
			),
			el("div", {}, el("a", { class: "button primary", href: "/admin/settings" }, "Open settings"))
		);
	}

	const row = (label: string, value: string | null) => (value ? el("div", { class: "legal-row" }, el("dt", {}, label), el("dd", {}, value)) : null);
	return el(
		"section",
		{ class: "card stack" },
		el(
			"div",
			{ class: "security-head" },
			el("h2", {}, "Operator details"),
			el("a", { class: "button ghost small", href: "/admin/settings" }, "Edit in settings")
		),
		el(
			"dl",
			{ class: "legal-details" },
			row("Operator", operator.name),
			row("Address", operator.address),
			row("Business register", operator.register),
			row("Registration number", operator.registration_number),
			row("Tax number", operator.tax_number),
			row("VAT", operator.vat_status === "registered" ? (operator.vat_number ?? "Registered") : "Not registered"),
			row("Contact email", operator.email),
			row("Phone", operator.phone),
			row("Customers", legal.business_only ? "Businesses only" : "Businesses and consumers")
		),
		el("p", { class: "muted" }, "Shown to everyone at ", el("a", { href: "/legal", target: "_blank", rel: "noopener" }, "/legal"), ".")
	);
}

function legalDocumentPanel(kind: LegalKind, legal: AdminLegal, onPublished: () => void): HTMLElement {
	const state = legal.documents[kind];
	const latest = state.latest;
	const nextVersion = (latest?.version ?? 0) + 1;
	const editors = {
		en: markdownEditor({ value: latest?.content_en ?? "", rows: 22, maxlength: 100000 }),
		sl: markdownEditor({ value: latest?.content_sl ?? "", rows: 22, maxlength: 100000 }),
	};
	let active: "en" | "sl" = "sl";

	const tabs = LEGAL_LANGUAGES.map((language) => {
		const tab = el("button", { class: "segment", type: "button" }, language.label);
		tab.addEventListener("click", () => show(language.value));
		return tab;
	});
	const show = (language: "en" | "sl") => {
		active = language;
		tabs.forEach((tab, index) => tab.classList.toggle("active", LEGAL_LANGUAGES[index].value === language));
		editors.en.element.hidden = language !== "en";
		editors.sl.element.hidden = language !== "sl";
	};
	show(active);

	const template = el("button", { class: "button ghost", type: "button" }, "Fill from template");
	template.addEventListener("click", async () => {
		const textarea = editors[active].textarea;
		if (textarea.value.trim()) {
			const confirmed = await confirmDialog({
				title: "Replace this text",
				body: "The template replaces the text in the language you are editing. Nothing is published until you publish.",
				confirmLabel: "Replace",
				destructive: true,
			});
			if (!confirmed) return;
		}
		template.disabled = true;
		try {
			textarea.value = (await AdminApi.legalTemplate(kind, active)).content;
		} catch (error) {
			reportError(error);
		} finally {
			template.disabled = false;
		}
	});

	const today = dateInputValue(Date.now());
	const noticeDays = kind === "terms" && latest ? LEGAL_NOTICE_DAYS : 0;
	const effective = input("date", { value: dateInputValue(Date.now() + noticeDays * DAY_MS), min: today, max: dateInputValue(Date.now() + 365 * DAY_MS) });
	const notify = input("checkbox");
	notify.checked = legal.email_enabled && latest !== null;
	notify.disabled = !legal.email_enabled;
	const notifyField = el(
		"label",
		{ class: "legal-accept" },
		notify,
		el(
			"span",
			{},
			legal.email_enabled
				? `Email all ${legal.accounts.toLocaleString()} accounts about this version`
				: "Email all accounts about this version. Turn on email in Settings to use this."
		)
	);

	const publish = el("button", { class: "button primary", type: "button" }, `Publish version ${nextVersion}`);
	publish.addEventListener("click", async () => {
		const chosen = effective.value && effective.value > today ? Date.parse(`${effective.value}T00:00:00Z`) : null;
		const content = { content_en: editors.en.textarea.value.trim() || null, content_sl: editors.sl.textarea.value.trim() || null };
		if (!content.content_en || !content.content_sl) {
			const missing = content.content_en ? "Slovenian" : "English";
			if (!content.content_en && !content.content_sl) {
				toast("Write the document before publishing it", "error");
				return;
			}
			const confirmed = await confirmDialog({
				title: `Publish without ${missing}`,
				body: `Visitors who use ${missing} will see the other language with a note that no translation exists.`,
				confirmLabel: "Continue",
			});
			if (!confirmed) return;
		}
		const when = chosen === null ? "right away" : `on ${formatDate(chosen)}`;
		const confirmed = await confirmDialog({
			title: `Publish ${LEGAL_TITLES[kind]} version ${nextVersion}`,
			body:
				(kind === "terms"
					? `Published versions are kept forever and cannot be edited. This version takes effect ${when}. From then on every account must accept it the next time it opens RabbitPay. New accounts accept it when they register.`
					: `Published versions are kept forever and cannot be edited. This version takes effect ${when}.`) +
				(notify.checked ? " Every account gets an email about it now." : ""),
			confirmLabel: "Publish",
		});
		if (!confirmed) return;

		publish.disabled = true;
		try {
			const result = await AdminApi.publishLegal(kind, { ...content, effective: chosen, notify: notify.checked });
			toast(
				result.notified === null
					? `${LEGAL_TITLES[kind]} version ${nextVersion} published`
					: `${LEGAL_TITLES[kind]} version ${nextVersion} published. Emailing ${result.notified.toLocaleString()} accounts.`,
				"success"
			);
			onPublished();
		} catch (error) {
			reportError(error);
			publish.disabled = false;
		}
	});

	const history = state.versions.length
		? table(
				["Version", "Published", "Takes effect", "By", kind === "terms" ? "Accepted by" : "Acknowledged by"],
				state.versions.map((version) =>
					el(
						"tr",
						{},
						el("td", {}, String(version.version)),
						el("td", {}, formatDateTime(version.published)),
						el("td", {}, formatDate(version.effective), version.upcoming ? el("span", { class: "pill pill-pending" }, "scheduled") : null),
						el("td", {}, version.published_by ?? "-"),
						el("td", {}, `${version.accepted.toLocaleString()} of ${legal.accounts.toLocaleString()} accounts`)
					)
				)
			)
		: null;

	return el(
		"section",
		{ class: "card stack" },
		el(
			"div",
			{ class: "security-head" },
			el("h2", {}, LEGAL_TITLES[kind]),
			latest === null
				? el("span", { class: "pill pill-pending" }, "Not published")
				: latest.effective > Date.now()
					? el("span", { class: "pill pill-pending" }, `Version ${latest.version} | takes effect ${formatDate(latest.effective)}`)
					: el("span", { class: "pill pill-active" }, `Version ${latest.version} | in force since ${formatDate(latest.effective)}`)
		),
		el(
			"p",
			{ class: "muted" },
			kind === "terms"
				? "Registration requires accepting the latest version. Include the data processing agreement, because businesses store their customers' data here."
				: "Explains what personal data you process as the controller, why, for how long and which rights people have."
		),
		el("div", { class: "toolbar" }, el("div", { class: "segmented" }, ...tabs), el("span", {}), template),
		editors.en.element,
		editors.sl.element,
		el(
			"p",
			{ class: "field-hint" },
			"Templates are drafts built from your operator details and server settings. Review every section, especially hosting, subprocessors and retention, and have them checked by a lawyer before publishing."
		),
		el(
			"div",
			{ class: "form-grid" },
			field(
				"Takes effect on",
				effective,
				kind === "terms" && latest
					? `Defaults to ${LEGAL_NOTICE_DAYS} days from today, the notice period promised in the Terms. Until then the current version stays in force.`
					: "Today publishes it right away."
			),
			el("div", {})
		),
		latest ? notifyField : null,
		el("div", {}, publish),
		history ? el("h3", {}, "Published versions") : null,
		history
	);
}

export async function adminLegalView(): Promise<HTMLElement> {
	const container = el("div", { class: "stack" });
	const render = async () => {
		try {
			const legal = await AdminApi.legal();
			container.replaceChildren(operatorPanel(legal), legalDocumentPanel("terms", legal, render), legalDocumentPanel("privacy", legal, render));
		} catch (error) {
			reportError(error);
		}
	};
	await render();
	return adminLayout(container);
}
