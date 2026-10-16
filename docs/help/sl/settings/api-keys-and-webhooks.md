# API ključi in webhooki

Povežite spletno trgovino, sistem za rezervacije ali drugo programsko opremo, da lahko ustvarja račune in izve, kdaj so plačani.

## API ključi

API ključ omogoča drugemu programu klice RabbitPay pod /api/v1/pay. Z njim lahko ustvarja stranke, izdaja račune in preverja, ali so plačani. Ključ ne more upravljati projekta, ekipe ali ključev in ne more izvajati vračil.

Odprite **Nastavitve** in poiščite kartico **API ključi**. Vsak projekt ima primarni in sekundarni ključ.

![Kartica API ključi](https://cdn.rabbitpay.net/help/sl/dark/settings/api-keys-and-webhooks/keys.webp)

Za nov ključ ali zamenjavo pritisnite **Zamenjaj** ob njem in potrdite. Nov ključ takoj kopirajte in ga shranite v upravitelj gesel. Prikaže se samo enkrat.

Dva ključa omogočata zamenjavo brez prekinitve: programsko opremo usmerite na sekundarni ključ, zamenjajte primarnega in se nato vrnite nanj.

## Webhooki

Webhook vašo programsko opremo obvesti v trenutku, ko se kaj zgodi, na primer ko je račun plačan, namesto da bi ta znova in znova spraševala.

1. Pod **URL webhooka** vpišite naslov vaše programske opreme, ki naj prejema dogodke. Biti mora javen naslov, dosegljiv iz interneta, po možnosti prek https.
2. Pritisnite **Shrani URL webhooka**.

![Kartica Webhooki z naslovom](https://cdn.rabbitpay.net/help/sl/dark/settings/api-keys-and-webhooks/webhooks.webp)

RabbitPay nato pošlje zahtevo za dogodke, kot so **invoice.issued**, **invoice.paid**, **invoice.partially_paid**, **invoice.overdue**, **invoice.credited**, **invoice.canceled**, **invoice.refunded**, **payment.received**, **payment.confirmed** in **payment.refunded**.

Seznam pod naslovom pokaže zadnje dostave z dogodkom, stanjem, številom poskusov in odgovorom vaše programske opreme. Neuspele dostave se kasneje poskusijo znova. Pustite naslov prazen, da webhooke izklopite.

## Preverite, ali je webhook pristen

Vsaka dostava je podpisana, zato lahko vaša programska oprema preveri, da je prišla od RabbitPay. Zahteva vsebuje:

| Glava                 | Vsebina                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| X-RabbitPay-Event     | Dogodek, na primer invoice.paid                                                        |
| X-RabbitPay-Delivery  | Enolična oznaka dostave                                                                |
| X-RabbitPay-Timestamp | Čas pošiljanja v milisekundah                                                          |
| X-RabbitPay-Signature | sha256= in za njim HMAC-SHA256 časa, pike in telesa, izračunan s skrivnostjo za podpis |

**Skrivnost za podpis** je prikazana na kartici. Če uide, pritisnite **Zamenjaj** ob njej. Dostave so takoj podpisane z novo skrivnostjo, zato hkrati posodobite programsko opremo.

![Zamenjava skrivnosti za podpis](https://cdn.rabbitpay.net/help/sl/dark/settings/api-keys-and-webhooks/rotate.webp)
