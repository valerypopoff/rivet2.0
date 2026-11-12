/** Reserved host-only documents; never valid project save destinations. */
export const COMPARISON_INSPECTION_PREFIX = 'bundle-comparison:';
export const isComparisonInspectionProject = (id: string) => id.startsWith(COMPARISON_INSPECTION_PREFIX);
