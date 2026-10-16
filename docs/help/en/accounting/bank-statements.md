# Bank statements

Import the statement from online banking, match payments to invoices and expenses and book everything else to an account.

## Import a statement

1. In online banking, download the statement in the ISO 20022 **camt.053** XML format.
2. Open **Accounting** > **Bank** and press **Import statement**.
3. Choose the file. RabbitPay shows the account, period, balances and how many lines are new.
4. Press **Import**.

![A statement ready to import](https://cdn.rabbitpay.net/help/en/dark/accounting/bank-statements/import.webp)

Lines that were already imported are skipped, so it is safe to import overlapping statements.

## Match the lines

Each new line shows the documents it probably pays, found by the reference, the amount and the name. A highlighted suggestion matches exactly.

![Statement lines with suggested matches](https://cdn.rabbitpay.net/help/en/dark/accounting/bank-statements/lines.webp)

- Press a suggestion to match the line to that invoice, invoice issued elsewhere or expense.
- Press **Match exact** at the top to match every line whose reference and amount match exactly, all at once.

Matching a customer invoice records the payment on the invoice, so it shows as paid everywhere in RabbitPay.

![After matching, only the bank charge is left](https://cdn.rabbitpay.net/help/en/dark/accounting/bank-statements/matched.webp)

## One payment for several documents

When a customer pays several invoices at once, or pays an invoice less a credit note, press **Match several** on the line. Select every document the payment settles. The difference must be zero before you can match.

Customer invoices can be paid in part, other documents only in full. A document in another currency is matched on its own, and the difference to its booked value is posted as an exchange difference.

## Book the rest to an account

Bank charges, loan payments, taxes and transfers have no document. Press **Book to account** and choose the account, for example **4150** for bank charges.

![Booking a bank charge](https://cdn.rabbitpay.net/help/en/dark/accounting/bank-statements/book.webp)

Press **Ignore** for a line that should not be posted at all.

## Check the balance

The statements table compares the closing balance of each statement with the **Ledger balance** of that bank account. When every line is matched or booked, the two are equal and **Open lines** shows 0.

![Every line matched or booked](https://cdn.rabbitpay.net/help/en/dark/accounting/bank-statements/all-lines.webp)

Choose **All** under **Show** to see every line with how it was settled. **Reopen** undoes a match, a booking or an ignored line. A match to a customer invoice cannot be reopened, because it recorded a payment on the invoice.
