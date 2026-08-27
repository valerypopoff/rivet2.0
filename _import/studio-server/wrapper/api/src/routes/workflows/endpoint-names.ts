import { badRequest } from '../../utils/httpError.js';

export function normalizeStoredEndpointName(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return '';
  }

  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(trimmed)) {
    throw badRequest('Endpoint name must contain only letters, numbers, and hyphens');
  }

  return trimmed;
}

export function normalizeWorkflowEndpointLookupName(value: string): string {
  return normalizeStoredEndpointName(value).toLowerCase();
}
