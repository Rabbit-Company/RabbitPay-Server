# Accountant package

Send your accountant everything for a month in one go: invoices, received invoices, bank lines, open items, DDV-O and all originals, by hand or automatically.

## What the package contains

The package is one ZIP file:

- **Overview PDF**. The first page has totals for each list, the position on the last day of the period, the DDV-O summary and what still needs checking. The pages after it list issued invoices, credit notes, received invoices from domestic suppliers, received invoices from foreign suppliers, receipts paid by card or cash, bank statement lines for each account, and open customer receivables and supplier payables.
- **CSV folder**. The same lists as CSV files for import into your accountant's software, together with the DDV-O fields.
- **Issued invoices and credit notes** as PDF, with the e-SLOG XML where it was created.
- **Received invoices** with the original you attached to each expense, sorted into domestic, foreign, and card and cash.

The DDV-O summary appears for Slovenian VAT registered companies when the period is a full month or quarter. It is calculated from the same KIR and KPR records FURS uses to prefill the DDV-O return.

## Prepare the package

1. Open **Statistics**. **Accountant package** is at the top.
2. Choose the **Period**, usually **Previous month**.
3. Read the cards and the **To check before sending** box.

![The accountant package for this month](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/accountant-package/summary.webp)

The box lists what your accountant would otherwise ask you about: an expense without its original document, an invoice in a foreign currency without an exchange rate, overdue supplier invoices that are still unpaid, and bank statement lines that are not matched to a document. Fix what you can, then send.

**Overview PDF** downloads only the overview. **Download package** downloads the whole ZIP file, which you can send to your accountant any way you like.

## Send it to your accountant

1. Press **Sending** next to the title.
2. Enter your accountant's address under **Accountant email addresses**. Separate several addresses with commas, up to five.
3. Press **Save changes**.

   ![Your accountant's address and the day for automatic sending](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/accountant-package/settings.webp)

4. Press **Send to accountant** and confirm.

   ![Confirming who receives the package](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/accountant-package/confirm.webp)

After sending, **Sent to your accountant** shows when the package went out and to whom. **Send again** sends the whole package once more.

## Send it automatically every month

Under **Sending**, choose a day in **Send automatically**, for example **On day 5 of each month**. On that day RabbitPay sends the previous month. The line under the buttons shows the date of the next automatic package.

If you turn this on after this month's day has passed, the first automatic package goes out next month, in case you already sent this one yourself. Choose **No, only manually** to stop automatic sending.

## When something changes after sending

A late receipt or a corrected invoice does not mean sending everything again. RabbitPay remembers every document it sent. When a document in a period that was already sent is added, edited or removed, **Changed since** lists it.

![Documents changed after the package was sent](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/accountant-package/changes.webp)

**Send changes** sends a package with only the new and changed documents. Its overview is still complete, marked as changes, and lists every change on the first page. A payment you record later does not count as a change, because your accountant books payments from the bank statement.

With automatic sending on, changes to months sent in the last year go out on the same day as the monthly package.

## What your accountant receives

Your accountant gets an email with the overview PDF attached and a button that downloads the ZIP file. No RabbitPay account is needed. The link works for 60 days and always contains the current version of the documents.

To let your accountant work in RabbitPay directly, invite them to the project with the **Accountant** role. See [Invite your team](getting-started/invite-team). They can then download the package themselves and use [Accounting](accounting).

## Card and cash receipts

For the card and cash list, tell RabbitPay how each expense was paid. When you switch on **Paid** on an expense, choose **Paid with**: **Bank transfer**, **Card** or **Cash**. Cash payments are booked through the cash register in [Accounting](accounting). See [Record an expense](expenses-and-reports/record-expense).

## Who can do what

Everyone who can export reports and see expenses can prepare, download and send the package: owners, administrators, managers and accountants.
