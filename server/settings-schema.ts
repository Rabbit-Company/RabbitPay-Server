export type CacheAdapter = "memory" | "file" | "redis";

export type BackupDestination = "local" | "s3" | "both";

export type RegistrationMode = "open" | "invite" | "closed";

export type VatStatus = "not_registered" | "registered";

export type ProxyPreset = "direct" | "nginx" | "burrowgate" | "cloudflare" | "aws" | "gcp" | "azure" | "vercel" | "development";

interface CacheScope {
	adapter: CacheAdapter;
	redis: {
		url: string;
		options: { connectionTimeout: number };
	};
	file: {
		path: string;
	};
}

export interface ServerSettings {
	server: {
		hostname: string;
		port: number;
		proxy: ProxyPreset;
		trusted_proxies: string;
		burrowgate_secret: string;
		public_url: string;
	};
	web: {
		enabled: boolean;
		path: string;
		landing_page: boolean;
	};
	cache: {
		local: CacheScope;
		external: CacheScope;
	};
	metrics: {
		method: number;
		token: string;
		cache: number;
	};
	logging: {
		level: number;
	};
	backups: {
		enabled: boolean;
		destination: BackupDestination;
		interval_hours: number;
		keep: number;
		local_path: string;
		s3_bucket: string;
		s3_region: string;
		s3_endpoint: string;
		s3_prefix: string;
		s3_access_key_id: string;
		s3_secret_access_key: string;
	};
	access_logs: {
		online_days: number;
		archive: boolean;
		retention_years: number;
	};
	security: {
		session_ttl: number;
		credential_rate_limit: number;
		credential_rate_window: number;
	};
	registrations: {
		mode: RegistrationMode;
		max_accounts: number;
	};
	legal: {
		operator_name: string;
		address: string;
		register: string;
		registration_number: string;
		tax_number: string;
		vat_status: VatStatus;
		vat_number: string;
		contact_email: string;
		phone: string;
		business_only: boolean;
	};
	licensing: {
		enabled: boolean;
		free_transactions: number;
		free_storage_gb: number;
	};
	payments: {
		allow_private_wallets: boolean;
	};
	invoices: {
		overdue_interval: number;
		recurring_interval: number;
		document_interval: number;
	};
	fiscal: {
		poll_interval: number;
		software_supplier_tax_number: number;
		software_supplier_name: string;
	};
	reports: {
		cooldown_minutes: number;
	};
	email: {
		enabled: boolean;
		host: string;
		port: number;
		secure: boolean;
		username: string;
		password: string;
		from_address: string;
		from_name: string;
		poll_interval: number;
		max_attempts: number;
		reminder_interval: number;
	};
	webhooks: {
		poll_interval: number;
		timeout: number;
		max_attempts: number;
		allow_private_targets: boolean;
	};
	rates: {
		enabled: boolean;
		api_url: string;
		cache_seconds: number;
	};
	vies: {
		enabled: boolean;
		api_url: string;
		timeout: number;
	};
	stripe: {
		enabled: boolean;
		api_url: string;
		checkout_expiry: number;
	};
	paypal: {
		enabled: boolean;
		api_url: string;
	};
	xmr: {
		enabled: boolean;
		confirmations: number;
		poll_interval: number;
		address_expiry: number;
	};
	eth: {
		enabled: boolean;
		backend: "etherscan" | "rpc";
		rpc_url: string;
		rpc_username: string;
		rpc_password: string;
		api_url: string;
		api_key: string;
		chain_id: number;
		confirmations: number;
		poll_interval: number;
		address_expiry: number;
	};
	btc: {
		enabled: boolean;
		backend: "esplora" | "rpc";
		rpc_url: string;
		rpc_username: string;
		rpc_password: string;
		rpc_wallet: string;
		api_url: string;
		confirmations: number;
		poll_interval: number;
		address_expiry: number;
	};
}

