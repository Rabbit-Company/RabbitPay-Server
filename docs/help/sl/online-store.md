# Spletna trgovina

Artikle iz svojega kataloga prodajajte v lastni spletni trgovini, s košarico, zaključkom nakupa, e-pošto o naročilih in računi, ki se izdajo sami, ko kupec plača.

## Odprite trgovino

Spletna trgovina je plačljiv modul. V projektu odprite **Trgovina** in unovčite licenco za spletno trgovino, če tega še niste storili.

1. Izpolnite podatke podjetja pod **Nastavitve** > **Podatki podjetja**. Trgovina jih potrebuje za račune in pravne strani.
2. Vklopite vsaj en način plačila. Glejte [Plačila](payments).
3. Odprite **Trgovina**, izberite ime in spletni naslov trgovine ter pritisnite **Ustvari trgovino**.

Nova trgovina ima že pripravljeno politiko zasebnosti, splošne pogoje prodaje in stran o odstopu od pogodbe, izpolnjene s podatki vašega podjetja. Preberite jih in prilagodite svojemu načinu prodaje. Politika zasebnosti in pogoji prodaje so obvezni.

Ko ste pripravljeni na kupce, vklopite **Trgovina je odprta**.

## Prilagodite trgovino

Vse o videzu in delovanju trgovine je pod **Trgovina** > **Nastavitve**.

- **Splošno**: ime, slogan, privzeti jezik, spletni naslov in obvestilna vrstica.
- **Videz**: logotip, naslovna slika in besedilo, poudarjena barva, barvna shema, pisava, vogali, kartice izdelkov in število izdelkov v vrsti.
- **Lastna domena**: povežite svojo domeno in sledite tam prikazanim navodilom za DNS.
- **Fizična trgovina**: naslov, povezava do zemljevida in delovni čas.
- **Dostava**: načini dostave s cenami, brezplačna dostava nad določenim zneskom, prevzem v trgovini in čas priprave.
- **Zaključek nakupa**: koliko dni ima kupec za plačilo in ali so dovoljene opombe k naročilu.
- **Strani in pravna besedila**: vaše pravne strani in morebitne dodatne strani, napisane v Markdownu.

## Dodajte izdelke in kategorije

Vsak artikel pod **Artikli** lahko prodajate v trgovini. Cena in DDV vedno prideta iz artikla.

1. Odprite **Trgovina** > **Izdelki** in pri artiklu pritisnite **Dodaj v trgovino**.
2. Dodajte kratek povzetek, opis, do 12 fotografij in specifikacije, na primer `Barva: Črna`. Kupci izdelke filtrirajo po specifikacijah.
3. Izberite kategorijo in vklopite **Naprodaj v trgovini**.

Vklopite **Spremljaj zalogo**, da se izdelek neha prodajati, ko ga zmanjka. Pričakovani datum dobave kupcem pove, kdaj bo spet na voljo. Artikli, ki prodajajo licenčne ključe, zalogo jemljejo iz ključev.

Kategorije ustvarite pod **Trgovina** > **Kategorije**. Kategorije so lahko vgnezdene, stran kategorije pa prikaže tudi izdelke njenih podkategorij.

## Ponudite kupone

Pod **Trgovina** > **Kuponi** pritisnite **Nov kupon** in izberite, kaj prinaša: odstotni popust, znesek popusta ali brezplačno dostavo. Kupon lahko omejite na obdobje, na skupno število uporab in na eno uporabo na kupca.

## Prodajajte v več jezikih

Angleščina in slovenščina sta vgrajeni. Pod **Trgovina** > **Prevodi** lahko dodate skupaj do 10 jezikov, jih prevajate v svojem tempu in vsakega prikažete v trgovini, ko je pripravljen.

- **Uredi besedila** spremeni katerokoli besedilo, ki ga trgovina prikaže, od gumbov do oznak pri zaključku nakupa.
- Imena in opise izdelkov ter kategorij prevedete tam, kjer jih pišete, na zavihku za vsak jezik.
- Besedilo, ki ga pustite prazno, se prikaže v privzetem jeziku.

Naročila, računi in e-pošta o naročilih ostanejo v privzetem jeziku.

## Obdelajte naročila

Kupec se prijavi s povezavo, poslano na njegov e-poštni naslov, in odda naročilo. Prejme potrditev naročila s povezavo do plačilne strani, zaloga pa se rezervira zanj.

**Trgovina** > **Naročila** prikaže naročila. Pogled **Plačano, za odpremo** pokaže, kaj je treba poslati naslednje.

1. Odprite naročilo in pritisnite **Začni pripravo**.
2. Ko ga odpošljete, dodajte povezavo za sledenje in pritisnite **Označi kot odposlano**.
3. Ko prispe, pritisnite **Označi kot dostavljeno**.

Vsak korak lahko kupcu pošlje e-pošto. **Prekliči naročilo** pri naročilu, ki še ni odposlano, vrne zalogo.

## Kako naročila postanejo računi

Naročilo še ni račun. Ima številko naročila, na primer `ORDER-26000001`, in čaka na plačilo.

Račun se izda, ko prispe prvo plačilo, s kartico, kriptovaluto ali bančnim nakazilom, ki ga zabeležite. Dobi naslednjo številko računa in je kupcu poslan kot PDF, za njim pa morebitni licenčni ključi. Ker številko računa dobijo le plačana naročila, opuščena naročila ne puščajo vrzeli in ne potrebujejo dobropisov.

Naročilo, ki je 7 dni po roku plačila še neplačano, se samodejno prekliče in njegova zaloga se sprosti.

Plačano naročilo vrnete tako, da vrnete plačilo na njegovem računu. Glejte [Računi](invoices).

## Zasebnost v vaši trgovini

Trgovina ne nastavlja sledilnih ali oglaševalskih piškotkov. Kupci morajo pri zaključku nakupa sprejeti vaše pogoje in politiko zasebnosti, svoje podatke pa lahko izvozijo ali izbrišejo na strani svojega računa. Iskalniki lahko prikažejo vašo trgovino in strani izdelkov, nikoli pa košarice, zaključka nakupa ali strani računa.
