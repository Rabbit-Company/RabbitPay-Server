# Invoice numbers

Invoice numbers must run in sequence without gaps. You decide how they look, and RabbitPay keeps the sequence.

## Open Document numbers

Open **Settings** and find the card **Document numbers**. It has three parts: invoice numbers, pro forma invoice numbers and store order numbers. Each has its own format and its own counter.

![The Document numbers card](https://cdn.rabbitpay.net/help/en/dark/invoices/numbering/document-numbers.webp)

## Write a format

A format is a pattern. These codes are replaced when a number is made, and everything else is printed as written.

| Code          | Becomes                                        |
| ------------- | ---------------------------------------------- |
| `YYYY` / `YY` | The year, 2026 or 26                           |
| `MM`          | The month, 01 to 12                            |
| `DD`          | The day, 01 to 31                              |
| `X`           | One digit of the counter, so `XXX` gives `001` |

| Format            | First number    | The counter starts again        |
| ----------------- | --------------- | ------------------------------- |
| `YYMMDDXXXXXX`    | `261013000001`  | Every day. This is the default. |
| `XXX/YY`          | `001/26`        | Every year                      |
| `YYYY-XXXX`       | `2026-0001`     | Every year                      |
| `INV-YYYY-XXXX`   | `INV-2026-0001` | Every year                      |
| `"INV"-YYMM-XXXX` | `INV-2610-0001` | Every month                     |
| `XXXXXX`          | `000001`        | Never                           |

The counter starts again at 1 with the smallest date part in the format: every year when the format has only a year, every month with `MM` and every day with `DD`.

Put text in double quotes when it contains the letters Y, M, D or X, for example `"ORDER"-YYXXXXXX`. Without the quotes those letters would be read as codes.

## Change the invoice number format

1. Under **Invoice numbers**, type the new **Format**.
2. Read the line below it. It shows the next number exactly as it will be printed, and how many invoices fit before the counter is full.

   ![A format of your own, with the next number shown](https://cdn.rabbitpay.net/help/en/dark/invoices/numbering/own-format.webp)

3. Press **Save numbering**.

Invoices already issued keep their numbers. A format that could produce the same number twice is refused.

## Continue a series from another program

If you already issued invoices this year somewhere else, set **Next number** to continue the series, for example 42 after 41 invoices. Numbers that were already used are skipped.

> **Note:** In a Slovenian project with fiscal verification switched on, invoices are numbered the way FURS requires: the business premise, the device and a running number, for example `PP1-SPLET1-1`. See [Slovenian compliance](slovenia).

## Pro forma invoices, store orders and credit notes

- **Pro forma invoice numbers** work the same way and start with `PR-YYYY-XXXXX`. The same part of the card sets what happens [when a pro forma invoice is paid](invoices/pro-forma#choose-what-happens-when-it-is-paid).
- **Store order numbers** are given to every order in your [online store](online-store). The invoice gets its own number once the order is paid.
- Credit notes use the invoice format with `CN` in front and count separately.
