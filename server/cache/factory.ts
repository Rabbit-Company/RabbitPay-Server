import { Settings } from "../settings";
import type { CacheClient, CacheAdapter } from "./types";
import { RedisAdapter } from "./adapters/redis.adapter";
import { MemoryAdapter } from "./adapters/memory.adapter";
import { FileAdapter } from "./adapters/file.adapter";

export class CacheFactory {
	static createAdapter(adapter: CacheAdapter, scope: "local" | "external", config: typeof Settings.cache): CacheClient {
		const scopeName = scope.charAt(0).toUpperCase() + scope.slice(1);

		switch (adapter) {
			case "redis": {
				const connectionString = scope === "local" ? config.local.redis.url : config.external.redis.url;
				const redisOptions = scope === "local" ? config.local.redis.options : config.external.redis.options;

				if (!connectionString) {
					throw new Error(`Redis connection string not configured for ${scope} cache`);
				}

				return new RedisAdapter(connectionString, `${scopeName} Redis`, redisOptions);
			}

			case "memory": {
				const adapter = new MemoryAdapter(`${scopeName} Memory`);
				// Start cleanup for memory adapters
				adapter.startCleanup();
				return adapter;
			}

			case "file": {
				const basePath = scope === "local" ? Settings.cache.local.file.path || "./cache/local" : config.external.file.path || "./cache/external";

				return new FileAdapter(basePath, `${scopeName} File`);
			}

			default:
				throw new Error(`Unknown cache adapter: ${adapter}`);
		}
	}
}
