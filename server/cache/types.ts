export interface CacheClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttl?: number): Promise<boolean>;
	delete(key: string): Promise<boolean>;
	incr(key: string): Promise<number>;
	exists(key: string): Promise<boolean>;
	close?(): Promise<void>;
}

export type CacheAdapter = "redis" | "memory" | "file";

export interface CacheLocalConfig {
	adapter: CacheAdapter;
	redis?: string;
	file?: string;
}

export interface CacheExternalConfig {
	adapter: CacheAdapter;
	redis?: string;
	file?: string;
}
