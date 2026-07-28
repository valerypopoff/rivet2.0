import { useSetAtom } from 'jotai';
import { useLayoutEffect } from 'react';
import { dataBusFullRowCountState } from '../../state/ui.js';

/** Publishes the vertical space reserved by the always-pinned Data Bus rows. */
export function useDataBusRailLayout(busCount: number): void {
  const setDataBusFullRowCount = useSetAtom(dataBusFullRowCountState);

  useLayoutEffect(() => {
    setDataBusFullRowCount(Math.max(0, Math.floor(busCount)));
  }, [busCount, setDataBusFullRowCount]);

  useLayoutEffect(
    () => () => {
      setDataBusFullRowCount(0);
    },
    [setDataBusFullRowCount],
  );
}
