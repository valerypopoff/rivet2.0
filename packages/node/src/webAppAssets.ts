import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { RIVET_WEB_APP_DOCUMENT_CSS, RIVET_WEB_APP_RENDERER_CSS } from '@valerypopoff/rivet2-core';
import { RIVET_WEB_APP_CLIENT_JS } from './generated/webAppClient.generated.js';

export const RIVET_WEB_APP_ASSET_ROUTE = '/_rivet/assets';
export const RIVET_WEB_APP_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type RivetWebAppAssetKey = 'client' | 'domPurify' | 'marked' | 'styles';

export type RivetWebAppAsset = Readonly<{
  content: string;
  contentType: string;
  etag: string;
  fileName: string;
  hash: string;
  integrity: string;
  key: RivetWebAppAssetKey;
}>;

export type RivetWebAppAssetManifest = Readonly<Record<RivetWebAppAssetKey, RivetWebAppAsset>>;

let manifest: RivetWebAppAssetManifest | undefined;
let requireForWebAppAssets: ReturnType<typeof createRequire> | undefined;

/** Returns the immutable, content-addressed assets used by hosted Rivet web apps. */
export function getRivetWebAppAssetManifest(): RivetWebAppAssetManifest {
  manifest ??= Object.freeze({
    client: createAsset('client', 'rivet-web-app', 'js', RIVET_WEB_APP_CLIENT_JS, 'text/javascript; charset=utf-8'),
    domPurify: createAsset(
      'domPurify',
      'dompurify',
      'js',
      readPackageAsset('dompurify/dist/purify.min.js'),
      'text/javascript; charset=utf-8',
    ),
    marked: createAsset(
      'marked',
      'marked',
      'js',
      readPackageAsset('marked/marked.min.js'),
      'text/javascript; charset=utf-8',
    ),
    styles: createAsset(
      'styles',
      'rivet-web-app',
      'css',
      [
        RIVET_WEB_APP_DOCUMENT_CSS,
        readPackageAsset('github-markdown-css/github-markdown-dark-dimmed.css'),
        RIVET_WEB_APP_RENDERER_CSS,
      ].join('\n'),
      'text/css; charset=utf-8',
    ),
  });
  return manifest;
}

function createAsset(
  key: RivetWebAppAssetKey,
  baseName: string,
  extension: string,
  content: string,
  contentType: string,
): RivetWebAppAsset {
  const digest = createHash('sha256').update(content).digest();
  const hash = digest.toString('hex');
  return Object.freeze({
    content,
    contentType,
    etag: `"${hash}"`,
    fileName: `${baseName}.${hash.slice(0, 20)}.${extension}`,
    hash,
    integrity: `sha256-${digest.toString('base64')}`,
    key,
  });
}

function readPackageAsset(specifier: string): string {
  return readFileSync(getRequireForWebAppAssets().resolve(specifier), 'utf8');
}

function getRequireForWebAppAssets(): ReturnType<typeof createRequire> {
  requireForWebAppAssets ??= createRequire(getCreateRequireAnchor());
  return requireForWebAppAssets;
}

function getCreateRequireAnchor(): string {
  if (typeof import.meta.url === 'string' && import.meta.url.length > 0) {
    return import.meta.url;
  }
  if (typeof __filename === 'string' && __filename.length > 0) {
    return __filename;
  }
  return `${process.cwd()}/package.json`;
}
