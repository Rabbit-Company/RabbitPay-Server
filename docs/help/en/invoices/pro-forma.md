# Pro forma invoices

A pro forma invoice asks the customer to pay before you invoice. The invoice itself is issued when the money arrives.

A pro forma invoice is not an invoice: it has its own number series, it is not reported to FURS and it is not in your VAT records.

## Create a pro forma invoice

1. Start a [new invoice](invoices/create-invoice) and fill in the customer and the lines.
2. Press **Pro forma invoice** in the **Details** card to open its options.
3. Under **When a pro forma invoice is paid**, choose what should happen. The two choices are explained in the next section.

   ![The pro forma options on the invoice form](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/options.webp)

4. Press **Create pro forma invoice** at the bottom.

   ![Create pro forma invoice among the buttons](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/create-button.webp)

You can also turn an existing draft into one with **More** > **Create pro forma invoice**.

The pro forma invoice has its own number, the pills **Pro Forma Invoice** and **Awaiting Payment**, and a date until which it is valid.

![A pro forma invoice waiting for payment](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/pro-forma.webp)

## Choose what happens when it is paid

| Choice                                         | What happens                                                                                           | Use it when                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| **Issue the invoice right away**               | The first payment turns the pro forma invoice into an invoice with the next invoice number.            | You deliver when the customer pays. |
| **Issue an advance invoice for every payment** | Every payment gets its own advance invoice for the amount received. You issue the final invoice later. | You deliver later, or in stages.    |

The default for new pro forma invoices is set under **Settings** > **Document numbers** > **When a pro forma invoice is paid**.

To change it for one pro forma invoice, press **More** > **Change what happens on payment**. This is possible until the first payment arrives.

![Changing what happens on payment](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/what-happens-on-payment.webp)

## Send it and get paid

Press **Send** > **Email pro forma invoice**, or copy the payment link. The customer pays on the payment page like for any invoice.

![The Send menu of a pro forma invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/send-menu.webp)

A bank transfer you [record yourself](invoices/record-payment) with **Record payment**.

## When the invoice is issued right away

The first payment turns the pro forma invoice into an invoice. It gets the next invoice number, shows the payment and says which pro forma invoice it came from.

![The invoice that was issued from a paid pro forma invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/became-invoice.webp)

## When you invoice advances

Every payment creates an advance invoice. They are listed in the card **Advance invoices** on the pro forma invoice, and the totals show what was **Paid in advance**.

![A pro forma invoice with one advance invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/advance-invoices.webp)

When you deliver, press **More** > **Issue final invoice**. The final invoice gets the next invoice number and deducts every advance invoice, split by VAT rate.

![Issue final invoice in the More menu](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/issue-final.webp)

## Other things you can do

Open the pro forma invoice and press **More**.

![The More menu of a pro forma invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/more-menu.webp)

- **Edit** changes it. This is possible until the first payment.
- **Issue invoice now** turns it into an invoice without waiting for a payment.
- **Cancel invoice** withdraws it. A pro forma invoice cannot be deleted, only canceled.

To see only pro forma invoices, choose **Pro forma invoices** in the first filter of the invoice list.

![The invoice list showing only pro forma invoices](https://cdn.rabbitpay.net/help/en/dark/invoices/pro-forma/filter.webp)
