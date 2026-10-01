# Administration

The first account created on a server becomes its administrator and gets an
Admin link in the header. The Admin panel covers the whole server rather than a
single project.

| Page         | What it does                                                                              |
| ------------ | ----------------------------------------------------------------------------------------- |
| Overview     | Accounts, projects, payments this month, license sales by currency and the Server ID      |
| License keys | Create keys (on the issuing server), copy them, edit purchase details, revoke unused ones |
| Projects     | Usage this month, paid balance, storage, add-on end dates, apply a key to a project       |
| Accounts     | Administrators, suspension, two-factor reset, data export and account deletion            |
| Invite codes | Registration codes with a use limit, expiry and note, a signup link to copy, revocation   |
| Legal        | Terms of Service and Privacy Policy, with version history and acceptance counts           |
| Settings     | Every server setting                                                                      |

The Admin panel is in English only. It is for whoever runs the server, and its
setting labels come from [`server/settings-schema.ts`](../server/settings-schema.ts).

## Licensing

Every project gets a number of free completed payments each calendar month (UTC)
and an amount of document storage. The defaults are 50 payments and 1 GB. Past
the free payments, each completed payment takes one from the project's paid
balance. Pending, failed and refunded attempts do not count.

License keys add to a project:

| Type         | What it adds                                                               |
| ------------ | -------------------------------------------------------------------------- |
| Transactions | Payments added to the paid balance. They never expire.                     |
| Storage      | Document storage added permanently.                                        |
| White label  | Your own branding for a number of days.                                    |
| Online store | A web store for a number of days (see [Online store](online-store.md)).    |
| Workforce    | Timesheets, absences, tickets, employees and payroll for a number of days. |
| Employees    | More people in the workforce for a number of days.                         |

Keys with a duration start when they are redeemed, and a second key adds its days
to whatever is left. Several keys of any type can be redeemed on one project. A
project owner redeems keys under License in the project, and an administrator can
apply one under Admin, Projects.

A workforce license covers 5 people. Everyone who can log their own working time
(owners, administrators, supervisors and employees) or has an employee record
counts, while they are an active or suspended member. Pending invitations for
those roles hold a place too. An employee seat key adds a number of people for a
number of days. Unlike the other timed keys, seat keys do not add up in time:
each one runs from its own redemption, and the seats of all running keys are
added together.

Inviting someone who would log time, giving a member such a role, or creating an
employee record past the limit is refused with error `1243` (HTTP 402). If
seats run out while more people are in the workforce, timesheets, absences,
tickets and payroll become read only with the same error until a seat key is
redeemed or people are removed. Removing members and employee records still
works, and nothing is deleted.

When the paid balance runs out, new open invoices, issuing drafts, terminal sales
and recurring invoices are refused with error `1096` (HTTP 402). Drafts can still
be created. Money that arrives for an invoice that is already open is always
recorded. Those payments take the balance below zero, and the next transactions
key covers them first.

Invoice and credit note PDFs, original expense attachments, stored e-invoices,
FURS export packages and store photos count toward storage. When it is full,
existing documents stay available, but new issued invoices, attachments and
exports are refused with error `1126` until storage is added.

### The issuing server and licensed servers

License keys are signed. The server that sells licenses holds a private signing
key, and every copy of RabbitPay carries the matching public key. That server is
the issuer. Only the issuer can:

- create license keys,
- change the free allowance or turn off license limits under Admin, Settings,
  Licensing,
- give one project its own free limit under Admin, Projects.

Every other server is a licensed server. It uses the default free allowance, and
it only accepts keys signed for its Server ID. The Server ID is shown on the
Overview and License keys pages and looks like `RPS-80YC7-KTKMN-6NNP6-VHG0S`. It
is stored in the database, so every instance that shares the database has the
same ID, and moving the database to new hardware keeps it. Each signed key can be
redeemed once, and a key signed for another server is refused with error `1241`.

