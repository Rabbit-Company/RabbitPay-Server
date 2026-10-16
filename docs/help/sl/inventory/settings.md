# Izberite način vrednotenja

Odprite zavihek **Nastavitve** v **Zaloge**.

![Nastavitve vrednotenja](https://cdn.rabbitpay.net/help/sl/dark/inventory/settings/valuation.webp)

## Metoda vrednotenja

**Metoda vrednotenja** določa, kako se izračuna nabavna vrednost prodane in porabljene zaloge. SRS 4 dovoljuje obe.

- **Drseče tehtane povprečne cene** ponovno izračunajo povprečno ceno ob vsakem prevzemu.
- **FIFO (metoda zaporednih cen)** najprej izda najstarejšo nabavo.

Pred prvim premikom lahko izbirate prosto. Kasneje se metoda lahko spremeni le s 1. januarjem leta, ki ni zaključeno, ker gre za spremembo računovodske usmeritve. Prej se dogovorite z računovodjo.

## Zaloga pod ničlo

**Dovoli zalogo pod ničlo** določa, kaj se zgodi, ko prodate ali izdate več, kot kaže knjižno stanje. Če je dovoljeno, se manjkajoča količina ovrednoti po zadnji znani ceni in popravi ob prevzemu. Če ni dovoljeno, so takšni dokumenti in računi zavrnjeni.

## Skladišče za blagajno

**Blagajna prodaja iz** omogoči, da [blagajna](terminal) jemlje blago iz drugega skladišča, na primer iz prodajalne. Računi in spletna trgovina vedno jemljejo iz privzetega skladišča.

## Kako zaloga pride v glavno knjigo

Z licenco za računovodstvo se vsak dokument zaloge knjiži sam.

- Račun za nabavo zalog gre na konto obračuna nabave (650 za blago, 300 za material), prevzemnica pa vrednost prenese na zalogo (660 ali 310).
- Prodaja prenese nabavno vrednost z zaloge na nabavno vrednost prodanega blaga (702), prihodki takih artiklov pa gredo na 762 ali 763.
- Material, porabljen v podjetju, postane strošek materiala (400). Odpisi gredo na 721.
- Primanjkljaj ali višek blaga popravi 702.

Nastavitve tedaj pokažejo tudi **Primerjavo z glavno knjigo**, zato manjkajoča otvoritev ali ročna knjižba takoj izstopata.
