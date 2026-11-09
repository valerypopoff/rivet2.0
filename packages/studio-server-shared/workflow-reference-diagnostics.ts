export type WorkflowReferenceIncompleteReason =
  | 'missing-summary'
  | 'outdated-summary'
  | 'invalid-summary'
  | 'result-limit';

export function describeReferenceCoverage(result: {
  checkedProjects?: number;
  totalProjects?: number;
  incompleteReasons?: WorkflowReferenceIncompleteReason[];
}): string {
  const messages: string[] = [];
  if (Number.isSafeInteger(result.checkedProjects) && Number.isSafeInteger(result.totalProjects))
    messages.push(`${result.checkedProjects} of ${result.totalProjects} other projects checked.`);
  if (result.incompleteReasons?.some((reason) => reason === 'missing-summary' || reason === 'outdated-summary'))
    messages.push('Some saved projects are still awaiting reference indexing.');
  if (result.incompleteReasons?.includes('invalid-summary')) messages.push('Some saved projects could not be checked.');
  if (result.incompleteReasons?.includes('result-limit'))
    messages.push('The reference list is too large to show in full.');
  return messages.join(' ');
}
