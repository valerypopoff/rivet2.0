import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pagesOutDir = path.resolve(repoRoot, process.env.PAGES_OUT_DIR ?? 'desktop-release-pages');
const releaseChannel = process.env.RELEASE_CHANNEL ?? 'developer';
const releaseAssetsManifestPath = process.env.RELEASE_ASSETS_MANIFEST_PATH?.trim();

const releaseConfigs = {
  developer: {
    displayName: 'Developer',
    metadataFile: 'developer-release.json',
    stableFilePrefixes: {
      macos: 'Rivet-2-Developer-macOS',
      windows: 'Rivet-2-Developer-Windows',
    },
  },
  official: {
    displayName: 'Stable',
    metadataFile: 'official-release.json',
    stableFilePrefixes: {
      macos: 'Rivet-2-macOS',
      windows: 'Rivet-2-Windows',
    },
  },
};

const releaseConfig = releaseConfigs[releaseChannel];

if (!releaseConfig) {
  throw new Error(`Unsupported RELEASE_CHANNEL: ${releaseChannel}`);
}

const downloadsDir = path.join(pagesOutDir, 'downloads', releaseChannel);
const originalDownloadsDir = path.join(downloadsDir, 'original');

const platformConfigs = {
  windows: {
    displayName: 'Windows',
    releaseFilePattern: /\.(exe|msi|zip|sig|json|blockmap)$/i,
    sourceBundleDir: path.resolve(
      repoRoot,
      process.env.WINDOWS_BUNDLE_DIR ??
        process.env.SOURCE_BUNDLE_DIR ??
        'packages/app/src-tauri/target/release/bundle',
    ),
  },
  macos: {
    displayName: 'macOS',
    releaseFilePattern: /\.(dmg|zip|sig|json|blockmap)$/i,
    sourceBundleDir: path.resolve(
      repoRoot,
      process.env.MACOS_BUNDLE_DIR ?? 'packages/app/src-tauri/target/universal-apple-darwin/release/bundle',
    ),
  },
};

function parseReleasePlatforms() {
  const requestedPlatforms = (process.env.RELEASE_PLATFORMS ?? 'windows,macos')
    .split(',')
    .map((platform) => platform.trim().toLowerCase())
    .filter((platform) => platform.length > 0);

  if (requestedPlatforms.length === 0) {
    throw new Error('RELEASE_PLATFORMS did not include any platforms.');
  }

  return requestedPlatforms.map((platform) => {
    const config = platformConfigs[platform];

    if (!config) {
      throw new Error(`Unsupported release platform: ${platform}`);
    }

    return {
      id: platform,
      ...config,
    };
  });
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return walkFiles(entryPath);
      }

      return entry.isFile() ? [entryPath] : [];
    }),
  );

  return files.flat();
}

function toPagePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function defaultPublishedSiteUrl() {
  const repository = process.env.GITHUB_REPOSITORY ?? 'valerypopoff/rivet2.0';
  const [owner, repo] = repository.split('/');
  return `https://${owner}.github.io/${repo}/`;
}

function normalizePublishedPath(url, publishedSiteUrl) {
  const parsedUrl = new URL(url, publishedSiteUrl);
  const siteUrl = new URL(publishedSiteUrl);

  if (parsedUrl.origin !== siteUrl.origin) {
    return null;
  }

  const sitePath = siteUrl.pathname.endsWith('/') ? siteUrl.pathname : `${siteUrl.pathname}/`;

  if (!parsedUrl.pathname.startsWith(sitePath)) {
    return null;
  }

  return decodeURIComponent(parsedUrl.pathname.slice(sitePath.length)).replace(/^\/+/, '');
}

async function writeUnderPagesRoot(relativePath, bytes) {
  const targetPath = path.resolve(pagesOutDir, relativePath);
  const relativeTarget = path.relative(pagesOutDir, targetPath);

  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error(`Refusing to write outside Pages output: ${relativePath}`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);
}

function releaseAssetUrls(metadata) {
  return [
    ...(Array.isArray(metadata.stableDownloads) ? metadata.stableDownloads : []),
    ...(Array.isArray(metadata.artifacts) ? metadata.artifacts : []),
  ]
    .map((item) => item?.url)
    .filter((url) => typeof url === 'string' && url.length > 0);
}

