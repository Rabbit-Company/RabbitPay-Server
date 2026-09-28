# Expenses and reports

## Expenses

Each project has an Expenses page for recording costs, suppliers, categories,
currencies, tax, deductible tax and payment dates. Currency and category fields
use searchable selectors. Categories offer common options and accept custom
entries. Expense permissions control
who can view, create, edit and delete records. Accountants and managers can record
and edit expenses. Owners and administrators can also delete them.

## Importing supplier e-invoices

Import e-invoice on the Expenses page reads an e-SLOG 2.0 or UBL 2.1 (Peppol BIS
Billing 3.0) invoice and opens the expense form filled in from it: the supplier
with its tax number and country, the invoice number, the issue, supply and
receipt dates, the total, the VAT lines per rate and the payment details in the
notes. Review the category and the VAT, then save. The original XML is attached
to the expense, because it is the legal original of the supplier's invoice.

| Method | Path                                             | Permission       |
| ------ | ------------------------------------------------ | ---------------- |
| `POST` | `/api/v1/projects/:uuid/expenses/import/preview` | `expense.create` |
| `POST` | `/api/v1/projects/:uuid/expenses/import`         | `expense.create` |

Both take the file as base64 in `data` with an optional `name`. The preview
returns the suggested expense, the parsed invoice and any warnings without
saving anything. The import saves the suggestion with the XML attached in one
step, for automated inboxes, and refuses a supplier invoice number that is
already recorded with error `1181`. When the suggestion needs changes, such as an
exchange rate for a foreign currency, it returns error `1112` with the
suggestion so it can go through the preview instead.

The VAT treatment follows the invoice. A domestic supplier becomes Domestic, or
Domestic reverse charge for category `AE`. An EU supplier becomes EU goods for
`K` or EU services for `AE`. Invoices without VAT, from outside the EU, or
received by a project that is not VAT registered are not reported. Deductible VAT
defaults to the full amount for VAT registered projects. Warnings point out an
invoice addressed to another company, a reverse charge to self-assess, a foreign
currency and totals that do not add up. Supplier credit notes are refused, and
any file that is not one of the two formats returns error `1180`.

Files are parsed with Bun's built-in XML parser, which never reads external
entities and stops entity expansion bombs, and are limited to 5 MB. Files in
UTF-8 or a declared encoding such as `windows-1250` are both read. Signatures on
incoming files are kept in the attachment but not verified.

## Recurring expenses

Recurring expenses create entries every 1 to 60 weeks, months or years. Set an
optional end date or maximum number of entries, pause or resume a schedule, or
cancel future entries. Entries are unpaid by default. Enable automatic paid
status only for expenses you know are paid automatically. RabbitPay records the
expense and does not initiate a payment. Missed entries are generated in batches
of up to 12 per schedule on each scheduler run. Generated entries keep their
scheduled expense date, and later template edits do not change existing entries.

## Financial reports

Statistics includes a financial report with a date range, monthly or yearly
totals, expense categories and a CSV export. Each currency is shown separately.
Financial, VAT and item sales reports have a Generate report button. Opening
Statistics displays the last saved results without calculating new reports.
Changing filters only affects the next report you generate. Each report shows
its generation date and time, its actual period and when it can be generated
again. All company users share the saved results and cooldown for each report
type. Reports and cooldowns are stored in the database and survive restarts.

Admin, Settings, Reports controls the generation cooldown in minutes. It defaults
to 10, accepts 0 to 1440 and takes effect without restarting. Setting it to 0
allows immediate regeneration. Different filters do not bypass the cooldown.
Concurrent requests for the same company and report type cannot calculate the
report twice. A failed calculation keeps the previous report and can be retried.
CSV exports use saved results and never calculate a report. Browser exports use
the displayed snapshot, so they still match the page if another user generates
new results. This reduces repeated work. Large initial report calculations
still need optimization before hosting companies with high transaction volumes.

Revenue comes from issued invoices excluding tax, reduced by credit notes.
Expense costs include the total expense less deductible tax. Estimated profit
subtracts expense costs and settled payment fees from revenue. Cash flow uses
settled payments less refunds, payment fees and expenses paid during the period.
Report periods use UTC. Estimates cover the records entered in RabbitPay and do
not include accounting adjustments such as depreciation or inventory valuation.
CSV amounts use minor currency units, such as cents for EUR.

## API

| Method | Path                                                 | Permission       |
| ------ | ---------------------------------------------------- | ---------------- |
| GET    | `/api/v1/projects/:uuid/expenses`                    | `expense.view`   |
| POST   | `/api/v1/projects/:uuid/expenses`                    | `expense.create` |
| PATCH  | `/api/v1/projects/:uuid/expenses/:expense`           | `expense.edit`   |
| DELETE | `/api/v1/projects/:uuid/expenses/:expense`           | `expense.delete` |
| GET    | `/api/v1/projects/:uuid/expense-schedules`           | `expense.view`   |
| POST   | `/api/v1/projects/:uuid/expense-schedules`           | `expense.create` |
| PATCH  | `/api/v1/projects/:uuid/expense-schedules/:schedule` | `expense.edit`   |
| GET    | `/api/v1/projects/:uuid/reports/financial`           | `report.view`    |
| POST   | `/api/v1/projects/:uuid/reports/financial`           | `report.view`    |
| GET    | `/api/v1/projects/:uuid/reports/financial/export`    | `report.export`  |
| GET    | `/api/v1/projects/:uuid/reports/vat`                 | `report.view`    |
| POST   | `/api/v1/projects/:uuid/reports/vat`                 | `report.view`    |
| GET    | `/api/v1/projects/:uuid/items/stats`                 | `report.view`    |
| POST   | `/api/v1/projects/:uuid/items/stats`                 | `report.view`    |

Expense amounts are positive integer minor currency units. Dates are Unix
milliseconds. `tax_amount` and `deductible_tax_amount` default to zero, and
`paid_at` defaults to null. Lists accept `from`, `to`, `status`, `limit` and
`offset`. Schedules use `start_date`, `interval_unit`, `interval_count`, optional
`end_date` and `max_occurrences`, and `auto_paid`. Patch a schedule with `status`
set to `paused`, `active` or `canceled`. Financial report generation accepts
`from`, `to` and `group` set to `month` or `year`, and defaults to the current
calendar year. VAT and item sales generation accept `from` and `to`.
Report GET endpoints return the latest snapshot as `data.report`, or null when
none has been generated, with `generating`, `next_generation_at` and `server_time`.
They do not calculate reports for query parameters. POST endpoints generate
reports and return their existing fields with `generated_at` and
`next_generation_at`. Generation during the cooldown returns error 1117 with
HTTP 429 and Retry-After. Generation already in progress returns error 1118
with HTTP 409. Both include the saved report state in `data`. Financial export
returns error 1119 with HTTP 409 until a report has been generated.
