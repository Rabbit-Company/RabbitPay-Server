import Database from "../database/database";
import Vault from "../crypto/vault";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { checkTarget } from "../webhooks/target";
import { WatchOnlyKeyError, bitcoinAddressAt, ethereumAddressAt, isBitcoinAddressType, parseBitcoinKey, parseEthereumKey } from "../crypto/watch-only";
import { FISCAL_PROCESSORS, fiscalBlocked } from "../fiscal/config";

export type ProcessorName = "bitcoin" | "ethereum" | "monero" | "bank_transfer" | "stripe" | "paypal";

export interface ProcessorField {
	key: string;
	label: string;
	secret: boolean;
	hint?: string;
	choices?: { value: string; label: string }[];
	optional?: boolean;
}

export interface ProcessorDescriptor {
	name: ProcessorName;
	label: string;
	kind: "crypto" | "bank" | "card";
	fields: ProcessorField[];
}

export const PROCESSORS: ProcessorDescriptor[] = [
	{
		name: "bitcoin",
		label: "Bitcoin",
		kind: "crypto",
		fields: [
			{
				key: "xpub",
				label: "Extended public key",
				secret: false,
				hint: "The zpub, ypub or xpub of the wallet account that receives payments. It can only watch, never spend. Raise your wallet's gap limit, unpaid invoices leave gaps.",
			},
			{
				key: "address_type",
				label: "Address type",
				secret: false,
				optional: true,
				hint: "Match what your wallet uses, so payments show up in it",
				choices: [
					{ value: "auto", label: "From the key (zpub native, ypub nested, xpub legacy)" },
					{ value: "p2wpkh", label: "Native SegWit, bc1q" },
					{ value: "p2sh-p2wpkh", label: "Nested SegWit, 3" },
					{ value: "p2pkh", label: "Legacy, 1" },
				],
			},
		],
	},
	{
		name: "ethereum",
		label: "Ethereum",
		kind: "crypto",
		fields: [
			{
				key: "xpub",
				label: "Account extended public key",
				secret: false,
				hint: "The xpub of m/44'/60'/0', the path MetaMask, Ledger and Trezor use. Each invoice gets the next address under it.",
			},
		],
	},
	{
		name: "monero",
		label: "Monero",
		kind: "crypto",
		fields: [
			{
				key: "wallet_rpc_url",
				label: "Wallet RPC URL",
				secret: false,
				hint: "A monero-wallet-rpc you run with a view-only wallet, for example https://wallet.example.com/json_rpc",
			},
			{ key: "rpc_username", label: "RPC username", secret: false, optional: true },
			{ key: "rpc_password", label: "RPC password", secret: true, optional: true },
			{ key: "account_index", label: "Account", secret: false, optional: true, hint: "Wallet account that receives payments, 0 if unsure" },
		],
	},
	{
		name: "bank_transfer",
		label: "Bank transfer",
		kind: "bank",
		fields: [
			{ key: "iban", label: "IBAN", secret: false, hint: "The account a customer pays into" },
			{ key: "bic", label: "BIC or SWIFT", secret: false, optional: true },
			{ key: "account_holder", label: "Account holder", secret: false, optional: true, hint: "Defaults to your company's legal name" },
			{ key: "bank_name", label: "Bank name", secret: false, optional: true },
			{
				key: "qr_format",
				label: "Payment code",
				secret: false,
				optional: true,
				hint: "Slovenian banks read UPN QR, the rest of the euro area reads GiroCode",
				choices: [
					{ value: "auto", label: "Choose for me" },
					{ value: "epc", label: "GiroCode (SEPA)" },
					{ value: "upn", label: "UPN QR (Slovenia)" },
					{ value: "none", label: "No payment code" },
				],
			},
		],
	},
	{
		name: "stripe",
		label: "Stripe",
		kind: "card",
		fields: [
			{ key: "secret_key", label: "Secret key", secret: true, hint: "Starts with sk_live_ or sk_test_" },
			{ key: "webhook_secret", label: "Webhook signing secret", secret: true, hint: "Shown when you add the endpoint in Stripe" },
		],
	},
	{
		name: "paypal",
		label: "PayPal",
		kind: "card",
		fields: [
			{ key: "client_id", label: "Client id", secret: false },
			{ key: "client_secret", label: "Client secret", secret: true },
			{ key: "webhook_id", label: "Webhook id", secret: false, hint: "From the webhook you add in the PayPal dashboard" },
		],
	},
];

