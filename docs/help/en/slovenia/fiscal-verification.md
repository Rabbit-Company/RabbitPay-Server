# Fiscal verification

In Slovenia, invoices paid in cash, by card or in crypto must be verified by FURS. Connect RabbitPay to FURS once and it does this for every such invoice.

The Financial Administration (FURS) has to verify each of them before the customer gets it. Bank transfers and PayPal payments are not verified.

Until verification is set up, a Slovenian project cannot take cash at the terminal, card payments or crypto.

## What you need

- The **certificate for fiscal verification** (a `.p12` file) and its password. You order it in eDavki, in the section for cash registers (**Davčne blagajne**). It is not the same as your qualified certificate for signing.
- The **cadastral data** of your business premises: the cadastral municipality number, the building number and the building part number. You find them in the public real estate register (GURS). If you sell only online or from a single device, you can register a movable premise instead.
- The **personal tax number** of everyone who issues invoices.

## Open the setup

Open **Settings** at the bottom of the project menu and scroll to **Fiscal verification (FURS)**.

![Settings at the bottom of the project menu](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/open-settings.webp)

The card shows **Not active** until all four steps are done.

![Fiscal verification before it is set up](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/not-active.webp)

## 1. Upload the certificate

1. Under **1. Certificate**, choose your `.p12` file in **Certificate file (.p12)**.
2. Type its password in **Certificate password**.
3. Press **Upload certificate**.

   ![The certificate and its password, ready to upload](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/certificate-form.webp)

RabbitPay reads the holder, your tax number and the expiry date from the certificate and shows them. Press **Test connection** to check that FURS answers. You should see **FURS answered.**

![The certificate is saved](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/certificate-saved.webp)

The certificate is stored encrypted. The pill next to the status shows **Production** for a real certificate. A test certificate from FURS shows **Test environment**, and nothing you issue with it counts for tax.

> **Tip:** Note the **Valid until** date. Before it passes, download a new certificate in eDavki and press **Replace certificate**. An expired certificate stops verification, and with it cash, cards and crypto.

## 2. Register your business premises

Every verified invoice names the premises it was issued from. FURS needs to know them in advance.

1. Under **2. Business premises**, open **Register a premise**.
2. Enter a **Premise ID**, for example `PP1`. Letters and digits only, up to 20. It becomes the first part of every invoice number, so keep it short.
3. Choose the **Type**:
   - **Building** for a shop, an office or any other premises with an address. Enter the cadastral data and the address.
   - **Movable premise or device** for a vehicle, a market stall or a single electronic device. Choose the **Kind of premise**. A web shop with no premises usually registers type **C: individual electronic device**.
4. Press **Register with FURS**.

   ![A building registered as premises PP1](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/premise-form.webp)

The premise appears in the list with the day it was registered.

![The registered premise](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/premise-registered.webp)

If you move out, press **Close** next to the premise. FURS is told and no more invoices can be issued from it. Register the new premises first.

## 3. Choose the devices and switch it on

A device is the till or the program that numbers the invoices. RabbitPay uses one device for invoices and online payments and, if you want, a separate one for the terminal.

1. Under **Invoices and online payments**, choose the **Premise** and enter a **Device ID**, for example `SPLET1`.
2. Under **Terminal**, choose **Same as invoices**, or a premise and a separate **Device ID**, for example `BLAG1`.
3. Leave **Fallback tax number** empty unless invoices are also issued by people without a tax number of their own. See the next step.
4. Switch on **Verify invoices with FURS**.
5. Press **Save**.

   ![Devices SPLET1 for invoices and BLAG1 for the terminal](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/devices.webp)

From now on invoices are numbered premise, device and number, for example `PP1-SPLET1-1` for invoices and `PP1-BLAG1-1` at the terminal. The numbers on each device continue without gaps, as the law requires.

## 4. Enter who issues invoices

FURS receives the personal tax number of the person who issued each invoice, and the invoice prints their name.

1. Under **4. People who issue invoices**, find each person.
2. Type their 8 digit tax number and press **Save** in that row.

   ![The owner's tax number, ready to save](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/operators.webp)

The status changes from **Missing** to **Entered**. Invoices without a creator, such as recurring invoices and invoices made through the API, use the project owner. A person without a tax number uses the **Fallback tax number** from step 3.

The name on the invoice comes from each person's invoice identity. Everyone sets their own full name under **Team** > **Invoice identity**, in their own row.

## Done

The status is now **Active**.

![Fiscal verification is active](https://cdn.rabbitpay.net/help/en/dark/slovenia/fiscal-verification/active.webp)

Cash, card and crypto payments are allowed again, and every such invoice is sent to FURS automatically. See [Invoices sent to FURS](slovenia/verified-invoices) for what happens next.

## Questions

**Do I need this if I only take bank transfers?** No. Invoices paid only by bank transfer or PayPal are not verified. You need it as soon as you take cash, cards or crypto.

**Can I try it first?** Yes. Ask FURS for a test certificate at sd.fu@gov.si and upload it. The project then talks to the FURS test environment. When you are ready, press **Replace certificate**, upload the real one and register your premises again, because premises are registered separately in each environment.

**I have two shops.** Register both as separate premises. Choose which one is used for invoices and which one for the terminal in step 3.
