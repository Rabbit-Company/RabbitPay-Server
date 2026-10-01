export interface RpcOptions {
	url: string;
	username?: string;
	password?: string;
	timeoutMs?: number;
}

export class RpcError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export class JsonRpcClient {
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private readonly timeoutMs: number;
	private nextId = 1;

	constructor(options: RpcOptions) {
		this.url = options.url;
		this.timeoutMs = options.timeoutMs ?? 15000;
		this.headers = { "Content-Type": "application/json" };

		if (options.username || options.password) {
			this.headers["Authorization"] = `Basic ${btoa(`${options.username ?? ""}:${options.password ?? ""}`)}`;
		}
	}

	async call<T>(method: string, params: unknown = []): Promise<T> {
		const response = await fetch(this.url, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		let payload: { result?: T; error?: { code?: number; message?: string } };
		try {
			payload = (await response.json()) as { result?: T; error?: { code?: number; message?: string } };
		} catch {
			if (!response.ok) throw new RpcError(response.status, `RPC responded ${response.status}`);
			throw new RpcError(-1, "RPC returned an unreadable response");
		}

		if (!response.ok && response.status !== 500 && !payload?.error?.message) throw new RpcError(response.status, `RPC responded ${response.status}`);

		if (payload?.error) throw new RpcError(payload.error.code ?? -1, payload.error.message ?? "RPC call failed");
		if (payload?.result === undefined) throw new RpcError(-1, `RPC returned no result for ${method}`);

		return payload.result;
	}
}
