// The current chart runs API and executor from one API image. The standalone
// executor image is only present in a rendered predecessor-compatibility pod.
export function assertCandidateManifestImages(manifest, images, runnerName) {
  const deployedImages = [...manifest.matchAll(/^\s*image:\s*["']?([^\s"']+)/gmu)].map((match) => match[1]);
  for (const [component, image] of Object.entries(images)) {
    const expected = `${image.repository}@${image.digest}`;
    const componentImages = deployedImages.filter(
      (reference) => reference.startsWith(`${image.repository}@`) || reference.startsWith(`${image.repository}:`),
    );
    if (component === 'executor' && componentImages.length === 0) continue;
    if (!componentImages.includes(expected) || componentImages.some((reference) => reference !== expected)) {
      throw new Error(`[${runnerName}] ${component} manifest did not use the immutable candidate digest`);
    }
  }
}