function assertPublishedReleaseMetadata(metadata, metadataFile) {
  if (metadata == null || typeof metadata !== 'object') {
    throw new Error(`Existing ${metadataFile} is not a release metadata object.`);
  }

  if (!Array.isArray(metadata.stableDownloads) || metadata.stableDownloads.length === 0) {
    throw new Error(`Existing ${metadataFile} does not contain any stable downloads.`);
  }

  if (!metadata.stableDownloads.every(isStableDownload)) {
    throw new Error(`Existing ${metadataFile} has invalid stable download metadata.`);
  }

  if (!Array.isArray(metadata.artifacts) || !metadata.artifacts.every(isReleaseAsset)) {
    throw new Error(`Existing ${metadataFile} has invalid build artifact metadata.`);
  }
}

async function preservePublishedRelease(metadataFile, publishedSiteUrl) {
  const metadataUrl = new URL(metadataFile, publishedSiteUrl);
  let response;

  try {
    response = await fetch(metadataUrl, { cache: 'no-store' });
  } catch (error) {
    throw new Error(
      `Could not fetch existing ${metadataFile}; refusing to publish a Pages site that could drop the other release channel. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (response.status === 404) {
    console.log(`No existing ${metadataFile} found on Pages; nothing to preserve.`);
    return;
  }

  if (!response.ok) {
    throw new Error(
      `Could not fetch existing ${metadataFile}; refusing to publish a Pages site that could drop the other release channel. ${response.status} ${response.statusText}`,
    );
  }

  const metadataText = await response.text();
  let metadata;

  try {
    metadata = JSON.parse(metadataText);
  } catch (error) {
    throw new Error(
      `Existing ${metadataFile} is not valid JSON; refusing to publish a Pages site that could drop the other release channel. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    assertPublishedReleaseMetadata(metadata, metadataFile);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Refusing to publish a Pages site that could drop the other release channel.`,
    );
  }

  for (const assetUrl of releaseAssetUrls(metadata)) {
    const assetPath = normalizePublishedPath(assetUrl, publishedSiteUrl);

    if (!assetPath) {
      console.warn(`Skipping non-site release asset while preserving ${metadataFile}: ${assetUrl}`);
      continue;
    }

    try {
      const assetResponse = await fetch(new URL(assetPath, publishedSiteUrl), { cache: 'no-store' });

      if (!assetResponse.ok) {
        throw new Error(`${assetResponse.status} ${assetResponse.statusText}`);
      }

      const assetBytes = Buffer.from(await assetResponse.arrayBuffer());
      await writeUnderPagesRoot(assetPath, assetBytes);
    } catch (error) {
      throw new Error(
        `Could not preserve ${assetUrl}; refusing to publish a Pages site that could break the other release channel. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await writeUnderPagesRoot(metadataFile, metadataText);
  console.log(`Preserved existing ${metadataFile} from ${publishedSiteUrl}`);
}

function formatReleaseLabel(shortSha) {
  return process.env.RELEASE_LABEL ?? `${process.env.GITHUB_REF_NAME ?? releaseChannel}-${shortSha}`;
}

async function readAppVersion() {
  const appPackagePath = path.join(repoRoot, 'packages', 'app', 'package.json');
  const tauriConfigPath = path.join(repoRoot, 'packages', 'app', 'src-tauri', 'tauri.conf.json');
  const appPackage = JSON.parse(await readFile(appPackagePath, 'utf8'));
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, 'utf8'));
  const appVersion = appPackage?.version;
  const version = tauriConfig?.package?.version;

  if (typeof appVersion !== 'string' || appVersion.length === 0) {
    throw new Error(`Could not read version from ${appPackagePath}`);
  }

  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`Could not read package.version from ${tauriConfigPath}`);
  }

  if (version !== appVersion) {
    throw new Error(
      `Desktop version mismatch: ${appPackagePath} has ${appVersion}, but ${tauriConfigPath} has ${version}. Tauri bundle filenames use tauri.conf.json package.version.`,
    );
  }

  return appVersion;
}