export function describeProcessor(name: string): ProcessorDescriptor | undefined {
	return PROCESSORS.find((processor) => processor.name === name);
}

export interface ProcessorRow {
	uuid: string;
	project: string;
	processor: string;
	enabled: number;
	config: string | null;
	created: number;
	updated: number;
}

export interface ProcessorState {
	processor: ProcessorName;
	label: string;
	kind: string;
	enabled: boolean;
	configured: boolean;
	server_available: boolean;
	problem: string | null;
	preview: string | null;
	fields: (ProcessorField & { value: string | null; set: boolean })[];
}

export function serverSupports(name: string): boolean {
	switch (name) {
		case "bitcoin":
			return Settings.btc?.enabled === true;
		case "ethereum":
			return Settings.eth?.enabled === true;
		case "monero":
			return Settings.xmr?.enabled === true;
		case "bank_transfer":
			return true;
		case "stripe":
			return Settings.stripe?.enabled === true;
		case "paypal":
			return Settings.paypal?.enabled === true;
		default:
			return false;
	}
}

export async function configProblem(name: string, config: Record<string, string>, checkUrl = true): Promise<string | null> {
	try {
		if (name === "bitcoin" && config.xpub) {
			if (config.address_type && !isBitcoinAddressType(config.address_type)) return "Choose a valid address type.";
			parseBitcoinKey(config.xpub, config.address_type);
		}
		if (name === "ethereum" && config.xpub) parseEthereumKey(config.xpub);
	} catch (err) {
		return err instanceof WatchOnlyKeyError ? err.message : "This key could not be read.";
	}

	if (name === "monero") {
		if (config.account_index && !/^\d{1,6}$/.test(config.account_index)) return "The account must be a whole number.";
		if (config.wallet_rpc_url && checkUrl) {
			const target = await checkTarget(config.wallet_rpc_url, allowsPrivateWallets());
			if (!target.allowed) return `The wallet RPC URL cannot be used: ${target.reason}.`;
		}
	}

	return null;
}

export function allowsPrivateWallets(): boolean {
	return Settings.payments?.allow_private_wallets === true;
}

export function previewFor(name: string, config: Record<string, string>): string | null {
	try {
		if (name === "bitcoin" && config.xpub) return bitcoinAddressAt(parseBitcoinKey(config.xpub, config.address_type), 0);
		if (name === "ethereum" && config.xpub) return ethereumAddressAt(parseEthereumKey(config.xpub), 0);
	} catch {
		return null;
	}
	return null;
}

function isConfigured(descriptor: ProcessorDescriptor, config: Record<string, string>): boolean {
	return descriptor.fields.every((field) => field.optional === true || Boolean(config[field.key]));
}

export function decodeConfig(row: ProcessorRow | undefined): Record<string, string> {
	if (!row?.config) return {};

	try {
		return JSON.parse(Vault.decrypt(row.config)) as Record<string, string>;
	} catch (err) {
		Logger.error(`[PROCESSORS] Could not read the ${row.processor} config for ${row.project}: ${err}`);
		return {};
	}
}

export async function processorRow(projectId: string, processor: string): Promise<ProcessorRow | undefined> {
	const [row] = (await Database`
		SELECT * FROM payment_methods WHERE project = ${projectId} AND processor = ${processor}
	`) as ProcessorRow[];
	return row;
}

export async function configFor(projectId: string, processor: string): Promise<Record<string, string>> {
	const own = decodeConfig(await processorRow(projectId, processor));
	return Object.fromEntries(Object.entries(own).filter(([, value]) => Boolean(value)));
}

