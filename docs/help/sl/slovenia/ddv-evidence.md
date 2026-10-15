# Evidence DDV za eDavke

RabbitPay iz vaših računov, dobropisov in stroškov sestavi evidenco obračunanega DDV (KIR) in evidenco odbitka DDV (KPR) ter vam da datoteko za eDavke.

Vsak zavezanec za DDV v Sloveniji ju odda FURS za vsako davčno obdobje.

## Ustvarite izvoz

1. Odprite **Statistika** in se pomaknite do **Uradni evidenci DDV za FURS**.
2. **Od** in **Do** sta nastavljena na prejšnji mesec. Spremenite ju, če je vaše davčno obdobje četrtletje.
3. **Obravnavo oddaje po roku** pustite na **Oddaja v roku**, razen če oddajate po roku. Ostale možnosti vklopite samo, če veljajo za vas, na primer **Zahtevam vračilo DDV**.
4. Pritisnite **Preveri evidence**.

   ![Evidenci DDV za september](https://cdn.rabbitpay.net/help/sl/dark/slovenia/ddv-evidence/form.webp)

## Odpravite, kar najde

RabbitPay preveri vsak dokument. Kartice kažejo, koliko zapisov gre v KIR in KPR in ali se ujemajo z vašimi dokumenti. Vse, zaradi česar bi FURS datoteko zavrnil, je navedeno pod **Napake, ki preprečujejo izvoz**, skupaj z dokumentom, ki mu pripada.

![Strošek brez računa dobavitelja preprečuje izvoz](https://cdn.rabbitpay.net/help/sl/dark/slovenia/ddv-evidence/errors.webp)

V tem primeru strošek nima priloženega računa dobavitelja. Odprite strošek, priložite račun in znova pritisnite **Preveri evidence**. Ko ne ostane nič, vidite **Pripravljeno za izvoz**.

![Pripravljeno za izvoz](https://cdn.rabbitpay.net/help/sl/dark/slovenia/ddv-evidence/validated.webp)

## Prenesite in oddajte

1. Pritisnite **Ustvari izvoz za FURS**. Datoteka se prenese.
2. V eDavkih odprite obrazec za evidence DDV za to obdobje in uvozite datoteko.

Vsak izvoz je naveden pod **Izvozi in popravki**, kjer **Prenesi ZIP** datoteko prenese znova.

![Izvoz in zaklenjeno obdobje](https://cdn.rabbitpay.net/help/sl/dark/slovenia/ddv-evidence/exported.webp)

## Obdobje je zaklenjeno

Ustvarjanje izvoza obdobje zaklene pod **Zaklepi obračunskih obdobij**. Računov, dobropisov in stroškov v njem ni več mogoče dodajati ali spreminjati, zato vaše evidence ostanejo enake oddanim.

Račun za dobavo v zaklenjenem obdobju je še vedno mogoč, kot [zamujeno poročanje](slovenia/vat-periods#racun-za-obdobje-ki-ste-ga-ze-oddali).

## Popravite oddano obdobje

1. Ob obdobju pritisnite **Odkleni**.
2. Napišite, zakaj, na primer zaradi računa dobavitelja, ki je prispel prepozno. Razlog in vaše ime se zabeležita.

   ![Odklep septembra z razlogom](https://cdn.rabbitpay.net/help/sl/dark/slovenia/ddv-evidence/unlock.webp)

3. Naredite popravek.
4. Izvoz ustvarite znova. Shrani se kot naslednja revizija in obdobje znova zaklene. V eDavkih ga oddajte kot popravek.

Obdobje lahko odklenejo samo osebe, ki smejo izvažati poročila.
