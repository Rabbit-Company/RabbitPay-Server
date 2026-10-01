import { Api, type Company, type LedgerIssue, type OpenItem, type OpenItemsKind, type OpenItemsReport, type PartnerOpenItems } from "../api";
import { el, emptyState, field, input, saveFile, select, table } from "../dom";
import { formatDate, formatMoney, fromDateInput, toDateInput } from "../money";
import { can, Permission } from "../access";
import { t, type UiKey } from "../i18n";
import { reportError } from "../ui";
import { loadProject } from "./project";
import { baseCurrency, ledgerPage, moneyCell, numeric, showNotices, summaryCards } from "./accounting";
import type { DateFormat } from "../../../server/formats";
import type { AgingBucket } from "../../../server/accounting/types";

const BUCKETS: AgingBucket[] = ["current", "1_30", "31_60", "61_90", "91_180", "over_180"];
const KINDS: OpenItemsKind[] = ["receivable", "payable", "all"];

function partnerLabel(partner: Pick<PartnerOpenItems, "name">): string {
	return partner.name || t("open.no_name");
}

function iopLink(uuid: string, date: string, partner: string | null): string {
	const query = new URLSearchParams({ date });
	if (partner) query.set("partner", partner);
	return `/projects/${uuid}/accounting/open-items/print?${query}`;
}

function itemsTable(items: OpenItem[], currency: string, dateFormat: DateFormat, timezone: string): HTMLElement {
	return table(
		[
			t("open.document"),
			t("open.date_issued"),
			t("open.due"),
			t("open.account"),
			numeric(t("open.amount")),
			numeric(t("open.open")),
			numeric(t("open.overdue_days")),
		],
		items.map((item) =>
			el(
				"tr",
				{},
				el("td", {}, t(`open.type_${item.type}` as UiKey), item.reference ? el("div", { class: "muted mono" }, item.reference) : null),
				el("td", { class: "date" }, formatDate(item.date, dateFormat, timezone)),
				el("td", { class: "date" }, item.due_date === null ? "" : formatDate(item.due_date, dateFormat, timezone)),
				el("td", { class: "code" }, item.account),
				moneyCell(item.amount, currency, { zero: true }),
				el(
					"td",
					{ class: "num" },
					formatMoney(item.open, currency),
					item.currency && item.currency !== currency ? el("div", { class: "muted" }, formatMoney(item.open_foreign, item.currency)) : null
				),
				el("td", { class: item.days_overdue > 0 ? "num warn" : "num muted" }, item.days_overdue > 0 ? String(item.days_overdue) : "")
			)
		)
	);
}

