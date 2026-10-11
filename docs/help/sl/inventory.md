# Zaloge

Vodite zalogo po artiklih in skladiščih, vrednotite jo po metodi FIFO ali povprečnih cen, enkrat letno jo popišite, vsaka prodaja pa jo zmanjša sama.

## Začnite voditi zalogo

Zaloge so ločena licenca. Na strani **Licenca** unovčite ključ za zaloge in v meniju se pojavi zavihek **Zaloge**.

1. Odprite **Zaloge** in pritisnite **Vodi zalogo za artikel**.
2. Izberite artikel. Zalogo lahko vodijo samo artikli vrste blago, storitve in licenčni ključi je ne morejo.
3. Izberite vrsto zaloge. **Trgovsko blago** je kupljeno za nadaljnjo prodajo. **Material** se porabi pri delu ali proizvodnji.
4. Po želji vnesite minimalno zalogo. Artikel se označi, ko zaloga pade pod njo.

Od tega trenutka naprej vsak izdan račun s tem artiklom zmanjša zalogo. Računi, izdani pred tem, ostanejo nespremenjeni.

## Vnesite zalogo, ki jo že imate

Ob začetku vnesite, kar imate danes na policah, z dokumentom **Otvoritev zaloge** pod **Več dokumentov**.

1. Izberite datum in skladišče.
2. Za vsak artikel dodajte vrstico s količino in nabavno vrednostjo brez DDV.
3. Izberite knjižbo v glavni knjigi. Izberite **Brez**, če ima računovodja to zalogo že v otvoritveni bilanci. Izberite **Pripoznaj zalogo in zmanjšaj stroške**, če je bilo blago ob nakupu knjiženo med stroške.
4. Pritisnite **Knjiži**.

## Prevzemite blago

1. Pritisnite **Nova prevzemnica**.
2. Vnesite dobavitelja in številko dobavnice ali računa.
3. Dodajte artikle s količino in ceno na enoto ali vrednostjo vrstice, oboje brez DDV.
4. Prevoz, carino in podobne stroške vnesite pod **Odvisni stroški nabave**. Razdelijo se po vrsticah glede na vrednost in postanejo del nabavne vrednosti, kot zahteva SRS 4.
5. Pritisnite **Shrani osnutek**, če boste nadaljevali pozneje, ali **Knjiži**, da blago prevzamete na zalogo.

Ko račun dobavitelja zabeležite pod **Stroški**, nastavite **Nabava zalog** na trgovsko blago ali material. Tak račun še ni strošek. Nato se na strani Zaloge pojavi pod **Nabave brez prevzema**, kjer **Ustvari prevzemnico** odpre prevzemnico z izpolnjenim dobaviteljem, številko in vrednostjo.

## Naročite pri dobavitelju

Naročilnice niso obvezne. Uporabite jih, ko želite vedeti, kaj je na poti in kaj vam dobavitelj še dolguje.

1. Dobavitelja dodajte pod **Zaloge**, **Dobavitelji** z davčno številko in IBAN-om.
2. Odprite **Naročila**, pritisnite **Nova naročilnica**, izberite dobavitelja ter dodajte artikle, količine in dogovorjene cene brez DDV.
3. Pritisnite **Potrdi naročilo**. Naročilnica dobi številko in jo lahko natisnete ter pošljete dobavitelju.
4. Ko blago prispe, odprite naročilnico in pritisnite **Prevzemi blago**. Prevzemnica se odpre z odprtimi količinami in cenami, zato popravite samo to, kar je dejansko prispelo. Dobava v več delih je preprosto več prevzemnic.

Naročilo se zaključi samo, ko prispe vse. **Zaključi naročilo** ga konča prej, ko ne pričakujete ničesar več. Naročene količine so na seznamu zalog prikazane kot naročene, naročilnica pa kaže naročeno, prevzeto in zaračunano vrednost eno ob drugi, tako da račun dobavitelja, ki se ne ujema s prevzemi, hitro opazite.

**Artikli za naročilo** na strani Naročila našteje vse artikle, katerih zaloga skupaj z odprtimi naročili je pod minimalno. **Ustvari naročilo** odpre naročilnico z manjkajočimi količinami in zadnjimi nabavnimi cenami.

## Kaj se zgodi ob prodaji

Ničesar vam ni treba narediti. Izdan račun, prodaja na blagajni in plačano spletno naročilo vzamejo blago iz privzetega skladišča in izračunajo njegovo nabavno vrednost.

