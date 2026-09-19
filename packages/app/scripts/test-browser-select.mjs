import { createElement, forwardRef } from 'react';

// See the loader note for react-collapsible. The tests only rely on Select's
// accessible input and option-change contract, so retain those without
// reproducing Atlaskit's browser-only positioning and analytics layers.
export default forwardRef(function TestBrowserSelect({
  'aria-label': ariaLabel,
  instanceId,
  isDisabled = false,
  onChange,
  options = [],
  value,
}, ref) {
  const selectedValue = value?.value ?? '';
  return createElement('select', {
    'aria-label': ariaLabel,
    disabled: isDisabled,
    id: instanceId == null ? undefined : `react-select-${instanceId}-input`,
    onChange: (event) => {
      const selected = options.find((option) => option.value === event.target.value) ?? null;
      onChange?.(selected);
    },
    value: selectedValue,
    ref,
    children: options.map((option) => createElement('option', { key: option.value, value: option.value }, option.label)),
  });
});
