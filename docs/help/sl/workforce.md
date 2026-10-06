# Delovni čas, zahtevki in plače

Beležite delovne ure in odsotnosti, načrtujte delo z zahtevki in izračunajte plače, vse po slovenskih pravilih o zaposlovanju.

Ti deli projekta potrebujejo licenco za delovno silo, ki pokriva 5 oseb. Večje ekipe dodajo mesta za zaposlene.

## Kdo lahko kaj počne

Osebe povabite pod **Ekipa** in vsaki dodelite vlogo.

| Vloga     | Kaj lahko počne                                                                        |
| --------- | -------------------------------------------------------------------------------------- |
| Zaposleni | Beleži svoje ure in odsotnosti ter dela na zahtevkih                                   |
| Nadzornik | Upravlja evidence, odsotnosti in zahtevke vseh ter pripravlja poročila o delovnih urah |
| Vodja     | Dela z zahtevki, ne pa z evidencami delovnega časa                                     |

Lastniki in skrbniki lahko počnejo vse, kar lahko nadzornik. Podatki o zaposlenih in plače imajo svoja dovoljenja, zato nadzornik vidi ure, ne pa plač.

## Beležite delovni čas

Odprite **Delovni čas**.

1. Pri dnevu pritisnite **+ Dodaj ure** ter vnesite začetek in konec. Izberite redne ure, nadure ali odmor.
2. Po želji dodajte opombo ali ure povežite z zahtevkom.
3. Ob koncu meseca pritisnite **Oddaj mesec**. Nadzornik nato evidenco odobri ali jo vrne z razlogom.

**Izpolni delovne dni** doda običajne ure z malico vsakemu delovnemu dnevu v obdobju, ki še nima ur. Slovenski prazniki so znani in so preskočeni. Konec, ki je zgodnejši od začetka, se nadaljuje v naslednji dan.

Vsaka sprememba ur in odsotnosti se shrani v **Zgodovina sprememb**, s podatkom, kdo jo je naredil in zakaj. Prebere jo lahko tudi zaposleni.

## Zaprosite za odsotnost in jo odobrite

Odprite **Delovni čas** > **Odsotnosti**.

- Zaposleni pritisne **Zaprosi za odsotnost**, izbere vrsto, na primer letni dopust ali bolniško odsotnost, in datume. Odsotnost lahko zajema cele dni ali del dneva.
- Nadzornik prošnjo odobri ali zavrne in lahko doda opombo za zaposlenega.

Stanje dopusta pokaže dneve za leto, izrabljene dneve, vnaprej odobrene dneve in tiste, ki še čakajo na odobritev.

## Pripravite mesečno poročilo

**Delovni čas** > **Mesečno poročilo** sešteje ure, nadure, praznike in odsotnosti vsake osebe in ga je mogoče prenesti kot PDF ali CSV.

Ocena bruto plač izračuna plačilo iz teh ur z dodatki za nadure, nočno delo, delo v nedeljo in na praznik ter za delovno dobo, skupaj z regresom za prehrano in povračilom prevoza. Dodatke nastavite pod **Delovni čas** > **Nastavitve**. To je ocena, ne plačilna lista.

## Delajte z zahtevki

**Zahtevki** so naloge, prijave napak, predlogi funkcij in zahteve za podporo. Zahtevek dodelite eni ali več osebam, mu nastavite prioriteto in rok ter ga povežite s stranko. Zahtevke si ogledate kot seznam ali kot tablo.

Ure, zabeležene na zahtevku, se prikažejo v evidencah delovnega časa. Zaračunate jih tako:

1. Zahtevku določite urno postavko ali fiksno ceno, ki se zaračuna enkrat ne glede na zabeležene ure.
2. Pritisnite **Zaračunaj zahtevek**. Izberete lahko več zahtevkov iste stranke in jih združite na enem računu.
3. Preverite ustvarjeni osnutek računa in ga izdajte.

Stranka vidi zahtevek na portalu za kupce šele, ko ji omogočite dostop in zahtevek označite kot viden zanjo. Glejte [Portal za kupce](customer-portal).

## Vodite podatke o zaposlenih

**Zaposleni** hrani delovno mesto, vrsto zaposlitve, plačo, datum začetka, dneve dopusta in osebne podatke, ki jih potrebuje obračun plač, na primer davčno številko in transakcijski račun. Podatki so shranjeni šifrirano in jih lahko berejo le osebe z dovoljenjem za ogled podatkov o zaposlenih. Izbris zapisa ohrani evidence delovnega časa in odsotnosti.

## Obračunajte plače

Odprite **Plače**.

1. Pritisnite **Nov obračun**, izberite mesec in datum izplačila ter pritisnite **Izračunaj**. RabbitPay izračuna bruto in neto plačo iz evidenc delovnega časa, odsotnosti in podatkov o zaposlenih za ta mesec.
2. Po potrebi posamezni osebi dodajte dodatke, neobdavčena povračila in odtegljaje ter pritisnite **Ponovno izračunaj**.
3. Ko je vse pravilno, pritisnite **Zaključi**.

Iz zaključenega obračuna dobite plačilno listo PDF za vsakega zaposlenega, datoteko **REK-O za eDavke**, ki jo uvozite in podpišete v eDavkih, ter **Datoteka za banko** z enim plačilom plače na zaposlenega, ki jo naložite v spletno banko.

Davčne stopnje in stopnje prispevkov so shranjene kot **Davčne tabele**, ki veljajo od določenega meseca, zato je sprememba zakonodaje nova tabela, pretekli obračuni pa ostanejo nespremenjeni.

Odpravnine, nerezidenti, študentsko delo, pogodbeno delo in popravki REK-O še niso podprti. Pred izplačilom rezultate preverite s svojim računovodjo.
