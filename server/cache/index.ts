import { Logger } from "../logger";
import { Settings } from "../settings";
import type { CacheClient } from "./types";
import { CacheFactory } from "./factory";

namespace Cache {
	// Separate local and external cache instances
	export namespace local {
		export let adapter: CacheClient;
	}

	export namespace external {
		export let adapter: CacheClient;
	}

	export async function initialize() {
		// Initialize local cache
		local.adapter = CacheFactory.createAdapter(Settings.cache.local.adapter, "local", Settings.cache);

		// Initialize external cache
		external.adapter = CacheFactory.createAdapter(Settings.cache.external.adapter, "external", Settings.cache);

		Logger.info("[CACHE] Cache system initialized", {
			local: Settings.cache.local.adapter,
			external: Settings.cache.external.adapter,
		});
	}

	export async function getString(key: string, localTTL: number = 0): Promise<string | null> {
		try {
			// Try local cache first
			const localValue = await local.adapter.get(key);
			if (localValue !== null) return localValue;

			// Fall back to external cache
			const externalValue = await external.adapter.get(key);
			if (externalValue !== null) {
				// Cache locally if TTL is specified
				if (localTTL > 0) {
					await local.adapter.set(key, externalValue, localTTL);
				}
				return externalValue;
			}

			return null;
		} catch (error) {
			Logger.error("[CACHE] getString error", { key, error });
			return null;
		}
	}

	export async function setString(key: string, value: string, localTTL: number = 0, externalTTL: number = 0): Promise<boolean> {
		try {
			const results: boolean[] = [];

			if (localTTL !== 0) {
				results.push(await local.adapter.set(key, value, localTTL));
			}

			if (externalTTL !== 0) {
				results.push(await external.adapter.set(key, value, externalTTL));
			}

			return results.length === 0 || results.every((r) => r === true);
		} catch (error) {
			Logger.error("[CACHE] setString error", { key, error });
			return false;
		}
	}

	export async function increase(key: string, useLocal: boolean = true, useExternal: boolean = false): Promise<number | null> {
		try {
			let number = 0;

			if (useLocal) {
				number = await local.adapter.incr(key);
			}

			if (useExternal) {
				number = await external.adapter.incr(key);
			}

			return number;
		} catch (error) {
			Logger.error("[CACHE] increase error", { key, error });
			return null;
		}
	}

	export async function getNumber(key: string, defaultNumber: number = 0): Promise<number> {
		const value = await getString(key);
		return value ? parseInt(value, 10) || defaultNumber : defaultNumber;
	}

	export async function deleteString(key: string): Promise<boolean> {
		try {
			const results = await Promise.all([local.adapter.delete(key), external.adapter.delete(key)]);

			return results.every((r) => r === true);
		} catch (error) {
			Logger.error("[CACHE] deleteString error", { key, error });
			return false;
		}
	}

	export async function getOrSetString(key: string, value: string, localTTL: number = 0, externalTTL: number = 0): Promise<string | null> {
		try {
			// Check local cache
			if (localTTL !== 0) {
				const localValue = await local.adapter.get(key);
				if (localValue !== null) return localValue;
			}

			// Check external cache
			if (externalTTL !== 0) {
				const externalValue = await external.adapter.get(key);
				if (externalValue !== null) {
					if (localTTL !== 0) {
						await local.adapter.set(key, externalValue, localTTL);
					}
					return externalValue;
				}
			}

			// Set in both caches
			if (localTTL !== 0) {
				await local.adapter.set(key, value, localTTL);
			}

			if (externalTTL !== 0) {
				await external.adapter.set(key, value, externalTTL);
			}

			return value;
		} catch (error) {
			Logger.error("[CACHE] getOrSetString error", { key, error });
			return null;
		}
	}

	export async function exists(key: string): Promise<boolean> {
		try {
			const [localExists, externalExists] = await Promise.all([local.adapter.exists(key), external.adapter.exists(key)]);

			return localExists || externalExists;
		} catch (error) {
			Logger.error("[CACHE] exists error", { key, error });
			return false;
		}
	}
}

export default Cache;
