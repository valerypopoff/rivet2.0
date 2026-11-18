/** Reserved host-only documents; never valid project save destinations. */
export const COMPARISON_INSPECTION_PREFIX = 'bundle-comparison:';
export const isComparisonInspectionProject = (id: string) => id.startsWith(COMPARISON_INSPECTION_PREFIX);
export const isPublishedHistoryInspection = (id: string | null | undefined) =>
  id?.startsWith('published-version-preview:') === true;

export const isDetachedInspectionProject = (id: string) =>
  isComparisonInspectionProject(id) || isPublishedHistoryInspection(id);
