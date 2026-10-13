# Slovenian compliance

What a Slovenian business sets up in RabbitPay: fiscal verification with FURS, e-invoices, the details the law wants on an invoice, and VAT records for eDavki.

## Tell RabbitPay your tax status

Open **Settings** > **Tax** and choose your **VAT status**. RabbitPay uses it to suggest the right VAT on each invoice, to check your customers' VAT numbers in VIES and to print the exemption note when you are not registered for VAT.

A project with Slovenia as its tax country always reports VAT in euros.

## Set up fiscal verification (FURS)

Invoices paid in cash, by card or in crypto must be verified by FURS. Bank transfers and PayPal payments are not verified. Until verification is set up, a Slovenian project cannot accept or record cash, card or crypto payments.

Open **Settings** > **Fiscal verification (FURS)** and go through the steps.

1. **Certificate**: upload the `.p12` certificate you received through eDavki and enter its password. **Test connection** checks that FURS answers.
2. **Business premises**: register the premise you sell from, either a building with its cadastral data and address or a movable premise.
3. **Devices**: choose the premise and device for invoices and online payments, optionally a separate one for the terminal, and switch on **Verify invoices with FURS**.
4. **People who issue invoices**: enter the tax number of each person who issues invoices. The fallback tax number is used for anyone without one.

Once verification is on, invoices are numbered by premise and device, for example `SPLET-1-15`. Verified invoices show the ZOI, the EOR and a QR code on screen, in the PDF and in emails.

When FURS cannot be reached, the invoice waits and is sent again automatically. **Invoices sent to FURS** shows every record and its status, and **Send again** retries a rejected one after you fix the cause. If a record is rejected or close to its legal deadline, the project owners get an email and the project overview shows a warning.

A credit note for a verified invoice is verified too, and refunding a payment on a verified invoice always issues one.

## Send e-invoices (e-SLOG)

Every issued invoice and credit note can be downloaded as an e-SLOG 2.0 e-invoice with **Documents** > **Download e-SLOG**. The customer needs a name, a country and a VAT ID or tax number.

RabbitPay creates the file and hands it over by download, by email or in the customer portal. It does not submit it to an e-invoice network. To email it, switch on **Attach the e-invoice (e-SLOG XML)** when you send the invoice, or attach it to every invoice email under **Settings** > **Email**.

**Public sector buyers** accept e-invoices only through UJP, so upload the file to UJPnet or send it through your bank or another provider. They also require:

- a **Reference document**, the number of their order or contract, which you set on the invoice form and can still correct after issuing,
- their registration number and the bank account they receive e-invoices on, which you enter on the customer under **e-Invoice details**.

To sign your e-invoices, upload a qualified certificate, for example from SIGEN-CA, POSTArCA or Halcom, under **Settings** > **e-Invoice signing**. It is separate from the FURS certificate.

The first e-SLOG file of a document is stored and every later download returns exactly that file, because the e-invoice is the original that you must keep unchanged for 10 years.

## Print the required company details

Slovenian companies state their full name, registered office, register entry and registration number on their documents. A d.o.o. and a d.d. also state the share capital.

The name, address and registration number come from **Settings** > **Company details** and are printed on every invoice. The register entry and the share capital belong in the **Invoice footer**. RabbitPay shows what is still missing, and **Add suggested text** puts the usual sentences into the footer with `___` where the court and the amount go. Replace every `___` with your own details.

## Invoice without VAT under the domestic reverse charge

For some supplies between two Slovenian VAT payers, such as construction work, the buyer accounts for the VAT under Article 76.a of ZDDV-1 and the invoice carries none.

- **On an item**: set the item's **VAT category** to **Domestic reverse charge** and keep its normal rate. When the customer is a Slovenian business with a VAT ID confirmed in VIES, the line is suggested at 0%. Other customers are charged the normal rate.
- **By hand**: on a line with 0% VAT, choose the reason under **Why no VAT is charged**.

The invoice then prints the required note. You must be registered for VAT and the customer must have a Slovenian VAT ID. Reverse charge supplies and supplies with VAT go on separate invoices.

A domestic line with VAT can only use the rates 22%, 9.5% or 5%.

## Invoices in another currency

VAT has to be reported in euros. When you issue an invoice in another currency, RabbitPay converts the VAT at the ECB reference rate for the supply date and prints the rate on the invoice.

For a currency the ECB does not quote, enter the rate yourself on the invoice form. An invoice with VAT cannot be issued without a rate, and the rate cannot be changed after issuing. To correct it, credit the invoice and issue a new one.

## The VAT period of an invoice

VAT belongs to the period in which the goods were supplied or the service was performed, not the period in which the invoice was written. An invoice issued on 5 October for a supply on 28 September is reported in September. That is why the **Supply date** on the invoice form matters.

If you issue an invoice for a period whose records you already submitted, RabbitPay stops and asks whether to issue it as a late report. Choosing **Issue as a late report** reports the invoice in the current period and marks it so that eDavki can work out the interest.

Only the ordinary VAT rules are covered. Cash accounting, the margin scheme and self-billing are not supported.

## Export VAT records for eDavki

Open **Statistics** and find **Official FURS DDV evidence**.

1. Choose the tax period.
2. Press **Validate evidence** and fix what the warnings point out.
3. Press **Create FURS export** and download the file to submit in eDavki.

Creating an export locks the period. Invoices, credit notes and expenses in a locked period can no longer be added or changed, so the records stay equal to what you submitted. Every export is kept as a revision.

If you need to correct something, an authorized person can **Unlock** the period with a reason, which is recorded. The next export locks it again.
