# Import from CSV

Bring in many expenses at once from a spreadsheet, for example when you move to RabbitPay from another program.

## Prepare the file

1. On **Expenses**, press **Import CSV**.
2. Press **Download template** to get a file with the right columns.

   ![The Import CSV window](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/import-csv/dialog.webp)

3. Fill it in with one row per VAT rate of a supplier invoice. Save it as CSV.

| Column                                              | What to enter                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `supplier`                                          | Who issued the invoice. Required.                                  |
| `invoice_number`                                    | The supplier's invoice number. Required.                           |
| `issue_date`                                        | The date on the invoice. Required.                                 |
| `net_amount`                                        | The amount without VAT, for example `42.00`. Required.             |
| `vat_rate`                                          | The VAT rate of this row, for example `23`                         |
| `vat_amount`                                        | The VAT of this row                                                |
| `deductible_vat`                                    | How much of the VAT you reclaim. Leave empty to reclaim all of it. |
| `category`                                          | The category, for example `Travel`                                 |
| `description`                                       | What it was for                                                    |
| `supplier_country`                                  | The two letter country code, for example `IE`                      |
| `currency`                                          | Leave empty for the project currency                               |
| `paid_date`                                         | The day you paid it. Leave empty for an unpaid invoice.            |
| `due_date`, `receipt_date`, `expense_date`, `notes` | Optional                                                           |

Rows with the same supplier and invoice number are joined into one expense, so an invoice with two VAT rates takes two rows.

## Check and import

1. Choose the file under **CSV file**.
2. Read the result. **Documents ready to import** lists every expense that will be created. **Rows to fix before importing** lists what is wrong, by row number.

   ![Two expenses ready to import](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/import-csv/preview.webp)

3. Fix any rows the window lists, choose the file again, and press **Import**.

Nothing is imported until every row is correct, so a file is never half imported. An invoice number that is already recorded for the same supplier is refused, so importing the same file twice does not create duplicates.

![The imported expenses in the list](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/import-csv/imported.webp)
