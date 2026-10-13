# Online store

Sell the items from your catalogue in your own web store, with a cart, checkout, order emails and invoices that issue themselves when the customer pays.

## Open your store

The online store is a paid module. Open **Store** in your project and redeem an online store license if you have not done so yet.

1. Fill in your company details under **Settings** > **Company details**. The store needs them for invoices and legal pages.
2. Switch on at least one payment method. See [Payments](payments).
3. Open **Store**, choose the store name and web address, and press **Create store**.

A new store starts with a privacy policy, terms of sale and a withdrawal page that are already filled in with your company details. Read them and adjust them to how you sell. A privacy policy and terms of sale are required.

Switch on **Store is open** when you are ready for customers.

## Make the store yours

Everything about how the store looks and works is under **Store** > **Settings**.

- **General**: name, tagline, default language, web address and an announcement bar.
- **Appearance**: logo, hero image and text, accent color, color scheme, font, corners, product cards and products per row.
- **Custom domain**: connect your own domain and follow the DNS instructions shown there.
- **Physical store**: address, map link and opening hours.
- **Shipping and delivery**: shipping options with prices, free shipping above an amount, in store pickup and preparation time.
- **Checkout**: how many days a customer has to pay and whether order notes are allowed.
- **Pages and legal texts**: your legal pages and any extra pages, written in Markdown.

## Add products and categories

Every item under **Items** can be sold in the store. Price and VAT always come from the item.

1. Open **Store** > **Products** and press **Add to store** on an item.
2. Add a short summary, a description, up to 12 photos and specifications such as `Color: Black`. Customers filter products by specifications.
3. Choose a category and switch on **For sale in the store**.

Switch on **Track stock** to stop selling a product when it runs out. An expected restock date tells customers when it is back. Items that sell license keys take their stock from the keys.

Create categories under **Store** > **Categories**. Categories can be nested, and a category page also shows the products of its subcategories.

## Offer coupons

Under **Store** > **Coupons**, press **New coupon** and choose what it gives: a percentage off, a fixed amount off or free shipping. You can limit a coupon to a period, to a total number of uses and to one use per customer.

## Sell in more languages

English and Slovenian are built in. Under **Store** > **Translations** you can add up to 10 languages in total, translate them at your own pace and show each one in the store when it is ready.

- **Edit texts** changes any text the store shows, from buttons to checkout labels.
- Product and category names and descriptions are translated where you write them, on a tab for each language.
- A text you leave empty is shown in the default language.

Orders, invoices and order emails stay in the default language.

## Handle orders

A customer signs in with a link sent to their email and places an order. They receive an order confirmation with a link to the payment page, and the stock is held for them.

**Store** > **Orders** lists the orders. The **Paid, to ship** view shows what to send next.

1. Open the order and press **Start preparing**.
2. When it leaves, add a tracking link and press **Mark as shipped**.
3. Press **Mark as delivered** when it arrives.

Each step can send the customer an email. **Cancel order** on an order that has not shipped returns the stock.

## How orders become invoices

An order is not an invoice yet. It has an order number such as `ORDER-26000001` and waits for payment.

The invoice is issued when the first payment arrives, whether by card, crypto or a bank transfer that you record. It gets the next invoice number and is sent to the customer as a PDF, followed by any license keys. Because only paid orders get an invoice number, abandoned orders leave no gaps and need no credit notes.

An order that is still unpaid 7 days after its payment deadline is canceled automatically and its stock is released.

To refund a paid order, refund the payment on its invoice. See [Invoices](invoices).

## Privacy in your store

The store sets no tracking or advertising cookies. Customers must accept your terms and privacy policy at checkout, and they can export or delete their data from their account page. Search engines may list your store and product pages, never the cart, checkout or account pages.
