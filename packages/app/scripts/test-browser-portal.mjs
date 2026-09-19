import { createElement, forwardRef } from 'react';

export default forwardRef(function TestBrowserPortal({ children }, ref) {
  return createElement('div', { ref, style: { display: 'contents' } }, children ?? null);
});
