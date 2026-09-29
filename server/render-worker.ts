import { renderJob, type RenderJob } from "./render-jobs";

declare var self: Worker;

self.onmessage = async (event: MessageEvent<{ id: number; job: RenderJob }>) => {
	const { id, job } = event.data;
	try {
		const rendered = await renderJob(job);
		const data = rendered.byteLength === rendered.buffer.byteLength ? rendered : rendered.slice();
		self.postMessage({ id, data }, [data.buffer as ArrayBuffer]);
	} catch (error) {
		self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
};
