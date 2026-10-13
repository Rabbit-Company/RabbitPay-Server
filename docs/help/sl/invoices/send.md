# Pošljite račun

Izdan račun pošljite po e-pošti, opomnite kupca, ki ni plačal, ali kopirajte povezavo za plačilo in jo pošljite po katerikoli drugi poti.

## Pošljite račun po e-pošti

1. Odprite račun in pritisnite **Pošlji**.

   ![Meni Pošlji](https://cdn.rabbitpay.net/help/sl/dark/invoices/send/send-menu.webp)

2. Izberite **Pošlji račun**.
3. Preverite naslov pod **Prejemnik**. To je kupčev e-poštni naslov, ki ga lahko za to eno sporočilo spremenite.
4. Po želji dodajte **Sporočilo**. Prikazano je nad računom.
5. Izberite, kaj gre zraven:
   - **Priloži račun kot PDF**
   - **Priloži e-račun (e-SLOG XML)**, ki ga poslovni kupec lahko uvozi naravnost v svoj računovodski program
   - **Dodaj povezavo do plačilne strani**, da lahko kupec plača prek spleta
6. Pritisnite **Pošlji račun**.

   ![E-pošta, pripravljena za pošiljanje](https://cdn.rabbitpay.net/help/sl/dark/invoices/send/email-invoice.webp)

E-pošta vedno našteje postavke in skupni znesek, zato kupec vidi, za kaj gre, tudi če priloge ne odpre.

## Poglejte, kaj je bilo poslano

Vsaka e-pošta je navedena na računu pod **E-pošta**, s časom, naslovom, podatkom o dostavi in s tem, kdo jo je poslal.

![E-pošta enega računa](https://cdn.rabbitpay.net/help/sl/dark/invoices/send/emails-on-invoice.webp)

**E-pošta** v meniju projekta našteje vso e-pošto projekta. Iščite po prejemniku, zadevi ali številki računa ali filtrirajte po stanju, vrsti in datumu.

![Vsa e-pošta projekta](https://cdn.rabbitpay.net/help/sl/dark/invoices/send/emails.webp)

| Stanje        | Pomen                                                         |
| ------------- | ------------------------------------------------------------- |
| **V čakanju** | Čaka na pošiljanje. To traja nekaj sekund.                    |
| **Poslano**   | Predano kupčevemu poštnemu strežniku.                         |
| **Neuspelo**  | Ni bilo mogoče dostaviti, na primer zaradi napačnega naslova. |

## Opomnite kupca

1. Odprite neplačan račun in pritisnite **Pošlji** > **Pošlji opomnik**.
2. Preverite naslov, po želji dodajte sporočilo in pošljite.

   ![Opomnik za neplačan račun](https://cdn.rabbitpay.net/help/sl/dark/invoices/send/reminder.webp)

Opomnik kupcu pove, koliko je še odprtega, in vsebuje povezavo do plačilne strani.

## Samodejno pošiljanje opomnikov

1. Odprite **Nastavitve** in poiščite kartico **E-pošta**.
2. Vklopite **Opominjaj kupce na neplačane račune**.
3. Pod **Dni pred rokom plačila** vpišite, koliko dni pred rokom se pošlje en opomnik. `0` ga izklopi.
4. Pod **Dni po roku plačila** vpišite presledek med opomniki po roku. Ponovijo se v tem presledku, največ trikrat. `0` jih izklopi.
5. Pritisnite **Shrani nastavitve e-pošte**.

   ![Kartica E-pošta v Nastavitvah](https://cdn.rabbitpay.net/help/sl/dark/invoices/send/email-settings.webp)

Opomnjeni so samo računi z e-poštnim naslovom kupca. Prodaje na blagajni niso nikoli opomnjene.

Ista kartica določa, kaj vsebuje vsaka e-pošta, če tega pri posameznem sporočilu ne spremenite: PDF, e-račun, povezavo do plačilne strani in povezavo do [portala za kupce](customer-portal).

## Sami pošljite povezavo za plačilo

**Pošlji** > **Kopiraj povezavo za plačilo** kopira naslov plačilne strani, da jo lahko prilepite v klepet ali sporočilo SMS. **Pošlji** > **Odpri plačilno stran** pokaže stran, na kateri kupec plača.

Stran lahko odpre vsak, ki ima povezavo, zato jo pošljite samo kupcu, ki mu je namenjena.