export const DEFAULT_SETTINGS: ServerSettings = {
	server: { hostname: "0.0.0.0", port: 8085, proxy: "direct", trusted_proxies: "", burrowgate_secret: "", public_url: "http://localhost:8085" },
	web: { enabled: true, path: "./web/dist", landing_page: true },
	cache: {
		local: { adapter: "memory", redis: { url: "redis://localhost/", options: { connectionTimeout: 500 } }, file: { path: "./data/cache/local" } },
		external: { adapter: "memory", redis: { url: "redis://localhost/", options: { connectionTimeout: 2000 } }, file: { path: "./data/cache/external" } },
	},
	metrics: { method: 0, token: "none", cache: 5 },
	logging: { level: 4 },
	backups: {
		enabled: false,
		destination: "local",
		interval_hours: 24,
		keep: 14,
		local_path: "./data/backups",
		s3_bucket: "",
		s3_region: "",
		s3_endpoint: "",
		s3_prefix: "backups/",
		s3_access_key_id: "",
		s3_secret_access_key: "",
	},
	access_logs: { online_days: 90, archive: true, retention_years: 2 },
	security: { session_ttl: 3600, credential_rate_limit: 10, credential_rate_window: 900 },
	registrations: { mode: "open", max_accounts: 0 },
	legal: {
		operator_name: "",
		address: "",
		register: "",
		registration_number: "",
		tax_number: "",
		vat_status: "not_registered",
		vat_number: "",
		contact_email: "",
		phone: "",
		business_only: false,
	},
	licensing: { enabled: true, free_transactions: 50, free_storage_gb: 1 },
	payments: { allow_private_wallets: false },
	invoices: { overdue_interval: 300, recurring_interval: 300, document_interval: 60 },
	fiscal: { poll_interval: 30, software_supplier_tax_number: 0, software_supplier_name: "RabbitPay" },
	reports: { cooldown_minutes: 10 },
	email: {
		enabled: false,
		host: "smtp.example.com",
		port: 587,
		secure: false,
		username: "",
		password: "",
		from_address: "billing@example.com",
		from_name: "RabbitPay",
		poll_interval: 15,
		max_attempts: 5,
		reminder_interval: 900,
	},
	webhooks: { poll_interval: 15, timeout: 10, max_attempts: 5, allow_private_targets: false },
	rates: { enabled: true, api_url: "https://forex.rabbitmonitor.com", cache_seconds: 60 },
	vies: { enabled: true, api_url: "https://ec.europa.eu/taxation_customs/vies/rest-api", timeout: 20 },
	stripe: { enabled: false, api_url: "https://api.stripe.com", checkout_expiry: 86400 },
	paypal: { enabled: false, api_url: "https://api-m.paypal.com" },
	xmr: { enabled: false, confirmations: 10, poll_interval: 60, address_expiry: 3600 },
	eth: {
		enabled: false,
		backend: "etherscan",
		rpc_url: "http://127.0.0.1:8545",
		rpc_username: "",
		rpc_password: "",
		api_url: "https://api.etherscan.io/api",
		api_key: "",
		chain_id: 1,
		confirmations: 12,
		poll_interval: 60,
		address_expiry: 3600,
	},
	btc: {
		enabled: false,
		backend: "esplora",
		rpc_url: "http://127.0.0.1:8332",
		rpc_username: "",
		rpc_password: "",
		rpc_wallet: "rabbitpay",
		api_url: "https://mempool.space/api",
		confirmations: 2,
		poll_interval: 60,
		address_expiry: 3600,
	},
};

export type SettingValue = string | number | boolean;

export interface SettingField {
	key: string;
	label: string;
	hint?: string;
	kind: "text" | "number" | "boolean" | "choice" | "secret";
	choices?: { value: string; label: string }[];
	min?: number;
	max?: number;
	restart?: boolean;
}

export interface SettingGroup {
	id: string;
	label: string;
	description: string;
	fields: SettingField[];
}

const CACHE_ADAPTERS = [
	{ value: "memory", label: "Memory" },
	{ value: "file", label: "File" },
	{ value: "redis", label: "Redis" },
];

function cacheFields(scope: "local" | "external"): SettingField[] {
	return [
		{ key: `cache.${scope}.adapter`, label: "Adapter", kind: "choice", choices: CACHE_ADAPTERS, restart: true },
		{ key: `cache.${scope}.file.path`, label: "File directory", hint: "Used by the file adapter", kind: "text", restart: true },
		{ key: `cache.${scope}.redis.url`, label: "Redis URL", hint: "redis://[username:password@]host[:port][/database]", kind: "secret", restart: true },
		{ key: `cache.${scope}.redis.options.connectionTimeout`, label: "Redis connection timeout", hint: "Milliseconds", kind: "number", min: 1, restart: true },
	];
}

