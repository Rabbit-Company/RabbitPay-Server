# Payments

Choose how your customers can pay and follow the money as it arrives. Payments go straight to your own bank account, payment provider or wallet. They never pass through RabbitPay.

## Set up a way to get paid

| Method                    | Recorded      | Page                                    |
| ------------------------- | ------------- | --------------------------------------- |
| Bank transfer             | By hand       | [Bank transfer](payments/bank-transfer) |
| Cards, through Stripe     | Automatically | [Cards with Stripe](payments/cards)     |
| PayPal                    | Automatically | [PayPal](payments/paypal)               |
| Bitcoin, Ethereum, Monero | Automatically | [Crypto](payments/crypto)               |

Start with [Payment methods](payments/payment-methods), which explains the card where all of them are switched on.

## Get paid and keep track

| I want to                             | Page                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| See what my customer sees when paying | [The payment page](payments/payment-page)            |
| See every payment and refund          | [Follow your payments](payments/follow-payments)     |
| Record a bank transfer or cash        | [Record a payment](invoices/record-payment)          |
| Return money to a customer            | [Return money](invoices/record-payment#return-money) |

## Sell in person with the terminal

**Terminal** turns a phone, a tablet or a POS device into a till.

1. Tap products from your **Items**, search or scan a barcode, or enter an amount on the keypad.
2. Press **Charge**.
3. For cash, enter the amount handed over and RabbitPay shows the change to give back. For other methods the customer scans the QR code and pays on their phone.

Every sale is an issued invoice with a receipt that you can print or email. In a Slovenian project with fiscal verification, cash and card sales are sent to FURS right away. Canceling a sale issues a credit note.

A team member with the **Cashier** role sees only the terminal and their own sales.
