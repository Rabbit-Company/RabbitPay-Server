# Dnevnik

Vse knjižbe na enem seznamu, v vrstnem redu knjiženja. Poiščite katero koli temeljnico, odprite listino za njo in knjižite svoje temeljnice.

## Branje dnevnika

Odprite **Knjigovodstvo**. Dnevnik je prvi zavihek. Vsaka temeljnica ima številko, na primer **2025/1**, datum, opis in postavke s kontom, bremenom in dobrom.

![Dnevnik z otvoritvijo in prvimi stroški](https://cdn.rabbitpay.net/help/sl/dark/accounting/journal/list.webp)

- **Odpri dokument** vas pelje na račun, strošek ali drugo listino, iz katere je temeljnica.
- Kliknite konto, da odprete njegovo [kartico](accounting/trial-balance#odprite-kartico-konta).
- **Izvozi CSV** prenese prikazane temeljnice z upoštevanimi filtri.

## Iskanje temeljnice

Izberite **Obdobje**, na primer **Ta mesec** ali **Lani**, ali vpišite svoje datume. Nato zožite iskanje po kontu, viru, besedi iz opisa ali partnerju ali po natančnem znesku.

![Obdobje in filtri nad dnevnikom](https://cdn.rabbitpay.net/help/sl/dark/accounting/journal/filters.webp)

Filter **Vir** pokaže samo eno vrsto temeljnic, na primer samo **Postavka bančnega izpiska** ali samo **Ročna temeljnica**.

## Ročna temeljnica

Ročne temeljnice uporabite za začetna stanja, bančne stroške, ki jih niste uvozili, posojila in vse drugo, kar v RabbitPay nima listine.

1. Pritisnite **Nova temeljnica** ali kjer koli v projektu pritisnite **F8**.
2. Vpišite datum in opis.
3. V vsaki postavki izberite konto tako, da vtipkate njegovo šifro ali del imena, nato vpišite znesek v **Breme** ali **Dobro**.
4. Za več postavk pritisnite **Dodaj postavko**. Nova postavka se izpolni z zneskom, ki še manjka.
5. Ko sta **Breme** in **Dobro** enaka, pritisnite **Knjiži**.

![Otvoritvena temeljnica s tremi postavkami](https://cdn.rabbitpay.net/help/sl/dark/accounting/journal/new-entry.webp)

Celo temeljnico lahko vnesete brez miške. **Enter** se premakne v naslednje polje in doda postavko, dokler temeljnica ni uravnotežena, **Ctrl + Enter** pa jo knjiži. Postavkam na kontih kupcev in dobaviteljev dodajte **Partnerja**, da se pokažejo med [odprtimi postavkami](accounting/open-items).

## Popravek ročne temeljnice

Temeljnic se ne ureja. Pri ročni temeljnici pritisnite **Storniraj**, da se knjiži enaka temeljnica z nasprotnimi zneski, nato knjižite pravilno.

Temeljnice iz listin popravite tako, da popravite listino. RabbitPay sam stornira staro temeljnico in knjiži novo.

## Zaklenjena obdobja

Obdobje zakleneta dve stvari:

- Mesec, za katerega ste izvozili [evidenco DDV](slovenia/ddv-evidence). Ročne temeljnice na kontih DDV so tam zavrnjene.
- [Zaključeno leto](accounting/year-end). Nič z datumom v njem se ne more knjižiti, dokler leta ne odprete ponovno.

Če se kakšne listine niso mogle knjižiti, na primer račun v tuji valuti brez tečaja, jih obvestilo nad dnevnikom našteje.
