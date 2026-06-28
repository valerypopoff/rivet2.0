import { type ComponentType, useMemo } from 'react';
import { useContextMenuAddNodeConfiguration } from './useContextMenuAddNodeConfiguration.js';
import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import DuplicateIcon from '../assets/icons/duplicate-icon.svg?react';
import PlayIcon from 'majesticons/line/play-circle-line.svg?react';
import CopyIcon from '../assets/icons/copy-icon.svg?react';
import PasteIcon from '../assets/icons/paste-icon.svg?react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import SnowflakeIcon from '../assets/icons/snowflake-icon.svg?react';
import RearrangePortsIcon from '../assets/icons/rearrange-ports-icon.svg?react';
import { type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import { selectedNodesState } from '../state/graphBuilder.js';
import { useContextMenuCommands } from './useContextMenuCommands.js';
import { clipboardState } from '../state/clipboard';
import { useAtomValue } from 'jotai';
import { SubgraphGraphIcon } from '../components/visualNode/SubgraphGraphIcon.js';
import { SubgraphLinkIcon } from '../components/visualNode/SubgraphLinkIcon.js';
import type { VariadicPortReorderKind } from '../domain/graphEditing/variadicPortReorder.js';

export type ContextMenuConfig = {
  contexts: ContextMenuContextConfig;
  commands: ContextMenuItem[];
};

export type ContextMenuContextConfig = {
  [key: string]: ContextMenuContextConfigContext;
};

export type ContextMenuContextConfigContext<Context = unknown> = {
  contextType: Context;
  items: readonly ContextMenuItem<Context>[];
};

export type ContextMenuSearchSection = 'graphs';

export type ContextMenuItem<Context = unknown, Data = unknown> = {
  id: string;
  label: string;
  subLabel?: string;
  disabled?: boolean | ((context: Context) => boolean);
  disabledReason?: string | ((context: Context) => string | undefined);
  searchSection?: ContextMenuSearchSection;
  icon?: ComponentType;
  tone?: 'default' | 'danger';
  separatorBefore?: boolean;
  data?: Data | ((context: Context) => Data);
  conditional?: (context: Context) => boolean;
  items?: readonly ContextMenuItem<Context>[];
  infoBox?: {
    title: string;
    description: string;
    image?: string;
  };
  hiddenUntilSearched?: boolean;
};

export type ContextMenuConfiguration = ReturnType<typeof useContextMenuConfiguration>;

const type = <T>() => undefined! as T;

type NodeContextMenuData = {
  nodeType: ChartNode['type'];
  nodeId: NodeId;
  graphCommandsEnabled: boolean;
  isLinkedNode: boolean;
  canRunFromEditor: boolean;
  canRunFromHere: boolean;
  canRearrangeSubgraphPorts: boolean;
  canRearrangeVariadicPorts: boolean;
  variadicPortRearrangeKind?: VariadicPortReorderKind;
  canFreeze: boolean;
  canUnfreeze: boolean;
  freezeNodeTargets: NodeFreezeTarget[];
  freezeMenuTargetCount: number;
  freezeDisabledReason?: string;
  unfreezeNodeIds: NodeId[];
  isFrozen: boolean;
  canOpenNodePrefabSource: boolean;
};

type NodeFreezeTarget = {
  nodeId: NodeId;
  nodeType: ChartNode['type'];
};

const isNodeFreezeTarget = (value: unknown): value is NodeFreezeTarget =>
  Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as Partial<NodeFreezeTarget>).nodeId === 'string' &&
      typeof (value as Partial<NodeFreezeTarget>).nodeType === 'string',
  );