export async function isEnabledFor(projectId: string, processor: string): Promise<boolean> {
	const descriptor = describeProcessor(processor);
	if (!descriptor || !serverSupports(processor)) return false;

	const row = await processorRow(projectId, processor);
	if (!row || row.enabled !== 1) return false;

	const config = decodeConfig(row);
	return isConfigured(descriptor, config) && (await configProblem(processor, config, false)) === null;
}

export function mergeConfig(current: Record<string, string>, changes: Record<string, string>, descriptor: ProcessorDescriptor): Record<string, string> {
	const merged = { ...current };
	for (const [key, value] of Object.entries(changes)) {
		const field = descriptor.fields.find((entry) => entry.key === key);
		if (value !== "") merged[key] = value;
		else if (field && !field.secret) delete merged[key];
	}

	const movedWallet = descriptor.name === "monero" && merged.wallet_rpc_url !== current.wallet_rpc_url;
	if (movedWallet && !changes.rpc_password) delete merged.rpc_password;

	return merged;
}

export async function pendingConfig(projectId: string, processor: string, changes: Record<string, string>): Promise<Record<string, string>> {
	const descriptor = describeProcessor(processor)!;
	return mergeConfig(decodeConfig(await processorRow(projectId, processor)), changes, descriptor);
}

export async function setProcessor(projectId: string, processor: string, enabled: boolean, config: Record<string, string>): Promise<void> {
	const existing = await processorRow(projectId, processor);
	const merged = mergeConfig(decodeConfig(existing), config, describeProcessor(processor)!);

	const encoded = Object.keys(merged).length > 0 ? Vault.encrypt(JSON.stringify(merged)) : null;
	const timestamp = Date.now();

	if (existing) {
		await Database`
			UPDATE payment_methods SET enabled = ${enabled ? 1 : 0}, config = ${encoded}, updated = ${timestamp} WHERE uuid = ${existing.uuid}
		`;
		return;
	}

	await Database`
		INSERT INTO payment_methods(uuid, project, processor, enabled, config, created, updated)
		VALUES(${crypto.randomUUID()}, ${projectId}, ${processor}, ${enabled ? 1 : 0}, ${encoded}, ${timestamp}, ${timestamp})
	`;
}

export const FISCAL_PROBLEM = "Needs fiscal verification with FURS. Set it up under Fiscal verification before offering this method.";

export async function statesFor(projectId: string): Promise<ProcessorState[]> {
	const rows = (await Database`SELECT * FROM payment_methods WHERE project = ${projectId}`) as ProcessorRow[];
	const blocked = await fiscalBlocked(Database, projectId);
	const byName = new Map(rows.map((row) => [row.processor, row]));

	const states: ProcessorState[] = [];
	for (const descriptor of PROCESSORS) {
		const row = byName.get(descriptor.name);
		const config = decodeConfig(row);

		const fields = descriptor.fields.map((field) => ({
			...field,
			value: field.secret ? null : (config[field.key] ?? null),
			set: Boolean(config[field.key]),
		}));

		const problem = blocked && FISCAL_PROCESSORS.has(descriptor.name) ? FISCAL_PROBLEM : await configProblem(descriptor.name, config, false);

		states.push({
			processor: descriptor.name,
			label: descriptor.label,
			kind: descriptor.kind,
			enabled: serverSupports(descriptor.name) && row?.enabled === 1,
			configured: isConfigured(descriptor, config) && problem === null,
			server_available: serverSupports(descriptor.name),
			problem,
			preview: previewFor(descriptor.name, config),
			fields,
		});
	}
	return states;
}

export async function availableFor(projectId: string): Promise<ProcessorState[]> {
	const states = await statesFor(projectId);
	return states.filter((state) => state.enabled && state.server_available && state.configured);
}

export async function projectsWith(processor: string): Promise<string[]> {
	if (!serverSupports(processor)) return [];

	const rows = (await Database`
		SELECT p.uuid AS uuid FROM projects p
		JOIN payment_methods pm ON pm.project = p.uuid AND pm.processor = ${processor}
		WHERE p.status != 'deleted' AND pm.enabled = 1
	`) as { uuid: string }[];

	const ready: string[] = [];
	for (const row of rows) {
		if (await isEnabledFor(row.uuid, processor)) ready.push(row.uuid);
	}
	return ready;
}
