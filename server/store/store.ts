import Database from "../database/database";
import Utils from "../utils";
import { addressLines, companyFor, displayNameOf } from "../company";
import { storeActive } from "../licensing";
import { defaultStoreConfig, parseStoredConfig, slugify, type StoreConfig, type StoreSeller } from "./config";
import type { ProjectRow, StoreImageRow, StoreSettingsRow } from "../database/models";

const DOMAIN_CACHE_MS = 60 * 1000;

export interface LoadedStore {
	project: ProjectRow;
	settings: StoreSettingsRow;
	config: StoreConfig;
	seller: StoreSeller;
}

export async function sellerFor(project: ProjectRow): Promise<StoreSeller> {
	const company = await companyFor(project.uuid);
	return {
		name: displayNameOf(project),
		language: project.language,
		accent: project.accent_color,
		legal_name: company.legal_name,
		address: addressLines(company, project.language),
		email: company.email,
		phone: company.phone,
		vat_number: company.vat_number,
		registration_number: company.registration_number,
		country: company.country,
	};
}

export async function settingsFor(projectId: string): Promise<StoreSettingsRow | null> {
	const [row] = (await Database`SELECT * FROM store_settings WHERE project = ${projectId}`) as StoreSettingsRow[];
	return row ?? null;
}

export async function suggestedSlug(project: ProjectRow): Promise<string> {
	const base = slugify(displayNameOf(project), 60);
	for (let attempt = 0; attempt < 50; attempt++) {
		const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
		const [taken] = (await Database`SELECT project FROM store_settings WHERE slug = ${candidate}`) as { project: string }[];
		if (!taken) return candidate;
	}
	return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function draftFor(project: ProjectRow) {
	const seller = await sellerFor(project);
	const settings = await settingsFor(project.uuid);
	if (settings) return { settings, config: parseStoredConfig(settings.config, seller), seller, slug: settings.slug };
	return { settings: null, config: defaultStoreConfig(seller), seller, slug: await suggestedSlug(project) };
}

async function openStore(settings: StoreSettingsRow | undefined): Promise<LoadedStore | null> {
	if (!settings || !settings.enabled) return null;
	const [project] = (await Database`SELECT * FROM projects WHERE uuid = ${settings.project} AND status = 'active'`) as ProjectRow[];
	if (!project || !storeActive(project)) return null;
	const seller = await sellerFor(project);
	return { project, settings, config: parseStoredConfig(settings.config, seller), seller };
}

export async function storeBySlug(slug: string): Promise<LoadedStore | null> {
	const [settings] = (await Database`SELECT * FROM store_settings WHERE slug = ${slug}`) as StoreSettingsRow[];
	return await openStore(settings);
}

const domainCache = new Map<string, { slug: string | null; expires: number }>();

export function normalizeHost(host: string | null | undefined): string | null {
	if (!host) return null;
	const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
	return name === "" ? null : name;
}

export async function slugForHost(host: string | null | undefined): Promise<string | null> {
	const name = normalizeHost(host);
	if (name === null || name.length > 253) return null;

	const cached = domainCache.get(name);
	if (cached && cached.expires > Date.now()) return cached.slug;

	const [row] = (await Database`SELECT slug, enabled FROM store_settings WHERE domain = ${name}`) as Pick<StoreSettingsRow, "slug" | "enabled">[];
	const slug = row && row.enabled ? row.slug : null;
	if (domainCache.size > 1000) domainCache.clear();
	domainCache.set(name, { slug, expires: Date.now() + DOMAIN_CACHE_MS });
	return slug;
}

export function forgetDomains() {
	domainCache.clear();
}

export function storePath(settings: Pick<StoreSettingsRow, "slug">): string {
	return `/shop/${settings.slug}`;
}

export function storeUrl(settings: Pick<StoreSettingsRow, "slug" | "domain">): string {
	return settings.domain ? `https://${settings.domain}` : `${Utils.publicUrl()}/shop/${settings.slug}`;
}

export function imagePath(image: Pick<StoreImageRow, "uuid">): string {
	return `/api/v1/public/store-images/${image.uuid}`;
}

export async function brandImages(projectId: string): Promise<{ logo: string | null; hero: string | null }> {
	const rows = (await Database`
		SELECT uuid, kind FROM store_images WHERE project = ${projectId} AND kind IN ('logo', 'hero') ORDER BY created DESC
	`) as Pick<StoreImageRow, "uuid" | "kind">[];
	const logo = rows.find((row) => row.kind === "logo");
	const hero = rows.find((row) => row.kind === "hero");
	return { logo: logo ? imagePath(logo) : null, hero: hero ? imagePath(hero) : null };
}
