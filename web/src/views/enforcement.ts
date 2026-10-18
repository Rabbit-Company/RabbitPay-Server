import {
	DunningApi,
	EnforcementApi,
	type DunningLetterDetail,
	type EnforcementClaim,
	type EnforcementInput,
	type EnforcementIssue,
	type EnforcementParty,
	type EnforcementPlan,
	type EnforcementProposal,
	type EnforcementProposalDetail,
	type Project,
} from "../api";
import { can, Permission } from "../access";
import { el, field, input, replaceContent, saveFile, table } from "../dom";
import { formatDate, formatMoney } from "../money";
import { navigate } from "../router";
import { accountName, confirmDialog, modal, reportError, toast } from "../ui";
import { actionMenu, type MenuLink } from "../menu";
import { icon } from "../storefront/icons";
import { t, type UiKey } from "../i18n";
import { loadProject, projectLayout } from "./project";
import { dateText, dunningPath, pageHead } from "./dunning";
import type { DateFormat } from "../../../server/formats";

const CURRENCY = "EUR";
const PORTAL_URL = "https://esodisce.si";

const ISSUE_TEXT: Record<EnforcementIssue, UiKey> = {
	not_final_letter: "enforcement.issue_not_final_letter",
	deadline_not_passed: "enforcement.issue_deadline_not_passed",
	currency_not_eur: "enforcement.issue_currency_not_eur",
	project_not_slovenian: "enforcement.issue_project_not_slovenian",
	creditor_name: "enforcement.issue_creditor_name",
	creditor_address: "enforcement.issue_creditor_address",
	creditor_postal_code: "enforcement.issue_creditor_postal_code",
	creditor_city: "enforcement.issue_creditor_city",
	creditor_identifier: "enforcement.issue_creditor_identifier",
	creditor_iban: "enforcement.issue_creditor_iban",
	debtor_missing: "enforcement.issue_debtor_missing",
	debtor_name: "enforcement.issue_debtor_name",
	debtor_person_name: "enforcement.issue_debtor_person_name",
	debtor_address: "enforcement.issue_debtor_address",
	debtor_postal_code: "enforcement.issue_debtor_postal_code",
	debtor_city: "enforcement.issue_debtor_city",
	debtor_country: "enforcement.issue_debtor_country",
	debtor_identifier: "enforcement.issue_debtor_identifier",
	nothing_open: "enforcement.issue_nothing_open",
	issue_date_missing: "enforcement.issue_issue_date_missing",
};

const PARTY_KINDS: Record<EnforcementParty["kind"], UiKey> = {
	person: "enforcement.kind_person",
	company: "enforcement.kind_company",
	sole_trader: "enforcement.kind_sole_trader",
};

export function enforcementPath(uuid: string, proposal: string): string {
	return dunningPath(uuid, `/enforcement/${proposal}`);
}

function issueFix(uuid: string, issue: EnforcementIssue, customer: string | null): HTMLElement | null {
	if (issue === "creditor_iban") return el("a", { href: `/projects/${uuid}/settings#payment-methods` }, t("enforcement.fix_payment_methods"));
	if (issue.startsWith("creditor_")) return el("a", { href: `/projects/${uuid}/settings#company` }, t("enforcement.fix_company"));
	if (issue.startsWith("debtor_") && issue !== "debtor_missing" && customer) {
		return el("a", { href: `/projects/${uuid}/customers/${customer}` }, t("enforcement.fix_customer"));
	}
	return null;
}

function statusPill(proposal: Pick<EnforcementProposal, "status" | "court_case">): HTMLElement {
	return proposal.status === "filed"
		? el(
				"span",
				{ class: "pill pill-paid" },
				proposal.court_case ? t("enforcement.status_filed_case", { case: proposal.court_case }) : t("enforcement.status_filed")
			)
		: el("span", { class: "pill pill-pending" }, t("enforcement.status_prepared"));
}

