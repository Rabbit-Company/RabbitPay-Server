export class PageState {
	offset = 0;
	total = 0;
	private round = 0;

	constructor(readonly size = 50) {}

	get previous(): boolean {
		return this.offset > 0;
	}

	get next(): boolean {
		return this.offset + this.size < this.total;
	}

	reset() {
		this.offset = 0;
		this.round++;
	}

	begin(): number {
		return ++this.round;
	}

	current(round: number): boolean {
		return round === this.round;
	}

	update(total: number): boolean {
		this.total = total;
		const offset = Math.min(this.offset, Math.max(0, Math.ceil(total / this.size) - 1) * this.size);
		const changed = offset !== this.offset;
		this.offset = offset;
		return changed;
	}
}
