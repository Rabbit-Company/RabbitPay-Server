# Invoices issued elsewhere

Bring invoices from another program or cash register into the books, the DDV records and the VAT report, with their original numbers.

## Why record them

A company that started with RabbitPay during the year, or still sells through another register, has invoices RabbitPay did not issue. Record them here so the books are complete.

RabbitPay keeps their original number and never fiscalizes, emails or renumbers them. They appear in the journal, the KIR, the VAT report, [open items](accounting/open-items) and [bank matching](accounting/bank-statements).

## Import many at once

1. Open **Accounting** > **Issued elsewhere** and press **Import CSV**.
2. Press **Download template** for a file with the right columns and an example row.
3. Fill in one row per VAT rate of a document. Rows with the same number become one invoice.
4. Choose the file. RabbitPay checks every row and lists the invoices it found.
5. Press **Import**.

![Seven invoices from last year ready to import](https://cdn.rabbitpay.net/help/en/dark/accounting/issued-elsewhere/import.webp)

Dates can be written as 2026-01-05 or 5.1.2026, and amounts as 1234.56 or 1.234,56. Column names can be in English or Slovenian.

Nothing is imported until every row is correct. If a row has a mistake, the list says which row and which column to fix. A number that is already recorded, or an issue date in a month whose DDV evidence you exported, is refused.

| Column                                          | What to enter                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| number                                          | The number printed on the invoice                                                        |
| document_type                                   | invoice or credit_note                                                                   |
| issue_date, supply_date, due_date               | The dates on the invoice                                                                 |
| buyer_name, buyer_vat_number, buyer_country     | The buyer                                                                                |
| currency, exchange_rate                         | For invoices in another currency, the rate used on the invoice                           |
| vat_rate, vat_treatment, net_amount, vat_amount | One VAT rate per row, for example 22, domestic, 200.00 and 44.00                         |
| paid_date, paid_to                              | When it was paid and whether to the bank or the cash register. Leave empty while unpaid. |

## The list

Choose the period to see the invoices recorded in it, with their buyer, VAT treatment, total and payment date.

![Invoices issued elsewhere last year](https://cdn.rabbitpay.net/help/en/dark/accounting/issued-elsewhere/list.webp)

- **Attach original** adds the PDF or image of the invoice, so it is kept with the books.
- **Edit** corrects a recorded invoice. Its postings are corrected in the journal.
- **Delete** removes it and reverses its postings.

## Record one by hand

Press **Record invoice** and copy the amounts exactly as they are on the original. Enter the amounts of a credit note as positive numbers and choose **Credit note** as the document.

![The form for one invoice](https://cdn.rabbitpay.net/help/en/dark/accounting/issued-elsewhere/new.webp)

Add a line for each VAT rate with **Add VAT rate**. **Save and add another** keeps the form open for the next invoice.
