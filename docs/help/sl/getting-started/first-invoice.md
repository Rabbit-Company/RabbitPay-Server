# Vaš prvi račun

V petih minutah vklopite način plačila, dodate kupca, izdate račun in ga pošljete.

## Povejte kupcem, kam naj plačajo

Bančno nakazilo nastavite najhitreje, saj potrebuje le številko vašega računa.

1. Odprite **Nastavitve** in poiščite kartico **Načini plačila**.
2. Pod **Bančno nakazilo** vpišite svoj **IBAN**. **BIC ali SWIFT** in **Ime banke** nista obvezna, pomagata pa kupcem iz tujine. Polje **Prejemnik** lahko ostane prazno, kadar je račun odprt na ime vašega podjetja.
3. **Plačilno kodo** pustite na **Izberi zame**. RabbitPay nato natisne kodo QR, ki jo znajo prebrati banke v državi vašega kupca. Za slovenske kupce je to UPN QR.
4. Pritisnite **Shrani**.

   ![Podatki za bančno nakazilo](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/bank-transfer.webp)

5. Preverite, da je stikalo ob **Bančno nakazilo** vklopljeno.

   ![Bančno nakazilo je vklopljeno](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/bank-transfer-on.webp)

Kartice, PayPal in kriptovalute vklopite v isti kartici in zahtevajo nekaj minut več. Glejte [Plačila](payments).

## Začnite nov račun

1. V meniju projekta pritisnite **Računi**.
2. Pritisnite **Nov račun** ali kjerkoli v projektu pritisnite `F2`.

   ![Stran Računi z gumbom Nov račun na desni](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/invoices-empty.webp)

## Dodajte kupca

1. Pritisnite polje **Kupec** in izberite **Dodaj novega kupca**. Naslednjič preprosto začnite tipkati ime kupca, ki ga že imate.

   ![Dodajanje kupca, ne da bi zapustili račun](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/add-customer.webp)

2. Pod **Ime** začnite tipkati ime ali davčno številko podjetja in ga izberite s seznama. RabbitPay naslov, ID za DDV, davčno in matično številko izpolni iz javnega registra FURS.

   ![Kupec, najden v registru FURS](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/find-customer.webp)

3. Vpišite **E-pošto**, na katero naj bo račun poslan.
4. Pod **Vrsta** izberite **Podjetje** ali **Fizična oseba**.
5. Preverite **Naslov**, **Kraj**, **Poštno številko** in **Državo**. Če kupca ni v registru, jih vpišite ročno, pri zavezancu za DDV pa dodajte še **ID za DDV**. RabbitPay ga ob shranjevanju preveri.
6. Pritisnite **Ustvari kupca**.

   ![Izpolnjen novi kupec](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/new-customer.webp)

> **Namig:** Podjetje iz druge države EU najdete tako, da pod **Ime** vpišete njegov ID za DDV.

Kupec je shranjen v vašem projektu pod **Kupci** in izbran na računu.

## Dodajte, kaj zaračunavate

1. Pod **Postavke** vpišite opis, na primer `Prenova spletne strani`.
2. Vpišite količino, izberite enoto, če želite, da je natisnjena, in vpišite ceno na enoto brez DDV.
3. Preverite davčno stopnjo. RabbitPay jo je že predlagal glede na vaše davčne nastavitve in državo kupca.
4. Za vsako nadaljnjo postavko pritisnite **Dodaj postavko**.

   ![Ena postavka z izračunanimi zneski spodaj](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/line-items.webp)

Zneski pod postavkami se posodabljajo med tipkanjem. Če pogosto prodajate iste stvari, jih enkrat shranite pod **Artikli** in jih tukaj samo izberite.

## Izdajte račun

1. Preverite **Rok plačila**. Začne se 14 dni od danes.
2. Pritisnite **Ustvari in izdaj**.

   ![Dokončan obrazec računa](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/invoice-form.webp)

Račun ima zdaj svojo številko in ga je mogoče plačati. Urejati ga ni več mogoče, kar zakon tudi pričakuje od izdanega računa.

![Izdan račun](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/invoice-issued.webp)

Še niste prepričani? **Predogled** pokaže račun tako, kot ga bo videl kupec, ne da bi se karkoli shranilo, **Ustvari osnutek** pa ga shrani brez številke, da ga dokončate pozneje. Vse o osnutkih, dobropisih in predračunih je v poglavju [Računi](invoices).

## Pošljite ga kupcu

1. Na računu pritisnite **Pošlji** in izberite **Pošlji račun**.

   ![Meni Pošlji na računu](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/send-menu.webp)

2. Preverite naslov pod **Prejemnik** in po želji dodajte **Sporočilo**.
3. Izberite, kaj gre zraven: račun kot PDF, e-račun (e-SLOG XML) in povezava do plačilne strani.
4. Pritisnite **Pošlji račun**.

   ![E-pošta, pripravljena za pošiljanje](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/email-invoice.webp)

Vsaka poslana e-pošta je navedena na računu in pod **E-pošta** v meniju projekta.

## Kaj vidi vaš kupec

Povezava v e-pošti odpre plačilno stran. Ta pokaže znesek, rok plačila in načine plačila, ki ste jih vklopili. Pri bančnem nakazilu kupec dobi podatke o vašem računu in kodo QR, ki jo skenira z bančno aplikacijo.

![Plačilna stran, kot jo vidi vaš kupec](https://cdn.rabbitpay.net/help/sl/dark/getting-started/first-invoice/payment-page.webp)

Bi jo radi videli sami? Na računu pritisnite **Pošlji** > **Odpri plačilno stran**.

## Ko denar prispe

Plačila s kartico, prek PayPala ali s kriptovalutami se zabeležijo sama. Bančno nakazilo zabeležite sami.

1. Odprite račun in pritisnite **Zabeleži plačilo**.
2. Vpišite znesek in datum, ko je denar prispel.
3. Shranite. Račun postane **plačan**.
