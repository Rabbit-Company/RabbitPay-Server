import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import Database from "../database/database";
import Utils from "../utils";
import { Logger } from "../logger";
import { Settings } from "../settings";
import { forgetDomains } from "./store";
import type { DomainProvider } from "../settings-schema";
import type { StoreDomainProvider, StoreDomainRow, StoreDomainStatus } from "../database/models";

const RETRY_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

export interface VerificationRecord {
	type: "TXT" | "CNAME";
	name: string;
	value: string;
}

export interface StoreDomain {
	project: string;
	hostname: string;
	provider: StoreDomainProvider;
	status: StoreDomainStatus;
	providerHostnameId: string | null;
	gatewaySiteId: string | null;
	records: VerificationRecord[];
	lastError: string | null;
	created: number;
	updated: number;
	activated: number | null;
}

export class DomainProvisioningFailed extends Error {}

export function domainProvider(): DomainProvider {
	return Settings.domains?.provider ?? "manual";
}

function cleanHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

export function normalizeHostname(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const raw = cleanHost(value);
	if (raw.length === 0 || raw.length > 253 || raw.includes("://") || /[\s/@:#?\\]/.test(raw)) return null;

	let hostname: string;
	try {
		const parsed = new URL(`http://${raw}`);
		if (parsed.hostname.length === 0 || parsed.port.length > 0 || parsed.pathname !== "/") return null;
		hostname = parsed.hostname.toLowerCase();
	} catch {
		return null;
	}

	if (isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost") || !hostname.includes(".")) return null;
	const labels = hostname.split(".");
	if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
	return hostname;
}

function publicHost(): string {
	return new URL(Utils.publicUrl()).hostname.toLowerCase();
}

export function domainTarget(): string {
	return normalizeHostname(Settings.domains?.target ?? "") ?? publicHost();
}

export function isReservedHostname(hostname: string): boolean {
	return hostname === publicHost() || hostname === domainTarget();
}

export function domainsAvailable(): boolean {
	const provider = domainProvider();
	const domains = Settings.domains;
	if (provider === "disabled") return false;
	if (provider === "manual") return true;
	const burrowgate = domains.burrowgate_url !== "" && domains.burrowgate_admin_token !== "";
	if (provider === "burrowgate") return burrowgate;
	return burrowgate && domains.cloudflare_api_token !== "" && domains.cloudflare_zone_id !== "";
}

function parseRecords(value: string): VerificationRecord[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(record): record is VerificationRecord =>
				typeof record === "object" &&
				record !== null &&
				((record as VerificationRecord).type === "TXT" || (record as VerificationRecord).type === "CNAME") &&
				typeof (record as VerificationRecord).name === "string" &&
				typeof (record as VerificationRecord).value === "string"
		);
	} catch {
		return [];
	}
}

function fromRow(row: StoreDomainRow): StoreDomain {
	return {
		project: row.project,
		hostname: row.hostname,
		provider: row.provider,
		status: row.status,
		providerHostnameId: row.provider_hostname_id,
		gatewaySiteId: row.gateway_site_id,
		records: parseRecords(row.verification_records),
		lastError: row.last_error,
		created: Number(row.created),
		updated: Number(row.updated),
		activated: row.activated === null ? null : Number(row.activated),
	};
}

export async function domainOf(projectId: string): Promise<StoreDomain | null> {
	const [row] = (await Database`SELECT * FROM store_domains WHERE project = ${projectId}`) as StoreDomainRow[];
	return row ? fromRow(row) : null;
}

async function hostnameTaken(hostname: string, projectId: string): Promise<boolean> {
	const [claimed] = (await Database`SELECT project FROM store_domains WHERE hostname = ${hostname} AND project != ${projectId}`) as { project: string }[];
	if (claimed) return true;
	const [served] = (await Database`SELECT project FROM store_settings WHERE domain = ${hostname} AND project != ${projectId}`) as { project: string }[];
	return served !== undefined;
}

type DomainChanges = Partial<Pick<StoreDomain, "status" | "providerHostnameId" | "gatewaySiteId" | "records" | "lastError" | "activated">>;

async function updateDomain(domain: StoreDomain, changes: DomainChanges): Promise<StoreDomain> {
	const next: StoreDomain = { ...domain, ...changes, updated: Date.now() };
	await Database`
		UPDATE store_domains SET status = ${next.status}, provider_hostname_id = ${next.providerHostnameId}, gateway_site_id = ${next.gatewaySiteId},
			verification_records = ${JSON.stringify(next.records)}, last_error = ${next.lastError}, activated = ${next.activated}, updated = ${next.updated}
		WHERE project = ${domain.project}
	`;
	return next;
}

function messageFrom(value: unknown, fallback: string): string {
	if (typeof value !== "object" || value === null) return fallback;
	const record = value as Record<string, unknown>;
	if (typeof record.error === "string") return record.error;
	if (typeof record.info === "string") return record.info;
	if (Array.isArray(record.errors)) {
		const message = (record.errors[0] as { message?: unknown } | undefined)?.message;
		if (typeof message === "string") return message;
	}
	return fallback;
}

async function providerFetch<T>(url: string, init: RequestInit, fallback: string, allowNotFound = false, timeoutMs = 15_000): Promise<T | null> {
	const method = init.method ?? "GET";
	let response: Response;
	try {
		response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		throw new DomainProvisioningFailed(`${fallback}: ${method} ${url} failed: ${error instanceof Error ? error.message : "network error"}`);
	}
	if (allowNotFound && response.status === 404) return null;
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok)
		throw new DomainProvisioningFailed(`${fallback}: ${method} ${url} answered HTTP ${response.status}: ${messageFrom(body, "no error message")}`);
	if (method !== "DELETE" && (typeof body !== "object" || body === null)) {
		throw new DomainProvisioningFailed(`${fallback}: ${method} ${url} did not answer with JSON. Check that the address points at the provider API.`);
	}
	return body as T;
}

