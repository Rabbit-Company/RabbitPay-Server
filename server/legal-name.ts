const SOLE_TRADER_ACTIVITY = /^(.*?(?:^|[\s,])s\.\s*p\.?)[\s,]+(\S.*)$/i;

export interface LegalNameParts {
	name: string;
	activity: string | null;
}

export function legalNameParts(legalName: string | null | undefined): LegalNameParts {
	const name = (legalName ?? "").trim();
	const match = SOLE_TRADER_ACTIVITY.exec(name);
	return match ? { name: match[1].trim(), activity: match[2].trim() } : { name, activity: null };
}
