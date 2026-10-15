# VAT periods and other currencies

VAT is reported in euros and in the period the goods were supplied or the service was performed. This page shows how RabbitPay handles both.

## The supply date

VAT belongs to the period of the supply, not the period the invoice was written in. An invoice issued on 5 October for work done on 28 September is reported in September.

That is why the invoice form has a **Supply date**. Leave it on the invoice date when they are the same.

![The supply date on the invoice form](https://cdn.rabbitpay.net/help/en/dark/slovenia/vat-periods/supply-date.webp)

## Invoices in another currency

You can invoice in any currency, for example US dollars for a customer abroad. The VAT is still reported in euros.

When you choose another currency, the form shows a field for the rate.

![An invoice in US dollars with the rate field](https://cdn.rabbitpay.net/help/en/dark/slovenia/vat-periods/currency.webp)

- Leave it **empty** and RabbitPay uses the reference rate of the European Central Bank for the supply date.
- Enter a rate only for a currency the ECB does not publish. Use the rate of your central bank for the supply date.

The issued invoice prints the rate and the VAT in euros, and the invoice page shows them under **VAT reporting**.

![The VAT in euros and the ECB rate used](https://cdn.rabbitpay.net/help/en/dark/slovenia/vat-periods/issued.webp)

An invoice with VAT cannot be issued without a rate, and the rate cannot be changed after issuing. To correct it, credit the invoice and issue a new one.

## Invoicing a period you already submitted

After you [export the DDV evidence](slovenia/ddv-evidence) for a month, that month is locked. If you then issue an invoice whose supply date falls in it, RabbitPay stops and asks what to do.

![The question about a late VAT report](https://cdn.rabbitpay.net/help/en/dark/slovenia/vat-periods/late-dialog.webp)

Press **Issue as a late report**. The invoice is reported in the current period as a correction of the earlier one, under Article 88.b of ZDDV-1, and marked so that eDavki can work out the interest. The invoice page says so.

![The note on an invoice issued as a late report](https://cdn.rabbitpay.net/help/en/dark/slovenia/vat-periods/late-note.webp)

Press **Cancel** instead if you made a mistake in the supply date.
