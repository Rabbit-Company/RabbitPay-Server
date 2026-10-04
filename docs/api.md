# API

All responses use the envelope `{ "error": <code>, "info": <message> }`, plus a
`data` field on success. `error` is `0` on success. The codes are listed in
[`server/errors.ts`](../server/errors.ts).

Authenticated requests carry a session token: `Authorization: Bearer <token>`.

Passwords are sent pre-hashed with BLAKE2b (128 hex characters), matching the
rest of the Rabbit Company stack. The server hashes that digest again with
Argon2id before storing it. A client must hash before calling, because a raw
password is rejected as malformed.

## Authentication

| Method   | Path                                              | Description                                                 |
| -------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `GET`    | `/api/v1/auth/registration`                       | Whether registration is open, invite only or closed.        |
| `POST`   | `/api/v1/auth/register`                           | Create an account.                                          |
| `POST`   | `/api/v1/auth/login`                              | Sign in with a password and, when enabled, a second factor. |
| `POST`   | `/api/v1/auth/logout`                             | Revoke the current session.                                 |
| `GET`    | `/api/v1/auth/me`                                 | The signed-in account.                                      |
| `POST`   | `/api/v1/auth/email`                              | Change the email address the account signs in with.         |
| `POST`   | `/api/v1/auth/email/confirm`                      | Confirm a new email address with the emailed link.          |
| `GET`    | `/api/v1/auth/export`                             | Download the account's personal data as JSON.               |
| `POST`   | `/api/v1/auth/legal/accept`                       | Accept the current Terms of Service.                        |
| `POST`   | `/api/v1/auth/two-factor/setup`                   | Start an authenticator app enrollment.                      |
| `POST`   | `/api/v1/auth/two-factor/enable`                  | Confirm the authenticator app.                              |
| `DELETE` | `/api/v1/auth/two-factor/authenticator`           | Remove the authenticator app.                               |
| `POST`   | `/api/v1/auth/two-factor/security-keys/options`   | WebAuthn options for adding a security key.                 |
| `POST`   | `/api/v1/auth/two-factor/security-keys`           | Add a security key.                                         |
| `POST`   | `/api/v1/auth/two-factor/security-keys/challenge` | WebAuthn challenge for confirming a change.                 |
| `DELETE` | `/api/v1/auth/two-factor/security-keys/:key`      | Remove a security key.                                      |
| `POST`   | `/api/v1/auth/two-factor/recovery-codes`          | Replace the recovery codes.                                 |
| `DELETE` | `/api/v1/auth/two-factor`                         | Turn off two-factor authentication.                         |

Register and login are rate limited per client IP per endpoint (10 requests per
15 minutes by default).

When registration needs an invite code, send it as `invite` in the register
body. Someone invited to a project can send the invitation token as
`invitation` instead, and must register with the invited email.

Two-factor authentication is set up under Account security in the web
interface. An account can use an authenticator app, up to 10 security keys
(WebAuthn, such as a YubiKey or a passkey), or both. The first factor added
returns ten single-use recovery codes once. Only their hashes are kept, and the
authenticator secret is encrypted with `RABBITPAY_MASTER_KEY`.

When two-factor authentication is on, a login without a second factor fails with
`1133` and includes WebAuthn request options when the account has security keys.
Send the next login with either `code` (an authenticator or recovery code) or
`credential` (the WebAuthn assertion). Removing a factor, replacing recovery
codes or turning two-factor authentication off needs the password and a second
factor. WebAuthn uses the host of the Public URL setting as its relying party, so
open RabbitPay at that address over HTTPS.

Registration needs `accept_terms: true` and `legal_versions` once an
administrator has published Terms of Service. `GET /api/v1/legal` returns the
current documents and `required_versions`, which is what a client sends back.

```bash
PW=$(printf 'correct-horse' | b2sum -l 512 | cut -d' ' -f1)

curl -X POST localhost:8085/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"z@example.com\",\"password\":\"$PW\"}"

curl -X POST localhost:8085/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"z@example.com\",\"password\":\"$PW\"}"
```

Accounts sign in with their email address, which is matched without regard to
letter case. Each account also gets a permanent identifier at registration,
returned as `username`. It is 26 random lowercase letters and digits, never
changes, is never given to another account and is what invoices, timesheets and
the audit log record as the person who acted. Nobody types it to sign in.
Accounts created before identifiers were random keep the username they chose.