The issuer creates keys under Admin, License keys. Leaving "For a self-hosted
server" empty creates a key for a project on the issuer itself, which looks like
`RPAY-7K2QM-X4D9T-HB3WN-0PZ5R`. Entering a customer's Server ID creates a signed
key starting with `RPAY2.` that only works on that server. Keys signed for other
servers cannot be revoked, since the issuer cannot reach them. The issuer can
also sell keys in its online store, where buyers choose the amounts and get the
key once the invoice is paid, see [RabbitPay licenses](online-store.md#rabbitpay-licenses).

To set up an issuer, generate the key pair once:

```bash
bun run license:keygen
```

Put the printed public key in `ISSUER_PUBLIC_KEY` in
[`server/license-signing.ts`](../server/license-signing.ts) and ship it with the
release. Put `RABBITPAY_LICENSE_SIGNING_KEY` only in the `.env` of the issuing
server and keep a copy somewhere safe. A server whose signing key does not match
the built-in public key is not an issuer, and logs an error on start.

### White labeling

While a white label license is active, the project can:

- upload a logo (PNG, JPEG or WebP up to 150 KB) shown on the payment page, on
  printed invoices and credit notes, and at the top of emails,
- send its emails through its own SMTP server and from its own address,
- remove "Powered by RabbitPay" from the payment page and printed documents, and
  "with RabbitPay" from emails,
- design its documents under Settings, Invoice design: a classic, modern or
  compact layout, a sans serif or serif font, an accent color, logo size and
  position, a header line, footer text, default texts for invoices, receipts and
  credit notes, and which contact details to show. A live preview shows the
  result, and Open PDF renders the exact file. The seller's legal details, the
  tax summary and fiscal marks are always printed. Each issued document keeps
  the design it was issued with.
- design its customer emails under Settings, Email design: an accent color,
  whether the logo and address are shown, a signature, a footer line, and the
  subject, heading, message, button text and closing of every customer email.
  Texts can use placeholders such as `{merchant}`, `{reference}`, `{amount}` and
  `{date}`. Empty texts keep the default wording in the project language.

When it ends, RabbitPay branding returns and the server's email settings are used
again. The logo and email server are kept for the next white label license.

When an online store license ends, the store shows a closed page and takes no
orders. Products, categories, photos, orders and settings are kept.

## Registrations

Admin, Settings, Registrations controls who can create an account:

- Anyone can register (the default).
- Only with an invite code. The register form asks for a code created under
  Admin, Invite codes. People invited to a project can still register through
  their invitation link, with the invited email.
- Nobody can register.

Maximum accounts closes registration once that many accounts exist. The very
first account can always be created, so a new server cannot lock itself out.

Invite codes look like `JOIN-7K2QM-X4D9T-HB3WN` and are case insensitive, with
`O`, `I` and `L` read as `0` and `1`. A code can allow any number of
registrations and can expire. Revoking it keeps the accounts already created
with it. Every registration is recorded in the audit log with the code or
invitation it used.

## Accounts

Admin, Accounts lists every account with its projects, status and whether it
uses two-factor authentication. An administrator can:

- make another account an administrator, or remove that,
- suspend an account, which signs it out on its next request and blocks sign-in
  until it is reactivated,
- reset two-factor authentication for someone who lost their authenticator or
  security key. This removes the authenticator app, all security keys and the
  recovery codes, so they can sign in with only their password and set it up
  again. Confirm who is asking before doing this.
- export an account's personal data as JSON, to answer an access request,
- delete an account.

Deleting an account removes its sign-in, email address, two-factor settings,
security keys, accepted terms and access logs, and clears the IP addresses and
browser details from its audit entries. Business records stay with their
projects: the person is detached from each project, so invoices, timesheets and
payroll they worked on keep the name recorded on them. Projects where the
account was the only member are closed. Deletion is refused while the account is
the only owner of a project that other people still use (error `1239`), so make
someone else an owner first. The admin types the username to confirm.

Users can download the same export themselves under Account, Your data.

## Legal pages

Admin, Settings, Operator and legal holds who runs the server: the operator's
legal name, address, business register, registration and tax numbers, VAT
status, contact email and phone, and whether only business customers may
register. They are shown at `/legal`. Nothing is shown until the operator name
is set, so a new server does not publish anybody's details.

Admin, Legal publishes the Terms of Service and the Privacy Policy, in English,
Slovenian or both, at `/terms` and `/privacy`. Fill from template creates a draft
from the operator details and the server settings, including the subprocessors
it detects (Cloudflare as a proxy or as R2 storage) and the retention periods.
Review every template before publishing and have it checked by a lawyer.

Published versions are kept and cannot be edited. A version can take effect
right away or on a later date, and the current version stays in force until
then. Publishing can email every active account about the change. Once Terms of
Service exist, registration requires accepting them, and the accepted versions
are stored with the time, IP address and browser. When a new version takes
effect, every account must accept it the next time it opens RabbitPay. Before
that, signed-in users see a notice with the date. The Legal page shows how many
accounts accepted each version.

## Admin API

All of these need an administrator session.

| Method   | Path                                          | Purpose                                      |
| -------- | --------------------------------------------- | -------------------------------------------- |
| `GET`    | `/api/v1/admin/overview`                      | Totals, Server ID and issuer status.         |
| `GET`    | `/api/v1/admin/settings`                      | Every setting. Secrets only say whether set. |
| `PATCH`  | `/api/v1/admin/settings`                      | Change settings.                             |
| `POST`   | `/api/v1/admin/settings/:group/test`          | Test the connection for `btc` or `eth`.      |
| `GET`    | `/api/v1/admin/backups`                       | Backup destinations and the newest backups.  |
| `POST`   | `/api/v1/admin/backups`                       | Run a backup now.                            |
| `GET`    | `/api/v1/admin/licenses`                      | List license keys.                           |
| `POST`   | `/api/v1/admin/licenses`                      | Create keys (issuer only).                   |
| `PATCH`  | `/api/v1/admin/licenses/:license`             | Change purchase details.                     |
| `POST`   | `/api/v1/admin/licenses/:license/revoke`      | Revoke an unused key.                        |
| `GET`    | `/api/v1/admin/projects`                      | Projects with their usage.                   |
| `PATCH`  | `/api/v1/admin/projects/:project`             | Set a project's free limit (issuer only).    |
| `POST`   | `/api/v1/admin/projects/:project/licenses`    | Apply a key to a project.                    |
| `GET`    | `/api/v1/admin/accounts`                      | List accounts.                               |
| `PATCH`  | `/api/v1/admin/accounts/:username`            | Change administrator status or suspension.   |
| `DELETE` | `/api/v1/admin/accounts/:username/two-factor` | Reset two-factor authentication.             |
| `GET`    | `/api/v1/admin/accounts/:username/export`     | Download the account's personal data.        |
| `GET`    | `/api/v1/admin/accounts/:username/deletion`   | What deleting the account would do.          |
| `DELETE` | `/api/v1/admin/accounts/:username`            | Delete the account (`confirm` = username).   |
| `GET`    | `/api/v1/admin/invites`                       | List invite codes.                           |
| `POST`   | `/api/v1/admin/invites`                       | Create an invite code.                       |
| `POST`   | `/api/v1/admin/invites/:invite/revoke`        | Revoke an invite code.                       |
| `GET`    | `/api/v1/admin/legal`                         | Legal documents with their history.          |
| `GET`    | `/api/v1/admin/legal/:kind/template`          | A filled template (`?language=en` or `sl`).  |
| `POST`   | `/api/v1/admin/legal/:kind`                   | Publish a new version.                       |

```bash
curl -X POST http://localhost:8085/api/v1/admin/licenses \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"transactions","transactions":10000,"quantity":5,"server_id":"RPS-80YC7-KTKMN-6NNP6-VHG0S"}'

curl -X PATCH http://localhost:8085/api/v1/admin/settings \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"values":{"email.enabled":true,"registrations.mode":"invite"}}'
```

A secret setting that is left out or sent as `""` keeps its value, and `null`
clears it.

Project owners use these for licensing and branding:

| Method   | Path                                       | Permission     |
| -------- | ------------------------------------------ | -------------- |
| `GET`    | `/api/v1/projects/:uuid/license`           | `project.view` |
| `POST`   | `/api/v1/projects/:uuid/license/redeem`    | `project.edit` |
| `PUT`    | `/api/v1/projects/:uuid/branding/logo`     | `project.edit` |
| `DELETE` | `/api/v1/projects/:uuid/branding/logo`     | `project.edit` |
| `GET`    | `/api/v1/projects/:uuid/email-server`      | `project.edit` |
| `PUT`    | `/api/v1/projects/:uuid/email-server`      | `project.edit` |
| `DELETE` | `/api/v1/projects/:uuid/email-server`      | `project.edit` |
| `POST`   | `/api/v1/projects/:uuid/email-server/test` | `project.edit` |
| `GET`    | `/api/v1/public/projects/:uuid/logo`       | anyone         |
