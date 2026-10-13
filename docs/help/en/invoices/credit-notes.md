# Credit notes and canceling

An issued invoice is never edited. You correct it with a credit note, which is a document of its own that lowers what the customer owes and corrects your VAT report.

## When to use what

| Situation                                           | What to do                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| The invoice is still a draft                        | [Edit or delete the draft](invoices/drafts#change-or-delete-a-draft)             |
| Part of an issued invoice was wrong or was returned | Issue a credit note for that part                                                |
| The whole issued invoice was a mistake              | Cancel the invoice                                                               |
| The customer paid too much                          | [Refund the payment](invoices/record-payment#return-money) without a credit note |

## Issue a credit note

1. Open the invoice and find the card **Credit notes**.
2. Press **Issue credit note**.

   ![The Credit notes card on an invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/credit-notes-card.webp)

3. Under **What to credit**, choose one of the three ways. They are explained below.
4. Enter the **Reason**. It is printed on the credit note.
5. Press **Issue credit note**.

### Everything that is left

**Everything left** credits the whole amount that has not been credited yet.

![Crediting everything that is left](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/what-to-credit.webp)

### One amount

**An amount, spread over the lines** takes one amount including VAT and spreads it over the lines in proportion. Use it for a price reduction on the whole invoice.

![Crediting one amount](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/amount.webp)

### Chosen lines

**Chosen lines** lets you enter a net amount for each line. Use it when one product was returned or one line was wrong.

![Crediting single lines](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/chosen-lines.webp)

## After the credit note

The credit note gets its own number, which is your invoice format with `CN` in front. It is listed in the **Credit notes** card, where you can **Print** it, **Download PDF**, **Download e-SLOG** or **Email** it to the customer.

![A credit note listed on its invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/credit-note-issued.webp)

The totals of the invoice now show a line **Credited**, and **Outstanding** is lower by that amount.

![The invoice after a credit note](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/invoice-after-credit.webp)

A credit note is taken off your VAT report in the period in which it is issued.

## Cancel an invoice

Use this when the whole invoice should never have been issued.

1. Open the invoice and press **More**.

   ![Cancel invoice in the More menu](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/more-menu.webp)

2. Choose **Cancel invoice** and confirm.

   ![Confirming the cancellation](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/cancel-confirm.webp)

The invoice stays on record with the status **canceled**, and its number stays used. A credit note is issued for whatever had not been credited yet, so your VAT report stays right.

![A canceled invoice with its credit note](https://cdn.rabbitpay.net/help/en/dark/invoices/credit-notes/canceled.webp)

A fully paid invoice cannot be canceled. Refund the payment first.