Fields that hold an identifier, such as `created_by`, `sent_by` or
`decided_by`, come with a `_name` field beside them wherever the dashboard
shows a person: the member's full name in that project, or their email when no
name is saved. The name is `null` once the account has been deleted. Invoices
and fiscal documents name the issuer the same way, full name first and email
otherwise.

`POST /api/v1/auth/email` takes the new `email`, the `password` and, when
two-factor authentication is on, `code` or `credential`. An address that already
has an account is refused with `1007`, and accounts are never merged. When the
server can send email, the change waits until the link sent to the new address
is opened (`pending: true`), the link works once for an hour, and the old
address is told afterwards. Without an email server the change applies at once.
`POST /api/v1/auth/email/confirm` takes the `token` from that link and needs no
session. The identifier, projects, roles and sessions stay as they are.

Sessions are held in the cache, keyed by a hash of the token, and expire after
`session_ttl` seconds. The expiry slides forward on each authenticated request,
and an account may hold several concurrent sessions that are revoked separately.

## Projects

| Method   | Path                     | Permission       |
| -------- | ------------------------ | ---------------- |
| `GET`    | `/api/v1/projects`       | any membership   |
| `POST`   | `/api/v1/projects`       | authenticated    |
| `GET`    | `/api/v1/projects/:uuid` | `project.view`   |
| `PATCH`  | `/api/v1/projects/:uuid` | `project.edit`   |
| `DELETE` | `/api/v1/projects/:uuid` | `project.delete` |

Creating a project makes the creator its owner. The API keys are returned once, at creation. `PATCH`
accepts `name`, `currency` and `webhook_url`. Passing `webhook_url: null` clears
it.

`currency` is the project's primary currency, an ISO 4217 code that defaults to
`EUR`. New invoices and the terminal start there, so a shop that bills in one
currency never picks it again. Existing projects were given the currency they had
already been invoicing in.

`name` is a slug used in URLs and in the dashboard, so it stays lowercase.
`display_name` is what customers see on the payment page and on printed invoices,
and it has no such restriction, so `bloggy` can present itself as `Bloggy Studio`.
Every response also carries `public_name`, which is the display name when one is
set and the slug otherwise.

Deletion is a soft delete. Invoices and transactions are financial records, so
rows are kept and the project drops out of every query.

## Company details

| Method | Path                             | Permission     |
| ------ | -------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/company` | `project.view` |
| `PUT`  | `/api/v1/projects/:uuid/company` | `project.edit` |

Most countries require a seller's legal name, address and tax number on an
invoice. These are kept per project, under Settings, and printed on every
invoice: `legal_name`, `address_line1`, `address_line2`, `postal_code`, `city`,
`state`, `country`, `vat_number`, `tax_number`, `registration_number`, `email`,
`phone`, `website` and `footer_note`.

`PUT` merges, so sending one field leaves the rest alone, and sending a blank
string or `null` clears that one. `footer_note` is printed at the foot of the
invoice, which is where a clause like a VAT exemption belongs.

Nothing here is enforced, because what an invoice must carry differs by country.
The print view warns when the legal name or address is missing, and otherwise
prints what you give it.

## API keys

| Method | Path                                         | Permission     |
| ------ | -------------------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/keys`                | `api.keys`     |
| `POST` | `/api/v1/projects/:uuid/keys/rotate`         | `api.keys`     |
| `POST` | `/api/v1/projects/:uuid/keys/webhook-secret` | `api.webhooks` |
| `PUT`  | `/api/v1/projects/:uuid/webhook-url`         | `api.webhooks` |
| `GET`  | `/api/v1/projects/:uuid/webhooks`            | `api.webhooks` |

`PUT /webhook-url` takes `{ "url": "https://..." }` and sets where webhooks are
sent, so developers can manage it without `project.edit`. `{ "url": null }` stops
them.

Each project has two keys so one can be rotated without downtime: point
integrations at the secondary, rotate the primary, then swap. `GET` returns
masked keys. A rotated key is shown in full once and never again.

```bash
curl -X POST localhost:8085/api/v1/projects/$UUID/keys/rotate \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slot":"primary"}'
```

