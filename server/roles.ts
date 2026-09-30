export enum ProjectRole {
	OWNER = "owner",
	ADMIN = "admin",
	MANAGER = "manager",
	ACCOUNTANT = "accountant",
	DEVELOPER = "developer",
	VIEWER = "viewer",
	CASHIER = "cashier",
	SUPERVISOR = "supervisor",
	EMPLOYEE = "employee",
}

export enum Permission {
	EXPENSE_VIEW = "expense.view",
	EXPENSE_CREATE = "expense.create",
	EXPENSE_EDIT = "expense.edit",
	EXPENSE_DELETE = "expense.delete",
	// Project permissions
	PROJECT_VIEW = "project.view",
	PROJECT_EDIT = "project.edit",
	PROJECT_DELETE = "project.delete",
	PROJECT_MEMBERS = "project.members",

	// Payment permissions
	PAYMENT_VIEW = "payment.view",
	PAYMENT_CREATE = "payment.create",
	PAYMENT_REFUND = "payment.refund",
	PAYMENT_EXPORT = "payment.export",

	// Invoice permissions
	INVOICE_VIEW = "invoice.view",
	INVOICE_CREATE = "invoice.create",
	INVOICE_EDIT = "invoice.edit",
	INVOICE_DELETE = "invoice.delete",
	INVOICE_SEND = "invoice.send",

	// Customer permissions
	CUSTOMER_VIEW = "customer.view",
	CUSTOMER_CREATE = "customer.create",
	CUSTOMER_EDIT = "customer.edit",
	CUSTOMER_DELETE = "customer.delete",

	POS_SELL = "pos.sell",

	// Catalog item permissions
	ITEM_VIEW = "item.view",
	ITEM_CREATE = "item.create",
	ITEM_EDIT = "item.edit",
	ITEM_DELETE = "item.delete",

	// Report permissions
	REPORT_VIEW = "report.view",
	REPORT_EXPORT = "report.export",

	// API permissions
	API_KEYS = "api.keys",
	API_WEBHOOKS = "api.webhooks",

	// Subscription permissions
	SUBSCRIPTION_VIEW = "subscription.view",
	SUBSCRIPTION_CREATE = "subscription.create",
	SUBSCRIPTION_EDIT = "subscription.edit",
	SUBSCRIPTION_CANCEL = "subscription.cancel",

	TIMESHEET_OWN = "timesheet.own",
	TIMESHEET_VIEW = "timesheet.view",
	TIMESHEET_EDIT = "timesheet.edit",

	TICKET_VIEW = "ticket.view",
	TICKET_WORK = "ticket.work",
	TICKET_MANAGE = "ticket.manage",

	EMPLOYEE_VIEW = "employee.view",
	EMPLOYEE_EDIT = "employee.edit",

	LEDGER_EDIT = "ledger.edit",
}

