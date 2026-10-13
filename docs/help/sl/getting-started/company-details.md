# Vpišite podatke podjetja

Račun je veljaven le s pravimi podatki: kdo ga je izdal, od kod in s katero davčno številko. Vpišite jih enkrat in RabbitPay jih natisne na vsak dokument.

## Odprite Nastavitve

Odprite svoj projekt in na dnu menija projekta pritisnite **Nastavitve**.

![Nastavitve na dnu menija projekta](https://cdn.rabbitpay.net/help/sl/dark/getting-started/company-details/open-settings.webp)

Nastavitve so ena dolga stran s karticami. Vsaka kartica ima svoj gumb za shranjevanje, zato kartico shranite, preden greste na naslednjo.

## Izberite jezik svojih računov

To naredite najprej. RabbitPay ta jezik uporabi za besedilo, ki ga predlaga v naslednjih korakih.

1. Poiščite kartico **Račun**.
2. Pod **Jezik** izberite jezik, v katerem so napisani vaši računi in plačilna stran.
3. Pod **Oblika datuma** in **Oblika ure** izberite, kako so na njih zapisani datumi in ure.
4. Preverite **Računovodski časovni pas**. Ta določa, na kateri dan je račun datiran in oštevilčen.
5. Pritisnite **Shrani nastavitve računa**.

   ![Kartica Račun](https://cdn.rabbitpay.net/help/sl/dark/getting-started/company-details/invoice-language.webp)

Stavek pod polji pokaže, kako se bo bral račun, izdan danes.

To je ločeno od jezika vmesnika, ki si ga vsak izbere sam v [meniju računa](getting-started/find-your-way#spremenite-jezik-in-temo). Delate lahko v enem jeziku in izdajate račune v drugem.

## Vpišite podatke podjetja

1. Poiščite kartico **Podatki podjetja**.
2. Pod **Uradno ime** začnite tipkati ime ali davčno številko svojega podjetja in ga izberite s seznama.

   ![Podjetje, najdeno v registru FURS](https://cdn.rabbitpay.net/help/sl/dark/getting-started/company-details/find-company.webp)

   RabbitPay iz javnega registra FURS izpolni **Naslov**, **Poštno številko**, **Kraj**, **Državo**, **ID za DDV**, **Davčno številko** in **Matično številko**. Če vašega podjetja ni na seznamu, polja izpolnite ročno. ID za DDV vpišite s črkama države spredaj, na primer `SI58140000`.

3. Preverite izpolnjene podatke in jih po potrebi popravite.
4. Dodajte **E-pošto**, **Telefon** in **Spletno stran**, ki naj bodo natisnjeni na računih.
5. V polje **Noga računa** vpišite vse drugo, kar zakon zahteva na vaših dokumentih, na primer vpis v register. Natisnjena je na dnu vsakega računa.
6. Pritisnite **Shrani podatke podjetja**.

   ![Izpolnjena kartica Podatki podjetja](https://cdn.rabbitpay.net/help/sl/dark/getting-started/company-details/company-details.webp)

> **Namig:** Podjetja iz drugih držav EU najdete enako, če pod **Uradno ime** vpišete njihov ID za DDV.

Če za vašo državo še kaj obveznega manjka, RabbitPay to oranžno izpiše nad gumbom za shranjevanje. D.o.o. in d.d. morata na primer navesti register, v katerega sta vpisana, in osnovni kapital. Pritisnite **Dodaj predlagano besedilo**, v nogi zamenjajte vsako praznino `___` s svojimi podatki in shranite.

![Opozorilo o vpisu v register in gumb Dodaj predlagano besedilo](https://cdn.rabbitpay.net/help/sl/dark/getting-started/company-details/register-entry.webp)

## Nastavite, kako za vas velja DDV

1. Poiščite kartico **Davki**.
2. Pod **Država, v kateri ste ustanovljeni** izberite državo, v kateri je vaše podjetje davčno registrirano.
3. Pod **Status DDV** izberite tistega, ki vas opisuje. Razlaga jih spodnja tabela.
4. Preverite **Valuto poročanja**. V tej valuti se zneski DDV poročajo vašemu davčnemu uradu.
5. Pritisnite **Shrani davčne nastavitve**.

   ![Kartica Davki pri zavezancu za DDV](https://cdn.rabbitpay.net/help/sl/dark/getting-started/company-details/tax.webp)

| Status DDV                              | Izberite ga, ko                                    |
| --------------------------------------- | -------------------------------------------------- |
| **Zavezanec za DDV**                    | Obračunavate DDV in oddajate obračune DDV.         |
| **Mali davčni zavezanec, oproščen DDV** | Ste pod nacionalnim pragom in DDV ne obračunavate. |
| **Ni zavezanec za DDV**                 | Niste davčni zavezanec ali ste zunaj EU.           |

Od zdaj RabbitPay na vsaki postavki računa predlaga pravo stopnjo DDV, vključno z obrnjeno davčno obveznostjo za podjetja iz drugih držav EU.

Dve polji se pokažeta le, kadar prideta v poštev:

- **Registrirani za EU vse na enem mestu (VEM)** je za zavezance za DDV v EU, ki prodajajo potrošnikom v drugih državah EU in ta DDV prijavijo v enem obračunu.
- **Opomba o oprostitvi** je za malega davčnega zavezanca. To je stavek, natisnjen na vsakem računu, ki pojasni, zakaj DDV ni obračunan. Pustite prazno, da se uporabi predlagano besedilo.

## Kaj sledi

Vaši podatki so urejeni. Zdaj [povejte kupcem, kam naj plačajo, in izdajte prvi račun](getting-started/first-invoice).

Slovensko podjetje mora pred izdajo računov, plačanih z gotovino ali kartico, nastaviti še nekaj stvari, na primer davčno potrjevanje pri FURS. Glejte [Slovenska zakonodaja](slovenia).
