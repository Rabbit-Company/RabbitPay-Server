const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;
const RESERVED_LANGUAGE_CODES = ["api", "pay"];

export function isLanguageCode(value: unknown): value is string {
	if (typeof value !== "string" || !LANGUAGE_CODE.test(value) || RESERVED_LANGUAGE_CODES.includes(value)) return false;
	try {
		return Intl.getCanonicalLocales(value)[0] === value;
	} catch {
		return false;
	}
}
