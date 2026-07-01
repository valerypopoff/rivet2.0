import fs from 'node:fs';
import path from 'node:path';

import { normalizeBasePath, normalizeBasePathFromAliases } from '../../shared/normalize-base-path.js';
import type {
  AppSettingsSource,
  PublicRouteSettings,
  PublicRouteSettingsDraft,
  WebAppRouteSettings,
} from '../../shared/app-settings-types.js';
import { getAppDataRoot } from './security.js';
import { writeJsonSettingsFile } from './settings-file-writer.js';
import { badRequest } from './utils/httpError.js';

export const PUBLIC_ROUTE_SETTINGS_RELATIVE_PATH = path.join('settings', 'public-routes.json');
export const LEGACY_WEB_APP_ROUTE_SETTINGS_RELATIVE_PATH = path.join('settings', 'web-app-routes.json');

const MAX_ROUTE_SLUG_LENGTH = 64;
const RESERVED_ROUTE_SLUGS = new Set([
  '__rivet_auth',
  'api',
  'assets',
  'internal',
  'node_modules',
  'ui-auth',
  'ws',
]);

type RuntimePublicRouteSettings = PublicRouteSettings;

type RouteField = {
  draftKey: keyof PublicRouteSettingsDraft;
  fallback: string;
  label: string;
};

const routeFields: RouteField[] = [
  {
    draftKey: 'publishedWorkflowsBasePath',
    fallback: '/workflows',
    label: 'Published workflow endpoints slug',
  },
  {
    draftKey: 'latestWorkflowsBasePath',
    fallback: '/workflows-latest',
    label: 'Latest workflow endpoints slug',
  },
  {
    draftKey: 'publishedAppsBasePath',
    fallback: '/apps',
    label: 'Published web apps slug',
  },
  {
    draftKey: 'latestAppsBasePath',
    fallback: '/apps-latest',
    label: 'Latest web apps slug',
  },
];

function getEnvPublishedAppsBasePath(): string {
  return normalizeBasePathFromAliases(
    [
      process.env.RIVET_PUBLISHED_APPS_BASE_PATH,
      process.env.RIVET_WEB_APPS_BASE_PATH,
    ],
    '/apps',
  );
}

function getEnvLatestAppsBasePath(): string {
  return normalizeBasePathFromAliases(
    [
      process.env.RIVET_LATEST_APPS_BASE_PATH,
      process.env.RIVET_LATEST_WEB_APPS_BASE_PATH,
    ],
    '/apps-latest',
  );
}

function getDefaultPublicRouteSettings(source: AppSettingsSource = 'default'): RuntimePublicRouteSettings {
  return {
    publishedWorkflowsBasePath: normalizeBasePath(process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH, '/workflows'),
    latestWorkflowsBasePath: normalizeBasePath(process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH, '/workflows-latest'),
    publishedAppsBasePath: getEnvPublishedAppsBasePath(),
    latestAppsBasePath: getEnvLatestAppsBasePath(),
    updatedAt: null,
    source,
  };
}

function normalizeRouteSlug(value: unknown, fieldLabel: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const slug = raw.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();

  if (!slug) {
    throw badRequest(`${fieldLabel} is required`);
  }

  if (slug.length > MAX_ROUTE_SLUG_LENGTH) {
    throw badRequest(`${fieldLabel} is too long`);
  }

  if (slug.includes('/')) {
    throw badRequest(`${fieldLabel} must be a single URL path segment`);
  }

  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw badRequest(`${fieldLabel} must contain only lowercase letters, numbers, and hyphens`);
  }

  if (RESERVED_ROUTE_SLUGS.has(slug)) {
    throw badRequest(`${fieldLabel} cannot use the reserved "${slug}" route`);
  }

  return slug;
}

function normalizePublicRouteSettingsDraft(
  value: unknown,
  fallback = getDefaultPublicRouteSettings(),
): Omit<RuntimePublicRouteSettings, 'updatedAt' | 'source'> {
  const raw = value && typeof value === 'object'
    ? value as PublicRouteSettingsDraft
    : {};
  const normalized = {} as Omit<RuntimePublicRouteSettings, 'updatedAt' | 'source'>;
  const usedSlugs = new Map<string, string>();

  for (const field of routeFields) {
    const slug = normalizeRouteSlug(raw[field.draftKey] ?? fallback[field.draftKey] ?? field.fallback, field.label);
    const existingLabel = usedSlugs.get(slug);
    if (existingLabel) {
      throw badRequest(`${field.label} must be different from ${existingLabel.toLowerCase()}`);
    }

    usedSlugs.set(slug, field.label);
    normalized[field.draftKey] = normalizeBasePath(slug, field.fallback) as never;
  }

  return normalized;
}

