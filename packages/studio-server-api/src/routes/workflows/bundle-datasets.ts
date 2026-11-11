import { deserializeDatasets } from '@valerypopoff/rivet2-node';
import { badRequest } from '../../utils/httpError.js';

/** Shared by portable import and merge; never silently combine dataset snapshots. */
export function parseBundleDatasets(contents: string | null, projectId: string) {
  if (contents === null) return null;
  let datasets: ReturnType<typeof deserializeDatasets>;
  try {
    datasets = deserializeDatasets(contents);
  } catch {
    throw badRequest('Invalid bundle datasets.');
  }
  if (!Array.isArray(datasets)) throw badRequest('Invalid bundle datasets.');
  const ids = new Set<string>();
  for (const dataset of datasets) {
    if (
      !dataset?.meta ||
      !dataset.data ||
      typeof dataset.meta.id !== 'string' ||
      !dataset.meta.id ||
      dataset.meta.projectId !== projectId ||
      typeof dataset.meta.name !== 'string' ||
      dataset.data.id !== dataset.meta.id ||
      !Array.isArray(dataset.data.rows)
    )
      throw badRequest('Invalid bundle dataset metadata or rows.');
    if (ids.has(dataset.meta.id)) throw badRequest('Bundle contains duplicate dataset IDs.');
    ids.add(dataset.meta.id);
    const rows = new Set<string>();
    for (const row of dataset.data.rows) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !Array.isArray(row.data) ||
        row.data.some((value) => typeof value !== 'string') ||
        (row.embedding !== undefined &&
          (!Array.isArray(row.embedding) ||
            row.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))))
      )
        throw badRequest('Invalid bundle dataset row or embedding.');
      if (rows.has(row.id)) throw badRequest('Bundle contains duplicate dataset row IDs.');
      rows.add(row.id);
    }
  }
  return datasets;
}
