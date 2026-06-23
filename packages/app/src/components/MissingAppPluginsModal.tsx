import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import type { PluginLoadSpec } from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue } from 'jotai';
import { useMemo, useState } from 'react';
import { AppModalHeader } from './AppModalHeader';
import { graphState } from '../state/graph';
import { appPluginSpecsState, pluginsState } from '../state/plugins';
import { projectState } from '../state/savedGraphs';
import {
  dedupePluginSpecs,
  deriveProjectPluginSpecsFromGraphs,
  getMissingAppPluginSpecs,
  getPluginSpecDetails,
  getPluginSpecLabel,
} from '../utils/pluginUsage';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry';

const modalStyles = css`
  .missing-plugin-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .missing-plugin {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid var(--grey-darkish);
    padding: 8px 0;
  }

  .plugin-name {
    font-weight: 600;
  }

  .plugin-details {
    color: var(--grey-light);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
  }
`;

export function MissingAppPluginsModalRenderer() {
  const graph = useAtomValue(graphState);
  const project = useAtomValue(projectState);
  const pluginStates = useAtomValue(pluginsState);
  const projectNodeRegistry = useProjectNodeRegistry();
  const [appPluginSpecs, setAppPluginSpecs] = useAtom(appPluginSpecsState);
  const [dismissedMissingPluginKey, setDismissedMissingPluginKey] = useState<string | null>(null);

  const projectPluginSpecs = useMemo(
    () =>
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: pluginStates,
        currentGraph: graph,
        project,
        registry: projectNodeRegistry,
      }),
    [graph, pluginStates, project, projectNodeRegistry],
  );

  const missingPluginSpecs = useMemo(
    () => getMissingAppPluginSpecs(projectPluginSpecs, appPluginSpecs),
    [appPluginSpecs, projectPluginSpecs],
  );

  const missingPluginKey = useMemo(
    () => `${project.metadata.id}:${missingPluginSpecs.map((spec) => spec.id).sort().join('|')}`,
    [missingPluginSpecs, project.metadata.id],
  );

  const isOpen = missingPluginSpecs.length > 0 && dismissedMissingPluginKey !== missingPluginKey;

  const installPlugin = (spec: PluginLoadSpec) => {
    setAppPluginSpecs((currentSpecs) => dedupePluginSpecs([...(currentSpecs ?? []), spec]));
  };

  const close = () => {
    setDismissedMissingPluginKey(missingPluginKey);
  };

  return (
    <ModalTransition>
      {isOpen && (
        <Modal onClose={close} width="large">
          <AppModalHeader title="Project Plugins Not Installed" onClose={close} />
          <ModalBody>
            <div css={modalStyles}>
              <p>
                This project uses plugins that are not installed in this Rivet app. Install the plugins you trust to
                make their nodes available.
              </p>
              <div className="missing-plugin-list">
                {missingPluginSpecs.map((spec) => (
                  <div className="missing-plugin" key={spec.id}>
                    <div>
                      <div className="plugin-name">{getPluginSpecLabel(spec)}</div>
                      <div className="plugin-details">{getPluginSpecDetails(spec)}</div>
                    </div>
                    <Button appearance="primary" onClick={() => installPlugin(spec)}>
                      Install
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button onClick={close}>Close</Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
}
