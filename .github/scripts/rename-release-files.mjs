// Renames release files to remove version numbers from filenames so the latest
// installer assets have stable download URLs.

const { GITHUB_TOKEN, GITHUB_RELEASE_ID } = process.env;

if (GITHUB_TOKEN == null || GITHUB_RELEASE_ID == null) {
  throw new Error('GITHUB_TOKEN and GITHUB_RELEASE_ID must be set');
}

const [owner = 'valerypopoff', repo = 'rivet2.0'] = (process.env.GITHUB_REPOSITORY ?? 'valerypopoff/rivet2.0').split(
  '/',
);

const apiBaseUrl = 'https://api.github.com';
const uploadBaseUrl = 'https://uploads.github.com';
const githubHeaders = {
  authorization: `Bearer ${GITHUB_TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'rivet2-release-asset-renamer',
};

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...githubHeaders,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${options.method ?? 'GET'} ${url} failed: ${response.status} ${response.statusText}\n${body}`);
  }

  return response;
}

async function listReleaseAssets() {
  const assets = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(`${apiBaseUrl}/repos/${owner}/${repo}/releases/${GITHUB_RELEASE_ID}/assets`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));

    const response = await githubRequest(url);
    const pageAssets = await response.json();
    assets.push(...pageAssets);

    if (pageAssets.length < 100) {
      break;
    }
  }

  return assets;
}

async function downloadReleaseAsset(asset) {
  const response = await githubRequest(asset.url, {
    headers: {
      accept: 'application/octet-stream',
    },
  });

  return Buffer.from(await response.arrayBuffer());
}

async function deleteReleaseAsset(asset) {
  await githubRequest(`${apiBaseUrl}/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
    method: 'DELETE',
  });
}

async function uploadReleaseAsset({ name, data }) {
  const url = new URL(`${uploadBaseUrl}/repos/${owner}/${repo}/releases/${GITHUB_RELEASE_ID}/assets`);
  url.searchParams.set('name', name);

  const response = await githubRequest(url, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      'content-length': String(data.length),
      'content-type': 'application/octet-stream',
    },
    body: data,
  });

  return response.json();
}

const assets = await listReleaseAssets();
const currentAssetsByName = new Map(assets.map((asset) => [asset.name, asset]));
const uploadFailures = [];

for (const asset of assets) {
  const file = asset.name;

  if (!/[Rr]ivet_.*_(universal\.dmg|aarch64\.dmg|x64\.dmg|x86_64\.dmg|amd64\.AppImage|amd64\.deb|x64-setup.exe)$/.test(file)) {
    continue;
  }

  console.log(`Downloading ${file}...`);
  const assetData = await downloadReleaseAsset(asset);

  let newFileName = `Rivet-2.${file.split('.').pop()}`;

  if (/aarch64\.dmg$/i.test(file)) {
    newFileName = 'Rivet-2-Apple-Silicon.dmg';
  } else if (/(x64|x86_64)\.dmg$/i.test(file)) {
    newFileName = 'Rivet-2-Intel.dmg';
  }

  if (/x64-setup\.exe$/i.test(file)) {
    newFileName = 'Rivet-2-Setup.exe';
  }

  console.log(`Renamed ${file} to ${newFileName}`);

  const existingWithName = currentAssetsByName.get(newFileName);
  if (existingWithName) {
    console.log(`Deleting existing asset ${newFileName}...`);
    await deleteReleaseAsset(existingWithName);
    currentAssetsByName.delete(newFileName);
  }

  try {
    console.log(`Uploading ${newFileName}...`);
    const uploadedAsset = await uploadReleaseAsset({
      name: newFileName,
      data: assetData,
    });
    currentAssetsByName.set(uploadedAsset.name, uploadedAsset);
  } catch (error) {
    const message = `Failed to upload asset ${newFileName}: ${error instanceof Error ? error.message : String(error)}`;
    uploadFailures.push(message);
    console.error(message);
  }
}

if (uploadFailures.length > 0) {
  throw new Error(`Failed to upload ${uploadFailures.length} renamed release asset(s):\n${uploadFailures.join('\n')}`);
}
