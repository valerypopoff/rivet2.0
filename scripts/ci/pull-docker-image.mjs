import { pullImageWithRetry } from '../../deploy/studio-server/scripts/lib/docker-image-pull.mjs';
import { runArgsCapture } from '../../deploy/studio-server/scripts/lib/docker-launcher.mjs';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/ci/pull-docker-image.mjs <image>');

await pullImageWithRetry(image, (reference) =>
  runArgsCapture('docker', ['pull', '--', reference], process.env, { streamOutput: true }),
);