export async function enforcementLetterCard(uuid: string, project: Project, letter: DunningLetterDetail): Promise<HTMLElement | null> {
	if (letter.level !== 3 || !letter.customer) return null;
	const plan = await EnforcementApi.plan(uuid, letter.uuid);
	const head = el("div", { class: "card-head" }, el("h3", {}, t("enforcement.next_step")));

	if (plan.proposals.length > 0) {
		return el(
			"div",
			{ class: "card enforcement-next" },
			head,
			...plan.proposals.map((proposal) =>
				el(
					"a",
					{ class: "enforcement-link", href: enforcementPath(uuid, proposal.uuid) },
					icon("file", 16),
					el("span", {}, t("enforcement.proposal_from", { date: formatDate(proposal.created, project.date_format as DateFormat, project.timezone) })),
					statusPill(proposal)
				)
			)
		);
	}
	if (plan.issues.includes("deadline_not_passed")) {
		return el(
			"div",
			{ class: "card enforcement-next" },
			head,
			el("p", { class: "muted" }, t("enforcement.after_deadline", { date: dateText(project, letter.deadline_date) }))
		);
	}
	if (plan.issues.includes("nothing_open")) {
		return el("div", { class: "card enforcement-next" }, head, el("p", { class: "muted" }, t("enforcement.all_paid")));
	}
	return el(
		"div",
		{ class: "card enforcement-next enforcement-ready" },
		head,
		el("p", {}, t("enforcement.ready_intro", { date: dateText(project, letter.deadline_date) })),
		el("p", { class: "muted" }, t("enforcement.ready_fee", { fee: formatMoney(plan.court_fee, CURRENCY) })),
		can(project, Permission.INVOICE_CREATE)
			? el("div", {}, el("a", { class: "button danger", href: dunningPath(uuid, `/${letter.uuid}/enforcement`) }, t("enforcement.prepare")))
			: null
	);
}

export function enforcementProposalsCard(uuid: string, project: Project, proposals: EnforcementProposal[], total: number): HTMLElement | null {
	if (proposals.length === 0) return null;
	return el(
		"div",
		{ class: "card" },
		el("div", { class: "card-head" }, el("h3", {}, t("enforcement.list_title")), el("span", { class: "muted" }, t("enforcement.list_count", { count: total }))),
		table(
			[
				t("customers.column_customer"),
				t("enforcement.column_letter"),
				{ label: t("enforcement.column_claimed"), class: "numeric" },
				t("enforcement.column_status"),
				t("enforcement.column_filed"),
			],
			proposals.map((proposal) =>
				el(
					"tr",
					{},
					el("td", {}, el("a", { href: enforcementPath(uuid, proposal.uuid) }, el("strong", {}, proposal.customer_name || t("customers.unnamed")))),
					el(
						"td",
						{},
						proposal.dunning_letter && proposal.letter_number
							? el("a", { class: "mono", href: dunningPath(uuid, `/${proposal.dunning_letter}`) }, proposal.letter_number)
							: el("span", { class: "muted" }, "-")
					),
					el("td", { class: "mono numeric" }, formatMoney(proposal.claims_total, CURRENCY)),
					el("td", {}, statusPill(proposal)),
					el("td", {}, dateText(project, proposal.filed_date))
				)
			)
		)
	);
}

function claimRows(project: Project, claims: EnforcementClaim[], issueCell?: (claim: EnforcementClaim, index: number) => HTMLElement | string): HTMLElement[] {
	const phoneLabel = (key: UiKey) => el("span", { class: "enforcement-phone-label" }, `${t(key)} `);
	return claims.map((claim, index) =>
		el(
			"tr",
			{},
			el("td", { class: "enforcement-claim" }, claim.label),
			el(
				"td",
				{ class: "dunning-date enforcement-issued" },
				phoneLabel("dunning.column_issued"),
				issueCell ? issueCell(claim, index) : dateText(project, claim.issue_date)
			),
			el("td", { class: "dunning-date enforcement-due" }, phoneLabel("dunning.column_due"), dateText(project, claim.due_date)),
			el("td", { class: "mono numeric enforcement-amount" }, formatMoney(claim.amount, CURRENCY)),
			el(
				"td",
				{ class: "dunning-date enforcement-interest" },
				phoneLabel("enforcement.column_interest_from"),
				claim.interest_from ? dateText(project, claim.interest_from) : el("span", { class: "muted" }, t("enforcement.no_interest"))
			)
		)
	);
}

function claimsTable(rows: HTMLElement[]): HTMLElement {
	const wrap = table(
		[
			t("enforcement.column_document"),
			t("dunning.column_issued"),
			t("dunning.column_due"),
			{ label: t("enforcement.column_amount"), class: "numeric" },
			t("enforcement.column_interest_from"),
		],
		rows
	);
	wrap.classList.add("enforcement-claims");
	return wrap;
}