## Customers

| Method   | Path                                         | Permission        |
| -------- | -------------------------------------------- | ----------------- |
| `GET`    | `/api/v1/projects/:uuid/customers`           | `customer.view`   |
| `POST`   | `/api/v1/projects/:uuid/customers`           | `customer.create` |
| `GET`    | `/api/v1/projects/:uuid/customers/:customer` | `customer.view`   |
| `PATCH`  | `/api/v1/projects/:uuid/customers/:customer` | `customer.edit`   |
| `DELETE` | `/api/v1/projects/:uuid/customers/:customer` | `customer.delete` |

A customer needs a name or an email, and a request with neither returns error
`1287`. Email is optional, so a customer who has none can still be invoiced and
the invoice is printed or downloaded instead of emailed. An email that is given
must be unique within a project. Emails are trimmed and stored in lowercase, so
`Billing@Acme.com` and `billing@acme.com` are the same address. Any number of customers can be saved without
one. Send `"email": null` to remove it. Sending an email to such a customer
needs an explicit `to` address, otherwise it returns error `1084`. Automatic
emails, meaning recurring invoices set to send themselves and payment reminders,
skip a customer without an email. The customer portal identifies customers by
email, so a customer without one cannot sign in to it. `country` is an ISO
3166-1 alpha-2 code. `metadata` is stored as JSON and returned parsed.
`vat_number` is the VAT ID of a VAT registered customer and is stored with its
country prefix, so `12345678` for a Slovenian customer becomes `SI12345678`.
`tax_number` is for businesses outside the VAT system. Invoices print the VAT
ID, and the tax number only when it is a different number. The list endpoint
takes `limit`, `offset` and `search`, where `search` matches email, name, VAT
ID or tax number. A customer referenced by any invoice cannot be deleted.

`GET /api/v1/projects/:uuid/customer-duplicates` finds customers that share a
VAT ID or tax number, and needs `customer.view`. It takes `vat_number`,
`tax_number`, an optional `country` used when the VAT ID has no prefix, and an
optional `exclude` with the UUID of the customer being edited. Spaces, dots and
the country prefix are ignored, and a VAT ID matches a tax number with the same
digits, so `SI12345678` finds a customer whose tax number is `12345678`. It
returns up to ten customers. Saving a duplicate is never refused. The customer
form uses this to warn before it saves a second customer with the same number.

`registration_number`, `iban` and `bic` are optional and only used in e-SLOG
invoices, where public sector buyers need them. The IBAN is stored without spaces
and must pass its checksum, and the BIC must have 8 or 11 characters. Anything
else returns error `1174`.

## Invoices

| Method   | Path                                                | Permission       |
| -------- | --------------------------------------------------- | ---------------- |
| `GET`    | `/api/v1/projects/:uuid/invoices`                   | `invoice.view`   |
| `POST`   | `/api/v1/projects/:uuid/invoices`                   | `invoice.create` |
| `GET`    | `/api/v1/projects/:uuid/invoices/:invoice`          | `invoice.view`   |
| `PATCH`  | `/api/v1/projects/:uuid/invoices/:invoice`          | `invoice.edit`   |
| `POST`   | `/api/v1/projects/:uuid/invoices/:invoice/open`     | `invoice.send`   |
| `POST`   | `/api/v1/projects/:uuid/invoices/:invoice/cancel`   | `invoice.edit`   |
| `POST`   | `/api/v1/projects/:uuid/invoices/:invoice/proforma` | `invoice.send`   |
| `PATCH`  | `/api/v1/projects/:uuid/invoices/:invoice/proforma` | `invoice.edit`   |
| `DELETE` | `/api/v1/projects/:uuid/invoices/:invoice`          | `invoice.delete` |

```bash
curl -X POST localhost:8085/api/v1/projects/$UUID/invoices \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "customer": "'"$CUSTOMER"'",
        "currency": "EUR",
        "due_date": 1789000000000,
        "items": [
          { "description": "Consulting", "quantity": 3, "unit_price": 10000, "tax_rate": 22 }
        ]
      }'
```

