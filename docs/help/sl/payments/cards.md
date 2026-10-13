# Kartice s Stripom

Plačila s kartico potekajo prek vašega računa Stripe. Kupec plača na Stripovi strani, zato podatki o kartici nikoli ne pridejo do RabbitPaya, denar pa pristane na vašem računu Stripe.

## Kaj potrebujete

- Račun Stripe, ki lahko sprejema plačila. Ustvarite ga na [stripe.com](https://stripe.com).
- Nekaj minut v nadzorni plošči Stripe.

## Povejte Stripu, kam naj sporoča plačila

Stripe mora RabbitPayu sporočiti, ko je kupec plačal. Temu se reče webhook.

1. V nadzorni plošči Stripe odprite **Developers** > **Webhooks** in dodajte končno točko.
2. Kot naslov vpišite `https://rabbitpay.net/api/v1/hooks/stripe`.
3. Izberite dogodek `checkout.session.completed`.
4. Shranite in kopirajte **signing secret**, ki ga pokaže Stripe. Začne se z `whsec_`.

Če RabbitPay gostite sami, namesto rabbitpay.net uporabite svoj naslov.

## Vpišite ključa Stripe

1. V nadzorni plošči Stripe odprite **Developers** > **API keys** in kopirajte **secret key**. Začne se s `sk_live_`.
2. V RabbitPayu odprite **Nastavitve** in v kartici **Načini plačila** poiščite **Stripe**.

   ![Stripe pred nastavitvijo](https://cdn.rabbitpay.net/help/sl/dark/payments/cards/stripe-empty.webp)

3. Prilepite **Skrivni ključ** in **Skrivnost za podpis webhooka**.
4. Pritisnite **Shrani**.

   ![Skrivnosti Stripe, pripravljeni za shranjevanje](https://cdn.rabbitpay.net/help/sl/dark/payments/cards/stripe-keys.webp)

5. Pritisnite stikalo ob **Stripe**.

   ![Stripe je pripravljen in vklopljen](https://cdn.rabbitpay.net/help/sl/dark/payments/cards/stripe-on.webp)

Obe skrivnosti sta shranjeni šifrirano in nista več prikazani.

> **Namig:** Če želite najprej preizkusiti, uporabite ključa Stripovega testnega načina. Skrivni ključ se takrat začne s `sk_test_`, plačate pa s Stripovimi testnimi številkami kartic.

## Kaj vidi vaš kupec

Na plačilni strani kupec izbere **Stripe**, plača na Stripovi strani in se vrne.

![Stripe na plačilni strani](https://cdn.rabbitpay.net/help/sl/dark/payments/cards/pay-by-card.webp)

Račun čez nekaj trenutkov postane **plačan**, ne da bi vi karkoli naredili.

## Vračila

Plačilo s kartico vrnete tako, da denar pošljete nazaj v nadzorni plošči Stripe, nato pa vračilo zabeležite na računu v RabbitPayu. Glejte [Vrnite denar](invoices/record-payment#vrnite-denar).

## Če se plačila ne zabeležijo

- Preverite, da je naslov webhooka natanko tak kot zgoraj in da je izbran dogodek `checkout.session.completed`.
- Preverite, da **Skrivnost za podpis webhooka** pripada temu webhooku. Vsak webhook v Stripu ima svojo.
- Stran webhooka v Stripu našteje vsako dostavo in ali jo je RabbitPay sprejel.