function totalsOf(claims: EnforcementClaim[]) {
	const principal = claims.filter((claim) => claim.kind === "invoice").reduce((sum, claim) => sum + claim.amount, 0);
	const compensation = claims.filter((claim) => claim.kind === "compensation").reduce((sum, claim) => sum + claim.amount, 0);
	return { principal, compensation, total: principal + compensation };
}

function summaryRows(claims: EnforcementClaim[], courtFee: number): HTMLElement[] {
	const totals = totalsOf(claims);
	const rows: (HTMLElement | null)[] = [
		el(
			"div",
			{ class: "totals-row" },
			el("span", {}, t("enforcement.summary_principal")),
			el("span", { class: "mono" }, formatMoney(totals.principal, CURRENCY))
		),
		totals.compensation > 0
			? el(
					"div",
					{ class: "totals-row" },
					el("span", {}, t("enforcement.summary_compensation")),
					el("span", { class: "mono" }, formatMoney(totals.compensation, CURRENCY))
				)
			: null,
		el(
			"div",
			{ class: "totals-row grand" },
			el("span", {}, t("enforcement.summary_claimed")),
			el("span", { class: "mono" }, formatMoney(totals.total, CURRENCY))
		),
		el(
			"div",
			{ class: "totals-row enforcement-fee" },
			el("span", {}, t("enforcement.summary_fee")),
			el("span", { class: "mono" }, formatMoney(courtFee, CURRENCY))
		),
	];
	return rows.filter((row): row is HTMLElement => row !== null);
}

function switchOption(control: HTMLInputElement, label: string, hint: string): HTMLElement {
	return el("div", { class: "dunning-option" }, el("label", { class: "switch" }, control, el("span", {}, label)), el("p", { class: "field-hint" }, hint));
}

