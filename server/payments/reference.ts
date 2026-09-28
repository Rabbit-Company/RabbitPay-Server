function digitsOf(value: string): string {
	return [...value].map((character) => (/[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character)).join("");
}

export function mod97(value: string): number {
	let remainder = 0;
	for (const digit of digitsOf(value)) remainder = (remainder * 10 + Number(digit)) % 97;
	return remainder;
}

export function creditorReference(invoiceNumber: string): string | null {
	const body = digitsOf(invoiceNumber.toUpperCase().replace(/[^A-Z0-9]/g, ""));
	if (body.length === 0 || body.length > 21) return null;
	return `RF${String(98 - mod97(`${body}RF00`)).padStart(2, "0")}${body}`;
}

export function isCreditorReference(value: string): boolean {
	const reference = value.replace(/\s+/g, "").toUpperCase();
	return /^RF[0-9]{2}[A-Z0-9]{1,21}$/.test(reference) && mod97(reference.slice(4) + reference.slice(0, 4)) === 1;
}

export function formatReference(reference: string): string {
	return isCreditorReference(reference) ? reference.replace(/(.{4})(?=.)/g, "$1 ") : reference;
}
