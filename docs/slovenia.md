# Slovenian compliance

## e-SLOG 2.0 e-invoices

Issued invoices and credit notes can be downloaded as e-SLOG 2.0 XML, the
Slovenian e-invoice format built on EN 16931. Public sector buyers already require
it, and it becomes the standard for invoices between businesses in 2028. Upload
the file to the UJP e-invoice portal or hand it to your e-invoice provider. Use
Download e-SLOG on the invoice page or on a credit note row.

| Method | Path                                                          | Permission     |
| ------ | ------------------------------------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/invoices/:invoice/eslog`              | `invoice.view` |
| `GET`  | `/api/v1/projects/:uuid/credit-notes/:note/eslog`             | `invoice.view` |
| `PUT`  | `/api/v1/projects/:uuid/invoices/:invoice/reference-document` | `invoice.edit` |

The document is built from the issue snapshot, so it matches the archived PDF.
Invoices use type `380` and credit notes type `381` with a reference to the
corrected invoice. Each line carries its quantity and unit, net price, VAT and its share of
the invoice discount as a line allowance. The totals and a VAT breakdown per rate
follow, along with the bank account, payment reference and due date when the
invoice is paid by bank transfer. When fiscal verification is on, the FURS issue
time, operator, ZOI, EOR and verification code are included.

Tax treatments map to these VAT category codes:

| Treatment                         | Code | Exemption code |
| --------------------------------- | ---- | -------------- |
| Your VAT, OSS                     | `S`  |                |
| Reverse charge                    | `AE` | `VATEX-EU-AE`  |
| Intra-EU supply of goods          | `K`  | `VATEX-EU-IC`  |
| Export                            | `G`  | `VATEX-EU-G`   |
| Exempt                            | `E`  |                |
| Outside the scope, small business | `O`  | `VATEX-EU-O`   |

Every category other than `S` also carries the exemption text printed on the
invoice. Tax numbers follow the ePOS guidance. A VAT registered party is listed
with its VAT ID under both `VA` and `AHP`. Any other party is listed under `AHP`
only, and so is every party on an invoice with code `O`. The seller's
registration number is listed under `0199`.

An invoice needs a customer with a name, a country and a VAT ID or tax number, and
the seller needs a country and a VAT ID or tax number. Anything missing returns
error `1172` with an `issues` list, the same shape as error `1132`. Drafts return
error `1044` because they have no final number yet. The tests check every variant
against the official e-SLOG 2.0 schema when `xmllint` is installed.

### Public sector buyers (UJP)

The UJP portal checks more than the schema. For an invoice to a public sector
buyer it also requires:

- A reference document, the buyer's order or contract. Set it when creating the
  invoice with `reference_document_type` (`order` or `contract`),
  `reference_document_number` and an optional `reference_document_date`. It is
  written as `ON` or `CT` and printed on the PDF next to the dates.
- The buyer's registration number, written under `0199`.
- The bank account the buyer receives e-invoices on, written as `S_FII BB`. For
  public sector buyers this is their UJP sub-account with BIC `UJPLSI2DICL`.

Add the last two to the customer under e-Invoice details. The reference document
only routes the invoice and changes no amounts, so it can still be set,
corrected or cleared after the invoice is issued, from the invoice page or with
the `PUT` endpoint above. Invalid values return error `1173`. The change is
recorded in the audit log. The PDF archived at issue stays unchanged, while the
invoice page shows the new value and the next e-SLOG download is stored as a new
version, as described under [Stored e-invoices](#stored-e-invoices). For invoices issued
before a customer's registration number or bank account was recorded, the e-SLOG
download takes them from the current customer record.

### Signing

| Method   | Path                                                  | Permission     |
| -------- | ----------------------------------------------------- | -------------- |
| `GET`    | `/api/v1/projects/:uuid/einvoice/signing-certificate` | `project.view` |
| `PUT`    | `/api/v1/projects/:uuid/einvoice/signing-certificate` | `project.edit` |
| `DELETE` | `/api/v1/projects/:uuid/einvoice/signing-certificate` | `project.edit` |

Upload a qualified certificate, for example from SIGEN-CA, POSTArCA or Halcom,
under Settings, e-Invoice signing, or send the `.p12` file as base64 with its
password to the `PUT` endpoint. It is separate from the FURS certificate and is
stored encrypted with the master key. RSA and EC keys work, and an expired
certificate or a wrong password is refused with error `1176` or `1175`.

With a certificate on file, every newly stored e-SLOG file is signed with an enveloped
XAdES-BES signature that sits next to `M_INVOIC`, as the e-SLOG schema allows.
It signs the message through its `Id="data"` and the signing time and
certificate through the XAdES signed properties, using exclusive
canonicalization and SHA-256. The certificate and its chain are included. If
the certificate expires, creating a new file returns error `1176` until it is
replaced or removed, rather than carrying a signature that no longer verifies.
Files stored earlier are still returned. Without a certificate, files are stored
unsigned. The tests verify every signed variant with `xmlsec1` when it is
installed.

### Stored e-invoices

| Method | Path                                                       | Permission     |
| ------ | ---------------------------------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/invoices/:invoice/eslog/versions`  | `invoice.view` |
| `GET`  | `/api/v1/projects/:uuid/credit-notes/:note/eslog/versions` | `invoice.view` |