function proposalForm(uuid: string, project: Project, letterId: string, customer: string | null, first: EnforcementPlan): HTMLElement {
	let plan = first;
	const interest = input("checkbox");
	interest.checked = first.interest_available;
	const compensation = input("checkbox");
	compensation.checked = first.compensation_available;
	const bankAccounts = input("checkbox");
	bankAccounts.checked = true;
	const salary = input("checkbox");
	salary.checked = first.debtor_kind === "person";
	salary.disabled = first.debtor_kind === "company";
	const issueDates: Record<string, string> = {};

	const issuesBody = el("div", {});
	const claimsBody = el("div", {});
	const summaryBody = el("div", { class: "dunning-summary-rows" });
	const createButton = el("button", { class: "button danger", type: "button" }, t("enforcement.create"));
	let round = 0;

	const payload = (): EnforcementInput => ({
		interest: interest.checked,
		compensation: compensation.checked,
		bank_accounts: bankAccounts.checked,
		salary: salary.checked && !salary.disabled,
		issue_dates: issueDates,
	});

	const issueDateInput = (claim: EnforcementClaim, index: number): HTMLElement | string => {
		const planned = plan.claims[index];
		if (!planned?.needs_issue_date || claim.kind !== "invoice") return dateText(project, claim.issue_date || null);
		const control = input("date", { max: plan.today, value: issueDates[planned.line] ?? "", required: true });
		control.setAttribute("aria-label", t("enforcement.issue_date_for", { reference: claim.reference }));
		control.addEventListener("change", () => {
			if (control.value) issueDates[planned.line] = control.value;
			else delete issueDates[planned.line];
			void refresh();
		});
		return control;
	};

	const render = () => {
		replaceContent(
			issuesBody,
			plan.issues.length === 0
				? null
				: el(
						"div",
						{ class: "card enforcement-issues" },
						el("h3", {}, t("enforcement.issues_title")),
						el("ul", {}, ...plan.issues.map((issue) => el("li", {}, el("span", {}, t(ISSUE_TEXT[issue])), " ", issueFix(uuid, issue, customer))))
					)
		);
		replaceContent(
			claimsBody,
			plan.claims.length === 0 ? el("p", { class: "muted" }, t("enforcement.no_claims")) : claimsTable(claimRows(project, plan.claims, issueDateInput)),
			plan.paid_lines > 0 ? el("p", { class: "muted small-print" }, t("enforcement.paid_left_out", { count: plan.paid_lines })) : null,
			el("p", { class: "muted small-print" }, t("enforcement.claims_hint"))
		);
		replaceContent(summaryBody, ...summaryRows(plan.claims, plan.court_fee));
		createButton.disabled = !plan.ready || !can(project, Permission.INVOICE_CREATE);
	};

	const refresh = async () => {
		const current = ++round;
		if (!bankAccounts.checked && (!salary.checked || salary.disabled)) bankAccounts.checked = true;
		try {
			const next = await EnforcementApi.plan(uuid, letterId, payload());
			if (current !== round) return;
			plan = next;
			render();
		} catch (error) {
			reportError(error);
		}
	};

	for (const control of [interest, compensation, bankAccounts, salary]) control.addEventListener("change", () => void refresh());

	createButton.addEventListener("click", async () => {
		const confirmed = await confirmDialog({
			title: t("enforcement.create_title"),
			body: t("enforcement.create_body", { fee: formatMoney(plan.court_fee, CURRENCY), days: plan.fee_payment_days }),
			confirmLabel: t("enforcement.create"),
		});
		if (!confirmed) return;
		createButton.disabled = true;
		try {
			const proposal = await EnforcementApi.create(uuid, letterId, payload());
			toast(t("enforcement.created"), "success");
			navigate(enforcementPath(uuid, proposal.uuid));
		} catch (error) {
			reportError(error);
			createButton.disabled = false;
		}
	});

	const optionsCard = el(
		"div",
		{ class: "card stack" },
		el("h3", {}, t("enforcement.options_title")),
		first.interest_available ? switchOption(interest, t("enforcement.option_interest"), t("enforcement.option_interest_hint")) : null,
		first.compensation_available ? switchOption(compensation, t("enforcement.option_compensation"), t("enforcement.option_compensation_hint")) : null,
		el("h4", { class: "enforcement-subhead" }, t("enforcement.means_title")),
		switchOption(bankAccounts, t("enforcement.means_bank"), t("enforcement.means_bank_hint")),
		switchOption(
			salary,
			t("enforcement.means_salary"),
			t(first.debtor_kind === "company" ? "enforcement.means_salary_company" : "enforcement.means_salary_hint")
		)
	);

	const claimsCard = el("div", { class: "card" }, el("h3", {}, t("enforcement.claims_title")), claimsBody);
	const summaryCard = el(
		"aside",
		{ class: "card dunning-summary" },
		el("h3", {}, t("enforcement.summary_title")),
		summaryBody,
		el("p", { class: "muted dunning-deadline" }, t("enforcement.summary_hint", { days: first.fee_payment_days })),
		el("div", { class: "dunning-summary-actions" }, createButton)
	);

	render();
	return el("div", { class: "dunning-editor" }, el("div", { class: "stack" }, issuesBody, claimsCard, optionsCard), summaryCard);
}

export async function newEnforcementView(uuid: string, letterId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const [plan, letter] = await Promise.all([EnforcementApi.plan(uuid, letterId), DunningApi.letter(uuid, letterId)]);
	return projectLayout(
		project,
		el(
			"div",
			{ class: "stack dunning enforcement" },
			el("a", { class: "back-link", href: dunningPath(uuid, `/${letterId}`) }, t("enforcement.back_to_letter", { number: plan.letter.number })),
			pageHead(t("enforcement.new_title"), t("enforcement.new_intro", { name: letter.buyer.name || "-" })),
			proposalForm(uuid, project, letterId, letter.customer, plan)
		)
	);
}

function partyCard(title: string, party: EnforcementParty, extra: (HTMLElement | null)[] = []): HTMLElement {
	const name = [party.first_name, party.name].filter(Boolean).join(" ");
	return el(
		"div",
		{ class: "card enforcement-party" },
		el("h3", {}, title),
		el("p", {}, el("strong", {}, name)),
		el("div", { class: "muted" }, t(PARTY_KINDS[party.kind])),
		el("div", {}, `${party.street} ${party.house_number}`),
		el("div", {}, `${party.postal_code} ${party.city}`),
		party.registration_number ? el("div", { class: "muted" }, t("enforcement.registration_number", { number: party.registration_number })) : null,
		party.tax_number ? el("div", { class: "muted" }, t("enforcement.tax_number", { number: party.tax_number })) : null,
		...extra
	);
}

