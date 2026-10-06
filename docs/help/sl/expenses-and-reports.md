# Stroški in poročila

Beležite, kaj vaše podjetje porabi, pustite, da se ponavljajoči stroški vnašajo sami, in spremljajte prihodke, stroške in DDV na enem mestu.

## Zabeležite strošek

1. Odprite **Stroški** in pritisnite **Dodaj strošek**.
2. Vnesite dobavitelja, številko računa dobavitelja, datume in skupni znesek.
3. Izberite kategorijo. Izberite eno od pogostih ali vpišite svojo.
4. Vnesite DDV z računa in koliko ga lahko odbijete: vse, nič ali znesek po meri.
5. Strošek označite kot plačan in nastavite datum plačila ali ga pustite neplačanega, dokler ga ne plačate.

Strošku lahko priložite izvirni račun dobavitelja, da je dokument shranjen skupaj z zapisom.

Računovodje in vodje lahko stroške beležijo in urejajo. Izbrišejo jih lahko samo lastniki in skrbniki.

## Uvozite e-račun dobavitelja

Ko vam dobavitelj pošlje e-račun, ga ni treba prepisovati.

1. Na strani **Stroški** pritisnite **Uvozi e-račun** in izberite datoteko XML. Podprti so računi e-SLOG 2.0 in UBL 2.1 (Peppol).
2. RabbitPay izpolni dobavitelja, številko računa, datume, skupni znesek in DDV po stopnjah.
3. Preverite kategorijo in DDV ter shranite.

Izvirni XML se priloži strošku, ker je pravni izvirnik računa. RabbitPay vas opozori, kadar je račun naslovljen na drugo podjetje, kadar morate DDV obračunati sami, kadar je v tuji valuti ali kadar se zneski ne ujemajo. Številka računa, ki je že zabeležena, je zavrnjena, zato ni nič vneseno dvakrat.

Več stroškov hkrati lahko prenesete z **Uvozi CSV**.

## Nastavite ponavljajoče stroške

Najemnino, naročnine in druge stroške, ki se ponavljajo, lahko vnašate samodejno.

1. Na strani **Stroški** pritisnite **Dodaj ponavljajoči strošek**.
2. Strošek izpolnite kot običajno in izberite, kako pogosto se ponavlja, vsakih 1 do 60 tednov, mesecev ali let.
3. Po želji nastavite končni datum ali največje število vnosov.

Vsak vnos se ustvari kot neplačan. **Označi ustvarjene stroške kot plačane** vklopite le pri stroških, ki se plačajo samodejno, na primer z direktno obremenitvijo. RabbitPay strošek samo zabeleži in nikoli ne pošlje plačila.

Urnik lahko kadarkoli začasno ustavite, nadaljujete ali prekličete. Poznejša sprememba ne spremeni vnosov, ki jih je že ustvaril.

## Preberite finančno poročilo

Odprite **Statistika** in si oglejte **Prihodki in stroški** za poljubno obdobje, po mesecih ali letih, s stroški po kategorijah. Vsaka valuta je prikazana posebej.

| Podatek                     | Kaj vsebuje                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| Neto prihodki               | Izdani računi brez davka, zmanjšani za dobropise                  |
| Stroški poslovanja          | Stroški brez DDV, ki ga lahko odbijete                            |
| Ocenjeni dobiček ali izguba | Neto prihodki brez stroškov poslovanja in provizij plačil         |
| Denarni tok                 | Prejeta plačila brez vračil, provizij plačil in plačanih stroškov |

To so ocene na podlagi zapisov, ki ste jih vnesli. Ne vključujejo računovodskih popravkov, kot je amortizacija, zato jih uporabljajte za spremljanje poslovanja, letne izkaze pa prepustite računovodji.

## Ustvarite in izvozite poročila

Finančno poročilo, **Obračun DDV** in **Prodaja artiklov** se izračunajo, ko pritisnete **Ustvari poročilo**. Ko odprete **Statistika**, vidite zadnji shranjeni rezultat z datumom in uro nastanka.

Sprememba obdobja ali drugih filtrov vpliva šele na naslednje poročilo, ki ga ustvarite. Po izdelavi je treba kratek čas počakati, preden lahko isto poročilo ustvarite znova, shranjeni rezultat pa si delijo vsi v projektu.

**Prenesi CSV** izvozi poročilo, ki je na zaslonu.
