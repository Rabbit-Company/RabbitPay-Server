export type ReportKind = "financial" | "vat" | "items";

export interface ReportStamp {
	generated_at: number;
	next_generation_at: number;
}

export type GeneratedReport<T> = T & ReportStamp;

export interface ReportState<T> {
	report: GeneratedReport<T> | null;
	generating: boolean;
	next_generation_at: number;
	server_time: number;
}