function pollField(key: string, min: number, fallback: string): SettingField {
	return { key, label: "Poll interval", hint: `Seconds. Minimum ${min}. ${fallback}`, kind: "number", min, restart: true };
}

export const SETTING_GROUPS: SettingGroup[] = [
	{
		id: "reports",
		label: "Reports",
		description: "Users generate reports on request. Saved reports can be viewed and exported without recalculating them.",
		fields: [
			{
				key: "reports.cooldown_minutes",
				label: "Report generation cooldown",
				hint: "Minutes between successful generations of each report per company. Changing filters does not bypass this wait. Set 0 to allow immediate regeneration.",
				kind: "number",
				min: 0,
				max: 1440,
			},
		],
	},
	{
		id: "server",
		label: "Server",
		description: "Where this server listens and the address customers reach it on.",
		fields: [
			{ key: "server.hostname", label: "Hostname", hint: "0.0.0.0 listens on every interface, 127.0.0.1 only locally", kind: "text", restart: true },
			{ key: "server.port", label: "Port", kind: "number", min: 1, max: 65535, restart: true },
			{
				key: "server.proxy",
				label: "Client IP source",
				hint: "Drives the audit trail and the login rate limiter, so set it to match your proxy",
				kind: "choice",
				choices: [
					{ value: "direct", label: "Direct connection" },
					{ value: "nginx", label: "Nginx, Caddy or another reverse proxy" },
					{ value: "burrowgate", label: "BurrowGate" },
					{ value: "cloudflare", label: "Cloudflare" },
					{ value: "aws", label: "AWS load balancer" },
					{ value: "gcp", label: "Google Cloud load balancer" },
					{ value: "azure", label: "Azure Application Gateway" },
					{ value: "vercel", label: "Vercel" },
					{ value: "development", label: "Development, trusts every header. Never use in production" },
				],
				restart: true,
			},
			{
				key: "server.trusted_proxies",
				label: "Trusted proxies",
				hint: "IP addresses or CIDR ranges of your proxy, separated by commas. Forwarded headers from anyone else are ignored. Strongly recommended for Nginx and BurrowGate.",
				kind: "text",
				restart: true,
			},
			{
				key: "server.burrowgate_secret",
				label: "BurrowGate origin signing secret",
				hint: "From the BurrowGate site editor. When set with BurrowGate selected, every request must carry a valid BurrowGate signature and the signed client IP is used.",
				kind: "secret",
				restart: true,
			},
			{ key: "server.public_url", label: "Public URL", hint: "Used in payment links, emails and checkout return links", kind: "text" },
			{
				key: "web.enabled",
				label: "Serve the web interface",
				hint: "Turn off for a headless server that only exposes the API",
				kind: "boolean",
				restart: true,
			},
			{ key: "web.path", label: "Web interface directory", hint: "Build it with bun run build:web", kind: "text", restart: true },
			{
				key: "web.landing_page",
				label: "Show the home page",
				hint: "Visitors who are not signed in see a page about RabbitPay at the public URL. Turn off to send them straight to sign in.",
				kind: "boolean",
			},
		],
	},
	{
		id: "licensing",
		label: "Licensing",
		description: "Every project gets free completed payments and document storage. License keys add payments, storage, or white labeling.",
		fields: [
			{
				key: "licensing.enabled",
				label: "Enforce license limits",
				hint: "When off, every project has unlimited payments and storage, plus white labeling",
				kind: "boolean",
			},
			{
				key: "licensing.free_transactions",
				label: "Free payments per month",
				hint: "Default for every project. You can override it per project.",
				kind: "number",
				min: 0,
			},
			{
				key: "licensing.free_storage_gb",
				label: "Included storage in GB",
				hint: "Default document storage included with every project. Storage license keys add to it permanently.",
				kind: "number",
				min: 0,
			},
		],
	},
	{
		id: "security",
		label: "Security",
		description: "Login sessions and brute force protection.",
		fields: [
			{ key: "security.session_ttl", label: "Session lifetime", hint: "Seconds. Refreshed on every request.", kind: "number", min: 60 },
			{ key: "security.credential_rate_limit", label: "Login attempts", hint: "Per client IP within the window below", kind: "number", min: 1, restart: true },
			{ key: "security.credential_rate_window", label: "Login attempt window", hint: "Seconds", kind: "number", min: 1, restart: true },
		],
	},
	{
		id: "registrations",
		label: "Registrations",
		description: "Who can create an account on this server. The very first account can always be created and becomes the administrator.",
		fields: [
			{
				key: "registrations.mode",
				label: "New accounts",
				hint: "With invite codes, people invited to a project can still register with their invitation link.",
				kind: "choice",
				choices: [
					{ value: "open", label: "Anyone can register" },
					{ value: "invite", label: "Only with an invite code" },
					{ value: "closed", label: "Nobody can register" },
				],
			},
			{
				key: "registrations.max_accounts",
				label: "Maximum accounts",
				hint: "Registration closes once this many accounts exist, counting suspended ones. Set 0 for no limit.",
				kind: "number",
				min: 0,
			},
		],
	},
	{
		id: "legal",
		label: "Operator and legal",
		description:
			"Who runs this server. Shown on the public legal notice and used in the Terms of Service and Privacy Policy templates. Publish the documents themselves under Admin, Legal.",
		fields: [
			{ key: "legal.operator_name", label: "Operator name", hint: "The full legal name of the business, as registered", kind: "text" },
			{ key: "legal.address", label: "Registered address", hint: "Street, postal code, city and country", kind: "text" },
			{ key: "legal.register", label: "Business register", hint: "For example Slovenian Business Register (AJPES)", kind: "text" },
			{ key: "legal.registration_number", label: "Registration number", hint: "Matična številka in Slovenia", kind: "text" },
			{ key: "legal.tax_number", label: "Tax number", hint: "Davčna številka in Slovenia", kind: "text" },
			{
				key: "legal.vat_status",
				label: "VAT status",
				kind: "choice",
				choices: [
					{ value: "not_registered", label: "Not registered for VAT" },
					{ value: "registered", label: "Registered for VAT" },
				],
			},
			{ key: "legal.vat_number", label: "VAT number", hint: "Only when registered for VAT, for example SI12345678", kind: "text" },
			{ key: "legal.contact_email", label: "Contact email", hint: "For customers, legal requests and data protection requests", kind: "text" },
			{ key: "legal.phone", label: "Phone", hint: "Optional", kind: "text" },
			{
				key: "legal.business_only",
				label: "Business customers only",
				hint: "People who register confirm that they act for a business. Consumer protection rules then do not apply to purchases.",
				kind: "boolean",
			},
		],
	},
	{
		id: "email",
		label: "Email",
		description: "The default SMTP server for invoices, reminders, receipts and invitations. White labeled projects can use their own.",
		fields: [
			{ key: "email.enabled", label: "Send email", kind: "boolean" },
			{ key: "email.host", label: "SMTP host", kind: "text" },
			{ key: "email.port", label: "SMTP port", hint: "465 with TLS on, or 587 with TLS off to use STARTTLS", kind: "number", min: 1, max: 65535 },
			{ key: "email.secure", label: "Implicit TLS", kind: "boolean" },
			{ key: "email.username", label: "Username", hint: "Leave empty if the server needs no login", kind: "text" },
			{ key: "email.password", label: "Password", kind: "secret" },
			{ key: "email.from_address", label: "From address", kind: "text" },
			{ key: "email.from_name", label: "From name", kind: "text" },
			pollField("email.poll_interval", 5, "How often queued emails are sent."),
			{ key: "email.max_attempts", label: "Delivery attempts", kind: "number", min: 1 },
			{ key: "email.reminder_interval", label: "Reminder check interval", hint: "Seconds. Minimum 60.", kind: "number", min: 60, restart: true },
		],
	},
	{
		id: "invoices",
		label: "Invoices",
		description: "Background jobs for invoices.",
		fields: [
			{ key: "invoices.overdue_interval", label: "Overdue check interval", hint: "Seconds. Minimum 30.", kind: "number", min: 30, restart: true },
			{ key: "invoices.recurring_interval", label: "Recurring invoice interval", hint: "Seconds. Minimum 30.", kind: "number", min: 30, restart: true },
			{ key: "invoices.document_interval", label: "Document archive interval", hint: "Seconds. Minimum 30.", kind: "number", min: 30, restart: true },
		],
	},
	{
		id: "fiscal",
		label: "Fiscal verification",
		description: "Sending invoices paid in cash, by card or in crypto to the Slovenian Financial Administration (FURS).",
		fields: [
			pollField("fiscal.poll_interval", 10, "How often invoices waiting for FURS are sent again."),
			{
				key: "fiscal.software_supplier_tax_number",
				label: "Software supplier tax number",
				hint: "The Slovenian tax number of whoever supplies this RabbitPay installation. Sent to FURS when a business premise is registered. Leave 0 to send the name below instead.",
				kind: "number",
				min: 0,
				max: 99999999,
			},
			{
				key: "fiscal.software_supplier_name",
				label: "Software supplier name",
				hint: "Sent to FURS when there is no Slovenian tax number above.",
				kind: "text",
			},
		],
	},
	{
		id: "webhooks",
		label: "Webhooks",
		description: "Deliveries to the webhook URL of each project.",
		fields: [
			pollField("webhooks.poll_interval", 5, "How often queued deliveries are attempted."),
			{ key: "webhooks.timeout", label: "Timeout", hint: "Seconds to wait for the receiving server", kind: "number", min: 1 },
			{ key: "webhooks.max_attempts", label: "Delivery attempts", kind: "number", min: 1 },
			{
				key: "webhooks.allow_private_targets",
				label: "Allow private targets",
				hint: "Lets projects send webhooks to private and loopback addresses. Keep off in production.",
				kind: "boolean",
			},
		],
	},
	{
		id: "payments",
		label: "Payments",
		description: "Server wide switches. Each project still connects its own accounts and wallets.",
		fields: [
			{
				key: "payments.allow_private_wallets",
				label: "Allow private wallet addresses",
				hint: "Lets projects point Monero at a wallet RPC on a private address. Keep off when strangers can create projects.",
				kind: "boolean",
			},
			{ key: "rates.enabled", label: "Look up exchange rates", kind: "boolean" },
			{ key: "rates.api_url", label: "RabbitForex API", kind: "text" },
			{ key: "rates.cache_seconds", label: "Rate cache", hint: "Seconds a fetched rate is reused", kind: "number", min: 1 },
			{ key: "vies.enabled", label: "Check VAT numbers with VIES", kind: "boolean" },
			{ key: "vies.api_url", label: "VIES API", kind: "text" },
			{ key: "vies.timeout", label: "VIES timeout", hint: "Seconds", kind: "number", min: 1 },
		],
	},
	{
		id: "stripe",
		label: "Stripe and PayPal",
		description: "Hosted card and PayPal checkouts.",
		fields: [
			{ key: "stripe.enabled", label: "Enable Stripe", kind: "boolean" },
			{ key: "stripe.api_url", label: "Stripe API", kind: "text" },
			{ key: "stripe.checkout_expiry", label: "Checkout link lifetime", hint: "Seconds", kind: "number", min: 60 },
			{ key: "paypal.enabled", label: "Enable PayPal", kind: "boolean" },
			{ key: "paypal.api_url", label: "PayPal API", hint: "https://api-m.sandbox.paypal.com while testing", kind: "text" },
		],
	},
	{
		id: "btc",
		label: "Bitcoin",
		description: "A payment address per invoice, watched on chain.",
		fields: [
			{ key: "btc.enabled", label: "Enable Bitcoin", kind: "boolean" },
			{
				key: "btc.backend",
				label: "Chain source",
				kind: "choice",
				choices: [
					{ value: "esplora", label: "Esplora API" },
					{ value: "rpc", label: "Bitcoin Core RPC" },
				],
			},
			{ key: "btc.api_url", label: "Esplora API", kind: "text" },
			{ key: "btc.rpc_url", label: "RPC URL", kind: "text" },
			{ key: "btc.rpc_username", label: "RPC username", kind: "text" },
			{ key: "btc.rpc_password", label: "RPC password", kind: "secret" },
			{ key: "btc.rpc_wallet", label: "RPC wallet", kind: "text" },
			{ key: "btc.confirmations", label: "Confirmations", kind: "number", min: 0 },
			pollField("btc.poll_interval", 10, "How often the chain is checked."),
			{ key: "btc.address_expiry", label: "Address lifetime", hint: "Seconds", kind: "number", min: 60 },
		],
	},
	{
		id: "eth",
		label: "Ethereum",
		description: "Native ETH only.",
		fields: [
			{ key: "eth.enabled", label: "Enable Ethereum", kind: "boolean" },
			{
				key: "eth.backend",
				label: "Chain source",
				kind: "choice",
				choices: [
					{ value: "etherscan", label: "Etherscan compatible API" },
					{ value: "rpc", label: "Node JSON-RPC" },
				],
			},
			{ key: "eth.api_url", label: "Etherscan API", kind: "text" },
			{ key: "eth.api_key", label: "Etherscan API key", kind: "secret" },
			{ key: "eth.rpc_url", label: "RPC URL", kind: "text" },
			{ key: "eth.rpc_username", label: "RPC username", kind: "text" },
			{ key: "eth.rpc_password", label: "RPC password", kind: "secret" },
			{ key: "eth.chain_id", label: "Chain id", hint: "1 is mainnet, 11155111 is Sepolia", kind: "number", min: 1 },
			{ key: "eth.confirmations", label: "Confirmations", kind: "number", min: 0 },
			pollField("eth.poll_interval", 10, "How often the chain is checked."),
			{ key: "eth.address_expiry", label: "Address lifetime", hint: "Seconds", kind: "number", min: 60 },
		],
	},
	{
		id: "xmr",
		label: "Monero",
		description: "Each project runs its own view-only monero-wallet-rpc.",
		fields: [
			{ key: "xmr.enabled", label: "Enable Monero", kind: "boolean" },
			{ key: "xmr.confirmations", label: "Confirmations", kind: "number", min: 0 },
			pollField("xmr.poll_interval", 10, "How often wallets are checked."),
			{ key: "xmr.address_expiry", label: "Subaddress lifetime", hint: "Seconds", kind: "number", min: 60 },
		],
	},
	{
		id: "backups",
		label: "Backups",
		description:
			"Automatic compressed snapshots of the SQLite database, taken while the server runs. PostgreSQL and MySQL need their own backup tooling. Back up RABBITPAY_MASTER_KEY separately, without it the encrypted credentials in a backup cannot be read.",
		fields: [
			{ key: "backups.enabled", label: "Automatic backups", kind: "boolean" },
			{
				key: "backups.destination",
				label: "Destination",
				kind: "choice",
				choices: [
					{ value: "local", label: "Directory" },
					{ value: "s3", label: "S3 compatible storage" },
					{ value: "both", label: "Directory and S3" },
				],
			},
			{ key: "backups.interval_hours", label: "Interval", hint: "Hours between backups", kind: "number", min: 1, max: 720 },
			{ key: "backups.keep", label: "Backups to keep", hint: "Older backups are deleted from each destination", kind: "number", min: 1, max: 10000 },
			{
				key: "backups.local_path",
				label: "Directory",
				hint: "A mounted NFS or SMB share keeps backups off this machine. Relative paths start at the server directory.",
				kind: "text",
			},
			{ key: "backups.s3_bucket", label: "S3 bucket", kind: "text" },
			{ key: "backups.s3_region", label: "S3 region", kind: "text" },
			{
				key: "backups.s3_endpoint",
				label: "S3 endpoint",
				hint: "Leave empty for AWS. Needed for Cloudflare R2, Backblaze B2, MinIO and similar.",
				kind: "text",
			},
			{ key: "backups.s3_prefix", label: "S3 key prefix", kind: "text" },
			{ key: "backups.s3_access_key_id", label: "S3 access key id", kind: "text" },
			{ key: "backups.s3_secret_access_key", label: "S3 secret access key", kind: "secret" },
		],
	},
	{
		id: "access-logs",
		label: "Access logs",
		description:
			"Every permission check on a project is recorded with the account, IP address and user agent. Recent entries stay in the database, older ones move to encrypted and compressed archives in document storage.",
		fields: [
			{
				key: "access_logs.online_days",
				label: "Days in the database",
				hint: "Entries older than this move to archives. 90 days keeps three months ready for investigation.",
				kind: "number",
				min: 7,
				max: 3650,
			},
			{
				key: "access_logs.archive",
				label: "Archive older entries",
				hint: "When off, entries stay in the database until the retention period ends.",
				kind: "boolean",
			},
			{
				key: "access_logs.retention_years",
				label: "Retention",
				hint: "Years after the end of the calendar year in which an entry was recorded. Slovenian ZVOP-2 sets 2 years and allows up to 5 when a risk assessment justifies it. Entries and archives are then deleted.",
				kind: "number",
				min: 0,
				max: 5,
			},
		],
	},
	{
		id: "cache-local",
		label: "Local cache",
		description: "The fast first cache layer.",
		fields: cacheFields("local"),
	},
	{
		id: "cache-external",
		label: "Shared cache",
		description: "Login sessions live here. Use Redis when running more than one instance.",
		fields: cacheFields("external"),
	},
	{
		id: "observability",
		label: "Logging and metrics",
		description: "What the server logs and exposes at /metrics.",
		fields: [
			{
				key: "logging.level",
				label: "Log level",
				kind: "choice",
				choices: [
					{ value: "0", label: "Error" },
					{ value: "1", label: "Warning" },
					{ value: "2", label: "Audit" },
					{ value: "3", label: "Info" },
					{ value: "4", label: "HTTP" },
					{ value: "5", label: "Debug" },
					{ value: "6", label: "Verbose" },
					{ value: "7", label: "Everything" },
				],
			},
			{
				key: "metrics.method",
				label: "Metrics",
				kind: "choice",
				choices: [
					{ value: "0", label: "Disabled" },
					{ value: "1", label: "Basic" },
					{ value: "2", label: "Detailed" },
					{ value: "3", label: "Full" },
				],
				restart: true,
			},
			{ key: "metrics.token", label: "Metrics token", hint: "none leaves /metrics open", kind: "secret" },
			{ key: "metrics.cache", label: "Metrics refresh", hint: "Seconds", kind: "number", min: 1, restart: true },
		],
	},
];

