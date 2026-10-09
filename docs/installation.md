# Installation and operation

## Requirements

- [Bun](https://bun.sh) 1.4 or newer
- Redis (optional, for the shared cache)
- A database (optional, SQLite is used by default and needs nothing installed)

## Setup

```bash
bun install
bun run build:web

# Generate a master key. It encrypts payment credentials, secret settings and
# files stored in S3. The server refuses to start without it.
echo "RABBITPAY_MASTER_KEY=\"$(openssl rand -base64 48)\"" >> .env

bun run start
```

Bun reads `.env` next to the server on start. It is git ignored, so the key is
never committed. [`.env.example`](../.env.example) lists every variable.

The server listens on `0.0.0.0:8085` by default and creates `data/rabbitpay.sqlite`
on first run. Issued invoice PDFs are archived under `data/invoices`. Open <http://localhost:8085> and register. The first account
becomes the server administrator and gets an Admin link in the header.

## Docker Compose

Copy `.env.example` to `.env`, set `RABBITPAY_MASTER_KEY`, then start RabbitPay:

```bash
docker compose up -d --build
```

The compose file mounts the local `data` folder at `/app/data`. SQLite files are stored directly in `data` and invoice PDFs are stored in `data/invoices`. Back up the complete `data` folder together with the master key.

`GET /api/health` answers `200` while the database responds and `503` during shutdown, and the image uses it as its Docker health check. On `SIGTERM` the server stops accepting requests and new background work, waits up to 25 seconds for running tasks such as email and webhook deliveries to finish, then closes the database. The compose file allows 30 seconds before Docker kills the container.

Run exactly one instance against a database. Background tasks such as email, webhooks, chain polling and FURS submissions guard against overlapping runs inside one process only, so a second instance would send emails and webhooks twice. Several instances behind a load balancer are not supported yet.

## Back up the master key

Each project's payment credentials, each project's own email server, account
TOTP configuration and every secret setting are encrypted with the master key
using AES-256-GCM. Documents and database backups stored in S3 are encrypted
with a key derived from it as well. Losing the key means every project has to
enter its Stripe, PayPal and Monero credentials again, accounts using 2FA must
have that setting reset, and secret settings have to be entered again. Every
document and backup stored in S3 becomes permanently unreadable. The server
never holds keys that can spend crypto, so no funds are lost with it. Back it up
separately from the database file and from the S3 bucket, for example in a
password manager.

The server refuses to start when `RABBITPAY_MASTER_KEY` is missing or shorter
than 32 characters. Changing the key later makes everything encrypted with the
old one unreadable, so treat it as permanent.

## Automatic database backups

Admin, Settings, Backups takes a snapshot of the SQLite database on a
schedule while the server keeps running. Each snapshot is written with
`VACUUM INTO` from a separate read-only connection, checked with
`PRAGMA quick_check`, compressed with gzip and named
`rabbitpay-YYYYMMDDTHHMMSSZ.sqlite.gz`. It is stored in a directory, in S3
compatible storage, or in both. Backups sent to S3 are encrypted with
AES-256-GCM before they leave the server and get a `.enc` suffix, so the storage
provider only ever sees ciphertext. The directory can be a mounted NFS or SMB share
so backups leave the machine. After each backup the oldest files beyond
Backups to keep are deleted from that destination. Files that do not match
the backup name are never touched. Back up now runs one immediately and the
panel lists the newest backup in each destination.

The server checks every five minutes whether the newest backup in any
destination is older than the interval. A failed destination is retried after
30 minutes and does not stop the others. Only SQLite is covered. Use
`pg_dump`, `mysqldump` or your provider's snapshots for PostgreSQL and MySQL.
Invoice PDFs in document storage are not part of the database backup, so copy
`DOCUMENT_LOCAL_PATH` or enable versioning on the document bucket as well.

To restore, stop the server, then replace the database and remove its WAL
files. Decrypt a backup downloaded from S3 first. This needs the same
`RABBITPAY_MASTER_KEY` in the environment or `.env`:

```bash
bun run backup:decrypt rabbitpay-20260923T030000Z.sqlite.gz.enc
gunzip -c rabbitpay-20260923T030000Z.sqlite.gz > data/rabbitpay.sqlite
rm -f data/rabbitpay.sqlite-wal data/rabbitpay.sqlite-shm
```

A modified backup or one taken with a different master key is refused and no
output file is left behind.

A backup is only useful together with the master key that was set when it was
taken.

## Access logs

Every permission check on a project writes an entry to `access_logs` with the
account, route, IP address and user agent. Admin, Settings, Access logs
controls how long they are kept. Entries stay in the database for 90 days by
default. Once an hour the server moves each complete UTC hour older than that
into document storage as gzipped JSON lines at
`logs/access/YYYY/MM/YYYY-MM-DDTHH.jsonl.gz`. Archives are always encrypted
with AES-256-GCM, including in a local directory, and their SHA-256 is recorded
in `access_log_archives` so a modified archive is refused. Archives do not count
towards any project's storage.

Entries and archives are deleted two years after the end of the calendar year in
which they were recorded, the default retention for processing logs under
Article 22 of the Slovenian ZVOP-2. The retention can be set up to 5 years when
a risk assessment justifies it. With archiving turned off, entries stay in the
database until retention ends. The `audit_log` of changes to invoices and other
records is not affected.

To read entries for an investigation or an access request, export a range of
UTC days from the archives and the database together. This needs the same
`RABBITPAY_MASTER_KEY` and document storage settings as the server:

```bash
bun run logs:export 2026-06-01 2026-06-30 access-2026-06.jsonl
```

## Configuration

Database and document storage settings live in the environment because they are needed before application settings can be read:

| Variable                        | Purpose                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `RABBITPAY_MASTER_KEY`          | Required encryption key, at least 32 characters. The server does not start without it.                                                        |
| `RABBITPAY_DB`                  | Database connection string (default `sqlite://./data/rabbitpay.sqlite`).                                                                      |
| `RABBITPAY_DB_ENGINE`           | Optional explicit engine (`sqlite`, `mysql`, `postgres`, `yugabyte`). Set `yugabyte` with a PostgreSQL connection string for YugabyteDB YSQL. |
| `DOCUMENT_STORAGE`              | Document archive backend. Use `local`, the default, or `s3`.                                                                                  |
| `DOCUMENT_LOCAL_PATH`           | Local document archive directory. Defaults to an `invoices` folder beside the SQLite database.                                                |
| `DOCUMENT_S3_BUCKET`            | S3 bucket used when `DOCUMENT_STORAGE=s3`.                                                                                                    |
| `DOCUMENT_S3_REGION`            | Optional S3 region.                                                                                                                           |
| `DOCUMENT_S3_ENDPOINT`          | Optional endpoint for S3 compatible services such as MinIO or Cloudflare R2.                                                                  |
| `DOCUMENT_S3_ACCESS_KEY_ID`     | Optional S3 access key. Bun also supports its standard AWS and S3 environment variables.                                                      |
| `DOCUMENT_S3_SECRET_ACCESS_KEY` | Optional S3 secret key.                                                                                                                       |
| `DOCUMENT_S3_SESSION_TOKEN`     | Optional S3 session token.                                                                                                                    |
| `RABBITPAY_LICENSE_SIGNING_KEY` | Only on the server that issues license keys. See [Administration](administration.md#the-issuing-server-and-licensed-servers).                 |
| `RABBITPAY_RENDER_WORKERS`      | Background threads that render PDFs. Defaults to a quarter of the CPU threads, between 1 and 4. Each uses about 90 MB. `0` renders inline.    |

Application settings are stored in the `settings` table and edited under Admin,
Settings: the listen address, public URL, email, payment methods, chain
backends, caches, logging, metrics and licensing. Each field explains itself
there, and the list is defined once in
[`server/settings-schema.ts`](../server/settings-schema.ts). Settings are held in
memory, saved changes apply at once, and every instance reloads them from the
database each minute. Fields marked "Takes effect after a restart" (listen
address, caches, poll intervals, the login rate limit) are read on start. Secret
settings are encrypted before they are stored and are never sent back to the
browser.

### Database

All queries go through Bun's built-in SQL client, so the engine is chosen by
`RABBITPAY_DB`:

```bash
RABBITPAY_DB="sqlite://./data/rabbitpay.sqlite"
RABBITPAY_DB="postgres://user:pass@localhost/rabbitpay"
RABBITPAY_DB="mysql://user:pass@localhost/rabbitpay"
```

SQLite is the default and needs nothing installed. Migrations map timestamp and
money columns to SQLite `INTEGER` or signed `BIGINT` on MySQL, PostgreSQL and
YugabyteDB YSQL. Dates remain Unix milliseconds and money remains integer minor
units. Flags remain numeric 0/1 values enforced by database constraints. Rates
and quantities use 64 bit floating point types. Database integers outside
JavaScript's safe integer range are rejected, including integer report totals.

### Invoice document storage

Draft PDFs are rendered on demand and are not stored. When an invoice is issued, RabbitPay saves a small versioned snapshot of its seller, tax, language, bank, branding, and issuer settings in the database. It renders one canonical PDF and writes it to the configured document storage backend. The database stores only the object key, size, SHA-256 hash, status, and retry information.

Local writes use a temporary file followed by an atomic rename, which also supports a mounted NFS directory. S3 storage uses Bun's S3 client and private objects. Every file is encrypted with AES-256-GCM before it is uploaded and decrypted when it is served, so the storage provider never sees invoices, expense receipts or other documents. Each file is bound to its storage key, so a file copied or moved to another key inside the bucket is refused. Encryption adds 32 bytes per file.

A bucket that already holds unencrypted documents from an older version must be converted once, because unencrypted files are refused. Run this with the server's environment. Files that are already encrypted are skipped:

```bash
bun run documents:encrypt
```

Failed archives are retried in the background. Downloads verify the stored size and SHA-256 hash before returning the PDF. A stored PDF that is missing, unreadable, or no longer matches is never replaced with a newly generated one, because that file would not be the original. The download, the customer page and the email attachment fail with error `1283`, the reason is saved in `last_error` on the document record, and the record keeps its storage key and hash. Restore the file from a backup of the document storage and the next download returns it again. The same applies to credit notes and to the verified copies kept for FURS.

Issued PDFs and their storage keys are immutable during normal operation. Changes to company details, VAT settings, language, bank account, logo, issuer visibility, or signatures affect only later invoices. The database and document archive must be backed up as one dataset.

MySQL schemas use bounded `VARCHAR` identifiers and indexed fields, `LONGTEXT`
for larger content, and case sensitive `utf8mb4_0900_bin` collation. Use MySQL
8.4 or newer. PostgreSQL and YugabyteDB use `TEXT` for unbounded text fields.

For YugabyteDB, set `RABBITPAY_DB_ENGINE=yugabyte` and use a `postgres://` URL.

The schema is built by numbered migrations in
[`server/database/migrations.ts`](../server/database/migrations.ts). On startup
every migration that is missing from the `schema_migrations` table runs once, in
order, inside a transaction, so a fresh installation and an upgraded one end up
with the same schema. A server refuses to start on a database migrated by a newer
version.

The database compatibility tests always check SQLite. To run the other engine
checks, provide `RABBITPAY_TEST_MYSQL_DB`, `RABBITPAY_TEST_POSTGRES_DB` or
`RABBITPAY_TEST_YUGABYTE_DB` and run
`bun test --isolate tests/database-compatibility.test.ts`. Each external check
creates and removes its own temporary database on MySQL or schema on YSQL and
PostgreSQL. The test account needs permission to create those fixtures. Checks
without a connection string are skipped.

### Settings worth a second look

These settings are easy to get wrong:

- Server, Client IP source sets how the client IP is found. The client IP
  drives the audit trail and the login rate limiter. Choose the proxy that sits
  in front of RabbitPay: Nginx or Caddy (reads `X-Real-IP`, then
  `X-Forwarded-For`), BurrowGate, Cloudflare, AWS, Google Cloud, Azure or
  Vercel. Direct connection ignores forwarded headers. Development
  trusts every header and must never be used in production. Behind your own
  reverse proxy, also set Trusted proxies to its address or CIDR range so
  clients that reach the server directly cannot forge their IP. With BurrowGate,
  setting the origin signing secret makes RabbitPay verify every request's
  BurrowGate signature and reject requests that bypassed it. `/api/health` is
  exempt so health checks keep working. With the secret set, every signed-in
  response also reports the RabbitPay username back to BurrowGate in signed
  `X-BurrowGate-Origin-User` headers, so BurrowGate's traffic log shows who made
  each request. BurrowGate removes those headers before the response reaches
  the browser. A proxy that is not configured makes
  every client share one rate-limit bucket, so one attacker can lock everyone
  out of logging in.
- Chat and calls use a WebSocket at `/api/v1/realtime`. The reverse proxy has
  to pass WebSocket upgrades through on HTTP/1.1, and the site has to be served
  over HTTPS for browsers to allow the microphone, camera and screen sharing.
  Live delivery is kept in the memory of one server process, so run RabbitPay
  as a single process. Group calls and meetings also need LiveKit media
  servers, see [Timesheets, tickets and payroll](workforce.md#calls).
- Shared cache, Adapter has to be reachable or nobody can log in. Sessions
  are written to both cache layers and a write must succeed in both. With the
  memory adapter everyone is signed out when the server restarts. The file and
  Redis adapters keep sessions across restarts.

### Store domains

Online stores can connect their own domain from Store settings. The settings
group Store domains decides how. Every mode first asks the merchant to add a
TXT record that proves they own the domain, and a store only answers on its
domain once the domain is active. After that, the store's `/shop/<slug>`
address redirects to the domain. RabbitPay rechecks waiting domains every five
minutes for two weeks, and the merchant can also check on demand.

- Manual is the default. RabbitPay checks the TXT record and that the domain
  points at the DNS target, either with a CNAME or with A and AAAA records that
  match the target. Apex domains therefore work with A records. You configure
  the reverse proxy and HTTPS certificate for each domain yourself.
- BurrowGate creates a site in your gateway for each domain, reusing the private
  origin of the BurrowGate site that serves RabbitPay, and issues a Let's
  Encrypt certificate for it. Set the BurrowGate URL, an admin token that can
  list, create and remove sites and manage their certificates, and the site id
  of your RabbitPay site. The new sites are signed with the same origin signing
  secret as the main site, so RabbitPay keeps rejecting requests that bypass
  BurrowGate. Point the DNS target at the gateway and keep HTTP open for ACME
  validation.
- Cloudflare for SaaS in front of BurrowGate is the hosted setup. RabbitPay
  creates a Cloudflare custom hostname and shows the merchant the TXT records
  Cloudflare asks for. Once Cloudflare validates them, RabbitPay creates the
  BurrowGate site and certificate as above. Before enabling it, create a
  proxied fallback origin in the SaaS zone that resolves to BurrowGate, select
  it as the Cloudflare for SaaS fallback origin, and create the proxied DNS
  target record pointing at it. The Cloudflare token only needs the zone-level
  SSL and Certificates Edit permission on that zone. Use Full (strict) mode
  once BurrowGate has issued the certificates.
- Disabled hides custom domains. Domains that are already active keep working.

The private origin setting is a fallback for when the RabbitPay site cannot be
read from BurrowGate. It must be an address BurrowGate reaches directly, such
as `http://127.0.0.1:8085`, and never the public URL, which would loop back
through the gateway. Deleting a project removes its Cloudflare hostname and
BurrowGate site.

### Email

Invoices, payment reminders, terminal receipts, license keys and team invitations
are sent over SMTP. Fill in Admin, Settings, Email and switch it on. Emails are queued in the
database and retried with a growing delay when the SMTP server is unavailable,
so a failed send never blocks a sale or an invoice. Each project turns reminders
on and sets their timing under Settings, Email. A white labeled project can send
through its own SMTP server instead.
