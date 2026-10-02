import { Logger } from "./logger";
import { bitcoinBackend, ethereumBackend } from "./crypto/chains";
import { refreshClients } from "./settings-clients";
import { Settings, reloadSettings } from "./settings";
import TaskMetrics from "./tasks/metrics";
import TaskBitcoin from "./tasks/bitcoin";
import TaskWebhooks from "./tasks/webhooks";
import TaskEthereum from "./tasks/ethereum";
import TaskMonero from "./tasks/monero";
import TaskOverdue from "./tasks/overdue";
import TaskEmail from "./tasks/email";
import TaskKeys from "./tasks/keys";
import TaskReminders from "./tasks/reminders";
import TaskRecurring from "./tasks/recurring";
import TaskLicensing from "./tasks/licensing";
import TaskDocuments from "./tasks/documents";
import TaskFiscal from "./tasks/fiscal";
import TaskBackups from "./tasks/backups";
import TaskAccessLogs from "./tasks/access-logs";
import TaskDomains from "./tasks/domains";
import TaskLedger from "./tasks/ledger";
import TaskRegistry from "./tasks/registry";
import TaskRates from "./tasks/rates";
import { isEnabled as emailEnabled } from "./email/mailer";
import { isEnabled as bitcoinEnabled } from "./payments/bitcoin";
import { isEnabled as ethereumEnabled } from "./payments/ethereum";
import { isEnabled as moneroEnabled } from "./payments/monero";

const SETTINGS_RELOAD_MS = 60 * 1000;
const METERING_MS = 5 * 60 * 1000;
const BACKUP_CHECK_MS = 5 * 60 * 1000;
const ACCESS_LOG_MAINTENANCE_MS = 60 * 60 * 1000;
const DOMAIN_CHECK_MS = 5 * 60 * 1000;
const LEDGER_POSTING_MS = 15 * 60 * 1000;
const REGISTRY_CHECK_MS = 60 * 60 * 1000;
const REFERENCE_RATE_CHECK_MS = 60 * 60 * 1000;

function bitcoinSource(): string {
	return bitcoinBackend() === "rpc" ? `node RPC at ${Settings.btc?.rpc_url}` : (Settings.btc?.api_url ?? "");
}

function ethereumSource(): string {
	return ethereumBackend() === "rpc" ? `node RPC at ${Settings.eth?.rpc_url}` : (Settings.eth?.api_url ?? "");
}

namespace Scheduler {
	const timers: ReturnType<typeof setInterval>[] = [];
	const inFlight = new Set<Promise<unknown>>();
	let stopping = false;

	function launch(task: () => unknown) {
		if (stopping) return;
		const run = Promise.resolve()
			.then(task)
			.catch((err) => Logger.error(`[SCHEDULER] Task failed: ${err}`));
		inFlight.add(run);
		void run.finally(() => inFlight.delete(run));
	}

	function every(intervalMs: number, task: () => unknown, immediately = false) {
		timers.push(setInterval(() => launch(task), intervalMs));
		if (immediately) launch(task);
	}

	export function running(): number {
		return inFlight.size;
	}

	export async function stop(timeoutMs: number): Promise<boolean> {
		stopping = true;
		for (const timer of timers.splice(0)) clearInterval(timer);
		if (inFlight.size === 0) return true;

		Logger.info(`[SCHEDULER] Waiting for ${inFlight.size} running tasks to finish`);
		const finished = Promise.allSettled([...inFlight]).then(() => true);
		return await Promise.race([finished, Bun.sleep(timeoutMs).then(() => false)]);
	}

	export async function initialize() {
		if (Settings.metrics.method >= 1) every(Settings.metrics.cache * 1000, () => TaskMetrics.run());

		const overdueInterval = Math.max(Settings.invoices?.overdue_interval || 300, 30);
		every(overdueInterval * 1000, () => TaskOverdue.run(), true);

		const recurringInterval = Math.max(Settings.invoices?.recurring_interval || 300, 30);
		every(recurringInterval * 1000, () => TaskRecurring.run(), true);

		const documentInterval = Math.max(Settings.invoices?.document_interval || 60, 30);
		every(documentInterval * 1000, () => TaskDocuments.run(), true);

		const fiscalInterval = Math.max(Settings.fiscal?.poll_interval || 30, 10);
		every(fiscalInterval * 1000, () => TaskFiscal.run(), true);

		every(SETTINGS_RELOAD_MS, () =>
			reloadSettings()
				.then((changed) => {
					if (changed) refreshClients();
				})
				.catch((err) => Logger.error(`[SETTINGS] Reload failed: ${err}`))
		);

		every(METERING_MS, () => TaskLicensing.run(), true);

		every(BACKUP_CHECK_MS, () => TaskBackups.run(), true);

		every(ACCESS_LOG_MAINTENANCE_MS, () => TaskAccessLogs.run(), true);

		every(DOMAIN_CHECK_MS, () => TaskDomains.run());

		every(LEDGER_POSTING_MS, () => TaskLedger.run());

		every(REGISTRY_CHECK_MS, () => TaskRegistry.run(), true);

		every(REFERENCE_RATE_CHECK_MS, () => TaskRates.run(), true);

		const emailInterval = Math.max(Settings.email?.poll_interval || 15, 5);
		every(emailInterval * 1000, () => TaskEmail.run(), true);

		every(emailInterval * 1000, () => TaskKeys.run(), true);

		const reminderInterval = Math.max(Settings.email?.reminder_interval || 900, 60);
		every(reminderInterval * 1000, () => TaskReminders.run(), true);

		if (emailEnabled()) {
			Logger.info(`[EMAIL] Sending through ${Settings.email.host}:${Settings.email.port || 587} as ${Settings.email.from_address}`);
		}

		const webhookInterval = Math.max(Settings.webhooks?.poll_interval || 15, 5);
		every(webhookInterval * 1000, () => TaskWebhooks.run());

		const bitcoinInterval = Math.max(Settings.btc?.poll_interval || 60, 10);
		every(bitcoinInterval * 1000, () => TaskBitcoin.run());
		if (bitcoinEnabled()) Logger.info(`[BTC] Watching for payments every ${bitcoinInterval} seconds through ${bitcoinSource()}`);

		const ethereumInterval = Math.max(Settings.eth?.poll_interval || 60, 10);
		every(ethereumInterval * 1000, () => TaskEthereum.run());
		if (ethereumEnabled()) Logger.info(`[ETH] Watching for payments every ${ethereumInterval} seconds through ${ethereumSource()}`);

		const moneroInterval = Math.max(Settings.xmr?.poll_interval || 60, 10);
		every(moneroInterval * 1000, () => TaskMonero.run());
		if (moneroEnabled()) Logger.info(`[XMR] Watching for payments in project wallets every ${moneroInterval} seconds`);
	}
}

export default Scheduler;
