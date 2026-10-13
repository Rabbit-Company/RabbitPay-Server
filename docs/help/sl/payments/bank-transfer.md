# Bančno nakazilo

Najpreprostejši način plačila. Kupec vidi vaš račun, znesek in sklic ter plača iz svoje banke. Potrebujete le svoj IBAN.

## Vpišite bančne podatke

1. Odprite **Nastavitve** in v kartici **Načini plačila** poiščite **Bančno nakazilo**.
2. Vpišite svoj **IBAN**. RabbitPay preveri, ali je številka veljavna.
3. Po želji vpišite **BIC ali SWIFT** in **Ime banke**. Pomagata kupcem iz tujine.
4. Polje **Prejemnik** pustite prazno, kadar je račun odprt na uradno ime vašega podjetja. Izpolnite ga le, če je ime na računu drugačno.
5. Pritisnite **Shrani** in preverite, da je stikalo ob **Bančno nakazilo** vklopljeno.

   ![Bančno nakazilo z izpolnjenimi podatki](https://cdn.rabbitpay.net/help/sl/dark/payments/bank-transfer/details.webp)

## Izberite kodo QR

Kupec lahko kodo QR skenira z bančno aplikacijo, ta pa izpolni vaš račun, znesek in sklic.

![Polje Plačilna koda](https://cdn.rabbitpay.net/help/sl/dark/payments/bank-transfer/payment-code.webp)

| Plačilna koda          | Uporabite, ko                                                              |
| ---------------------- | -------------------------------------------------------------------------- |
| **Izberi zame**        | Priporočeno. Slovenski račun dobi UPN QR, vsak drug evrski račun GiroCode. |
| **GiroCode (SEPA)**    | Vaši kupci imajo banko kjerkoli v evroobmočju zunaj Slovenije.             |
| **UPN QR (Slovenija)** | Vaši kupci uporabljajo slovenske bančne aplikacije.                        |
| **Brez plačilne kode** | Ne želite prikazati kode.                                                  |

Kodi nista zamenljivi: slovenske bančne aplikacije berejo UPN QR, preostanek evroobmočja GiroCode. Koda je prikazana samo pri računih v evrih in vedno zahteva znesek, ki je še odprt, zato delno plačan račun zahteva preostanek.

## Kaj vidi vaš kupec

Na plačilni strani kupec izbere **Bančno nakazilo**.

![Bančno nakazilo na plačilni strani](https://cdn.rabbitpay.net/help/sl/dark/payments/bank-transfer/choose.webp)

Stran nato pokaže kodo QR, podatke o vašem računu in **Sklic**, vsakega z gumbom **Kopiraj**.

![Bančni podatki in koda QR](https://cdn.rabbitpay.net/help/sl/dark/payments/bank-transfer/pay-by-transfer.webp)

Isti podatki in ista koda so natisnjeni na samem računu.

![Bančni podatki na natisnjenem računu](https://cdn.rabbitpay.net/help/sl/dark/payments/bank-transfer/on-the-invoice.webp)

## Ko denar prispe

RabbitPay ne spremlja vašega bančnega računa, zato bančno nakazilo ni nikoli samo označeno kot plačano. Ko denar prispe, odprite račun in pritisnite **Zabeleži plačilo**. Glejte [Zabeležite plačilo](invoices/record-payment).

Po sklicu prepoznate plačilo. Poiščite ga pod **Računi**, ko prispe nakazilo brez znanega imena.
