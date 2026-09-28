# Customer portal

The customer portal is where the people and companies you invoice see their
documents. It is separate from the business dashboard.

Customers sign in at `/customer/login` using an email link. The server email
service must be configured and enabled. Links expire after 15 minutes and can
be used once. Customers confirm the link before a session is created.

Customer accounts and sessions are separate from business accounts. The same
email can use both portals, and signing out of one leaves the other signed in.
Customer sessions use the configured `session_ttl` and never grant project
membership or business permissions.

The portal lists issued invoices addressed to the verified email across all
projects on this server. It offers unpaid, overdue and paid filters, invoice
details, printing, PDF downloads, payment links and related credit notes.
Drafts, unissued cancellations and invoices from deleted projects are excluded.
Existing public invoice payment links continue to work.

The recipient email and details are saved when an invoice is issued. Editing
a customer later does not transfer access to earlier invoices or change their
printed buyer details.

| Method   | Path                                        | Description                               |
| -------- | ------------------------------------------- | ----------------------------------------- |
| `POST`   | `/api/v1/customer/auth/request`             | Email a login link.                       |
| `POST`   | `/api/v1/customer/auth/verify`              | Exchange a link for a session.            |
| `GET`    | `/api/v1/customer/auth/me`                  | The verified customer email.              |
| `POST`   | `/api/v1/customer/auth/logout`              | Revoke the customer session.              |
| `GET`    | `/api/v1/customer/invoices`                 | List the customer's invoices.             |
| `GET`    | `/api/v1/customer/invoices/:invoice`        | Invoice and related credits.              |
| `GET`    | `/api/v1/customer/invoices/:invoice/pdf`    | Download the invoice PDF.                 |
| `GET`    | `/api/v1/customer/invoices/:invoice/eslog`  | Download the invoice as e-SLOG XML.       |
| `GET`    | `/api/v1/customer/credit-notes/:note`       | Read a related credit note.               |
| `GET`    | `/api/v1/customer/credit-notes/:note/pdf`   | Download the credit note PDF.             |
| `GET`    | `/api/v1/customer/credit-notes/:note/eslog` | Download the credit note as e-SLOG XML.   |
| `GET`    | `/api/v1/customer/profile`                  | Saved checkout details.                   |
| `PUT`    | `/api/v1/customer/profile`                  | Save billing and delivery defaults.       |
| `DELETE` | `/api/v1/customer/profile`                  | Forget the saved details.                 |
| `GET`    | `/api/v1/customer/orders`                   | Store orders placed with this email.      |
| `GET`    | `/api/v1/customer/export`                   | Download all personal data as JSON.       |
| `DELETE` | `/api/v1/customer/account`                  | Delete the customer account and profile.  |
| `GET`    | `/api/v1/customer/tickets`                  | Support tickets shared with the customer. |
| `POST`   | `/api/v1/customer/tickets`                  | Open a new ticket.                        |
| `GET`    | `/api/v1/customer/tickets/:ticket`          | One ticket with its comments.             |
| `POST`   | `/api/v1/customer/tickets/:ticket/comments` | Reply to a ticket.                        |

The request endpoint accepts `email`, an optional `language` of `en` or `sl`, and
optionally `store` (a store web address) and `return` (a path on this server).
With a store, the email carries the store's name, color and language, links to
the store's own domain when it has one, and the customer lands back on `return`
after signing in.

Deleting an account removes the profile, sign in and pending login links right
away. Issued invoices stay with the seller because tax law requires keeping
them.

Verification accepts `token`. Subsequent requests use the customer token in
`Authorization: Bearer <token>`. The invoice list accepts `limit`, `offset` and
an optional `status` of `unpaid`, `overdue` or `paid`.

Support tickets are off for customers by default. A project member with ticket
permissions gives a customer portal access, and marks the tickets that customer
may see. The customer can then read those tickets, reply and open new ones.