async function collectPlatformArtifacts(platformConfig) {
  await stat(platformConfig.sourceBundleDir).catch(() => {
    throw new Error(
      `${platformConfig.displayName} Tauri bundle directory does not exist: ${platformConfig.sourceBundleDir}`,
    );
  });

  const bundleFiles = (await walkFiles(platformConfig.sourceBundleDir)).filter((file) =>
    platformConfig.releaseFilePattern.test(file),
  );

  if (bundleFiles.length === 0) {
    throw new Error(
      `No ${platformConfig.displayName} release artifacts were found under ${platformConfig.sourceBundleDir}`,
    );
  }

  const artifacts = [];

  for (const sourcePath of bundleFiles) {
    const relativeSourcePath = path.relative(platformConfig.sourceBundleDir, sourcePath);
    const originalPath = toPagePath(path.join(platformConfig.id, relativeSourcePath));
    const downloadPath = path.join(originalDownloadsDir, originalPath);
    await mkdir(path.dirname(downloadPath), { recursive: true });
    await copyFile(sourcePath, downloadPath);

    const fileStat = await stat(sourcePath);
    artifacts.push({
      name: path.basename(sourcePath),
      originalPath,
      platform: platformConfig.id,
      size: fileStat.size,
      sourcePath: downloadPath,
      url: encodeURI(toPagePath(path.relative(pagesOutDir, downloadPath))),
    });
  }

  return artifacts;
}

async function createStableDownload({ artifact, label, stableName }) {
  const stablePath = path.join(downloadsDir, stableName);
  await mkdir(path.dirname(stablePath), { recursive: true });
  await copyFile(artifact.sourcePath, stablePath);

  return {
    label,
    name: stableName,
    platform: artifact.platform,
    url: encodeURI(toPagePath(path.relative(pagesOutDir, stablePath))),
    size: artifact.size,
  };
}

async function createStableDownloads(artifacts) {
  const stableDownloads = [];
  const windowsPrefix = releaseConfig.stableFilePrefixes.windows;
  const macosPrefix = releaseConfig.stableFilePrefixes.macos;

  const primarySetup = artifacts.find(
    (artifact) => artifact.platform === 'windows' && /setup\.exe$/i.test(artifact.name),
  );
  const primaryMsi = artifacts.find(
    (artifact) => artifact.platform === 'windows' && /\.msi$/i.test(artifact.name),
  );
  const primaryDmg = artifacts.find(
    (artifact) => artifact.platform === 'macos' && /\.dmg$/i.test(artifact.name),
  );

  if (primarySetup) {
    stableDownloads.push(
      await createStableDownload({
        artifact: primarySetup,
        label: 'Windows setup executable',
        stableName: `${windowsPrefix}-Setup.exe`,
      }),
    );
  }

  if (primaryMsi) {
    stableDownloads.push(
      await createStableDownload({
        artifact: primaryMsi,
        label: 'Windows MSI installer',
        stableName: `${windowsPrefix}.msi`,
      }),
    );
  }

  if (primaryDmg) {
    stableDownloads.push(
      await createStableDownload({
        artifact: primaryDmg,
        label: 'macOS disk image',
        stableName: `${macosPrefix}.dmg`,
      }),
    );
  }

  return stableDownloads;
}

function assertStableDownloadsForRequestedPlatforms(stableDownloads, releasePlatforms) {
  const missingPlatforms = releasePlatforms.filter(
    (platformConfig) => !stableDownloads.some((download) => download.platform === platformConfig.id),
  );

  if (missingPlatforms.length > 0) {
    throw new Error(
      `No stable download aliases were produced for ${missingPlatforms
        .map((platformConfig) => platformConfig.displayName)
        .join(', ')}.`,
    );
  }
}

function isReleaseAsset(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.originalPath === 'string' &&
    value.originalPath.length > 0 &&
    typeof value.platform === 'string' &&
    value.platform.length > 0 &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    typeof value.url === 'string' &&
    value.url.length > 0
  );
}

function isStableDownload(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.platform === 'string' &&
    value.platform.length > 0 &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    typeof value.url === 'string' &&
    value.url.length > 0
  );
}

