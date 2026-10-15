# Invoices sent to FURS

With [fiscal verification](slovenia/fiscal-verification) on, you send nothing yourself. RabbitPay sends every invoice paid in cash, by card or in crypto to FURS the moment it is paid.

FURS answers with a unique invoice identifier (EOR), which is printed on the invoice.

## What gets verified

| Paid with                 | Sent to FURS |
| ------------------------- | ------------ |
| Cash                      | Yes          |
| Card, through Stripe      | Yes          |
| Bitcoin, Ethereum, Monero | Yes          |
| Bank transfer             | No           |
| PayPal                    | No           |

An invoice is sent once, with its first such payment. A credit note for a verified invoice is verified too, and refunding a payment on a verified invoice always issues one.

## What the invoice shows

A verified invoice carries the fiscal details at the bottom, in the PDF, on the printed page and in emails:

- **Issue time** to the second.
- **Issued by**, the person whose tax number was sent to FURS.
- **ZOI**, the protective mark RabbitPay calculates with your certificate.
- **EOR**, the identifier FURS returned.
- A **QR code** your customer can scan to check the invoice with FURS.

![A verified invoice with ZOI, EOR and the QR code](https://cdn.rabbitpay.net/help/en/dark/slovenia/verified-invoices/printed.webp)

The number has the form premise, device and number, for example `PP1-SPLET1-1`.

## Check what was sent

Open **Settings** > **Fiscal verification (FURS)** and scroll to **Invoices sent to FURS**. Every record is listed with its amount and status.

![An invoice verified by FURS](https://cdn.rabbitpay.net/help/en/dark/slovenia/verified-invoices/sent.webp)

| Status       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| **Verified** | FURS accepted it. The last column shows the EOR.                  |
| **Waiting**  | FURS could not be reached yet. RabbitPay keeps trying on its own. |
| **Rejected** | FURS refused it. The last column shows the reason FURS gave.      |

## When FURS cannot be reached

The customer still gets the invoice right away, with the ZOI and without an EOR. RabbitPay sends it again in the background until FURS answers, and then the EOR appears on the invoice.

The law gives you 2 working days to send such an invoice, or 10 working days when the invoice was paid more than an hour after it was issued. When an invoice gets close to its deadline, the card at the top of **Fiscal verification (FURS)** shows a warning, the project overview shows it too and the project owners get an email.

## When FURS rejects an invoice

1. Read the reason in the last column.
2. Fix the cause. The usual ones are a certificate that was replaced or expired, a premise that is not registered and a missing tax number of the person who issued the invoice.
3. Press **Send again** in that row.

The owners get an email about every rejected invoice, so nothing stays unnoticed.
