# Invoices and documents

## Invoice numbers

An invoice number must be sequential, not merely unique. EU Directive 2006/112/EC
Article 226(2) says so and the Slovenian ZDDV-1 repeats it, so numbers are drawn
from a per project series rather than generated at random.

Each project picks its own format under Settings, Document numbers:

| Code          | Becomes                                     |
| ------------- | ------------------------------------------- |
| `YYYY` / `YY` | the year, 2026 or 26                        |
| `MM`          | the month, 01 to 12                         |
| `DD`          | the day, 01 to 31                           |
| `X`           | one digit of the counter, `XXX` gives `001` |

Anything else (letters, digits, `/ - . _ #`) is printed as written. Text in
double quotes is printed as written too, which is how the letters Y, M, D and X
get into a number: `"ORDER"-YYXXXXXX` gives `ORDER-26000001`. The default is
`YYMMDDXXXXXX`, so `260916000001` is the first invoice of 16 September 2026.
`XXX/YY` gives `001/26`, and `INV-YYYY-XXXX` gives `INV-2026-0001`.

The smallest date part decides when the counter starts again at 1: every day with
`DD`, every month with `MM`, every year with only a year, and never without any
date. A format must contain one group of 1 to 9 `X`, a day needs a month, and a
month needs a year, so a number can never repeat. The settings page shows the next
number as it will be printed, how many invoices fit in a period, and why a format
is refused.

Continuing an existing series. The next number can be set for the current
period, for example 42 for a client who already issued 41 invoices this year. A
number that is already taken is skipped rather than reused.

```bash
curl -X PUT localhost:8085/api/v1/projects/$PROJECT/invoice-numbering \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"format":"XXX/YY","next_number":42}'
```

`GET /api/v1/projects/:uuid/invoice-numbering?format=...` previews a format
without saving it. An invalid format or next number returns `1106` with the
reason.

Three series use the same formats and each has its own counter:

| Series              | `series`   | Default            | Example          |
| ------------------- | ---------- | ------------------ | ---------------- |
| Invoices            | `invoice`  | `YYMMDDXXXXXX`     | `260916000001`   |
| Pro forma invoices  | `proforma` | `PR-YYYY-XXXXX`    | `PR-2026-00001`  |
| Online store orders | `order`    | `"ORDER"-YYXXXXXX` | `ORDER-26000001` |

Pass `series` to both calls to read or change the other two. A format that
could produce the same number as another series, or as credit notes, is
refused with `1106`, so an order or pro forma number can never take the place
of an invoice number. The answer also says with `bank_reference` whether the
numbers are short enough for an RF payment reference, which bank transfers
use when they can.

A number is taken when the invoice is issued, not when a draft is made. A
draft carries a placeholder such as `DRAFT-8KQ2LM4P` and takes its real number the
moment it is opened, so deleting a draft leaves no gap in the series. When a
period is full, issuing is refused with `1107` rather than wrapping around.

Credit notes use the same format with `CN` in front and their own counter.

The date comes from the project's accounting timezone, which defaults to
`Europe/Ljubljana`. This keeps the year, month and day correct around midnight
and daylight saving changes even when the server runs elsewhere. The timezone
cannot be changed after an issued invoice or expense exists because that would
reinterpret existing accounting dates. Each project counts separately, and the
counter lives in `invoice_sequences`, read and advanced inside the same
transaction that writes the invoice, so two invoices issued at the same moment
cannot take the same number.

## Pro forma invoices

A pro forma invoice (predračun) asks the customer to pay before you invoice.
Create one from the New invoice page, or turn a draft into one with Create pro
forma invoice. It gets the next number from the pro forma series, and its PDF is
titled Pro forma invoice, shows Valid until instead of a due date, and says that
it is not an invoice. It carries the bank details with a UPN or EPC QR code and
an RF reference built from its number, and a link to the payment page where the
customer can pay online. Email it from the invoice page: the PDF is attached and
the email has its own design under Settings, Emails. Customers also see open pro
forma invoices in the customer portal.

A pro forma invoice is not an invoice. Its number is not reported to FURS, it is
not in the VAT records, reports or e-SLOG exports, and it can be edited until the
first payment. It cannot be deleted, only canceled, so its number stays taken.
Issue invoice now turns it into an invoice without waiting for a payment.

