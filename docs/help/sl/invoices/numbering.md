# Številke računov

Številke računov si morajo slediti zaporedno in brez vrzeli. Vi določite, kako so videti, RabbitPay pa skrbi za zaporedje.

## Odprite Številčenje dokumentov

Odprite **Nastavitve** in poiščite kartico **Številčenje dokumentov**. Ima tri dele: številke računov, številke predračunov in številke naročil v trgovini. Vsak ima svojo obliko in svoj števec.

![Kartica Številčenje dokumentov](https://cdn.rabbitpay.net/help/sl/dark/invoices/numbering/document-numbers.webp)

## Zapišite obliko

Oblika je vzorec. Te kode se ob nastanku številke zamenjajo, vse drugo pa se izpiše tako, kot je zapisano.

| Koda          | Postane                                 |
| ------------- | --------------------------------------- |
| `YYYY` / `YY` | Leto, 2026 ali 26                       |
| `MM`          | Mesec, od 01 do 12                      |
| `DD`          | Dan, od 01 do 31                        |
| `X`           | Ena števka števca, `XXX` torej da `001` |

| Oblika            | Prva številka   | Števec se začne znova     |
| ----------------- | --------------- | ------------------------- |
| `YYMMDDXXXXXX`    | `261013000001`  | Vsak dan. To je privzeto. |
| `XXX/YY`          | `001/26`        | Vsako leto                |
| `YYYY-XXXX`       | `2026-0001`     | Vsako leto                |
| `INV-YYYY-XXXX`   | `INV-2026-0001` | Vsako leto                |
| `"INV"-YYMM-XXXX` | `INV-2610-0001` | Vsak mesec                |
| `XXXXXX`          | `000001`        | Nikoli                    |

Števec se znova začne z 1 glede na najmanjši del datuma v obliki: vsako leto, če oblika vsebuje samo leto, vsak mesec z `MM` in vsak dan z `DD`.

Besedilo, ki vsebuje črke Y, M, D ali X, postavite v dvojne narekovaje, na primer `"ORDER"-YYXXXXXX`. Brez narekovajev bi se te črke brale kot kode.

## Spremenite obliko številke računa

1. Pod številkami računov vpišite novo **Obliko**.
2. Preberite vrstico pod njo. Pokaže naslednjo številko natanko tako, kot bo natisnjena, in koliko računov gre v števec, preden je poln.

   ![Lastna oblika s prikazano naslednjo številko](https://cdn.rabbitpay.net/help/sl/dark/invoices/numbering/own-format.webp)

3. Pritisnite **Shrani številčenje**.

Že izdani računi ohranijo svoje številke. Oblika, ki bi lahko dvakrat dala isto številko, je zavrnjena.

## Nadaljujte zaporedje iz drugega programa

Če ste letos račune že izdajali drugje, nastavite **Naslednjo številko** in nadaljujte zaporedje, na primer 42 po 41 izdanih računih. Že porabljene številke se preskočijo.

> **Opomba:** V slovenskem projektu z vklopljenim davčnim potrjevanjem so računi oštevilčeni tako, kot zahteva FURS: poslovni prostor, naprava in zaporedna številka, na primer `PP1-SPLET1-1`. Glejte [Slovenska zakonodaja](slovenia).

## Predračuni, naročila v trgovini in dobropisi

- **Številčenje predračunov** deluje enako in se začne z obliko `PR-YYYY-XXXXX`. Isti del kartice določa, kaj se zgodi, [ko je predračun plačan](invoices/pro-forma#izberite-kaj-se-zgodi-ob-placilu).
- **Številčenje naročil v trgovini** velja za vsako naročilo v vaši [spletni trgovini](online-store). Račun dobi svojo številko, ko je naročilo plačano.
- Dobropisi uporabljajo obliko računov s `CN` spredaj in se štejejo ločeno.
