# Ustvarite račun

Račun potrebuje kupca, vsaj eno postavko in rok plačila. Vse drugo je neobvezno. Izdate ga lahko takoj ali ga shranite kot osnutek in dokončate pozneje.

## Začnite nov račun

1. V meniju projekta pritisnite **Računi**.
2. Pritisnite **Nov račun**. Kjerkoli v projektu enako naredi `F2`.

   ![Stran Računi z gumbom Nov račun na desni](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/invoices.webp)

Obrazec ima dve kartici: **Podatki** zgoraj in **Postavke** pod njo.

![Prazen obrazec računa](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/empty-form.webp)

## Izberite kupca

1. Pritisnite polje **Kupec** in začnite tipkati ime, e-poštni naslov ali ID za DDV.
2. Izberite kupca s seznama.

   ![Iskanje kupca z začetkom imena](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/choose-customer.webp)

Ga še ni na seznamu? Na dnu seznama izberite **Dodaj novega kupca** in vpišite podatke, ne da bi zapustili račun. Glejte [Kupci](invoices/customers).

Kupca lahko pustite praznega pri prodaji nekomu, ki ga ni treba navesti, kjer zakon to dovoljuje.

## Dodajte postavke

1. Pod **Postavke** pritisnite polje za opis. S tipkanjem poiščite [artikle](invoices/items), ki ste jih shranili, in izberite enega. Enota, cena in davčna stopnja se izpolnijo same. Ali pa preprosto vpišite svoj opis.
2. Vpišite količino v **Kol.**
3. Preverite **Enoto**, **Ceno na enoto** brez DDV in **Davek %**.
4. Za vsako nadaljnjo postavko pritisnite **Dodaj postavko**. Križec na koncu vrstice postavko odstrani.

   ![Dve postavki z izračunanimi zneski pod njima](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/lines.webp)

RabbitPay davčno stopnjo predlaga glede na vaše davčne nastavitve, artikel in državo kupca. Za zavezanca za DDV iz druge države EU na primer predlaga obrnjeno davčno obveznost. Če stopnjo spremenite ročno, opomba pod postavko pokaže, kaj je bilo predlagano, z **Uporabi predlog** pa se vrnete. Kadar postavka nima DDV, ob **Zakaj DDV ni obračunan** izberite razlog, da se natisne prava klavzula.

> **Opomba:** Stopnja ni predlagana? Najprej nastavite državo in status DDV. Glejte [Nastavite, kako za vas velja DDV](getting-started/company-details#nastavite-kako-za-vas-velja-ddv).

## Nastavite datume, popust in opombe

Vse to je v kartici **Podatki**.

![Rok plačila, popust in opombe](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/details.webp)

- **Valuta** se začne z valuto projekta. Izberite drugo, če želite račun izdati v njej.
- **Rok plačila** je zadnji dan za plačilo. Začne se 14 dni od danes.
- **Datum dobave** je dan, ko je bilo blago ali storitev dobavljena. Izpolnite ga le, kadar to ni datum računa. DDV se poroča v obdobju tega datuma.
- **Popust** je en znesek za celoten račun, pred davkom.
- **Opombe** so natisnjene na računu.

Seštevki pod postavkami med tipkanjem kažejo znesek brez DDV, popust, davek in skupni znesek.

![Seštevki računa](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/totals.webp)

## Dodajte številko kupčevega naročila

Nekateri kupci, in vsi proračunski uporabniki, na računu potrebujejo številko svojega naročila ali pogodbe.

1. Pritisnite **Referenčni dokument**, da se odpre.
2. Izberite **Vrsto**: **Naročilo kupca** ali **Pogodba**.
3. Vpišite **Številko** in, če ga imate, **Datum**.

   ![Odprt referenčni dokument](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/reference-document.webp)

Dodate ali spremenite ga lahko tudi na izdanem računu z **Uredi** ob napisu **Referenčni dokument**.

## Shranite ali izdajte

Na dnu obrazca je pet gumbov.

![Gumbi na dnu obrazca](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/buttons.webp)

| Gumb                  | Kaj naredi                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| **Prekliči**          | Zapusti obrazec brez shranjevanja.                                         |
| **Predogled**         | Odpre račun kot PDF, natanko tak, kot ga bo videl kupec. Nič se ne shrani. |
| **Ustvari osnutek**   | Shrani račun brez številke, da ga lahko pozneje spremenite.                |
| **Ustvari predračun** | Kupca prosi, naj najprej plača. Glejte [Predračuni](invoices/pro-forma).   |
| **Ustvari in izdaj**  | Računu dodeli številko in ga takoj omogoči za plačilo.                     |

![Dokončan obrazec, pripravljen za shranjevanje ali izdajo](https://cdn.rabbitpay.net/help/sl/dark/invoices/create-invoice/form.webp)

Kaj sledi: [Osnutki in izdani računi](invoices/drafts) ter [Pošljite račun](invoices/send).