What happens when it is paid is chosen per pro forma invoice, with a default
under Settings, Document numbers, and can be changed until the first payment:

- **Issue the invoice right away.** The first settled payment issues the pro
  forma invoice as an invoice with the next invoice number, the payment date as
  supply date, and FURS verification when the payment needs it. The customer
  receives the invoice. Use this when the goods or service are delivered on
  payment.
- **Issue an advance invoice for every payment.** Each settled payment becomes a
  račun za predplačilo for exactly the amount received, split over the VAT rates
  of the pro forma invoice. The payment moves to the advance invoice, which is
  verified with FURS when needed, exported to e-SLOG as a prepayment invoice
  (document type 386), and emailed to the customer. The pro forma invoice shows
  what was paid in advance and stays payable for the rest. When you deliver,
  Issue final invoice turns it into the final invoice: every advance invoice is
  deducted as a negative line per VAT rate, so the final invoice charges only
  what is left, often nothing. Crediting an advance invoice lowers what the pro
  forma invoice counts as paid, and a pro forma invoice with advance invoices
  cannot be canceled until they are credited.

Recording a payment by hand issues the invoice or advance invoice straight
away. Card, PayPal and crypto payments do so within moments of settling, and a
document that cannot be issued yet, for example because company details are
missing, is retried in the background.

## Supply date

Article 226(7) asks for the date the goods or service were supplied when it
differs from the invoice date. `supply_date` is an optional millisecond timestamp
on create and edit, it appears on the printed invoice as Supplied, and it is
left out entirely when unset. The dashboard turns date inputs into the start of
that calendar day in the project's accounting timezone. Issue, supply and due
dates are rendered in that timezone on archived invoices and customer pages.

## Document language

A shop whose customers are all in one country should not send them invoices in
English. Under Settings, Invoice picks the language, and it is used for the
printed invoice and for the page a customer pays from.

| Language    | Code |
| ----------- | ---- |
| English     | `en` |
| Slovenščina | `sl` |

It is set through `PATCH /api/v1/projects/:uuid` as `language`, and anything else
is refused with `1062 INVALID_LANGUAGE`. A new project starts in English.

Brand names are left alone, so `IBAN`, `BIC`, `UPN QR` and `GiroCode` read the
same in every language, while the accounting terms around them are translated
properly: a Slovenian invoice is headed `Račun` and carries `ID za DDV`,
`Matična številka`, `Osnova`, `Skupaj brez DDV` and `Sklic`.

Adding a language to a document means adding one block to
[`server/i18n.ts`](../server/i18n.ts), and a test fails if any key is left
untranslated.

## Interface language

The dashboard speaks English and Slovenian, chosen with the switcher in the
header, beside your email. The login and invitation pages carry the same
switcher, since there is no header before you sign in.

This is a separate choice from the project's document language above. The
document language decides what a customer reads on an invoice or the payment
page. The interface language decides what the person working in the dashboard
reads, so an accountant can work in Slovenian on a project that invoices in
English.

The choice is kept in `localStorage`, so it survives a reload and applies to
every project that browser opens. A new visitor gets the language their browser
asks for, if this server has it, and English otherwise. The terminal inherits
whatever was chosen in the dashboard.

Interface strings live in [`web/src/i18n`](../web/src/i18n), one file per language
beside a `dictionary.ts` that holds the lookup itself. English defines the keys,
so a missing or misspelled key in a view is a compile error rather than a
mystery at runtime, and Slovenian is typed against that same list.
[`tests/interface-i18n.test.ts`](../tests/interface-i18n.test.ts) fails when the two
files drift apart, when a placeholder such as `{amount}` is dropped in
translation, or when a counted string is missing one of the four Slovenian plural
forms.

Counted strings are declined properly. Slovenian needs four forms where
English needs two, so `1 dan`, `2 dneva`, `3 dni` and `7 dni` all come out
right through `Intl.PluralRules`. Where agreement would get ugly, the wording is
turned around instead, so a count reads `Zapadlo: 3` rather than a sentence that
has to guess a case.

Brand and format names are left alone in the interface too, so `IBAN`, `SKU`,
`Bitcoin`, `SMTP`, `API` and `webhook` read the same either way.

