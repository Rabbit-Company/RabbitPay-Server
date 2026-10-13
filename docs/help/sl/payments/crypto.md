# Kriptovalute

Sprejemajte Bitcoin, Ethereum in Monero naravnost v svojo denarnico. RabbitPay vsakemu računu dodeli svoj naslov, ga spremlja in račun označi kot plačan, ko je plačilo potrjeno.

RabbitPay dohodna plačila vidi, nikoli pa jih ne more porabiti.

## Kako deluje

- RabbitPayu daste javni ključ svoje denarnice, nikoli zasebnega ključa ali semenske fraze. Zasebni ključ je zavrnjen.
- Vsak račun dobi nov naslov iz tega ključa. Kovanci prispejo v vašo denarnico.
- Cena se določi v trenutku, ko kupec izbere kovanec, znesek pa je za ta naslov fiksen. Sprememba na trgu med plačevanjem ne povzroči premajhnega plačila.

## Sprejemajte Bitcoin

1. V svoji denarnici poiščite **razširjeni javni ključ** računa, ki naj prejema plačila. Začne se z `zpub`, `ypub` ali `xpub`. V Sparrowu je pod **Settings** > **Keystore**, v Electrumu pod **Wallet** > **Information**.
2. V RabbitPayu odprite **Nastavitve** in v kartici **Načini plačila** poiščite **Bitcoin**.

   ![Bitcoin pred nastavitvijo](https://cdn.rabbitpay.net/help/sl/dark/payments/crypto/bitcoin-empty.webp)

3. Ključ prilepite pod **Razširjeni javni ključ**.
4. **Vrsto naslova** pustite na izbiri iz ključa, razen če vaša denarnica uporablja drugo vrsto.
5. Pritisnite **Shrani**.

   ![Razširjeni javni ključ, pripravljen za shranjevanje](https://cdn.rabbitpay.net/help/sl/dark/payments/crypto/bitcoin-key.webp)

6. **Prvi prejemni naslov**, ki ga RabbitPay zdaj pokaže, primerjajte s prvim naslovom v svoji denarnici. Biti morata enaka.
7. Pritisnite stikalo ob **Bitcoin**.

   ![Bitcoin je pripravljen, s prikazanim prvim prejemnim naslovom](https://cdn.rabbitpay.net/help/sl/dark/payments/crypto/bitcoin-on.webp)

> **Pomembno:** Če prvi naslov ni tak, kot ga kaže vaša denarnica, Bitcoina ne vklopite. Plačila bi šla na naslove, ki jih vaša denarnica ne spremlja. Preverite vrsto naslova.

Neplačani računi pustijo neuporabljene naslove. Če vaša denarnica zgreši plačilo, ji povečajte omejitev vrzeli (gap limit).

## Sprejemajte Ethereum

1. Izvozite **razširjeni javni ključ računa** svoje denarnice, xpub poti `m/44'/60'/0'`. To pot uporabljajo MetaMask, Ledger in Trezor. MetaMask tega ključa ne pokaže, zato ga izvozite z orodjem za strojne denarnice ali iz svojega semena na računalniku brez povezave.
2. Prilepite ga pod **Razširjeni javni ključ računa** pri **Ethereum** in pritisnite **Shrani**.
3. **Prvi prejemni naslov** primerjajte s svojo denarnico, nato pritisnite stikalo.

   ![Ethereum je pripravljen in vklopljen](https://cdn.rabbitpay.net/help/sl/dark/payments/crypto/ethereum-on.webp)

## Sprejemajte Monero

Plačil Monero ni mogoče javno preveriti, zato RabbitPay potrebuje denarnico samo za ogled, ki jo poganjate sami.

1. Iz svojega primarnega naslova in zasebnega ključa za ogled ustvarite denarnico samo za ogled.
2. Z njo zaženite `monero-wallet-rpc` na strežniku, ki ga RabbitPay doseže.
3. Vpišite njen **URL denarnice RPC**, **Uporabniško ime RPC** in **Geslo RPC** ter **Račun**, ki prejema plačila. Če niste prepričani, vpišite `0`.
4. Pritisnite **Shrani**, nato stikalo.

   ![Podatki Monero](https://cdn.rabbitpay.net/help/sl/dark/payments/crypto/monero.webp)

Denarnica samo za ogled plačila vidi, ne more pa jih porabiti.

## Kaj vidi vaš kupec

Na plačilni strani kupec izbere kovanec.

![Bitcoin in Ethereum na plačilni strani](https://cdn.rabbitpay.net/help/sl/dark/payments/crypto/choose-coin.webp)

Stran pokaže naslov, kodo QR, ki jo lahko skenira aplikacija denarnice, in natančen znesek v kovancu. Pod tem sta uporabljeni tečaj in preostali čas za plačilo.

![Plačilo računa z Bitcoinom](https://cdn.rabbitpay.net/help/sl/dark/payments/crypto/pay-with-bitcoin.webp)

- Tečaj velja eno uro. Pozneje poslano plačilo se ne zabeleži samo.
- Plačilo, ki je bilo opaženo, a še ni potrjeno, je prikazano kot v čakanju in se še ne šteje.
- Račun postane **plačan** po številu potrditev, navedenem na strani, stran pa se osveži sama.
