# Crypto

Accept Bitcoin, Ethereum and Monero straight into your own wallet. RabbitPay gives every invoice its own address, watches it and marks the invoice as paid once the payment is confirmed.

RabbitPay can see incoming payments but can never spend them.

## How it works

- You give RabbitPay a public key of your wallet, never a private key or a seed phrase. A private key is refused.
- Each invoice gets a new address from that key. The coins arrive in your wallet.
- The price is taken at the moment the customer chooses a coin, and the amount is fixed for that address. A change in the market while the customer is paying does not leave the invoice short.

## Accept Bitcoin

1. In your wallet, find the **extended public key** of the account that should receive payments. It starts with `zpub`, `ypub` or `xpub`. In Sparrow it is under **Settings** > **Keystore**, in Electrum under **Wallet** > **Information**.
2. In RabbitPay, open **Settings** and find **Bitcoin** in the card **Payment methods**.

   ![Bitcoin before it is set up](https://cdn.rabbitpay.net/help/en/dark/payments/crypto/bitcoin-empty.webp)

3. Paste the key under **Extended public key**.
4. Leave **Address type** on **From the key** unless your wallet uses another type.
5. Press **Save**.

   ![The extended public key, ready to save](https://cdn.rabbitpay.net/help/en/dark/payments/crypto/bitcoin-key.webp)

6. Compare the **First receiving address** that RabbitPay now shows with the first address in your wallet. They must be the same.
7. Press the switch next to **Bitcoin**.

   ![Bitcoin is ready, with the first receiving address shown](https://cdn.rabbitpay.net/help/en/dark/payments/crypto/bitcoin-on.webp)

> **Important:** If the first address is not the one your wallet shows, do not switch Bitcoin on. Payments would go to addresses your wallet does not look at. Check the address type.

Unpaid invoices leave unused addresses behind. If your wallet misses a payment, raise its gap limit.

## Accept Ethereum

1. Export the **account extended public key** of your wallet, the xpub of the path `m/44'/60'/0'`. This is the path MetaMask, Ledger and Trezor use. MetaMask does not show this key, so export it with a hardware wallet tool or from your seed on an offline machine.
2. Paste it under **Account extended public key** in **Ethereum** and press **Save**.
3. Compare the **First receiving address** with your wallet, then press the switch.

   ![Ethereum is ready and switched on](https://cdn.rabbitpay.net/help/en/dark/payments/crypto/ethereum-on.webp)

## Accept Monero

Monero payments cannot be looked up publicly, so RabbitPay needs a view-only wallet that you run yourself.

1. Create a view-only wallet from your primary address and your private view key.
2. Run `monero-wallet-rpc` with it on a server that RabbitPay can reach.
3. Enter its **Wallet RPC URL**, the **RPC username** and **RPC password**, and the **Account** that receives payments. Use `0` if you are unsure.
4. Press **Save**, then press the switch.

   ![The Monero details](https://cdn.rabbitpay.net/help/en/dark/payments/crypto/monero.webp)

A view-only wallet can see payments but cannot spend them.

## What your customer sees

On the payment page the customer chooses a coin.

![Bitcoin and Ethereum on the payment page](https://cdn.rabbitpay.net/help/en/dark/payments/crypto/choose-coin.webp)

The page shows the address, a QR code that a wallet app can scan, and the exact amount in the coin. Under it are the price that was used and the time left to pay.

![Paying an invoice with Bitcoin](https://cdn.rabbitpay.net/help/en/dark/payments/crypto/pay-with-bitcoin.webp)

- The price is held for one hour. A payment sent later is not recorded by itself.
- A payment that was seen but is not confirmed yet is shown as pending and does not count yet.
- The invoice becomes **paid** after the number of confirmations shown on the page, and the page updates by itself.
