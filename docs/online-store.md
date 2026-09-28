# Online store

A project with an online store license can sell its catalogue items in its own
web store. Open the project and choose Store.

## Settings

The store gets a web address such as `/shop/pixel-parts` and can
also answer on a custom domain. Point the domain's DNS at this server, serve it
over HTTPS through your reverse proxy, and enter it under Custom domain. The
same page sets the name, tagline, search engine description, language (`en` or
`sl`), announcement bar, logo, hero image and text, accent color, color scheme,
font, corners, card style, products per row and optional custom CSS. Fonts are
system fonts, so the storefront loads nothing from other servers. Contact
details, social links (Discord, Instagram, Facebook, X, YouTube, TikTok and
more), a physical location with opening hours and an "open now" badge, shipping
options with free shipping thresholds and in store pickup, default preparation
times, the order cutoff hour, payment days and extra pages written in Markdown
are all set here. A privacy policy and terms of sale are required. New stores
start with templates for both and for a withdrawal page with the official model
withdrawal form, filled in with the company details. They follow the GDPR,
ZVOP-2, ZEKom-2 and the consumer protection act ZVPot-1. A Slovenian seller
with an English store also gets the Slovenian text on each page, since
consumers in Slovenia must be served in Slovenian. Saved stores keep their own
text. Replace with the current template in the page editor brings in the
latest version. Fill in the company details before creating the store.

## Products

Every item from Items can be listed. The listing adds a web
address, category, short summary, a Markdown description (headings, lists,
tables, links and images, with raw HTML always escaped), up to 12 photos,
specifications that customers filter by (for example `Proizvajalec: Asus` or
`Grafična kartica: Radeon RX 9060 XT`), a crossed out "was" price, stock with
an optional expected restock date, backorders and a custom preparation time.
Photos are converted to WebP in the browser, stored in the document storage and
count toward the storage allowance. Price and VAT come from the item. Items
that sell license keys take their stock from the keys.

## RabbitPay licenses

The license issuer can sell its own license keys through a store. On the issuer,
a server administrator who edits an item in a project owned by an
administrator sees a RabbitPay license section. It turns the item into one
license type with a rate and a minimum price, both before VAT:

| Type           | Rate                     | Buyer chooses      |
| -------------- | ------------------------ | ------------------ |
| Payments       | Per 1,000 payments       | Payments           |
| Storage        | Per GB                   | GB                 |
| White label    | Per 30 days              | Days               |
| Online store   | Per 30 days              | Days               |
| Workforce      | Per 30 days              | Days               |
| Employee seats | Per employee for 30 days | Employees and days |

The item also sets the lowest and highest amount and number of days a buyer can
choose. The product page asks for these values and an optional Server ID, and
shows the price as they change. Through the API, such a cart line carries
`license: { "amount": 20, "days": 365, "server_id": "RPS-..." }` next to
`product` and `quantity`. Each choice is its own cart line, and the
invoice line names what was bought, for example
`Employee seats (20 employees, 365 days, server RPS-...)`. The server calculates
every price again at checkout and ignores prices sent by the browser.

A license product has no stock. When the invoice is paid, including a bank
transfer recorded by hand, the keys are created and emailed with the other keys
on the order. A key with a Server ID is signed for that server, and one without
works on the issuer. The keys keep the order number, price and buyer, and are
listed under Admin, License keys. Choices are saved with the order, so changing
the item's rates later does not change orders already placed. Only the store
creates these keys: an invoice or terminal sale of the same item does not.

License products stop selling when the server is no longer the issuer or no
owner of the project is an active administrator. A delivered key cannot be
taken back with a credit note. Revoke an unused key under Admin, License keys.

## Categories

Categories can be nested. A category page shows the products of its
subcategories too, with filters built from the specifications of the products
on that page. Values of one specification are combined with "or", different
specifications with "and".

## Checkout

