import { Field } from '@atlaskit/form';
import { css } from '@emotion/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef, useState, type FC } from 'react';
import {
  getGraphBoundary,
  getSubgraphProjectKey,
  getSubgraphTargetBoundaryChange,
  reconcileSubgraphTargetBoundary,
  type GraphId,
  type SubGraphNode,
  type SubgraphProjectVersion,
} from '@valerypopoff/rivet2-core';
import { useSubgraphProjectCatalog } from '../../../providers/ProvidersContext';
import { projectState, projectsState, referencedProjectsState } from '../../../state/savedGraphs';
import {
  findSubgraphProjectBundle,
  subgraphSourceScope,
  type SubgraphProjectTree,
} from '../../../utils/subgraphBundleScope.js';
import type { SharedEditorProps } from '../SharedEditorProps';
import { SegmentedEditor } from '../SegmentedEditor';
import { SubgraphTargetControl, SubgraphTargetLabel } from '../../nodes/SubgraphTargetControl';
import { useNodeEditorSessionContext } from '../../nodeEditor/NodeEditorSessionContext.js';
import { isRecordingProjectState } from '../../../state/execution.js';

const versionWarningCss = css`
  color: var(--warning);
  font-size: var(--ui-font-size-sm);
  margin-top: 6px;
`;

export const SubgraphTargetEditor: FC<SharedEditorProps> = (props) => {
  const recording = useAtomValue(isRecordingProjectState);
  return recording ? (
    <Field name="graphId" label="Recorded graph">
      {() => <SubgraphTargetLabel node={props.node as SubGraphNode} isRecording />}
    </Field>
  ) : (
    <LiveSubgraphTargetEditor {...props} />
  );
};

