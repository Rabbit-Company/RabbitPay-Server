# Računi

Ustvarite račun, ga pošljite kupcu, zabeležite plačilo in ga popravite, ko se kaj spremeni. Vsi koraki se začnejo v vašem projektu pod **Računi**.

## Ustvarite račun

1. Odprite **Računi** in pritisnite **Nov račun**.
2. Izberite kupca. Začnite tipkati ime, e-pošto ali ID za DDV ali izberite **Dodaj novega kupca** in ga ustvarite, ne da bi zapustili obrazec.
3. Pod **Postavke** dodajte postavke. Vpišite opis ali poiščite izdelke in storitve, ki ste jih shranili pod **Artikli**, nato vnesite količino, ceno na enoto in davčno stopnjo. Z **Dodaj postavko** dodate naslednjo.
4. Nastavite **Rok plačila**. **Datum dobave** izpolnite le, če je bilo blago ali storitev dobavljena na drug dan, kot je datum računa.
5. Pritisnite **Ustvari in izdaj**, da račun takoj izdate, ali **Ustvari osnutek**, da ga shranite in dokončate pozneje.

**Predogled** pokaže račun tako, kot ga bo videl kupec, še preden se karkoli shrani.

Popust vnesete enkrat za celoten račun in se odšteje pred davkom. Opombe, ki jih vpišete na obrazcu, so natisnjene na računu.

## Osnutki in izdani računi

Osnutek je račun v pripravi. Namesto številke ima začasno oznako, na primer `DRAFT-8KQ2LM4P`, lahko ga urejate ali izbrišete, kupec pa ga ne more plačati.

Ko je osnutek pripravljen, ga odprite in pritisnite **Izdaj račun**. Račun takrat dobi naslednjo številko iz vašega zaporedja in ga je mogoče plačati. Ker se številka dodeli šele ob izdaji, izbris osnutka nikoli ne pusti vrzeli v številčenju.

