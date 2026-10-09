import { forwardRef, useCallback, type ComponentPropsWithoutRef } from 'react';
import FocusLock from 'react-focus-lock';

// Preserve the package's named API as well as its default component.
export * from 'react-focus-lock';

type FocusLockProps = ComponentPropsWithoutRef<typeof FocusLock>;

function isUnfocusedHostedDocument(document: Document): boolean {
  const window = document.defaultView;
  return !!window && window.parent !== window && !document.hasFocus();
}

/** An iframe modal owns its document, not the surrounding Server dashboard. */
export function canTrapHostedFocus(activeElement: HTMLElement, whiteList?: (element: HTMLElement) => boolean): boolean {
  if (isUnfocusedHostedDocument(activeElement.ownerDocument)) return false;
  return whiteList?.(activeElement) ?? true;
}

/** Closing a background editor dialog must not steal the host's current focus. */
export function getHostedReturnFocus(
  returnTo: Element,
  returnFocus: FocusLockProps['returnFocus'],
): boolean | FocusOptions {
  if (isUnfocusedHostedDocument(returnTo.ownerDocument)) return false;
  return (typeof returnFocus === 'function' ? returnFocus(returnTo) : returnFocus) ?? false;
}

const HostedFocusLock = forwardRef<HTMLElement, FocusLockProps>(function HostedFocusLock(
  { whiteList, returnFocus, ...props },
  ref,
) {
  const shouldHandleFocus = useCallback((element: HTMLElement) => canTrapHostedFocus(element, whiteList), [whiteList]);
  const shouldRestoreFocus = useCallback(
    (element: Element) => getHostedReturnFocus(element, returnFocus),
    [returnFocus],
  );
  return <FocusLock {...props} ref={ref} whiteList={shouldHandleFocus} returnFocus={shouldRestoreFocus} />;
});

export default HostedFocusLock;
