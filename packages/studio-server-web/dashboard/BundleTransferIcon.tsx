export function BundleTransferIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      className="workflow-project-context-menu-item-icon"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={direction === 'down' ? 'M7 3v13m-4-4 4 4 4-4' : 'M7 16V3m-4 4 4-4 4 4'} />
      <path d={direction === 'down' ? 'M17 6v13m-4-4 4 4 4-4' : 'M17 19V6m-4 4 4-4 4 4'} />
    </svg>
  );
}
