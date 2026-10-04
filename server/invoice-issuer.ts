import type { SQL } from "bun";
import Database from "./database/database";

interface IssuerRow {
	account_username: string;
	email: string;
	full_name: string | null;
	signature_version: string | null;
	signature: string | null;
}

export interface InvoiceIssuer {
	name: string;
	signatureVersion: string | null;
	signature: string | null;
}

async function memberIssuer(sql: SQL, projectId: string, username: string): Promise<InvoiceIssuer | null> {
	const [member] = (await sql`
		SELECT pm.account_username, a.email, pm.full_name, version.uuid AS signature_version, asset.data AS signature
		FROM project_members pm JOIN accounts a ON a.username = pm.account_username
		LEFT JOIN project_member_signature_versions version ON version.member = pm.uuid AND version.valid_until IS NULL
		LEFT JOIN signature_assets asset ON asset.signature_hash = version.signature_hash
		WHERE pm.project_id = ${projectId} AND pm.account_username = ${username} AND pm.status = 'active'
		ORDER BY version.valid_from DESC LIMIT 1
	`) as IssuerRow[];
	if (!member) return null;
	return { name: member.full_name?.trim() || member.email, signatureVersion: member.signature_version, signature: member.signature };
}

export async function projectOwnerIssuer(sql: SQL, projectId: string): Promise<(InvoiceIssuer & { username: string }) | null> {
	const [owner] = (await sql`
		SELECT pm.account_username, a.email, pm.full_name, version.uuid AS signature_version, asset.data AS signature
		FROM project_members pm JOIN accounts a ON a.username = pm.account_username
		LEFT JOIN project_member_signature_versions version ON version.member = pm.uuid AND version.valid_until IS NULL
		LEFT JOIN signature_assets asset ON asset.signature_hash = version.signature_hash
		WHERE pm.project_id = ${projectId} AND pm.role = 'owner' AND pm.status = 'active' AND pm.account_username IS NOT NULL
		ORDER BY pm.created ASC, version.valid_from DESC LIMIT 1
	`) as IssuerRow[];
	if (!owner) return null;
	return {
		username: owner.account_username,
		name: owner.full_name?.trim() || owner.email,
		signatureVersion: owner.signature_version,
		signature: owner.signature,
	};
}

export async function resolveInvoiceIssuer(sql: SQL, projectId: string, username?: string | null): Promise<InvoiceIssuer | null> {
	if (username) {
		const member = await memberIssuer(sql, projectId, username);
		if (member) return member;
	}
	return await projectOwnerIssuer(sql, projectId);
}

export async function draftInvoiceIssuer(projectId: string, username?: string | null): Promise<InvoiceIssuer | null> {
	return await resolveInvoiceIssuer(Database, projectId, username);
}
