import { createElement, forwardRef } from 'react';

export default forwardRef(function TestBrowserIcon(props, ref) {
  return createElement('span', { ...props, ref, 'data-test-browser-icon': true });
});
