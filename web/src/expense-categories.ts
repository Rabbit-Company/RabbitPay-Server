import { t, type UiKey } from "./i18n";

const categories: { value: string; key: UiKey }[] = [
	{ value: "Hosting", key: "expenses.category_hosting" },
	{ value: "Software", key: "expenses.category_software" },
	{ value: "Rent", key: "expenses.category_rent" },
	{ value: "Utilities", key: "expenses.category_utilities" },
	{ value: "Equipment", key: "expenses.category_equipment" },
	{ value: "Marketing", key: "expenses.category_marketing" },
	{ value: "Travel", key: "expenses.category_travel" },
	{ value: "Professional services", key: "expenses.category_services" },
	{ value: "Salaries", key: "expenses.category_salaries" },
	{ value: "Office supplies", key: "expenses.category_office_supplies" },
	{ value: "Material", key: "expenses.category_material" },
	{ value: "Fuel", key: "expenses.category_fuel" },
	{ value: "Transport and shipping", key: "expenses.category_transport" },
	{ value: "Maintenance and repairs", key: "expenses.category_maintenance" },
	{ value: "Bank fees and insurance", key: "expenses.category_bank_insurance" },
	{ value: "Phone and internet", key: "expenses.category_telecom" },
	{ value: "Education", key: "expenses.category_education" },
	{ value: "Memberships", key: "expenses.category_memberships" },
	{ value: "Contract and student work", key: "expenses.category_contract_work" },
	{ value: "Taxes and fees", key: "expenses.category_levies" },
	{ value: "Representation", key: "expenses.category_representation" },
	{ value: "Donations", key: "expenses.category_donations" },
	{ value: "Fines", key: "expenses.category_fines" },
	{ value: "Other", key: "expenses.category_other" },
];

const NON_DEDUCTIBLE = new Set(["Representation", "Fines", "Donations"]);

const NOTES: Record<string, UiKey> = {
	Representation: "expenses.category_note_representation",
	Fines: "expenses.category_note_fines",
	Donations: "expenses.category_note_donations",
	Fuel: "expenses.category_note_fuel",
	Salaries: "expenses.category_note_salaries",
};

export function nonDeductibleCategory(value: string): boolean {
	return NON_DEDUCTIBLE.has(value);
}

export function expenseCategoryNote(value: string): string | null {
	const key = NOTES[value];
	return key ? t(key) : null;
}

export function expenseCategoryLabel(value: string): string {
	const category = categories.find((category) => category.value === value);
	return category ? t(category.key) : value;
}

export function expenseCategoryOptions() {
	return categories.map((category) => ({ value: category.value, label: t(category.key), keywords: category.value }));
}
