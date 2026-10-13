# Plačilna stran

Vsak izdan račun ima svojo stran, na kateri kupec plača. Ne potrebuje računa ne gesla in deluje na telefonu.

## Pošljite povezavo

Povezava je v vsaki e-pošti z računom, kadar je vklopljeno **Dodaj povezavo do plačilne strani**. Če jo želite poslati sami:

1. Odprite račun in pritisnite **Pošlji**.
2. Izberite **Kopiraj povezavo za plačilo** in jo prilepite v sporočilo.

   ![Kopiraj povezavo za plačilo v meniju Pošlji](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-page/copy-link.webp)

**Odpri plačilno stran** v istem meniju vam stran pokaže.

> **Pomembno:** Stran lahko odpre vsak, ki ima povezavo. Pošljite jo samo kupcu, ki mu je namenjena. Stran ne pokaže ničesar o vaših drugih računih ali kupcih.

## Kaj stran pokaže

![Plačilna stran odprtega računa](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-page/page.webp)

Zgornja kartica pokaže ime vašega podjetja, znesek, številko računa, koliko je še za plačilo in rok plačila, z gumbom za prenos računa kot PDF.

![Povzetek na vrhu](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-page/summary.webp)

Pod njo kupec izbere, kako bo plačal. Našteti so samo načini, ki ste jih vklopili.

![Načini plačila](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-page/methods.webp)

**Postavke** naštejejo postavke računa.

Stran je napisana v jeziku vaših računov in uporablja poudarjeno barvo vašega projekta. Glejte [Oblikovanje in besedila](invoices/design).

## Na telefonu

Stran se prilagodi zaslonu telefona, zato lahko kupec plača naravnost iz e-pošte.

![Plačilna stran na telefonu](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-page/phone.webp)

## Po plačilu

Plačila s kartico, prek PayPala ali s kriptovalutami so prepoznana sama. Stran se spremeni v **Plačano**, medtem ko jo kupec še gleda.

![Stran po plačilu računa](https://cdn.rabbitpay.net/help/sl/dark/payments/payment-page/paid.webp)

Bančno nakazilo se preveri ročno, zato stran pove, da se ne bo osvežila sama. **Plačano** pokaže, ko [zabeležite plačilo](invoices/record-payment).

Osnutek nima plačilne strani. Preklicanega računa ni več mogoče plačati.

## Postavite plačilno stran na svojo spletno stran

Če imate spletno stran, lahko kupec plača, ne da bi jo zapustil. Tistega, ki vzdržuje vašo stran, prosite, naj doda ti dve vrstici z ID-jem računa:

```html
<div data-rabbitpay-invoice="INVOICE-ID" data-rabbitpay-label="Plačaj zdaj"></div>
<script src="https://rabbitpay.net/embed.js"></script>
```

To pokaže gumb, ki plačilno stran odpre v oknu nad vašo stranjo.
