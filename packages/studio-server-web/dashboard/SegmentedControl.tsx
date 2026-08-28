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
  role,
  selected,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  selected: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      role={role}
      aria-pressed={role === 'tab' ? undefined : selected}
      className={`segmented-control-button${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}
