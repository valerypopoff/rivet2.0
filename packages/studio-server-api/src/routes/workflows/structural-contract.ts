import { z } from 'zod';
import type { StructuralMutation } from '../../../../studio-server-shared/workflow-mutation-contract.js';
import { createHttpError } from '../../utils/httpError.js';

export const structuralMutationSchema = z
  .object({
    operationId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    expectedSource: z
      .object({
        id: z.string().min(1).max(256),
        revisionId: z.string().max(256).nullable().optional(),
        publicationVersion: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
    expectedDestinationId: z.string().uuid().nullable().optional(),
    expectedDestinationPath: z.string().max(4096).optional(),
  })
  .strict();

export function requireStructuralMutation(
  input: unknown,
  request: { get(name: string): string | undefined },
): StructuralMutation {
  if (
    request.get('Sec-Fetch-Site') === 'cross-site' ||
    (request.get('X-Rivet-Namespace-Intent') !== '1' && request.get('X-Rivet-Bundle-Intent') !== '1')
  )
    throw createHttpError(403, 'Structural changes require explicit UI intent.');
  if (input === undefined)
    throw createHttpError(428, 'Refresh Rivet before changing projects or folders. A guarded operation is required.');
  const parsed = structuralMutationSchema.safeParse(input);
  if (!parsed.success) throw createHttpError(400, 'Invalid structural mutation admission.');
  return parsed.data;
}
