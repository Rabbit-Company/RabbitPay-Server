# Zabeležite plačilo

Plačila s kartico, prek PayPala ali s kriptovalutami na plačilni strani se zabeležijo sama. Vse drugo, na primer bančno nakazilo ali gotovino, zabeležite sami.

## Zabeležite plačilo

1. Odprite račun in pritisnite **Zabeleži plačilo**.

   ![Gumb Zabeleži plačilo na odprtem računu](https://cdn.rabbitpay.net/help/sl/dark/invoices/record-payment/record-button.webp)

2. Preverite znesek. Začne se s tem, kar je še odprto. Vpišite manj, če je prispel le del.
3. Pod **Način plačila** izberite, kako je denar prispel, na primer bančno nakazilo ali gotovina.
4. **Datum plačila** nastavite na dan, ko je denar prispel.
5. Dodajte bančni **Sklic** in **Opombe**, če ju želite shraniti.
6. Pritisnite **Zabeleži plačilo**.

   ![Beleženje bančnega nakazila](https://cdn.rabbitpay.net/help/sl/dark/invoices/record-payment/record-dialog.webp)

Račun postane **plačan**. Plačilo je navedeno v kartici **Plačila** na računu in pod **Plačila** v meniju projekta.

![Plačan račun s svojim plačilom](https://cdn.rabbitpay.net/help/sl/dark/invoices/record-payment/paid.webp)

Dve polji, ki ju redko potrebujete:

- **Provizija** je znesek, ki ga je ponudnik plačil zadržal zase. V poročilih se odšteje od neto zneska.
- **Stanje** je **Zaključeno** za denar, ki je prispel. **V čakanju** zabeleži plačilo, ki ga pričakujete in se za račun še ne šteje.

## Ko je plačan le del

Vpišite znesek, ki je prispel. Račun postane **delno plačan** in pokaže, koliko je plačano in koliko je še za plačilo. Preostanek zabeležite enako, ko prispe.

![Delno plačan račun](https://cdn.rabbitpay.net/help/sl/dark/invoices/record-payment/partially-paid.webp)

## Vrnite denar

1. Odprite račun in v kartici **Plačila** poiščite plačilo.
2. V njegovi vrstici pritisnite **Vrni**.
3. Preverite znesek. Vrnete lahko vse ali le del.
4. Vpišite **Razlog**.
5. Odločite se glede **Izdaj dobropis za to vračilo**:
   - Pustite vklopljeno, kadar se razveljavi sama prodaja, na primer pri vrnjenem blagu. Dobropis popravi DDV, ki ste ga poročali.
   - Izklopite, kadar vračate samo preplačilo.
6. Pritisnite **Vrni**.

   ![Vračilo plačila](https://cdn.rabbitpay.net/help/sl/dark/invoices/record-payment/refund.webp)

> **Pomembno:** RabbitPay vračilo zabeleži. Denarja ne premakne. Bančno nakazilo vrnite iz svoje banke, vračilo s kartice ali prek PayPala pa iz nadzorne plošče Stripe ali PayPal.

Pri računu, ki je bil potrjen pri FURS, se z vračilom vedno izda dobropis, da FURS prejme popravek.

## Odstranite pomotoma vneseno plačilo

Če ste zabeležili plačilo, ki ni nikoli prispelo, na primer ker je bilo bančno plačilo za starejše račune, pod **Plačila** ob njem pritisnite **Odstrani**. Vpišite kratek razlog in potrdite. Plačilo ostane na seznamu, označeno kot neuspešno, z razlogom, da je vedno vidno, kaj je bilo popravljeno. Račun spet velja za neplačan in lahko dobi opomnike. Kupec ne prejme obvestila.

**Odstrani** je na voljo le pri plačilih, ki ste jih vnesli sami. Plačilo, ustvarjeno s povezavo bančne postavke, razveljavite s **Ponovno odpri** na tej postavki, glejte [Bančni izpiski](accounting/bank-statements). Plačila prek Stripe, PayPala ali kriptovalut, vrnjena plačila ter gotovinska in kartična plačila, potrjena pri FURS, popravite z **Vrni**.
