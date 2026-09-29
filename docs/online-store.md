# Online store

A project with an online store license can sell its catalogue items in its own
web store. Open the project and choose Store.

## Settings

The store gets a web address such as `/shop/pixel-parts` and can
also answer on a custom domain. Point the domain's DNS at this server, serve it
over HTTPS through your reverse proxy, and enter it under Custom domain. The
same page sets the name, tagline, search engine description, default language,
announcement bar, logo, hero image and text, accent color, color scheme,
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

## Translations

English and Slovenian are built in. The Translations tab lists the store's
languages and lets you add any other one by its code, such as `it`, `de` or
`pt-BR`, up to 10 languages in total. Each language can be shown in the store or
kept hidden while you translate it. Shoppers see the default language first and
switch between the shown ones in the footer or the mobile menu. The choice is
remembered in their browser, and a link ending in `?lang=it` opens the store in
that language.

Edit texts covers every text the storefront shows, from buttons and checkout
labels to statuses, counts and error messages. In English and Slovenian you can
replace any built-in text with your own wording, and only that language changes.
In an added language every text you leave empty appears in the default
language, or in English when the default is itself an added language. Counted
texts ask for the plural forms of the language, and a text must keep
placeholders such as `{count}`. Dates, prices and country names follow the
shopper's language. Sign in emails use the shopper's language when it is
English or Slovenian.

Your own content is translated where you write it. The product editor and the
category dialog show a tab for each extra language with the name, summary and
description, and the language's page under Translations has a Your store
content section for the texts from Settings: tagline, description, announcement,
hero, location, shipping options, footer text and pages. Any field left empty
shows the default language text. Store search also finds products by their
translated name and summary. Orders, invoices and order emails keep the default
language text, and specifications stay as written because shoppers filter by
them. Deleting a language deletes its product and category translations too.

When you switch the default between English and Slovenian, saving the settings
replaces the texts a new store starts with (hero subtitle, button label, standard
shipping name and the legal page templates) with the other language's version,
as long as you have not edited them.

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
Their billing and delivery details are saved for next time if they choose.
Prices shown in the store include VAT for the seller's country. VAT for the
buyer's country, OSS and reverse charge follow the same rules as invoices.
Orders are refused while the project has no payment method, no payments or
storage left, a locked accounting period, or company details an invoice needs.

## Payment and invoicing

A new order is not an invoice yet. It is a draft with an order number from the
order series under Settings, Document numbers, `ORDER-26000001` by default, the
store's shipping as a line when it costs anything, and the payment deadline from
the store settings. The customer gets an order email with an order confirmation
PDF and a link to the regular payment page, which offers every enabled payment
method. The confirmation can be downloaded again from the order page. A bank transfer uses the order number in its RF reference. Physical
stock and license keys from a key pool are held for the order as soon as it is
placed.

The invoice is issued when the first payment settles, whether a card payment,
a confirmed crypto payment or a bank transfer recorded under Payments. It gets
the next invoice number, today's issue and supply date, and is verified with
FURS when the payment method needs it. The customer then receives the invoice
as a PDF, followed by any license keys. Invoice numbers are only used for
orders that are paid, so abandoned orders leave no gaps and need no credit
notes. The order keeps its order number, and both numbers are shown on the
order page.

An order that has received no payment 7 days after its payment deadline is
canceled automatically: the stock and keys are released and a coupon use is
returned. A payment for a canceled order cannot be recorded, so a late bank
transfer is refunded. While an order waits for payment, it cannot be edited or
deleted under Invoices, only canceled from the store's Orders tab.

## Orders

The Orders tab lists store orders with a "paid, to ship" view.
Moving an order to preparing, shipped (with a tracking link) or delivered can
email the customer. Canceling an order that is not shipped returns the stock.
An order waiting for payment is canceled without an invoice. One whose invoice
was issued by hand under Invoices is canceled with a credit note. A paid order
is refunded separately under Payments. Search finds orders by order number,
invoice number, email or name.

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
