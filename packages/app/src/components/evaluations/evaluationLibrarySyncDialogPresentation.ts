import type { EvaluationLibraryConflictDraft, EvaluationLibrarySyncIssue } from '@valerypopoff/rivet2-evaluations';

type EvaluationLibraryConflictPresentation = {
  canKeepMineAsCopy: boolean;
  draft: EvaluationLibraryConflictDraft;
  description: string;
  localTitle: string;
  serverTitle: string;
};

export type EvaluationLibrarySyncDialogPresentation = {
  title: string;
  message?: string;
  conflict?: EvaluationLibraryConflictPresentation;
};

function resourceTitle(conflict: EvaluationLibraryConflictDraft, source: 'local' | 'server'): string {
  const resource = conflict[source];
  if (resource.value === undefined) return 'Deleted';
  return resource.kind === 'suite'
    ? resource.value.suite.name || 'Untitled evaluation suite'
    : resource.value.name || 'Untitled evaluation dataset';
}

export function getEvaluationLibrarySyncDialogPresentation(
  issue: EvaluationLibrarySyncIssue | undefined,
): EvaluationLibrarySyncDialogPresentation | undefined {
  if (issue === undefined) return undefined;

  const conflict = issue.kind === 'conflict' ? issue.conflicts[0] : undefined;
  if (conflict === undefined) {
    return {
      title: 'Evaluation library save needs attention',
      message: issue.message + ' Your pending changes remain in this browser until you retry the save.',
    };
  }

  const serverTitle = resourceTitle(conflict, 'server');
  return {
    title: 'Resolve shared evaluation conflict',
    conflict: {
      canKeepMineAsCopy: conflict.local.value !== undefined,
      draft: conflict,
      description:
        'The ' +
        conflict.kind +
        ' “' +
        serverTitle +
        '” was changed by another browser after your edit began. Choose which version to retain; Rivet will never overwrite the other editor automatically.',
      localTitle: resourceTitle(conflict, 'local'),
      serverTitle,
    },
  };
}