Izdanega računa ni več mogoče urejati ali izbrisati. Če ga želite spremeniti, [izdajte dobropis](#popravite-ali-preklicite-racun).

| Stanje       | Pomen                                               |
| ------------ | --------------------------------------------------- |
| osnutek      | Še ni izdan. Nima številke in ga ni mogoče plačati. |
| odprt        | Izdan in čaka na plačilo.                           |
| zapadel      | Izdan, rok plačila je že potekel.                   |
| delno plačan | Del zneska je že prispel.                           |
| plačan       | Plačan v celoti.                                    |
| preklican    | Umaknjen. Njegova številka ostane porabljena.       |
| vrnjen       | Plačilo je bilo vrnjeno kupcu.                      |

## Pošljite račun

Odprite račun in uporabite meni **Pošlji**.

- **Pošlji račun** ga pošlje na kupčev e-poštni naslov. Dodate lahko sporočilo, priložite račun kot PDF, priložite e-račun (e-SLOG XML) in dodate povezavo do plačilne strani.
- **Pošlji opomnik** kupca opomni na znesek, ki je še odprt, s povezavo za plačilo.
- **Kopiraj povezavo za plačilo** kopira naslov plačilne strani, da ga lahko pošljete po katerikoli drugi poti.
- **Odpri plačilno stran** pokaže stran, na kateri kupec plača.

Vsaka poslana e-pošta je navedena na računu in pod **E-pošta** v projektu, skupaj s podatkom, ali je bila dostavljena.

## Natisnite ali prenesite račun

Odprite račun in uporabite meni **Dokumenti**.

- **Natisni** odpre račun na samostojni strani, pripravljen za tiskalnik.
- **Prenesi PDF** ga shrani kot datoteko PDF.
- **Prenesi e-SLOG** shrani izdan račun kot e-račun v obliki e-SLOG.

Če se na robu papirja izpiše spletni naslov, datum ali številka strani, jih je dodal vaš brskalnik. V oknu za tiskanje izklopite **Glave in noge**, da izginejo.

Če potrebujete več računov hkrati, na seznamu računov pritisnite **Prenesi PDF-je**. Izberite obdobje pod **Po datumu** ali prvi in zadnji račun pod **Po številki računa**, nato jih prenesite kot eno datoteko ZIP. Ena datoteka vsebuje do 1000 računov. Osnutki in predračuni so izpuščeni, preklicani računi pa so vključeni, ker so bile njihove številke porabljene.

## Zabeležite plačilo

Plačila s kartico, prek PayPala ali s kriptovalutami na plačilni strani se zabeležijo sama. Vse drugo, na primer bančno nakazilo ali gotovino, zabeležite ročno.

1. Odprite račun in pritisnite **Zabeleži plačilo**.
2. Vnesite znesek in datum, ko je denar prispel. Če ju želite shraniti, dodajte bančni sklic in opombo.
3. Shranite. Račun postane **delno plačan** ali **plačan**, odvisno od zneska.

Če želite denar vrniti, poiščite plačilo na dnu računa in pritisnite **Vrni**. Vklopite **Izdaj dobropis za to vračilo**, kadar vračilo zniža tudi to, kar ste zaračunali.

## Popravite ali prekličite račun

Izdan račun se popravi z dobropisom, nikoli z urejanjem.

1. Odprite račun in v kartici **Dobropisi** pritisnite **Izdaj dobropis**.
2. Izberite, kaj želite dobropisati: vse, kar ostaja, en znesek, porazdeljen po postavkah, ali izbrane postavke.
3. Vpišite razlog. Natisnjen je na dobropisu.

Če je bil celoten račun napaka, odprite **Več** in izberite **Prekliči račun**. Račun ostane v evidenci, za vse, kar še ni bilo dobropisano, se izda dobropis, vaše poročilo DDV pa ostane pravilno.

Osnutek, ki ga ne potrebujete več, preprosto odstranite z **Več** > **Izbriši osnutek**.

## Predračuni

S predračunom kupca prosite za plačilo, preden izdate račun. Ima svoje zaporedje številk, ni račun in se ne potrjuje pri FURS niti ne vodi v vaših evidencah DDV.

Ustvarite ga z **Ustvari predračun** na obrazcu za nov račun ali iz osnutka pod **Več**. Pošljete ga prek **Pošlji** > **Pošlji predračun po e-pošti**. Urejate ga lahko do prvega plačila. Ni ga mogoče izbrisati, le preklicati.

Sami izberete, kaj se zgodi, ko je plačan:

- **Takoj izdaj račun.** Prvo plačilo predračun spremeni v račun z naslednjo številko računa. To izberite, kadar dobavite ob plačilu.
- **Za vsako plačilo izdaj račun za predplačilo.** Vsako plačilo dobi svoj račun za predplačilo za prejeti znesek. Ko dobavite, z **Več** > **Izdaj končni račun** ustvarite končni račun, ki odšteje račune za predplačilo.

Privzeto izbiro nastavite pod **Nastavitve** > **Številčenje dokumentov**, za posamezen predračun pa jo do prvega plačila spremenite z **Več** > **Spremeni, kaj se zgodi ob plačilu**.

**Več** > **Takoj izdaj račun** predračun spremeni v račun, ne da bi čakali na plačilo.

## Nastavite številčenje računov

Številke računov si morajo slediti zaporedno in brez vrzeli. Kako so videti, določite pod **Nastavitve** > **Številčenje dokumentov**.

| Koda          | Postane                                 |
| ------------- | --------------------------------------- |
| `YYYY` / `YY` | Leto, 2026 ali 26                       |
| `MM`          | Mesec, od 01 do 12                      |
| `DD`          | Dan, od 01 do 31                        |
| `X`           | Ena števka števca, `XXX` torej da `001` |

Vse drugo se izpiše tako, kot je zapisano. `XXX/YY` da `001/26`, `INV-YYYY-XXXX` pa `INV-2026-0001`. Besedilo, ki vsebuje črke Y, M, D ali X, postavite v dvojne narekovaje, na primer `"ORDER"-YYXXXXXX`.

Števec se znova začne z 1 glede na najmanjši del datuma v obliki: vsako leto, če oblika vsebuje samo leto, vsak mesec z `MM` in vsak dan z `DD`.

Če ste letos račune že izdajali drugje, nastavite **Naslednja številka** in nadaljujte zaporedje, na primer 42 po 41 izdanih računih. Stran z nastavitvami pokaže naslednjo številko natanko tako, kot bo natisnjena.

Računi, predračuni in naročila v spletni trgovini imajo vsak svojo obliko in svoj števec. Dobropisi uporabljajo obliko računov s `CN` spredaj.

## Izberite jezik in obliko datuma

Pod **Nastavitve** > **Račun** izberete jezik računov in plačilne strani ter način zapisa datumov in ur na njih. To je ločeno od jezika vmesnika, ki si ga vsak uporabnik izbere sam s preklopnikom jezika. Delate lahko v slovenščini in še vedno izdajate račune v angleščini.
