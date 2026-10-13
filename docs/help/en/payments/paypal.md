# PayPal

PayPal payments run through your own PayPal business account. Your customer pays on PayPal's page and the money lands in your PayPal balance.

## What you need

- A PayPal business account.
- Access to the PayPal developer dashboard at [developer.paypal.com](https://developer.paypal.com).

## Create an app and a webhook in PayPal

1. In the PayPal developer dashboard, switch to **Live** and create an app.
2. Copy its **Client ID** and **Secret**.
3. In the same app, add a webhook with the address `https://rabbitpay.net/api/v1/hooks/paypal`.
4. Choose the events `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED`.
5. Save it and copy the **Webhook ID**.

If you run RabbitPay on your own server, use your own address in place of rabbitpay.net.

## Enter your PayPal details

1. In RabbitPay, open **Settings** and find **PayPal** in the card **Payment methods**.
2. Paste the **Client id**, the **Client secret** and the **Webhook id**.
3. Press **Save**.

   ![The PayPal details, ready to save](https://cdn.rabbitpay.net/help/en/dark/payments/paypal/paypal-keys.webp)

4. Press the switch next to **PayPal**.

   ![PayPal is ready and switched on](https://cdn.rabbitpay.net/help/en/dark/payments/paypal/paypal-on.webp)

Without the webhook id every notification from PayPal is refused, so do not leave it out.

## What your customer sees

On the payment page the customer chooses **PayPal**, approves the payment on PayPal's page and comes back.

![PayPal on the payment page](https://cdn.rabbitpay.net/help/en/dark/payments/paypal/pay-with-paypal.webp)

The invoice becomes **paid** a few moments later.

## Refunds

To refund a PayPal payment, send the money back in your PayPal account, then record the refund on the invoice in RabbitPay. See [Return money](invoices/record-payment#return-money).
