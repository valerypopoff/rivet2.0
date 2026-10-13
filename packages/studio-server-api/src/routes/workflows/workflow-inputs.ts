import { badRequest } from '../../utils/httpError.js';

export function normalizeWorkflowRelativePath(
  value: unknown,
  options: {
    allowProjectFile: boolean;
    allowEmpty?: boolean;
  },
): string {
  if (typeof value !== 'string') {
    if (options.allowEmpty && value == null) return '';
    throw badRequest('Missing relativePath');
  }
  const normalized = value
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    if (options.allowEmpty) return '';
    throw badRequest('Missing relativePath');
  }
  if (
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))
  )
    throw badRequest('Invalid relativePath');
  if (!options.allowProjectFile && normalized.endsWith('.rivet-project'))
    throw badRequest('Expected folder path, received project path');
  return normalized;
}
