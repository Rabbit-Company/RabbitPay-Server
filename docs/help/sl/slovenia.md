# Slovenska zakonodaja

Kaj slovensko podjetje nastavi v RabbitPayu: davčno potrjevanje računov pri FURS, e-račune, podatke, ki jih zakon zahteva na računu, in evidence DDV za eDavke.

## Nastavite svoj davčni status

Odprite **Nastavitve** > **Davki** in izberite **Status DDV**. RabbitPay ga uporablja, da na vsakem računu predlaga pravi DDV, da preveri ID za DDV vaših kupcev v sistemu VIES in da izpiše opombo o oprostitvi, kadar niste zavezanec za DDV.

Projekt s Slovenijo kot davčno državo DDV vedno poroča v evrih.

## Nastavite davčno potrjevanje računov (FURS)

Račune, plačane z gotovino, kartico ali kriptovaluto, mora potrditi FURS. Bančna nakazila in plačila PayPal se ne potrjujejo. Dokler potrjevanje ni nastavljeno, slovenski projekt ne more sprejemati ali beležiti gotovinskih, kartičnih in kripto plačil.

Odprite **Nastavitve** > **Davčno potrjevanje računov (FURS)** in pojdite skozi korake.

1. **Digitalno potrdilo**: naložite potrdilo `.p12`, ki ste ga prejeli prek eDavkov, in vnesite njegovo geslo. **Preveri povezavo** preveri, ali se FURS odziva.
2. **Poslovni prostori**: prijavite prostor, iz katerega prodajate, bodisi nepremičnino s katastrskimi podatki in naslovom bodisi premičen prostor.
3. **Naprave**: izberite poslovni prostor in napravo za račune in spletna plačila, po želji ločeno za blagajno, ter vklopite **Potrjuj račune pri FURS**.
4. **Osebe, ki izdajajo račune**: vnesite davčno številko vsake osebe, ki izdaja račune. Nadomestna davčna številka se uporabi za vse, ki je nimajo vpisane.

Ko je potrjevanje vklopljeno, se računi številčijo po poslovnem prostoru in napravi, na primer `SPLET-1-15`. Potrjeni računi prikazujejo ZOI, EOR in kodo QR na zaslonu, v PDF-ju in v e-pošti.

Kadar FURS ni dosegljiv, račun počaka in se samodejno pošlje znova. **Računi, poslani FURS** prikaže vsak zapis in njegovo stanje, z **Pošlji znova** pa zavrnjenega ponovno pošljete, ko odpravite vzrok. Če je zapis zavrnjen ali blizu zakonskega roka, lastniki projekta prejmejo e-pošto, pregled projekta pa prikaže opozorilo.

Tudi dobropis za potrjen račun se potrdi, vračilo plačila na potrjenem računu pa ga vedno izda.

## Pošiljajte e-račune (e-SLOG)

Vsak izdan račun in dobropis lahko prenesete kot e-račun e-SLOG 2.0 z **Dokumenti** > **Prenesi e-SLOG**. Kupec potrebuje ime, državo in ID za DDV ali davčno številko.

RabbitPay datoteko ustvari in jo preda s prenosom, po e-pošti ali na portalu za kupce. Ne odda je v omrežje za izmenjavo e-računov. Če jo želite poslati po e-pošti, pri pošiljanju računa vklopite **Priloži e-račun (e-SLOG XML)** ali jo pod **Nastavitve** > **E-pošta** priložite vsaki e-pošti z računom.

**Proračunski uporabniki** sprejemajo e-račune samo prek UJP, zato datoteko naložite v UJPnet ali jo pošljite prek svoje banke ali drugega ponudnika. Zahtevajo tudi:

- **Referenčni dokument**, številko njihove naročilnice ali pogodbe, ki jo nastavite na obrazcu računa in jo lahko popravite tudi po izdaji,
- njihovo matično številko in transakcijski račun, na katerega prejemajo e-račune, ki ju vnesete pri kupcu pod **Podatki za e-račune**.

Če želite e-račune podpisovati, pod **Nastavitve** > **Podpisovanje e-računov** naložite kvalificirano potrdilo, na primer SIGEN-CA, POSTArCA ali Halcom. Ločeno je od potrdila za FURS.

