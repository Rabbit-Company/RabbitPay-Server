# Payments

Choose how your customers can pay, follow the money as it arrives and sell in person with the terminal. Payments go straight to your own accounts and never through RabbitPay.

## Switch on payment methods

Open **Settings** in your project and find **Payment methods**. Every method starts switched off. A method is offered to your customers once it is switched on and its details are complete.

| Method        | What you enter                             | Recorded      |
| ------------- | ------------------------------------------ | ------------- |
| Bank transfer | Your IBAN                                  | By hand       |
| Stripe        | Secret key and webhook signing secret      | Automatically |
| PayPal        | Client ID, secret and webhook ID           | Automatically |
| Bitcoin       | Extended public key of your wallet         | Automatically |
| Ethereum      | Extended public key of your wallet         | Automatically |
| Monero        | Address and login of your view-only wallet | Automatically |

Secrets are stored encrypted and are never shown again after you save them. Leave a secret field empty to keep what is stored.

A method marked **off on this server** has not been made available by whoever runs the server.

A Slovenian business must set up fiscal verification before it can accept cash, cards or crypto. Until then only bank transfer and PayPal are offered.

## Accept bank transfers

Switch on **Bank transfer** and enter your IBAN. The BIC, the account holder and the bank name are optional.

Your customer sees the account, the amount and the payment reference on the invoice and on the payment page, together with a QR code that banking apps can scan. A Slovenian account gets a UPN QR code and other euro accounts get an EPC QR code. The code is shown for invoices in euros and always asks for the amount that is still open.

RabbitPay does not watch your bank account. When the money arrives, open the invoice and press **Record payment**.

## Accept cards and PayPal

Card payments run through your own Stripe account, and PayPal payments through your own PayPal business account. Your customer pays on the Stripe or PayPal page, so card details never reach RabbitPay.

**Stripe**

1. In the Stripe dashboard, create a webhook that points to `https://rabbitpay.net/api/v1/hooks/stripe` and sends the event `checkout.session.completed`.
2. Copy the secret key and the signing secret of that webhook into **Settings** > **Payment methods** > **Stripe**.

**PayPal**

1. In the PayPal developer dashboard, create an app and a webhook that points to `https://rabbitpay.net/api/v1/hooks/paypal` with the events `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED`.
2. Copy the client ID, the secret and the webhook ID into **Settings** > **Payment methods** > **PayPal**.

If you host RabbitPay yourself, use your own address in place of rabbitpay.net.

The invoice is marked as paid a few moments after the customer pays. A refund is recorded in RabbitPay and has to be sent from the Stripe or PayPal dashboard.

## Accept crypto

Bitcoin and Ethereum need only the extended public key of your wallet. RabbitPay creates a new address for every invoice, watches it and marks the invoice as paid once the payment is confirmed. It can see incoming payments but can never spend them. After you save the key, the first receiving address is shown so you can compare it with your wallet.

Monero needs a view-only wallet that you run yourself, because Monero payments cannot be looked up publicly.

The price is taken at the moment the customer chooses to pay with a coin, and the amount is fixed for that address. A change in the market while the customer is paying does not leave the invoice short.

## The payment page

Every issued invoice has its own payment page that needs no account. Send it with **Send** > **Copy payment link** on the invoice, or include the link in the invoice email.

The page shows what is owed, offers the methods you switched on and updates by itself when the money arrives. A draft has no payment page.

Anyone with the link can open the page, so share it only with the customer it is meant for.

## Follow and refund payments

**Payments** in your project lists every payment and refund. Search by invoice or transaction ID and filter by type and payment method. A payment marked as pending has been seen but is not confirmed yet, so it does not count toward the invoice.

To return money, open the invoice, find the payment and press **Refund**. See [Invoices](invoices) for refunds and credit notes.

## Sell in person with the terminal

**Terminal** turns a phone, a tablet or a POS device into a till.

1. Tap products from your **Items**, search or scan a barcode, or enter an amount on the keypad.
2. Press **Charge**.
3. For cash, enter the amount handed over and RabbitPay shows the change to give back. For other methods the customer scans the QR code and pays on their phone.

Every sale is an issued invoice with a receipt that you can print or email. In a Slovenian project with fiscal verification, cash and card sales are sent to FURS right away. Canceling a sale issues a credit note.

A team member with the **Cashier** role sees only the terminal and their own sales.
