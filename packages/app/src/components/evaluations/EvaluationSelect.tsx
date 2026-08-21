import Portal from '@atlaskit/portal';
import Select, { type OptionType, type SelectProps } from '@atlaskit/select';
import { useState } from 'react';

/**
 * Evaluation workspaces and dialogs contain their own scroll regions. Keep
 * menus in Rivet's top-level portal so those regions can never clip them.
 */
export function EvaluationSelect<Option = OptionType, IsMulti extends boolean = false>(
  props: SelectProps<Option, IsMulti>,
) {
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <Select {...props} menuPosition="fixed" menuPortalTarget={menuPortalTarget ?? undefined} />
      <Portal zIndex={1000}>
        <div ref={setMenuPortalTarget} />
      </Portal>
    </>
  );
}
