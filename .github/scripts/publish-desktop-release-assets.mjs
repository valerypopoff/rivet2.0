import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiBaseUrl = 'https://api.github.com';
const uploadBaseUrl = 'https://uploads.github.com';

const releaseConfigs = {
  developer: {
    displayName: 'Developer',
    assetPrefix: 'Rivet-2-Developer',
    prerelease: true,
    tag: 'rivet-2-developer-feed',
  },
  official: {
    displayName: 'Stable',
    assetPrefix: 'Rivet-2',
    prerelease: false,
    tag: 'rivet-2-stable-feed',
  },
};

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

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be set.`);
  }

  return value;
}

function parseRepository() {
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const [owner, repo, ...rest] = repository.split('/');

  if (!owner || !repo || rest.length > 0) {
    throw new Error(`GITHUB_REPOSITORY must have the form owner/repo, received: ${repository}`);
  }

  return { owner, repo, repository };
}

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

    return { id: platform, ...config };
  });
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function sanitizeAssetSegment(value) {
  const sanitized = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!sanitized) {
    throw new Error(`Could not derive a release-asset name from ${value}.`);
  }

  return sanitized;
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

async function readAppVersion() {
  const appPackagePath = path.join(repoRoot, 'packages', 'app', 'package.json');
  const tauriConfigPath = path.join(repoRoot, 'packages', 'app', 'src-tauri', 'tauri.conf.json');
  const [appPackageText, tauriConfigText] = await Promise.all([
    readFile(appPackagePath, 'utf8'),
    readFile(tauriConfigPath, 'utf8'),
  ]);
  const appPackage = JSON.parse(appPackageText);
  const tauriConfig = JSON.parse(tauriConfigText);
  const appVersion = appPackage?.version;
  const tauriVersion = tauriConfig?.package?.version;

  if (typeof appVersion !== 'string' || appVersion.length === 0) {
    throw new Error(`Could not read version from ${appPackagePath}`);
  }

  if (typeof tauriVersion !== 'string' || tauriVersion.length === 0) {
    throw new Error(`Could not read package.version from ${tauriConfigPath}`);
  }

  if (appVersion !== tauriVersion) {
    throw new Error(
      `Desktop version mismatch: ${appPackagePath} has ${appVersion}, but ${tauriConfigPath} has ${tauriVersion}.`,
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

  return Promise.all(
    bundleFiles.map(async (sourcePath) => {
      const relativeSourcePath = path.relative(platformConfig.sourceBundleDir, sourcePath);
      const fileStat = await stat(sourcePath);

      return {
        name: path.basename(sourcePath),
        originalPath: toPosixPath(path.join(platformConfig.id, relativeSourcePath)),
        platform: platformConfig.id,
        size: fileStat.size,
        sourcePath,
      };
    }),
  );
}

function findPrimaryArtifacts(artifacts) {
  return new Map(
    [
      ['windowsSetup', artifacts.find((artifact) => artifact.platform === 'windows' && /setup\.exe$/i.test(artifact.name))],
      ['windowsMsi', artifacts.find((artifact) => artifact.platform === 'windows' && /\.msi$/i.test(artifact.name))],
      ['macosDmg', artifacts.find((artifact) => artifact.platform === 'macos' && /\.dmg$/i.test(artifact.name))],
    ].filter((entry) => entry[1]),
  );
}

function releaseAssetName({ artifact, assetPrefix, buildId, primaryKind }) {
  const extension = path.extname(artifact.name);

  if (primaryKind === 'windowsSetup') {
    return `${assetPrefix}-Windows-Setup-${buildId}${extension}`;
  }

  if (primaryKind === 'windowsMsi') {
    return `${assetPrefix}-Windows-${buildId}${extension}`;
  }

  if (primaryKind === 'macosDmg') {
    return `${assetPrefix}-macOS-${buildId}${extension}`;
  }

  const sourceStem = artifact.originalPath.slice(0, -extension.length);
  return `${assetPrefix}-${sanitizeAssetSegment(sourceStem)}-${buildId}${extension}`;
}

function stableDownloadDetails(primaryKind, assetPrefix) {
  switch (primaryKind) {
    case 'windowsSetup':
      return { label: 'Windows setup executable', name: `${assetPrefix}-Windows-Setup.exe` };
    case 'windowsMsi':
      return { label: 'Windows MSI installer', name: `${assetPrefix}-Windows.msi` };
    case 'macosDmg':
      return { label: 'macOS disk image', name: `${assetPrefix}-macOS.dmg` };
    default:
      return null;
  }
}

function buildUploadPlan({ artifacts, config, version, shortSha, runAttempt, runNumber }) {
  const buildId = `${version}-${shortSha}-r${runNumber}-a${runAttempt}`;
  const sortedArtifacts = [...artifacts].sort((left, right) =>
    `${left.platform}:${left.originalPath}`.localeCompare(`${right.platform}:${right.originalPath}`),
  );
  const primaryArtifacts = findPrimaryArtifacts(sortedArtifacts);
  const primaryKindsBySourcePath = new Map(
    [...primaryArtifacts.entries()].map(([kind, artifact]) => [artifact.sourcePath, kind]),
  );
  const releaseAssetNames = new Set();

  const uploadPlan = sortedArtifacts
    .map((artifact) => {
      const primaryKind = primaryKindsBySourcePath.get(artifact.sourcePath);
      const assetName = releaseAssetName({
        artifact,
        assetPrefix: config.assetPrefix,
        buildId,
        primaryKind,
      });

      if (releaseAssetNames.has(assetName)) {
        throw new Error(`Two release artifacts would use the same release-asset name: ${assetName}`);
      }

      releaseAssetNames.add(assetName);
      return { ...artifact, assetName, primaryKind };
    })
    .sort((left, right) => `${left.platform}:${left.assetName}`.localeCompare(`${right.platform}:${right.assetName}`));

  return uploadPlan;
}

function assertStableDownloadsForRequestedPlatforms(uploadPlan, releasePlatforms) {
  const missingPlatforms = releasePlatforms.filter(
    (platformConfig) => !uploadPlan.some((asset) => asset.platform === platformConfig.id && asset.primaryKind),
  );

  if (missingPlatforms.length > 0) {
    throw new Error(
      `No primary release download was produced for ${missingPlatforms
        .map((platformConfig) => platformConfig.displayName)
        .join(', ')}.`,
    );
  }
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'rivet2-desktop-release-publisher',
  };
}

async function githubRequest({ token, url, options = {}, acceptedStatuses = [] }) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...githubHeaders(token),
      ...options.headers,
    },
  });

  if (response.ok || acceptedStatuses.includes(response.status)) {
    return response;
  }

  const responseBody = await response.text();
  throw new Error(
    `${options.method ?? 'GET'} ${url} failed: ${response.status} ${response.statusText}\n${responseBody.slice(0, 20_000)}`,
  );
}

async function getReleaseByTag({ token, owner, repo, tag }) {
  const response = await githubRequest({
    token,
    url: `${apiBaseUrl}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    acceptedStatuses: [404],
  });

  return response.status === 404 ? null : response.json();
}

