import { RedisClient } from "bun";
import { Logger } from "../../logger";
import type { CacheClient } from "../types";

export class RedisAdapter implements CacheClient {
	private client: RedisClient;
	private name: string;

	constructor(connectionString: string, name: string = "Redis", options: Bun.RedisOptions) {
		this.name = name;
		this.client = new RedisClient(connectionString, options);

		this.client.onconnect = () => {
			Logger.info(`[CACHE] ${this.name} connected`);
		};

		this.client.onclose = (error) => {
			Logger.error(`[CACHE] ${this.name} connection error!`, { error });
		};
	}

	async get(key: string): Promise<string | null> {
		try {
			return await this.client.get(key);
		} catch (error) {
			Logger.error(`[CACHE] ${this.name} get error`, { key, error });
			return null;
		}
	}

	async set(key: string, value: string, ttl?: number): Promise<boolean> {
		try {
			if (ttl && ttl > 0) {
				await this.client.set(key, value, "EX", ttl);
			} else {
				await this.client.set(key, value);
			}
			return true;
		} catch (error) {
			Logger.error(`[CACHE] ${this.name} set error`, { key, error });
			return false;
		}
	}

	async delete(key: string): Promise<boolean> {
		try {
			await this.client.del(key);
			return true;
		} catch (error) {
			Logger.error(`[CACHE] ${this.name} delete error`, { key, error });
			return false;
		}
	}

	async incr(key: string): Promise<number> {
		try {
			return await this.client.incr(key);
		} catch (error) {
			Logger.error(`[CACHE] ${this.name} incr error`, { key, error });
			return 0;
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			return (await this.client.exists(key)) === true;
		} catch (error) {
			Logger.error(`[CACHE] ${this.name} exists error`, { key, error });
			return false;
		}
	}

	async close(): Promise<void> {
		this.client.close();
	}
}