The Admin panel stays in English. It is for whoever runs the server rather than
for the people selling through it, and its setting labels come from the server's
own schema.

## Date and time format

An invoice is a legal record, so how its dates read should be decided by whoever
issues it, not by whoever opens it. Under Settings, Invoice sets the format
once per project and it is used on printed invoices, on the payment page and
through the dashboard.

| Setting       | Values                                                                       |
| ------------- | ---------------------------------------------------------------------------- |
| `date_format` | `d. m. yyyy`, `dd.mm.yyyy`, `dd/mm/yyyy`, `mm/dd/yyyy`, `yyyy-mm-dd`, `auto` |
| `time_format` | `24`, `12`, `auto`                                                           |

Both are set through `PATCH /api/v1/projects/:uuid` and anything else is refused
with `1060 INVALID_DATE_FORMAT`. `auto` keeps the old behaviour, each reader's own
device format, which is fine in the dashboard and wrong on a document you send
somebody. The default for a new project is `auto` for dates and a 24 hour clock,
and existing projects were left on `auto` rather than being switched under you.

Formats are written out rather than derived from a locale, so `d. m. yyyy` is
always `16. 9. 2026` and never varies with the browser's language.

## Printing an invoice

Open an invoice and press Print, which opens `/projects/<uuid>/invoices/<invoice>/print`,
a plain document with no dashboard around it. It carries both parties with their
tax numbers, the lines, a tax breakdown per rate, the totals, your footer note
and, when bank transfer is switched on, the account details with a scannable
payment code.

No URL is printed on the invoice. A link is no use to somebody holding paper,
so the way to the payment page is a QR code beside the bank one, and an invoice
that cannot be paid, a draft or one already settled, gets neither.

The tab is titled `Invoice 260916000002`, so a browser asked to save the page as a
PDF names the file after the invoice rather than after this software.

If a URL, a timestamp or the word RabbitPay appears at the very edge of the
paper, that is your browser, not the invoice. Browsers can print their own
header and footer carrying the page title, the date, the address and the page
number, drawn outside the page in a margin no stylesheet can reach. Untick
Headers and footers in the print dialog (Chrome puts it under More settings)
and they are gone.

| Method | Path                                                | Permission     |
| ------ | --------------------------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/invoices/:invoice/document` | `invoice.view` |

The endpoint returns the whole document as data, so the page is one request and
the same shape can feed a PDF service later.

## Downloading invoices in bulk

Download PDFs on the invoice list packs the PDFs of issued invoices into one ZIP
file, for bookkeeping done outside RabbitPay. Choose either the dates the
invoices were issued on, with shortcuts for the previous month, quarter and
year, or the first and the last invoice number. The dialog shows how many
invoices the choice holds before anything is downloaded.

Drafts, pro forma invoices and order confirmations are left out. Canceled
invoices are included, since their numbers were used. A range of numbers holds
both invoices and every invoice issued between them, in either order. Each file
is the archived PDF, the same bytes a single download returns. One ZIP holds up
to 1000 invoices, and a larger choice is refused with error `1290` so nothing is
left out silently.

| Method | Path                                        | Permission     |
| ------ | ------------------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/invoice-export`     | `invoice.view` |
| `GET`  | `/api/v1/projects/:uuid/invoice-export/zip` | `invoice.view` |

Both take either `from` and `to` as `YYYY-MM-DD` dates in the project timezone,
or `first` and `last` as invoice numbers. The first returns `count`, `limit` and
the `first` and `last` invoice of the selection, the second returns the ZIP.

## Emails

Every email a project sends is listed under Emails: invoices, pro forma
invoices, reminders, credit notes, receipts, license keys, store order updates,
ticket and absence notices, team invitations and FURS alerts. Each row shows
when it was sent, to whom, the document it belongs to and whether it was
delivered, is still waiting or failed. The reason of a failure is shown with it.

The list can be searched by recipient, subject or invoice number and narrowed
by status, kind of email and period. Above the list are the totals of the
current selection: how many emails were sent, failed and are waiting, and how
many there were of each kind. A recurring invoice links to the emails of the
invoices it created.

Opening an email shows its content and whether it went through the email server
of this RabbitPay server or the project's own one. An email that failed can be
sent again from there. It keeps its place in the history instead of adding a new
row, and its PDF is attached again.

