# Davčno potrjevanje računov

V Sloveniji mora račune, plačane z gotovino, s kartico ali s kriptovaluto, potrditi FURS. RabbitPay enkrat povežete s FURS in to naredi za vsak tak račun.

Finančna uprava (FURS) mora vsakega potrditi, preden ga kupec dobi. Bančna nakazila in plačila PayPal se ne potrjujejo.

Dokler potrjevanje ni nastavljeno, slovenski projekt ne more sprejemati gotovine na blagajni, plačil s kartico in kriptovalut.

## Kaj potrebujete

- **Digitalno potrdilo za davčne blagajne** (datoteka `.p12`) in njegovo geslo. Naročite ga v eDavkih, v delu za davčne blagajne. To ni isto kot vaše kvalificirano potrdilo za podpisovanje.
- **Katastrske podatke** poslovnega prostora: številko katastrske občine, številko stavbe in številko dela stavbe. Najdete jih v javnem vpogledu v nepremičninske evidence GURS. Če prodajate samo na spletu ali z ene naprave, lahko namesto tega prijavite premičen prostor.
- **Osebno davčno številko** vsakega, ki izdaja račune.

## Odprite nastavitve

Odprite **Nastavitve** na dnu menija projekta in se pomaknite do **Davčno potrjevanje računov (FURS)**.

![Nastavitve na dnu menija projekta](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/open-settings.webp)

Kartica kaže **Ni aktivno**, dokler niso opravljeni vsi štirje koraki.

![Davčno potrjevanje pred nastavitvijo](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/not-active.webp)

## 1. Naložite digitalno potrdilo

1. Pod **1. Digitalno potrdilo** v **Datoteka potrdila (.p12)** izberite svojo datoteko `.p12`.
2. V **Geslo potrdila** vpišite njeno geslo.
3. Pritisnite **Naloži potrdilo**.

   ![Potrdilo in geslo, pripravljena za nalaganje](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/certificate-form.webp)

RabbitPay iz potrdila prebere imetnika, vašo davčno številko in datum veljavnosti ter jih prikaže. Pritisnite **Preveri povezavo**, da preverite, ali se FURS odziva. Videti morate **FURS se je odzval.**

![Potrdilo je shranjeno](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/certificate-saved.webp)

Potrdilo je shranjeno šifrirano. Oznaka ob statusu kaže **Produkcija** za pravo potrdilo. Testno potrdilo FURS kaže **Testno okolje**, in nič, kar z njim izdate, davčno ne velja.

> **Nasvet:** Zapomnite si datum **Velja do**. Preden poteče, v eDavkih prenesite novo potrdilo in pritisnite **Zamenjaj potrdilo**. Poteklo potrdilo ustavi potrjevanje, z njim pa tudi gotovino, kartice in kripto.

## 2. Prijavite poslovni prostor

Vsak potrjen račun navaja poslovni prostor, v katerem je bil izdan. FURS ga mora poznati vnaprej.

1. Pod **2. Poslovni prostori** odprite **Prijavi poslovni prostor**.
2. Vpišite **Oznako prostora**, na primer `PP1`. Samo črke in številke, do 20 znakov. Postane prvi del vsake številke računa, zato naj bo kratka.
3. Izberite **Vrsto**:
   - **Nepremičnina** za trgovino, pisarno ali drug prostor z naslovom. Vpišite katastrske podatke in naslov.
   - **Premičen prostor ali naprava** za vozilo, stojnico ali posamezno elektronsko napravo. Izberite **Vrsto prostora**. Spletna trgovina brez prostora navadno prijavi vrsto **C: posamezna elektronska naprava**.
4. Pritisnite **Prijavi pri FURS**.

   ![Nepremičnina, prijavljena kot prostor PP1](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/premise-form.webp)

Prostor se prikaže na seznamu z datumom prijave.

![Prijavljen poslovni prostor](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/premise-registered.webp)

Če se izselite, ob prostoru pritisnite **Zapri**. FURS je obveščen in iz tega prostora ni več mogoče izdajati računov. Najprej prijavite nov prostor.

## 3. Izberite naprave in vklopite potrjevanje

Naprava je blagajna ali program, ki številči račune. RabbitPay uporablja eno napravo za račune in spletna plačila in po želji ločeno napravo za blagajno.

1. Pod **Računi in spletna plačila** izberite **Poslovni prostor** in vpišite **Oznako naprave**, na primer `SPLET1`.
2. Pod **Blagajna** izberite **Enako kot računi** ali poslovni prostor in ločeno **Oznako naprave**, na primer `BLAG1`.
3. **Nadomestno davčno številko** pustite prazno, razen če račune izdajajo tudi osebe brez lastne davčne številke. Glejte naslednji korak.
4. Vklopite **Potrjuj račune pri FURS**.
5. Pritisnite **Shrani**.

   ![Napravi SPLET1 za račune in BLAG1 za blagajno](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/devices.webp)

Odslej so računi oštevilčeni s prostorom, napravo in zaporedno številko, na primer `PP1-SPLET1-1` za račune in `PP1-BLAG1-1` na blagajni. Številke na vsaki napravi si sledijo brez vrzeli, kot zahteva zakon.

## 4. Vpišite, kdo izdaja račune

FURS prejme osebno davčno številko osebe, ki je izdala račun, na računu pa je izpisano njeno ime.

1. Pod **4. Osebe, ki izdajajo račune** poiščite vsako osebo.
2. Vpišite njeno 8 mestno davčno številko in v tej vrstici pritisnite **Shrani**.

   ![Davčna številka lastnice, pripravljena za shranjevanje](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/operators.webp)

Status se spremeni iz **Manjka** v **Vpisana**. Računi brez avtorja, na primer ponavljajoči se računi in računi prek API, uporabijo lastnika projekta. Oseba brez davčne številke uporabi **Nadomestno davčno številko** iz 3. koraka.

Ime na računu pride iz podatkov izdajatelja. Vsak član ekipe svoje polno ime vpiše v **Ekipa** > **Podatki za račun**, v svoji vrstici.

## Končano

Status je zdaj **Aktivno**.

![Davčno potrjevanje je aktivno](https://cdn.rabbitpay.net/help/sl/dark/slovenia/fiscal-verification/active.webp)

Gotovina, kartice in kripto so spet dovoljeni, vsak tak račun pa se samodejno pošlje FURS. Kaj se zgodi potem, preberite v [Računi, poslani FURS](slovenia/verified-invoices).

## Vprašanja

**Ali to potrebujem, če sprejemam samo nakazila?** Ne. Računi, plačani samo z nakazilom ali prek PayPala, se ne potrjujejo. Potrebujete ga, ko začnete sprejemati gotovino, kartice ali kripto.

**Ali lahko najprej poskusim?** Da. Pri FURS na sd.fu@gov.si zaprosite za testno potrdilo in ga naložite. Projekt se tedaj povezuje s testnim okoljem FURS. Ko ste pripravljeni, pritisnite **Zamenjaj potrdilo**, naložite pravo potrdilo in poslovne prostore prijavite znova, ker se v vsakem okolju prijavljajo posebej.

**Imam dve trgovini.** Obe prijavite kot ločena poslovna prostora. V 3. koraku izberite, kateri se uporablja za račune in kateri za blagajno.
