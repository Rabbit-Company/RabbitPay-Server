# e-Invoices (e-SLOG)

Every issued invoice and credit note can be downloaded as an e-SLOG 2.0 e-invoice, the format Slovenian companies and the public sector read automatically.

RabbitPay creates the file and hands it over by download, by email or in the customer portal. It does not submit it to an e-invoice network for you.

## Download the e-invoice

1. Open the invoice.
2. Open **Documents** and choose **Download e-SLOG**.

   ![Download e-SLOG in the Documents menu](https://cdn.rabbitpay.net/help/en/dark/slovenia/e-invoices/download.webp)

The customer needs a name, a country and a VAT ID or tax number. If something is missing, RabbitPay says what.

The first file is stored and every later download returns exactly the same file, because the e-invoice is the original that you must keep unchanged for 10 years. The stored versions are listed on the invoice.

![The stored e-SLOG version on the invoice](https://cdn.rabbitpay.net/help/en/dark/slovenia/e-invoices/versions.webp)

## Email it with the invoice

When you send an invoice by email, switch on **Attach the e-invoice (e-SLOG XML)**.

![The e-invoice attached to the invoice email](https://cdn.rabbitpay.net/help/en/dark/slovenia/e-invoices/attach.webp)

To attach it to every invoice, reminder and credit note email, open **Settings** > **Email** and switch on **Attach the e-invoice (e-SLOG XML) to invoice, reminder and credit note emails**.

## Invoices to the public sector

Ministries, municipalities, schools and other public sector buyers accept e-invoices only through UJP. Upload the file to UJPnet, or send it through your bank or another provider.

They also require two things on the e-invoice.

**The number of their order or contract.** On the invoice form, open **Reference document** and enter it.

![The order number under Reference document](https://cdn.rabbitpay.net/help/en/dark/slovenia/e-invoices/reference.webp)

You can still correct the reference document after the invoice is issued. A new e-SLOG version is stored and the old one is kept.

**Their registration number and the bank account they receive e-invoices on.** Open the customer, press **Edit** and fill in **e-Invoice details**. When you pick a Slovenian company from the register, the registration number is filled in for you.

![The e-invoice details of a customer](https://cdn.rabbitpay.net/help/en/dark/slovenia/e-invoices/customer.webp)

## Sign your e-invoices

A signed e-invoice proves it came from you and was not changed. To sign every e-SLOG file:

1. Open **Settings** and find **e-Invoice signing**.
2. Choose your qualified certificate, for example from SIGEN-CA, POSTArCA or Halcom, and enter its password.
3. Press **Upload certificate**.

![e-Invoice signing before a certificate is uploaded](https://cdn.rabbitpay.net/help/en/dark/slovenia/e-invoices/signing.webp)

This certificate is separate from the one for [fiscal verification](slovenia/fiscal-verification). Without it, e-SLOG files are downloaded unsigned.
