import Portal from '@atlaskit/portal';
import { css } from '@emotion/react';
import {
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { type CSSProperties, forwardRef, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { draggingWireState } from '../state/graphBuilder';
import { lastRunDataState, resolvedGraphSelectionState, selectedProcessPageNodesState } from '../state/dataFlow';
import {
  filterProcessDataForSelection,
  getSelectedProcessData,
  getSelectedProcessPageIndex,
  resolveCanvasExecutionProcessPage,
} from '../state/selectors/executionSelectors.js';
import clsx from 'clsx';
import { RenderDataValue } from './RenderDataValue';
import { getPortCompatibilityStatus } from '../domain/graphEditing/portCompatibility.js';
import {
  canvasIoDefinitionsForNodeState,
  createInputConnectionWarningDetailsAtom,
} from '../state/selectors/canvasGraphSelectors.js';

const style = css`
  position: absolute;
  pointer-events: none;
  width: max-content;
  max-width: calc(100vw - 24px);
  box-sizing: border-box;
  overflow-wrap: anywhere;

  padding: 12px;
  border-radius: 10px;
  corner-shape: squircle;
  @supports not (corner-shape: squircle) {
    border-radius: 5px;
  }
  background-color: var(--grey-darker);
  color: var(--foreground);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
  border: 1px solid var(--grey);
  z-index: 1000;
  font-size: var(--ui-font-size-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;

  dl {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    gap: 4px;

    dt {
      display: inline;
      font-weight: bold;
      margin: 0;
      white-space: nowrap;
      padding: 0;
    }

    dd {
      display: inline;
      margin: 0;
      padding: 0;
    }
  }

  .port-title {
    font-weight: bold;

    .id {
      font-family: var(--font-family-monospace);
      font-weight: 400;
    }
  }

  .will-be-coerced,
  .connection-warning {
    color: var(--warning);

    code {
      font-family: var(--font-family-monospace);
      font-size: var(--ui-font-size-sm);
    }
  }

  .incompatible {
    color: var(--error);

    code {
      font-family: var(--font-family-monospace);
      font-size: var(--ui-font-size-sm);
    }
  }

  .port-title,
  .description,
  .connection-warning {
    max-width: 350px;
  }

  .not-ran {
    border-top: 1px dashed var(--warning);
    padding-top: 4px;
    margin-top: 4px;
    color: var(--warning);
  }
`;

export const PortInfo = forwardRef<
  HTMLDivElement,
  {
    port: {
      nodeId: NodeId;
      isInput: boolean;
      portId: PortId;
      definition: NodeInputDefinition | NodeOutputDefinition;
    };
    floatingStyles: CSSProperties;
  }
>(({ port, floatingStyles }, ref) => {
  const liveIo = useAtomValue(canvasIoDefinitionsForNodeState(port.nodeId));
  const definition = useMemo(
    () =>
      port.isInput
        ? liveIo.inputDefinitions.find((candidate) => candidate.id === port.portId)
        : liveIo.outputDefinitions.find((candidate) => candidate.id === port.portId),
    [liveIo.inputDefinitions, liveIo.outputDefinitions, port.isInput, port.portId],
  );

  if (!definition?.dataType) {
    return null;
  }

  return <PortInfoContent port={port} definition={definition} floatingStyles={floatingStyles} ref={ref} />;
});

PortInfo.displayName = 'PortInfo';

const PortInfoContent = forwardRef<
  HTMLDivElement,
  {
    port: {
      nodeId: NodeId;
      isInput: boolean;
      portId: PortId;
      definition: NodeInputDefinition | NodeOutputDefinition;
    };
    definition: NodeInputDefinition | NodeOutputDefinition;
    floatingStyles: CSSProperties;
  }
>(({ port, definition, floatingStyles }, ref) => {
  const { dataType, title, description, id } = definition;

  const lastRun = useAtomValue(lastRunDataState(port.nodeId));
  const selectedProcessPageNodes = useAtomValue(selectedProcessPageNodesState);
  const selectedPage = resolveCanvasExecutionProcessPage(selectedProcessPageNodes[port.nodeId]);
  const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);

  const filteredLastRun = useMemo(
    () => filterProcessDataForSelection({ ...graphSelectionOptions, processData: lastRun }),
    [graphSelectionOptions, lastRun],
  );
  const portData = useMemo(() => {
    if (!filteredLastRun || selectedPage == null) {
      return undefined;
    }

    const execution = getSelectedProcessData(filteredLastRun, selectedPage);
    if (!execution?.data) {
      return undefined;
    }

    const data = port.isInput ? execution.data.inputData : execution.data.outputData;
    if (!data) {
      return undefined;
    }

    return data;
  }, [filteredLastRun, port.isInput, selectedPage]);

  const selectedPortData = portData?.[port.portId];
  const didNotRun = selectedPortData?.type === 'control-flow-excluded';

  const draggingWire = useAtomValue(draggingWireState);
  const warningDetailsAtom = useMemo(
    () => createInputConnectionWarningDetailsAtom(port.nodeId, port.portId, port.isInput),
    [port.nodeId, port.portId, port.isInput],
  );
  const warningDetails = useAtomValue(warningDetailsAtom);

  const dataTypeDisplay: string =
    dataType == null ? 'Unknown' : Array.isArray(dataType) ? dataType.join(' or ') : (dataType as string);
  let dataTypeDisplayWithCoerced = dataTypeDisplay;

  let canCoerce = false;
  if (port.isInput && ((definition as NodeInputDefinition).coerced ?? true)) {
    canCoerce = true;
    dataTypeDisplayWithCoerced += ' (coerced)';
  }

  const compatibilityStatus = getPortCompatibilityStatus({
    draggingDataType: draggingWire?.dataType,
    portDataType: definition.dataType,
    canCoerce,
    isInput: port.isInput,
  });
  const willCoerce = compatibilityStatus === 'coerced';
  const incompatible = compatibilityStatus === 'incompatible';
  const draggingDataTypeDisplay =
    draggingWire?.dataType == null
      ? 'Unknown'
      : Array.isArray(draggingWire.dataType)
        ? draggingWire.dataType.join(' or ')
        : draggingWire.dataType;

  const selectedPageIndex = getSelectedProcessPageIndex(filteredLastRun, selectedPage);
  const displayExecutionNum = selectedPortData != null && selectedPageIndex != null ? selectedPageIndex + 1 : undefined;

  return (
    <Portal>
      <div css={style} ref={ref} style={floatingStyles} className={clsx({ 'has-data': selectedPortData != null })}>
        {!['input', 'output'].includes(title.trim().toLowerCase()) && (
          <div className="port-title">
            {title === id ? (
              title
            ) : (
              <span>
                {title} <span className="id">({id})</span>
              </span>
            )}
          </div>
        )}
        <dl>
          <div className="type-row">
            <dt>{port.isInput ? 'Expected data type:' : 'Data type:'}</dt> <dd>{dataTypeDisplayWithCoerced}</dd>
          </div>

          {(definition as NodeInputDefinition).required && (
            <div>
              <dt>Required:</dt> <dd>Yes</dd>
            </div>
          )}
        </dl>
        {description && <div className="description">{description}</div>}
        {!draggingWire &&
          warningDetails.map((warning, index) => (
            <div className="connection-warning" key={index}>
              Actual input is{' '}
              <code>{Array.isArray(warning.sourceType) ? warning.sourceType.join(' or ') : warning.sourceType}</code>;
              this input expects <code>{dataTypeDisplay}</code>.{' '}
              {warning.status === 'coerced'
                ? 'Rivet will convert it.'
                : 'The types are incompatible; this connection may fail at runtime.'}
            </div>
          ))}
        {willCoerce && (
          <div className="will-be-coerced">
            Your data of type <code>{draggingDataTypeDisplay}</code> will be coerced to <code>{dataTypeDisplay}</code>{' '}
            if you connect it here.
          </div>
        )}
        {incompatible && (
          <div className="incompatible">
            Your data of type <code>{draggingDataTypeDisplay}</code> is incompatible with <code>{dataTypeDisplay}</code>
            . You may still connect it, but your graph may error.
          </div>
        )}
        {didNotRun && port.isInput && (
          <div className="not-ran">The input to this port was not run in the last execution.</div>
        )}
        {didNotRun && !port.isInput && (
          <div className="not-ran">Nodes connected to this port were not run in the last execution.</div>
        )}
        {selectedPortData != null && (
          <>
            <h6>Execution {displayExecutionNum}</h6>
            <div className="last-value">
              <RenderDataValue truncateLength={1500} value={selectedPortData} mode="compact" />
            </div>
          </>
        )}
      </div>
    </Portal>
  );
});

PortInfoContent.displayName = 'PortInfoContent';