export const SETTING_FIELDS: SettingField[] = SETTING_GROUPS.flatMap((group) => group.fields);

const FIELD_BY_KEY = new Map(SETTING_FIELDS.map((field) => [field.key, field]));

export function settingField(key: string): SettingField | undefined {
	return FIELD_BY_KEY.get(key);
}

const NUMERIC_CHOICES = new Set(["logging.level", "metrics.method"]);

export function readPath(source: unknown, key: string): unknown {
	let node: unknown = source;
	for (const part of key.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

export function writePath(target: object, key: string, value: SettingValue) {
	const parts = key.split(".");
	let node = target as Record<string, unknown>;
	for (const part of parts.slice(0, -1)) {
		if (node[part] === null || typeof node[part] !== "object") node[part] = {};
		node = node[part] as Record<string, unknown>;
	}
	node[parts[parts.length - 1]] = value;
}

export function coerceSetting(field: SettingField, raw: unknown): SettingValue | undefined {
	switch (field.kind) {
		case "boolean":
			return typeof raw === "boolean" ? raw : undefined;
		case "number": {
			const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			if (field.min !== undefined && value < field.min) return undefined;
			if (field.max !== undefined && value > field.max) return undefined;
			return value;
		}
		case "choice": {
			const value = String(raw);
			if (!field.choices?.some((choice) => choice.value === value)) return undefined;
			return NUMERIC_CHOICES.has(field.key) ? Number(value) : value;
		}
		case "text":
		case "secret":
			return typeof raw === "string" && raw.length <= 2000 ? raw.trim() : undefined;
	}
}

export function settingValues(source: ServerSettings): Record<string, SettingValue> {
	const values: Record<string, SettingValue> = {};
	for (const field of SETTING_FIELDS) {
		const value = readPath(source, field.key);
		if (value !== undefined) values[field.key] = value as SettingValue;
	}
	return values;
}
