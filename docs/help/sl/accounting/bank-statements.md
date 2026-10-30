# Bančni izpiski

Uvozite izpisek iz spletne banke, povežite plačila z računi in stroški ter vse drugo knjižite na konto.

## Uvoz izpiska

1. V spletni banki prenesite izpisek v obliki ISO 20022 **camt.053** XML.
2. Odprite **Knjigovodstvo** > **Banka** in pritisnite **Uvozi izpisek**.
3. Izberite datoteko. RabbitPay pokaže račun, obdobje, stanja in koliko postavk je novih.
4. Pritisnite **Uvozi**.

![Izpisek, pripravljen za uvoz](https://cdn.rabbitpay.net/help/sl/dark/accounting/bank-statements/import.webp)

Postavke, ki so že uvožene, se preskočijo, zato lahko varno uvozite izpiske, ki se prekrivajo.

## Povezovanje postavk

Vsaka nova postavka pokaže listine, ki jih verjetno plačuje, najdene po sklicu, znesku in imenu. Poudarjen predlog se ujema natančno.

![Postavke izpiska s predlogi](https://cdn.rabbitpay.net/help/sl/dark/accounting/bank-statements/lines.webp)

- Pritisnite predlog, da postavko povežete s tem računom, računom, izdanim drugje, ali stroškom.
- Pritisnite **Poveži natančna ujemanja** na vrhu, da hkrati povežete vse postavke, pri katerih se sklic in znesek ujemata natančno.

Povezava z računom kupca zabeleži plačilo na računu, zato je račun povsod v RabbitPay prikazan kot plačan.

Če ste račun že sami označili kot plačan z nakazilom, postavka namesto tega ponudi **Že plačano: poveži**. Postavko poveže s plačilom, ki ste ga vnesli, brez drugega plačila. Predlog, najden samo po znesku in pri drugem kupcu, nikoli ni glavni gumb. Najdete ga pod **Več**, kjer lahko z **Odpri** predlagani dokument tudi najprej preverite.

Če kupec ni navedel celotne številke računa, na primer je napisal 373 namesto 373/26, za predlog zadošča enak znesek. Za vse, česar predlogi ne najdejo, pod **Več** odprite **Poveži z več dokumenti** in vklopite **Prikaži že plačane račune**. Seznam pokaže plačane račune, katerih plačilo z nakazilom še ni povezano z bančno postavko. Iščite po številki, kupcu ali znesku, izberite plačilo in pritisnite **Poveži**.

![Po povezovanju ostane samo bančni strošek](https://cdn.rabbitpay.net/help/sl/dark/accounting/bank-statements/matched.webp)

## Eno plačilo za več listin

Ko kupec plača več računov hkrati ali račun, zmanjšan za dobropis, pri postavki odprite **Več** in izberite **Poveži z več dokumenti**. Izberite vse listine, ki jih plačilo poravna. Razlika mora biti nič, preden lahko povežete.

Račune kupcev je mogoče plačati delno, druge listine samo v celoti. Listina v tuji valuti se poveže sama, razlika do njene knjižene vrednosti pa se knjiži kot tečajna razlika.

## Plačila s kartico brez stroška

Plačila s kartico pogosto še nimajo stroška, ker je račun še v denarnici. RabbitPay iz bančne postavke prebere trgovino in skrije številko kartice. Na postavki pritisnite **Ustvari strošek** ali ga izberite pod **Več**: obrazec stroška se odpre z že vpisano trgovino, zneskom, datumom nakupa in načinom plačila **Kartica**. Izberite kategorijo in DDV, priložite račun in shranite. Strošek se v enem koraku poveže z bančno postavko in označi kot plačan.

## Knjiženje ostalega na konto

Bančni stroški, obroki posojil, davki in prenosi nimajo listine. Pod **Več** izberite **Knjiži na konto** in konto, na primer **4150** za bančne stroške.

![Knjiženje bančnega stroška](https://cdn.rabbitpay.net/help/sl/dark/accounting/bank-statements/book.webp)

Pri samostojnem podjetniku denar, porabljen za zasebne stvari s poslovnega računa, ni strošek. Pod **Več** izberite **Zasebno**: postavka se knjiži na **9190 Pritoki in odtoki med podjetjem in gospodinjstvom** in je v [Paketu za računovodstvo](expenses-and-reports/accountant-package) navedena kot zasebna. Uporabite ga tudi za denar, ki ga prenesete s poslovnega na osebni račun in nazaj.

Za postavko, ki se sploh ne sme knjižiti, pod **Več** izberite **Prezri**.

## Preverjanje stanja

Tabela izpiskov primerja končno stanje vsakega izpiska s **Stanjem v glavni knjigi** za ta bančni račun. Ko so vse postavke povezane ali knjižene, sta enaka in **Odprte postavke** kažejo 0.

![Vse postavke povezane ali knjižene](https://cdn.rabbitpay.net/help/sl/dark/accounting/bank-statements/all-lines.webp)

Pod **Prikaži** izberite **Vse**, da vidite vse postavke in kako so bile poravnane. **Ponovno odpri** razveljavi povezavo, knjiženje ali prezrto postavko. Ponovno odpiranje povezave z računom kupca odstrani tudi plačilo, ki je bilo zabeleženo na računu, zato je račun spet neplačan. Kupec ne prejme obvestila. Plačila, ki je bilo medtem vrnjeno, tako ni mogoče odstraniti.
