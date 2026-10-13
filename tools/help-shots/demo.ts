import type { UiLanguage } from "../../web/src/i18n/dictionary";

export interface Person {
	name: string;
	email: string;
}

export interface Company {
	legalName: string;
	search: string;
	address: string;
	postalCode: string;
	city: string;
	country: string;
	countryName: string;
	taxNumber: string;
	vatNumber: string;
	registrationNumber: string;
	email: string;
	phone: string;
	website: string;
	footer: string[];
}

export interface DemoItem {
	name: string;
	sku: string;
	price: number;
	unit: string;
}

export interface DemoCustomer {
	search?: string;
	name: string;
	email: string;
	type: "business" | "individual";
	address?: string;
	postalCode?: string;
	city?: string;
	country?: string;
}

export interface Demo {
	vatRate: number;
	items: DemoItem[];
	newItem: DemoItem;
	customers: DemoCustomer[];
	individual: DemoCustomer & { countryName: string };
	notes: string;
	creditReason: string;
	recurringTitle: string;
	recurringLine: string;
	orderNumber: string;
	customerSearch: string;
	owner: Person & { password: string };
	project: string;
	displayName: string;
	company: Company;
	locale: string;
	dateFormat: string;
	timezone: string;
	iban: string;
	bic: string;
	bank: string;
	customer: { search: string; name: string; address: string; postalCode: string; city: string; countryName: string; email: string };
	service: { description: string; price: string };
	teammates: Person[];
}

export interface Session {
	demo: Demo;
	totpSecret: string | null;
	project: string | null;
	items?: string[];
	customers?: string[];
	customerNames?: string[];
	partial?: string;
	marks?: Record<string, string>;
}

export const ADMINISTRATOR = { email: "administrator@example.com", password: "Scratch-Server-Administrator-1" };