function assertHttpsReleaseAssetUrl(url, description) {
  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${description} must use an absolute HTTPS URL, received: ${url}`);
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`${description} must use an absolute HTTPS URL, received: ${url}`);
  }
}

async function readReleaseAssetsManifest({ releasePlatforms, version }) {
  if (!releaseAssetsManifestPath) {
    return null;
  }

  const manifestPath = path.resolve(repoRoot, releaseAssetsManifestPath);
  let manifest;

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Could not read release asset manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (manifest?.version !== 1 || manifest.channel !== releaseChannel) {
    throw new Error(`Release asset manifest ${manifestPath} is not for the ${releaseChannel} release channel.`);
  }

  if (manifest.desktopVersion !== version) {
    throw new Error(
      `Release asset manifest ${manifestPath} has desktop version ${String(manifest.desktopVersion)}, expected ${version}.`,
    );
  }

  if (!Array.isArray(manifest.stableDownloads) || !manifest.stableDownloads.every(isStableDownload)) {
    throw new Error(`Release asset manifest ${manifestPath} has invalid stableDownloads.`);
  }

  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.every(isReleaseAsset)) {
    throw new Error(`Release asset manifest ${manifestPath} has invalid artifacts.`);
  }

  for (const asset of [...manifest.stableDownloads, ...manifest.artifacts]) {
    assertHttpsReleaseAssetUrl(asset.url, `Release asset ${asset.name}`);
  }

  assertStableDownloadsForRequestedPlatforms(manifest.stableDownloads, releasePlatforms);

  return {
    artifacts: manifest.artifacts,
    releaseUrl: typeof manifest.release?.url === 'string' ? manifest.release.url : null,
    stableDownloads: manifest.stableDownloads,
  };
}

async function main() {
  const releasePlatforms = parseReleasePlatforms();
  const preserveMetadataFiles = (process.env.PRESERVE_RELEASE_METADATA_FILES ?? '')
    .split(',')
    .map((file) => file.trim())
    .filter((file) => file.length > 0 && file !== releaseConfig.metadataFile);
  const publishedSiteUrl = process.env.PAGES_SITE_URL ?? defaultPublishedSiteUrl();
  const version = await readAppVersion();

  for (const metadataFile of preserveMetadataFiles) {
    await preservePublishedRelease(metadataFile, publishedSiteUrl);
  }

  const releaseAssetsManifest = await readReleaseAssetsManifest({ releasePlatforms, version });
  let artifacts;
  let releaseUrl = null;
  let stableDownloads;

  if (releaseAssetsManifest) {
    ({ artifacts, releaseUrl, stableDownloads } = releaseAssetsManifest);
  } else {
    await mkdir(originalDownloadsDir, { recursive: true });
    artifacts = (await Promise.all(
      releasePlatforms.map((platformConfig) => collectPlatformArtifacts(platformConfig)),
    ))
      .flat()
      .sort((a, b) => `${a.platform}:${a.name}`.localeCompare(`${b.platform}:${b.name}`));
    stableDownloads = await createStableDownloads(artifacts);
    assertStableDownloadsForRequestedPlatforms(stableDownloads, releasePlatforms);
  }

  const shortSha = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);
  const repository = process.env.GITHUB_REPOSITORY ?? 'local/repo';
  const runId = process.env.GITHUB_RUN_ID;
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const releaseMetadata = {
    channel: releaseChannel,
    title: `${releaseConfig.displayName} Desktop Release`,
    version,
    label: formatReleaseLabel(shortSha),
    generatedAt: new Date().toISOString(),
    branch: process.env.GITHUB_REF_NAME ?? releaseChannel,
    commit: process.env.GITHUB_SHA ?? 'local',
    runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
    runUrl: runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
    commitUrl: process.env.GITHUB_SHA ? `${serverUrl}/${repository}/commit/${process.env.GITHUB_SHA}` : null,
    releaseUrl,
    stableDownloads,
    artifacts: artifacts.map(({ sourcePath: _sourcePath, ...artifact }) => artifact),
  };

  await mkdir(pagesOutDir, { recursive: true });
  await writeFile(path.join(pagesOutDir, releaseConfig.metadataFile), JSON.stringify(releaseMetadata, null, 2));

  console.log(
    `Prepared ${releaseChannel} desktop release downloads for ${releasePlatforms
      .map((platformConfig) => platformConfig.displayName)
      .join(', ')} at ${pagesOutDir}`,
  );
}

await main();