const getNodeContextMenuData = (context: unknown): NodeContextMenuData | undefined => {
  if (!context || typeof context !== 'object') {
    return undefined;
  }

  const data = context as Partial<NodeContextMenuData>;
  const freezeNodeTargets = Array.isArray(data.freezeNodeTargets)
    ? data.freezeNodeTargets.filter(isNodeFreezeTarget)
    : [];
  const unfreezeNodeIds = Array.isArray(data.unfreezeNodeIds)
    ? data.unfreezeNodeIds.filter((nodeId): nodeId is NodeId => typeof nodeId === 'string')
    : [];

  if (
    typeof data.nodeType !== 'string' ||
    typeof data.nodeId !== 'string' ||
    typeof data.graphCommandsEnabled !== 'boolean' ||
    typeof data.isLinkedNode !== 'boolean' ||
    typeof data.canRunFromEditor !== 'boolean' ||
    typeof data.canRunFromHere !== 'boolean' ||
    typeof data.canRearrangeSubgraphPorts !== 'boolean' ||
    typeof data.canRearrangeVariadicPorts !== 'boolean' ||
    typeof data.canFreeze !== 'boolean' ||
    typeof data.canUnfreeze !== 'boolean' ||
    typeof data.freezeMenuTargetCount !== 'number' ||
    typeof data.isFrozen !== 'boolean' ||
    typeof data.canOpenNodePrefabSource !== 'boolean'
  ) {
    return undefined;
  }

  return {
    nodeType: data.nodeType as ChartNode['type'],
    nodeId: data.nodeId as NodeId,
    graphCommandsEnabled: data.graphCommandsEnabled,
    isLinkedNode: data.isLinkedNode,
    canRunFromEditor: data.canRunFromEditor,
    canRunFromHere: data.canRunFromHere,
    canRearrangeSubgraphPorts: data.canRearrangeSubgraphPorts,
    canRearrangeVariadicPorts: data.canRearrangeVariadicPorts,
    variadicPortRearrangeKind:
      data.variadicPortRearrangeKind === 'input-only' || data.variadicPortRearrangeKind === 'input-output-pair'
        ? data.variadicPortRearrangeKind
        : undefined,
    canFreeze: data.canFreeze,
    canUnfreeze: data.canUnfreeze,
    freezeNodeTargets,
    freezeMenuTargetCount: data.freezeMenuTargetCount,
    freezeDisabledReason:
      typeof data.freezeDisabledReason === 'string' && data.freezeDisabledReason.length > 0
        ? data.freezeDisabledReason
        : undefined,
    unfreezeNodeIds,
    isFrozen: data.isFrozen,
    canOpenNodePrefabSource: data.canOpenNodePrefabSource,
  };
};

const isExecutableNodeContext = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data != null && data.graphCommandsEnabled && data.canRunFromEditor && data.nodeType !== 'comment';
};

const canRunFromHere = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data != null && data.graphCommandsEnabled && data.canRunFromEditor && data.nodeType !== 'comment' && data.canRunFromHere;
};

const getFreezeNodeTargetCount = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled && data.canFreeze ? data.freezeNodeTargets.length : 0;
};

const getFreezeMenuTargetCount = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled ? data.freezeMenuTargetCount : 0;
};

const getFreezeDisabledReason = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled ? data.freezeDisabledReason : undefined;
};

const getUnfreezeNodeTargetCount = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled && data.canUnfreeze ? data.unfreezeNodeIds.length : 0;
};

const isFreezeDisabled = (context: unknown) =>
  getFreezeNodeTargetCount(context) === 0 && getFreezeDisabledReason(context) != null;

const canFreezeOneNode = (context: unknown) => getFreezeNodeTargetCount(context) === 1;

const canFreezeMultipleNodes = (context: unknown) => getFreezeNodeTargetCount(context) > 1;

const shouldShowFreezeOneNode = (context: unknown) =>
  canFreezeOneNode(context) || (isFreezeDisabled(context) && getFreezeMenuTargetCount(context) === 1);

const shouldShowFreezeMultipleNodes = (context: unknown) =>
  canFreezeMultipleNodes(context) || (isFreezeDisabled(context) && getFreezeMenuTargetCount(context) > 1);

const canUnfreezeOneNode = (context: unknown) => getUnfreezeNodeTargetCount(context) === 1;

const canUnfreezeMultipleNodes = (context: unknown) => getUnfreezeNodeTargetCount(context) > 1;

const isSubgraphNodeContext = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled === true && data.nodeType === 'subGraph';
};

const canRearrangeSubgraphPorts = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled === true && data.canRearrangeSubgraphPorts === true;
};

const canRearrangeVariadicInputPorts = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled === true && data.canRearrangeVariadicPorts === true && data.variadicPortRearrangeKind === 'input-only';
};

const canRearrangeVariadicMirrorPorts = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data?.graphCommandsEnabled === true && data.canRearrangeVariadicPorts === true && data.variadicPortRearrangeKind === 'input-output-pair';
};

const canOpenNodePrefabSource = (context: unknown) => getNodeContextMenuData(context)?.canOpenNodePrefabSource === true;
const canEditNode = (context: unknown) => {
  const data = getNodeContextMenuData(context);
  return data != null && !data.isLinkedNode;
};
const isGraphCommandNodeContext = (context: unknown) => getNodeContextMenuData(context)?.graphCommandsEnabled === true;
const isPasteCommandBlankAreaContext = (context: unknown) =>
  Boolean(
    context &&
      typeof context === 'object' &&
      ((context as { graphCommandsEnabled?: unknown }).graphCommandsEnabled === true ||
        (context as { pasteCommandsEnabled?: unknown }).pasteCommandsEnabled === true),
  );

