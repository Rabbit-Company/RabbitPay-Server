export enum ProcessorType {
	// Crypto
	BITCOIN = "bitcoin",
	ETHEREUM = "ethereum",
	MONERO = "monero",

	// Fiat
	STRIPE = "stripe",
	PAYPAL = "paypal",
	BANK_TRANSFER = "bank_transfer",

	// Internal
	CREDIT = "credit",
	CASH = "cash",
}

export enum PaymentStatus {
	PENDING = "pending",
	PROCESSING = "processing",
	CONFIRMED = "confirmed",
	COMPLETED = "completed",
	FAILED = "failed",
	EXPIRED = "expired",
	REFUNDED = "refunded",
	PARTIALLY_REFUNDED = "partially_refunded",
}

export interface CustomerInfo {
	id: string;
	email: string;
	name?: string;
	phone?: string;
	address?: CustomerAddress;
	vatNumber?: string;
	metadata?: Record<string, any>; // Additional customer data
}

export interface CustomerAddress {
	line1: string;
	line2?: string;
	city: string;
	state?: string;
	postalCode: string;
	country: string; // ISO 3166-1 alpha-2 code
}

export interface PaymentRequest {
	invoiceId: string;
	amount: number;
	currency: string;
	processor: ProcessorType;
	customer: CustomerInfo;
	items?: PaymentItem[]; // Optional line items for detailed invoices
	metadata?: Record<string, any>;
	returnUrl?: string;
	webhookUrl?: string;
	ipAddress?: string; // For fraud detection
}

export interface PaymentItem {
	description: string;
	quantity: number;
	unitPrice: number;
	totalPrice: number;
	tax?: number;
	metadata?: Record<string, any>;
}

export interface PaymentResponse {
	id: string;
	processor: ProcessorType;
	status: PaymentStatus;
	amount: number;
	currency: string;
	paymentUrl?: string; // For redirect-based payments
	paymentAddress?: string; // For crypto payments
	paymentInstructions?: any; // Processor-specific instructions
	expiresAt?: number;
	metadata?: Record<string, any>;
}

export interface ProcessorConfig {
	enabled: boolean;
	testMode?: boolean;
	apiKey?: string;
	apiSecret?: string;
	webhookSecret?: string;
	[key: string]: any; // Processor-specific config
}

export interface Transaction {
	id: string;
	invoiceId: string;
	processor: ProcessorType;
	status: PaymentStatus;
	amount: number;
	currency: string;
	fee?: number;
	netAmount?: number;
	externalId?: string; // External payment ID
	customerId: string; // Link to customer
	paymentDetails?: any; // Processor-specific details
	confirmations?: number; // For crypto
	refundedAmount?: number; // For partial refunds
	failureReason?: string; // Error message if failed
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

// Additional utility types
export interface PaymentMethod {
	type: ProcessorType;
	name: string;
	icon?: string;
	currencies: string[];
	minAmount?: Record<string, number>; // Per currency
	maxAmount?: Record<string, number>; // Per currency
	estimatedFee?: Record<string, number>; // Per currency
	estimatedProcessingTime?: string; // e.g., "instant", "1-3 days"
	available: boolean;
}

export interface PaymentError extends Error {
	code: string;
	processor: ProcessorType;
	details?: any;
	recoverable?: boolean;
}

export interface RefundRequest {
	transactionId: string;
	amount?: number; // Optional for partial refunds
	reason?: string;
	metadata?: Record<string, any>;
}

export interface RefundResponse {
	id: string;
	transactionId: string;
	amount: number;
	currency: string;
	status: "pending" | "completed" | "failed";
	externalId?: string;
	processedAt?: number;
}

export interface PaymentSessionRow {
	uuid: string;
	project: string;
	invoice: string | null;
	processor: string;
	processor_session_id: string;
	amount: number;
	currency: string;
	status: string;
	return_url: string | null;
	created: number;
	expires_at: number;
	completed_at: number | null;
}