On rabbitpay.net the list also shows how many emails are left this month. See
[Licensing](administration.md#licensing) for what counts.

The content of delivered and failed emails is kept for 90 days and then
removed. The record of what was sent to whom stays. The server administrator
changes the period under Email, Keep email content, where 0 keeps it forever.

| Method | Path                                          | Permission     |
| ------ | --------------------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/emails`               | `email.view`   |
| `GET`  | `/api/v1/projects/:uuid/emails/:email`        | `email.view`   |
| `POST` | `/api/v1/projects/:uuid/emails/:email/resend` | `invoice.send` |

The list takes `search`, `status` (`pending`, `sent`, `failed`), `kind`,
`invoice`, `recurring`, `from` and `to` (timestamps in milliseconds), `limit`
and `offset`. It answers with `emails`, `total`, `counts` per status and `kinds`
with the counts of each kind of email. Owners, admins, managers, accountants and
viewers have `email.view`.

## Digital products and license keys

An item in the catalogue can carry a list of license keys, and then selling it
sells a key. Open Items, press Keys on an item and paste the keys in, one
per line. Pasting keys marks the item as a keys product, and the item form has
the same switch under Sells license keys.

The list is the stock. Blank lines are dropped, keys are trimmed, and a key
already on that item is reported as a duplicate rather than stored twice, so a
list can be pasted again after adding a few lines to it.

Every unit sold takes one key, oldest first. A key moves through three
states:

| State       | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `available` | In stock, not promised to anybody.               |
| `reserved`  | Held for an issued invoice that is not paid yet. |
| `delivered` | Sent to the customer, and never given out again. |

A key is held the moment the invoice is issued, whether that is a new open
invoice, a draft being opened, a terminal sale or an invoice raised through an
API key. Drafts hold nothing, since a draft may never be issued. Issuing is
refused with `1108` (HTTP 409) when the keys would run out, so the shop cannot
sell what it does not have, and two invoices for the last key cannot both be
issued. Cancelling an invoice puts its held keys back in stock.

When the invoice is paid in full, the keys are handed over: they are marked
delivered and emailed to the customer's address. The email lists the keys under
each item name and links to the invoice. Delivery is driven from the payment
ledger, so it happens whichever way the money arrived, and it is idempotent, so a
key is emailed once no matter how many times a payment is recorded or retried. A
background task sweeps up anything the payment itself could not finish.

A sale with no customer, which is what the terminal takes, has no address to send
to. Those keys are still handed over: they show on the payment page the receipt QR
code points at, they are listed on the sale in the dashboard, and emailing the
receipt sends the keys with it.

The payment page shows the keys once the invoice is paid, with a copy button for
each, and says they are on their way in the moment between the payment landing and
the keys being handed over. The invoice page in the dashboard shows which key went
to which address, and Email keys again resends them.

| Method   | Path                                                  | Permission     |
| -------- | ----------------------------------------------------- | -------------- |
| `GET`    | `/api/v1/projects/:uuid/items/:item/keys`             | `item.edit`    |
| `POST`   | `/api/v1/projects/:uuid/items/:item/keys`             | `item.edit`    |
| `DELETE` | `/api/v1/projects/:uuid/items/:item/keys/:key`        | `item.edit`    |
| `GET`    | `/api/v1/projects/:uuid/invoices/:invoice/keys`       | `invoice.view` |
| `POST`   | `/api/v1/projects/:uuid/invoices/:invoice/keys/email` | `invoice.send` |

```bash
curl -X POST localhost:8085/api/v1/projects/$PROJECT/items/$ITEM/keys \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"keys":"ABCD-1234-EFGH\nIJKL-5678-MNOP"}'
```

```json
{ "added": 2, "duplicates": 0, "stock": { "available": 2, "reserved": 0, "delivered": 0, "total": 2 } }
```

Reading the keys of an item needs `item.edit`, so an owner, admin or manager. The
stock counts ride along on the item itself for anybody who may see items, which
is what a cashier needs and all they get. Only an unsold key can be removed, and
`1111` says so when one is held or already sent.

> Not covered yet: generating keys rather than pasting them, and a per key expiry
> date. A refunded key stays delivered, because it has already left the building,
> so a returned sale needs a fresh key pasted in if the old one cannot be trusted.
