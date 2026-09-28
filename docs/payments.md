# Payments

## Payment methods per project

Each project connects its own accounts under its Settings, so money goes straight
to the company that issued the invoice and never through an account of whoever
runs the server. The admin settings only switch a method on for the whole server
and sets the endpoints it talks to.

| Method        | What a project enters                                  |
| ------------- | ------------------------------------------------------ |
| Bitcoin       | Extended public key (zpub, ypub or xpub), address type |
| Ethereum      | Account extended public key (xpub of `m/44'/60'/0'`)   |
| Monero        | View-only wallet RPC URL, login and account            |
| Bank transfer | IBAN and account details                               |
| Stripe        | Secret key and webhook signing secret                  |
| PayPal        | REST client id, secret and webhook id                  |

Credentials are encrypted with the master key and are never returned by the
API once saved. The settings screen shows only whether a field is set. Leaving a
secret field blank keeps what is already stored, so changing one field does not
wipe another. Changing the Monero wallet URL forgets the stored wallet password,
so it is never sent to a different host.

Keys are checked when they are saved. A private key is refused outright, and the
first receiving address is shown so the owner can compare it with their wallet
before any customer pays.

A method is offered to a customer when the server supports it, the project has
switched it on, and its details are complete and valid. A new project starts with
everything off.

Stripe and PayPal webhooks all arrive at the same URLs. Each event is verified
with the secret of the project whose checkout it belongs to. Events that belong to
no checkout here are acknowledged and ignored, so a company's Stripe account does
not keep retrying them.

| Method | Path                                           | Permission     |
| ------ | ---------------------------------------------- | -------------- |
| `GET`  | `/api/v1/projects/:uuid/processors`            | `project.view` |
| `PUT`  | `/api/v1/projects/:uuid/processors/:processor` | `project.edit` |

Changing payment methods needs `project.edit`, so an owner or admin. A developer
with API key access cannot redirect where money goes, and an API key cannot
change these at all.

## Currencies

The list of currencies the interface offers comes from RabbitForex rather than a
hardcoded handful, so every currency it quotes can be billed in.

| Method | Path                         | Permission    |
| ------ | ---------------------------- | ------------- |
| `GET`  | `/api/v1/currencies`         | authenticated |
| `GET`  | `/api/v1/currencies/convert` | authenticated |

`GET /api/v1/currencies` returns the codes, the rates behind them and the base
they are quoted against, along with `live`. When the feed cannot be reached
`live` is `false` and the codes fall back to what the runtime itself knows, so a
currency can still be picked while nothing can be converted.

`GET /api/v1/currencies/convert?from=EUR&to=JPY&amount=100` crosses the two
through the base and answers with `result` and the unit `rate`. It is a
convenience for people, not a settlement rate: what a customer actually owes is
fixed when a payment address is assigned, as described below.

The interface has a Converter in the header for checking what an amount is
worth elsewhere. It converts in the browser from the rates fetched once, so
typing gives an answer immediately.

## Exchange rates

