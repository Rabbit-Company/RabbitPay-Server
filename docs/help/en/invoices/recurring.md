# Recurring invoices

For a retainer, a subscription or hosting, set the invoice up once. RabbitPay creates it on schedule and, if you want, issues it and emails it to the customer.

## Open Recurring

In the project menu, press **Recurring**.

![Recurring in the project menu](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/open-recurring.webp)

![The Recurring page before the first one](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/empty.webp)

## Set the schedule

1. Press **New recurring invoice**.
2. Enter a **Name**. Only you see it.
3. Choose the **Customer**.
4. Under **Every** and **Period**, set how often it repeats, for example every 1 months.
5. Under **First invoice on**, choose the day of the first invoice. Later invoices are created on the same day of each period.
6. Under **Ends**, choose **Never, until I cancel**, **After a number of invoices** or **On a date**.

   ![The schedule of a recurring invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/schedule.webp)

The line under the fields lists the dates of the next invoices, so you can check the schedule before you start it.

Three more choices decide what each invoice is like:

| Field                          | What it sets                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Each invoice covers**        | **The period starting on the invoice date** bills in advance. **The period before the invoice date** bills afterwards and sets the supply date to the last day of that period. |
| **Payment terms in days**      | How many days after it is created each invoice is due.                                                                                                                         |
| **When an invoice is created** | **Issue and email it to the customer**, **Issue it without emailing**, or **Save it as a draft for me to review**.                                                             |

## Add the lines

Add lines as on any [invoice](invoices/create-invoice#add-the-lines).

![A line that names the month it is for](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/lines.webp)

Write `{month}`, `{year}` or `{period}` in a description or in the notes, and RabbitPay replaces it with the period each invoice covers. `Website maintenance for {month} {year}` becomes `Website maintenance for October 2026` on the October invoice.

## Start it

1. Press **Preview next invoice** to see the first invoice as a PDF.
2. Press **Start recurring invoice**.

   ![The finished form](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/form.webp)

The page of the recurring invoice shows its schedule, what each invoice contains and the invoices created so far.

![A recurring invoice that is running](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/started.webp)

## Pause, change or stop it

The buttons at the top of its page do this.

![The buttons of a recurring invoice](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/actions.webp)

| Button                      | What it does                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| **Edit**                    | Changes the schedule or the lines. Invoices already created stay as they are.                |
| **Preview next invoice**    | Shows the next invoice as a PDF.                                                             |
| **Create next invoice now** | Creates the invoice planned for the next date right away and moves the schedule on.          |
| **Pause**                   | Stops creating invoices until you press **Resume**. Periods missed while paused are skipped. |
| **Cancel**                  | Ends it for good. Invoices already created stay as they are.                                 |
| **Delete**                  | Removes it completely. Only possible while nothing was invoiced yet.                         |

![Creating the next invoice right away](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/create-now.webp)

Every invoice it creates is listed under **Invoices created** and opens like any other invoice.

![The first invoice it created](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/invoice-created.webp)

## See all recurring invoices

**Recurring** lists them with the customer, the schedule, the amount, the date of the next invoice and how many were created. The line above the table estimates what the active ones bring in a month.

![The list of recurring invoices](https://cdn.rabbitpay.net/help/en/dark/invoices/recurring/list.webp)

If an invoice cannot be created, for example because the customer was deleted, RabbitPay tries again by itself and shows **Last run failed** in the list. After several failures in a row it pauses the recurring invoice. Fix the problem, then press **Resume**.
