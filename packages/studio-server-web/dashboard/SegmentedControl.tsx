import type { AriaRole, ButtonHTMLAttributes, ReactNode } from 'react';

import './SegmentedControl.css';

export function SegmentedControl({
  children,
  className,
  label,
  role = 'group',
}: {
  children: ReactNode;
  className?: string;
  label: string;
  role?: AriaRole;
}) {
  return (
    <div className={`segmented-control${className ? ` ${className}` : ''}`} role={role} aria-label={label}>
      {children}
    </div>
  );
}

export function SegmentedControlButton({
  children,
  className,
  isLoading = false,
  role,
  selected,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  isLoading?: boolean;
  selected: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      role={role}
      aria-busy={isLoading || props['aria-busy']}
      aria-pressed={role === 'tab' ? undefined : selected}
      className={`segmented-control-button${selected ? ' is-selected' : ''}${isLoading ? ' is-loading' : ''}${className ? ` ${className}` : ''}`}
    >
      {isLoading ? <span className="segmented-control-loading-label">{children}</span> : children}
      {isLoading ? <span className="segmented-control-spinner" aria-hidden="true" /> : null}
    </button>
  );
}