const LiveSubgraphTargetEditor: FC<SharedEditorProps> = ({ node: chartNode, onChange, isReadonly, isDisabled }) => {
  const node = chartNode as SubGraphNode;
  const session = useNodeEditorSessionContext();
  const catalog = useSubgraphProjectCatalog();
  const ownProjectId = useAtomValue(projectState).metadata.id;
  const membershipKey = useAtomValue(projectsState).openedProjects[ownProjectId]?.hostedBundleKey;
  const [tree, setTree] = useState<SubgraphProjectTree | null>(null);
  const scope = subgraphSourceScope(node.data, tree, ownProjectId);
  const ownBundle = findSubgraphProjectBundle(tree, ownProjectId);
  const otherProjects = !!catalog && scope !== 'this-project';
  const [publishedAvailable, setPublishedAvailable] = useState<boolean | null>(null);
  const [publishedError, setPublishedError] = useState<string>();
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState<string>();
  const [versionWarning, setVersionWarning] = useState<string>();
  const versionRequest = useRef(0);
  const latestNode = useRef(node);
  const setReferencedProjects = useSetAtom(referencedProjectsState);
  latestNode.current = node;
  const disabled = isReadonly || isDisabled;

  useEffect(() => {
    const requests = versionRequest;
    // A renewed same-ID session may keep this component mounted. Its retired
    // request can no longer clear loading, so release the incoming owner's UI.
    setVersionLoading(false);
    setVersionError(undefined);
    setVersionWarning(undefined);
    return () => {
      requests.current++;
    };
  }, [session, ownProjectId, membershipKey]);

  useEffect(() => {
    if (!catalog || !otherProjects || !node.data.targetProjectId) {
      setPublishedAvailable(null);
      setPublishedError(undefined);
      return;
    }
    let active = true;
    setPublishedAvailable(null);
    setPublishedError(undefined);
    void catalog
      .preview({ projectId: node.data.targetProjectId, version: 'published', callerProjectId: ownProjectId })
      .then(
        () => {
          if (active && (!session || session.isCurrent())) setPublishedAvailable(true);
        },
        (error: { status?: number }) => {
          if (!active || (session && !session.isCurrent())) return;
          setPublishedAvailable(false);
          if (error.status !== 409) setPublishedError('Could not check this project’s published version.');
        },
      );
    return () => {
      active = false;
    };
  }, [catalog, otherProjects, node.data.targetProjectId, session, ownProjectId, membershipKey]);

  const changeScope = (scope: string | boolean) => {
    if (disabled || (session && !session.canWrite())) return;
    const other = scope === 'other-projects' || scope === 'same-bundle';
    if (scope === subgraphSourceScope(node.data, tree, ownProjectId)) return;
    if (scope === 'same-bundle' && !ownBundle) return;
    versionRequest.current++;
    setVersionLoading(false);
    setVersionError(undefined);
    setVersionWarning(undefined);
    onChange({
      ...node,
      data: {
        ...node.data,
        graphId: '' as GraphId,
        targetScope: other ? (scope as 'other-projects' | 'same-bundle') : undefined,
        targetProjectId: undefined,
        targetVersion: other ? 'latest' : undefined,
        targetBoundary: undefined,
      },
    });
  };

  const changeVersion = async (value: string | boolean) => {
    if (disabled || (session && !session.canWrite())) return;
    const nextVersion = value as SubgraphProjectVersion;
    const projectId = node.data.targetProjectId;
    const graphId = node.data.graphId;
    const previousVersion = node.data.targetVersion ?? 'latest';
    if (!catalog || !projectId || !graphId || nextVersion === previousVersion || versionLoading) return;

    const request = ++versionRequest.current;
    setVersionLoading(true);
    setVersionError(undefined);
    setVersionWarning(undefined);
    try {
      const project = await catalog.preview({ projectId, version: nextVersion, callerProjectId: ownProjectId });
      if (versionRequest.current !== request || (session && !session.canWrite())) return;
      const current = (session?.getNode() ?? latestNode.current) as SubGraphNode;
      if (
        current.data.targetProjectId !== projectId ||
        current.data.graphId !== graphId ||
        (current.data.targetVersion ?? 'latest') !== previousVersion
      )
        return;

      const boundary = getGraphBoundary(project, graphId);
      if (!boundary) {
        setVersionError('This graph is unavailable in the selected version. The current version was kept.');
        return;
      }

      const change = getSubgraphTargetBoundaryChange(current.data.targetBoundary, boundary);
      setReferencedProjects((projects) => ({
        ...projects,
        [getSubgraphProjectKey({ projectId, version: nextVersion })]: project,
      }));
      onChange(
        {
          ...current,
          data: {
            ...current.data,
            targetVersion: nextVersion,
            targetBoundary: change ? boundary : reconcileSubgraphTargetBoundary(current.data.targetBoundary, boundary),
          },
        },
        undefined,
        current,
      );
      if (change) {
        setVersionWarning(
          `The selected project's graph changed its ${change.side} "${change.id}". The graph selection was updated automatically; review its connections.`,
        );
      }
    } catch {
      if (versionRequest.current === request && (!session || session.isCurrent())) {
        setVersionError('Could not load the selected project version. The current version was kept.');
      }
    } finally {
      if (versionRequest.current === request && (!session || session.isCurrent())) setVersionLoading(false);
    }
  };

  return (
    <>
      {catalog && (
        <SegmentedEditor
          value={scope}
          onChange={changeScope}
          isDisabled={disabled || versionLoading}
          isReadonly={isReadonly}
          label="Graph source"
          ariaLabel="Subgraph graph source"
          options={[
            { label: 'This project', value: 'this-project' },
            ...(ownBundle ? [{ label: 'Same bundle', value: 'same-bundle' }] : []),
            { label: 'Other projects', value: 'other-projects' },
          ]}
        />
      )}
      <Field name="graphId" label="Graph" isDisabled={disabled}>
        {() => (
          <SubgraphTargetControl
            node={node}
            projectTree={tree}
            onProjectTreeChange={setTree}
            isReadonly={disabled || versionLoading}
            onChange={(next) => {
              if (disabled || (session && !session.canWrite())) return;
              versionRequest.current++;
              setVersionLoading(false);
              setVersionError(undefined);
              setVersionWarning(undefined);
              onChange(next);
            }}
          />
        )}
      </Field>
      {otherProjects && (
        <>
          <SegmentedEditor
            value={node.data.targetVersion ?? 'latest'}
            onChange={(value) => {
              void changeVersion(value);
            }}
            isDisabled={disabled || !node.data.targetProjectId || !node.data.graphId || versionLoading}
            isReadonly={isReadonly}
            label="Version"
            ariaLabel="Subgraph project version"
            options={[
              { label: 'Saved latest', value: 'latest' },
              {
                label: 'Published',
                value: 'published',
                disabled: publishedAvailable !== true && node.data.targetVersion !== 'published',
              },
            ]}
          />
          {versionWarning && (
            <div css={versionWarningCss} role="alert">
              {versionWarning}
            </div>
          )}
          {versionError && <div role="alert">{versionError}</div>}
          {publishedError && <div role="alert">{publishedError}</div>}
        </>
      )}
    </>
  );
};
