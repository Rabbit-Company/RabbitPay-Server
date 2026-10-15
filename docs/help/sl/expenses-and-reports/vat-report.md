# Obračun DDV

Poglejte DDV, ki ste ga obračunali pri prodaji v obdobju, razdeljen tako, kot ga zahteva obračun DDV.

## Ustvarite poročilo

1. Odprite **Statistiko** in poiščite **Obračun DDV**.
2. Izberite obdobje, na primer **Ta mesec** ali **Prejšnje četrtletje**.
3. Pritisnite **Ustvari poročilo**.

## Preberite poročilo

![Obračun DDV za ta mesec](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/vat-report/report.webp)

- **Neto prodaja** je, kar ste zaračunali brez DDV, s številom računov in dobropisov.
- **DDV za vaš davčni urad** je DDV za vaš obračun DDV.
- **DDV prek VEM** se pojavi, ko prodajate potrošnikom v drugih državah EU prek sistema vse na enem mestu.

Pod njimi je prodaja razvrščena po stopnjah pod **Prodaja z vašim DDV**, kadar jih imate, pa še pod prodajo brez DDV, domačo samoobdavčitvijo po kupcih (obrazec PD-O), rekapitulacijskim poročilom za prodajo podjetjem v EU in VEM po državah kupcev.

Zneski so v valuti poročanja, po popustih na računih, po datumu izdaje posameznega računa. Dobropis se odšteje v obdobju, v katerem je bil izdan. Račun v drugi valuti brez menjalnega tečaja je naveden pod **Izpuščeno, ni tečaja**, dokler tečaja ne nastavite na računu.

**Prenesi CSV** shrani poročilo.

## Evidence za FURS

Slovenski zavezanec za DDV ima v **Statistiki** tudi **Uradni evidenci DDV za FURS**.

![Uradni evidenci DDV za FURS](https://cdn.rabbitpay.net/help/sl/dark/expenses-and-reports/vat-report/ddv-evidence.webp)

1. Izberite davčno obdobje pod **Od** in **Do**.
2. Pritisnite **Preveri evidence**. RabbitPay na ravni listin preveri evidenco obračunanega DDV (KIR) in evidenco odbitka DDV (KPR) ter ju uskladi z izvornimi računi in stroški.
3. Odpravite napake, ki preprečujejo izvoz, nato pritisnite **Ustvari izvoz za FURS**.
4. Prenesite paket ZIP in ga uvozite v eDavke.

Vsak izvoz se ohrani kot revizija pod **Izvozi in popravki**, izvoz pa zaklene obračunsko obdobje pred poznejšimi spremembami. Več o tem v poglavju [Slovenska zakonodaja](slovenia).

## Kaj poročilo potrebuje

Najprej pod **Nastavitve** > **Davki** nastavite državo in status DDV. Brez njiju RabbitPay ne more razvrstiti postavk v prava polja. Glejte [Nastavite, kako za vas velja DDV](getting-started/company-details#nastavite-kako-za-vas-velja-ddv).