interface CloudflareEnvelope<T> {
	success: boolean;
	result: T;
}

interface CloudflareHostname {
	id: string;
	status?: string;
	ownership_verification?: { name?: string; value?: string };
	ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string; txt_record?: string }[] };
}

function cloudflareUrl(path: string): string {
	return `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(Settings.domains.cloudflare_zone_id)}${path}`;
}

function cloudflareHeaders(): Record<string, string> {
	return { Authorization: `Bearer ${Settings.domains.cloudflare_api_token}`, "Content-Type": "application/json" };
}

function cloudflareRecords(hostname: CloudflareHostname): VerificationRecord[] {
	const records: VerificationRecord[] = [];
	const ownership = hostname.ownership_verification;
	if (ownership?.name && ownership.value) records.push({ type: "TXT", name: ownership.name, value: ownership.value });
	for (const record of hostname.ssl?.validation_records ?? []) {
		const value = record.txt_value ?? record.txt_record;
		if (record.txt_name && value && !records.some((entry) => entry.name === record.txt_name && entry.value === value)) {
			records.push({ type: "TXT", name: record.txt_name, value });
		}
	}
	return records;
}

async function createCloudflareHostname(hostname: string): Promise<{ id: string; records: VerificationRecord[] }> {
	const envelope = await providerFetch<CloudflareEnvelope<CloudflareHostname>>(
		cloudflareUrl("/custom_hostnames"),
		{ method: "POST", headers: cloudflareHeaders(), body: JSON.stringify({ hostname, ssl: { method: "txt", type: "dv" } }) },
		"Cloudflare could not create the custom hostname"
	);
	if (!envelope?.success || typeof envelope.result?.id !== "string") throw new DomainProvisioningFailed("Cloudflare returned an incomplete custom hostname");
	return { id: envelope.result.id, records: cloudflareRecords(envelope.result) };
}

async function readCloudflareHostname(id: string): Promise<{ ready: boolean; records: VerificationRecord[] }> {
	const envelope = await providerFetch<CloudflareEnvelope<CloudflareHostname>>(
		cloudflareUrl(`/custom_hostnames/${encodeURIComponent(id)}`),
		{ headers: cloudflareHeaders() },
		"Cloudflare could not read the custom hostname"
	);
	if (!envelope?.success) throw new DomainProvisioningFailed("Cloudflare returned an invalid custom hostname");
	return { ready: envelope.result.status === "active" && envelope.result.ssl?.status === "active", records: cloudflareRecords(envelope.result) };
}

