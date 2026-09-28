import type { StorePage, StoreSeller } from "./config";

type Language = "en" | "sl";

const SUPERVISOR = {
	en: "Information Commissioner of the Republic of Slovenia (Informacijski pooblaščenec), Dunajska cesta 22, 1000 Ljubljana, gp.ip@ip-rs.si, www.ip-rs.si",
	sl: "Informacijski pooblaščenec Republike Slovenije, Dunajska cesta 22, 1000 Ljubljana, gp.ip@ip-rs.si, www.ip-rs.si",
};

function validFrom(language: Language, now: Date): string {
	return new Intl.DateTimeFormat(language === "sl" ? "sl-SI" : "en-GB", { day: "numeric", month: "long", year: "numeric" }).format(now);
}

function identity(seller: StoreSeller, language: Language): string {
	const sl = language === "sl";
	const lines = [
		`**${seller.legal_name ?? seller.name}**`,
		seller.address.length ? seller.address.join(", ") : null,
		seller.registration_number ? `${sl ? "Matična številka" : "Registration number"}: ${seller.registration_number}` : null,
		seller.vat_number ? `${sl ? "ID za DDV" : "VAT ID"}: ${seller.vat_number}` : null,
		seller.email ? `${sl ? "E-pošta" : "Email"}: ${seller.email}` : null,
		seller.phone ? `${sl ? "Telefon" : "Phone"}: ${seller.phone}` : null,
	].filter((line): line is string => line !== null);
	return lines.join("  \n");
}

function contact(seller: StoreSeller, language: Language): string {
	if (seller.email) return language === "sl" ? `na ${seller.email}` : `at ${seller.email}`;
	return language === "sl" ? "na kontaktne podatke, navedene v nogi trgovine" : "using the contact details in the store footer";
}

function privacyEn(seller: StoreSeller, date: string): string {
	const who = seller.legal_name ?? seller.name;
	return `This policy explains how ${who} handles your personal data when you use this online store, in line with the General Data Protection Regulation (Regulation (EU) 2016/679, GDPR) and the Slovenian Personal Data Protection Act (ZVOP-2).

## Controller

${identity(seller, "en")}

Write to us ${contact(seller, "en")} with any question about your data or to use your rights.

## What we process and why

| Data | Purpose | Legal basis |
|---|---|---|
| Name, email address, phone number, billing and delivery address, and for business customers the company name, VAT ID and tax number | Taking, delivering and invoicing your order and contacting you about it | Performance of a contract, Article 6(1)(b) GDPR |
| Order, invoice and payment details | Keeping accounting and tax records | Legal obligation, Article 6(1)(c) GDPR, together with the Value Added Tax Act (ZDDV-1) and the Tax Procedure Act (ZDavP-2) |
| Email address and one-time sign in links | Signing you in without a password and showing your orders and invoices | Performance of a contract, Article 6(1)(b) GDPR |
| Checkout details you choose to save | Filling in your next order for you | Your consent, Article 6(1)(a) GDPR |
| Messages you send us, including complaints | Answering you and handling complaints | Performance of a contract and legal obligation, Article 6(1)(b) and (c) GDPR |
| IP address and technical records | Keeping the store secure and preventing abuse, for example by limiting sign in attempts | Legitimate interest, Article 6(1)(f) GDPR |

We do not use your data for advertising, we do not sell it and we do not make decisions about you by automated means or build profiles of you.

We collect the data from you. Payment providers tell us whether a payment succeeded.

## Is providing the data required

The data marked as required at checkout is needed to conclude and fulfil the contract and to issue an invoice as the law requires. Without it we cannot accept your order. Saving your details for later is optional.

## Who receives your data

- Payment providers you choose at checkout, such as banks and card or PayPal processors. They process payments as independent controllers under their own terms. A cryptocurrency payment is recorded on a public blockchain, without your name.
- Delivery and postal companies, which receive your name, delivery address and phone number.
- Providers of hosting, email, IT and accounting services, which process data on our behalf under a data processing agreement (Article 28 GDPR).
- The Financial Administration of the Republic of Slovenia (FURS) and other authorities when the law requires it, for example for fiscal verification of invoices.

## Transfers outside the European Economic Area

If a provider processes data outside the European Economic Area, it does so only on the basis of an adequacy decision of the European Commission or standard contractual clauses (Articles 45 and 46 GDPR).

## How long we keep the data

- Invoices and accounting records: 10 years after the end of the year the invoice relates to, as ZDDV-1 requires.
- Other order records and correspondence: until claims arising from the contract become time barred, as a rule five years.
- Saved checkout details: until you delete them or your customer account.
- Sign in links: 15 minutes, and each link works once. Sessions end after a period of inactivity.
- Security records: only as long as needed to protect the store.

## Cookies and storage on your device

This store sets no cookies for tracking or advertising, uses no analytics and loads no content from third parties. Your browser keeps only what the store needs to work: the contents of your cart, your sign in, and whether you have dismissed the privacy notice. This storage is strictly necessary for the service you request, so it does not require consent under the Electronic Communications Act (ZEKom-2). You can clear it in your browser at any time.

## Your rights

You have the right to access your data (Article 15 GDPR), to have it corrected (Article 16), erased (Article 17) or restricted (Article 18), to receive it in a portable format (Article 20) and to object to processing based on legitimate interest (Article 21). You can withdraw your consent at any time, which does not affect processing that took place before.

In your customer account you can download all your data and delete your account yourself. You can also write to us ${contact(seller, "en")}. We reply within one month. Erasure does not cover invoices and records that the law requires us to keep.

## Complaints to the supervisory authority

You can lodge a complaint with the supervisory authority in the EU country where you live, work or where the infringement took place. In Slovenia this is the ${SUPERVISOR.en}.

## Children

The store is not intended for children under 15, who may not give consent to information society services themselves (Article 8 ZVOP-2).

## Changes

We publish changes to this policy on this page.

Valid from ${date}.`;
}

