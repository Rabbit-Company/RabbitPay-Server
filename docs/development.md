# Development

## Web interface

The management interface lives in [`web/`](../web) and is served by the same Bun
process at the root path. It covers everything the API does: signing in,
projects, invoices with a line item editor, customers, the team and its roles,
API key rotation and project settings.

```bash
bun run build:web
```

It is plain TypeScript bundled by Bun, with no frontend framework. Requests to
`/api/` and `/metrics` always answer as the API, and anything else falls back to
the app shell so client side routes survive a refresh.

Passwords are hashed with `@rabbit-company/blake2b` in the browser before they
are sent, matching what the API expects, and the session token is kept in
`localStorage`. The invoice editor imports
[`server/invoicing.ts`](../server/invoicing.ts) directly rather than reimplementing
the arithmetic, so the total previewed while editing is produced by the same code
that computes the authoritative one on save.

To work on it, run `bun run watch:web` alongside `bun run watch`.

## Help articles

The help section at `/help` is built from [`docs/help`](help), with one Markdown
file per article in each language: `docs/help/en/invoices.md` and
`docs/help/sl/invoices.md` are the same article, served at `/help/en/invoices`
and `/help/sl/invoices`. The first `# ` heading is the title, the first
paragraph is the description shown on the index and to search engines, and
every `## ` heading becomes an entry under On this page.

To add an article, write it in both languages under the same file name and
register both files in `SOURCES` in [`server/help.ts`](../server/help.ts). The
file name is the address, so keep it in lowercase English with dashes.
[`tests/help.test.ts`](../tests/help.test.ts) fails when an article is missing
in one language, is not registered, has a different number of sections in the
two languages, or links to a section or an article that does not exist. Link to
another article by its file name alone, as in `[Payments](payments)`, so the
link stays in the reader's language.

The server sends a help page with the article already in it, along with its
title, description and language alternates, so it reads before the interface
loads and search engines index the text. The interface then takes over the page
from the same data, without asking the API again. The home page follows the same
idea for its title and description: `/` is English and `/sl` is Slovenian, each
pointing at the other, as listed in `HOME_PAGES` in
[`server/web.ts`](../server/web.ts).

Write for somebody using the dashboard: start from what they want to do, name
buttons and menus exactly as the interface does in that language, and leave
API details to [`api.md`](api.md).

## Commands

```bash
bun run watch      # restart on change
bun run test       # no network or external services needed
bun run typecheck
bun run build      # compile a standalone binary
bun run build:web  # bundle the web interface into web/dist
bun run watch:web  # rebuild the interface on change
```

Tests drive the app in-process through `Server.app.handle()` against the same
middleware stack production uses, with settings from
[`tests/environment.ts`](../tests/environment.ts) written into a throwaway
database, so no Redis is required.

## Adding an endpoint

Endpoint modules register their own routes as a side effect of being imported.
`Server.configure()` walks `server/endpoints/` and imports every `.ts` file. A
file that only exports a handler function registers nothing:

```ts
import { Server } from "../../server";

Server.app.get("/api/v1/thing/:uuid", Auth.required(), Permissions.require(Permission.PROJECT_VIEW), async (ctx) => {
  return Utils.ok(ctx, { ... });
});
```

## Queries

Queries use Bun's tagged template SQL, which parameterises every interpolated
value:

```ts
const [account] = (await Database`SELECT * FROM accounts WHERE username = ${username}`) as AccountRow[];

await Database.begin(async (tx) => {
	await tx`INSERT INTO invoices ...`;
	await tx`INSERT INTO invoice_items ...`;
});
```

A query always resolves to an array, so a single row is taken by destructuring
the first element rather than a `.get()` call.

## Schema changes

[`server/database/schema.ts`](../server/database/schema.ts) is migration 1, the
baseline, and must not change again. Every later change is a new entry at the
end of `MIGRATIONS` in
[`server/database/migrations.ts`](../server/database/migrations.ts) with the next
version number:

```ts
{
	version: 2,
	name: "customer nickname",
	up: async (sql, dialect) => {
		await sql.unsafe(`ALTER TABLE customers ADD COLUMN nickname ${schemaTypes(dialect).text("nickname")}`);
	},
},
```

Never edit or reorder a migration that has shipped. MySQL commits DDL
statements immediately, so keep each MySQL migration to steps that can be
repeated safely.

## List pagination

Lists use pages of 50 records with Previous and Next controls. This includes
customers, payments, items, key stock, recurring invoices, recurring expenses,
projects, team members, webhook history, invoice histories, license history,
terminal items and terminal sales. Long report tables also have page controls.
Report summaries and CSV exports include the full result set.

Search and status changes return to the first page. If records are removed from
the last page, the list returns to the last available page. Customer and item
search counts match the filtered results. Webhook delivery and terminal sale
counts remain totals for the full selection.
