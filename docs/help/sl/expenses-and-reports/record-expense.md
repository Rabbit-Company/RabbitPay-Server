# Zabeležite strošek

Strošek je vse, kar vaše podjetje plača: račun dobavitelja, blagajniški račun, najemnina ali naročnina. Zabeležite ga enkrat in prikaže se v poročilih ter, če je neplačan, na seznamu obveznosti.

## Odprite Stroške

V meniju projekta pritisnite **Stroški**.

![Stroški v meniju projekta](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/open-expenses.webp)

Stran našteje vaše stroške, najnovejše najprej, pod njimi pa **Ponavljajoče stroške**. Gumbi na vrhu začnejo vse na tej strani.

![Stran Stroški](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/expenses.webp)

## Dodajte strošek

1. Pritisnite **Dodaj strošek** ali kjerkoli v projektu pritisnite `F6`.
2. Vpišite **Opis**, na primer `Poštnine, oktober`.
3. Izberite **Dobavitelja**. Začnite tipkati ime ali davčno številko in ga izberite s seznama. Podjetje iz registra FURS izpolni tudi davčno številko in državo. Novega dobavitelja preprosto vpišite.
4. Izberite **Kategorijo**. Izberite eno od običajnih ali vpišite svojo.

   ![Izbira kategorije](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/choose-category.webp)

5. Pod **Obravnava v evidencah DDV** izberite, kako strošek vstopi v vašo evidenco odbitka DDV (KPR). Za običajen račun slovenskega dobavitelja je to **Domača nabava**. Za strošek, ki v evidenco ne sodi, na primer pri malem davčnem zavezancu, pustite **Ni vključeno v evidence DDV**.
6. Vpišite **Skupni znesek**, ki ga je dobavitelj zaračunal, z DDV.
7. V tabeli stopenj vpišite **Davčno osnovo** ob stopnji z računa, na primer 22 %. **DDV/davek na računu** in **Odbitni DDV/davek** se izračunata sama. Račun z več stopnjami ima vpisano osnovo ob vsaki.

   ![Znesek, DDV po stopnjah in kaj se odbije](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/amounts.webp)

Vrstica pod zneski pokaže dejanski strošek za vaše podjetje, skupni znesek brez odbitnega DDV.

Pri domači nabavi so prikazana še polja, ki jih potrebuje evidenca KPR:

| Polje                                             | Kaj vpišete                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Davčna številka ali ID za DDV dobavitelja**     | Izpolni se ob izbiri dobavitelja iz registra.                                     |
| **Datum izdaje računa**, **Datum prejema računa** | Datuma z računa in dan, ko ste ga prejeli.                                        |
| **Datum dobave**                                  | Le, če se razlikuje od datuma računa.                                             |
| **Vrsta nabave**                                  | **Običajni strošek**, **Nepremičnina** ali **Drugo osnovno sredstvo**.            |
| **Obravnava po 88.b členu**                       | Pustite **1, redni obračun**, razen pri popravku za nazaj.                        |
| **DDV odbit po začasnem odbitnem deležu**         | Vklopite, kadar ste odbitni DDV izračunali z letošnjim začasnim odbitnim deležem. |

## Izvirni račun shranite zraven

1. Vpišite **Številko računa dobavitelja**.
2. Pod **Izvirni račun dobavitelja** izberite PDF, fotografijo blagajniškega računa ali XML e-računa. Do 20 MB.

Datoteka se hrani ob strošku, zato imate izvirnik pri roki, ko ga zahteva računovodja ali davčni urad.

## Datumi in plačilo

1. **Datum stroška** je dan, ki mu strošek pripada. Poročila uporabljajo ta datum.
2. **Datum zapadlosti** je dan, do katerega dobavitelj pričakuje plačilo. Pri že plačanem pustite prazno.
3. Če boste plačali z nakazilom, vpišite **IBAN za plačilo** in **Sklic za plačilo**. Brez IBAN-a se uporabi račun dobavitelja. Glejte [Plačajte dobaviteljem](expenses-and-reports/pay-suppliers).
4. Vklopite **Plačano**, če je strošek že plačan, in nastavite **Datum plačila**.
5. Pritisnite **Dodaj strošek**.

   ![Dokončan strošek, pripravljen za dodajanje](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/filled.webp)

Strošek se pojavi na vrhu seznama.

![Novi strošek na seznamu](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/list.webp)

## Spremenite, označite kot plačano ali izbrišite strošek

Stikalo **Plačano** v vsaki vrstici z enim klikom označi strošek kot plačan ali neplačan. **Uredi** odpre strošek, da ga spremenite. **Izbriši** ga odstrani iz poročil.

![Stikalo in gumbi v vrstici stroška](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/row-actions.webp)

## Poiščite strošek

S **Stanjem** pokažete samo plačane ali neplačane stroške, z **Od** in **Do** pa eno obdobje.

![Samo še neplačani stroški](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/record-expense/unpaid.webp)

## Kategorije brez odbitnega DDV

Pri nekaterih stroških DDV ni odbiten. Ko izberete **Reprezentanca**, **Kazni in globe** ali **Donacije**, RabbitPay **Odbitni DDV/davek** nastavi na **Nič** in pod kategorijo izpiše pravilo:

- Pri **reprezentanci**, na primer poslovnem kosilu, vstopnega DDV ni mogoče odbiti, davčno priznana pa je le polovica stroška.
- **Kazni in globe** nimajo DDV in niso davčno priznan strošek.
- Pri **donacijah** DDV ni odbiten. Niso davčno priznan strošek, lahko pa štejejo za olajšavo za donacije.
