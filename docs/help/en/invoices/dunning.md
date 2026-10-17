# Dunning letters

A dunning letter ("opomin") is a formal payment reminder that lists what a customer still owes.

It shows every overdue document of one customer, the open total and how to pay it. RabbitPay makes it as a PDF in your invoice design, with a UPN QR code or bank details, and can email it.

Automatic reminder emails stay as they are. Use a dunning letter when a customer ignores them or owes money for months.

## See who is late

Open **Dunning letters** in the menu under Sales. The page shows:

- the total overdue amount and how many customers owe you money
- **Customers with overdue invoices**, the oldest debt first, with the last letter each one received
- **Issued letters**, with the date, the deadline and whether the letter was emailed

## Write a letter

1. Press **Send reminder** next to a customer, or **New dunning letter** and choose the customer. You can also start from a customer's page or from the **Send** menu of an overdue invoice.
2. Under **Unpaid documents**, keep the documents the letter should list. All overdue invoices are selected. Invoices that are not due yet are left out.
3. Choose the level:
   - **Reminder** is friendly and says the payment may have been missed.
   - **Second reminder** refers to the earlier reminder.
   - **Final reminder** warns that the claim goes to debt collection or enforcement.

   RabbitPay suggests the next level after the customer's last letter.

4. Set **Pay within (days)**. 8 days is common.
5. Add late interest or recovery costs if you want them, see below.
6. Check the **Summary** and press **Preview PDF** to see the letter.
7. Press **Issue letter**. It gets the next number, for example OP-2026-0001, and RabbitPay offers to email it right away.

## Invoices from before RabbitPay

Press **Add invoice issued outside RabbitPay** and enter the invoice number, the dates, the invoice total and what is still open. These invoices appear only on the letter. They do not change your books, VAT records or statistics.

When you write the next letter for the same customer, **Add ... from the last letter again** copies them over, so you only remove the ones that were paid.

Invoices you recorded in Accounting under **Issued elsewhere** appear in the list automatically when the buyer's VAT number or name matches the customer.

## Late interest

For Slovenian projects you can switch on **Add statutory late interest**. RabbitPay calculates it for each document:

- from the day after the due date until the date of the letter
- with the simple (linear) method
- with the statutory default rate of each half year (ECB rate plus 8 percentage points, ZPOMZO-1), 10.40 % since 1 July 2026
- never more than the open amount itself (Article 376 of the Obligations Code)

The letter lists the rates used and notes that interest is not subject to VAT. The interest is calculated on what is open today. If a customer paid part of an invoice late, the real interest is a little higher, so the letter never asks for too much.

Without the switch the letter says that you keep the right to charge late interest.

## Recovery costs

Between businesses you can ask for 40 EUR for each late invoice (Article 14 of ZPreZP-1, in other EU countries Directive 2011/7/EU). Switch on **Add recovery costs**. It is available only for business customers, for letters in EUR and for invoices that became due less than 3 years ago.

## Old debts

Documents due more than 3 years ago get a warning. Claims between businesses usually become time barred after 3 years. A letter does not stop that, only a written acknowledgement of the debt or a court procedure does. You can still send the letter, the customer may pay anyway.

## After the letter

Open a letter to see what is still open on each listed invoice. The status changes to **Partly paid** or **Paid** as payments come in. From **More** you can start the next reminder or delete the letter. Deleting does not remove emails that were already sent.