export function useContextMenuConfiguration() {
  const addMenuConfig = useContextMenuAddNodeConfiguration();
  const commands = useContextMenuCommands();
  const selectedNodeIds = useAtomValue(selectedNodesState);
  const clipboard = useAtomValue(clipboardState);

  const config = useMemo(
    () =>
      ({
        // Defines the "contexts" that the context menu can show, i.e. what you've right clicked on.
        contexts: {
          node: {
            contextType: type<NodeContextMenuData>(),
            items: [
              {
                id: 'node-run-to-here',
                label: 'Run to here',
                icon: PlayIcon,
                conditional: isExecutableNodeContext,
              },
              {
                id: 'node-run-from-here',
                label: 'Run from here',
                icon: PlayIcon,
                conditional: canRunFromHere,
              },
              {
                id: 'node-freeze',
                label: 'Freeze node output',
                icon: SnowflakeIcon,
                conditional: shouldShowFreezeOneNode,
                disabled: isFreezeDisabled,
                disabledReason: getFreezeDisabledReason,
                separatorBefore: true,
              },
              {
                id: 'nodes-freeze',
                label: 'Freeze node outputs',
                icon: SnowflakeIcon,
                conditional: shouldShowFreezeMultipleNodes,
                disabled: isFreezeDisabled,
                disabledReason: getFreezeDisabledReason,
                separatorBefore: true,
              },
              {
                id: 'node-unfreeze',
                label: 'Unfreeze node output',
                icon: SnowflakeIcon,
                conditional: canUnfreezeOneNode,
                separatorBefore: true,
              },
              {
                id: 'nodes-unfreeze',
                label: 'Unfreeze node outputs',
                icon: SnowflakeIcon,
                conditional: canUnfreezeMultipleNodes,
                separatorBefore: true,
              },
              {
                id: 'node-copy',
                label: 'Copy',
                icon: CopyIcon,
                conditional: isGraphCommandNodeContext,
                separatorBefore: true,
              },
              {
                id: 'node-duplicate',
                label: 'Duplicate',
                icon: DuplicateIcon,
              },
              {
                id: 'node-go-to-subgraph',
                label: 'Go to subgraph',
                icon: SubgraphGraphIcon,
                conditional: isSubgraphNodeContext,
              },
              {
                id: 'node-edit',
                label: 'Edit',
                icon: SettingsCogIcon,
                conditional: canEditNode,
              },
              {
                id: 'node-open-prefab-source',
                label: 'Open library node',
                icon: SubgraphLinkIcon,
                conditional: canOpenNodePrefabSource,
              },
              {
                id: 'node-rearrange-subgraph-ports',
                label: 'Rearrange inputs/outputs',
                icon: RearrangePortsIcon,
                conditional: canRearrangeSubgraphPorts,
              },
              {
                id: 'node-rearrange-variadic-inputs',
                label: 'Rearrange inputs',
                icon: RearrangePortsIcon,
                conditional: canRearrangeVariadicInputPorts,
              },
              {
                id: 'node-rearrange-variadic-inputs-outputs',
                label: 'Rearrange inputs/outputs',
                icon: RearrangePortsIcon,
                conditional: canRearrangeVariadicMirrorPorts,
              },
              {
                id: 'nodes-factor-into-subgraph',
                label: 'Create Subgraph',
                icon: DuplicateIcon,
                conditional: (context) => isGraphCommandNodeContext(context) && selectedNodeIds.length > 0,
              },
              {
                id: 'node-delete',
                label: 'Delete',
                icon: DeleteIcon,
                tone: 'danger',
                separatorBefore: true,
              },
            ],
          },
          blankArea: {
            contextType: type<{ graphCommandsEnabled?: boolean; pasteCommandsEnabled?: boolean }>(),
            items: [
              {
                id: 'add',
                label: 'Add node',
                items: addMenuConfig,
                icon: PlusIcon,
              },
              {
                id: 'paste',
                label: 'Paste',
                icon: PasteIcon,
                conditional: (context) => isPasteCommandBlankAreaContext(context) && clipboard !== undefined,
              },
            ],
          },
          graphList: {
            contextType: type<{}>(),
            items: [],
          },
          graphListGraph: {
            contextType: type<{}>(),
            items: [],
          },
        },
        commands,
      }) as const satisfies ContextMenuConfig,
    [addMenuConfig, selectedNodeIds.length, commands, clipboard],
  );

  return config;
}
