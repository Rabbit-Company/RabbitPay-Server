# Predračuni

S predračunom kupca prosite za plačilo, preden izdate račun. Sam račun se izda, ko prispe denar.

Predračun ni račun: ima svoje zaporedje številk, se ne potrjuje pri FURS in ni v vaših evidencah DDV.

## Ustvarite predračun

1. Začnite [nov račun](invoices/create-invoice) ter vpišite kupca in postavke.
2. V kartici **Podatki** pritisnite **Predračun**, da se odprejo njegove možnosti.
3. Pod **Ko je predračun plačan** izberite, kaj naj se zgodi. Izbiri sta razloženi v naslednjem razdelku.

   ![Možnosti predračuna na obrazcu računa](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/options.webp)

4. Na dnu pritisnite **Ustvari predračun**.

   ![Gumb Ustvari predračun med gumbi](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/create-button.webp)

V predračun lahko spremenite tudi obstoječi osnutek z **Več** > **Ustvari predračun**.

Predračun ima svojo številko, oznaki **Predračun** in **Čaka na plačilo** ter datum, do katerega velja.

![Predračun, ki čaka na plačilo](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/pro-forma.webp)

## Izberite, kaj se zgodi ob plačilu

| Izbira                                          | Kaj se zgodi                                                                                 | Uporabite, ko                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| **Takoj izdaj račun**                           | Prvo plačilo predračun spremeni v račun z naslednjo številko računa.                         | Dobavite, ko kupec plača.      |
| **Za vsako plačilo izdaj račun za predplačilo** | Vsako plačilo dobi svoj račun za predplačilo za prejeti znesek. Končni račun izdate pozneje. | Dobavite pozneje ali po delih. |

Privzeto izbiro za nove predračune nastavite pod **Nastavitve** > **Številčenje dokumentov** > **Ko je predračun plačan**.

Za posamezen predračun jo spremenite z **Več** > **Spremeni, kaj se zgodi ob plačilu**. To je mogoče do prvega plačila.

![Sprememba tega, kaj se zgodi ob plačilu](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/what-happens-on-payment.webp)

## Pošljite ga in prejmite plačilo

Pritisnite **Pošlji** > **Pošlji predračun po e-pošti** ali kopirajte povezavo za plačilo. Kupec plača na plačilni strani kot pri vsakem računu.

![Meni Pošlji pri predračunu](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/send-menu.webp)

Bančno nakazilo [zabeležite sami](invoices/record-payment) z **Zabeleži plačilo**.

## Ko se račun izda takoj

Prvo plačilo predračun spremeni v račun. Ta dobi naslednjo številko računa, pokaže plačilo in pove, iz katerega predračuna je nastal.

![Račun, izdan iz plačanega predračuna](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/became-invoice.webp)

## Ko zaračunavate predplačila

Vsako plačilo ustvari račun za predplačilo. Našteti so v kartici **Računi za predplačilo** na predračunu, seštevki pa pokažejo, koliko je **Plačano s predplačilom**.

![Predračun z enim računom za predplačilo](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/advance-invoices.webp)

Ko dobavite, pritisnite **Več** > **Izdaj končni račun**. Končni račun dobi naslednjo številko računa in odšteje vse račune za predplačilo, ločeno po stopnjah DDV.

![Izdaj končni račun v meniju Več](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/issue-final.webp)

## Kaj še lahko naredite

Odprite predračun in pritisnite **Več**.

![Meni Več pri predračunu](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/more-menu.webp)

- **Uredi** ga spremeni. To je mogoče do prvega plačila.
- **Takoj izdaj račun** ga spremeni v račun, ne da bi čakali na plačilo.
- **Prekliči račun** ga umakne. Predračuna ni mogoče izbrisati, le preklicati.

Če želite videti samo predračune, v prvem filtru seznama računov izberite **Predračuni**.

![Seznam računov, ki kaže samo predračune](https://cdn.rabbitpay.net/help/sl/dark/invoices/pro-forma/filter.webp)