function releaseDescription(config) {
  return [
    `Rolling ${config.displayName.toLowerCase()} desktop-download feed for Rivet.`,
    '',
    'This release is an asset container for the documentation download page. The current source commit and workflow run are recorded in the published feed metadata.',
  ].join('\n');
}

async function getOrCreateRelease({ token, owner, repo, config }) {
  const name = `Rivet 2 ${config.displayName} desktop download feed`;
  const existing = await getReleaseByTag({ token, owner, repo, tag: config.tag });

  if (existing) {
    return existing;
  }

  const releaseTarget = requiredEnvironment('RELEASE_TARGET_COMMITISH');
  const response = await githubRequest({
    token,
    url: `${apiBaseUrl}/repos/${owner}/${repo}/releases`,
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: config.tag,
        target_commitish: releaseTarget,
        name,
        body: releaseDescription(config),
        draft: false,
        prerelease: config.prerelease,
        generate_release_notes: false,
        make_latest: 'false',
      }),
    },
  });

  return response.json();
}

async function listReleaseAssets({ token, owner, repo, releaseId }) {
  const assets = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(`${apiBaseUrl}/repos/${owner}/${repo}/releases/${releaseId}/assets`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await githubRequest({ token, url });
    const nextAssets = await response.json();
    assets.push(...nextAssets);

    if (nextAssets.length < 100) {
      return assets;
    }
  }
}

async function uploadReleaseAsset({ token, owner, repo, releaseId, asset }) {
  const url = new URL(`${uploadBaseUrl}/repos/${owner}/${repo}/releases/${releaseId}/assets`);
  url.searchParams.set('name', asset.assetName);
  url.searchParams.set('label', asset.originalPath);
  const source = createReadStream(asset.sourcePath);

  try {
    const response = await githubRequest({
      token,
      url,
      options: {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          'content-length': String(asset.size),
          'content-type': 'application/octet-stream',
        },
        body: source,
        duplex: 'half',
      },
    });

    return response.json();
  } finally {
    source.destroy();
  }
}

