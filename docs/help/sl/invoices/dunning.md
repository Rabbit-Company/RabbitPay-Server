# Opomini

Opomin je uradni poziv k plačilu, ki navede, koliko vam stranka še dolguje.

Prikaže vse zapadle dokumente ene stranke, skupni odprti znesek in kako ga plačati. RabbitPay ga pripravi kot PDF v obliki vaših računov, z UPN QR kodo ali podatki za nakazilo, in ga lahko pošlje po e-pošti.

Samodejni opomniki po e-pošti ostanejo, kot so. Opomin uporabite, ko jih stranka prezre ali dolguje več mesecev.

## Kdo zamuja

V meniju pod Prodaja odprite **Opomini**. Stran prikaže:

- skupni zapadli znesek in število strank z dolgom
- **Stranke z zapadlimi računi**, najstarejši dolg najprej, z zadnjim opominom, ki ga je stranka prejela
- **Izdane opomine** z datumom, rokom plačila in podatkom, ali je bil opomin poslan

## Pripravite opomin

1. Pri stranki pritisnite **Pošlji opomin** ali pa **Nov opomin** in izberite stranko. Začnete lahko tudi na strani stranke ali v meniju **Pošlji** zapadlega računa.
2. Pod **Neplačani dokumenti** pustite označene dokumente, ki naj bodo na opominu. Vsi zapadli računi so označeni. Računi, ki še niso zapadli, niso vključeni.
3. Izberite stopnjo:
   - **Opomin** je prijazen in omeni, da je plačilo morda spregledano.
   - **Drugi opomin** se sklicuje na prejšnji opomin.
   - **Zadnji opomin** opozori, da bo terjatev predana v izterjavo oziroma izvršbo.

   RabbitPay predlaga naslednjo stopnjo glede na zadnji opomin stranke.

4. Nastavite **Rok plačila (dni)**. Običajno je 8 dni.
5. Po želji dodajte zamudne obresti ali nadomestilo stroškov, glejte spodaj.
6. Preverite **Povzetek** in pritisnite **Predogled PDF**.
7. Pritisnite **Izdaj opomin**. Dobi naslednjo številko, na primer OP-2026-0001, in RabbitPay ponudi, da ga takoj pošljete.

## Računi iz časa pred RabbitPay

Pritisnite **Dodaj račun, izdan izven RabbitPay** in vpišite številko računa, datuma, znesek računa in koliko je še odprto. Ti računi so samo na opominu. Ne spremenijo knjig, evidenc DDV ali statistike.

Ko pripravite naslednji opomin za isto stranko, jih gumb **Ponovno dodaj ... iz zadnjega opomina** prenese, zato odstranite le plačane.

Računi, ki ste jih v Računovodstvu vnesli pod **Izdani drugje**, se prikažejo samodejno, če se ID za DDV ali naziv kupca ujema s stranko.

## Zamudne obresti

Pri slovenskih projektih lahko vklopite **Dodaj zakonske zamudne obresti**. RabbitPay jih izračuna za vsak dokument:

- od prvega dne po zapadlosti do datuma opomina
- po linearni metodi
- po predpisani obrestni meri zamudnih obresti za vsako polletje (obrestna mera ECB, povečana za 8 odstotnih točk, ZPOMZO-1), od 1. 7. 2026 10,40 %
- nikoli več od odprtega zneska (376. člen Obligacijskega zakonika)

Opomin navede uporabljene obrestne mere in da zamudne obresti niso predmet DDV. Obresti so izračunane od zneska, ki je odprt danes. Če je stranka del računa plačala z zamudo, so dejanske obresti nekoliko višje, zato opomin nikoli ne zahteva preveč.

Brez vklopa opomin navede, da si pridržujete pravico do obračuna zamudnih obresti.

## Nadomestilo izterjatvenih stroškov

Med podjetji lahko za vsak zamujeni račun zahtevate 40 EUR (14. člen ZPreZP-1, v drugih državah EU Direktiva 2011/7/EU). Vklopite **Dodaj nadomestilo izterjatvenih stroškov**. Na voljo je samo za poslovne stranke, za opomine v EUR in za račune, ki so zapadli pred manj kot 3 leti.

## Stari dolgovi

Dokumenti, ki so zapadli pred več kot 3 leti, dobijo opozorilo. Terjatve med podjetji običajno zastarajo v 3 letih. Opomin zastaranja ne pretrga, pretrga ga le pisno priznanje dolga ali sodni postopek. Opomin lahko vseeno pošljete, stranka lahko dolg še vedno plača.

## Po opominu

Odprite opomin in preverite, koliko je še odprto na posameznem računu. Stanje se spremeni v **Delno plačano** ali **Plačano**, ko prispejo plačila. V meniju **Več** lahko pripravite naslednji opomin ali opomin izbrišete. Brisanje ne odstrani že poslanih e-sporočil.
