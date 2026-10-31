import { SQL, type TransactionSQL } from "bun";
import { normalizeIntegers } from "./numbers";
import Metrics from "../metrics";

export function numericClient<T extends SQL>(client: T): T {
	function query<T>(pending: SQL.Query<T>): SQL.Query<T> {
		function settled(target: SQL.Query<T>): Promise<T> {
			if (Metrics.level() < Metrics.FULL) return target.then(normalizeIntegers);
			const start = performance.now();
			return target.then(normalizeIntegers).finally(() => Metrics.observeQuery(performance.now() - start));
		}

		return new Proxy(pending, {
			get(target, property, receiver) {
				if (property === "then") return (resolve: (value: T) => unknown, reject: (error: unknown) => unknown) => settled(target).then(resolve, reject);
				if (property === "catch") return (reject: (error: unknown) => unknown) => settled(target).catch(reject);
				if (property === "finally") return (callback: () => void) => settled(target).finally(callback);
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					const result = Reflect.apply(value, target, args);
					return result === target ? receiver : result;
				};
			},
		});
	}

	return new Proxy(client, {
		apply(target, thisArg, args) {
			const result = Reflect.apply(target, thisArg, args);
			return result && typeof result.then === "function" ? query(result) : result;
		},
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (["begin", "transaction", "savepoint"].includes(String(property))) {
				return (...args: unknown[]) =>
					Reflect.apply(
						value,
						target,
						args.map((arg) => (typeof arg === "function" ? (tx: TransactionSQL) => arg(numericClient(tx)) : arg))
					);
			}
			if (property === "reserve") return async (...args: unknown[]) => numericClient(await Reflect.apply(value, target, args));
			return (...args: unknown[]) => {
				const result = Reflect.apply(value, target, args);
				return property === "unsafe" || property === "file" ? query(result) : result;
			};
		},
	});
}
