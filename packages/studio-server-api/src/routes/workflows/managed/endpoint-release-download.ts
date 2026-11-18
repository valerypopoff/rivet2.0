import { ZipFile } from 'yazl';
import { createHttpError } from '../../../utils/httpError.js';
import type { ManagedWorkflowContext } from './context.js';
import { loadEndpointReleaseArtifacts, type StoredEndpointRelease } from './endpoint-release-reader.js';

let activeDownloads = 0;

export async function downloadEndpointRelease(
  context: Pick<ManagedWorkflowContext, 'blobStore'>,
  release: StoredEndpointRelease,
  endpointName: string,
  publishedAt: string,
): Promise<Buffer> {
  if (activeDownloads >= 2)
    throw createHttpError(429, 'Two revision downloads are already in progress. Try again shortly.');
  activeDownloads++;
  try {
    const { contents } = await loadEndpointReleaseArtifacts(context, release);
    const archive = new ZipFile();
    const projects = release.manifest.projects.map((artifact, index) => {
      const saved = contents.get(artifact.artifactId)!;
      const base = `projects/${index + 1}`;
      const projectFile = `${base}.rivet-project`;
      const datasetsFile = saved.datasetsContents === null ? null : `${base}.rivet-data`;
      archive.addBuffer(Buffer.from(saved.contents), projectFile);
      if (datasetsFile) archive.addBuffer(Buffer.from(saved.datasetsContents!), datasetsFile);
      return { ...artifact, projectFile, datasetsFile };
    });
    archive.addBuffer(
      Buffer.from(
        JSON.stringify(
          {
            ...release.manifest,
            projects,
            endpointName,
            publishedAt,
            capturedAt: release.capturedAt,
          },
          null,
          2,
        ),
      ),
      'published-revision.json',
    );
    archive.end();
    const chunks: Buffer[] = [];
    for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally {
    activeDownloads--;
  }
}