async function deleteCloudflareHostname(id: string): Promise<void> {
	await providerFetch(
		cloudflareUrl(`/custom_hostnames/${encodeURIComponent(id)}`),
		{ method: "DELETE", headers: cloudflareHeaders() },
		"Cloudflare could not remove the custom hostname",
		true
	);
}

interface BurrowGateSite {
	id?: string;
	publicHost?: string;
	originUrl?: string | null;
}

function gatewayOrigin(): string {
	try {
		return new URL(Settings.domains.burrowgate_url).origin;
	} catch {
		throw new DomainProvisioningFailed(`The BurrowGate URL ${Settings.domains.burrowgate_url} is not a valid address`);
	}
}

function burrowGateUrl(path: string): string {
	return `${gatewayOrigin()}${path}`;
}

function burrowGateHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${Settings.domains.burrowgate_admin_token}`,
		"Content-Type": "application/json",
		"X-BurrowGate-Admin": "1",
		Origin: gatewayOrigin(),
	};
}

function originUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
		return url.toString().replace(/\/$/, url.pathname === "/" ? "" : "/");
	} catch {
		return null;
	}
}

function privateOrigin(origin: string): string {
	if (new URL(origin).origin === new URL(Utils.publicUrl()).origin) {
		throw new DomainProvisioningFailed(
			"The store domain origin points back at the public RabbitPay site. Set the BurrowGate site id, or a private origin such as http://127.0.0.1:8085."
		);
	}
	return origin;
}

async function burrowGateOrigin(): Promise<string> {
	const fallback = originUrl(Settings.domains.burrowgate_origin);
	let sites: BurrowGateSite[];
	try {
		const body = await providerFetch<{ items?: BurrowGateSite[] }>(
			burrowGateUrl("/_burrowgate/api/admin/sites"),
			{ headers: burrowGateHeaders() },
			"BurrowGate could not list its sites"
		);
		if (!Array.isArray(body?.items)) {
			throw new DomainProvisioningFailed(`BurrowGate at ${gatewayOrigin()} did not return a site list. Check the BurrowGate URL.`);
		}
		sites = body.items;
	} catch (error) {
		if (fallback) return privateOrigin(fallback);
		throw error;
	}
	const siteId = Settings.domains.burrowgate_site_id;
	const main = (siteId !== "" ? sites.find((site) => site.id === siteId) : undefined) ?? sites.find((site) => site.publicHost?.toLowerCase() === publicHost());
	const origin = originUrl(main?.originUrl) ?? fallback;
	if (!origin) throw new DomainProvisioningFailed("BurrowGate has no RabbitPay site to reuse. Set the BurrowGate site id or a private origin.");
	return privateOrigin(origin);
}

async function createBurrowGateSite(hostname: string, behindCloudflare: boolean): Promise<string> {
	const body = await providerFetch<{ site?: { id?: string } }>(
		burrowGateUrl("/_burrowgate/api/admin/sites"),
		{
			method: "POST",
			headers: burrowGateHeaders(),
			body: JSON.stringify({
				name: hostname,
				publicHost: hostname,
				originUrl: await burrowGateOrigin(),
				originSigningSecret: Settings.server.burrowgate_secret || undefined,
				enabled: true,
				defaultAccessMode: "bypass",
				ipExtractionPreset: behindCloudflare ? "cloudflare" : "direct",
			}),
		},
		"BurrowGate could not create the store domain site"
	);
	const id = body?.site?.id;
	if (typeof id !== "string" || id.length === 0) throw new DomainProvisioningFailed("BurrowGate returned an incomplete site");
	return id;
}

async function burrowGateCertificateReady(siteId: string): Promise<boolean> {
	const body = await providerFetch<{ settings?: { mode?: string }; certificate?: { status?: string } | null }>(
		burrowGateUrl(`/_burrowgate/api/admin/sites/${encodeURIComponent(siteId)}/tls`),
		{ headers: burrowGateHeaders() },
		"BurrowGate could not read the store domain certificate"
	);
	return body?.settings?.mode === "letsencrypt" && body.certificate?.status === "active";
}

async function issueBurrowGateCertificate(siteId: string): Promise<void> {
	await providerFetch(
		burrowGateUrl(`/_burrowgate/api/admin/sites/${encodeURIComponent(siteId)}/certificate/letsencrypt`),
		{
			method: "POST",
			headers: burrowGateHeaders(),
			body: JSON.stringify({ email: Settings.domains.acme_email || undefined, forceHttps: true, termsAccepted: true }),
		},
		"BurrowGate could not issue the store domain certificate",
		false,
		120_000
	);
}

async function deleteBurrowGateSite(siteId: string): Promise<void> {
	await providerFetch(
		burrowGateUrl(`/_burrowgate/api/admin/sites/${encodeURIComponent(siteId)}`),
		{ method: "DELETE", headers: burrowGateHeaders() },
		"BurrowGate could not remove the store domain site",
		true
	);
}

async function deleteResources(domain: StoreDomain): Promise<void> {
	const operations: Promise<void>[] = [];
	if (domain.provider === "cloudflare" && domain.providerHostnameId) operations.push(deleteCloudflareHostname(domain.providerHostnameId));
	if (domain.provider !== "manual" && domain.gatewaySiteId) operations.push(deleteBurrowGateSite(domain.gatewaySiteId));
	const failed = (await Promise.allSettled(operations)).find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failed) throw failed.reason;
}

function ownershipRecord(hostname: string): VerificationRecord {
	return { type: "TXT", name: `_rabbitpay.${hostname}`, value: `rabbitpay-verify=${Utils.generateRandomText(40)}` };
}

async function addressesOf(hostname: string): Promise<string[]> {
	const [v4, v6] = await Promise.all([resolve4(hostname).catch(() => [] as string[]), resolve6(hostname).catch(() => [] as string[])]);
	return [...v4, ...v6];
}

async function pointsHere(hostname: string): Promise<boolean> {
	const target = domainTarget();
	const cnames = await resolveCname(hostname).catch(() => [] as string[]);
	if (cnames.some((name) => cleanHost(name) === target)) return true;
	const [own, wanted] = await Promise.all([addressesOf(hostname), addressesOf(target)]);
	return own.length > 0 && own.every((address) => wanted.includes(address));
}

async function dnsReady(domain: StoreDomain): Promise<boolean> {
	const required = domain.records.filter((record) => record.type === "TXT");
	try {
		const answers = await Promise.all(required.map((record) => resolveTxt(record.name).catch(() => [] as string[][])));
		if (!required.every((record, index) => answers[index]!.some((parts) => parts.join("") === record.value))) return false;
		return await pointsHere(domain.hostname);
	} catch {
		return false;
	}
}

async function activate(domain: StoreDomain, records: VerificationRecord[]): Promise<StoreDomain> {
	const active = await updateDomain(domain, { status: "active", records, lastError: null, activated: domain.activated ?? Date.now() });
	await Database`UPDATE store_settings SET domain = ${domain.hostname} WHERE project = ${domain.project}`;
	forgetDomains();
	return active;
}

async function provision(domain: StoreDomain): Promise<StoreDomain> {
	let records = domain.records;
	let ready: boolean;
	if (domain.provider === "cloudflare") {
		if (!domain.providerHostnameId) throw new DomainProvisioningFailed("The Cloudflare hostname id is missing");
		const cloudflare = await readCloudflareHostname(domain.providerHostnameId);
		if (cloudflare.records.length > 0) records = cloudflare.records;
		ready = cloudflare.ready;
	} else {
		ready = await dnsReady(domain);
	}

	if (!ready) return await updateDomain(domain, { status: "pending", records, lastError: null });
	if (domain.provider === "manual") return await activate(domain, records);

	let current = domain;
	if (!current.gatewaySiteId) {
		const siteId = await createBurrowGateSite(current.hostname, current.provider === "cloudflare");
		try {
			current = await updateDomain(current, { status: "provisioning", gatewaySiteId: siteId, records, lastError: null });
		} catch (error) {
			await deleteBurrowGateSite(siteId).catch(() => undefined);
			throw error;
		}
	}

	let certificate = await burrowGateCertificateReady(current.gatewaySiteId!);
	if (!certificate) {
		await issueBurrowGateCertificate(current.gatewaySiteId!);
		certificate = await burrowGateCertificateReady(current.gatewaySiteId!);
	}
	if (!certificate) return await updateDomain(current, { status: "provisioning", records, lastError: null });
	return await activate(current, records);
}

const checking = new Set<string>();

export async function checkDomain(domain: StoreDomain): Promise<StoreDomain> {
	if (domain.status === "active" || checking.has(domain.project)) return domain;
	checking.add(domain.project);
	try {
		return await provision(domain);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Store domain setup failed";
		Logger.warn(`[DOMAINS] Setting up ${domain.hostname} failed: ${message}`);
		return await updateDomain(domain, { status: "error", lastError: message });
	} finally {
		checking.delete(domain.project);
	}
}

export type ConnectProblem = "unavailable" | "invalid" | "exists" | "taken";

export async function connectDomain(projectId: string, value: unknown): Promise<StoreDomain | ConnectProblem> {
	if (!domainsAvailable()) return "unavailable";
	const hostname = normalizeHostname(value);
	if (hostname === null || isReservedHostname(hostname)) return "invalid";
	if (await domainOf(projectId)) return "exists";
	if (await hostnameTaken(hostname, projectId)) return "taken";

	const provider = domainProvider() as StoreDomainProvider;
	let providerHostnameId: string | null = null;
	let records = [ownershipRecord(hostname)];
	if (provider === "cloudflare") {
		const cloudflare = await createCloudflareHostname(hostname);
		providerHostnameId = cloudflare.id;
		records = cloudflare.records;
	}

	const now = Date.now();
	const domain: StoreDomain = {
		project: projectId,
		hostname,
		provider,
		status: "pending",
		providerHostnameId,
		gatewaySiteId: null,
		records,
		lastError: null,
		created: now,
		updated: now,
		activated: null,
	};
	try {
		await Database`
			INSERT INTO store_domains(project, hostname, provider, status, provider_hostname_id, gateway_site_id, verification_records, last_error, created, updated, activated)
			VALUES(${projectId}, ${hostname}, ${provider}, 'pending', ${providerHostnameId}, NULL, ${JSON.stringify(records)}, NULL, ${now}, ${now}, NULL)
		`;
	} catch (error) {
		await deleteResources(domain).catch(() => undefined);
		if (await hostnameTaken(hostname, projectId)) return "taken";
		throw error;
	}
	return domain;
}

async function forget(domain: StoreDomain) {
	await Database.begin(async (tx) => {
		await tx`DELETE FROM store_domains WHERE project = ${domain.project}`;
		await tx`UPDATE store_settings SET domain = NULL WHERE project = ${domain.project}`;
	});
	forgetDomains();
}

export async function removeDomain(domain: StoreDomain): Promise<void> {
	try {
		await deleteResources(domain);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Store domain removal failed";
		Logger.warn(`[DOMAINS] Removing ${domain.hostname} failed: ${message}`);
		await updateDomain(domain, { status: "error", lastError: message });
		throw error;
	}
	await forget(domain);
}

export async function releaseProjectDomain(projectId: string): Promise<void> {
	const domain = await domainOf(projectId);
	if (!domain) return;
	try {
		await deleteResources(domain);
	} catch (error) {
		Logger.warn(
			`[DOMAINS] ${domain.hostname} was released without removing its provider resources (Cloudflare ${domain.providerHostnameId ?? "none"}, BurrowGate ${domain.gatewaySiteId ?? "none"}): ${error}`
		);
	}
	await forget(domain);
}

export function presentDomain(domain: StoreDomain) {
	const pointer: VerificationRecord = { type: "CNAME", name: domain.hostname, value: domainTarget() };
	return {
		hostname: domain.hostname,
		status: domain.status,
		records: domain.status === "active" ? [] : [pointer, ...domain.records],
		created: domain.created,
		activated: domain.activated,
	};
}

export async function domainState(projectId: string) {
	const domain = await domainOf(projectId);
	return {
		available: domainsAvailable(),
		target: domainTarget(),
		domain: domain ? presentDomain(domain) : null,
	};
}

export async function checkWaitingDomains(): Promise<number> {
	if (!domainsAvailable()) return 0;
	const rows = (await Database`
		SELECT * FROM store_domains WHERE status IN ('pending', 'provisioning', 'error') AND created > ${Date.now() - RETRY_DAYS * DAY} ORDER BY updated ASC LIMIT 50
	`) as StoreDomainRow[];
	let activated = 0;
	for (const row of rows) {
		if ((await checkDomain(fromRow(row))).status === "active") activated++;
	}
	return activated;
}