function filingDialog(uuid: string, proposal: EnforcementProposalDetail, onSaved: () => void) {
	const today = new Date().toISOString().slice(0, 10);
	const courtCase = input("text", { maxlength: "40", value: proposal.court_case ?? "", placeholder: "VL 12345/2026" });
	const filed = input("date", { max: today, value: proposal.filed_date ?? today, required: true });
	const submit = el("button", { class: "button primary", type: "submit" }, t("enforcement.filing_save"));
	const save = async (status: "prepared" | "filed") => {
		submit.disabled = true;
		try {
			await EnforcementApi.update(uuid, proposal.uuid, {
				status,
				court_case: status === "filed" ? courtCase.value.trim() || null : null,
				filed_date: status === "filed" ? filed.value : null,
			});
			dialog.close();
			toast(t(status === "filed" ? "enforcement.filing_saved" : "enforcement.filing_cleared"), "success");
			onSaved();
		} catch (error) {
			reportError(error);
			submit.disabled = false;
		}
	};
	const form = el(
		"form",
		{
			class: "stack",
			onSubmit: (event) => {
				event.preventDefault();
				void save("filed");
			},
		},
		el("p", { class: "muted" }, t("enforcement.filing_hint")),
		el(
			"div",
			{ class: "form-grid" },
			field(t("enforcement.court_case"), courtCase, t("enforcement.court_case_hint")),
			field(t("enforcement.filed_date"), filed)
		),
		el(
			"div",
			{ class: "dialog-actions" },
			proposal.status === "filed"
				? el("button", { class: "button ghost", type: "button", onClick: () => void save("prepared") }, t("enforcement.filing_clear"))
				: null,
			submit
		)
	);
	const dialog = modal(t("enforcement.filing_title"), form, undefined, "dialog-medium");
	courtCase.focus();
}

function stepsCard(proposal: EnforcementProposalDetail, download: () => void): HTMLElement {
	const fee = formatMoney(proposal.court_fee, CURRENCY);
	const step = (number: number, title: string, body: (HTMLElement | string | null)[]) =>
		el(
			"li",
			{ class: "enforcement-step" },
			el("span", { class: "dunning-level-step" }, String(number)),
			el("div", {}, el("strong", {}, title), el("p", { class: "muted" }, ...body))
		);
	return el(
		"div",
		{ class: "card" },
		el("h3", {}, t("enforcement.steps_title")),
		el(
			"ol",
			{ class: "enforcement-steps" },
			step(1, t("enforcement.step_download"), [
				t("enforcement.step_download_body"),
				" ",
				el("button", { class: "link-button", type: "button", onClick: download }, t("enforcement.download_xml")),
			]),
			step(2, t("enforcement.step_portal"), [
				t("enforcement.step_portal_body"),
				" ",
				el("a", { href: PORTAL_URL, target: "_blank", rel: "noopener" }, "esodisce.si"),
			]),
			step(3, t("enforcement.step_import"), [t("enforcement.step_import_body")]),
			step(4, t("enforcement.step_fee", { fee }), [t("enforcement.step_fee_body", { days: proposal.fee_payment_days })]),
			step(5, t("enforcement.step_case"), [t("enforcement.step_case_body", { days: proposal.objection_days })])
		),
		el("p", { class: "muted small-print" }, t("enforcement.steps_fallback"))
	);
}