export async function openItemsView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const dateFormat = project.date_format as DateFormat;
	const date = input("date", { value: toDateInput(Date.now(), project.timezone), required: true });
	const kind = select(
		KINDS.map((value) => ({ value, label: t(`open.kind_${value}` as UiKey) })),
		"receivable"
	);
	const search = input("search", { placeholder: t("open.search") });
	const notice = el("div", { class: "stack" });
	const summary = el("div", {});
	const body = el("div", { class: "stack" });
	let report: (OpenItemsReport & { issues: LedgerIssue[] }) | null = null;
	const sign = () => (kind.value === "payable" ? -1 : 1);

	const show = () => {
		if (!report) return;
		const wanted = search.value.trim().toLowerCase();
		const partners = report.partners.filter((partner) => !wanted || `${partner.name} ${partner.tax_number ?? ""}`.toLowerCase().includes(wanted));
		const rows: HTMLElement[] = [];
		for (const partner of partners) {
			const cell = el("td", {}, itemsTable(partner.items, currency, dateFormat, project.timezone));
			cell.colSpan = BUCKETS.length + 4;
			const details = el("tr", { class: "open-items-details" }, cell);
			details.hidden = true;
			rows.push(
				el(
					"tr",
					{},
					el("td", {}, el("strong", {}, partnerLabel(partner)), partner.tax_number ? el("div", { class: "muted mono" }, partner.tax_number) : null),
					moneyCell(partner.receivable, currency),
					moneyCell(partner.payable, currency),
					...BUCKETS.map((bucket) => moneyCell(sign() * partner.aging[bucket], currency, { warn: bucket !== "current" && partner.aging[bucket] !== 0 })),
					el(
						"td",
						{ class: "actions" },
						el(
							"button",
							{
								class: "button ghost small",
								type: "button",
								onClick: () => {
									details.hidden = !details.hidden;
								},
							},
							t("open.items")
						),
						el("a", { class: "button ghost small", href: iopLink(uuid, date.value, partner.key), target: "_blank" }, t("open.iop"))
					)
				),
				details
			);
		}
		body.replaceChildren(
			...report.accounts
				.filter((account) => account.difference !== 0)
				.map((account) =>
					el(
						"p",
						{ class: "ledger-notice warn" },
						t("open.difference", { account: `${account.code} ${account.name}`, amount: formatMoney(account.difference, currency) })
					)
				),
			partners.length === 0
				? emptyState(t("open.empty"))
				: table(
						[
							t("open.partner"),
							numeric(t("open.receivable")),
							numeric(t("open.payable")),
							...BUCKETS.map((bucket) => numeric(t(`open.aging_${bucket}` as UiKey))),
							"",
						],
						rows
					)
		);
	};

	const render = async () => {
		if (!date.value) return;
		try {
			report = await Api.openItems(uuid, { date: fromDateInput(date.value, project.timezone), kind: kind.value as OpenItemsKind });
			showNotices(notice, project, report.issues);
			const items = report.partners.flatMap((partner) => partner.items);
			const total = (wanted: "receivable" | "payable") => items.filter((item) => item.kind === wanted).reduce((sum, item) => sum + item.open, 0);
			const overdue = items.filter((item) => item.kind === "receivable" && item.days_overdue > 0).reduce((sum, item) => sum + item.open, 0);
			summary.replaceChildren(
				summaryCards(
					[
						kind.value !== "payable" ? ([t("open.total_receivable"), formatMoney(total("receivable"), currency)] as [string, string]) : null,
						kind.value !== "payable" ? ([t("open.total_overdue"), formatMoney(overdue, currency)] as [string, string]) : null,
						kind.value !== "receivable" ? ([t("open.total_payable"), formatMoney(-total("payable"), currency)] as [string, string]) : null,
					].filter((card): card is [string, string] => card !== null)
				)
			);
			show();
		} catch (error) {
			reportError(error);
		}
	};
	date.addEventListener("change", () => void render());
	kind.addEventListener("change", () => void render());
	search.addEventListener("input", show);
	await render();

	const exportButton = can(project, Permission.REPORT_EXPORT)
		? el(
				"button",
				{
					class: "button ghost",
					type: "button",
					onClick: async () => {
						try {
							const file = await Api.exportOpenItems(uuid, { date: fromDateInput(date.value, project.timezone), kind: kind.value as OpenItemsKind });
							saveFile(file.blob, file.name);
						} catch (error) {
							reportError(error);
						}
					},
				},
				t("accounting.export_csv")
			)
		: null;
	const printAll = el(
		"button",
		{ class: "button ghost", type: "button", onClick: () => window.open(iopLink(uuid, date.value, null), "_blank") },
		t("open.iop_all")
	);

	return ledgerPage(
		project,
		"open",
		{ title: t("open.title"), intro: t("open.intro"), actions: [exportButton, printAll] },
		notice,
		el("div", { class: "ledger-controls" }, field(t("open.date"), date), field(t("open.kind"), kind), field(t("open.search"), search)),
		summary,
		body
	);
}

function spanning(cell: HTMLTableCellElement, columns: number): HTMLTableCellElement {
	cell.colSpan = columns;
	return cell;
}

function companyLines(company: Company | null, fallback: string): string[] {
	if (!company) return [fallback];
	return [
		company.legal_name || fallback,
		company.address_line1,
		company.address_line2,
		[company.postal_code, company.city].filter(Boolean).join(" "),
		company.tax_number || company.vat_number ? t("iop.tax_number", { number: (company.vat_number || company.tax_number)! }) : null,
	].filter((line): line is string => Boolean(line));
}

