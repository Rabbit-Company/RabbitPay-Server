# VAT report

See the VAT you charged on your sales in a period, split the way your VAT return asks for it.

## Generate the report

1. Open **Statistics** and find **VAT report**.
2. Choose the period, for example **This month** or **Last quarter**.
3. Press **Generate report**.

## Read the report

![The VAT report for this month](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/vat-report/report.webp)

- **Net sales** is what you invoiced without VAT, with the number of invoices and credit notes.
- **VAT to your tax office** is the VAT for your own VAT return.
- **VAT through OSS** appears when you sell to consumers in other EU countries through the One-Stop Shop.

Below them the sales are grouped by rate under **Sales with your VAT**, and, when you have them, under **Sales without VAT**, **Domestic reverse charge sales by customer**, **EU sales listing** and **One-Stop Shop, by customer country**.

Amounts are in your reporting currency, after invoice discounts, by the date each invoice was issued. A credit note is taken off in the period it was issued. An invoice in another currency without an exchange rate is listed under **Left out, no exchange rate** until you set the rate on the invoice.

**Download CSV** saves the report.

## Records for the Slovenian tax office

In a project of a Slovenian VAT registered company, **Statistics** also has **Official FURS DDV evidence**. It checks the records of output VAT (KIR) and deductible VAT (KPR) document by document and creates the JSON package for eDavki. See [Slovenian compliance](slovenia).

## What the report needs

Set your country and VAT status under **Settings** > **Tax** first. Without them, RabbitPay cannot sort the lines into the right boxes. See [Set how VAT applies to you](getting-started/company-details#set-how-vat-applies-to-you).
