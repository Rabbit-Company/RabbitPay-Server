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

The help section at `/help` is built from [`docs/help`](help). It is split into
modules, and a module has pages. Each module is a folder per language:
`docs/help/en/invoices/index.md` is the module itself, served at
`/help/en/invoices`, and `docs/help/en/getting-started/first-invoice.md` is one
of its pages, served at `/help/en/getting-started/first-invoice`. The Slovenian
files sit under `docs/help/sl` with the same names. The first `# ` heading is
the title, the first paragraph is the description shown on cards and to search
engines, and every `## ` heading becomes an entry under On this page and a
target for search.

To add a page, write it in both languages under the same file name and register
both files in [`server/help-sources.ts`](../server/help-sources.ts), in the
order they should be read. The file name is the address, so keep it in lowercase
English with dashes. [`tests/help.test.ts`](../tests/help.test.ts) fails when a
page is missing in one language, is not registered, has a different number of
sections in the two languages, links to a page or a section that does not
exist, or shows a screenshot that was never captured. Link to another page from
the root of the help, as in `[Payments](payments)` or
`[Sign in](getting-started/create-account#sign-in)`, so the link stays in the
reader's language.

### Screenshots

Screenshots are not kept in the repository. They live on the CDN under
`https://cdn.rabbitpay.net/help/<language>/<theme>/<module>/<page>/<name>.webp`,
once in the dark and once in the light theme. A page names only the dark one:

```markdown
![The registration form](https://cdn.rabbitpay.net/help/en/dark/getting-started/create-account/register.webp)
```

The help page shows the image that matches the reader's theme, with the alt text
as its caption.

`bun run help:shots` takes every screenshot again. It starts a throwaway server
on port 8096 with an empty database, plays each guide in
[`tools/help-shots/guides`](../tools/help-shots/guides) in a headless Chrome in
both languages, and writes the images to `cdn/`, which is laid out exactly like
the bucket. Upload the content of `cdn/` to the root of the bucket. The command
also rewrites [`server/help-shots.ts`](../server/help-shots.ts) with the size
and a version of every image, so pages reserve the right space and browsers
fetch a changed image again. Commit that file together with the pages.

| Option                    | What it does                                                        |
| ------------------------- | ------------------------------------------------------------------- |
| `--languages en`          | Only one language                                                   |
| `--out <folder>`          | Where the images go, `cdn` by default                               |
| `--keep`                  | Leaves the throwaway server running, to look at it or to continue   |
| `--reuse --steps <names>` | Runs only the named steps of a guide against the server kept before |

The people and companies in the screenshots are defined in
[`tools/help-shots/demo.ts`](../tools/help-shots/demo.ts). The business that
issues the invoices is made up and added to the throwaway copy of the company
register, so the lookup finds it. Build the interface with `bun run build:web`
first, because the throwaway server serves `web/dist`.

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
