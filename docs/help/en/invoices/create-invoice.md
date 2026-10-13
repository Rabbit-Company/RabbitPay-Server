# Create an invoice

An invoice needs a customer, at least one line and a due date. Everything else is optional. You can issue it right away or save it as a draft and finish later.

## Start a new invoice

1. In the project menu, press **Invoices**.
2. Press **New invoice**. Anywhere in the project, `F2` does the same.

   ![The Invoices page, with New invoice on the right](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/invoices.webp)

The form has two cards: **Details** at the top and **Line items** below it.

![The empty invoice form](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/empty-form.webp)

## Choose the customer

1. Press the **Customer** field and start typing a name, an email address or a VAT number.
2. Pick the customer from the list.

   ![Finding a customer by typing the start of the name](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/choose-customer.webp)

Not in the list yet? Choose **Add a new customer** at the bottom of the list and fill in the details without leaving the invoice. See [Customers](invoices/customers).

You can leave the customer empty for a sale to someone you do not need to name, where the law allows that.

## Add the lines

1. Under **Line items**, press the description field. Type to search the [items](invoices/items) you saved and pick one. Its unit, price and tax rate are filled in for you. Or simply type a description of your own.
2. Enter the quantity in **Qty**.
3. Check the **Unit**, the **Unit price** without VAT and the **Tax %**.
4. Press **Add line** for every further line. The cross at the end of a line removes it.

   ![Two lines, with the totals worked out below them](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/lines.webp)

RabbitPay suggests the tax rate from your tax settings, the item and the customer's country. For a VAT registered business in another EU country it suggests reverse charge, for example. If you change a rate by hand, a note under the line shows what was suggested, with **Use suggestion** to go back. When a line carries no VAT, choose the reason next to **Why no VAT is charged**, so the right clause is printed.

> **Note:** No rate suggested? Set your country and VAT status first. See [Set how VAT applies to you](getting-started/company-details#set-how-vat-applies-to-you).

## Set the dates, a discount and notes

All of these are in the **Details** card.

![Due date, discount and notes](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/details.webp)

- **Currency** starts with the currency of the project. Choose another one to invoice in it.
- **Due date** is the last day to pay. It starts 14 days from today.
- **Supply date** is the day the goods or service were delivered. Fill it in only when that is not the invoice date. VAT is reported in the period of this date.
- **Discount** is one amount for the whole invoice, before tax.
- **Notes** are printed on the invoice.

The totals under the lines show the subtotal, the discount, the tax and the total as you type.

![The totals of the invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/totals.webp)

## Add the customer's order number

Some customers, and every public sector buyer, need the number of their order or contract on the invoice.

1. Press **Reference document** to open it.
2. Choose the **Type**: **Customer order** or **Contract**.
3. Enter the **Number** and, if you have it, the **Date**.

   ![The reference document, opened](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/reference-document.webp)

You can still add or change it on an issued invoice with **Edit** next to **Reference document**.

## Save or issue

Five buttons are at the bottom of the form.

![The buttons at the bottom of the form](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/buttons.webp)

| Button                       | What it does                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| **Cancel**                   | Leaves the form without saving.                                                    |
| **Preview**                  | Opens the invoice as a PDF, exactly as the customer will see it. Nothing is saved. |
| **Create draft**             | Saves the invoice without a number, so you can change it later.                    |
| **Create pro forma invoice** | Asks the customer to pay first. See [Pro forma invoices](invoices/pro-forma).      |
| **Create and issue**         | Gives the invoice its number and makes it payable at once.                         |

![A finished form, ready to save or issue](https://cdn.rabbitpay.net/help/en/dark/invoices/create-invoice/form.webp)

What comes next: [Drafts and issued invoices](invoices/drafts) and [Send an invoice](invoices/send).