// Define which permissions each role has
export const ROLE_PERMISSIONS: Record<ProjectRole, Permission[]> = {
	[ProjectRole.OWNER]: [
		// Owners have all permissions
		...Object.values(Permission),
	],

	[ProjectRole.ADMIN]: [
		Permission.EXPENSE_VIEW,
		Permission.EXPENSE_CREATE,
		Permission.EXPENSE_EDIT,
		Permission.EXPENSE_DELETE,
		// Admins have all permissions except project deletion
		Permission.PROJECT_VIEW,
		Permission.PROJECT_EDIT,
		Permission.PROJECT_MEMBERS,
		Permission.PAYMENT_VIEW,
		Permission.PAYMENT_CREATE,
		Permission.PAYMENT_REFUND,
		Permission.PAYMENT_EXPORT,
		Permission.INVOICE_VIEW,
		Permission.INVOICE_CREATE,
		Permission.INVOICE_EDIT,
		Permission.INVOICE_DELETE,
		Permission.INVOICE_SEND,
		Permission.CUSTOMER_VIEW,
		Permission.CUSTOMER_CREATE,
		Permission.CUSTOMER_EDIT,
		Permission.CUSTOMER_DELETE,
		Permission.ITEM_VIEW,
		Permission.ITEM_CREATE,
		Permission.ITEM_EDIT,
		Permission.ITEM_DELETE,
		Permission.POS_SELL,
		Permission.REPORT_VIEW,
		Permission.REPORT_EXPORT,
		Permission.API_KEYS,
		Permission.API_WEBHOOKS,
		Permission.SUBSCRIPTION_VIEW,
		Permission.SUBSCRIPTION_CREATE,
		Permission.SUBSCRIPTION_EDIT,
		Permission.SUBSCRIPTION_CANCEL,
		Permission.TIMESHEET_OWN,
		Permission.TIMESHEET_VIEW,
		Permission.TIMESHEET_EDIT,
		Permission.TICKET_VIEW,
		Permission.TICKET_WORK,
		Permission.TICKET_MANAGE,
		Permission.EMPLOYEE_VIEW,
		Permission.EMPLOYEE_EDIT,
		Permission.LEDGER_EDIT,
	],

	[ProjectRole.MANAGER]: [
		Permission.EXPENSE_VIEW,
		Permission.EXPENSE_CREATE,
		Permission.EXPENSE_EDIT,
		// Managers can manage payments, invoices, customers, and subscriptions
		Permission.PROJECT_VIEW,
		Permission.PAYMENT_VIEW,
		Permission.PAYMENT_CREATE,
		Permission.PAYMENT_REFUND,
		Permission.PAYMENT_EXPORT,
		Permission.INVOICE_VIEW,
		Permission.INVOICE_CREATE,
		Permission.INVOICE_EDIT,
		Permission.INVOICE_SEND,
		Permission.CUSTOMER_VIEW,
		Permission.CUSTOMER_CREATE,
		Permission.CUSTOMER_EDIT,
		Permission.ITEM_VIEW,
		Permission.ITEM_CREATE,
		Permission.ITEM_EDIT,
		Permission.POS_SELL,
		Permission.REPORT_VIEW,
		Permission.REPORT_EXPORT,
		Permission.SUBSCRIPTION_VIEW,
		Permission.SUBSCRIPTION_CREATE,
		Permission.SUBSCRIPTION_EDIT,
		Permission.SUBSCRIPTION_CANCEL,
		Permission.TICKET_VIEW,
		Permission.TICKET_WORK,
		Permission.TICKET_MANAGE,
	],

	[ProjectRole.ACCOUNTANT]: [
		Permission.EXPENSE_VIEW,
		Permission.EXPENSE_CREATE,
		Permission.EXPENSE_EDIT,
		Permission.PROJECT_VIEW,
		Permission.PAYMENT_VIEW,
		Permission.PAYMENT_EXPORT,
		Permission.INVOICE_VIEW,
		Permission.CUSTOMER_VIEW,
		Permission.ITEM_VIEW,
		Permission.REPORT_VIEW,
		Permission.REPORT_EXPORT,
		Permission.SUBSCRIPTION_VIEW,
		Permission.TIMESHEET_VIEW,
		Permission.EMPLOYEE_VIEW,
		Permission.LEDGER_EDIT,
	],

	[ProjectRole.DEVELOPER]: [
		// Developers can manage API settings and view project
		Permission.PROJECT_VIEW,
		Permission.API_KEYS,
		Permission.API_WEBHOOKS,
	],

	[ProjectRole.VIEWER]: [
		Permission.EXPENSE_VIEW,
		// Viewers have read-only access to everything
		Permission.PROJECT_VIEW,
		Permission.PAYMENT_VIEW,
		Permission.INVOICE_VIEW,
		Permission.CUSTOMER_VIEW,
		Permission.ITEM_VIEW,
		Permission.REPORT_VIEW,
		Permission.SUBSCRIPTION_VIEW,
		Permission.TIMESHEET_VIEW,
		Permission.TICKET_VIEW,
	],

	[ProjectRole.CASHIER]: [Permission.PROJECT_VIEW, Permission.ITEM_VIEW, Permission.POS_SELL],

	[ProjectRole.SUPERVISOR]: [
		Permission.PROJECT_VIEW,
		Permission.CUSTOMER_VIEW,
		Permission.TIMESHEET_OWN,
		Permission.TIMESHEET_VIEW,
		Permission.TIMESHEET_EDIT,
		Permission.TICKET_VIEW,
		Permission.TICKET_WORK,
		Permission.TICKET_MANAGE,
	],

	[ProjectRole.EMPLOYEE]: [Permission.PROJECT_VIEW, Permission.TIMESHEET_OWN, Permission.TICKET_VIEW, Permission.TICKET_WORK],
};

// Helper function to check if a role has a specific permission
export function roleHasPermission(role: ProjectRole, permission: Permission): boolean {
	return ROLE_PERMISSIONS[role].includes(permission);
}

// Role descriptions for UI
export const ROLE_DESCRIPTIONS: Record<ProjectRole, { name: string; description: string }> = {
	[ProjectRole.OWNER]: {
		name: "Owner",
		description: "Full control over the project including deletion and member management",
	},
	[ProjectRole.ADMIN]: {
		name: "Administrator",
		description: "Can manage all aspects of the project except deletion",
	},
	[ProjectRole.MANAGER]: {
		name: "Manager",
		description: "Can manage payments, invoices, customers, and subscriptions",
	},
	[ProjectRole.ACCOUNTANT]: {
		name: "Accountant",
		description: "View-only access to financial data with export capabilities",
	},
	[ProjectRole.DEVELOPER]: {
		name: "Developer",
		description: "Can manage API keys and webhooks for integration",
	},
	[ProjectRole.VIEWER]: {
		name: "Viewer",
		description: "Read-only access to view project data",
	},
	[ProjectRole.CASHIER]: {
		name: "Cashier",
		description: "Can only sell at the terminal and see their own sales",
	},
	[ProjectRole.SUPERVISOR]: {
		name: "Supervisor",
		description: "Manages everyone's timesheets, absences and tickets and runs work hour reports",
	},
	[ProjectRole.EMPLOYEE]: {
		name: "Employee",
		description: "Logs their own work hours and absences and works on tickets",
	},
};