export const DEMOS: Record<UiLanguage, Demo> = {
	en: {
		owner: { name: "Emily Carter", email: "emily.carter@example.com", password: "Harbour-Lane-Studio-2026" },
		project: "harbour-lane-studio",
		displayName: "Harbour Lane Studio",
		company: {
			legalName: "Harbour Lane Studio Limited",
			search: "Harbour Lane",
			address: "14 Harbour Lane",
			postalCode: "D02 XK71",
			city: "Dublin",
			country: "IE",
			countryName: "Ireland",
			taxNumber: "3948217KH",
			vatNumber: "IE3948217KH",
			registrationNumber: "748215",
			email: "hello@harbourlane.example",
			phone: "+353 1 555 0142",
			website: "https://harbourlane.example",
			footer: [],
		},
		vatRate: 23,
		items: [
			{ name: "Website design", sku: "WEB-DESIGN", price: 240000, unit: "E48" },
			{ name: "Design work, per hour", sku: "DESIGN-H", price: 7500, unit: "HUR" },
			{ name: "Website hosting, 12 months", sku: "HOST-12", price: 24000, unit: "ANN" },
		],
		newItem: { name: "Website maintenance, monthly", sku: "CARE-M", price: 18000, unit: "MON" },
		customers: [
			{
				name: "Electricity Supply Board",
				email: "invoices.esb@example.com",
				type: "business",
				address: "27 Fitzwilliam Street Lower",
				postalCode: "D02 KT92",
				city: "Dublin",
				country: "IE",
			},
			{
				name: "Raidió Teilifís Éireann",
				email: "finance.rte@example.com",
				type: "business",
				address: "Donnybrook",
				postalCode: "D04 P297",
				city: "Dublin",
				country: "IE",
			},
			{
				name: "Bus Éireann",
				email: "accounts.buseireann@example.com",
				type: "business",
				address: "Broadstone",
				postalCode: "D07 X2AE",
				city: "Dublin",
				country: "IE",
			},
		],
		individual: {
			name: "Hannah Murphy",
			email: "hannah.murphy@example.com",
			type: "individual",
			address: "8 Seaview Terrace",
			postalCode: "H91 T2X4",
			city: "Galway",
			country: "IE",
			countryName: "Ireland",
		},
		notes: "Thank you for your business. Please quote the invoice number with your payment.",
		creditReason: "Two design hours were billed by mistake",
		recurringTitle: "Monthly website maintenance",
		recurringLine: "Website maintenance for {month} {year}",
		orderNumber: "PO-2026-0418",
		customerSearch: "Post",
		locale: "en-IE",
		dateFormat: "dd/mm/yyyy",
		timezone: "Europe/Dublin",
		iban: "IE29 AIBK 9311 5212 3456 78",
		bic: "AIBKIE2D",
		bank: "Allied Irish Banks",
		customer: {
			search: "An Post",
			name: "An Post",
			address: "General Post Office, O'Connell Street Lower",
			postalCode: "D01 F5P2",
			city: "Dublin",
			countryName: "Ireland",
			email: "accounts.payable@example.com",
		},
		service: { description: "Website redesign", price: "2400" },
		teammates: [
			{ name: "James Wilson", email: "james.wilson@example.com" },
			{ name: "Sarah Thompson", email: "sarah.thompson@example.com" },
			{ name: "Oliver Bennett", email: "oliver.bennett@example.com" },
		],
	},
	sl: {
		owner: { name: "Ana Novak", email: "ana.novak@example.com", password: "Studio-Pod-Lipo-2026" },
		project: "studio-pod-lipo",
		displayName: "Studio Pod lipo",
		company: {
			legalName: "STUDIO POD LIPO, oblikovanje in spletne rešitve, d.o.o.",
			search: "Studio Pod lipo",
			address: "Pod lipo 14",
			postalCode: "1000",
			city: "Ljubljana",
			country: "SI",
			countryName: "Slovenija",
			taxNumber: "",
			vatNumber: "",
			registrationNumber: "8914257000",
			email: "info@podlipo.example",
			phone: "+386 1 555 01 42",
			website: "https://podlipo.example",
			footer: ["Ljubljani", "7.500,00"],
		},
		vatRate: 22,
		items: [
			{ name: "Izdelava spletne strani", sku: "SPLET-IZD", price: 240000, unit: "E48" },
			{ name: "Oblikovanje, na uro", sku: "OBLIK-H", price: 7500, unit: "HUR" },
			{ name: "Gostovanje spletne strani, 12 mesecev", sku: "GOST-12", price: 24000, unit: "ANN" },
		],
		newItem: { name: "Vzdrževanje spletne strani, mesečno", sku: "VZDR-M", price: 18000, unit: "MON" },
		customers: [
			{ search: "Slovenske železnice, d.o.o.", name: "", email: "racuni.sz@example.com", type: "business" },
			{ search: "Telekom Slovenije", name: "", email: "racuni.telekom@example.com", type: "business" },
			{ search: "Družba za avtoceste v Republiki Sloveniji", name: "", email: "racuni.dars@example.com", type: "business" },
		],
		individual: {
			name: "Nina Zupančič",
			email: "nina.zupancic@example.com",
			type: "individual",
			address: "Cankarjeva ulica 5",
			postalCode: "2000",
			city: "Maribor",
			country: "SI",
			countryName: "Slovenija",
		},
		notes: "Hvala za zaupanje. Ob plačilu navedite številko računa.",
		creditReason: "Dve uri oblikovanja sta bili zaračunani pomotoma",
		recurringTitle: "Mesečno vzdrževanje spletne strani",
		recurringLine: "Vzdrževanje spletne strani za {month} {year}",
		orderNumber: "NAR-2026-0418",
		customerSearch: "Telekom",
		locale: "sl-SI",
		dateFormat: "d. m. yyyy",
		timezone: "Europe/Ljubljana",
		iban: "SI56 1910 0000 0123 438",
		bic: "SZKBSI2X",
		bank: "Deželna banka Slovenije",
		customer: {
			search: "Pošta Slovenije",
			name: "POŠTA SLOVENIJE d.o.o.",
			address: "",
			postalCode: "",
			city: "",
			countryName: "Slovenija",
			email: "racuni@example.com",
		},
		service: { description: "Prenova spletne strani", price: "2400" },
		teammates: [
			{ name: "Marko Horvat", email: "marko.horvat@example.com" },
			{ name: "Maja Kovačič", email: "maja.kovacic@example.com" },
			{ name: "Luka Krajnc", email: "luka.krajnc@example.com" },
		],
	},
};
