# Receive goods

A receipt books goods into stock at their purchase value without VAT.

## Enter a receipt

1. On the **Stock** tab, press **New receipt**.

   ![New receipt](https://cdn.rabbitpay.net/help/en/dark/inventory/receive-goods/new-receipt.webp)

2. Check the **Date**, the **Warehouse** and the **Reason**. Purchases use **Purchase from a supplier**.
3. Enter the **Supplier** and the number of their **delivery note or invoice**.
4. Add the items with the **Quantity** and either the **Unit price** or the **Line value**, both without VAT.
5. Enter transport, customs and similar costs under **Dependent costs**. They are spread over the lines by value and become part of the purchase value, as SRS 4 requires.

   ![A receipt of two prints with transport costs](https://cdn.rabbitpay.net/help/en/dark/inventory/receive-goods/receipt.webp)

6. Press **Post**, or **Save draft** to continue later.
7. Confirm with **Post**.

   ![Confirming the receipt](https://cdn.rabbitpay.net/help/en/dark/inventory/receive-goods/confirm.webp)

The receipt gets its number and the goods are in stock. The unit cost includes the dependent costs.

![The posted receipt](https://cdn.rabbitpay.net/help/en/dark/inventory/receive-goods/posted.webp)

## From the supplier's invoice

When you record the supplier's invoice under **Expenses**, set **Stock purchase** to goods or material. Such an invoice is not a cost yet. It appears on the **Stock** tab under **Purchases without a receipt**.

![A supplier invoice waiting for its receipt](https://cdn.rabbitpay.net/help/en/dark/inventory/receive-goods/purchases.webp)

Press **Create receipt**. The receipt opens with the supplier, the number and the value filled in. Choose the items and the quantities and post it.

![A receipt created from the supplier invoice](https://cdn.rabbitpay.net/help/en/dark/inventory/receive-goods/from-invoice.webp)

If the invoice came as an e-invoice, the lines are proposed from it, matched by item name, SKU or the supplier's own description from earlier receipts.

## Goods a customer returns

Choose the reason **Return from a customer** and pick the **Invoice of the sale**. The goods come back at the value they left with. See [Sales and returns](inventory/sales).
