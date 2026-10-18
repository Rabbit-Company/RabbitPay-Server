# Opomini

Opomin je uradni poziv k plačilu, ki navede, koliko vam stranka še dolguje.

Prikaže vse zapadle dokumente ene stranke, skupni odprti znesek in kako ga plačati. RabbitPay ga pripravi kot PDF v obliki vaših računov, z UPN QR kodo ali podatki za nakazilo, in ga lahko pošlje po e-pošti. Samodejni opomniki po e-pošti ostanejo, kot so. Opomin uporabite, ko jih stranka prezre ali dolguje več mesecev.

## Kdo zamuja

V meniju pod Prodaja odprite **Opomini**. Na vrhu vidite skupni zapadli znesek, število strank z dolgom in število opominov v tem letu.

Spodaj so **Stranke z zapadlimi računi**, najstarejši dolg najprej, z zadnjim opominom, ki ga je stranka prejela, in **Izdani opomini**.

![Opomini s strankami, ki zamujajo](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/overview.webp)

## Pripravite opomin

1. Pri stranki pritisnite **Pošlji opomin**. Lahko pa pritisnete **Nov opomin** in izberete stranko, na strani stranke pritisnete **Opomin** ali v meniju **Pošlji** zapadlega računa izberete **Ustvari opomin**.

   ![Izbira stranke za nov opomin](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/pick-customer.webp)

2. Pod **Neplačani dokumenti** pustite označene dokumente, ki naj bodo na opominu. Vsi zapadli računi so označeni, pri vsakem vidite število dni zamude. Računi, ki še niso zapadli, niso vključeni.

   ![Zapadli računi stranke](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/documents.webp)

3. Pod **Opomin** izberite stopnjo. RabbitPay predlaga naslednjo stopnjo glede na zadnji opomin stranke.
   - **Opomin** je prijazen in omeni, da je plačilo morda spregledano.
   - **Drugi opomin** se sklicuje na prejšnji opomin.
   - **Zadnji opomin** opozori, da bo terjatev predana v izterjavo oziroma izvršbo.
4. Nastavite **Rok plačila (dni)**. V Sloveniji je običajno 8 dni. Izberite **Jezik** opomina.
5. Po želji vklopite zamudne obresti ali nadomestilo stroškov. Oboje je razloženo spodaj. **Opomba** se natisne pod dokumenti, na primer ponudba za obročno plačilo.

   ![Stopnja, rok plačila, zamudne obresti in nadomestilo stroškov](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/options.webp)

6. Preverite **Povzetek**. Sešteje odprti znesek, obresti in nadomestilo ter prikaže rok plačila.

   ![Povzetek s skupnim zneskom za plačilo](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/summary.webp)

7. Pritisnite **Predogled PDF**, da vidite opomin, nato **Izdaj opomin** in potrdite. Opomin dobi naslednjo številko, na primer OP-2026-0001. Obliko številk lahko spremenite v [Številke računov](invoices/numbering).

## Pošljite opomin

Takoj po izdaji RabbitPay ponudi, da opomin pošljete na e-naslov stranke. Po želji dodajte sporočilo in pritisnite **Pošlji opomin**. Stranka prejme opomin kot PDF, seznam dokumentov in podatki za plačilo pa so tudi v samem e-sporočilu.

![Pošiljanje opomina](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/email.webp)

Pozneje ga lahko znova pošljete z gumbom **Pošlji** na opominu. Za tiskanje izberite **Dokumenti** in nato **Odpri PDF** ali **Prenesi PDF**.

## Kaj prejme stranka

PDF ima obliko vaših računov. Za vsak dokument navede datum zapadlosti, dni zamude in odprti znesek, nato sešteve, okvir za plačilo z UPN QR kodo za celoten znesek in pravna pojasnila.

![Opomin v PDF obliki](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/pdf.webp)

## Računi iz časa pred RabbitPay

Če vam stranka še dolguje po računih iz prejšnjega programa ali papirnih računih, jih dodajte ročno.

1. Pod **Neplačani dokumenti** pritisnite **Dodaj račun, izdan izven RabbitPay**.
2. Vpišite **Številko računa**, datuma, **Znesek računa** in koliko je **Še odprto**. Če ni bilo nič plačano, znesek računa pustite prazen.

   ![Dodajanje računa, izdanega izven RabbitPay](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/manual.webp)

3. Pritisnite **Dodaj v opomin**. Račun se pridruži seznamu z oznako, da je dodan ročno.

   ![Račun iz časa pred RabbitPay na opominu](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/documents-manual.webp)

Ti računi so samo na opominu. Ne spremenijo knjig, evidenc DDV ali statistike. Ko pripravite naslednji opomin za isto stranko, jih gumb **Ponovno dodaj ... iz zadnjega opomina** prenese, zato odstranite le plačane.

Računi, ki ste jih v Računovodstvu vnesli pod **Izdani drugje**, se prikažejo sami, če se ID za DDV ali naziv kupca ujema s stranko.

## Zamudne obresti

Pri slovenskih projektih lahko vklopite **Dodaj zakonske zamudne obresti**. RabbitPay jih izračuna za vsak dokument:

- od prvega dne po zapadlosti do datuma opomina
- po linearni metodi
- po predpisani obrestni meri zamudnih obresti za vsako polletje (obrestna mera ECB, povečana za 8 odstotnih točk, ZPOMZO-1), od 1. 7. 2026 10,40 %
- nikoli več od odprtega zneska (376. člen Obligacijskega zakonika)

