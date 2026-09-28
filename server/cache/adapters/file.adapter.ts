import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { CacheClient } from "../types";
import { Logger } from "../../logger";

export class FileAdapter implements CacheClient {
	private basePath: string;
	private cache: Map<string, { value: string; expiresAt?: number }> = new Map();
	private name: string;
	private saveDebounce: NodeJS.Timeout | null = null;

	constructor(basePath: string = "./cache", name: string = "File") {
		this.basePath = basePath;
		this.name = name;
		this.loadCache();
	}

	private getCachePath(): string {
		return join(this.basePath, "cache.json");
	}

	private async loadCache(): Promise<void> {
		try {
			const path = this.getCachePath();
			if (!(await Bun.file(path).exists())) {
				await Bun.write(path, "{}");
			}
			const data = await Bun.file(path).json();
			this.cache = new Map(Object.entries(data));
			Logger.info(`[CACHE] ${this.name} cache loaded from ${path}`);
		} catch (error) {
			Logger.error(`[CACHE] ${this.name} cache load error`, { error });
		}
	}

	private async saveCache(): Promise<void> {
		// Debounce saves to avoid excessive file writes
		if (this.saveDebounce) {
			clearTimeout(this.saveDebounce);
		}

		this.saveDebounce = setTimeout(async () => {
			try {
				const data = Object.fromEntries(this.cache.entries());
				await Bun.write(this.getCachePath(), JSON.stringify(data, null, 2));
			} catch (error) {
				Logger.error(`[CACHE] ${this.name} cache save error`, { error });
			}
		}, 100);
	}

	async get(key: string): Promise<string | null> {
		const entry = this.cache.get(key);
		if (!entry) return null;

		if (entry.expiresAt && entry.expiresAt < Date.now()) {
			this.cache.delete(key);
			await this.saveCache();
			return null;
		}

		return entry.value;
	}

	async set(key: string, value: string, ttl?: number): Promise<boolean> {
		const entry: { value: string; expiresAt?: number } = { value };
		if (ttl && ttl > 0) {
			entry.expiresAt = Date.now() + ttl * 1000;
		}
		this.cache.set(key, entry);
		await this.saveCache();
		return true;
	}

	async delete(key: string): Promise<boolean> {
		this.cache.delete(key);
		await this.saveCache();
		return true;
	}

	async incr(key: string): Promise<number> {
		const current = parseInt(this.cache.get(key)?.value || "0", 10);
		const newValue = current + 1;
		await this.set(key, newValue.toString());
		return newValue;
	}

	async exists(key: string): Promise<boolean> {
		const entry = this.cache.get(key);
		if (!entry) return false;

		if (entry.expiresAt && entry.expiresAt < Date.now()) {
			this.cache.delete(key);
			await this.saveCache();
			return false;
		}

		return true;
	}
}
