# Follow your payments

**Payments** lists every payment and every refund of the project in one place, whichever way the money arrived.

## Open Payments

In the project menu, press **Payments**.

![Payments in the project menu](https://cdn.rabbitpay.net/help/en/dark/payments/follow-payments/open-payments.webp)

## Read the list

![The list of payments](https://cdn.rabbitpay.net/help/en/dark/payments/follow-payments/payments.webp)

The line above the table adds up what was received and refunded and what the fees were, for the rows shown.

| Column        | What it shows                                                                         |
| ------------- | ------------------------------------------------------------------------------------- |
| **Type**      | **Payment**, or a refund                                                              |
| **Amount**    | What arrived, or what was returned with a minus sign                                  |
| **Processor** | How it was paid, with the bank reference or the provider's id under it                |
| **Status**    | **Completed** counts toward the invoice. **Pending** was seen but does not count yet. |
| **Invoice**   | The invoice it belongs to. Press it to open the invoice.                              |
| **Customer**  | Who paid                                                                              |
| **When**      | The date and time of the payment                                                      |

## Find a payment

| Filter                        | What it does                                               |
| ----------------------------- | ---------------------------------------------------------- |
| **Invoice or transaction ID** | Finds a payment by the invoice number or the provider's id |
| **All types**                 | Shows only payments or only refunds                        |
| **All statuses**              | Shows only one status, for example pending                 |
| **All processors**            | Shows only one way of paying, for example Stripe           |
| **All customers**             | Shows the payments of one customer                         |

![The list showing only refunds](https://cdn.rabbitpay.net/help/en/dark/payments/follow-payments/refunds.webp)

## Payments that are still pending

A crypto payment is listed as pending from the moment it is seen until it has enough confirmations. It then becomes completed and the invoice is credited. You do not need to do anything.

## Record or refund a payment

Both are done on the invoice, not in this list.

- To record a bank transfer or cash, open the invoice and press **Record payment**. See [Record a payment](invoices/record-payment).
- To return money, open the invoice and press **Refund** next to the payment. See [Return money](invoices/record-payment#return-money).

## See the totals at a glance

The **Overview** of the project counts your invoices, customers and transactions and lists the latest invoices with their status.

![The Overview of a project in use](https://cdn.rabbitpay.net/help/en/dark/payments/follow-payments/overview.webp)

For income over time, by customer or by item, see [Expenses and reports](expenses-and-reports).