export async function enforcementProposalView(uuid: string, proposalId: string): Promise<HTMLElement> {
	const project = await loadProject(uuid);
	const container = el("div", { class: "stack dunning enforcement" });

	const render = async () => {
		const proposal = await EnforcementApi.proposal(uuid, proposalId);
		const download = async () => {
			try {
				const file = await EnforcementApi.xml(uuid, proposal.uuid);
				saveFile(file.blob, file.name);
			} catch (error) {
				reportError(error);
			}
		};
		const edits = can(project, Permission.INVOICE_CREATE);
		const links: MenuLink[] = [];
		if (proposal.dunning_letter) links.push({ label: t("enforcement.open_letter"), href: dunningPath(uuid, `/${proposal.dunning_letter}`) });
		const dangerLinks: MenuLink[] = can(project, Permission.INVOICE_DELETE)
			? [
					{
						label: t("enforcement.delete"),
						danger: true,
						onSelect: async () => {
							const confirmed = await confirmDialog({
								title: t("enforcement.delete"),
								body: t("enforcement.delete_body"),
								confirmLabel: t("ui.delete"),
								destructive: true,
							});
							if (!confirmed) return;
							try {
								await EnforcementApi.remove(uuid, proposal.uuid);
								toast(t("enforcement.deleted"), "success");
								navigate(proposal.dunning_letter ? dunningPath(uuid, `/${proposal.dunning_letter}`) : dunningPath(uuid));
							} catch (error) {
								reportError(error);
							}
						},
					},
				]
			: [];
		const actions = [
			el("button", { class: "button primary", type: "button", onClick: () => void download() }, icon("download", 16), t("enforcement.download_xml")),
			edits
				? el(
						"button",
						{ class: "button ghost", type: "button", onClick: () => filingDialog(uuid, proposal, () => void render()) },
						t(proposal.status === "filed" ? "enforcement.filing_edit" : "enforcement.filing_mark")
					)
				: null,
			links.length + dangerLinks.length > 0 ? actionMenu(t("invoices.menu_more"), [links, dangerLinks]) : null,
		].filter((action): action is HTMLElement => action !== null);

		const means = [proposal.means.bank_accounts ? t("enforcement.means_bank") : null, proposal.means.salary ? t("enforcement.means_salary") : null].filter(
			(entry): entry is string => entry !== null
		);

		replaceContent(
			container,
			el("a", { class: "back-link", href: dunningPath(uuid) }, t("dunning.title")),
			el(
				"div",
				{ class: "page-head" },
				el(
					"div",
					{},
					el("h2", {}, t("enforcement.detail_title")),
					el(
						"p",
						{ class: "muted" },
						[proposal.customer_name, proposal.letter_number ? t("enforcement.from_letter", { number: proposal.letter_number }) : null]
							.filter(Boolean)
							.join(" | ")
					)
				),
				el("div", { class: "line-actions" }, statusPill(proposal))
			),
			el("div", { class: "toolbar invoice-actions" }, ...actions),
			proposal.status === "prepared" ? stepsCard(proposal, () => void download()) : null,
			proposal.status === "filed"
				? el(
						"div",
						{ class: "card enforcement-filed" },
						icon("check", 20),
						el(
							"div",
							{},
							el("strong", {}, t("enforcement.filed_on", { date: dateText(project, proposal.filed_date) })),
							el("p", { class: "muted" }, t("enforcement.filed_hint", { days: proposal.objection_days }))
						)
					)
				: null,
			el(
				"div",
				{ class: "dunning-detail-grid" },
				partyCard(t("enforcement.creditor"), proposal.creditor, [
					proposal.creditor.iban ? el("div", { class: "muted mono" }, proposal.creditor.iban.replace(/(.{4})(?=.)/g, "$1 ")) : null,
				]),
				partyCard(t("enforcement.debtor"), proposal.debtor, [
					proposal.customer ? el("a", { href: `/projects/${uuid}/customers/${proposal.customer}` }, t("enforcement.open_customer")) : null,
				])
			),
			el("div", { class: "card" }, el("h3", {}, t("enforcement.claims_title")), claimsTable(claimRows(project, proposal.claims))),
			el(
				"div",
				{ class: "dunning-detail-grid" },
				el(
					"div",
					{ class: "card" },
					el("h3", {}, t("enforcement.costs_title")),
					el("div", { class: "dunning-summary-rows" }, ...summaryRows(proposal.claims, proposal.court_fee)),
					el("p", { class: "muted small-print" }, t("enforcement.costs_hint"))
				),
				el(
					"div",
					{ class: "card" },
					el("h3", {}, t("enforcement.means_title")),
					el("ul", { class: "enforcement-means" }, ...means.map((entry) => el("li", {}, entry))),
					el("p", { class: "muted small-print" }, t(proposal.commercial ? "enforcement.commercial" : "enforcement.not_commercial")),
					el("p", { class: "muted small-print" }, t("enforcement.created_by", { name: accountName(proposal.created_by_name, proposal.created_by) ?? "-" }))
				)
			)
		);
	};

	await render();
	return projectLayout(project, container);
}
