# Obdobja DDV in tuje valute

DDV se poroča v evrih in v obdobju, v katerem je bilo blago dobavljeno ali storitev opravljena. Ta stran pokaže, kako RabbitPay ureja oboje.

## Datum dobave

DDV sodi v obdobje dobave, ne v obdobje, v katerem je bil račun napisan. Račun, izdan 5. oktobra za delo, opravljeno 28. septembra, se poroča v septembru.

Zato ima obrazec računa **Datum dobave**. Če je enak datumu računa, ga pustite.

![Datum dobave na obrazcu računa](https://cdn.rabbitpay.net/help/sl/dark/slovenia/vat-periods/supply-date.webp)

## Računi v drugi valuti

Račun lahko izdate v kateri koli valuti, na primer v ameriških dolarjih za kupca v tujini. DDV se kljub temu poroča v evrih.

Ko izberete drugo valuto, obrazec pokaže polje za tečaj.

![Račun v ameriških dolarjih s poljem za tečaj](https://cdn.rabbitpay.net/help/sl/dark/slovenia/vat-periods/currency.webp)

- Pustite ga **praznega** in RabbitPay uporabi referenčni tečaj Evropske centralne banke na datum dobave.
- Tečaj vpišite samo za valuto, za katero ECB tečaja ne objavlja. Uporabite tečaj svoje centralne banke na datum dobave.

Izdan račun izpiše tečaj in DDV v evrih, stran računa pa ju kaže pod **Poročanje DDV**.

![DDV v evrih in uporabljeni tečaj ECB](https://cdn.rabbitpay.net/help/sl/dark/slovenia/vat-periods/issued.webp)

Računa z DDV ni mogoče izdati brez tečaja, tečaja pa po izdaji ni mogoče spremeniti. Za popravek račun dobropišite in izdajte novega.

## Račun za obdobje, ki ste ga že oddali

Ko za mesec [izvozite evidenci DDV](slovenia/ddv-evidence), se ta mesec zaklene. Če nato izdate račun z datumom dobave v njem, se RabbitPay ustavi in vpraša, kaj storiti.

![Vprašanje o zamujenem poročanju DDV](https://cdn.rabbitpay.net/help/sl/dark/slovenia/vat-periods/late-dialog.webp)

Pritisnite **Izdaj kot zamujeno poročanje**. Račun se poroča v tekočem obdobju kot popravek prejšnjega, po 88.b členu ZDDV-1, in je označen tako, da eDavki lahko izračunajo obresti. Stran računa to tudi pove.

![Opomba na računu, izdanem kot zamujeno poročanje](https://cdn.rabbitpay.net/help/sl/dark/slovenia/vat-periods/late-note.webp)

Če ste se zmotili v datumu dobave, raje pritisnite **Prekliči**.