function privacySl(seller: StoreSeller, date: string): string {
	const who = seller.legal_name ?? seller.name;
	return `Ta politika pojasnjuje, kako ${who} obdeluje vaše osebne podatke pri uporabi te spletne trgovine, v skladu s Splošno uredbo o varstvu podatkov (Uredba (EU) 2016/679, GDPR) in Zakonom o varstvu osebnih podatkov (ZVOP-2).

## Upravljavec

${identity(seller, "sl")}

Za vprašanja o vaših podatkih in uveljavljanje pravic nam pišite ${contact(seller, "sl")}.

## Katere podatke obdelujemo in zakaj

| Podatki | Namen | Pravna podlaga |
|---|---|---|
| Ime in priimek, e-poštni naslov, telefon, naslov za račun in dostavo, pri poslovnih kupcih pa naziv podjetja, ID za DDV in davčna številka | Sprejem, dostava in obračun naročila ter komunikacija o njem | Izvajanje pogodbe, točka (b) člena 6(1) GDPR |
| Podatki o naročilih, računih in plačilih | Vodenje računovodskih in davčnih evidenc | Zakonska obveznost, točka (c) člena 6(1) GDPR, v povezavi z Zakonom o davku na dodano vrednost (ZDDV-1) in Zakonom o davčnem postopku (ZDavP-2) |
| E-poštni naslov in enkratne povezave za prijavo | Prijava brez gesla ter prikaz vaših naročil in računov | Izvajanje pogodbe, točka (b) člena 6(1) GDPR |
| Podatki za nakup, ki jih shranite | Samodejna izpolnitev naslednjega naročila | Vaša privolitev, točka (a) člena 6(1) GDPR |
| Sporočila, ki nam jih pošljete, vključno s pritožbami | Odgovori in obravnava pritožb | Izvajanje pogodbe in zakonska obveznost, točki (b) in (c) člena 6(1) GDPR |
| IP-naslov in tehnični zapisi | Varnost trgovine in preprečevanje zlorab, na primer omejevanje poskusov prijave | Zakoniti interes, točka (f) člena 6(1) GDPR |

Vaših podatkov ne uporabljamo za oglaševanje, jih ne prodajamo in o vas ne sprejemamo avtomatiziranih odločitev ali ustvarjamo profilov.

Podatke pridobimo od vas. Ponudniki plačil nam sporočijo, ali je bilo plačilo uspešno.

## Ali je posredovanje podatkov obvezno

Podatki, ki so ob nakupu označeni kot obvezni, so potrebni za sklenitev in izpolnitev pogodbe ter za izdajo računa, kot zahteva zakon. Brez njih naročila ne moremo sprejeti. Shranjevanje podatkov za naslednji nakup ni obvezno.

## Kdo prejme vaše podatke

- Ponudniki plačil, ki jih izberete ob nakupu, na primer banke in ponudniki plačil s karticami ali PayPal. Plačila obdelujejo kot samostojni upravljavci po svojih pogojih. Plačilo s kriptovaluto se zapiše v javno verigo blokov, brez vašega imena.
- Dostavne in poštne družbe, ki prejmejo vaše ime, naslov za dostavo in telefonsko številko.
- Ponudniki gostovanja, e-pošte, informacijskih in računovodskih storitev, ki podatke obdelujejo v našem imenu na podlagi pogodbe o obdelavi (člen 28 GDPR).
- Finančna uprava Republike Slovenije (FURS) in drugi organi, kadar to zahteva zakon, na primer pri davčnem potrjevanju računov.

## Prenos izven Evropskega gospodarskega prostora

Če ponudnik podatke obdeluje izven Evropskega gospodarskega prostora, to stori le na podlagi sklepa Evropske komisije o ustreznosti ali standardnih pogodbenih klavzul (člena 45 in 46 GDPR).

## Kako dolgo hranimo podatke

- Računi in računovodske listine: 10 let po koncu leta, na katero se račun nanaša, kot določa ZDDV-1.
- Drugi podatki o naročilih in korespondenca: do zastaranja terjatev iz pogodbe, praviloma pet let.
- Shranjeni podatki za nakup: dokler jih ali računa kupca ne izbrišete.
- Povezave za prijavo: 15 minut, vsaka deluje enkrat. Seje se končajo po obdobju neaktivnosti.
- Varnostni zapisi: le toliko časa, kot je potrebno za zaščito trgovine.

## Piškotki in shramba na vaši napravi

Ta trgovina ne uporablja piškotkov za sledenje ali oglaševanje, ne uporablja analitike in ne nalaga vsebin tretjih oseb. Vaš brskalnik hrani le tisto, kar trgovina potrebuje za delovanje: vsebino košarice, prijavo in podatek, ali ste obvestilo o zasebnosti že zaprli. Ta shramba je nujna za storitev, ki jo zahtevate, zato po Zakonu o elektronskih komunikacijah (ZEKom-2) ne potrebuje privolitve. V brskalniku jo lahko kadar koli izbrišete.

## Vaše pravice

Imate pravico do dostopa do podatkov (člen 15 GDPR), popravka (člen 16), izbrisa (člen 17), omejitve obdelave (člen 18), prenosljivosti (člen 20) in ugovora obdelavi na podlagi zakonitega interesa (člen 21). Privolitev lahko kadar koli prekličete, kar ne vpliva na zakonitost obdelave pred preklicem.

V računu kupca lahko vse svoje podatke sami prenesete ali račun izbrišete. Pišete nam lahko tudi ${contact(seller, "sl")}. Odgovorimo v enem mesecu. Izbris ne zajema računov in evidenc, ki jih moramo hraniti po zakonu.

## Pritožba pri nadzornem organu

Pritožbo lahko vložite pri nadzornem organu v državi EU, v kateri prebivate, delate ali je prišlo do kršitve. V Sloveniji je to ${SUPERVISOR.sl}.

## Otroci

Trgovina ni namenjena otrokom, mlajšim od 15 let, ki za storitve informacijske družbe ne morejo sami dati privolitve (člen 8 ZVOP-2).

## Spremembe

Spremembe te politike objavimo na tej strani.

Velja od ${date}.`;
}

