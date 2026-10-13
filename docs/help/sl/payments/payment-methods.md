# Načini plačila

Vsak način, s katerim lahko vaši kupci plačajo, vklopite v eni kartici v Nastavitvah. Način je kupcem ponujen, ko je vklopljen in so njegovi podatki popolni.

## Odprite Načine plačila

1. Odprite svoj projekt in v meniju projekta pritisnite **Nastavitve**.

   ![Nastavitve v meniju projekta](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-methods/open-settings.webp)

2. Pomaknite se do kartice **Načini plačila**.

   ![Kartica Načini plačila z vsemi načini](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-methods/card.webp)

## Kaj potrebuje posamezen način

| Način               | Kaj vnesete                                      | Plačila se zabeležijo |
| ------------------- | ------------------------------------------------ | --------------------- |
| **Bančno nakazilo** | Vaš IBAN                                         | Ročno                 |
| **Stripe**          | Skrivni ključ in skrivnost za podpis webhooka    | Samodejno             |
| **PayPal**          | ID odjemalca, skrivnost odjemalca in ID webhooka | Samodejno             |
| **Bitcoin**         | Razširjeni javni ključ vaše denarnice            | Samodejno             |
| **Ethereum**        | Razširjeni javni ključ računa vaše denarnice     | Samodejno             |
| **Monero**          | Naslov in prijavo vaše denarnice samo za ogled   | Samodejno             |

## Preberite stanje načina

Vsak način ima na levi stikalo in na desni stanje.

![Način, ki še potrebuje podatke](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-methods/needs-setup.webp)

![Način, ki je pripravljen in vklopljen](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-methods/ready.webp)

| Stanje                           | Pomen                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| **Potrebuje nastavitev**         | Izpolnite polja pod njim in pritisnite **Shrani**.                          |
| **Pripravljeno**                 | Podatki so popolni. Vklopite ga, da ga ponudite kupcem.                     |
| **Preverite nastavitve**         | Nečesa, kar ste vpisali, ni mogoče uporabiti. Razlog je izpisan pod imenom. |
| **Izklopljeno na tem strežniku** | Upravljavec strežnika tega načina ni omogočil.                              |

## Vklopite ali izklopite način

1. Izpolnite polja načina in pritisnite **Shrani**.
2. Pritisnite stikalo ob njegovem imenu.

Od tega trenutka je način ponujen na plačilni strani vsakega neplačanega računa. Izklopite ga enako. Že plačani računi se ne spremenijo.

## Kako so shranjeni vaši podatki

- Skrivnosti, kot so ključi in gesla, so shranjene šifrirano in po shranjevanju niso nikoli več prikazane. Pri shranjeni skrivnosti piše **Nastavljeno, pustite prazno za ohranitev**. Polje pustite prazno, da ostane shranjena vrednost, ali vpišite novo, da jo zamenjate.
- Kriptovalute se spremljajo samo z javnimi ključi, zato jih nihče pri RabbitPayu ali na strežniku ne more porabiti.
- Načine plačila lahko spremeni samo lastnik ali skrbnik projekta.

## Poglejte, kaj je vklopljeno

**Pregled** vašega projekta našteje pripravljene načine, ločeno na tiste, ki plačila zabeležijo sami, in tiste, ki jih zabeležite ročno.

![Načini plačila na Pregledu](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-methods/overview-card.webp)

> **Opomba:** Slovensko podjetje mora pred sprejemanjem gotovine, kartic ali kriptovalut nastaviti davčno potrjevanje pri FURS. Do takrat sta ponujena samo bančno nakazilo in PayPal. Glejte [Slovenska zakonodaja](slovenia).