function normalizeStoredPublicRouteSettings(value: unknown): RuntimePublicRouteSettings {
  const raw = value && typeof value === 'object'
    ? value as PublicRouteSettingsDraft & { updatedAt?: unknown }
    : {};
  const settings = normalizePublicRouteSettingsDraft(raw);

  return {
    ...settings,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source: 'app-settings',
  };
}

function normalizeLegacyWebAppRouteSettings(value: unknown): RuntimePublicRouteSettings {
  const raw = value && typeof value === 'object'
    ? value as Pick<PublicRouteSettingsDraft, 'publishedAppsBasePath' | 'latestAppsBasePath'> & { updatedAt?: unknown }
    : {};
  const fallback = getDefaultPublicRouteSettings();
  const settings = normalizePublicRouteSettingsDraft({
    ...fallback,
    publishedAppsBasePath: raw.publishedAppsBasePath ?? fallback.publishedAppsBasePath,
    latestAppsBasePath: raw.latestAppsBasePath ?? fallback.latestAppsBasePath,
  });

  return {
    ...settings,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    source: 'app-settings',
  };
}

function getSettingsRoot(): string {
  return path.resolve(process.env.RIVET_APP_DATA_ROOT?.trim() || getAppDataRoot());
}

export function getPublicRouteSettingsPath(): string {
  return path.join(getSettingsRoot(), PUBLIC_ROUTE_SETTINGS_RELATIVE_PATH);
}

export function getLegacyWebAppRouteSettingsPath(): string {
  return path.join(getSettingsRoot(), LEGACY_WEB_APP_ROUTE_SETTINGS_RELATIVE_PATH);
}

export function readPublicRouteSettingsSync(): RuntimePublicRouteSettings {
  const settingsPath = getPublicRouteSettingsPath();

  try {
    return normalizeStoredPublicRouteSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[public-routes] Failed to read public route app settings; using deployment defaults:', error);
      return getDefaultPublicRouteSettings();
    }
  }

  const legacySettingsPath = getLegacyWebAppRouteSettingsPath();
  try {
    return normalizeLegacyWebAppRouteSettings(JSON.parse(fs.readFileSync(legacySettingsPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[public-routes] Failed to read legacy web-app route app settings; using deployment defaults:', error);
    }

    return getDefaultPublicRouteSettings();
  }
}

export async function readPublicRouteSettings(): Promise<PublicRouteSettings> {
  return readPublicRouteSettingsSync();
}

export async function writePublicRouteSettings(draft: unknown): Promise<PublicRouteSettings> {
  const settings = normalizePublicRouteSettingsDraft(draft, readPublicRouteSettingsSync());
  const saved: PublicRouteSettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
    source: 'app-settings',
  };

  await writeJsonSettingsFile(
    getPublicRouteSettingsPath(),
    {
      version: 1,
      publishedWorkflowsBasePath: saved.publishedWorkflowsBasePath,
      latestWorkflowsBasePath: saved.latestWorkflowsBasePath,
      publishedAppsBasePath: saved.publishedAppsBasePath,
      latestAppsBasePath: saved.latestAppsBasePath,
      updatedAt: saved.updatedAt,
    },
    0o644,
  );

  return saved;
}

export function getPublishedWebAppsBasePath(): string {
  return readPublicRouteSettingsSync().publishedAppsBasePath;
}

export function getLatestWebAppsBasePath(): string {
  return readPublicRouteSettingsSync().latestAppsBasePath;
}

export function getPublishedWorkflowsBasePath(): string {
  return readPublicRouteSettingsSync().publishedWorkflowsBasePath;
}

export function getLatestWorkflowsBasePath(): string {
  return readPublicRouteSettingsSync().latestWorkflowsBasePath;
}

export function getWebAppRouteSettingsPath(): string {
  return getPublicRouteSettingsPath();
}

export async function readWebAppRouteSettings(): Promise<WebAppRouteSettings> {
  const settings = await readPublicRouteSettings();
  return {
    publishedAppsBasePath: settings.publishedAppsBasePath,
    latestAppsBasePath: settings.latestAppsBasePath,
    updatedAt: settings.updatedAt,
    source: settings.source,
  };
}

export async function writeWebAppRouteSettings(draft: unknown): Promise<WebAppRouteSettings> {
  const current = readPublicRouteSettingsSync();
  const settings = await writePublicRouteSettings({
    ...current,
    ...(draft && typeof draft === 'object' ? draft : {}),
  });

  return {
    publishedAppsBasePath: settings.publishedAppsBasePath,
    latestAppsBasePath: settings.latestAppsBasePath,
    updatedAt: settings.updatedAt,
    source: settings.source,
  };
}
