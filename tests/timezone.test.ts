import { describe, expect, test } from "bun:test";
import { formatDate } from "../server/formats";
import { parseInvoiceFormat, periodKey, renderInvoiceNumber } from "../server/invoice-format";
import { addInterval } from "../server/recurring-schedule";
import { endOfLocalDate, isCompleteLocalVatPeriod, isTimezone, localDate, previousLocalMonth, startOfLocalDate } from "../server/timezone";

function format(source: string) {
	const parsed = parseInvoiceFormat(source);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.format;
}

describe("project accounting timezone", () => {
	test("recognises IANA zones", () => {
		expect(isTimezone("Europe/Ljubljana")).toBe(true);
		expect(isTimezone("Not/AZone")).toBe(false);
	});

	test("maps instants to the Slovenian calendar date", () => {
		const instant = Date.UTC(2025, 11, 31, 23, 30);
		expect(localDate(instant, "Europe/Ljubljana")).toBe("2026-01-01");
		expect(formatDate(instant, "yyyy-mm-dd", "Europe/Ljubljana")).toBe("2026-01-01");
	});

	test("uses the project year for invoice numbering", () => {
		const instant = Date.UTC(2025, 11, 31, 23, 30);
		expect(renderInvoiceNumber(format("XXX/YY"), instant, 1, "Europe/Ljubljana")).toBe("001/26");
		expect(periodKey(format("XXX/YY"), instant, "Europe/Ljubljana")).toBe("Y2026");
	});

	test("builds local days across daylight saving changes", () => {
		const from = startOfLocalDate("2026-03-29", "Europe/Ljubljana");
		const to = endOfLocalDate("2026-03-29", "Europe/Ljubljana");
		expect(to - from + 1).toBe(23 * 60 * 60 * 1000);
		expect(localDate(from, "Europe/Ljubljana")).toBe("2026-03-29");
		expect(localDate(to, "Europe/Ljubljana")).toBe("2026-03-29");
	});

	test("keeps recurring schedules at local midnight across daylight saving changes", () => {
		const timezone = "Europe/Ljubljana";
		const march = startOfLocalDate("2026-03-28", timezone);
		const april = addInterval(march, "week", 1, 1, timezone);
		expect(localDate(april, timezone)).toBe("2026-04-04");
		expect(april - march).toBe(167 * 60 * 60 * 1000);
	});

	test("validates local VAT months and quarters", () => {
		const timezone = "Europe/Ljubljana";
		expect(isCompleteLocalVatPeriod(startOfLocalDate("2026-03-01", timezone), endOfLocalDate("2026-03-31", timezone), timezone)).toBe(true);
		expect(isCompleteLocalVatPeriod(startOfLocalDate("2026-01-01", timezone), endOfLocalDate("2026-03-31", timezone), timezone)).toBe(true);
		expect(isCompleteLocalVatPeriod(startOfLocalDate("2026-02-01", timezone), endOfLocalDate("2026-04-30", timezone), timezone)).toBe(false);
	});

	test("finds the previous local month at a UTC year boundary", () => {
		const period = previousLocalMonth(Date.UTC(2026, 0, 1, 0, 30), "Europe/Ljubljana");
		expect(localDate(period.from, "Europe/Ljubljana")).toBe("2025-12-01");
		expect(localDate(period.to, "Europe/Ljubljana")).toBe("2025-12-31");
	});
});
