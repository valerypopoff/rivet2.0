import { assertMutationAdmission, type CapturedReceipt } from './namespace-receipts.js';
import type { RevisionRow, TransactionHooks } from './types.js';
import type { ManagedWorkflowContext } from './context.js';

type Factory = Pick<ManagedWorkflowContext['revisions'], 'createRevision' | 'discardPreparedRevision'>;

function report(message: string, revisionId?: string) {
  try {
    console.error(message, revisionId ?? '');
  } catch {
    /* Diagnostics must not change the persistence outcome. */
  }
}

/** Sequential, operation-local ownership. No SQL clients, retries or direct deletes. */
export function createPreparedRevisions(factory: Factory, admission?: CapturedReceipt) {
  const rows = new Map<RevisionRow, boolean>();
  let pending: Promise<RevisionRow> | undefined;
  let closing: Promise<void> | undefined;
  let uncertain = false;
  return {
    async prepare(...args: Parameters<Factory['createRevision']>): Promise<RevisionRow> {
      if (closing || pending) throw new Error('Preparation is closed or already active.');
      if (admission) assertMutationAdmission(admission);
      const task = factory.createRevision(...args).then((row) => {
        rows.set(row, false);
        return row;
      });
      pending = task;
      try {
        return await task;
      } finally {
        pending = undefined;
      }
    },
    observe(hooks: TransactionHooks) {
      uncertain = true;
      hooks?.onSettled?.((outcome) => {
        uncertain = outcome === 'unknown';
      });
    },
    stage(row: RevisionRow, hooks: TransactionHooks) {
      if (!rows.has(row) || closing) throw new Error('Revision is not owned by this preparation scope.');
      hooks.onCommit(async () => {
        rows.set(row, true);
      });
    },
    close(): Promise<void> {
      if (!closing)
        closing = (async () => {
          await pending?.catch(() => undefined);
          for (const [row, attached] of rows) {
            if (attached) continue;
            if (uncertain) {
              report(
                '[managed-workflows] Retaining a prepared revision after an unresolved transaction:',
                row.revision_id,
              );
              continue;
            }
            try {
              await factory.discardPreparedRevision(row);
            } catch {
              report(
                '[managed-workflows] Could not queue unused preparation; retained for reconciliation.',
                row.revision_id,
              );
            }
          }
          rows.clear();
        })();
      return closing;
    },
  };
}
export type PreparedRevisions = ReturnType<typeof createPreparedRevisions>;
