import type { CacheClient } from "../types";

interface CacheEntry {
	value: string;
	expiresAt?: number;
}

export class MemoryAdapter implements CacheClient {
	private cache: Map<string, CacheEntry> = new Map();
	private counters: Map<string, number> = new Map();
	private name: string;

	constructor(name: string = "Memory") {
		this.name = name;
	}

	async get(key: string): Promise<string | null> {
		const entry = this.cache.get(key);
		if (!entry) return null;

		if (entry.expiresAt && entry.expiresAt < Date.now()) {
			this.cache.delete(key);
			return null;
		}

		return entry.value;
	}

	async set(key: string, value: string, ttl?: number): Promise<boolean> {
		const entry: CacheEntry = { value };
		if (ttl && ttl > 0) {
			entry.expiresAt = Date.now() + ttl * 1000;
		}
		this.cache.set(key, entry);
		return true;
	}

	async delete(key: string): Promise<boolean> {
		this.cache.delete(key);
		this.counters.delete(key);
		return true;
	}

	async incr(key: string): Promise<number> {
		const current = this.counters.get(key) || 0;
		const newValue = current + 1;
		this.counters.set(key, newValue);
		this.cache.set(key, { value: newValue.toString() });
		return newValue;
	}

	async exists(key: string): Promise<boolean> {
		const entry = this.cache.get(key);
		if (!entry) return false;

		if (entry.expiresAt && entry.expiresAt < Date.now()) {
			this.cache.delete(key);
			return false;
		}

		return true;
	}

	// Cleanup expired entries periodically
	startCleanup(intervalMs: number = 60000): void {
		setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.cache.entries()) {
				if (entry.expiresAt && entry.expiresAt < now) {
					this.cache.delete(key);
				}
			}
		}, intervalMs);
	}
}
