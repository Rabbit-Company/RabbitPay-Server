# Osnutki in izdani računi

Osnutek je račun v pripravi. Izdan račun je dokončen. Ta stran pokaže razliko, kako pridete od enega do drugega in kako račun spet najdete.

## Kaj je osnutek

Osnutek ima namesto številke začasno oznako, na primer `DRAFT-8KQ2LM4P`. Lahko ga spremenite ali izbrišete, kupec pa ga še ne more plačati.

![Osnutek z gumbom Izdaj račun na vrhu](https://cdn.rabbitpay.net/help/sl/dark/invoices/drafts/draft.webp)

Ker se številka dodeli šele ob izdaji, izbris osnutka nikoli ne pusti vrzeli v številčenju.

## Spremenite ali izbrišite osnutek

1. Odprite osnutek in pritisnite **Več**.

   ![Meni Več pri osnutku](https://cdn.rabbitpay.net/help/sl/dark/invoices/drafts/draft-more.webp)

2. Izberite **Uredi**, spremenite, kar je treba, in pritisnite **Shrani spremembe**.

   ![Urejanje osnutka](https://cdn.rabbitpay.net/help/sl/dark/invoices/drafts/edit-draft.webp)

**Več** > **Izbriši osnutek** odstrani osnutek, ki ga ne potrebujete več. **Več** > **Ustvari predračun** ga spremeni v [predračun](invoices/pro-forma).

## Izdajte račun

Odprite osnutek in pritisnite **Izdaj račun**.

![Račun po izdaji](https://cdn.rabbitpay.net/help/sl/dark/invoices/drafts/issued.webp)

Račun dobi naslednjo številko iz vašega zaporedja, njegovo stanje postane **odprt** in ga je mogoče plačati. Odslej ga ni več mogoče urejati ali izbrisati. Če ga želite spremeniti, [izdajte dobropis](invoices/credit-notes).

## Poiščite račun

**Računi** naštejejo vse dokumente, najnovejše najprej. Vrstica nad tabelo sešteje, koliko je bilo pri prikazanih računih obračunano, plačano in koliko je še za plačilo.

![Seznam računov s filtri](https://cdn.rabbitpay.net/help/sl/dark/invoices/drafts/list.webp)

| Filter                          | Kaj naredi                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Išči po številki ali sklicu** | Poišče račun po njegovi številki.                                                                |
| **Vsi dokumenti**               | Seznam zoži na predračune, naročila v trgovini, ki čakajo na plačilo, ali račune za predplačilo. |
| **Vsa stanja**                  | Pokaže samo eno stanje, na primer **zapadel**.                                                   |
| **Vsi kupci**                   | Pokaže račune enega kupca.                                                                       |

![Seznam, ki kaže samo osnutke](https://cdn.rabbitpay.net/help/sl/dark/invoices/drafts/filter-drafts.webp)

Pritisnite številko, da odprete račun, ali ime kupca, da odprete [kupca](invoices/customers).

## Kaj pomeni posamezno stanje

| Stanje       | Pomen                                                     |
| ------------ | --------------------------------------------------------- |
| osnutek      | Še ni izdan. Nima številke in ga ni mogoče plačati.       |
| odprt        | Izdan in čaka na plačilo.                                 |
| zapadel      | Izdan, rok plačila je že potekel. Rok je izpisan oranžno. |
| delno plačan | Del zneska je že prispel.                                 |
| plačan       | Plačan v celoti.                                          |
| preklican    | Umaknjen. Njegova številka ostane porabljena.             |
| vrnjen       | Plačilo je bilo vrnjeno kupcu.                            |
