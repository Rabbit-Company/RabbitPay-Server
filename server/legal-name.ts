const SOLE_TRADER_ACTIVITY = /^(.*?(?:^|[\s,])s\.\s*p\.?)[\s,]+(\S.*)$/i;
const ENDS_AS_SOLE_TRADER = /(?:^|[\s,])s\.\s*p\.?$/i;

export interface LegalNameParts {
	name: string;
	activity: string | null;
}

export function legalNameParts(legalName: string | null | undefined): LegalNameParts {
	const name = (legalName ?? "").trim();
	const trailing = SOLE_TRADER_ACTIVITY.exec(name);
	if (trailing) return { name: trailing[1].trim(), activity: trailing[2].trim() };

	const segments = name.split(",").map((segment) => segment.trim());
	if (segments.length < 3 || segments.includes("") || !ENDS_AS_SOLE_TRADER.test(name)) return { name, activity: null };
	return { name: `${segments[0]}, ${segments[segments.length - 1]}`, activity: segments.slice(1, -1).join(", ") };
}
