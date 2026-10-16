# The journal

Every posting in one list, in the order it was posted. Find any entry, open the document behind it and post your own entries.

## Read the journal

Open **Accounting**. The journal is the first tab. Each entry has a number such as **2025/1**, a date, a description and its lines with the account, debit and credit.

![The journal with the opening entry and the first expenses](https://cdn.rabbitpay.net/help/en/dark/accounting/journal/list.webp)

- **Open document** takes you to the invoice, expense or other document the entry came from.
- Click an account to open its [account card](accounting/trial-balance#open-an-account-card).
- **Export CSV** downloads the entries you see, with the filters applied.

## Find an entry

Choose a **Period**, such as **This month** or **Last year**, or set your own dates. Then narrow it down by account, source, a word from the description or partner, or an exact amount.

![The period and filters above the journal](https://cdn.rabbitpay.net/help/en/dark/accounting/journal/filters.webp)

The **Source** filter shows only one kind of entry, for example only **Bank statement line** or only **Manual entry**.

## Post an entry yourself

Use manual entries for opening balances, bank charges you did not import, loans and anything else that has no document in RabbitPay.

1. Press **New entry**, or press **F8** anywhere in the project.
2. Enter the date and a description.
3. On each line choose the account by typing its code or part of its name, then type the amount in **Debit** or **Credit**.
4. Press **Add line** for more lines. A new line is filled with the amount still missing.
5. When **Debit** and **Credit** are equal, press **Post entry**.

![An opening entry with three lines](https://cdn.rabbitpay.net/help/en/dark/accounting/journal/new-entry.webp)

You can enter the whole entry without the mouse. **Enter** moves to the next field and adds a line while the entry is not balanced, and **Ctrl + Enter** posts it. Add a **Partner** to lines on customer and supplier accounts so they appear in [open items](accounting/open-items).

## Correct a manual entry

Entries are never edited. Press **Reverse** on a manual entry to post the same entry with opposite amounts, then post a correct one.

Entries that come from documents are corrected by changing the document. RabbitPay reverses the old entry and posts the new one for you.

## Locked periods

Two things lock a period:

- A month whose [DDV evidence](slovenia/ddv-evidence) you exported. Manual entries on VAT accounts are refused there.
- A [closed year](accounting/year-end). Nothing dated in it can be posted until the year is reopened.

If documents could not be posted, for example because a foreign currency invoice has no exchange rate, a notice above the journal lists them.
