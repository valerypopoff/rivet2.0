import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
} from '@floating-ui/react';
import { useEffect, useRef, useState } from 'react';

export function RecordingRunActions({
  disabled,
  diagnosticsVisible,
  onToggleDiagnostics,
  onDelete,
}: {
  disabled: boolean;
  diagnosticsVisible: boolean;
  onToggleDiagnostics(): void;
  onDelete(): void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const listRef = useRef<Array<HTMLButtonElement | null>>([]);
  const { context, refs, floatingStyles } = useFloating({
    open: isOpen && !disabled,
    onOpenChange: setIsOpen,
    placement: 'top-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const navigation = useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, loop: true });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([click, dismiss, role, navigation]);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  return (
    <>
      <button
        type="button"
        ref={refs.setReference}
        className="run-recordings-actions-trigger"
        aria-label="Recording actions"
        disabled={disabled}
        {...getReferenceProps()}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="9" r="1.5" />
          <circle cx="9" cy="9" r="1.5" />
          <circle cx="15" cy="9" r="1.5" />
        </svg>
      </button>
      {isOpen && !disabled ? (
        <FloatingPortal root={refs.domReference.current?.closest<HTMLElement>('[role="dialog"]')}>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              className="run-recordings-actions-menu"
              aria-label="Recording actions"
              {...getFloatingProps()}
            >
              <button
                type="button"
                role="menuitem"
                ref={(element) => {
                  listRef.current[0] = element;
                }}
                tabIndex={activeIndex === 0 ? 0 : -1}
                {...getItemProps({
                  onClick: () => {
                    setIsOpen(false);
                    onToggleDiagnostics();
                  },
                })}
              >
                {diagnosticsVisible ? 'Hide diagnostic details' : 'Show diagnostic details'}
              </button>
              <div role="separator" />
              <button
                type="button"
                role="menuitem"
                className="run-recordings-actions-delete"
                ref={(element) => {
                  listRef.current[1] = element;
                }}
                tabIndex={activeIndex === 1 ? 0 : -1}
                {...getItemProps({
                  onClick: () => {
                    setIsOpen(false);
                    onDelete();
                  },
                })}
              >
                Delete
              </button>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  );
}
