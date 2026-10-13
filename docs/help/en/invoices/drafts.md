# Drafts and issued invoices

A draft is work in progress. An issued invoice is final. This page shows the difference, how you move from one to the other and how to find an invoice again.

## What a draft is

A draft has a placeholder such as `DRAFT-8KQ2LM4P` in place of a number. You can change it or delete it, and your customer cannot pay it yet.

![A draft, with Issue invoice at the top](https://cdn.rabbitpay.net/help/en/dark/invoices/drafts/draft.webp)

Because the number is taken only when you issue, deleting a draft never leaves a gap in your numbering.

## Change or delete a draft

1. Open the draft and press **More**.

   ![The More menu of a draft](https://cdn.rabbitpay.net/help/en/dark/invoices/drafts/draft-more.webp)

2. Choose **Edit**, change what you need and press **Save changes**.

   ![Editing a draft](https://cdn.rabbitpay.net/help/en/dark/invoices/drafts/edit-draft.webp)

**More** > **Delete draft** removes a draft you no longer need. **More** > **Create pro forma invoice** turns it into a [pro forma invoice](invoices/pro-forma).

## Issue the invoice

Open the draft and press **Issue invoice**.

![The invoice after issuing](https://cdn.rabbitpay.net/help/en/dark/invoices/drafts/issued.webp)

The invoice gets the next number in your series, its status becomes **open** and it can be paid. From now on it cannot be edited or deleted. To change it, [issue a credit note](invoices/credit-notes).

## Find an invoice

**Invoices** lists every document, newest first. The line above the table adds up what was billed, paid and is still outstanding for the invoices shown.

![The invoice list with its filters](https://cdn.rabbitpay.net/help/en/dark/invoices/drafts/list.webp)

| Filter                  | What it does                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| **Search by reference** | Finds an invoice by its number.                                                               |
| **All documents**       | Narrows the list to pro forma invoices, store orders waiting for payment or advance invoices. |
| **All statuses**        | Shows only one status, for example **overdue**.                                               |
| **All customers**       | Shows the invoices of one customer.                                                           |

![The list showing only drafts](https://cdn.rabbitpay.net/help/en/dark/invoices/drafts/filter-drafts.webp)

Press the reference to open an invoice, or the customer's name to open the [customer](invoices/customers).

## What each status means

| Status         | What it means                                                  |
| -------------- | -------------------------------------------------------------- |
| draft          | Not issued yet. Has no number and cannot be paid.              |
| open           | Issued and waiting for payment.                                |
| overdue        | Issued and past its due date. The due date is shown in orange. |
| partially paid | Some of the amount has arrived.                                |
| paid           | Paid in full.                                                  |
| canceled       | Withdrawn. Its number stays used.                              |
| refunded       | The payment was returned to the customer.                      |
