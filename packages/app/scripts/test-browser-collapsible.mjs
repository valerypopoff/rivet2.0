import { createElement, forwardRef } from 'react';

// Vite consumes react-collapsible through its browser-friendly interop path.
// Node's native ESM loader sees its CommonJS namespace instead, so component
// tests get an object where production gets a component. This deliberately
// small adapter keeps the public interaction and DOM contract the app uses.
export default forwardRef(function TestBrowserCollapsible({
  children,
  handleTriggerClick,
  open = false,
  trigger,
  triggerClassName,
  triggerOpenedClassName,
  triggerWhenOpen,
}, ref) {
  const triggerContent = open && triggerWhenOpen !== undefined ? triggerWhenOpen : trigger;
  return createElement(
    'div',
    { className: 'Collapsible', ref },
    createElement(
      'div',
      {
        className: open ? triggerOpenedClassName : triggerClassName,
        onClick: handleTriggerClick,
      },
      triggerContent,
    ),
    open ? createElement('div', { className: 'Collapsible__contentOuter' }, children) : null,
  );
});
