# Plačila

Izberite, kako lahko kupci plačajo, spremljajte prejeti denar in prodajajte v živo z blagajno. Plačila gredo neposredno na vaše račune in nikoli prek RabbitPaya.

## Vklopite načine plačila

V projektu odprite **Nastavitve** in poiščite **Načini plačila**. Vsi načini so na začetku izklopljeni. Način je kupcem ponujen, ko je vklopljen in so njegovi podatki popolni.

| Način           | Kaj vnesete                                    | Beleženje |
| --------------- | ---------------------------------------------- | --------- |
| Bančno nakazilo | Vaš IBAN                                       | Ročno     |
| Stripe          | Skrivni ključ in skrivnost za podpis webhooka  | Samodejno |
| PayPal          | ID odjemalca, skrivnost in ID webhooka         | Samodejno |
| Bitcoin         | Razširjeni javni ključ vaše denarnice          | Samodejno |
| Ethereum        | Razširjeni javni ključ vaše denarnice          | Samodejno |
| Monero          | Naslov in prijava vaše denarnice samo za ogled | Samodejno |

Skrivnosti so shranjene šifrirano in po shranjevanju niso nikoli več prikazane. Polje s skrivnostjo pustite prazno, če želite ohraniti shranjeno vrednost.

Način z oznako **izklopljeno na tem strežniku** ni na voljo, ker ga upravljavec strežnika ni omogočil.

Slovensko podjetje mora pred sprejemanjem gotovine, kartic ali kriptovalut nastaviti davčno potrjevanje računov. Do takrat sta ponujena le bančno nakazilo in PayPal.

## Sprejemajte bančna nakazila

Vklopite **Bančno nakazilo** in vnesite svoj IBAN. BIC, imetnik računa in ime banke niso obvezni.

Kupec na računu in na plačilni strani vidi račun, znesek in sklic, skupaj s kodo QR, ki jo preberejo bančne aplikacije. Slovenski račun dobi kodo UPN QR, drugi evrski računi pa kodo EPC QR. Koda je prikazana pri računih v evrih in vedno zahteva znesek, ki je še odprt.

RabbitPay ne spremlja vašega bančnega računa. Ko denar prispe, odprite račun in pritisnite **Zabeleži plačilo**.

## Sprejemajte kartice in PayPal

Kartična plačila tečejo prek vašega računa Stripe, plačila PayPal pa prek vašega poslovnega računa PayPal. Kupec plača na strani Stripe ali PayPal, zato podatki o kartici nikoli ne pridejo do RabbitPaya.

**Stripe**

1. V nadzorni plošči Stripe ustvarite webhook, ki kaže na `https://rabbitpay.net/api/v1/hooks/stripe` in pošilja dogodek `checkout.session.completed`.
2. Skrivni ključ in skrivnost za podpis tega webhooka prepišite v **Nastavitve** > **Načini plačila** > **Stripe**.

**PayPal**

1. V razvijalski nadzorni plošči PayPal ustvarite aplikacijo in webhook, ki kaže na `https://rabbitpay.net/api/v1/hooks/paypal`, z dogodkoma `CHECKOUT.ORDER.APPROVED` in `PAYMENT.CAPTURE.COMPLETED`.
2. ID odjemalca, skrivnost in ID webhooka prepišite v **Nastavitve** > **Načini plačila** > **PayPal**.

Če RabbitPay gostite sami, namesto rabbitpay.net uporabite svoj naslov.

Račun je označen kot plačan nekaj trenutkov po plačilu. Vračilo zabeležite v RabbitPayu, denar pa vrnete v nadzorni plošči Stripe ali PayPal.

## Sprejemajte kriptovalute

Bitcoin in Ethereum potrebujeta le razširjeni javni ključ vaše denarnice. RabbitPay za vsak račun ustvari nov naslov, ga spremlja in račun označi kot plačan, ko je plačilo potrjeno. Vidi prejeta plačila, nikoli pa jih ne more porabiti. Ko ključ shranite, se prikaže prvi prejemni naslov, da ga lahko primerjate s svojo denarnico.

Monero potrebuje denarnico samo za ogled, ki jo poganjate sami, ker plačil Monero ni mogoče javno preveriti.

Cena v kriptovaluti se določi, ko kupec izbere ta način plačila, znesek za plačilo na dodeljeni naslov pa ostane nespremenjen. Sprememba tečaja med plačevanjem zato ne povzroči premajhnega plačila.

## Plačilna stran

Vsak izdan račun ima svojo plačilno stran, za katero ni potreben uporabniški račun. Povezavo do nje kopirate na računu prek **Pošlji** > **Kopiraj povezavo za plačilo** ali jo dodate v e-pošto z računom.

Stran pokaže, koliko je treba plačati, ponudi načine, ki ste jih vklopili, in se sama osveži, ko denar prispe. Osnutek nima plačilne strani.

Stran lahko odpre vsak, ki ima povezavo, zato jo delite le s kupcem, ki mu je namenjena.

## Spremljajte in vračajte plačila

**Plačila** v projektu prikažejo vsa plačila in vračila. Iščete lahko po računu ali ID transakcije ter filtrirate po vrsti in načinu plačila. Plačilo v čakanju je bilo zaznano, ni pa še potrjeno, zato se še ne šteje k računu.

Če želite denar vrniti, odprite račun, poiščite plačilo in pritisnite **Vrni**. Več o vračilih in dobropisih je v članku [Računi](invoices).

## Prodajajte v živo z blagajno

**Blagajna** telefon, tablico ali napravo POS spremeni v blagajno.

1. Tapnite izdelke iz svojih **Artiklov**, jih poiščite ali skenirajte črtno kodo ali pa na tipkovnici vnesite znesek.
2. Pritisnite **Zaračunaj**.
3. Pri gotovini vnesite izročeni znesek in RabbitPay pokaže, koliko je treba vrniti. Pri drugih načinih kupec skenira kodo QR in plača s telefonom.

Vsaka prodaja je izdan račun, ki ga lahko natisnete ali pošljete po e-pošti. V slovenskem projektu z davčnim potrjevanjem se gotovinske in kartične prodaje takoj pošljejo FURS. Preklic prodaje izda dobropis.

Član ekipe z vlogo **Blagajnik** vidi samo blagajno in svoje prodaje.