function termsEn(seller: StoreSeller, storeName: string, date: string): string {
	const who = seller.legal_name ?? seller.name;
	return `These terms apply to purchases in the ${storeName} online store. The rules on the right of withdrawal and on consumer protection apply only to consumers, who buy for purposes outside their trade or profession.

## Seller

${identity(seller, "en")}

## Prices

Prices are shown in the store's currency and include VAT where it applies. Delivery costs are shown in the cart and at checkout before you place the order. The price valid at the moment you place the order applies. If a price is obviously wrong, we tell you and you may cancel the order free of charge.

## Placing an order

1. Add products to the cart and go to checkout.
2. Sign in with the link we send to your email address. No password is needed.
3. Enter your billing and delivery details and choose a delivery method.
4. Check the summary. Until you place the order you can go back and correct any entry.
5. Press **Order with obligation to pay**. This is a binding order.

The contract is concluded when we confirm the order by sending you the invoice by email. The order and the invoice are stored and always available in your customer account. Contracts are concluded in Slovenian or English.

## Payment

You can pay with the methods offered at checkout. The invoice shows the due date. If the order is not paid by then, we may cancel it.

## Delivery

We ship to the countries offered at checkout. The expected delivery time is shown on every product and at checkout. Unless agreed otherwise we deliver no later than 30 days after the contract is concluded. If we cannot deliver, we tell you without delay and refund what you paid. The risk of loss passes to you when you or a person you name receives the goods. Digital products are delivered by email and in your customer account once the payment arrives.

## Right of withdrawal

As a consumer you may withdraw from the contract within **14 days** without giving any reason. The period starts on the day you, or a person you name who is not the carrier, receive the goods. If several products from one order arrive separately, it starts when the last one arrives. For services and digital content it starts on the day the contract is concluded.

To withdraw, send us a clear statement before the period ends, for example by email ${contact(seller, "en")}. You may use the [model withdrawal form](withdrawal), but you do not have to.

We refund all payments received from you, including the cost of standard delivery, without undue delay and no later than 14 days after we receive your statement. We use the same payment method you used unless you expressly agree otherwise, and you pay no fees for the refund. We may withhold the refund until we receive the goods back or you prove you have sent them.

Send the goods back without undue delay and no later than 14 days after you withdrew. You bear the direct cost of returning them. You are only liable for any loss of value caused by handling the goods beyond what is needed to establish their nature, characteristics and functioning.

The right of withdrawal does not apply to:

- goods made to your specifications or clearly personalised,
- sealed goods that are not suitable for return for health or hygiene reasons once unsealed,
- sealed audio or video recordings and computer software once unsealed,
- digital content not supplied on a physical medium, such as license keys, once delivery has started with your express consent and your acknowledgement that you thereby lose the right of withdrawal, which you confirm at checkout,
- services fully performed with your express consent and acknowledgement that you lose the right of withdrawal once the service is fully performed.

## Liability for defects

We are liable for any lack of conformity of the goods that exists when they are delivered and becomes apparent within two years of delivery, as provided by the Consumer Protection Act (ZVPot-1). Tell us about the defect within two months of discovering it and describe it precisely. You may request that the goods are brought into conformity by repair or replacement, and where that is not possible or not done in time, a price reduction or termination of the contract and a refund. If a product comes with a commercial guarantee, its terms are in the guarantee statement. A guarantee does not limit your statutory rights.

## Complaints and disputes

Send complaints ${contact(seller, "en")}. We confirm receipt within five working days, tell you how long we need to handle the complaint and keep you informed until it is resolved.

${who} does not recognise any provider of out-of-court resolution of consumer disputes as competent. The list of providers approved in Slovenia is published by the ministry responsible for consumer protection. Disputes are otherwise decided by the competent court.

## Personal data

We handle personal data as described in the [privacy policy](privacy).

## Applicable law

The law of the Republic of Slovenia applies. For consumers this choice does not remove the protection of the mandatory rules of the country where they have their habitual residence.

Valid from ${date}.`;
}

