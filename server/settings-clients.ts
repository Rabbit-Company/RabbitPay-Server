import { resetChains } from "./crypto/chains";
import { setRateProvider } from "./rates/forex";
import { resetSchedule as resetBackupSchedule } from "./backups";

export function refreshClients() {
	resetChains();
	setRateProvider(null);
	resetBackupSchedule();
}