An e-invoice is the original invoice, and ZDDV-1 requires keeping it unchanged
in its original format for 10 years. The first e-SLOG download of an invoice or
credit note is therefore stored in the document storage as version 1, together
with its size and SHA-256 checksum. Every later download returns exactly that
file, so the signature and signing time never change.

A new version is only created when the reference document changes, or when the
stored version is unsigned and a valid signing certificate has been added since.
Earlier versions are never overwritten. The download returns the latest version
and reports it in the `X-Document-Version` header. Add `?version=N` to download
an earlier one, and the versions endpoint lists them all with their checksum,
signature state and reference document. The invoice page shows the same list.

Before a stored file is returned, its size and checksum are checked. A file that
no longer matches returns error `1177` and is not replaced, because a newly
generated file would not be the original. Restore it from a backup of the
document storage. An unknown version returns error `1178`. Stored files count
toward the project's document storage like archived PDFs.

### Delivering e-invoices

The e-SLOG file reaches the buyer in three ways, and all of them use the same
stored version described above:

- Email. The invoice and credit note email dialogs have an Attach the
  e-invoice switch, and the API takes `attach_eslog: true` on
  `POST .../invoices/:invoice/email` and `POST .../credit-notes/:note/email`.
  The XML is attached next to the PDF and the email says so. An explicit request
  for an invoice that cannot become an e-invoice returns the same error as the
  download, such as `1172`, and no email is queued.
- Project default. Turn on `email_attach_eslog` under Settings, Email to
  attach it to every invoice and credit note email, including recurring
  invoices and store orders. Reminders do not attach it. With the default, an
  invoice that cannot become an e-invoice, such as a sale to a consumer without a
  tax number, is still emailed without the XML and a warning is logged.
- Customer portal. Buyers with a VAT ID or tax number on the document see a
  Download e-SLOG button next to the PDF. When the file cannot be created, the
  portal answers with error `1179` and a neutral message, and the reason is
  logged for the seller.

Each email records which stored version it carried, so the email history shows
exactly what each recipient received.

## Fiscal verification (FURS)

Under ZDavPR, invoices paid in cash, by card or in crypto must be verified by
FURS. RabbitPay treats the `cash`, `stripe`, `bitcoin`, `ethereum` and `monero`
processors as needing verification. Bank transfers, PayPal and customer credit
do not.

A project whose tax country is `SI` cannot offer or record those payments until
fiscal verification is set up under Settings. The pay page hides them, the
payment method settings explain why, and taking cash at the terminal or
recording such a payment returns error `1140`.

| Method   | Path                                                      | Permission     |
| -------- | --------------------------------------------------------- | -------------- |
| `GET`    | `/api/v1/projects/:uuid/fiscal`                           | `project.view` |
| `PUT`    | `/api/v1/projects/:uuid/fiscal/certificate`               | `project.edit` |
| `DELETE` | `/api/v1/projects/:uuid/fiscal/certificate`               | `project.edit` |
| `PATCH`  | `/api/v1/projects/:uuid/fiscal`                           | `project.edit` |
| `POST`   | `/api/v1/projects/:uuid/fiscal/echo`                      | `project.edit` |
| `POST`   | `/api/v1/projects/:uuid/fiscal/premises`                  | `project.edit` |
| `POST`   | `/api/v1/projects/:uuid/fiscal/premises/:premise/close`   | `project.edit` |
| `PUT`    | `/api/v1/projects/:uuid/fiscal/operators/:username`       | `project.edit` |
| `GET`    | `/api/v1/projects/:uuid/fiscal/documents`                 | `invoice.view` |
| `POST`   | `/api/v1/projects/:uuid/fiscal/documents/:document/retry` | `project.edit` |

Setting it up takes three steps:

1. Upload the `.p12` certificate from eDavki as base64 with its password. The
   file is read without third party code, including older files that use RC2 or
   3DES, and stored encrypted with the master key. A certificate issued by
   `Tax CA Test` switches the project to the FURS test environment, any other to
   production.
2. Register a business premise, either a building with its cadastral data and
   address, or a movable premise of type `A`, `B` or `C`.
3. Choose the premise and device for invoices, optionally a separate one for the
   terminal, and switch verification on.