function termsSl(seller: StoreSeller, storeName: string, date: string): string {
	const who = seller.legal_name ?? seller.name;
	return `Ti splošni pogoji veljajo za nakupe v spletni trgovini ${storeName}. Določila o odstopu od pogodbe in varstvu potrošnikov veljajo le za potrošnike, ki kupujejo za namene zunaj svoje pridobitne dejavnosti.

## Prodajalec

${identity(seller, "sl")}

## Cene

Cene so navedene v valuti trgovine in vključujejo DDV, kadar se ta obračuna. Stroški dostave so prikazani v košarici in ob zaključku nakupa, preden oddate naročilo. Velja cena v trenutku oddaje naročila. Če je cena očitno napačna, vas o tem obvestimo in lahko naročilo brezplačno prekličete.

## Oddaja naročila

1. Izdelke dodajte v košarico in nadaljujte na zaključek nakupa.
2. Prijavite se s povezavo, ki jo pošljemo na vaš e-poštni naslov. Geslo ni potrebno.
3. Vnesite podatke za račun in dostavo ter izberite način dostave.
4. Preverite povzetek. Dokler naročila ne oddate, se lahko vrnete in popravite vsak vnos.
5. Pritisnite **Naročilo z obveznostjo plačila**. Naročilo je zavezujoče.

Pogodba je sklenjena, ko naročilo potrdimo tako, da vam po e-pošti pošljemo račun. Naročilo in račun sta shranjena in vedno dostopna v vašem računu kupca. Pogodbe sklepamo v slovenskem ali angleškem jeziku.

## Plačilo

Plačate lahko na načine, ponujene ob zaključku nakupa. Rok plačila je naveden na računu. Če naročilo do takrat ni plačano, ga lahko prekličemo.

## Dostava

Dostavljamo v države, ponujene ob zaključku nakupa. Predviden rok dostave je prikazan pri vsakem izdelku in ob zaključku nakupa. Če ni dogovorjeno drugače, dostavimo najpozneje v 30 dneh po sklenitvi pogodbe. Če dostava ni mogoča, vas o tem nemudoma obvestimo in vrnemo plačani znesek. Nevarnost naključnega uničenja preide na vas, ko blago prevzamete vi ali oseba, ki jo določite. Digitalne izdelke dostavimo po e-pošti in v račun kupca, ko prejmemo plačilo.

## Odstop od pogodbe

Kot potrošnik lahko od pogodbe odstopite v **14 dneh** brez navedbe razloga. Rok začne teči z dnem, ko blago prejmete vi ali oseba, ki jo določite in ni prevoznik. Če izdelki iz istega naročila prispejo ločeno, začne rok teči s prejemom zadnjega. Pri storitvah in digitalni vsebini začne rok teči z dnem sklenitve pogodbe.

Za odstop nam pred iztekom roka pošljite nedvoumno izjavo, na primer po e-pošti ${contact(seller, "sl")}. Uporabite lahko [obrazec za odstop od pogodbe](withdrawal), ni pa obvezno.

Vsa prejeta plačila, vključno s stroški standardne dostave, vam vrnemo brez nepotrebnega odlašanja in najpozneje v 14 dneh po prejemu vaše izjave. Uporabimo enako plačilno sredstvo, kot ste ga uporabili vi, razen če se izrecno dogovorimo drugače, vračilo pa vam ne povzroči stroškov. Vračilo lahko zadržimo, dokler blaga ne prejmemo nazaj ali dokler ne dokažete, da ste ga poslali.

Blago nam vrnite brez nepotrebnega odlašanja in najpozneje v 14 dneh po odstopu. Neposredne stroške vračila krijete sami. Odgovarjate le za zmanjšanje vrednosti blaga zaradi ravnanja, ki presega tisto, kar je potrebno za ugotovitev narave, značilnosti in delovanja blaga.

Pravica do odstopa ne velja za:

- blago, izdelano po vaših navodilih ali jasno prilagojeno vam,
- zapečateno blago, ki zaradi varovanja zdravja ali higiene ni primerno za vračilo, ko je odpečateno,
- zapečatene zvočne ali video posnetke in računalniško programsko opremo, ko so odpečateni,
- digitalno vsebino, ki ni dobavljena na otipljivem nosilcu, na primer licenčne ključe, ko se dobava začne z vašo izrecno privolitvijo in potrditvijo, da s tem izgubite pravico do odstopa, kar potrdite ob zaključku nakupa,
- storitve, ki so v celoti opravljene z vašo izrecno privolitvijo in potrditvijo, da po celotni izvedbi izgubite pravico do odstopa.

## Odgovornost za napake

Za neskladnost blaga, ki obstaja ob dobavi in se pokaže v dveh letih od dobave, odgovarjamo po Zakonu o varstvu potrošnikov (ZVPot-1). O napaki nas obvestite v dveh mesecih od dneva, ko ste jo odkrili, in jo natančno opišite. Zahtevate lahko vzpostavitev skladnosti s popravilom ali zamenjavo, in če to ni mogoče ali ni opravljeno pravočasno, znižanje kupnine ali odstop od pogodbe in vračilo kupnine. Če ima izdelek komercialno garancijo, so njeni pogoji navedeni v garancijski izjavi. Garancija ne omejuje vaših zakonskih pravic.

## Pritožbe in spori

Pritožbe pošljite ${contact(seller, "sl")}. Prejem potrdimo v petih delovnih dneh, sporočimo, koliko časa bomo potrebovali za obravnavo, in vas obveščamo do rešitve.

${who} ne priznava nobenega izvajalca izvensodnega reševanja potrošniških sporov kot pristojnega. Seznam izvajalcev, priznanih v Sloveniji, objavlja ministrstvo, pristojno za varstvo potrošnikov. Sicer spore rešuje pristojno sodišče.

## Osebni podatki

Osebne podatke obdelujemo, kot je opisano v [politiki zasebnosti](privacy).

## Uporabljeno pravo

Velja pravo Republike Slovenije. Za potrošnike ta izbira ne odvzame varstva po obveznih predpisih države, v kateri imajo običajno prebivališče.

Velja od ${date}.`;
}

