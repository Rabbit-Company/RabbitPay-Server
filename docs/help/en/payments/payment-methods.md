# Payment methods

Every way your customers can pay is switched on in one card in Settings. A method is offered to your customers once it is switched on and its details are complete.

## Open Payment methods

1. Open your project and press **Settings** in the project menu.

   ![Settings in the project menu](https://cdn.rabbitpay.net/help/en/dark/payments/payment-methods/open-settings.webp)

2. Scroll to the card **Payment methods**.

   ![The Payment methods card with every method](https://cdn.rabbitpay.net/help/en/dark/payments/payment-methods/card.webp)

## What each method needs

| Method            | What you enter                             | Payments are recorded |
| ----------------- | ------------------------------------------ | --------------------- |
| **Bank transfer** | Your IBAN                                  | By hand               |
| **Stripe**        | Secret key and webhook signing secret      | Automatically         |
| **PayPal**        | Client id, client secret and webhook id    | Automatically         |
| **Bitcoin**       | Extended public key of your wallet         | Automatically         |
| **Ethereum**      | Account extended public key of your wallet | Automatically         |
| **Monero**        | Address and login of your view-only wallet | Automatically         |

## Read the status of a method

Every method has a switch on the left and a status on the right.

![A method that still needs its details](https://cdn.rabbitpay.net/help/en/dark/payments/payment-methods/needs-setup.webp)

![A method that is ready and switched on](https://cdn.rabbitpay.net/help/en/dark/payments/payment-methods/ready.webp)

| Status                 | What it means                                                             |
| ---------------------- | ------------------------------------------------------------------------- |
| **Needs setup**        | Fill in the fields below it and press **Save**.                           |
| **Ready**              | The details are complete. Switch it on to offer it to your customers.     |
| **Check settings**     | Something you entered cannot be used. The reason is shown under the name. |
| **Off on this server** | Whoever runs the server has not made this method available.               |

## Switch a method on or off

1. Fill in the fields of the method and press **Save**.
2. Press the switch next to its name.

From that moment the method is offered on the payment page of every unpaid invoice. Switch it off the same way. Invoices that were already paid are not affected.

## How your details are kept

- Secrets such as keys and passwords are stored encrypted and are never shown again after you save them. A saved secret shows **Set, leave blank to keep**. Leave the field empty to keep what is stored, or type a new value to replace it.
- Crypto is watched through public keys only, so nobody at RabbitPay or on the server can spend it.
- Only an owner or an administrator of the project can change payment methods.

## See what is switched on

The **Overview** of your project lists the methods that are ready, split into those that record payments by themselves and those you record by hand.

![Payment methods on the Overview](https://cdn.rabbitpay.net/help/en/dark/payments/payment-methods/overview-card.webp)

> **Note:** A Slovenian business must set up fiscal verification with FURS before it can accept cash, cards or crypto. Until then only bank transfer and PayPal are offered. See [Slovenian compliance](slovenia).