Once it is on, issued invoices are numbered `PREMISE-DEVICE-NUMBER`, for example
`SPLET-1-15`, counting up without gaps on each device. When a payment that needs
verification settles, RabbitPay computes the ZOI, signs the message and sends it
to FURS with mutual TLS. An invoice issued earlier and paid later keeps its
original issue time. Store orders are only numbered and issued when their
payment arrives, so unpaid orders take no numbers. Terminal sales are sent straight away. When FURS cannot be
reached, the invoice waits, is retried with growing delays and is then sent
marked as a subsequent submission. Each record has a deadline of two working
days for terminal sales and ten for invoices paid later. A rejection keeps its
FURS error code and can be retried after the cause is fixed. Each record names the
person who issued the invoice, its creator or the project owner for invoices
without one, such as recurring or API invoices. FURS receives that person's tax
number as entered under People who issue invoices, or the project's fallback
tax number when none is entered. A credit note for a
verified invoice takes the next number on the same device and is sent as a
negative invoice that references the original. Refunding a payment on a verified
invoice always issues such a credit note, even when `credit_note` is `false`.

When FURS rejects a production record, or one is still unverified within 24
hours of its deadline, every owner of the project gets one email that lists the
affected invoices, and the project overview shows a warning until they are
verified. The same record raises another email only if it fails again after a
retry. Records in the FURS test environment never send email. Email must be set
up on the server or on the project for owners to be told.

Verified invoices and credit notes show the issue time, who issued them, the ZOI
and the EOR, followed by a 25 x 25 QR code with error correction M, on screen, in
PDFs and in email attachments.

Both versions of a verified document are kept. The PDF archived when the invoice
was issued stays unchanged, and when FURS returns the EOR a second PDF with the
fiscal marks is stored next to it with its size and SHA-256 hash. From then on
downloads and email attachments serve that stored copy byte for byte, so later
changes to the layout never alter a document a customer already received. A copy
that could not be stored straight away, or a record verified before this was
added, is stored by the next document archive run. Both copies count towards the
project's storage.

FURS responses are only accepted when signed under SIGOV-CA, which is bundled
together with the SI-TRUST root and also used to trust the FURS servers. Set
`fiscal.software_supplier_tax_number` in the admin settings to the Slovenian tax
number of whoever supplies your installation. Without it, premises are
registered with `fiscal.software_supplier_name`.

`tests/furs.test.ts` runs against a local FURS stand-in that checks signatures,
certificates and premises like the real service. To also test against the real
FURS test environment, request a test certificate at sd.fu@gov.si and run:

```bash
FURS_TEST_P12=/path/to/test.p12 FURS_TEST_PASSWORD=secret bun test tests/furs-live.test.ts
```

## VAT on invoices in another currency

VAT has to be reported in euros, and ZDDV-1 names the rate to use: the ECB
reference rate that applies on the day the tax liability arises, as published by
Banka Slovenije. When the project's reporting currency is EUR, an invoice in
another currency is therefore converted like this at the moment it is issued:

- The day is the supply date, in the project's timezone. An invoice issued on
  5 October for a supply on 28 September uses the rate for 28 September.
- The rate is the latest ECB reference rate published on or before that day, at
  most six days back, which covers weekends and bank holidays. It is saved on
  the invoice as `tax_exchange_rate` with `tax_rate_source` `ECB`, and
  `tax_rate_date` is the day the ECB published it.
- The ECB quotes the foreign currency per euro, and the invoice stores the
  reciprocal, euros for one unit of the invoice currency.

The server downloads the ECB rates of the last 90 days every few hours and keeps
them in the `ecb_rates` table, so a rate that was used can be looked up later.
When an invoice needs a day that is not stored yet, the server asks the ECB at
that moment, and for a supply date older than 90 days it reads the full history
file. The address is under Admin, Settings, Payments, and turning off Look up
exchange rates stops the downloads.

An invoice that charges VAT cannot be issued without a rate. The request fails
with error `1132` and the issue `tax_exchange_rate`. This happens for a currency
the ECB does not quote, such as RSD or BAM, or when the rates could not be
downloaded. Enter the rate in the invoice form, or send `tax_exchange_rate` when
creating or updating the draft. A rate entered this way always wins over the ECB
rate, is saved with `tax_rate_source` `manual`, and is removed when the invoice
currency changes. An invoice without VAT, such as a reverse charge or export
invoice, is still issued without a rate and stays out of the VAT report until
one is set on the invoice page.

A project whose reporting currency is not EUR keeps using the market rate from
RabbitForex at the moment of issuing.

## DDV periods and accounting locks

DDV month and quarter boundaries use the project's accounting timezone. For
`Europe/Ljubljana`, a period therefore begins and ends at local midnight with
the correct daylight saving offset instead of at UTC midnight.

Creating a valid FURS DDV export locks the covered period. RabbitPay then blocks
changes to expenses and their attachments in that period, manual exchange-rate
changes on covered invoices, and creation of new invoices or credit notes whose
issue time falls inside the lock. Existing documents remain readable and another
export revision can be downloaded without changing the records.

An authorized report exporter can explicitly unlock the period from the DDV
section. A reason between 3 and 500 characters is required. The user, time,
reason, previous lock state and new state are written to `audit_log`. The next
successful export locks the period again.
