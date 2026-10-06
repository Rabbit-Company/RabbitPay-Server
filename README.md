# RabbitPay

RabbitPay is invoicing, payments and bookkeeping for small businesses. It issues
invoices, takes payments by bank transfer, card, PayPal, Bitcoin, Ethereum and
Monero, runs a till and an online store, and keeps expenses, reports, timesheets
and payroll next to them. Slovenian fiscal verification (FURS) and e-SLOG
e-invoices are built in.

You can use it at [rabbitpay.net](https://rabbitpay.net) or run it on your own
server. It is a single Bun process with SQLite by default, so a small install
needs nothing else.

## Features

### Invoicing

Invoices and credit notes with sequential numbering, pro forma invoices
(predračun) that become invoices or advance invoices when paid, number formats
of your own for invoices, pro forma invoices and store orders, PDF archive,
email delivery with reminders before and after the due date, recurring invoices
and a customer portal where buyers see and pay what they owe. Documents in
English and Slovenian, with your own design and branding on a white label
license.

### Payments

Every invoice gets a payment page. Bank transfers show the account
with a UPN QR or EPC QR code. Stripe and PayPal checkouts credit the invoice from
signed webhooks. Bitcoin, Ethereum and Monero get a new address per invoice,
derived from a public key or a view-only wallet, so the server never holds
spending keys. A script embeds the payment page on your own site.

### Selling

A terminal for sales in person, which runs full screen on a tablet or
an Android POS device. An online store with categories, filters, coupons, custom
domains and delivery of digital license keys.

### Bookkeeping

Expenses with receipts, recurring expenses, import of supplier
e-invoices (e-SLOG 2.0 and Peppol UBL), and financial, VAT and item sales reports
with CSV export.

### Slovenia and the EU

FURS fiscal verification of cash and card sales, signed
e-SLOG 2.0 e-invoices for businesses and the public sector (UJP), DDV records
with period locks, VAT number checks through VIES, and OSS for sales to EU
consumers.

### Workforce

Timesheets, absences with approval, work hour reports, support
tickets, employee records and payroll with payslips, REK-O files for eDavki and
SEPA salary payments.

### Teams and security

Nine roles with per-member permissions, two-factor
authentication with authenticator apps and security keys (WebAuthn), audit and
access logs, and encryption of payment credentials, documents and backups.

### Integrations

A REST API for integrations authenticated by project API keys,
and signed webhooks for invoice and payment events.

## Getting started

### Docker Compose

```bash
git clone https://github.com/Rabbit-Company/RabbitPay-Server.git
cd RabbitPay-Server
cp .env.example .env
```

Set `RABBITPAY_MASTER_KEY` in `.env` to a random value of at least 32
characters, for example the output of `openssl rand -base64 48`. Then start it:

```bash
docker compose up -d --build
```

Open <http://localhost:8085> and register. The first account becomes the
administrator of the server. Data is kept in the `data` folder next to the
compose file.

### From source

You need [Bun](https://bun.sh) 1.4 or newer.

```bash
bun install
bun run build:web
echo "RABBITPAY_MASTER_KEY=\"$(openssl rand -base64 48)\"" >> .env
bun run start
```

The server listens on port 8085 and creates `data/rabbitpay.sqlite` on first run.

## Before going to production

1. Back up the master key somewhere other than the server, such as a password
   manager. It encrypts payment credentials, secret settings, authenticator
   secrets, and every document and backup stored in S3. If it is lost, those
   cannot be recovered. It cannot be changed later.
2. Put RabbitPay behind HTTPS. Set Admin, Settings, Server, Public URL to the
   address customers use. Payment links, emails and security keys depend on it.
3. Set the client IP source to match your reverse proxy (Nginx, Caddy,
   Cloudflare and others), so login rate limits and audit logs see real
   addresses.
4. Set up email under Admin, Settings, Email, so invoices, reminders and
   invitations are delivered.
5. Turn on backups under Admin, Settings, Backups, to a directory, S3
   compatible storage, or both. Keep the master key with them.
6. Run one instance per database. Background jobs are not coordinated
   between processes yet, so a second instance would send emails and webhooks
   twice.

## Configuration

The environment only holds what is needed before the database can be read:

| Variable               | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `RABBITPAY_MASTER_KEY` | Required. Encryption key, at least 32 characters.                         |
| `RABBITPAY_DB`         | Database connection. Defaults to `sqlite://./data/rabbitpay.sqlite`.      |
| `DOCUMENT_STORAGE`     | Where issued documents are kept: `local` (default) or `s3`.               |
| `DOCUMENT_S3_*`        | Bucket, region, endpoint and credentials when documents are stored in S3. |

SQLite, MySQL 8.4+, PostgreSQL and YugabyteDB are supported:

```bash
RABBITPAY_DB="postgres://user:pass@localhost/rabbitpay"
RABBITPAY_DB="mysql://user:pass@localhost/rabbitpay"
```

Everything else, from email and payment methods to caches and metrics, is set
under Admin, Settings in the web interface and stored in the database.
[`.env.example`](.env.example) lists every environment variable and
[Installation and operation](docs/installation.md) explains each setting.

## Updating

Pull the new version and rebuild or restart. Database migrations run on start,
inside a transaction, and never run twice. A server refuses to start on a
database migrated by a newer version, so back up before updating in case you
need to go back.

## Licensing on self-hosted servers

Self-hosted servers include the same free allowance as rabbitpay.net: every
project gets 50 completed payments a month and 1 GB of document storage. License
keys add payments, storage, white labeling, the online store or timesheets and
payroll, which cover 5 people before employee seat keys are needed. They are sold by SIMONCA ZAJC S.P. at [rabbitpay.net](https://rabbitpay.net)
or [info@rabbitpay.net](mailto:info@rabbitpay.net). Each key is signed for the
Server ID shown under Admin, Overview and can be redeemed once. See
[Administration](docs/administration.md#licensing) for details.

## Documentation

- [Installation and operation](docs/installation.md): setup, backups, access logs, database and document storage, settings
- [Administration](docs/administration.md): licensing, registrations, accounts, legal pages, admin API
- [API](docs/api.md): authentication, projects, customers, invoices, API keys, webhooks, payments, roles
- [Payments](docs/payments.md): payment methods, crypto, Stripe and PayPal, bank transfer, payment page, terminal, embedding
- [Invoices and documents](docs/invoices.md): numbering, languages, date formats, printing, digital products
- [Slovenian compliance](docs/slovenia.md): e-SLOG, UJP, e-invoice signing, FURS fiscal verification, DDV periods
- [Expenses and reports](docs/expenses-and-reports.md): expenses, supplier e-invoice import, recurring expenses, financial reports
- [Online store](docs/online-store.md): store settings, products, categories, checkout, orders, privacy
- [Customer portal](docs/customer-portal.md): email sign-in, invoices, saved details, data export, support tickets
- [Timesheets, tickets and payroll](docs/workforce.md): roles, timesheets, absences, reports, tickets, employee records, payroll
- [Development](docs/development.md): web interface, help articles, commands, endpoints, queries, schema changes

## Development

```bash
bun run watch        # restart the server on change
bun run watch:web    # rebuild the web interface on change
bun run test         # run the test suite, no network or services needed
bun run typecheck
bun run build        # compile a standalone binary
```

The server is TypeScript on Bun using its built-in SQL client, and the web
interface is plain TypeScript without a framework. Tests run the app in-process
against a throwaway database. [Development](docs/development.md) covers adding
endpoints, queries and schema changes.

## Contributing

RabbitPay does not accept pull requests. Pull requests will be closed without
review. Bug reports and feature requests are welcome as issues.

## Security

Please report vulnerabilities privately to
[info@rabbitpay.net](mailto:info@rabbitpay.net) instead of opening a public issue.
See the [security policy](SECURITY.md) for details.

## License

RabbitPay is source available under the [Elastic License 2.0](LICENSE), licensed
by SIMONCA ZAJC S.P. You may use, modify and self-host it. You may not offer it to
others as a hosted or managed service, and you may not change, disable or
circumvent its license key functionality.
