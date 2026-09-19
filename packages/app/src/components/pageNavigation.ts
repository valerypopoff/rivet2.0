export type PageNavigationDirection = 'previous' | 'next';

export function isPageBoundaryModifierClick(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey;
}

export function getPagedPageIndex(options: {
  currentPage: number;
  pageCount: number;
  direction: PageNavigationDirection;
  jumpToBoundary: boolean;
}): number {
  const lastPage = Math.max(0, options.pageCount - 1);
  if (options.jumpToBoundary) {
    return options.direction === 'previous' ? 0 : lastPage;
  }

  const currentPage = Math.min(lastPage, Math.max(0, options.currentPage));

  return options.direction === 'previous'
    ? Math.max(0, currentPage - 1)
    : Math.min(lastPage, currentPage + 1);
}
