# Record a payment

Payments by card, PayPal or crypto on the payment page are recorded for you. Everything else, such as a bank transfer or cash, you record yourself.

## Record the payment

1. Open the invoice and press **Record payment**.

   ![Record payment on an open invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/record-payment/record-button.webp)

2. Check the **Amount**. It starts with what is still outstanding. Enter less when only part arrived.
3. Under **Processor**, choose how the money arrived, for example **Bank transfer** or **Cash**.
4. Set the **Payment date** to the day the money arrived.
5. Add the bank **Reference** and **Notes** if you want to keep them.
6. Press **Record payment**.

   ![Recording a bank transfer](https://cdn.rabbitpay.net/help/en/dark/invoices/record-payment/record-dialog.webp)

The invoice becomes **paid**. The payment is listed in the **Payments** card on the invoice and under **Payments** in the project menu.

![A paid invoice with its payment](https://cdn.rabbitpay.net/help/en/dark/invoices/record-payment/paid.webp)

Two fields you rarely need:

- **Fee** is what a payment provider kept for itself. It is deducted from the net amount in your reports.
- **Status** is **Completed** for money that arrived. **Pending** records a payment you expect, which does not count toward the invoice yet.

## When only part is paid

Enter the amount that arrived. The invoice becomes **partially paid** and shows what was paid and what is still outstanding. Record the rest the same way when it arrives.

![A partially paid invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/record-payment/partially-paid.webp)

## Return money

1. Open the invoice and find the payment in the **Payments** card.
2. Press **Refund** in its row.
3. Check the **Amount**. You can return all of it or a part.
4. Enter the **Reason**.
5. Decide about **Issue a credit note for this refund**:
   - Leave it on when the sale itself is reversed, for example for returned goods. The credit note corrects the VAT you reported.
   - Switch it off when you only return an overpayment.
6. Press **Refund**.

   ![Returning a payment](https://cdn.rabbitpay.net/help/en/dark/invoices/record-payment/refund.webp)

> **Important:** RabbitPay records the refund. It does not move the money. Send a bank transfer back from your bank, and a card or PayPal refund from the Stripe or PayPal dashboard.

For an invoice that was verified by FURS, a credit note is always issued with the refund, so FURS receives the correction.

## Remove a payment entered by mistake

If you recorded a payment that never came in, for example because a bank payment turned out to be for older invoices, press **Remove** next to it under **Payments**. Write a short reason and confirm. The payment stays in the list marked as failed, with the reason, so you can always see what was corrected. The invoice counts as unpaid again and can get reminders. The customer is not notified.

**Remove** is only offered for payments you entered by hand. A payment created by matching a bank line is undone with **Reopen** on that line, see [Bank statements](accounting/bank-statements). Payments from Stripe, PayPal or crypto, payments that were refunded, and cash or card payments confirmed by FURS are corrected with **Refund**.