Prva datoteka e-SLOG posameznega dokumenta se shrani in vsak poznejši prenos vrne natanko to datoteko, ker je e-račun izvirnik, ki ga morate nespremenjenega hraniti 10 let.

## Izpišite obvezne podatke podjetja

Slovenske družbe na svojih dokumentih navajajo polno firmo, sedež, vpis v register in matično številko. D.o.o. in d.d. navedeta tudi osnovni kapital.

Ime, naslov in matična številka pridejo iz **Nastavitve** > **Podatki podjetja** in so natisnjeni na vsakem računu. Vpis v register in osnovni kapital sodita v polje **Noga računa**. RabbitPay pokaže, kaj še manjka, **Dodaj predlagano besedilo** pa v nogo vstavi običajne stavke z `___` na mestih za sodišče in znesek. Vsak `___` zamenjajte s svojimi podatki.

## Račun brez DDV po domači obrnjeni davčni obveznosti

Pri nekaterih dobavah med dvema slovenskima zavezancema za DDV, na primer pri gradbenih delih, DDV po 76.a členu ZDDV-1 obračuna kupec in na računu ga ni.

- **Na artiklu**: **Kategorija DDV** artikla naj bo **Domača obrnjena davčna obveznost (76.a člen)**, njegova običajna stopnja pa ostane. Kadar je kupec slovensko podjetje z ID za DDV, potrjenim v VIES, je postavka predlagana z 0 %. Drugim kupcem se zaračuna običajna stopnja.
- **Ročno**: pri postavki z 0 % DDV izberite razlog pod **Zakaj DDV ni obračunan**.

Račun nato izpiše predpisano opombo. Biti morate zavezanec za DDV, kupec pa mora imeti slovenski ID za DDV. Dobave z obrnjeno davčno obveznostjo in dobave z DDV sodijo na ločena računa.

Domača postavka z DDV lahko uporablja le stopnje 22 %, 9,5 % ali 5 %.

## Računi v drugi valuti

DDV je treba poročati v evrih. Ko izdate račun v drugi valuti, RabbitPay DDV preračuna po referenčnem tečaju ECB za datum dobave in tečaj izpiše na računu.

Za valuto, ki je ECB ne objavlja, tečaj vnesite sami na obrazcu računa. Računa z DDV ni mogoče izdati brez tečaja, po izdaji pa tečaja ni več mogoče spremeniti. Če ga želite popraviti, račun dobropišite in izdajte novega.

## Obdobje DDV posameznega računa

DDV sodi v obdobje, v katerem je bilo blago dobavljeno ali storitev opravljena, ne v obdobje, v katerem je bil račun napisan. Račun, izdan 5. oktobra za dobavo 28. septembra, se poroča v septembru. Zato je **Datum dobave** na obrazcu računa pomemben.

Če izdate račun za obdobje, za katero ste evidence že oddali, se RabbitPay ustavi in vpraša, ali ga želite izdati kot zamujeno poročanje. Če izberete **Izdaj kot zamujeno poročanje**, se račun poroča v tekočem obdobju in je označen tako, da lahko eDavki izračunajo obresti.

Podprta so le običajna pravila DDV. Obračunavanje po plačani realizaciji, posebna ureditev za maržo in samofakturiranje niso podprti.

## Izvozite evidence DDV za eDavke

Odprite **Statistika** in poiščite **Uradni evidenci DDV za FURS**.

1. Izberite davčno obdobje.
2. Pritisnite **Preveri evidence** in odpravite, na kar kažejo opozorila.
3. Pritisnite **Ustvari izvoz za FURS** in prenesite datoteko, ki jo oddate v eDavkih.

Izdelava izvoza zaklene obdobje. Računov, dobropisov in stroškov v zaklenjenem obdobju ni več mogoče dodajati ali spreminjati, zato evidence ostanejo enake oddanim. Vsak izvoz se shrani kot revizija.

Če morate kaj popraviti, lahko pooblaščena oseba obdobje odklene z **Odkleni** in navedbo razloga, kar se zabeleži. Naslednji izvoz ga znova zaklene.
