# DDV evidence for eDavki

RabbitPay builds your records of output VAT (KIR) and deductible VAT (KPR) from your invoices, credit notes and expenses, and gives you the file to upload in eDavki.

Every VAT payer in Slovenia submits both to FURS each tax period.

## Create the export

1. Open **Statistics** and scroll to **Official FURS DDV evidence**.
2. **From** and **To** are set to the previous month. Change them if your tax period is a quarter.
3. Leave **Late submission treatment** on **On time**, unless you submit after the deadline. Switch on the other options only if they apply to you, for example **Request a DDV refund**.
4. Press **Validate evidence**.

   ![The DDV evidence for September](https://cdn.rabbitpay.net/help/en/dark/slovenia/ddv-evidence/form.webp)

## Fix what it finds

RabbitPay checks every document. The cards show how many records go into KIR and KPR and whether they match your documents. Anything that would make FURS refuse the file is listed under **Errors that block export**, with the document it belongs to.

![An expense without the supplier's invoice blocks the export](https://cdn.rabbitpay.net/help/en/dark/slovenia/ddv-evidence/errors.webp)

In this example an expense has no attached supplier invoice. Open the expense, attach the invoice and press **Validate evidence** again. When nothing is left, you see **Ready for export**.

![Ready for export](https://cdn.rabbitpay.net/help/en/dark/slovenia/ddv-evidence/validated.webp)

## Download and submit

1. Press **Create FURS export**. The file downloads.
2. In eDavki, open the DDV evidence form for the period and import the file.

Every export is listed under **Exports and corrections**, where **Download ZIP** gets the file again.

![The export and the locked period](https://cdn.rabbitpay.net/help/en/dark/slovenia/ddv-evidence/exported.webp)

## The period is locked

Creating an export locks the period under **Accounting period locks**. Invoices, credit notes and expenses in it can no longer be added or changed, so your records stay equal to what you submitted.

An invoice for a supply in a locked period is still possible, as a [late report](slovenia/vat-periods#invoicing-a-period-you-already-submitted).

## Correct a submitted period

1. Press **Unlock** next to the period.
2. Write why, for example a supplier invoice that arrived late. The reason and your name are recorded.

   ![Unlocking September with a reason](https://cdn.rabbitpay.net/help/en/dark/slovenia/ddv-evidence/unlock.webp)

3. Make the correction.
4. Create the export again. It is saved as the next revision and locks the period again. Submit it in eDavki as a correction.

Only people allowed to export reports can unlock a period.