function withdrawalEn(seller: StoreSeller): string {
	const recipient = [seller.legal_name ?? seller.name, ...seller.address, seller.email].filter(Boolean).join(", ");
	return `As a consumer you may withdraw from the contract within 14 days without giving any reason, as explained in the [terms of sale](terms). Send us a clear statement, for example by email ${contact(seller, "en")}, or fill in and return the form below. Using the form is not required.

## Model withdrawal form

*Complete and return this form only if you wish to withdraw from the contract.*

- To: ${recipient}
- I/We (\\*) hereby give notice that I/We (\\*) withdraw from my/our (\\*) contract of sale of the following goods (\\*)/for the provision of the following service (\\*):
- Ordered on (\\*)/received on (\\*):
- Order number:
- Name of consumer(s):
- Address of consumer(s):
- Signature of consumer(s) (only if this form is notified on paper):
- Date:

(\\*) Delete as appropriate.`;
}

function withdrawalSl(seller: StoreSeller): string {
	const recipient = [seller.legal_name ?? seller.name, ...seller.address, seller.email].filter(Boolean).join(", ");
	return `Kot potrošnik lahko od pogodbe odstopite v 14 dneh brez navedbe razloga, kot je pojasnjeno v [splošnih pogojih](terms). Pošljite nam nedvoumno izjavo, na primer po e-pošti ${contact(seller, "sl")}, ali izpolnite in vrnite spodnji obrazec. Uporaba obrazca ni obvezna.

## Obrazec za odstop od pogodbe

*Izpolnite in vrnite ta obrazec le, če želite odstopiti od pogodbe.*

- Naslovnik: ${recipient}
- Obveščam/obveščamo (\\*), da odstopam/odstopamo (\\*) od pogodbe o prodaji naslednjega blaga (\\*)/o opravitvi naslednje storitve (\\*):
- Datum naročila (\\*)/datum prejema (\\*):
- Številka naročila:
- Ime potrošnika/potrošnikov:
- Naslov potrošnika/potrošnikov:
- Podpis potrošnika/potrošnikov (samo če se obrazec pošlje v papirni obliki):
- Datum:

(\\*) Neustrezno prečrtajte.`;
}

function withSlovenian(english: string, slovenian: string): string {
	return `${english}\n\n---\n\n# Slovenska različica\n\n${slovenian}`;
}

export function legalPages(seller: StoreSeller, storeName: string, language: Language, now = new Date()): StorePage[] {
	const bilingual = language === "en" && seller.country === "SI";
	const pick = (english: string, slovenian: string) => (language === "sl" ? slovenian : bilingual ? withSlovenian(english, slovenian) : english);
	const dateEn = validFrom("en", now);
	const dateSl = validFrom("sl", now);
	const sl = language === "sl";
	return [
		{
			slug: "privacy",
			title: sl ? "Politika zasebnosti" : "Privacy policy",
			content: pick(privacyEn(seller, dateEn), privacySl(seller, dateSl)),
			footer: true,
		},
		{
			slug: "terms",
			title: sl ? "Splošni pogoji poslovanja" : "Terms of sale",
			content: pick(termsEn(seller, storeName, dateEn), termsSl(seller, storeName, dateSl)),
			footer: true,
		},
		{ slug: "withdrawal", title: sl ? "Odstop od pogodbe" : "Right of withdrawal", content: pick(withdrawalEn(seller), withdrawalSl(seller)), footer: true },
	];
}
