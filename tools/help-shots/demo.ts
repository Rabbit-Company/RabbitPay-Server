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

export interface Demo {
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