- Storno celotnega računa vrne blago po vrednosti, s katero je bilo izdano.
- Delni dobropis zaloge ne spremeni. Ko kupec blago res vrne, vnesite **Novo prevzemnico** z razlogom **Vračilo kupca** in izberite račun.
- Če zaloga ne sme pod ničlo (glejte [Izberite metodo vrednotenja](#izberite-metodo-vrednotenja)), se račun za več, kot imate, zavrne.

## Izdajte zalogo iz drugih razlogov

Z **Novo izdajnico** vnesite vse, kar zapusti zalogo brez prodaje, in izberite razlog.

- **Poraba v podjetju** material spremeni v strošek.
- **Poškodba ali lom** ter **Pretečen rok ali zastarelost** blago odpišeta. Hranite zapisnik o uničenju.
- **Kalo v okviru normativa** je izguba v mejah normativa pristojnega združenja. DDV se ne obračuna.
- **Primanjkljaj nad dovoljenim kalom**, **Lastna raba** in **Darilo ali vzorec** se praviloma štejejo za dobavo. Pustite vklopljeno **Obračunaj DDV od nabavne vrednosti** in DDV se knjiži ter vpiše v evidenco DDV kot interni dokument.
- Pri **Tatvini** se DDV ne obračuna, če je sestavljen policijski zapisnik. **Višja sila** zajema požar, poplavo in podobne dogodke.
- **Vračilo dobavitelju** pošlje blago nazaj. Dobropis dobavitelja zabeležite kot nabavo zalog.

## Prenesite zalogo med skladišči

Skladišča dodate pod **Zaloge**, **Nastavitve**. Zaloga se vodi in vrednoti ločeno za vsako skladišče.

1. Pod **Več dokumentov** izberite **Nov prenos**.
2. Izberite skladišče, iz katerega gre blago, in skladišče, v katero gre.
3. Dodajte artikle in količine ter pritisnite **Knjiži**.

Blago ohrani svojo nabavno vrednost. Prodaja vedno jemlje iz privzetega skladišča, zato blago pred prodajo prenesite tja.

## Popišite zalogo

Zakon o gospodarskih družbah (ZGD-1) zahteva, da knjižno stanje vsaj enkrat letno uskladite z dejanskim.

1. Pod **Več dokumentov** izberite **Nova inventura**, nato datum in skladišče.
2. Pritisnite **Natisni popisni list** za seznam, po katerem boste šteli. Različica brez knjižnega stanja prepreči, da bi popisovalci prepisali pričakovane količine.
3. Pritisnite **Dodaj vse artikle** in za vsakega vnesite popisano količino. Artikli, ki jih izpustite, ostanejo nespremenjeni. Za artikel, ki ga sploh ni, vnesite 0.
4. Odločite, ali se od primanjkljajev obračuna DDV. Od primanjkljaja nad dovoljenim kalom se, glejte [Izdajte zalogo iz drugih razlogov](#izdajte-zalogo-iz-drugih-razlogov).
5. Pritisnite **Knjiži**. Presežki in primanjkljaji se knjižijo po trenutni nabavni vrednosti.

Po inventuri za popisane artikle ni več mogoče knjižiti na njen datum ali pred njim. Knjiženo inventuro natisnite kot zapisnik, ki ga podpiše popisna komisija.

## Stornirajte dokument

Knjiženega dokumenta ni mogoče spremeniti. Odprite ga, pritisnite **Storniraj dokument** in navedite razlog. Njegova gibanja se odstranijo, vse poznejše izdaje se ovrednotijo znova in knjižba v glavni knjigi se stornira. Dokument ostane na seznamu kot storniran in ohrani številko. Nato vnesite nov, pravilen dokument.

## Oglejte si zalogo na pretekli dan

**Zaloga na dan** pokaže količine in vrednosti ob koncu kateregakoli dne, na primer 31. decembra za bilanco stanja. Prenesete jo lahko kot CSV ali natisnete.

**Kartica artikla** za imenom vsakega artikla našteje vsak prevzem, prodajo in izdajo s količino in vrednostjo po njem.

## Izberite metodo vrednotenja

Pod **Zaloge**, **Nastavitve** izberete, kako se izračuna nabavna vrednost prodane in porabljene zaloge. SRS 4 dovoljuje obe metodi.

- **Drseče tehtane povprečne cene** ob vsakem prevzemu znova izračunajo povprečno ceno.
- **FIFO** najprej izda najstarejšo nabavo.

Pred prvim gibanjem lahko izbirate prosto. Pozneje je metodo mogoče spremeniti samo s 1. januarjem leta, ki še ni zaključeno, ker gre za spremembo računovodske usmeritve. Prej se dogovorite z računovodjo.

**Dovoli zalogo pod ničlo** določa, kaj se zgodi, ko prodate ali izdate več, kot kažejo knjige. Če je dovoljeno, se manjkajoča količina ovrednoti po zadnji znani ceni in popravi ob prevzemu. Če ni dovoljeno, se taki dokumenti in računi zavrnejo.

## Kako zaloga pride v glavno knjigo

Z licenco za knjigovodstvo se vsak skladiščni dokument knjiži sam.

- Račun za nabavo zalog gre na konto obračuna nabave (650 za blago, 300 za material), prevzemnica pa vrednost prenese na zalogo (660 ali 310).
- Prodaja prenese nabavno vrednost z zaloge na nabavno vrednost prodanega blaga (702), prihodek takih artiklov pa gre na 762 ali 763.
- Material, porabljen v podjetju, postane strošek materiala (400). Odpisi gredo na 721.
- Primanjkljaj ali presežek blaga popravi 702.

**Zaloge**, **Nastavitve** primerja vrednost zaloge s saldom konta zalog, tako da manjkajoče otvoritveno stanje ali ročno knjižbo opazite takoj.

## Prodajajte artikle z zalogo v spletni trgovini

Artikel, ki vodi zalogo, v [spletni trgovini](online-store) kaže dejansko razpoložljivost. Trgovina upošteva privzeto skladišče in rezervira naročila, ki so oddana, a še niso plačana. Število zaloge na izdelku v trgovini se za take artikle ne uporablja več.
