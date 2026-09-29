import { Logger } from "./logger";
import { renderJob, type RenderJob } from "./render-jobs";

const JOB_TIMEOUT_MS = 60 * 1000;
const DEFAULT_WORKERS = Math.min(4, Math.max(1, Math.floor(navigator.hardwareConcurrency / 4)));

interface Task {
	id: number;
	job: RenderJob;
	resolve: (data: Uint8Array) => void;
	reject: (error: Error) => void;
}

interface Slot {
	worker: Worker;
	task: Task | null;
	timer: ReturnType<typeof setTimeout> | null;
}

type Reply = { id: number; data: Uint8Array } | { id: number; error: string };

const COMPILED = /\/(?:\$bunfs|~BUN)\//.test(import.meta.url);

function workerEntry(): string | URL {
	return COMPILED ? "./server/render-worker.ts" : new URL("./render-worker.ts", import.meta.url);
}

function configuredWorkers(): number {
	const value = Bun.env.RABBITPAY_RENDER_WORKERS?.trim();
	if (!value) return DEFAULT_WORKERS;
	const count = Number(value);
	if (Number.isInteger(count) && count >= 0) return count;
	Logger.warn(`[RENDER] RABBITPAY_RENDER_WORKERS must be a whole number, using ${DEFAULT_WORKERS}`);
	return DEFAULT_WORKERS;
}

namespace RenderPool {
	const size = configuredWorkers();
	const slots: Slot[] = [];
	const queue: Task[] = [];
	let nextId = 0;

	export function workers(): number {
		return size;
	}

	export function waiting(): number {
		return queue.length;
	}

	export function render(job: RenderJob): Promise<Uint8Array> {
		if (size === 0) return renderJob(job);
		return new Promise((resolve, reject) => {
			queue.push({ id: nextId++, job, resolve, reject });
			dispatch();
		});
	}

	function dispatch() {
		while (queue.length > 0) {
			const slot = slots.find((candidate) => candidate.task === null) ?? (slots.length < size ? spawn() : null);
			if (!slot) return;
			start(slot, queue.shift()!);
		}
	}

	function spawn(): Slot {
		const worker = new Worker(workerEntry());
		const slot: Slot = { worker, task: null, timer: null };
		worker.onmessage = (event: MessageEvent<Reply>) => finish(slot, event.data);
		worker.onerror = (event) => retire(slot, new Error(`The render worker failed: ${event.message}`));
		worker.addEventListener("close", () => retire(slot, new Error("The render worker exited")));
		worker.unref();
		slots.push(slot);
		return slot;
	}

	function start(slot: Slot, task: Task) {
		slot.task = task;
		slot.timer = setTimeout(() => retire(slot, new Error(`Rendering took longer than ${JOB_TIMEOUT_MS / 1000} seconds`)), JOB_TIMEOUT_MS);
		try {
			slot.worker.postMessage({ id: task.id, job: task.job });
		} catch (error) {
			release(slot);
			task.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	function release(slot: Slot) {
		if (slot.timer) clearTimeout(slot.timer);
		slot.timer = null;
		slot.task = null;
	}

	function finish(slot: Slot, reply: Reply) {
		const task = slot.task;
		if (!task || task.id !== reply.id) return;
		release(slot);
		if ("error" in reply) task.reject(new Error(reply.error));
		else task.resolve(reply.data);
		dispatch();
	}

	function retire(slot: Slot, error: Error) {
		const index = slots.indexOf(slot);
		if (index < 0) return;
		slots.splice(index, 1);
		const task = slot.task;
		release(slot);
		slot.worker.terminate();
		if (task) {
			Logger.error(`[RENDER] ${error.message}`);
			task.reject(error);
		}
		dispatch();
	}
}

export default RenderPool;
