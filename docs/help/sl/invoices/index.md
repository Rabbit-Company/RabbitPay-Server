# Računi

Ustvarite račun, ga pošljite, prejmite plačilo in ga popravite, ko se kaj spremeni. Vsaka spodnja stran je ena naloga s sliko vsakega koraka, vse pa se začne v vašem projektu pod **Računi**.

## Vsakdanje delo

| Želim                                         | Stran                                             |
| --------------------------------------------- | ------------------------------------------------- |
| Napisati račun                                | [Ustvarite račun](invoices/create-invoice)        |
| Ga shraniti za pozneje, spremeniti ali izdati | [Osnutki in izdani računi](invoices/drafts)       |
| Ga poslati po e-pošti ali opomniti kupca      | [Pošljite račun](invoices/send)                   |
| Ga natisniti ali dobiti PDF                   | [Tiskanje in prenos](invoices/print-and-download) |
| Ga označiti kot plačanega ali vrniti denar    | [Zabeležite plačilo](invoices/record-payment)     |
| Popraviti napako ali ga preklicati            | [Dobropisi in preklic](invoices/credit-notes)     |

## Druge vrste računov

| Želim                                  | Stran                                     |
| -------------------------------------- | ----------------------------------------- |
| Prositi za plačilo, preden izdam račun | [Predračuni](invoices/pro-forma)          |
| Vsak mesec zaračunati isto             | [Ponavljajoči računi](invoices/recurring) |

## Nastavite enkrat

| Želim                                         | Stran                                      |
| --------------------------------------------- | ------------------------------------------ |
| Imeti kupce na enem mestu                     | [Kupci](invoices/customers)                |
| Shraniti izdelke in storitve, ki jih prodajam | [Artikli](invoices/items)                  |
| Določiti, kako so videti številke računov     | [Številke računov](invoices/numbering)     |
| Spremeniti videz računov in e-pošte           | [Oblikovanje in besedila](invoices/design) |

## Življenje računa

Račun se začne kot **osnutek**, ki ga še lahko spreminjate. Ko ga izdate, dobi številko, postane **odprt** in ga je mogoče plačati. Od tam naprej se premika sam, ko prihajajo plačila.

| Stanje       | Pomen                                               |
| ------------ | --------------------------------------------------- |
| osnutek      | Še ni izdan. Nima številke in ga ni mogoče plačati. |
| odprt        | Izdan in čaka na plačilo.                           |
| zapadel      | Izdan, rok plačila je že potekel.                   |
| delno plačan | Del zneska je že prispel.                           |
| plačan       | Plačan v celoti.                                    |
| preklican    | Umaknjen. Njegova številka ostane porabljena.       |
| vrnjen       | Plačilo je bilo vrnjeno kupcu.                      |

Ste novi v RabbitPayu? [Vaš prvi račun](getting-started/first-invoice) vas v petih minutah popelje po najkrajši poti.
