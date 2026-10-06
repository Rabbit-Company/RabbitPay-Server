# Expenses and reports

Record what your business spends, let recurring costs enter themselves and see income, expenses and VAT in one place.

## Record an expense

1. Open **Expenses** and press **Add expense**.
2. Enter the supplier, the supplier's invoice number, the dates and the total amount.
3. Choose a category. Pick one of the common ones or type your own.
4. Enter the VAT shown on the invoice and how much of it you can reclaim: all, none or a custom amount.
5. Mark the expense as paid and set the payment date, or leave it unpaid until you pay it.

You can attach the original supplier invoice to the expense, so the document is kept with the record.

Accountants and managers can record and edit expenses. Only owners and administrators can delete them.

## Import a supplier e-invoice

When a supplier sends you an e-invoice, you do not have to retype it.

1. Press **Import e-invoice** on the **Expenses** page and choose the XML file. e-SLOG 2.0 and UBL 2.1 (Peppol) invoices are supported.
2. RabbitPay fills in the supplier, the invoice number, the dates, the total and the VAT per rate.
3. Check the category and the VAT, then save.

The original XML is attached to the expense, because it is the legal original of the invoice. RabbitPay warns you when the invoice is addressed to another company, when you have to account for the VAT yourself, when it is in a foreign currency or when its totals do not add up. An invoice number that is already recorded is refused, so nothing is entered twice.

Many expenses at once can be brought in with **Import CSV**.

## Set up recurring expenses

Rent, subscriptions and other costs that repeat can be entered automatically.

1. Press **Add recurring expense** on the **Expenses** page.
2. Fill in the expense as usual and choose how often it repeats, every 1 to 60 weeks, months or years.
3. Optionally set an end date or a maximum number of entries.

Each entry is created as unpaid. Switch on **Mark generated expenses as paid** only for costs that are paid automatically, such as a direct debit. RabbitPay only records the expense and never sends a payment.

A schedule can be paused, resumed or canceled at any time. Changing it later does not change the entries it already created.

## Read the financial report

Open **Statistics** to see **Income and expenses** for any period, by month or by year, with expenses by category. Each currency is shown separately.

| Figure                   | What it contains                                                   |
| ------------------------ | ------------------------------------------------------------------ |
| Net revenue              | Issued invoices without tax, reduced by credit notes               |
| Expense costs            | Expenses without the VAT you can reclaim                           |
| Estimated profit or loss | Net revenue less expense costs and payment fees                    |
| Cash flow                | Payments received less refunds, payment fees and expenses you paid |

These are estimates from the records you entered. They do not include accounting adjustments such as depreciation, so use them to follow the business and leave the annual accounts to your accountant.

## Generate and export reports

The financial report, the **VAT report** and **Item sales** are calculated when you press **Generate report**. Opening **Statistics** shows the last saved result, with the date and time it was made.

Changing the period or other filters only affects the next report you generate. After generating, a short wait applies before the same report can be generated again, and everyone in the project shares the saved result.

**Download CSV** exports the report that is on screen.
