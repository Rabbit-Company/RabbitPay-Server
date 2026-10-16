# Sales and returns

You do nothing. An issued invoice, a sale at the [terminal](terminal) and a paid [online store](online-store) order all take the goods out of the default warehouse and calculate their purchase value.

## Follow an item

Press an item on the **Stock** tab to open its card. It shows the quantity, the value and the unit cost, and every receipt, sale and issue with the balance after it.

![The card of a print after a sale](https://cdn.rabbitpay.net/help/en/dark/inventory/sales/item-card.webp)

Press the document number of a movement to open it, and **Open item** to edit the item itself.

## Returns and corrections

- Canceling an invoice in full brings the goods back at the value they left with.
- A partial credit note does not move stock. When the customer really returns goods, enter a [receipt](inventory/receive-goods#goods-a-customer-returns) with the reason **Return from a customer**.
- When stock may not go below zero (see [Choose how stock is valued](inventory/settings)), an invoice for more than you have is refused.

## Terminal and online store

The terminal can sell from another warehouse than the default one, for example your shop. Choose it on the **Settings** tab of **Inventory** under **Terminal sells from**.

The online store shows the real stock of the default warehouse and holds back orders that are placed but not paid yet, so the last piece cannot be sold twice.
