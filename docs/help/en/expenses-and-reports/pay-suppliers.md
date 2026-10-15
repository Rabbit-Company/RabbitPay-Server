# Pay suppliers

Instead of typing every payment into your online bank, download one file with all of them and upload it to your bank.

## What you need

- The supplier's IBAN on each expense. An imported e-invoice fills it in by itself. Otherwise enter it under **Pay to IBAN** on the expense, or on the supplier under **Inventory** > **Suppliers**.
- The expenses in euros. A payment file can only hold euro payments.

## Create the payment file

1. On **Expenses**, press **Payment file**.

   ![Payment file at the top of the Expenses page](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/pay-suppliers/button.webp)

2. Tick the invoices you want to pay. Unpaid invoices due within a week are already ticked. An invoice marked **No IBAN** or **Not in EUR** cannot be ticked.
3. Set the **Payment date** and **Pay from IBAN**, your own account.
4. Check the total at the bottom and press **Download payment file**.

   ![Choosing which suppliers to pay](https://cdn.rabbitpay.net/help/en/dark/expenses-and-reports/pay-suppliers/dialog.webp)

## Upload it to your bank

Open your online bank and upload the file as a batch of SEPA payments. Banks call this a pain.001 file. Confirm the payments there.

> **Important:** RabbitPay never sends money itself. An expense stays unpaid until you mark it as paid or match it on a bank statement. An expense that was already in a payment file is marked **Already in a payment file**, so you do not pay it twice.