Opomin navede uporabljene obrestne mere in da zamudne obresti niso predmet DDV. Obresti so izračunane od zneska, ki je odprt danes. Če je stranka del računa plačala z zamudo, so dejanske obresti nekoliko višje, zato opomin nikoli ne zahteva preveč.

Brez vklopa opomin navede, da si pridržujete pravico do obračuna zamudnih obresti.

## Nadomestilo izterjatvenih stroškov

Med podjetji lahko za vsak zamujeni račun zahtevate 40 EUR (14. člen ZPreZP-1, v drugih državah EU Direktiva 2011/7/EU). Vklopite **Dodaj nadomestilo izterjatvenih stroškov 40 EUR na račun**. Na voljo je samo za poslovne stranke, za opomine v EUR in za račune, ki so zapadli pred manj kot 3 leti.

## Stari dolgovi

Dokumenti, ki so zapadli pred več kot 3 leti, dobijo opozorilo. Terjatve med podjetji običajno zastarajo v 3 letih. Opomin zastaranja ne pretrga, pretrga ga le pisno priznanje dolga ali sodni postopek. Opomin lahko vseeno pošljete, stranka lahko dolg še vedno plača.

## Po opominu

Opomin odprite v seznamu **Izdani opomini** in preverite, koliko je še odprto na posameznem računu. Stanje se spremeni v **Delno plačano** ali **Plačano**, ko prispejo plačila, in v **Rok je potekel**, ko stranka zamudi rok. Poslana e-sporočila so navedena na dnu.

![Opomin s tem, kar je še odprto na vsakem računu](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/letter.webp)

Ko rok poteče, pošljite naslednjo stopnjo. Na strani **Opomini** gumb pri stranki zdaj pravi **Pošlji drugi opomin**, na opominu pa ga najdete pod **Več**. Tam lahko opomin tudi izbrišete. Brisanje ne odstrani že poslanih e-sporočil.

![Naslednji opomin za isto stranko](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/next-level.webp)

## Izvršba po zadnjem opominu

Če stranka do roka na **zadnjem opominu** ne plača, opomin pokaže **Naslednji korak: izvršba**. Neplačan račun je verodostojna listina (23. člen ZIZ), zato lahko sodišče izvršbo dovoli brez tožbe. RabbitPay pripravi predlog, vi pa ga vložite na portalu e-Sodstvo.

![Zadnji opomin ponudi naslednji korak, izvršbo](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/enforcement-next.webp)

1. Odprite zadnji opomin in pritisnite **Pripravi predlog za izvršbo**. Najdete ga tudi pod **Več**.
2. Preverite, kaj se terja. Vsak račun, ki je še odprt, je naveden z odprtim zneskom, datumom zapadlosti in zakonskimi zamudnimi obrestmi od naslednjega dne. Če je zadnji opomin obračunal 40 EUR stroškov izterjave, se ti terjajo za vsak račun kot samostojen znesek, ker jih zakon ne šteje med izvršilne stroške. Plačani računi so izpuščeni.

   ![Odprti računi in stroški izterjave v predlogu](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/enforcement-claims.webp)

3. Izberite sredstva izvršbe. **Denarna sredstva na računih** so na voljo za vse, račune pa sodišče poišče samo. **Plača in drugi stalni prejemki** so na voljo za fizične osebe in samostojne podjetnike.

   ![Obresti, stroški izterjave in sredstva izvršbe](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/enforcement-options.webp)

4. Če kaj manjka, na primer hišna številka, matična številka ali vaš IBAN, stran to navede s povezavo, kjer podatek uredite.
5. Pritisnite **Ustvari predlog** in nato **Prenesi datoteko za e-Sodstvo**.

   ![Povzetek s sodno takso](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/enforcement-summary.webp)

   ![Predlog z datoteko in koraki za vložitev](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/enforcement-proposal.webp)

Vložitev:

1. Prijavite se na [esodisce.si](https://esodisce.si) s SI-PASS in odprite eIzvršba. Ob prvi prijavi se vključite v varnostno shemo sodstva kot samostojni uporabnik.
2. Začnite predlog za izvršbo na podlagi verodostojne listine in uvozite datoteko. Pred oddajo preverite vsa polja. Portal sprejme največ 10 predlogov na uro.
3. V 8 dneh plačajte sodno takso s sklicem, ki ga prikaže portal. Taksa znaša 55 EUR, za elektronski predlog je znižana za 20 % na 44 EUR (tarifna številka 4011 in 33.a člen ZST-1). Predlog je vložen šele, ko je taksa plačana. Predlog tudi zahteva, da sodišče dolžniku naloži povrnitev takse z zamudnimi obrestmi.
4. V RabbitPay pritisnite **Označi kot vloženo** in vpišite opravilno številko, na primer VL 12345/2026.

   ![Vpis opravilne številke](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/enforcement-filing.webp)

Sodišče izda sklep o izvršbi brez zaslišanja dolžnika, ta pa ima nato 8 dni za ugovor. Če portal datoteke ne sprejme, podatke s strani predloga vpišite v njegov spletni obrazec. Vsi predlogi so navedeni na strani **Opomini**.

![Predlogi za izvršbo na strani Opomini](https://cdn.rabbitpay.net/help/sl/dark/invoices/dunning/enforcement-list.webp)

Izvršba prek portala zahteva slovenski projekt, opomin v EUR in stranko z naslovom v Sloveniji.
