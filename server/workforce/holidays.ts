export interface Holiday {
	date: string;
	name: { en: string; sl: string };
	work_free: boolean;
}

interface FixedHoliday {
	month: number;
	day: number;
	name: { en: string; sl: string };
	work_free: boolean;
}

const SLOVENIAN_FIXED: FixedHoliday[] = [
	{ month: 1, day: 1, name: { en: "New Year's Day", sl: "Novo leto" }, work_free: true },
	{ month: 1, day: 2, name: { en: "New Year's Day", sl: "Novo leto" }, work_free: true },
	{ month: 2, day: 8, name: { en: "Prešeren Day, the Slovenian Cultural Holiday", sl: "Prešernov dan, slovenski kulturni praznik" }, work_free: true },
	{ month: 4, day: 27, name: { en: "Day of Uprising Against Occupation", sl: "Dan upora proti okupatorju" }, work_free: true },
	{ month: 5, day: 1, name: { en: "Labour Day", sl: "Praznik dela" }, work_free: true },
	{ month: 5, day: 2, name: { en: "Labour Day", sl: "Praznik dela" }, work_free: true },
	{ month: 6, day: 8, name: { en: "Primož Trubar Day", sl: "Dan Primoža Trubarja" }, work_free: false },
	{ month: 6, day: 25, name: { en: "Statehood Day", sl: "Dan državnosti" }, work_free: true },
	{ month: 8, day: 15, name: { en: "Assumption Day", sl: "Marijino vnebovzetje" }, work_free: true },
	{
		month: 8,
		day: 17,
		name: { en: "Unification of Prekmurje Slovenes with the Mother Nation", sl: "Združitev prekmurskih Slovencev z matičnim narodom" },
		work_free: false,
	},
	{ month: 9, day: 15, name: { en: "Return of Primorska to the Motherland", sl: "Vrnitev Primorske k matični domovini" }, work_free: false },
	{ month: 9, day: 23, name: { en: "Slovenian Sports Day", sl: "Dan slovenskega športa" }, work_free: false },
	{ month: 10, day: 25, name: { en: "Sovereignty Day", sl: "Dan suverenosti" }, work_free: false },
	{ month: 10, day: 31, name: { en: "Reformation Day", sl: "Dan reformacije" }, work_free: true },
	{ month: 11, day: 1, name: { en: "Day of Remembrance for the Dead", sl: "Dan spomina na mrtve" }, work_free: true },
	{ month: 11, day: 10, name: { en: "Slovenian Science Day", sl: "Dan slovenske znanosti" }, work_free: false },
	{ month: 11, day: 23, name: { en: "Rudolf Maister Day", sl: "Dan Rudolfa Maistra" }, work_free: false },
	{ month: 12, day: 25, name: { en: "Christmas Day", sl: "Božič" }, work_free: true },
	{ month: 12, day: 26, name: { en: "Independence and Unity Day", sl: "Dan samostojnosti in enotnosti" }, work_free: true },
];

export const HOLIDAY_COUNTRIES = ["SI"] as const;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function isoDate(year: number, month: number, day: number): string {
	return `${year}-${pad(month)}-${pad(day)}`;
}

export function easterSunday(year: number): { month: number; day: number } {
	const golden = year % 19;
	const century = Math.floor(year / 100);
	const yearOfCentury = year % 100;
	const leapCenturies = Math.floor(century / 4);
	const centuryRemainder = century % 4;
	const correction = Math.floor((century + 8) / 25);
	const moonCorrection = Math.floor((century - correction + 1) / 3);
	const epact = (19 * golden + century - leapCenturies - moonCorrection + 15) % 30;
	const leapYears = Math.floor(yearOfCentury / 4);
	const yearRemainder = yearOfCentury % 4;
	const weekday = (32 + 2 * centuryRemainder + 2 * leapYears - epact - yearRemainder) % 7;
	const adjustment = Math.floor((golden + 11 * epact + 22 * weekday) / 451);
	const month = Math.floor((epact + weekday - 7 * adjustment + 114) / 31);
	const day = ((epact + weekday - 7 * adjustment + 114) % 31) + 1;
	return { month, day };
}

export function addDays(date: string, days: number): string {
	const [year, month, day] = date.split("-").map(Number);
	const shifted = new Date(Date.UTC(year, month - 1, day + days));
	return isoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function weekdayOf(date: string): number {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isWeekend(date: string): boolean {
	const weekday = weekdayOf(date);
	return weekday === 0 || weekday === 6;
}

function slovenianHolidays(year: number): Holiday[] {
	const easter = easterSunday(year);
	const easterDate = isoDate(year, easter.month, easter.day);
	const movable: Holiday[] = [
		{ date: easterDate, name: { en: "Easter Sunday", sl: "Velikonočna nedelja" }, work_free: true },
		{ date: addDays(easterDate, 1), name: { en: "Easter Monday", sl: "Velikonočni ponedeljek" }, work_free: true },
		{ date: addDays(easterDate, 49), name: { en: "Whit Sunday", sl: "Binkoštna nedelja" }, work_free: true },
	];
	const fixed = SLOVENIAN_FIXED.map((holiday) => ({ date: isoDate(year, holiday.month, holiday.day), name: holiday.name, work_free: holiday.work_free }));
	return [...fixed, ...movable].sort((first, second) => first.date.localeCompare(second.date));
}

export function nationalHolidays(country: string | null, year: number): Holiday[] {
	if (country === "SI") return slovenianHolidays(year);
	return [];
}

export function datesBetween(from: string, to: string): string[] {
	const dates: string[] = [];
	for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
	return dates;
}
