process.env.RABBITPAY_MASTER_KEY = "test-master-key-not-for-production-use-0123456789";
process.env.RABBITPAY_DB = "sqlite://:memory:";
process.env.DOCUMENT_LOCAL_PATH = `/tmp/rabbitpay-tests-${process.pid}`;

const UNREACHABLE = "http://127.0.0.1:1";

export const TEST_SETTINGS: Record<string, string | number | boolean> = {
	"server.hostname": "127.0.0.1",
	"server.port": 8099,
	"server.public_url": "http://127.0.0.1:8099",
	"logging.level": 0,
	"metrics.method": 0,
	"metrics.token": "none",
	"security.credential_rate_limit": 50,
	"email.enabled": false,
	"email.host": "127.0.0.1",
	"email.port": 1,
	"email.from_address": "billing@rabbitpay.test",
	"email.poll_interval": 3600,
	"email.max_attempts": 3,
	"email.reminder_interval": 3600,
	"webhooks.poll_interval": 3600,
	"webhooks.timeout": 2,
	"webhooks.max_attempts": 3,
	"webhooks.allow_private_targets": true,
	"eth.enabled": true,
	"eth.rpc_url": UNREACHABLE,
	"eth.api_url": `${UNREACHABLE}/api`,
	"eth.poll_interval": 3600,
	"btc.enabled": true,
	"btc.rpc_url": UNREACHABLE,
	"btc.rpc_wallet": "test",
	"btc.api_url": `${UNREACHABLE}/api`,
	"btc.poll_interval": 3600,
	"xmr.enabled": true,
	"xmr.poll_interval": 3600,
	"stripe.enabled": true,
	"stripe.api_url": UNREACHABLE,
	"paypal.enabled": true,
	"paypal.api_url": UNREACHABLE,
	"rates.api_url": UNREACHABLE,
	"rates.ecb_url": UNREACHABLE,
	"vies.api_url": UNREACHABLE,
	"vies.timeout": 2,
	"registry.enabled": false,
};

export async function prepareTest(database = "sqlite://:memory:") {
	process.env.RABBITPAY_DB = database;
	const { databaseConnection } = await import("../server/database/database");
	if (databaseConnection !== database) {
		throw new Error(
			`The database opened ${databaseConnection} before prepareTest could switch it to ${database}. Import server modules with await import() after calling prepareTest.`
		);
	}
	const { generateIssuerKeys, useIssuerPublicKey } = await import("../server/license-signing");
	const issuer = generateIssuerKeys();
	process.env.RABBITPAY_LICENSE_SIGNING_KEY = issuer.privateKey;
	useIssuerPublicKey(issuer.publicKey);

	const { updateSettings } = await import("../server/settings");
	const problem = await updateSettings(TEST_SETTINGS);
	if (problem) throw new Error(`Test setting ${problem.key} is ${problem.reason}`);
}
