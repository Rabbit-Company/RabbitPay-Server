import * as ecc from "tiny-secp256k1";
import BIP32Factory, { type BIP32Interface } from "bip32";
import bs58check from "bs58check";
import * as bitcoin from "bitcoinjs-lib";
import { hdkey } from "ethereumjs-wallet";

export type BitcoinScript = "p2wpkh" | "p2sh-p2wpkh" | "p2pkh";
export type BitcoinAddressType = BitcoinScript | "auto";

interface KeyVersion {
	network: bitcoin.Network;
	script: BitcoinScript;
}

const XPUB = 0x0488b21e;
const TPUB = 0x043587cf;

const PUBLIC_VERSIONS: Record<number, KeyVersion> = {
	[XPUB]: { network: bitcoin.networks.bitcoin, script: "p2pkh" },
	0x049d7cb2: { network: bitcoin.networks.bitcoin, script: "p2sh-p2wpkh" },
	0x04b24746: { network: bitcoin.networks.bitcoin, script: "p2wpkh" },
	[TPUB]: { network: bitcoin.networks.testnet, script: "p2pkh" },
	0x044a5262: { network: bitcoin.networks.testnet, script: "p2sh-p2wpkh" },
	0x045f1cf6: { network: bitcoin.networks.testnet, script: "p2wpkh" },
};

const PRIVATE_VERSIONS = new Set([0x0488ade4, 0x049d7878, 0x04b2430c, 0x04358394, 0x044a4e28, 0x045f18bc]);

export const BITCOIN_ADDRESS_TYPES: BitcoinAddressType[] = ["auto", "p2wpkh", "p2sh-p2wpkh", "p2pkh"];

const bip32 = BIP32Factory(ecc);

export class WatchOnlyKeyError extends Error {}

export interface BitcoinWatchKey {
	node: BIP32Interface;
	network: bitcoin.Network;
	script: BitcoinScript;
}

function decode(key: string): Uint8Array {
	try {
		return bs58check.decode(key.trim());
	} catch {
		throw new WatchOnlyKeyError("This is not an extended public key. Check that it was copied in full.");
	}
}

export function isBitcoinAddressType(value: unknown): value is BitcoinAddressType {
	return typeof value === "string" && (BITCOIN_ADDRESS_TYPES as string[]).includes(value);
}

export function parseBitcoinKey(key: string, addressType: string | undefined = "auto"): BitcoinWatchKey {
	const bytes = decode(key);
	if (bytes.length !== 78) throw new WatchOnlyKeyError("This is not an extended public key. Check that it was copied in full.");

	const version = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
	if (PRIVATE_VERSIONS.has(version)) throw new WatchOnlyKeyError("This is a private key. Paste the public key instead, it starts with xpub, ypub or zpub.");

	const known = PUBLIC_VERSIONS[version];
	if (!known) throw new WatchOnlyKeyError("This key is not a Bitcoin extended public key. It should start with xpub, ypub or zpub.");

	const normalized = new Uint8Array(bytes);
	new DataView(normalized.buffer).setUint32(0, known.network === bitcoin.networks.bitcoin ? XPUB : TPUB);

	let node: BIP32Interface;
	try {
		node = bip32.fromBase58(bs58check.encode(normalized), known.network);
	} catch {
		throw new WatchOnlyKeyError("This extended public key could not be read.");
	}

	const script = isBitcoinAddressType(addressType) && addressType !== "auto" ? addressType : known.script;
	return { node, network: known.network, script };
}

export function bitcoinAddressAt(key: BitcoinWatchKey, index: number): string {
	const pubkey = Buffer.from(key.node.derive(0).derive(index).publicKey);

	const payment =
		key.script === "p2wpkh"
			? bitcoin.payments.p2wpkh({ pubkey, network: key.network })
			: key.script === "p2sh-p2wpkh"
				? bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network: key.network }), network: key.network })
				: bitcoin.payments.p2pkh({ pubkey, network: key.network });

	if (!payment.address) throw new WatchOnlyKeyError("Could not derive a Bitcoin address from this key.");
	return payment.address;
}

export function parseEthereumKey(key: string): ReturnType<typeof hdkey.fromExtendedKey> {
	const bytes = decode(key);
	if (bytes.length !== 78) throw new WatchOnlyKeyError("This is not an extended public key. Check that it was copied in full.");

	const version = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
	if (PRIVATE_VERSIONS.has(version)) throw new WatchOnlyKeyError("This is a private key. Paste the public key instead, it starts with xpub.");
	if (version !== XPUB) throw new WatchOnlyKeyError("An Ethereum account key starts with xpub.");

	try {
		return hdkey.fromExtendedKey(key.trim());
	} catch {
		throw new WatchOnlyKeyError("This extended public key could not be read.");
	}
}

export function ethereumAddressAt(key: ReturnType<typeof hdkey.fromExtendedKey>, index: number): string {
	return key.deriveChild(0).deriveChild(index).getWallet().getAddressString();
}

export function keyFingerprint(...parts: string[]): string {
	return new Bun.CryptoHasher("sha256")
		.update(parts.map((part) => part.trim()).join("\n"))
		.digest("hex")
		.slice(0, 32);
}
