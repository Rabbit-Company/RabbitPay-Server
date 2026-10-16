# Choose how stock is valued

Open the **Settings** tab of **Inventory**.

![The valuation settings](https://cdn.rabbitpay.net/help/en/dark/inventory/settings/valuation.webp)

## Valuation method

The **Valuation method** decides how the purchase value of sold and used stock is calculated. SRS 4 allows both.

- **Moving weighted average cost** recalculates the average price with every receipt.
- **FIFO (first in, first out)** issues the oldest purchase first.

Before the first movement you can choose freely. Later the method can change only from 1 January of a year that is not closed, because it is a change of accounting policy. Agree it with your accountant first.

## Stock below zero

**Allow stock to go below zero** decides what happens when you sell or issue more than the books show. When allowed, the missing quantity is valued at the last known price and corrected when the receipt arrives. When not allowed, such documents and invoices are refused.

## Terminal warehouse

**Terminal sells from** lets the [terminal](terminal) take goods from another warehouse, for example a shop. Invoices and the online store always take from the default warehouse.

## How stock reaches the ledger

With the accounting license every stock document posts itself.

- A stock purchase invoice goes to the purchase account (650 for goods, 300 for material) and a receipt moves the value to stock (660 or 310).
- A sale moves the purchase value from stock to cost of goods sold (702) and the revenue of such items goes to 762 or 763.
- Material used in the business becomes a material cost (400). Write-offs go to 721.
- A shortage or surplus of goods corrects 702.

The settings then also show a **Comparison with the ledger**, so a missing opening balance or a manual entry is noticed at once.
