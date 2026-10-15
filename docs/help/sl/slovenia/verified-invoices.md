# Računi, poslani FURS

Z vklopljenim [davčnim potrjevanjem](slovenia/fiscal-verification) sami ne pošiljate ničesar. RabbitPay vsak račun, plačan z gotovino, kartico ali kripto, pošlje FURS takoj ob plačilu.

FURS odgovori z enkratno identifikacijsko oznako računa (EOR), ki je izpisana na računu.

## Kaj se potrjuje

| Plačano z                      | Poslano FURS |
| ------------------------------ | ------------ |
| Gotovino                       | Da           |
| Kartico prek Stripa            | Da           |
| Bitcoinom, Ethereumom, Monerom | Da           |
| Bančnim nakazilom              | Ne           |
| PayPalom                       | Ne           |

Račun se pošlje enkrat, s prvim takim plačilom. Dobropis za potrjen račun se tudi potrdi, vračilo plačila na potrjenem računu pa vedno izda dobropis.

## Kaj je na računu

Potrjen račun ima davčne podatke na dnu, v PDF, na natisnjeni strani in v e-pošti:

- **Čas izdaje** na sekundo natančno.
- **Račun izdal**, oseba, katere davčna številka je bila poslana FURS.
- **ZOI**, zaščitna oznaka, ki jo RabbitPay izračuna z vašim potrdilom.
- **EOR**, oznaka, ki jo je vrnil FURS.
- **Koda QR**, s katero lahko kupec račun preveri pri FURS.

![Potrjen račun z ZOI, EOR in kodo QR](https://cdn.rabbitpay.net/help/sl/dark/slovenia/verified-invoices/printed.webp)

Številka ima obliko prostor, naprava in zaporedna številka, na primer `PP1-SPLET1-1`.

## Preverite, kaj je bilo poslano

Odprite **Nastavitve** > **Davčno potrjevanje računov (FURS)** in se pomaknite do **Računi, poslani FURS**. Vsak zapis je naveden z zneskom in statusom.

![Račun, ki ga je potrdil FURS](https://cdn.rabbitpay.net/help/sl/dark/slovenia/verified-invoices/sent.webp)

| Status       | Pomen                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| **Potrjen**  | FURS ga je sprejel. Zadnji stolpec kaže EOR.                           |
| **Čaka**     | FURS še ni bil dosegljiv. RabbitPay poskuša znova sam.                 |
| **Zavrnjen** | FURS ga je zavrnil. Zadnji stolpec kaže razlog, ki ga je navedel FURS. |

## Ko FURS ni dosegljiv

Kupec račun dobi takoj, z ZOI in brez EOR. RabbitPay ga v ozadju pošilja znova, dokler FURS ne odgovori, nato se EOR prikaže na računu.

Zakon za tak račun daje 2 delovna dneva, oziroma 10 delovnih dni, če je bil račun plačan več kot uro po izdaji. Ko se račun približa roku, kartica na vrhu **Davčno potrjevanje računov (FURS)** pokaže opozorilo, prikaže se tudi na pregledu projekta, lastniki projekta pa dobijo e-pošto.

## Ko FURS račun zavrne

1. V zadnjem stolpcu preberite razlog.
2. Odpravite vzrok. Najpogostejši so zamenjano ali poteklo potrdilo, neprijavljen poslovni prostor in manjkajoča davčna številka osebe, ki je izdala račun.
3. V tej vrstici pritisnite **Pošlji znova**.

Lastniki dobijo e-pošto o vsakem zavrnjenem računu, zato nič ne ostane spregledano.
