# PayPal

Plačila PayPal potekajo prek vašega poslovnega računa PayPal. Kupec plača na PayPalovi strani, denar pa pristane na vašem računu PayPal.

## Kaj potrebujete

- Poslovni račun PayPal.
- Dostop do razvijalske nadzorne plošče PayPal na [developer.paypal.com](https://developer.paypal.com).

## V PayPalu ustvarite aplikacijo in webhook

1. V razvijalski nadzorni plošči PayPal preklopite na **Live** in ustvarite aplikacijo.
2. Kopirajte njen **Client ID** in **Secret**.
3. V isti aplikaciji dodajte webhook z naslovom `https://rabbitpay.net/api/v1/hooks/paypal`.
4. Izberite dogodka `CHECKOUT.ORDER.APPROVED` in `PAYMENT.CAPTURE.COMPLETED`.
5. Shranite in kopirajte **Webhook ID**.

Če RabbitPay gostite sami, namesto rabbitpay.net uporabite svoj naslov.

## Vpišite podatke PayPal

1. V RabbitPayu odprite **Nastavitve** in v kartici **Načini plačila** poiščite **PayPal**.
2. Prilepite **ID odjemalca**, **Skrivnost odjemalca** in **ID webhooka**.
3. Pritisnite **Shrani**.

   ![Podatki PayPal, pripravljeni za shranjevanje](https://cdn.rabbitpay.net/help/sl/dark/payments/paypal/paypal-keys.webp)

4. Pritisnite stikalo ob **PayPal**.

   ![PayPal je pripravljen in vklopljen](https://cdn.rabbitpay.net/help/sl/dark/payments/paypal/paypal-on.webp)

Brez ID-ja webhooka je vsako obvestilo PayPala zavrnjeno, zato ga ne izpustite.

## Kaj vidi vaš kupec

Na plačilni strani kupec izbere **PayPal**, plačilo potrdi na PayPalovi strani in se vrne.

![PayPal na plačilni strani](https://cdn.rabbitpay.net/help/sl/dark/payments/paypal/pay-with-paypal.webp)

Račun čez nekaj trenutkov postane **plačan**.

## Vračila

Plačilo PayPal vrnete tako, da denar pošljete nazaj v svojem računu PayPal, nato pa vračilo zabeležite na računu v RabbitPayu. Glejte [Vrnite denar](invoices/record-payment#vrnite-denar).
