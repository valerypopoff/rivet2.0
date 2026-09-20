import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const targetSpecs = [
  { key: 'darwin-aarch64', extension: '.app.tar.gz', architecture: 'aarch64' },
  { key: 'darwin-x86_64', extension: '.app.tar.gz', architecture: 'x86_64' },
  { key: 'windows-x86_64', extension: '.msi.zip', architecture: 'x86_64' },
  { key: 'linux-x86_64', extension: '.AppImage.tar.gz', architecture: 'x86_64' },
  { key: 'linux-aarch64', extension: '.AppImage.tar.gz', architecture: 'aarch64' },
];

function parseRepository(repository) {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  return { owner, repo };
}

function createGithubRequest(headers) {
  return async function githubRequest(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...options.headers },
    });

    if (!response.ok) {
      throw new Error(
        `${options.method ?? 'GET'} ${url} failed: ${response.status} ${response.statusText}\n${await response.text()}`,
      );
    }

    return response;
  };
}

async function appVersion() {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'packages', 'app', 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Could not determine the desktop application version.');
  }
  return packageJson.version;
}

function findUniqueAsset(assets, description, predicate) {
  const matches = assets.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description}; found ${matches.length}: ${matches.map((asset) => asset.name).join(', ')}`);
  }
  return matches[0];
}

function updaterAssetMatches(asset, { extension, architecture }) {
  if (!asset.name.endsWith(extension)) return false;
  const name = asset.name.toLowerCase();
  return architecture === 'aarch64' ? name.includes('aarch64') : name.includes('x64') || name.includes('x86_64') || name.includes('amd64');
}

async function signatureForAsset(githubRequest, asset, assets) {
  const signatureAsset = findUniqueAsset(assets, `signature for ${asset.name}`, (candidate) => candidate.name === `${asset.name}.sig`);
  return (await githubRequest(signatureAsset.url, { headers: { accept: 'application/octet-stream' } })).text();
}

async function replaceReleaseAsset({ assets, assetName, contents, read, remove, upload }) {
  const existingAssets = assets.filter((asset) => asset.name === assetName);
  if (existingAssets.length > 1) {
    throw new Error(`Expected at most one existing ${assetName}; found ${existingAssets.length}.`);
  }

  const existing = existingAssets[0];
  const previousContents = existing ? await read(existing) : undefined;

  if (existing) {
    await remove(existing);
  }

  try {
    await upload(assetName, contents);
  } catch (error) {
    if (!existing) {
      throw error;
    }

    try {
      await upload(assetName, previousContents);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Could not replace ${assetName} and could not restore the previous release asset.`,
      );
    }

    throw new Error(`Could not replace ${assetName}; restored the previous release asset.`, { cause: error });
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!token || !repository) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required to publish the updater manifest.');
  }

  const { owner, repo } = parseRepository(repository);
  const githubRequest = createGithubRequest({
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'rivet2-updater-manifest-publisher',
  });
  const version = await appVersion();
  const tag = `app-v${version}`;
  const release = await (await githubRequest(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`)).json();
  const assets = release.assets;
  if (!Array.isArray(assets)) throw new Error(`Release ${tag} did not return its asset list.`);

  const platforms = {};
  for (const spec of targetSpecs) {
    const asset = findUniqueAsset(assets, `${spec.key} updater archive`, (candidate) => updaterAssetMatches(candidate, spec));
    platforms[spec.key] = {
      signature: (await signatureForAsset(githubRequest, asset, assets)).trim(),
      url: asset.browser_download_url,
    };
  }

  const manifest = {
    version,
    notes: `Rivet 2 v${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
  const uploadUrl = new URL(`https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets`);
  await replaceReleaseAsset({
    assets,
    assetName: 'latest.json',
    contents: JSON.stringify(manifest, null, 2),
    read: async (asset) =>
      (await githubRequest(asset.url, { headers: { accept: 'application/octet-stream' } })).text(),
    remove: async (asset) => githubRequest(asset.url, { method: 'DELETE' }),
    upload: async (assetName, contents) => {
      const assetUploadUrl = new URL(uploadUrl);
      assetUploadUrl.searchParams.set('name', assetName);
      await githubRequest(assetUploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: contents,
      });
    },
  });
  console.log(`Published architecture-specific updater manifest for ${tag}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { findUniqueAsset, parseRepository, replaceReleaseAsset, targetSpecs, updaterAssetMatches };
