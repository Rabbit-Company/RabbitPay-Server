# Invoices

Create an invoice, send it to your customer, record the payment and correct it when something changes. Every step below starts in your project under **Invoices**.

## Create an invoice

1. Open **Invoices** and press **New invoice**.
2. Choose the customer. Start typing a name, an email or a VAT number, or pick **Add a new customer** to create one without leaving the form.
3. Add the lines under **Line items**. Type a description or search the products and services you saved under **Items**, then fill in the quantity, the unit price and the tax rate. **Add line** adds another one.
4. Set the **Due date**. Fill in the **Supply date** only when the goods or service were delivered on a different day than the invoice date.
5. Press **Create and issue** to issue the invoice right away, or **Create draft** to save it and finish later.

**Preview** shows the invoice as your customer will see it before anything is saved.

A discount is entered once for the whole invoice and is deducted before tax. Notes you write on the form are printed on the invoice.

## Drafts and issued invoices

A draft is a work in progress. It has a placeholder such as `DRAFT-8KQ2LM4P` in place of a number, it can be edited or deleted, and your customer cannot pay it.

Open the draft and press **Issue invoice** when it is ready. The invoice then gets the next number in your series and becomes payable. Because numbers are taken only at that moment, deleting a draft never leaves a gap in your numbering.

An issued invoice can no longer be edited or deleted. To change it, [issue a credit note](#correct-or-cancel-an-invoice).

| Status         | Meaning                                           |
| -------------- | ------------------------------------------------- |
| draft          | Not issued yet. Has no number and cannot be paid. |
| open           | Issued and waiting for payment.                   |
| overdue        | Issued and past its due date.                     |
| partially paid | Some of the amount has arrived.                   |
| paid           | Paid in full.                                     |
| canceled       | Withdrawn. Its number stays used.                 |
| refunded       | The payment was returned to the customer.         |

## Send an invoice

Open the invoice and use the **Send** menu.

- **Email invoice** sends it to the customer's email address. You can add a message, attach the invoice as a PDF, attach the e-invoice (e-SLOG XML) and include a link to the payment page.
- **Send reminder** reminds the customer of the amount that is still open, with a link to pay.
- **Copy payment link** copies the address of the payment page, so you can send it through any other channel.
- **Open payment page** shows the page your customer pays from.

Every email you send is listed on the invoice and under **Emails** in the project, together with whether it was delivered.

## Print or download an invoice

Open the invoice and use the **Documents** menu.

- **Print** opens the invoice on its own page, ready for the printer.
- **Download PDF** saves it as a PDF file.
- **Download e-SLOG** saves an issued invoice as an e-invoice in the Slovenian e-SLOG format.

If a web address, a date or a page number appears at the edge of the paper, your browser added it. Untick **Headers and footers** in the print dialog to remove it.

To get many invoices at once, press **Download PDFs** on the invoice list. Choose a period under **By date** or a first and last invoice under **By invoice number**, then download them as one ZIP file. One file holds up to 1000 invoices. Drafts and pro forma invoices are left out, and canceled invoices are included because their numbers were used.

## Record a payment

Payments made by card, PayPal or crypto on the payment page are recorded for you. Record everything else, such as a bank transfer or cash, by hand.

1. Open the invoice and press **Record payment**.
2. Enter the amount and the date the money arrived. Add the bank reference and a note if you want to keep them.
3. Save. The invoice becomes **partially paid** or **paid**, depending on the amount.

To return money, find the payment at the bottom of the invoice and press **Refund**. Switch on **Issue a credit note for this refund** when the refund also lowers what you invoiced.

## Correct or cancel an invoice

An issued invoice is corrected with a credit note, never by editing it.

1. Open the invoice and press **Issue credit note** in the **Credit notes** card.
2. Choose what to credit: everything that is left, one amount spread over the lines, or chosen lines.
3. Write the reason. It is printed on the credit note.

If the whole invoice was a mistake, open **More** and choose **Cancel invoice**. The invoice stays on record, a credit note is issued for whatever was not credited yet, and your VAT report stays correct.

A draft that you no longer need is simply removed with **More** > **Delete draft**.

## Pro forma invoices

A pro forma invoice asks the customer to pay before you invoice. It has its own number series, it is not an invoice, and it is not reported to FURS or included in your VAT records.

Create one with **Create pro forma invoice** on the new invoice form, or from a draft under **More**. Send it with **Send** > **Email pro forma invoice**. It can be edited until the first payment arrives. It cannot be deleted, only canceled.

You choose what happens when it is paid:

- **Issue the invoice right away.** The first payment turns the pro forma invoice into an invoice with the next invoice number. Use this when you deliver on payment.
- **Issue an advance invoice for every payment.** Each payment gets its own advance invoice for the amount received. When you deliver, **More** > **Issue final invoice** creates the final invoice, which deducts the advance invoices.

The default is set under **Settings** > **Document numbers**, and you can change it for a single pro forma invoice with **More** > **Change what happens on payment** until its first payment.

**More** > **Issue invoice now** turns a pro forma invoice into an invoice without waiting for a payment.

## Set up invoice numbers

Invoice numbers must run in sequence without gaps. You decide how they look under **Settings** > **Document numbers**.

| Code          | Becomes                                        |
| ------------- | ---------------------------------------------- |
| `YYYY` / `YY` | The year, 2026 or 26                           |
| `MM`          | The month, 01 to 12                            |
| `DD`          | The day, 01 to 31                              |
| `X`           | One digit of the counter, so `XXX` gives `001` |

Everything else is printed as written. `XXX/YY` gives `001/26` and `INV-YYYY-XXXX` gives `INV-2026-0001`. Put text in double quotes when it contains the letters Y, M, D or X, for example `"ORDER"-YYXXXXXX`.

The counter starts again at 1 with the smallest date part in the format: every year when the format has only a year, every month with `MM`, and every day with `DD`.

If you issued invoices elsewhere this year, set **Next number** to continue the series, for example 42 after 41 invoices. The settings page shows the next number exactly as it will be printed.

Invoices, pro forma invoices and online store orders each have their own format and their own counter. Credit notes use the invoice format with `CN` in front.

## Choose the language and date format

Under **Settings** > **Invoice** you choose the language of your invoices and of the payment page, and how dates and times are written on them. This is separate from the language of the interface, which each person picks for themselves with the language switcher. You can work in Slovenian and still invoice in English.
