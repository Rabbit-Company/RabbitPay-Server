# Dunning letters

A dunning letter ("opomin") is a formal payment reminder that lists what a customer still owes.

It shows every overdue document of one customer, the open total and how to pay it. RabbitPay makes it as a PDF in your invoice design, with a UPN QR code or bank details, and can email it. Automatic reminder emails stay as they are. Use a dunning letter when a customer ignores them or owes money for months.

## See who is late

Open **Dunning letters** in the menu under Sales. At the top you see the overdue total, how many customers owe you money and how many letters you sent this year.

Below are **Customers with overdue invoices**, the oldest debt first, with the last letter each customer received, and **Issued letters**.

![Dunning letters with the customers who are late](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/overview.webp)

## Write a letter

1. Press **Send reminder** next to the customer. You can also press **New dunning letter** and choose the customer, open the customer's page and press **Dunning letter**, or choose **Create dunning letter** in the **Send** menu of an overdue invoice.

   ![Choosing the customer for a new letter](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/pick-customer.webp)

2. Under **Unpaid documents**, keep the documents the letter should list. All overdue invoices are selected and you see how many days each one is late. Invoices that are not due yet are left out.

   ![The overdue invoices of the customer](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/documents.webp)

3. Under **Letter**, choose the level. RabbitPay suggests the next level after the customer's last letter.
   - **Reminder** is friendly and says the payment may have been missed.
   - **Second reminder** refers to the earlier reminder.
   - **Final reminder** warns that the claim goes to debt collection or enforcement.
4. Set **Pay within (days)**. 8 days is common in Slovenia. Choose the **Language** of the letter.
5. Switch on late interest or recovery costs if you want them. Both are explained below. A **Note** is printed under the documents, for example an offer to pay in instalments.

   ![The level, the deadline, late interest and recovery costs](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/options.webp)

6. Check the **Summary**. It adds up the open amount, the interest and the recovery costs and shows the payment deadline.

   ![The summary with the total to pay](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/summary.webp)

7. Press **Preview PDF** to see the letter, then **Issue letter** and confirm. The letter gets the next number, for example OP-2026-0001. You can change how the numbers look in [Invoice numbers](invoices/numbering).

## Email the letter

Right after you issue the letter, RabbitPay offers to email it to the customer's address. Add a message if you like and press **Send letter**. The customer gets the letter as a PDF, with the list of documents and the payment details in the email itself.

![Emailing the letter](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/email.webp)

You can send it again later with **Email** on the letter. To print it, choose **Documents** and then **Open PDF** or **Download PDF**.

## What the customer gets

The PDF uses the design of your invoices. It lists each document with its due date, the days it is late and the open amount, then the totals, a payment box with a UPN QR code for the whole amount and the legal notes.

![A dunning letter as PDF](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/pdf.webp)

## Invoices from before RabbitPay

If the customer still owes money from invoices you wrote in your previous software or on paper, add them by hand.

1. Under **Unpaid documents**, press **Add invoice issued outside RabbitPay**.
2. Enter the **Invoice number**, the dates, the **Invoice total** and what is **Still open**. Leave the total empty when nothing was paid.

   ![Adding an invoice issued outside RabbitPay](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/manual.webp)

3. Press **Add to letter**. The invoice joins the list, marked as added by hand.

   ![The invoice from before RabbitPay on the letter](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/documents-manual.webp)

These invoices appear only on the letter. They do not change your books, VAT records or statistics. When you write the next letter for the same customer, **Add ... from the last letter again** copies them over, so you only remove the ones that were paid.

Invoices you recorded in Accounting under **Issued elsewhere** appear in the list by themselves when the buyer's VAT number or name matches the customer.

## Late interest

For Slovenian projects you can switch on **Add statutory late interest**. RabbitPay calculates it for each document:

- from the day after the due date until the date of the letter
- with the simple (linear) method
- with the statutory default rate of each half year (ECB rate plus 8 percentage points, ZPOMZO-1), 10.40 % since 1 July 2026
- never more than the open amount itself (Article 376 of the Obligations Code)

The letter lists the rates used and notes that interest is not subject to VAT. The interest is calculated on what is open today. If a customer paid part of an invoice late, the real interest is a little higher, so the letter never asks for too much.

Without the switch the letter says that you keep the right to charge late interest.

## Recovery costs

Between businesses you can ask for 40 EUR for each late invoice (Article 14 of ZPreZP-1, in other EU countries Directive 2011/7/EU). Switch on **Add recovery costs of 40 EUR per invoice**. It is available only for business customers, for letters in EUR and for invoices that became due less than 3 years ago.

## Old debts

Documents due more than 3 years ago get a warning. Claims between businesses usually become time barred after 3 years. A letter does not stop that, only a written acknowledgement of the debt or a court procedure does. You can still send the letter, the customer may pay anyway.

## After the letter

Open the letter from **Issued letters** to see what is still open on each listed invoice. The status changes to **Partly paid** or **Paid** as payments come in, and **Deadline passed** when the customer misses the deadline. The emails you sent are listed at the bottom.

![A letter with what is still open on each invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/letter.webp)

When the deadline passes, send the next level. On the **Dunning letters** page the button next to the customer now says **Send second reminder**, and on the letter you find it under **More**. There you can also delete a letter. Deleting does not remove emails that were already sent.

![The next reminder for the same customer](https://cdn.rabbitpay.net/help/en/dark/invoices/dunning/next-level.webp)
