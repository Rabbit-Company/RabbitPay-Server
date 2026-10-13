# Send an invoice

Send an issued invoice by email, remind a customer who has not paid, or copy the payment link and send it any other way.

## Email the invoice

1. Open the invoice and press **Send**.

   ![The Send menu](https://cdn.rabbitpay.net/help/en/dark/invoices/send/send-menu.webp)

2. Choose **Email invoice**.
3. Check the address under **To**. It is the customer's email address, and you can change it for this one email.
4. Add a **Message** if you like. It is shown above the invoice.
5. Choose what goes with the email:
   - **Attach the invoice as a PDF**
   - **Attach the e-invoice (e-SLOG XML)**, which a business customer in Slovenia can import straight into their accounting software
   - **Include a link to the payment page**, so the customer can pay online
6. Press **Send invoice**.

   ![The email, ready to send](https://cdn.rabbitpay.net/help/en/dark/invoices/send/email-invoice.webp)

The email always lists the lines and the total, so the customer sees what it is for even without opening an attachment.

## See what was sent

Every email is listed on the invoice under **Emails**, with the time, the address, whether it was delivered and who sent it.

![The emails of one invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/send/emails-on-invoice.webp)

**Emails** in the project menu lists every email of the project. Search by recipient, subject or invoice number, or filter by status, by kind and by date.

![All emails of the project](https://cdn.rabbitpay.net/help/en/dark/invoices/send/emails.webp)

| Status      | What it means                                                   |
| ----------- | --------------------------------------------------------------- |
| **Pending** | Waiting to be sent. This takes a few seconds.                   |
| **Sent**    | Handed over to the customer's mail server.                      |
| **Failed**  | Could not be delivered, for example because of a wrong address. |

## Remind the customer

1. Open the unpaid invoice and press **Send** > **Send reminder**.
2. Check the address, add a message if you like and send it.

   ![A reminder for an unpaid invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/send/reminder.webp)

The reminder tells the customer how much is still open and links to the payment page.

## Send reminders automatically

1. Open **Settings** and find the card **Email**.
2. Switch on **Remind customers about unpaid invoices**.
3. Under **Days before the due date**, enter how many days before the due date one reminder is sent. `0` turns it off.
4. Under **Days after the due date**, enter the gap between reminders after the due date. They repeat at this interval, up to three times. `0` turns them off.
5. Press **Save email settings**.

   ![The Email card in Settings](https://cdn.rabbitpay.net/help/en/dark/invoices/send/email-settings.webp)

Only invoices with a customer email address are reminded. Sales at the terminal are never reminded.

The same card sets what every email carries unless you change it for a single email: the PDF, the e-invoice, the link to the payment page and the link to the [customer portal](customer-portal).

## Send the payment link yourself

**Send** > **Copy payment link** copies the address of the payment page, so you can paste it into a chat or a text message. **Send** > **Open payment page** shows the page your customer pays from.

Anyone who has the link can open the page, so send it only to the customer it is meant for.