async function uploadCurrentAssets({ token, owner, repo, releaseId, uploadPlan }) {
  const existingAssets = await listReleaseAssets({ token, owner, repo, releaseId });
  const existingByName = new Map(existingAssets.map((asset) => [asset.name, asset]));
  const uploadedAssetsByName = new Map();

  for (const asset of uploadPlan) {
    const existing = existingByName.get(asset.assetName);

    if (existing) {
      throw new Error(
        `Release asset ${asset.assetName} already exists. Each workflow attempt must publish a distinct asset name; check the run number and attempt inputs before retrying.`,
      );
    }

    console.log(`Uploading ${asset.assetName}.`);
    const uploaded = await uploadReleaseAsset({ token, owner, repo, releaseId, asset });
    uploadedAssetsByName.set(asset.assetName, uploaded);
  }

  return uploadedAssetsByName;
}

function createReleaseAssetManifest({ assetPrefix, channel, release, uploadPlan, uploadedAssetsByName, version }) {
  const artifacts = uploadPlan.map(({ sourcePath: _sourcePath, assetName, primaryKind: _primaryKind, ...artifact }) => {
    const uploaded = uploadedAssetsByName.get(assetName);

    if (!uploaded?.browser_download_url) {
      throw new Error(`GitHub did not return a browser download URL for ${assetName}.`);
    }

    return { ...artifact, name: uploaded.name, url: uploaded.browser_download_url };
  });

  const stableDownloads = uploadPlan.flatMap((asset) => {
    const details = stableDownloadDetails(asset.primaryKind, assetPrefix);

    if (!details) {
      return [];
    }

    const uploaded = uploadedAssetsByName.get(asset.assetName);

    if (!uploaded?.browser_download_url) {
      throw new Error(`GitHub did not return a browser download URL for ${asset.assetName}.`);
    }

    return [
      {
        label: details.label,
        name: details.name,
        platform: asset.platform,
        url: uploaded.browser_download_url,
        size: asset.size,
      },
    ];
  });

  return {
    version: 1,
    channel,
    desktopVersion: version,
    release: {
      id: release.id,
      tag: release.tag_name,
      url: release.html_url,
    },
    stableDownloads,
    artifacts,
  };
}

async function main() {
  const releaseChannel = process.env.RELEASE_CHANNEL ?? 'developer';
  const releaseConfig = releaseConfigs[releaseChannel];

  if (!releaseConfig) {
    throw new Error(`Unsupported RELEASE_CHANNEL: ${releaseChannel}`);
  }

  const config = releaseConfig;

  const token = requiredEnvironment('GITHUB_TOKEN');
  const { owner, repo } = parseRepository();
  const manifestPath = path.resolve(repoRoot, process.env.RELEASE_ASSETS_MANIFEST_PATH ?? 'release-assets-manifest.json');

  const releasePlatforms = parseReleasePlatforms();
  const version = await readAppVersion();
  const commit = requiredEnvironment('GITHUB_SHA');
  const shortSha = commit.slice(0, 7);
  const uploadPlan = buildUploadPlan({
    artifacts: (await Promise.all(releasePlatforms.map((platform) => collectPlatformArtifacts(platform)))).flat(),
    config,
    version,
    shortSha,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
    runNumber: process.env.GITHUB_RUN_NUMBER ?? 'local',
  });
  assertStableDownloadsForRequestedPlatforms(uploadPlan, releasePlatforms);

  const release = await getOrCreateRelease({
    token,
    owner,
    repo,
    config,
  });
  const uploadedAssetsByName = await uploadCurrentAssets({
    token,
    owner,
    repo,
    releaseId: release.id,
    uploadPlan,
  });
  const manifest = createReleaseAssetManifest({
    assetPrefix: config.assetPrefix,
    channel: releaseChannel,
    release,
    uploadPlan,
    uploadedAssetsByName,
    version,
  });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Published ${uploadPlan.length} asset(s) to ${release.html_url}.`);
  console.log(`Wrote release asset manifest to ${manifestPath}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  buildUploadPlan,
  createReleaseAssetManifest,
  findPrimaryArtifacts,
  releaseAssetName,
  sanitizeAssetSegment,
};
