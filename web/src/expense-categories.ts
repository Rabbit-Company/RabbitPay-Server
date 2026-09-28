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
	{ value: "Other", key: "expenses.category_other" },
];

export function expenseCategoryLabel(value: string): string {
	const category = categories.find((category) => category.value === value);
	return category ? t(category.key) : value;
}

export function expenseCategoryOptions() {
	return categories.map((category) => ({ value: category.value, label: t(category.key), keywords: category.value }));
}