`POST .../proforma` turns a draft into a pro forma invoice with the next number
from the pro forma series. The body may set `settlement` to `invoice` or
`advance`, otherwise the project default applies, and `PATCH .../proforma`
changes it until the first payment. The list takes `document=proforma`,
`order` or `advance`, and every invoice carries `document`, `proforma`,
`order_number`, `advances` and `source_proforma` so an integration can follow a
pro forma invoice to its advance and final invoices. See
[Pro forma invoices](invoices.md#pro-forma-invoices).

Amounts are integers in the currency's smallest unit, so `10000` is 100.00
EUR. Fractional or negative amounts are rejected. `quantity` may be fractional,
`tax_rate` is a percentage between 0 and 100, and `currency` is an ISO 4217 code.
Leave `currency` out and the invoice takes the project's primary currency. A
currency with no minor unit works the same way, so `5000` in a `JPY` project is
5000 yen, not 50.

Each line can have a `unit` of measure, given as its UN/ECE Recommendation 20
code, the code list e-SLOG and EN 16931 use:

| Code  | Unit         | Code  | Unit     | Code  | Unit          |
| ----- | ------------ | ----- | -------- | ----- | ------------- |
| `C62` | Piece        | `DAY` | Day      | `MTR` | Metre         |
| `SET` | Set          | `WEE` | Week     | `KMT` | Kilometre     |
| `PR`  | Pair         | `MON` | Month    | `MTK` | Square metre  |
| `XPK` | Package      | `ANN` | Year     | `MTQ` | Cubic metre   |
| `MIN` | Minute       | `GRM` | Gram     | `LTR` | Litre         |
| `HUR` | Hour         | `KGM` | Kilogram | `KWH` | Kilowatt hour |
| `E48` | Service unit | `TNE` | Tonne    |       |               |

Any other value returns error `1038` on an invoice line or `1066` on a saved item. Saved items take a default `unit`, which
the web editor, the terminal and the online store copy onto the line. Recurring
templates keep the unit of each line. The PDF, the print view, emails and the pay
page show the quantity with a short symbol in the invoice's language, such as
`3 h` or `12 mes`. A line without a unit shows only the quantity and is sent to
e-SLOG as `C62`.

Totals are always computed by the server from the line items and never taken
from the request:

```
line total  = round(quantity * unit_price)
line tax    = round(line total * tax_rate / 100)
subtotal    = sum(line totals)
tax_amount  = sum(line taxes)
total       = subtotal - discount_amount + tax_amount
```

A discount larger than the subtotal is clamped to the subtotal, so a total never
goes negative.

Invoices are created as `draft` unless `"status": "open"` is passed. With
`"status": "open"` the invoice is created and issued in one step, so a failed
request leaves no draft behind. It also needs the `invoice.send` permission and
sends the `invoice.issued` webhook.

Creating an invoice is safe to retry with an `Idempotency-Key` header of 1 to
128 letters, digits, dots, colons, hyphens or underscores. When a request with
the same key and the same body is sent again, for example after a lost
connection, the server returns the invoice the first request created, with
status `200` and the header `Idempotency-Replayed: true`. Nothing is issued
twice and no second webhook is sent. The same key with a different body returns
error `1286`, and a malformed key returns `1285`. A request that was refused
does not use up its key. Keys are scoped to the project and kept for seven days.
`POST /api/v1/pay/invoices` takes the same header.

An invoice in another currency than the project's reporting currency takes an
optional `tax_exchange_rate`, the reporting currency for one unit of the invoice
currency. Leave it out to let the server pick the rate when the invoice is
issued. [VAT on invoices in another currency](slovenia.md#vat-on-invoices-in-another-currency)
explains which rate that is and when issuing is refused without one.

The lifecycle is:

| Status           | Meaning                                  |
| ---------------- | ---------------------------------------- |
| `draft`          | Editable and deletable. Not yet payable. |
| `open`           | Issued and awaiting payment.             |
| `overdue`        | Issued, unpaid, and past `due_date`.     |
| `partially_paid` | Some payment recorded.                   |
| `paid`           | Settled in full.                         |
| `canceled`       | Withdrawn before payment.                |
| `refunded`       | Paid and then returned.                  |

Only a `draft` can be edited or deleted, which keeps issued invoices immutable.
Opening an invoice already past its due date lands directly in `overdue`.
Cancelling is refused once an invoice is paid or already canceled.

`paid`, `partially_paid` and `refunded` are reached by recording payments, which
is covered under [Payments and refunds](#payments-and-refunds). Those statuses are
set by the ledger rather than by the caller, so they cannot be assigned directly.

The list endpoint takes `limit`, `offset`, `status` and `customer`, and returns
totals grouped by currency alongside the page.

## Machine API, authenticated by an API key

Everything above is authenticated by a login session and is what the dashboard
uses. An integration on your own server instead sends a project API key as the
bearer token, against a separate set of routes that do not take a project id,
because the key already identifies the project.

| Method | Path                            | Purpose                                        |
| ------ | ------------------------------- | ---------------------------------------------- |
| `GET`  | `/api/v1/pay/me`                | Check a key and see which project it is for.   |
| `POST` | `/api/v1/pay/customers`         | Create a customer, or return the existing one. |
| `POST` | `/api/v1/pay/invoices`          | Raise an invoice.                              |
| `GET`  | `/api/v1/pay/invoices`          | List invoices.                                 |
| `GET`  | `/api/v1/pay/invoices/:invoice` | Check one invoice and what it still owes.      |

```bash
curl -X POST localhost:8085/api/v1/pay/invoices \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  -d '{"currency":"EUR","due_date":1789000000000,
       "items":[{"description":"Licence","quantity":2,"unit_price":5000,"tax_rate":20}]}'
```

Invoices raised this way are issued immediately rather than left as drafts,
since an integration raising one intends to be paid. Pass `"status":"draft"` to
override that. `POST /pay/customers` returns the existing customer with `200`
when the email is already known, rather than failing, so an integration can call
it every time without tracking what it has already created. The email
stays required on this endpoint because it is what identifies the customer.

`GET /pay/invoices/:invoice` is the polling endpoint. It adds `outstanding` to
the invoice, which is the total minus what has been paid net of refunds.

What a key cannot do: A key is deliberately narrower than a session. It
cannot read or rotate keys, manage the project or its team, delete anything,
record payments, or issue refunds. Those stay with a signed-in member whose role
allows them, so a leaked key cannot drain or dismantle a project. Rotating the
key immediately invalidates the old one, and a key stops working the moment its
project is deleted.

Validation and invoice arithmetic are shared with the dashboard routes through
[`server/invoice-service.ts`](../server/invoice-service.ts), so both surfaces accept
exactly the same input and produce identical totals. A test asserts that.

## Webhooks

Set a webhook URL on the project and RabbitPay posts events to it as they happen,
so an integration does not have to poll.

| Event                    | Fired when                                                                      |
| ------------------------ | ------------------------------------------------------------------------------- |
| `invoice.issued`         | A draft is opened, a paid store order is issued, or the machine API raises one. |
| `invoice.partially_paid` | Part of an invoice is settled.                                                  |
| `invoice.paid`           | An invoice is settled in full.                                                  |
| `invoice.overdue`        | An unpaid invoice passes its due date.                                          |
| `invoice.refunded`       | Everything paid on an invoice is refunded.                                      |
| `invoice.canceled`       | An invoice is withdrawn.                                                        |
| `payment.received`       | A payment is seen but has not settled yet.                                      |
| `payment.confirmed`      | A payment settles.                                                              |
| `payment.refunded`       | A refund is issued.                                                             |

Each delivery is a POST carrying:

```
X-RabbitPay-Event: invoice.paid
X-RabbitPay-Delivery: <uuid>
X-RabbitPay-Timestamp: <epoch milliseconds>
X-RabbitPay-Signature: sha256=<hmac>
```

Verify the signature. It is HMAC-SHA256 over the timestamp, a dot, and the
raw body, keyed with the project signing secret. The secret is shown once when
the project is created and can be rotated from Settings. Checking the timestamp
as well as the body is what stops an old delivery being replayed at you.

```ts
const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
```

Anything outside 2xx counts as a failure and is retried with backoff at 30s, 2m,
10m, 1h and 6h, then given up on. `max_attempts` and `timeout` are configurable.
Delivery history is visible under a project's Settings and through
`GET /api/v1/projects/:uuid/webhooks`.

Events are not ordered or deduplicated. A status change can arrive before the
payment that caused it, and a delivery your server accepted slowly may be sent
again. Key off the invoice or transaction id and make your handling idempotent.

Private targets are blocked by default. Project members choose their own
webhook URL, so without this the server could be pointed at things only it can
reach, such as a cloud metadata endpoint. Public targets must resolve only to
public addresses. The delivery connects to the checked address while retaining
the original hostname for HTTP and TLS. Redirects are not followed. Set
`allow_private_targets` to develop against something on localhost. Keep it off
in production.

## Payments and refunds

| Method | Path                                                      | Permission       |
| ------ | --------------------------------------------------------- | ---------------- |
| `GET`  | `/api/v1/projects/:uuid/transactions`                     | `payment.view`   |
| `POST` | `/api/v1/projects/:uuid/transactions`                     | `payment.create` |
| `GET`  | `/api/v1/projects/:uuid/transactions/:transaction`        | `payment.view`   |
| `POST` | `/api/v1/projects/:uuid/transactions/:transaction/refund` | `payment.refund` |

A payment is recorded against an issued invoice. The currency comes from the
invoice, and passing a `currency` that disagrees with it is rejected rather than
ignored. `status` may be `completed` (the default), `confirmed`, or `pending`.
A pending payment is recorded but does not count towards the balance, which is
what a crypto payment looks like before it has enough confirmations.

```bash
curl -X POST localhost:8085/api/v1/projects/$UUID/transactions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"invoice":"'"$INVOICE"'","processor":"bank_transfer","amount":61000,"fee_amount":290}'
```

Refunding without an `amount` refunds everything still available on that
payment. Refunds cannot exceed what remains, and only a payment can be refunded,
never another refund.

Invoice balances are derived, never incremented. `paid_amount`,
`refunded_amount` and the invoice status are recomputed from the transactions
table inside the same database transaction as every payment and refund, so they
cannot drift out of step with the ledger, and a stale value is corrected the next
time anything touches that invoice.

A payment that has been refunded still counts as money received. The refund is
subtracted separately, so an invoice paid in full and then refunded in full
reads `paid_amount` equal to the total, `refunded_amount` equal to the total, and
a status of `refunded`.

Overpayment is recorded as it happened rather than rejected, since a crypto
payment can easily arrive slightly over.

## Members

| Method   | Path                                     | Permission        |
| -------- | ---------------------------------------- | ----------------- |
| `GET`    | `/api/v1/projects/:uuid/members`         | `project.view`    |
| `POST`   | `/api/v1/projects/:uuid/members`         | `project.members` |
| `PATCH`  | `/api/v1/projects/:uuid/members/:member` | `project.members` |
| `DELETE` | `/api/v1/projects/:uuid/members/:member` | `project.members` |

Inviting an address that already has an account adds that account immediately.
Otherwise the invitation stays `pending` and carries an invitation token.

The invited address gets an email with a link to accept, when email is set up on
the server or the project. The response says whether the email was queued.

Guard rails: only an owner may grant or revoke ownership, a project must always
keep at least one owner, and nobody may change or remove their own membership.

## Roles

Nine roles, defined with their permissions in [`server/roles.ts`](../server/roles.ts):

| Role         | Summary                                                 |
| ------------ | ------------------------------------------------------- |
| `owner`      | Full control, including deletion and member management. |
| `admin`      | Everything except deleting the project.                 |
| `manager`    | Payments, invoices, customers and subscriptions.        |
| `accountant` | Read-only financial access, with export.                |
| `developer`  | API keys and webhooks.                                  |
| `viewer`     | Read-only.                                              |
| `cashier`    | Sells at the terminal and sees their own sales.         |
| `supervisor` | Manages everyone's timesheets, absences and tickets.    |
| `employee`   | Logs their own hours and absences and works on tickets. |

A membership can be adjusted individually through `additional_permissions` and
`restricted_permissions`, and can carry an `expires_at` for temporary access.
Restrictions are applied last, so they always win.

## Metrics

`GET /metrics` exposes OpenMetrics, controlled by Admin, Settings, Logging and
metrics, and protected by the metrics token when set. Metrics are off by
default. Request counts and durations are labelled by HTTP method only, never by
path, so invoice and customer IDs cannot multiply the number of time series.