Customers keep their cart in the browser and sign in with an
emailed link before paying, so every order belongs to a verified email address.
The order button reads "Order with obligation to pay", and checkout requires
accepting the terms. A cart with license keys also requires the customer to
agree that delivery starts right away and that they lose the right of
withdrawal. Both consents are recorded with a timestamp in the invoice
metadata.
Their billing and delivery details are saved for next time if they choose. The
order becomes an issued invoice on the project, with the store's shipping as a
line when it costs anything, and the customer pays it on the regular payment
page with any enabled payment method. Physical stock is taken when the order is
placed. Prices shown in the store include VAT for the seller's country. VAT for
the buyer's country, OSS and reverse charge follow the same rules as invoices.
Orders are refused while the project has no payment method, no payments or
storage left, or a locked accounting period.

## Orders

The Orders tab lists store orders with a "paid, to ship" view.
Moving an order to preparing, shipped (with a tracking link) or delivered can
email the customer. Canceling an order that is not shipped cancels an unpaid
invoice with a credit note and returns the stock. A paid order is refunded
separately under Payments.

## Privacy

The storefront sets no tracking or advertising cookies and keeps
only the cart, the sign in and the dismissal of its privacy notice in the
browser. Customers export or delete their data from the customer portal or the
store's account page. Checkout requires accepting the terms and privacy policy.
Search engines may list the store pages, never checkout, account or payment
pages, and the store can opt out entirely.

## API

| Method   | Path                                                  | Description                                 |
| -------- | ----------------------------------------------------- | ------------------------------------------- |
| `GET`    | `/api/v1/projects/:uuid/store`                        | Store settings, license and counts.         |
| `PUT`    | `/api/v1/projects/:uuid/store`                        | Save `slug`, `domain`, `enabled`, `config`. |
| `PUT`    | `/api/v1/projects/:uuid/store/images/:kind`           | Upload the `logo` or `hero` image.          |
| `GET`    | `/api/v1/projects/:uuid/store/categories`             | List categories.                            |
| `POST`   | `/api/v1/projects/:uuid/store/categories`             | Create a category.                          |
| `PATCH`  | `/api/v1/projects/:uuid/store/categories/:category`   | Change a category.                          |
| `DELETE` | `/api/v1/projects/:uuid/store/categories/:category`   | Delete a category.                          |
| `GET`    | `/api/v1/projects/:uuid/store/products`               | Catalogue items with their store listing.   |
| `GET`    | `/api/v1/projects/:uuid/store/products/:item`         | One listing.                                |
| `PUT`    | `/api/v1/projects/:uuid/store/products/:item`         | Create or change a listing.                 |
| `DELETE` | `/api/v1/projects/:uuid/store/products/:item`         | Remove an item from the store.              |
| `POST`   | `/api/v1/projects/:uuid/store/products/:item/images`  | Add a photo.                                |
| `PUT`    | `/api/v1/projects/:uuid/store/products/:item/images`  | Reorder photos and set their alt texts.     |
| `GET`    | `/api/v1/projects/:uuid/store/orders`                 | List orders.                                |
| `PATCH`  | `/api/v1/projects/:uuid/store/orders/:invoice`        | Change fulfillment or the tracking link.    |
| `POST`   | `/api/v1/projects/:uuid/store/orders/:invoice/cancel` | Cancel an order.                            |
| `GET`    | `/api/v1/store/:slug`                                 | Public store settings and categories.       |
| `GET`    | `/api/v1/store/:slug/products`                        | Search, filter and sort products.           |
| `GET`    | `/api/v1/store/:slug/products/:product`               | One product with photos and specifications. |
| `POST`   | `/api/v1/store/:slug/quote`                           | Price a cart with shipping and VAT.         |
| `POST`   | `/api/v1/store/:slug/checkout`                        | Place an order as a signed in customer.     |
| `GET`    | `/api/v1/store/:slug/orders/:invoice`                 | The customer's own order.                   |
| `GET`    | `/api/v1/public/store-images/:image`                  | A store photo.                              |

The product list accepts `category`, `q`, `sort` (`featured`, `newest`,
`price_asc`, `price_desc` or `name`), `stock=1`, `featured=1`, `facets=1`,
`limit`, `offset` and any number of `f=Name=Value` filters. Store settings and
categories need the project edit and item permissions, orders need the invoice
permissions.
