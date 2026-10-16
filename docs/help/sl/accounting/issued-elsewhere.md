# Računi, izdani drugje

Prenesite račune iz drugega programa ali blagajne v knjige, evidence DDV in poročilo DDV, z njihovimi izvirnimi številkami.

## Zakaj jih evidentirati

Podjetje, ki je z RabbitPay začelo med letom ali še prodaja prek druge blagajne, ima račune, ki jih RabbitPay ni izdal. Evidentirajte jih tukaj, da so knjige popolne.

RabbitPay ohrani njihovo izvirno številko in jih nikoli ne potrjuje pri FURS, ne pošilja in ne preštevilči. Pokažejo se v dnevniku, KIR, poročilu DDV, [odprtih postavkah](accounting/open-items) in pri [povezovanju z banko](accounting/bank-statements).

## Uvoz več računov hkrati

1. Odprite **Knjigovodstvo** > **Izdani drugje** in pritisnite **Uvozi CSV**.
2. Pritisnite **Prenesi predlogo** za datoteko s pravimi stolpci in primerom.
3. Izpolnite eno vrstico za vsako stopnjo DDV listine. Vrstice z isto številko postanejo en račun.
4. Izberite datoteko. RabbitPay preveri vsako vrstico in našteje najdene račune.
5. Pritisnite **Uvozi**.

![Sedem lanskih računov, pripravljenih za uvoz](https://cdn.rabbitpay.net/help/sl/dark/accounting/issued-elsewhere/import.webp)

Datume lahko pišete kot 5.1.2026 ali 2026-01-05, zneske pa kot 1.234,56 ali 1234.56. Imena stolpcev so lahko slovenska ali angleška.

Nič se ne uvozi, dokler niso vse vrstice pravilne. Če ima vrstica napako, seznam pove, katero vrstico in kateri stolpec popraviti. Številka, ki je že evidentirana, ali datum izdaje v mesecu, za katerega ste izvozili evidenco DDV, sta zavrnjena.

| Stolpec                                          | Kaj vpišete                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| številka                                         | Številka, natisnjena na računu                                                       |
| vrsta listine                                    | račun ali dobropis                                                                   |
| datumi izdaje, opravljene storitve in zapadlosti | Datumi z računa                                                                      |
| kupec, ID za DDV in država kupca                 | Kupec                                                                                |
| valuta in tečaj                                  | Za račune v tuji valuti tečaj, uporabljen na računu                                  |
| stopnja, obravnava, osnova in DDV                | Ena stopnja DDV na vrstico, na primer 22, domestic, 200,00 in 44,00                  |
| datum plačila in plačano na                      | Kdaj je bil plačan in ali na banko ali v blagajno. Pustite prazno, dokler ni plačan. |

Natančna imena stolpcev so v predlogi.

## Seznam

Izberite obdobje, da vidite račune, evidentirane v njem, s kupcem, obravnavo DDV, zneskom in datumom plačila.

![Lanski računi, izdani drugje](https://cdn.rabbitpay.net/help/sl/dark/accounting/issued-elsewhere/list.webp)

- **Priloži izvirnik** doda PDF ali sliko računa, da se hrani skupaj s knjigami.
- **Uredi** popravi evidentirani račun. Njegove knjižbe se popravijo v dnevniku.
- **Izbriši** ga odstrani in stornira njegove knjižbe.

## Ročni vnos enega računa

Pritisnite **Evidentiraj račun** in prepišite zneske natančno tako, kot so na izvirniku. Zneske dobropisa vpišite kot pozitivna števila in kot listino izberite **Dobropis**.

![Obrazec za en račun](https://cdn.rabbitpay.net/help/sl/dark/accounting/issued-elsewhere/new.webp)

Za vsako stopnjo DDV dodajte vrstico z **Dodaj stopnjo DDV**. **Shrani in dodaj novo** pusti obrazec odprt za naslednji račun.
