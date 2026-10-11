# Inventory

Keep stock by item and warehouse, value it by FIFO or average cost, count it once a year and let every sale reduce it on its own.

## Start keeping stock

Inventory is a separate license. Redeem an inventory key on the **License** page and the **Inventory** tab appears in the menu.

1. Open **Inventory** and press **Keep stock for an item**.
2. Choose the item. Only items of the type goods can keep stock, services and license keys cannot.
3. Choose the stock type. **Goods** are bought to be resold. **Material** is used up in your work or production.
4. Optionally enter a minimum stock. The item is marked when it falls below it.

From that moment every issued invoice with this item reduces its stock. Invoices issued before that moment are not touched.

## Enter the stock you already have

When you start, enter what is on your shelves today with **Opening stock** under **More documents**.

1. Choose the date and the warehouse.
2. Add a line for every item with its quantity and its purchase value without VAT.
3. Choose the ledger entry. Pick **None** when your accountant already has this stock in the opening balance. Pick **Recognise the stock and reduce costs** when the goods were booked as a cost when you bought them.
4. Press **Post**.

## Receive goods

1. Press **New receipt**.
2. Enter the supplier and the number of the delivery note or invoice.
3. Add the items with the quantity and either the unit price or the line value, both without VAT.
4. Enter transport, customs and similar costs under **Dependent costs**. They are spread over the lines by value and become part of the purchase value, as SRS 4 requires.
5. Press **Save draft** to continue later or **Post** to book the goods into stock.

When you record the supplier's invoice under **Expenses**, set **Stock purchase** to goods or material. Such an invoice is not a cost yet. It then appears on the Inventory page under **Purchases without a receipt**, where **Create receipt** opens a receipt with the supplier, the number and the value filled in.

## Order from a supplier

Purchase orders are optional. Use them when you want to know what is on its way and what a supplier still owes you.

1. Add the supplier under **Inventory**, **Suppliers** with its tax number and IBAN.
2. Open **Orders**, press **New purchase order**, choose the supplier and add the items, quantities and agreed prices without VAT.
3. Press **Confirm order**. The order gets its number and can be printed and sent to the supplier.
4. When the goods arrive, open the order and press **Receive goods**. The receipt opens with the open quantities and prices, so you only correct what really arrived. A delivery in several parts is simply several receipts.

The order closes itself when everything has arrived. **Close order** ends it earlier when nothing more is expected. Ordered quantities are shown as on order in the stock list, and the order shows the ordered, received and invoiced values side by side, so a supplier invoice that does not match the receipts stands out.

**Items to reorder** on the Orders page lists every item whose stock together with open orders is below its minimum. **Create order** opens an order with the missing quantities and the last purchase prices.

## What happens when you sell

You do nothing. An issued invoice, a sale at the terminal and a paid online order all take the goods out of the default warehouse and calculate their purchase value.

- Canceling an invoice in full brings the goods back at the value they left with.
- A partial credit note does not move stock. When the customer really returns goods, enter a **New receipt** with the reason **Return from a customer** and choose the invoice.
- When stock may not go below zero (see [Choose the valuation method](#choose-the-valuation-method)), an invoice for more than you have is refused.

## Issue stock for other reasons

Use **New issue** for everything that leaves stock without a sale and choose the reason.

- **Used in the business** turns material into a cost.
- **Damage or breakage** and **Expired or obsolete** write the goods off. Keep a record of the destruction.
- **Normal loss (kalo)** is loss within the norm of your trade association. No VAT is due.
- **Shortage above the normal loss**, **Private or own use** and **Gift or sample** usually count as a supply. Leave **Charge VAT on the purchase value** switched on and the VAT is posted and listed in the DDV records as an internal document.
- **Theft** carries no VAT when the police made a report. **Force majeure** covers fire, flood and similar events.
- **Return to the supplier** sends goods back. Record the supplier's credit note as a stock purchase.

## Move stock between warehouses

Add warehouses under **Inventory**, **Settings**. Stock is kept and valued separately for each one.

1. Choose **New transfer** under **More documents**.
2. Choose the warehouse the goods leave and the one they go to.
3. Add the items and quantities and press **Post**.

The goods keep their purchase value. Sales always take from the default warehouse, so transfer goods there before selling them.

## Count your stock

The Companies Act (ZGD-1) requires you to compare the books with the real state at least once a year.

1. Choose **New stocktake** under **More documents**, then the date and the warehouse.
2. Press **Print count sheet** for a list to count from. The version without booked stock keeps the counters from copying the expected numbers.
3. Press **Add all items** and enter the counted quantity for each. Items you leave out are not changed. Enter 0 for an item that is not there at all.
4. Decide whether shortages are charged with VAT. A shortage above the normal loss is, see [Issue stock for other reasons](#issue-stock-for-other-reasons).
5. Press **Post**. Surpluses and shortages are booked at the current purchase value.

After a stocktake nothing can be booked for the counted items on or before its date. Print the posted stocktake as the record for the stocktake committee to sign.

## Cancel a document

A posted document cannot be changed. Open it, press **Cancel document** and give the reason. Its movements are removed, everything issued later is valued again and the ledger entry is reversed. The document stays in the list as canceled and keeps its number. Then enter a new, correct document.

## See stock on a past date

**Stock on a date** shows quantities and values as they stood at the end of any day, for example 31 December for the balance sheet. Download it as CSV or print it.

The **item card** behind every item name lists each receipt, sale and issue with the quantity and value after it.

## Choose the valuation method

Under **Inventory**, **Settings** you choose how the purchase value of sold and used stock is calculated. SRS 4 allows both.

- **Moving weighted average cost** recalculates the average price with every receipt.
- **FIFO** issues the oldest purchase first.

Before the first movement you can choose freely. Later the method can change only from 1 January of a year that is not closed, because it is a change of accounting policy. Agree it with your accountant first.

**Allow stock to go below zero** decides what happens when you sell or issue more than the books show. When allowed, the missing quantity is valued at the last known price and corrected when the receipt arrives. When not allowed, such documents and invoices are refused.

## How stock reaches the ledger

With the accounting license every stock document posts itself.

- A stock purchase invoice goes to the purchase account (650 for goods, 300 for material) and a receipt moves the value to stock (660 or 310).
- A sale moves the purchase value from stock to cost of goods sold (702) and the revenue of such items goes to 762 or 763.
- Material used in the business becomes a material cost (400). Write-offs go to 721.
- A shortage or surplus of goods corrects 702.

**Inventory**, **Settings** compares the stock value with the balance of the stock account, so a missing opening balance or a manual entry is noticed at once.

## Sell stocked items in the online store

An item that keeps stock shows its real availability in the [online store](online-store). The store counts the default warehouse and holds back orders that are placed but not paid yet. The stock number on the store product is no longer used for such items.
