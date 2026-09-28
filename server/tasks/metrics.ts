import Metrics from "../metrics";
import { Logger } from "../logger";
import Cache from "../cache";

namespace TaskMetrics {
	export async function run() {
		Logger.silly("[METRICS] Task started");
		await Cache.setString("metrics_cache", Metrics.registry.metricsText(), 864000);
		Logger.silly("[METRICS] Task ended");
	}
}

export default TaskMetrics;
