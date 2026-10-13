# Your first invoice

In five minutes you switch on a way to get paid, add a customer, issue an invoice and send it.

## Tell customers where to pay

A bank transfer is the quickest method to set up, because it needs only your account number.

1. Open **Settings** and find the card **Payment methods**.
2. Under **Bank transfer**, enter your **IBAN**. The **BIC or SWIFT** and the **Bank name** are optional but help customers abroad. **Account holder** can stay empty when the account is in your company's name.
3. Leave **Payment code** on **Choose for me**. RabbitPay then prints the QR code that banks in your customer's country can scan.
4. Press **Save**.

   ![The bank transfer details](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/bank-transfer.webp)

5. Make sure the switch next to **Bank transfer** is on.

   ![Bank transfer is switched on](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/bank-transfer-on.webp)

Cards, PayPal and crypto are switched on in the same card and take a few minutes more. See [Payments](payments).

## Start a new invoice

1. In the project menu, press **Invoices**.
2. Press **New invoice**, or press `F2` anywhere in the project.

   ![The Invoices page, with New invoice on the right](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/invoices-empty.webp)

## Add the customer

1. Press the **Customer** field and choose **Add a new customer**. Next time, just start typing the name of a customer you already have.

   ![Adding a customer without leaving the invoice](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/add-customer.webp)

2. Enter the **Name** and the **Email** the invoice should be sent to.
3. Under **Type**, choose **Business** or **Individual**.
4. Enter the **Address**, **City**, **Postal code** and **Country**.
5. If the customer is a VAT registered business, enter its **VAT number**. RabbitPay checks it when you save.
6. Press **Create customer**.

   ![The new customer, filled in](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/new-customer.webp)

> **Tip:** For a Slovenian company, type its name or tax number under **Name** and pick it from the list. The address and tax numbers are filled in from the public register. For a company elsewhere in the EU, type its VAT number.

The customer is saved in your project under **Customers** and is selected on the invoice.

## Add what you are charging for

1. Under **Line items**, type the description, for example `Website redesign`.
2. Enter the quantity, choose a unit if you want one printed, and enter the unit price without VAT.
3. Check the tax rate. RabbitPay has already suggested it from your tax settings and the customer's country.
4. Press **Add line** for every further line.

   ![One line, with the totals worked out below](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/line-items.webp)

The totals under the lines update as you type. If you sell the same things often, save them once under **Items** and pick them here.

## Issue the invoice

1. Check the **Due date**. It starts 14 days from today.
2. Press **Create and issue**.

   ![The finished invoice form](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/invoice-form.webp)

The invoice now has its number and can be paid. It can no longer be edited, which is what the law expects of an issued invoice.

![The issued invoice](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/invoice-issued.webp)

Not sure yet? **Preview** shows the invoice as your customer will see it without saving anything, and **Create draft** saves it without a number so you can finish it later. Everything about drafts, credit notes and pro forma invoices is in [Invoices](invoices).

## Send it to your customer

1. On the invoice, press **Send** and choose **Email invoice**.

   ![The Send menu on an invoice](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/send-menu.webp)

2. Check the address under **To** and add a **Message** if you like.
3. Choose what goes with the email: the invoice as a PDF, and a link to the payment page.
4. Press **Send invoice**.

   ![The email, ready to send](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/email-invoice.webp)

Every email you send is listed on the invoice and under **Emails** in the project menu.

## What your customer sees

The link in the email opens the payment page. It shows the amount, the due date and the ways to pay that you switched on. With a bank transfer the customer gets your account details and a QR code to scan with a banking app.

![The payment page your customer sees](https://cdn.rabbitpay.net/help/en/dark/getting-started/first-invoice/payment-page.webp)

Want to look for yourself? On the invoice, press **Send** > **Open payment page**.

## When the money arrives

Payments by card, PayPal or crypto are recorded for you. A bank transfer you record yourself.

1. Open the invoice and press **Record payment**.
2. Enter the amount and the date the money arrived.
3. Save. The invoice becomes **paid**.
