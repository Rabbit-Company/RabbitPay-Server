# Cards with Stripe

Card payments run through your own Stripe account. Your customer pays on Stripe's page, so card details never reach RabbitPay, and the money lands in your Stripe balance.

## What you need

- A Stripe account that can take payments. You create one at [stripe.com](https://stripe.com).
- A few minutes in the Stripe dashboard.

## Tell Stripe where to report payments

Stripe has to tell RabbitPay when a customer has paid. This is called a webhook.

1. In the Stripe dashboard, open **Developers** > **Webhooks** and add an endpoint.
2. As the address, enter `https://rabbitpay.net/api/v1/hooks/stripe`.
3. Choose the event `checkout.session.completed`.
4. Save it and copy the **signing secret** that Stripe shows. It starts with `whsec_`.

If you run RabbitPay on your own server, use your own address in place of rabbitpay.net.

## Enter your Stripe keys

1. In the Stripe dashboard, open **Developers** > **API keys** and copy the **secret key**. It starts with `sk_live_`.
2. In RabbitPay, open **Settings** and find **Stripe** in the card **Payment methods**.

   ![Stripe before it is set up](https://cdn.rabbitpay.net/help/en/dark/payments/cards/stripe-empty.webp)

3. Paste the **Secret key** and the **Webhook signing secret**.
4. Press **Save**.

   ![The two Stripe secrets, ready to save](https://cdn.rabbitpay.net/help/en/dark/payments/cards/stripe-keys.webp)

5. Press the switch next to **Stripe**.

   ![Stripe is ready and switched on](https://cdn.rabbitpay.net/help/en/dark/payments/cards/stripe-on.webp)

Both secrets are stored encrypted and are not shown again.

> **Tip:** To try it first, use the keys of Stripe's test mode. The secret key then starts with `sk_test_`, and you pay with Stripe's test card numbers.

## What your customer sees

On the payment page the customer chooses **Stripe**, pays on Stripe's page and comes back.

![Stripe on the payment page](https://cdn.rabbitpay.net/help/en/dark/payments/cards/pay-by-card.webp)

The invoice becomes **paid** a few moments later, without you doing anything.

## Refunds

To refund a card payment, send the money back in the Stripe dashboard, then record the refund on the invoice in RabbitPay. See [Return money](invoices/record-payment#return-money).

## If payments are not recorded

- Check that the webhook address is exactly as above and that the event `checkout.session.completed` is selected.
- Check that the **Webhook signing secret** belongs to this webhook. Each webhook in Stripe has its own.
- In Stripe, the webhook page lists every delivery and whether RabbitPay accepted it.