function statement(partner: PartnerOpenItems, sender: string[], currency: string, until: number, dateFormat: DateFormat, timezone: string): HTMLElement {
	const asOf = formatDate(until, dateFormat, timezone);
	const debit = partner.items.reduce((sum, item) => sum + Math.max(item.open, 0), 0);
	const credit = partner.items.reduce((sum, item) => sum + Math.max(-item.open, 0), 0);
	const block = (label: string, lines: string[]) =>
		el(
			"div",
			{ class: "iop-party" },
			el("p", { class: "doc-muted" }, label),
			...lines.map((line, index) => el("p", {}, index === 0 ? el("strong", {}, line) : line))
		);
	return el(
		"div",
		{ class: "document iop-sheet" },
		el(
			"div",
			{ class: "iop-parties" },
			block(t("iop.sender"), sender),
			block(t("iop.recipient"), [
				partnerLabel(partner),
				...partner.address,
				...(partner.tax_number ? [t("iop.tax_number", { number: partner.tax_number })] : []),
			])
		),
		el("h1", { class: "iop-title" }, t("iop.title")),
		el("p", {}, el("strong", {}, t("iop.as_of", { date: asOf }))),
		el("p", {}, t("iop.intro", { date: asOf })),
		el(
			"table",
			{ class: "iop-table" },
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					el("th", {}, t("open.document")),
					el("th", {}, t("open.date_issued")),
					el("th", {}, t("open.due")),
					el("th", { class: "num" }, t("iop.debit")),
					el("th", { class: "num" }, t("iop.credit"))
				)
			),
			el(
				"tbody",
				{},
				...partner.items.map((item) =>
					el(
						"tr",
						{},
						el("td", {}, `${t(`open.type_${item.type}` as UiKey)} ${item.reference ?? ""}`),
						el("td", {}, formatDate(item.date, dateFormat, timezone)),
						el("td", {}, item.due_date === null ? "" : formatDate(item.due_date, dateFormat, timezone)),
						el("td", { class: "num" }, item.open > 0 ? formatMoney(item.open, currency) : ""),
						el("td", { class: "num" }, item.open < 0 ? formatMoney(-item.open, currency) : "")
					)
				),
				el(
					"tr",
					{ class: "iop-total" },
					spanning(el("td", {}, el("strong", {}, t("accounting.total"))), 3),
					el("td", { class: "num" }, el("strong", {}, formatMoney(debit, currency))),
					el("td", { class: "num" }, el("strong", {}, formatMoney(credit, currency)))
				)
			)
		),
		el(
			"p",
			{ class: "iop-balance" },
			el(
				"strong",
				{},
				partner.balance >= 0
					? t("iop.balance_owed", { amount: formatMoney(partner.balance, currency) })
					: t("iop.balance_owing", { amount: formatMoney(-partner.balance, currency) })
			)
		),
		el(
			"div",
			{ class: "iop-reply" },
			el("p", {}, `[ ] ${t("iop.confirm")}`),
			el("p", {}, `[ ] ${t("iop.dispute")}`),
			el("div", { class: "iop-lines" }),
			el(
				"div",
				{ class: "iop-signatures" },
				el("div", {}, el("div", { class: "iop-sign-line" }), el("p", { class: "doc-muted" }, t("iop.place_date"))),
				el("div", {}, el("div", { class: "iop-sign-line" }), el("p", { class: "doc-muted" }, t("iop.signature")))
			)
		)
	);
}

export async function iopPrintView(uuid: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const currency = baseCurrency(project);
	const params = new URLSearchParams(window.location.search);
	const day = params.get("date") ?? toDateInput(Date.now(), project.timezone);
	const until = fromDateInput(day, project.timezone);
	const wanted = params.get("partner");
	const [report, company] = await Promise.all([Api.openItems(uuid, { date: until, kind: "all" }), Api.company(uuid).catch(() => null)]);
	const partners = report.partners.filter((partner) => (wanted ? partner.key === wanted : partner.balance !== 0));
	const sender = companyLines(company, project.display_name ?? project.name);
	const actions = el(
		"div",
		{ class: "doc-actions no-print" },
		el("a", { class: "button ghost", href: `/projects/${uuid}/accounting/open-items` }, t("iop.back")),
		el("button", { class: "button primary", type: "button", onClick: () => window.print() }, t("iop.print"))
	);
	return el(
		"div",
		{ class: "print-page" },
		actions,
		partners.length === 0
			? emptyState(t("iop.none"))
			: el(
					"div",
					{ class: "iop-pages" },
					...partners.map((partner) => statement(partner, sender, currency, until, project.date_format as DateFormat, project.timezone))
				)
	);
}
