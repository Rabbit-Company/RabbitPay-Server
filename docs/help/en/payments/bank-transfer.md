# Bank transfer

The simplest way to get paid. Your customer sees your account, the amount and a reference, and pays from their own bank. All you need is your IBAN.

## Enter your bank details

1. Open **Settings** and find **Bank transfer** in the card **Payment methods**.
2. Enter your **IBAN**. RabbitPay checks that it is a valid number.
3. Optionally enter the **BIC or SWIFT** and the **Bank name**. They help customers abroad.
4. Leave **Account holder** empty when the account is in your company's legal name. Fill it in only when the name on the account is different.
5. Press **Save** and make sure the switch next to **Bank transfer** is on.

   ![Bank transfer with its details filled in](https://cdn.rabbitpay.net/help/en/dark/payments/bank-transfer/details.webp)

## Choose the QR code

A customer can scan a QR code with a banking app, and the app fills in your account, the amount and the reference.

![The Payment code field](https://cdn.rabbitpay.net/help/en/dark/payments/bank-transfer/payment-code.webp)

| Payment code          | Use it when                                                                      |
| --------------------- | -------------------------------------------------------------------------------- |
| **Choose for me**     | Recommended. A Slovenian account gets UPN QR, every other euro account GiroCode. |
| **GiroCode (SEPA)**   | Your customers bank anywhere in the euro area outside Slovenia.                  |
| **UPN QR (Slovenia)** | Your customers use Slovenian banking apps.                                       |
| **No payment code**   | You do not want a code shown.                                                    |

The two codes are not interchangeable: Slovenian banking apps read UPN QR, the rest of the euro area reads GiroCode. A code is shown only for invoices in euros, and it always asks for the amount that is still open, so a partly paid invoice asks for the rest.

## What your customer sees

On the payment page the customer chooses **Bank transfer**.

![Bank transfer on the payment page](https://cdn.rabbitpay.net/help/en/dark/payments/bank-transfer/choose.webp)

The page then shows the QR code, your account details and the **Reference**, each with a **Copy** button.

![The bank details and the QR code](https://cdn.rabbitpay.net/help/en/dark/payments/bank-transfer/pay-by-transfer.webp)

The same details and the same code are printed on the invoice itself.

![The bank details on a printed invoice](https://cdn.rabbitpay.net/help/en/dark/payments/bank-transfer/on-the-invoice.webp)

## When the money arrives

RabbitPay does not watch your bank account, so a bank transfer is never marked as paid by itself. When the money arrives, open the invoice and press **Record payment**. See [Record a payment](invoices/record-payment).

The reference is how you recognise a payment. Search for it under **Invoices** when a transfer arrives without a name you know.
