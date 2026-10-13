# Kupci

Kupca shranite enkrat in ga izberete na vsakem računu. Vsak kupec ima stran, ki pokaže, koliko dolguje in kako plačuje.

## Odprite Kupce

V meniju projekta pritisnite **Kupci**.

![Kupci v meniju projekta](https://cdn.rabbitpay.net/help/sl/dark/invoices/customers/open-customers.webp)

![Seznam kupcev](https://cdn.rabbitpay.net/help/sl/dark/invoices/customers/customers.webp)

## Dodajte kupca

1. Pritisnite **Nov kupec** ali kjerkoli v projektu pritisnite `F3`.
2. Vpišite **Ime**. Pri podjetju začnite tipkati njegovo ime ali davčno številko in ga izberite s seznama. Naslov in davčne številke se izpolnijo iz javnega registra FURS. Za podjetje iz druge države EU vpišite njegov ID za DDV.
3. Vpišite **E-pošto**, na katero se pošiljajo računi. Brez nje je račune mogoče samo natisniti ali prenesti.
4. Pod **Vrsta** izberite **Podjetje** ali **Fizična oseba**. Podjetju iz druge države EU lahko izdate račun z obrnjeno davčno obveznostjo.
5. Izpolnite **Naslov**, **Kraj**, **Poštno številko** in **Državo**.
6. Pri podjetju vpišite **ID za DDV**, če je zavezanec za DDV, ali **Davčno številko**, če ni.
7. Pritisnite **Ustvari kupca**. Ko je vpisan ID za DDV, gumb **Shrani in preveri v VIES** številko preveri tudi v registru EU.

   ![Dodajanje fizične osebe kot kupca](https://cdn.rabbitpay.net/help/sl/dark/invoices/customers/new-customer.webp)

Kupca lahko dodate tudi med pisanjem računa, z **Dodaj novega kupca** v polju **Kupec**.

**Podatki za e-račune** na dnu obrazca so za proračunske uporabnike, ki e-račune prejemajo prek UJP. Glejte [Slovenska zakonodaja](slovenia).

## Poiščite, spremenite ali izbrišite kupca

V iskalno polje nad seznamom vpišite ime, e-poštni naslov ali ID za DDV.

![Iskanje med kupci](https://cdn.rabbitpay.net/help/sl/dark/invoices/customers/search.webp)

Vsaka vrstica ima tri gumbe.

![Gumbi v vrstici kupca](https://cdn.rabbitpay.net/help/sl/dark/invoices/customers/row-actions.webp)

- **Računi** odprejo seznam računov, filtriran na tega kupca.
- **Uredi** spremeni podatke. Že izdani računi ohranijo podatke, s katerimi so bili izdani.
- **Izbriši** odstrani kupca, ki nima računov.

Stolpec **DDV** pokaže ID za DDV in ali je bil preverjen: **veljaven**, **neveljaven** ali **nepreverjen**.

## Preberite stran kupca

Pritisnite ime kupca, da odprete njegovo stran.

![Stran enega kupca](https://cdn.rabbitpay.net/help/sl/dark/invoices/customers/profile.webp)

| Del                     | Kaj pokaže                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Štiri številke na vrhu  | Izdani računi, koliko jih je neplačanih in zapadlih, koliko jih je bilo plačanih pravočasno ter povprečni čas do plačila |
| **Seštevki**            | Koliko je bilo obračunano, prejeto in koliko je še za plačilo, za vsako valuto                                           |
| **Podatki**             | Kontaktni in davčni podatki                                                                                              |
| **Zgodovina plačil**    | Prvi in zadnji račun ter zadnje plačilo                                                                                  |
| **Ponavljajoči računi** | Kaj se temu kupcu zaračunava po urniku                                                                                   |
| **Računi**              | Vsi računi tega kupca                                                                                                    |

Gumbi na vrhu začnejo običajne naslednje korake.

![Gumbi na strani kupca](https://cdn.rabbitpay.net/help/sl/dark/invoices/customers/profile-actions.webp)

- **Uredi** spremeni podatke.
- **Odpri med računi** pokaže kupčeve račune na seznamu računov, kjer jih lahko še naprej filtrirate.
- **Nov račun** začne račun z že izbranim kupcem.
