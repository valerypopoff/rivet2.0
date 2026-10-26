import type { WorkflowNamespaceMutation } from '../../../../../studio-server-shared/workflow-namespace-types.js';
import { conflict } from '../../../utils/httpError.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import { createManagedCatalogMutations } from './catalog-mutations.js';
import type { ManagedWorkflowContext } from './context.js';
import { captureOperation, recoverCapturedReceipt, withMutationReceipt } from './namespace-receipts.js';
import { withCatalogTransaction } from './structural-admission.js';

export async function recoverManagedNamespace(context: ManagedWorkflowContext, request: WorkflowNamespaceMutation) {
  const captured = captureOperation(
    request,
    (input) => input,
    (input) => input,
  );
  await context.initialize();
  return recoverCapturedReceipt(context.pool, captured.admission!);
}

/** One transaction owns admission, identity checks, write and its recovery receipt.
 * Reuse the catalog's SQL implementation inside this transaction, never start a
 * nested transaction/connection while holding the topology lease. */
export async function mutateManagedNamespace(context: ManagedWorkflowContext, request: WorkflowNamespaceMutation) {
  const captured = captureOperation(
    request,
    (input) => input,
    (input) => input,
  );
  request = captured.input;
  const command = request.command;
  const sourcePath = normalizeManagedWorkflowRelativePath(command.relativePath, {
    allowProjectFile: command.itemType === 'project',
  });
  const destination =
    command.kind === 'move'
      ? normalizeManagedWorkflowRelativePath(command.destinationRelativePath, {
          allowProjectFile: false,
          allowEmpty: true,
        })
      : '';
  return withCatalogTransaction(context, async (tx) => {
    const { client } = tx;
    return withMutationReceipt(tx, captured.admission, async () => {
      if (command.itemType === 'project') {
        const source = await context.queries.getWorkflowByRelativePath(client, sourcePath, { forUpdate: true });
        if (!source || source.workflow_id !== request.expectedSource.id)
          throw conflict('The selected project was moved, replaced or deleted. Refresh the library.');
        if (
          command.kind === 'delete' &&
          (!request.expectedSource.revisionId || source.current_draft_revision_id !== request.expectedSource.revisionId)
        )
          throw conflict('The project changed after deletion was confirmed. Refresh and review it again.');
      } else {
        const source = await client.query<{ namespace_id: string; bundle_id: string | null }>(
          'SELECT namespace_id,bundle_id FROM workflow_folders WHERE relative_path=$1 FOR UPDATE',
          [sourcePath],
        );
        if (source.rows[0]?.namespace_id !== request.expectedSource.id)
          throw conflict('The selected folder was moved, replaced or deleted. Refresh the library.');
        if (command.kind === 'delete' && source.rows[0]?.bundle_id)
          throw conflict('Use Delete bundle and confirm its name before deleting a bundle.');
      }
      if (command.kind === 'move') {
        if (destination === '') {
          if (request.expectedDestinationId !== null) throw conflict('Refresh the destination before moving.');
        } else {
          const target = await client.query<{ namespace_id: string }>(
            'SELECT namespace_id FROM workflow_folders WHERE relative_path=$1 FOR KEY SHARE',
            [destination],
          );
          if (!request.expectedDestinationId || target.rows[0]?.namespace_id !== request.expectedDestinationId)
            throw conflict('The destination folder was moved, replaced or deleted. Refresh the library.');
        }
      }
      return createManagedCatalogMutations(context)(tx, command);
    });
  });
}
