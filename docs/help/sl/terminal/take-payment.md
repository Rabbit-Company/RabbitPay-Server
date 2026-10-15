# Plačilo

Ko pritisnete **Zaračunaj**, prodaja postane izdan račun, blagajna pa pokaže znesek in kodo QR.

![Znesek za plačilo in koda QR](https://cdn.rabbitpay.net/help/sl/dark/terminal/take-payment/scan.webp)

## Kupec plača s telefonom

Kupec kodo skenira s kamero telefona in plača na [plačilni strani](payments/payment-page), s kartico, prek PayPala ali s kriptovaluto, kar ste vklopili. Blagajna kaže, da čaka na plačilo, in se sama preklopi na **Plačano**, takoj ko plačilo prispe.

**Kopiraj povezavo** kopira plačilno povezavo, na primer da jo pošljete v sporočilu.

## Gotovina

1. Pritisnite **Plačano z gotovino**.
2. V **Prejeta gotovina** vpišite znesek, ki vam ga je dal kupec, ali pritisnite enega od gumbov z zaokroženim zneskom ali **Točno**.
3. RabbitPay pokaže, koliko drobiža morate vrniti.
4. Pritisnite **Zabeleži plačilo z gotovino**.

   ![Prejeta gotovina in drobiž za vrnitev](https://cdn.rabbitpay.net/help/sl/dark/terminal/take-payment/cash.webp)

Če kupec da manj od skupnega zneska, gumb zabeleži ta del v gotovini, preostanek pa ostane za plačilo, na primer s kartico prek kode.

## Plačano

Blagajna pokaže **Plačano**, skupni znesek in z velikimi črkami drobiž, ki ga morate vrniti.

![Prodaja je plačana in kaže drobiž](https://cdn.rabbitpay.net/help/sl/dark/terminal/take-payment/paid.webp)

Od tu lahko kupcu date [račun](terminal/receipts). Za naslednjega kupca pritisnite **Nova prodaja** ali Enter na tipkovnici.

## Davčno potrjevanje

Z [davčnim potrjevanjem](slovenia/fiscal-verification) se vsaka prodaja, plačana z gotovino, s kartico ali s kriptovaluto, pošlje FURS v trenutku plačila. Prodaje na blagajni so oštevilčene z napravo blagajne, na primer `PP1-BLAG1-1`, račun pa ima ZOI, EOR in kodo QR za FURS.
