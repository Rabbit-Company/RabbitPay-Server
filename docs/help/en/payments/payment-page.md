# The payment page

Every issued invoice has its own page where the customer pays. It needs no account and no password, and it works on a phone.

## Send the link

The link is in every invoice email when **Include a link to the payment page** is on. To send it yourself:

1. Open the invoice and press **Send**.
2. Choose **Copy payment link** and paste it into a message.

   ![Copy payment link in the Send menu](https://cdn.rabbitpay.net/help/en/dark/payments/payment-page/copy-link.webp)

**Open payment page** in the same menu shows you the page.

> **Important:** Anyone who has the link can open the page. Send it only to the customer it is meant for. The page shows nothing about your other invoices or customers.

## What the page shows

![The payment page of an open invoice](https://cdn.rabbitpay.net/help/en/dark/payments/payment-page/page.webp)

The top card shows your business name, the amount, the invoice number, what is still due and the due date, with a button to download the invoice as a PDF.

![The summary at the top](https://cdn.rabbitpay.net/help/en/dark/payments/payment-page/summary.webp)

Below it the customer chooses how to pay. Only the methods you switched on are listed.

![The ways to pay](https://cdn.rabbitpay.net/help/en/dark/payments/payment-page/methods.webp)

**What this is for** lists the lines of the invoice.

The page is written in the language of your invoices and uses the accent color of your project. See [Design and wording](invoices/design).

## On a phone

The page fits a phone screen, so a customer can pay straight from the email.

![The payment page on a phone](https://cdn.rabbitpay.net/help/en/dark/payments/payment-page/phone.webp)

## After the payment

Payments by card, PayPal or crypto are recognised by themselves. The page changes to **Paid** while the customer is still looking at it.

![The page after the invoice was paid](https://cdn.rabbitpay.net/help/en/dark/payments/payment-page/paid.webp)

A bank transfer is checked by hand, so the page says that it will not update on its own. It shows **Paid** once you [record the payment](invoices/record-payment).

A draft has no payment page. A canceled invoice can no longer be paid.

## Put the payment page on your own website

If you have a website, a customer can pay without leaving it. Ask whoever maintains your site to add these two lines, with the id of the invoice:

```html
<div data-rabbitpay-invoice="INVOICE-ID" data-rabbitpay-label="Pay now"></div>
<script src="https://rabbitpay.net/embed.js"></script>
```

This shows a button that opens the payment page in a window over your site.