An invoice is written in ordinary money, so paying it in a coin needs a price.
The server reads one from [RabbitForex](https://forex.rabbitmonitor.com) rather
than asking anybody to type it. The API address and the cache time are under
Admin, Settings, Payments.

Rates are fetched per invoice currency and cached for the rate cache time through the
same two layer cache as everything else, so a busy checkout asks the API roughly
once a minute and not once a customer. The API quotes coins per unit of the base
currency, and the server stores the reciprocal, the familiar price of one coin.

A rate is locked when the address is assigned. The amount the customer owes in
satoshi, wei or piconero is written down with the address and never repriced, so a
move in the market between opening the page and sending the coins cannot leave the
payment short. Reloading the payment page returns the same address and the same
amount.

An authenticated machine API caller may still send `exchange_rate` to its crypto
endpoints, which lets an integration use its own trusted price feed or add a
spread. The unauthenticated public checkout never accepts a caller-provided rate.
It always uses the server's configured provider. When no server rate can be
fetched, public checkout is refused with `1059 RATE_UNAVAILABLE` instead of
guessing. Turning off Look up exchange rates therefore disables public crypto
checkout, while making `exchange_rate` mandatory for the authenticated machine
API.

## Bitcoin

Turn it on under Admin, Settings, Bitcoin, then ask for an address for an issued invoice:

```bash
curl -X POST localhost:8085/api/v1/pay/invoices/$INVOICE/bitcoin \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  -d '{"exchange_rate":50000}'
```

`exchange_rate` is how many units of the invoice currency one bitcoin is worth,
and it is optional. Leave it out and the server fetches the price itself, as
described under [Exchange rates](#exchange-rates). Send it and yours is used
instead, which is how you add your own spread or use whichever source you trust.

Either way the rate is locked to that address, recorded on every payment that
arrives there, and used to decide how much the invoice is credited.

The response carries the address, the expected amount in satoshis, a `bitcoin:`
URI suitable for a QR code, and how many confirmations the server will wait for.
Asking again while the address is still live returns the same address rather than
burning a new one.

Addresses are derived per invoice from the extended public key the project
entered (zpub, ypub or xpub), at `0/n` below it, the receiving chain every wallet
scans. The server can watch those addresses but never spend from them, and the
payments show up in the company's own wallet. Unpaid invoices leave gaps in the
sequence, so raise the wallet's gap limit if it misses payments.

A background task polls the chain every `poll_interval` seconds. A payment it
sees is recorded immediately as `pending`, which shows up on the invoice without
crediting it, and flips to `completed` once it reaches `confirmations`, at which
point the invoice settles through the same ledger as any other payment.
Underpayments leave the invoice `partially_paid`, overpayments are credited in
full, and several payments to one address all count.

Conversion rounds so neither side is short changed: the amount asked of the payer
rounds up to the next satoshi, and the fiat credited to the project rounds
down.

The chain is read through any Esplora compatible API, set by `api_url`.
A public one such as mempool.space tells its operator which addresses you are
watching, so run your own instance if that matters to you.

> Not covered yet: BTC denominated invoices (set `currency` to a fiat code and
> convert with a rate), automatic price feeds, and chain reorganisations deeper
> than the confirmation count you configure.
>
> The chain API returns only the most recent 25 transactions for an address and
> the client does not paginate. An address serves one invoice and normally sees a
> single payment, so this only matters if you reuse an address far beyond its
> intended life.

## Ethereum

Works the same way as Bitcoin. Turn it on under Admin, Settings, Ethereum and ask for an address:

```bash
curl -X POST localhost:8085/api/v1/pay/invoices/$INVOICE/ethereum \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  -d '{"exchange_rate":2000}'
```

The response carries the address, the amount in wei and gwei, an EIP-681 `ethereum:`
URI including the chain id, and the confirmations the server waits for. As with
Bitcoin the rate is fetched unless you send one, it is locked to that address, and
a background task credits the invoice once transfers confirm.

Addresses derive from the account extended public key the project entered, the
xpub of `m/44'/60'/0'`, at `0/n` below it, the path MetaMask, Ledger and Trezor
use. The server cannot spend from them. Bitcoin and Ethereum keep separate
derivation index spaces, and so does every key, so two projects never share an
address.

The chain is read through any Etherscan compatible API, set by `api_url`.
Etherscan itself needs an `api_key`. Blockscout does not and can be self hosted,
which avoids telling a third party which addresses are yours.

Amounts use BigInt throughout. One ether is 10^18 wei, which overflows both a
JavaScript number and a 64 bit database integer, so transfers are read and summed
as BigInt. Only the expected amount is stored, in gwei, which is comfortably
within range. Sub-gwei dust is not tracked, which is worth about a millionth of a
cent.

> Not covered yet: ERC-20 tokens, so only native ETH is detected. The chain API
> is asked for the 50 most recent transactions for an address without paginating,
> which is ample for a per-invoice address but not for a reused one. Chain
> reorganisations deeper than your confirmation count are not handled.

## Choosing a chain backend

Bitcoin and Ethereum can each read the chain from a public HTTP API or from your
own node, set by `backend` in their config section. Monero only works against
your own wallet.

| Chain    | `backend = "..."` | Reads from                                   |
| -------- | ----------------- | -------------------------------------------- |
| Bitcoin  | `esplora`         | mempool.space, blockstream.info, or your own |
| Bitcoin  | `rpc`             | Bitcoin Core over JSON-RPC                   |
| Ethereum | `etherscan`       | Etherscan, or Blockscout which needs no key  |
| Ethereum | `rpc`             | geth, erigon, reth or similar over JSON-RPC  |
| Monero   | always RPC        | monero-wallet-rpc                            |

A public API sees every address you ask about, so it learns which addresses are
yours even though it never holds your keys. Your own node avoids that. The
tradeoff is running one.

Bitcoin over RPC imports each assigned address into a watch only wallet, so
the node needs a loaded wallet named by `rpc_wallet` and an RPC user allowed to
import. Descriptor wallets are used where available, with a fallback to
`importaddress` for legacy ones. Payments are then read per transaction, the same
as Esplora gives.

Ethereum over RPC works differently and it matters. A plain node has no
address to transaction index, which is exactly why services like Etherscan
exist. Since an invoice address only ever receives, the RPC backend reads its
balance instead: the balance at the current block is a pending payment, and the
balance a confirmation depth behind is a settled one. The consequence is that
several transfers to one address appear as one payment rather than several.
The Etherscan backend lists them individually. Both settle the invoice for the
same total.

## Monero

Monero has no public explorer that can tell you what an address received. That is
the point of Monero, and it means detection needs a wallet holding the view key.
Each project runs `monero-wallet-rpc` with a view-only wallet, made from its
primary address and private view key, and enters its URL and login under
Settings:

```bash
monero-wallet-rpc --wallet-file shop-view-only --rpc-bind-port 18083 \
  --daemon-address node.example.com:18081 --rpc-login shop:secret
```

```bash
curl -X POST localhost:8085/api/v1/pay/invoices/$INVOICE/monero \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' \
  -d '{"exchange_rate":150}'
```

Each invoice gets its own subaddress in the chosen account of that wallet, 0
unless the project picks another, so payments stay attributable per invoice. A
wallet URL on a private or loopback address is refused unless the server sets
Admin, Settings, Payments, Allow private wallet addresses, since otherwise any project could make
this server call things only it can reach.

The response carries the subaddress, the amount in piconero, and a `monero:` URI.
Transfers are matched back to an invoice by subaddress index, and the wallet's
transaction pool is polled too, so an unconfirmed payment shows up before it
settles.

> A view-only wallet can see incoming payments but cannot spend them, so neither
> the server nor its operator can move a project's funds.

## Stripe and PayPal

Both are hosted checkouts. You ask for a checkout, send the customer to it, and
the processor calls back when they have paid. No card details ever touch this
server.

```bash
curl -X POST localhost:8085/api/v1/pay/invoices/$INVOICE/stripe \
  -H "Authorization: Bearer $APIKEY" \
  -H 'Content-Type: application/json' -d '{}'
```

```json
{
	"processor": "stripe",
	"checkout_id": "cs_test_...",
	"checkout_url": "https://checkout.stripe.com/c/pay/...",
	"amount": 25000,
	"currency": "EUR"
}
```

Send the customer to `checkout_url`. `/paypal` works identically and returns the
PayPal approval link. Asking again while a checkout is still live returns the
same link rather than opening another.

Point each processor's webhook at this server:

| Processor | Webhook URL                               | Subscribe to                                           |
| --------- | ----------------------------------------- | ------------------------------------------------------ |
| Stripe    | `https://your-server/api/v1/hooks/stripe` | `checkout.session.completed`                           |
| PayPal    | `https://your-server/api/v1/hooks/paypal` | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` |

These two endpoints are the only ones on the server that take neither a session
nor an API key, because the processor calling them has neither. What stands in
for authentication is the signature, so an unverified webhook is rejected and
nothing is credited. It is just someone claiming they paid you.

Stripe signs with HMAC-SHA256 over the timestamp and the raw body, checked in
constant time. The timestamp is checked too, inside a five minute window, so a
genuine "paid" callback captured off the wire cannot be replayed later. A header
carrying several signatures is accepted, which is what Stripe sends while you
rotate the secret.

PayPal is verified by asking PayPal, which is how their scheme works: the
transmission headers and the event are posted back to
`/v1/notifications/verify-webhook-signature` and only a `SUCCESS` is trusted.
That needs `webhook_id` from the PayPal dashboard, and without it every webhook
is rejected.

PayPal orders are captured on approval, so `CHECKOUT.ORDER.APPROVED` triggers the
capture and credits the invoice. If the capture fails nothing is credited and the
invoice is left alone.

Every verified event is written to `webhook_events` with its payload and whether
it was processed, so a payment that did not land can be traced. Crediting is keyed
on the processor's own payment id, so a webhook delivered twice, which both
processors do, credits once.

> Each project enters its own credentials under Settings.
>
> Not covered yet: refunds through either API, so a refund is recorded here and
> has to be issued in the Stripe or PayPal dashboard. Stripe Checkout only, not
> Payment Intents or subscriptions.

## Bank transfer

A merchant who wants to be paid by ordinary transfer switches on Bank
transfer under Settings and gives an IBAN. Nothing else is needed, and no
third party is involved: the customer sees the account, the amount and the
invoice reference, and pays from their own bank.

| Field            | Notes                                          |
| ---------------- | ---------------------------------------------- |
| `iban`           | Checked with the mod-97 checksum               |
| `bic`            | Optional                                       |
| `account_holder` | Optional, defaults to the company's legal name |
| `bank_name`      | Optional                                       |
| `qr_format`      | `auto`, `epc`, `upn` or `none`                 |

The payment code is a real one. A Slovenian account gets a UPN QR, which is
what Slovenian bank applications read for skeniraj in placaj, and the rest of the
euro area gets an EPC QR, the GiroCode. They are not interchangeable, so `auto`
picks by the country of the IBAN and a merchant can override it. Both come from
[@rabbit-company/qrcode](https://github.com/Rabbit-Company/QRCode-JS), which
carries the payload rules for each.

A code is only offered for an invoice in euro, since both formats are euro only,
and the amount in it is what is still owed rather than the invoice total, so a
part paid invoice asks for the remainder. UPN QR must be encoded as ISO-8859-2,
so a company name carrying a character outside that set is reported instead of
producing a code no application can read.

Bank transfers are not detected. Nothing watches the account, so record the
payment by hand when it lands, and the payment page says as much rather than
pretending it will update itself.

## Payment page

Every issued invoice has a public page at `/pay/<invoice id>`, which needs no
account. Open an invoice in the dashboard and use Copy payment link to send it
to a customer.

The page shows what is owed and what it is for, offers the methods that project
accepts, and after a method is chosen shows a QR code and the address, or the bank
details and reference, or forwards to Stripe or PayPal. It polls while it is open,
so it flips to Paid on its own when the money arrives.

A coin amount is shown the way a wallet asks for it, as `0.00074716 BTC` rather
than a count of satoshis, with the smaller unit and the price it was worked out at
underneath. The customer is never asked for an exchange rate.

The page is headed by the project's display name, so a customer sees `Bloggy
Studio` rather than the `bloggy` slug.

The invoice id is the only thing needed to open it, so treat the link as the
capability it is. Nothing about the project, its keys or its other invoices is
exposed, and a draft invoice is not visible at all.

## Terminal

Each project has a Terminal for selling in person, which also runs full screen on
a tablet or an Android POS device. Tap products from Items, search or scan a
barcode, or type a custom amount on the keypad, then charge the sale. Cash is
recorded with the amount handed over and the change to give back. For other
methods the terminal shows a QR code for the payment page and waits for the
payment. Each sale is an issued invoice with a receipt that can be printed or
emailed, and a Slovenian project with fiscal verification sends cash and card
sales to FURS straight away. A cashier only sees the terminal and their own
sales. Canceling a sale that already has a number issues a credit note.

## Embedding on your own site

Drop the script in and mark an element with the invoice you want paid:

```html
<div data-rabbitpay-invoice="4f2c...-..." data-rabbitpay-label="Pay €5.00"></div>
<script src="https://your-server/embed.js"></script>
```

That renders a button which opens the payment page in an overlay, so the customer
never leaves your site. To drive it yourself:

```js
RabbitPay.open("4f2c...-...", {
	onPaid: function (invoice) {
		console.log("paid", invoice);
	},
	onClose: function (reason) {
		console.log("closed", reason);
	},
});
```

The overlay reports back with `postMessage`, and the script only accepts messages
from the server it was loaded from, so another page on the site cannot forge a
payment. Treat `onPaid` as a hint for the interface: confirm against your own
server through the API or a webhook before shipping anything.
