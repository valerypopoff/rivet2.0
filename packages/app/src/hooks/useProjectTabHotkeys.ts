import { useEffect } from 'react';
import { useUnrenderedValue } from './useUnrenderedValue.js';
import { installProjectTabHotkeyListener, type ProjectTabHotkeyState } from '../utils/projectTabHotkeys.js';
import type { ProjectTabListItem } from '../utils/openingProjectTabs.js';

export function useProjectTabHotkeys(
  getState: () => ProjectTabHotkeyState,
  selectTab: (tab: ProjectTabListItem) => void,
): void {
  const current = useUnrenderedValue({ getState, selectTab });
  useEffect(
    () =>
      installProjectTabHotkeyListener(
        window,
        () => current.value.getState(),
        (tab) => current.value.selectTab(tab),
      ),
    [current],
  );
}
