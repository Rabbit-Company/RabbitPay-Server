export type ValuationMethod = "average" | "fifo";

export const VALUATION_METHODS: ValuationMethod[] = ["average", "fifo"];

export function isValuationMethod(value: unknown): value is ValuationMethod {
	return typeof value === "string" && VALUATION_METHODS.includes(value as ValuationMethod);
}

export interface StockLayer {
	quantity: number;
	value: number;
}

export interface AppliedThrough {
	date: number;
	sequence: number;
	count: number;
}

export interface StockState {
	layers: StockLayer[];
	deficit: StockLayer;
	last_cost: StockLayer | null;
	applied?: AppliedThrough;
}

export type CostBasis = "entered" | "current" | "source";

export interface ValuationMovement {
	uuid: string;
	warehouse: string;
	quantity: number;
	basis: CostBasis;
	entered_value: number | null;
	cost_source: string | null;
}

export interface MovementValue {
	value: number;
	correction: number;
}

export interface ValuedSource {
	quantity: number;
	value: number;
}

export function emptyState(): StockState {
	return { layers: [], deficit: { quantity: 0, value: 0 }, last_cost: null };
}

export function proportion(value: number, part: number, whole: number): number {
	if (whole === 0 || value === 0 || part === 0) return 0;
	if (part === whole) return value;
	const numerator = BigInt(value) * BigInt(part);
	const denominator = BigInt(whole);
	const negative = numerator < 0n !== denominator < 0n;
	const absolute = (numerator < 0n ? -numerator : numerator) * 2n + (denominator < 0n ? -denominator : denominator);
	const rounded = absolute / ((denominator < 0n ? -denominator : denominator) * 2n);
	return Number(negative ? -rounded : rounded);
}

export function onHand(state: StockState): StockLayer {
	const quantity = state.layers.reduce((sum, layer) => sum + layer.quantity, 0);
	const value = state.layers.reduce((sum, layer) => sum + layer.value, 0);
	return { quantity: quantity - state.deficit.quantity, value: value - state.deficit.value };
}

function mergeLayers(state: StockState) {
	if (state.layers.length < 2) return;
	state.layers = [
		{
			quantity: state.layers.reduce((sum, layer) => sum + layer.quantity, 0),
			value: state.layers.reduce((sum, layer) => sum + layer.value, 0),
		},
	];
}

function currentCost(state: StockState, quantity: number): number {
	const quantityInLayers = state.layers.reduce((sum, layer) => sum + layer.quantity, 0);
	if (quantityInLayers > 0) {
		const valueInLayers = state.layers.reduce((sum, layer) => sum + layer.value, 0);
		return proportion(valueInLayers, quantity, quantityInLayers);
	}
	return state.last_cost ? proportion(state.last_cost.value, quantity, state.last_cost.quantity) : 0;
}

function receive(state: StockState, method: ValuationMethod, quantity: number, value: number, remembersCost: boolean): MovementValue {
	let correction = 0;
	let remainingQuantity = quantity;
	let remainingValue = value;
	if (state.deficit.quantity > 0) {
		const covered = Math.min(quantity, state.deficit.quantity);
		const coveredValue = proportion(value, covered, quantity);
		const released = proportion(state.deficit.value, covered, state.deficit.quantity);
		correction = coveredValue - released;
		state.deficit = { quantity: state.deficit.quantity - covered, value: state.deficit.value - released };
		remainingQuantity -= covered;
		remainingValue -= coveredValue;
	}
	if (remainingQuantity > 0) state.layers.push({ quantity: remainingQuantity, value: remainingValue });
	if (method === "average") mergeLayers(state);
	if (remembersCost && value > 0) state.last_cost = { quantity, value };
	return { value, correction };
}

function issue(state: StockState, quantity: number): MovementValue {
	let remaining = quantity;
	let value = 0;
	while (remaining > 0 && state.layers.length > 0) {
		const layer = state.layers[0];
		const taken = Math.min(remaining, layer.quantity);
		const takenValue = proportion(layer.value, taken, layer.quantity);
		value += takenValue;
		remaining -= taken;
		if (taken === layer.quantity) state.layers.shift();
		else state.layers[0] = { quantity: layer.quantity - taken, value: layer.value - takenValue };
	}
	if (remaining > 0) {
		const provisional = state.last_cost ? proportion(state.last_cost.value, remaining, state.last_cost.quantity) : 0;
		state.deficit = { quantity: state.deficit.quantity + remaining, value: state.deficit.value + provisional };
		value += provisional;
	}
	return { value: value === 0 ? 0 : -value, correction: 0 };
}

export function applyMovement(
	state: StockState,
	method: ValuationMethod,
	movement: ValuationMovement,
	source: (uuid: string) => ValuedSource | undefined
): MovementValue {
	if (method === "average") mergeLayers(state);
	if (movement.quantity < 0) return issue(state, -movement.quantity);
	if (movement.quantity === 0) return { value: 0, correction: 0 };
	if (movement.basis === "source") {
		const origin = movement.cost_source ? source(movement.cost_source) : undefined;
		const value = origin ? Math.abs(proportion(origin.value, movement.quantity, Math.abs(origin.quantity))) : currentCost(state, movement.quantity);
		return receive(state, method, movement.quantity, value, false);
	}
	if (movement.basis === "current") return receive(state, method, movement.quantity, currentCost(state, movement.quantity), false);
	return receive(state, method, movement.quantity, Math.max(movement.entered_value ?? 0, 0), true);
}

export interface ReplayResult {
	values: Map<string, MovementValue>;
	states: Map<string, StockState>;
}

export function replay<T extends ValuationMovement>(
	movements: T[],
	methodFor: (movement: T) => ValuationMethod,
	earlier: { states: Map<string, StockState>; sources: Map<string, ValuedSource> } | null = null
): ReplayResult {
	const values = new Map<string, MovementValue>();
	const states = earlier?.states ?? new Map<string, StockState>();
	const quantities = new Map<string, number>();
	for (const movement of movements) {
		const state = states.get(movement.warehouse) ?? emptyState();
		states.set(movement.warehouse, state);
		quantities.set(movement.uuid, movement.quantity);
		const valued = applyMovement(state, methodFor(movement), movement, (uuid) => {
			const known = values.get(uuid);
			return known ? { quantity: quantities.get(uuid) ?? 0, value: known.value } : earlier?.sources.get(uuid);
		});
		values.set(movement.uuid, valued);
	}
	return { values, states };
}
