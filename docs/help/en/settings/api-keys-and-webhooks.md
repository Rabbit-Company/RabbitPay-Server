# API keys and webhooks

Connect your web shop, booking system or other software, so it can create invoices and hear when they are paid.

## API keys

An API key lets another program call RabbitPay under /api/v1/pay. It can create customers, raise invoices and check whether they are paid. A key cannot manage the project, its team or its keys, and cannot issue refunds.

Open **Settings** and find the card **API keys**. Every project has a primary and a secondary key.

![The API keys card](https://cdn.rabbitpay.net/help/en/dark/settings/api-keys-and-webhooks/keys.webp)

To get a key or replace one, press **Rotate** next to it and confirm. Copy the new key straight away and keep it in a password manager. It is shown only once.

Two keys let you change keys without downtime: point your software at the secondary key, rotate the primary, then move back.

## Webhooks

A webhook tells your software the moment something happens, for example when an invoice is paid, instead of your software asking again and again.

1. Under **Webhook URL**, enter the address of your software that should receive the events. It must be a public address reachable from the internet, preferably over https.
2. Press **Save webhook URL**.

![The Webhooks card with an address](https://cdn.rabbitpay.net/help/en/dark/settings/api-keys-and-webhooks/webhooks.webp)

RabbitPay then sends a request for events such as **invoice.issued**, **invoice.paid**, **invoice.partially_paid**, **invoice.overdue**, **invoice.credited**, **invoice.canceled**, **invoice.refunded**, **payment.received**, **payment.confirmed** and **payment.refunded**.

The list below the address shows recent deliveries with the event, status, attempts and the answer your software gave. Deliveries that fail are tried again later. Leave the address empty to turn webhooks off.

## Check that a webhook is real

Every delivery is signed, so your software can make sure it came from RabbitPay. The request carries:

| Header                | Content                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| X-RabbitPay-Event     | The event, for example invoice.paid                                                                   |
| X-RabbitPay-Delivery  | A unique id of the delivery                                                                           |
| X-RabbitPay-Timestamp | When it was sent, in milliseconds                                                                     |
| X-RabbitPay-Signature | sha256= followed by an HMAC-SHA256 of the timestamp, a dot and the body, made with the signing secret |

The **Signing secret** is shown on the card. If it leaks, press **Rotate** next to it. Deliveries are signed with the new secret straight away, so update your software at the same time.

![Rotating the signing secret](https://cdn.rabbitpay.net/help/en/dark/settings/api-keys-and-webhooks/rotate.webp)
