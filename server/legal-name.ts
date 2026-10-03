const SOLE_TRADER_ACTIVITY = /^(.*?(?:^|[\s,])s\.\s*p\.?)[\s,]+(\S.*)$/i;
const ENDS_AS_SOLE_TRADER = /(?:^|[\s,])s\.\s*p\.?$/i;
const LEGAL_FORM_ALONE = /^(d\.\s*o\.\s*o\.?|d\.\s*d\.?|d\.\s*n\.\s*o\.?|k\.\s*d\.\s*d\.?|k\.\s*d\.?|s\.\s*p\.?)$/i;

export interface LegalNameParts {
	name: string;
	activity: string | null;
}

export function legalNameParts(legalName: string | null | undefined): LegalNameParts {
	const name = (legalName ?? "").trim();
	const trailing = SOLE_TRADER_ACTIVITY.exec(name);
	if (trailing) return { name: trailing[1].trim(), activity: trailing[2].trim() };

	const segments = name.split(",").map((segment) => segment.trim());
	if (segments.length < 2 || segments.includes("")) return { name, activity: null };

	const first = segments[0];
	const last = segments[segments.length - 1];
	if (segments.length === 2) {
		const namesPerson = ENDS_AS_SOLE_TRADER.test(last) && !LEGAL_FORM_ALONE.test(last);
		return namesPerson ? { name: last, activity: first } : { name, activity: null };
	}

	const activity = segments.slice(1, -1).join(", ");
	if (LEGAL_FORM_ALONE.test(last)) return { name: `${first} ${last}`, activity };
	if (ENDS_AS_SOLE_TRADER.test(last)) return { name: `${first}, ${last}`, activity };

	const form = segments[segments.length - 2];
	if (segments.length < 4 || !LEGAL_FORM_ALONE.test(form)) return { name, activity: null };
	return { name: `${first}, ${form}, ${last}`, activity: segments.slice(1, -2).join(", ") };
}
