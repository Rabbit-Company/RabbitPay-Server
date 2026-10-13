# Ponavljajoči računi

Za pavšal, naročnino ali gostovanje račun nastavite enkrat. RabbitPay ga ustvari po urniku in ga, če želite, izda ter pošlje kupcu po e-pošti.

## Odprite Ponavljajoče

V meniju projekta pritisnite **Ponavljajoči**.

![Ponavljajoči v meniju projekta](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/open-recurring.webp)

![Stran Ponavljajoči pred prvim vnosom](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/empty.webp)

## Nastavite urnik

1. Pritisnite **Nov ponavljajoči račun**.
2. Vpišite **Ime**. Vidite ga samo vi.
3. Izberite **Kupca**.
4. Pod **Vsake** in **Obdobje** nastavite, kako pogosto se ponavlja, na primer vsak 1 mesec.
5. Pod **Prvi račun dne** izberite dan prvega računa. Naslednji računi nastanejo na isti dan vsakega obdobja.
6. Pod **Se konča** izberite **Nikoli, dokler ne prekličem**, **Po določenem številu računov** ali **Na določen datum**.

   ![Urnik ponavljajočega računa](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/schedule.webp)

Vrstica pod polji našteje datume naslednjih računov, da urnik preverite, preden ga zaženete.

Še tri izbire določajo, kakšen je vsak račun:

| Polje                     | Kaj določa                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vsak račun pokriva**    | **Obdobje, ki se začne z datumom računa** zaračuna vnaprej. **Obdobje pred datumom računa** zaračuna za nazaj in datum dobave nastavi na zadnji dan tega obdobja. |
| **Plačilni rok v dnevih** | Koliko dni po nastanku zapade vsak račun.                                                                                                                         |
| **Ko nastane račun**      | **Izdaj in pošlji kupcu po e-pošti**, **Izdaj brez pošiljanja** ali **Shrani kot osnutek za moj pregled**.                                                        |

## Dodajte postavke

Postavke dodajte kot na vsakem [računu](invoices/create-invoice#dodajte-postavke).

![Postavka, ki navede mesec, za katerega velja](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/lines.webp)

V opis ali opombe zapišite `{month}`, `{year}` ali `{period}` in RabbitPay to zamenja z obdobjem, ki ga pokriva posamezen račun. `Vzdrževanje spletne strani za {month} {year}` na oktobrskem računu postane `Vzdrževanje spletne strani za oktober 2026`.

## Zaženite ga

1. Pritisnite **Predogled naslednjega računa**, da vidite prvi račun kot PDF.
2. Pritisnite **Zaženi ponavljajoči račun**.

   ![Dokončan obrazec](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/form.webp)

Stran ponavljajočega računa pokaže njegov urnik, vsebino vsakega računa in do zdaj ustvarjene račune.

![Ponavljajoči račun, ki teče](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/started.webp)

## Ustavite, spremenite ali končajte ga

To naredijo gumbi na vrhu njegove strani.

![Gumbi ponavljajočega računa](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/actions.webp)

| Gumb                             | Kaj naredi                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Uredi**                        | Spremeni urnik ali postavke. Že ustvarjeni računi ostanejo, kot so.                                          |
| **Predogled naslednjega računa** | Pokaže naslednji račun kot PDF.                                                                              |
| **Ustvari naslednji račun zdaj** | Račun, načrtovan za naslednji datum, ustvari takoj in urnik premakne naprej.                                 |
| **Ustavi**                       | Preneha ustvarjati račune, dokler ne pritisnete **Nadaljuj**. Obdobja, zamujena med premorom, se preskočijo. |
| **Prekliči**                     | Ga dokončno konča. Že ustvarjeni računi ostanejo, kot so.                                                    |
| **Izbriši**                      | Ga popolnoma odstrani. Mogoče le, dokler ni bilo še nič zaračunano.                                          |

![Takojšnja izdelava naslednjega računa](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/create-now.webp)

Vsak račun, ki ga ustvari, je naveden pod **Ustvarjeni računi** in se odpre kot vsak drug račun.

![Prvi račun, ki ga je ustvaril](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/invoice-created.webp)

## Poglejte vse ponavljajoče račune

**Ponavljajoči** jih naštejejo s kupcem, urnikom, zneskom, datumom naslednjega računa in številom ustvarjenih. Vrstica nad tabelo oceni, koliko aktivni prinesejo na mesec.

![Seznam ponavljajočih računov](https://cdn.rabbitpay.net/help/sl/dark/invoices/recurring/list.webp)

Če računa ni mogoče ustvariti, na primer ker je bil kupec izbrisan, RabbitPay poskusi znova sam in na seznamu pokaže **Zadnji zagon ni uspel**. Po več zaporednih neuspehih ponavljajoči račun ustavi. Odpravite težavo in pritisnite **Nadaljuj**.
