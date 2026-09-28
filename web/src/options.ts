import { CUSTOMER_TYPES, OSS_THRESHOLD_EUR, SUPPLY_TYPES, TAX_CATEGORIES, TAX_TREATMENTS, VAT_STATUSES } from "../../server/tax";
import { MEASURE_UNITS, unitName, unitSymbol } from "../../server/measure-units";
import { has, language, t } from "./i18n";

export function unitOptions(): Option[] {
	return [
		{ value: "", label: t("units.none") },
		...MEASURE_UNITS.map((unit) => ({ value: unit.code, label: `${unitName(unit.code, language())} (${unitSymbol(unit.code, language())})` })),
	];
}

export function unitLabel(code: string | null | undefined): string | null {
	return unitSymbol(code, language());
}

export interface Option {
	value: string;
	label: string;
}

function labelFor(prefix: string, value: string, fallback: string): string {
	const key = `${prefix}.${value}`;
	return has(key) ? t(key) : fallback;
}

function hintFor(prefix: string, value: string, fallback: string): string {
	const key = `${prefix}.${value}.hint`;
	return has(key) ? t(key) : fallback;
}

export function customerTypeOptions(): Option[] {
	return CUSTOMER_TYPES.map((entry) => ({ value: entry.value, label: labelFor("customer_type", entry.value, entry.label) }));
}

export function customerTypeLabel(value: string | null | undefined): string | null {
	if (!value) return null;
	const found = CUSTOMER_TYPES.find((entry) => entry.value === value);
	return found ? labelFor("customer_type", found.value, found.label) : value;
}

export function supplyTypeOptions(): Option[] {
	return SUPPLY_TYPES.map((entry) => ({ value: entry.value, label: labelFor("supply", entry.value, entry.label) }));
}

export function supplyTypeLabel(value: string): string {
	const found = SUPPLY_TYPES.find((entry) => entry.value === value);
	return found ? labelFor("supply", found.value, found.label) : value;
}

export function supplyTypeHint(value: string): string {
	const found = SUPPLY_TYPES.find((entry) => entry.value === value);
	return found ? hintFor("supply", found.value, found.hint) : "";
}

export function taxCategoryOptions(): Option[] {
	return TAX_CATEGORIES.map((entry) => ({ value: entry.value, label: labelFor("tax_category", entry.value, entry.label) }));
}

export function taxTreatmentOptions(): Option[] {
	return TAX_TREATMENTS.map((entry) => ({ value: entry.value, label: labelFor("treatment", entry.value, entry.label) }));
}

export function taxTreatmentName(value: string): string {
	const found = TAX_TREATMENTS.find((entry) => entry.value === value);
	return found ? labelFor("treatment", found.value, found.label) : value;
}

export function taxWarning(code: string, country: string | null): string {
	const key = `tax.warn.${code}`;
	return has(key) ? t(key, { country: country ?? "", threshold: OSS_THRESHOLD_EUR.toLocaleString(language()) }) : code;
}

export function processorFieldLabel(processor: string, key: string, fallback: string): string {
	const dictionaryKey = `field.${processor}.${key}`;
	return has(dictionaryKey) ? t(dictionaryKey) : fallback;
}

export function processorFieldHint(processor: string, key: string, fallback: string | undefined): string | undefined {
	const dictionaryKey = `field.${processor}.${key}.hint`;
	if (has(dictionaryKey)) return t(dictionaryKey);
	return fallback;
}

export function processorChoiceLabel(processor: string, key: string, value: string, fallback: string): string {
	const dictionaryKey = `field.${processor}.${key}.${value}`;
	return has(dictionaryKey) ? t(dictionaryKey) : fallback;
}

export function processorKindLabel(kind: string): string {
	const dictionaryKey = `processor_kind.${kind}`;
	return has(dictionaryKey) ? t(dictionaryKey) : kind;
}

export function vatStatusOptions(): Option[] {
	return VAT_STATUSES.map((entry) => ({ value: entry.value, label: labelFor("vat_status", entry.value, entry.label) }));
}

export function vatStatusHint(value: string): string {
	const found = VAT_STATUSES.find((entry) => entry.value === value);
	return found ? hintFor("vat_status", found.value, found.hint) : "";
}
