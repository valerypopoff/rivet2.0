import { Field } from '@atlaskit/form';
import { css } from '@emotion/react';
import { useSetAtom } from 'jotai';
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
import { referencedProjectsState } from '../../../state/savedGraphs';
import type { SharedEditorProps } from '../SharedEditorProps';
import { SegmentedEditor } from '../SegmentedEditor';
import { SubgraphTargetControl } from '../../nodes/SubgraphTargetControl';

const versionWarningCss = css`
  color: var(--warning);
  font-size: var(--ui-font-size-sm);
  margin-top: 6px;
`;

export const SubgraphTargetEditor: FC<SharedEditorProps> = ({ node: chartNode, onChange, isReadonly, isDisabled }) => {
  const node = chartNode as SubGraphNode;
  const catalog = useSubgraphProjectCatalog();
  const otherProjects = !!catalog && (node.data.targetScope === 'other-projects' || !!node.data.targetProjectId);
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

  useEffect(
    () => () => {
      versionRequest.current++;
    },
    [],
  );

  useEffect(() => {
    if (!catalog || !otherProjects || !node.data.targetProjectId) {
      setPublishedAvailable(null);
      setPublishedError(undefined);
      return;
    }
    let active = true;
    setPublishedAvailable(null);
    setPublishedError(undefined);
    void catalog.preview({ projectId: node.data.targetProjectId, version: 'published' }).then(
      () => {
        if (active) setPublishedAvailable(true);
      },
      (error: { status?: number }) => {
        if (!active) return;
        setPublishedAvailable(false);
        if (error.status !== 409) setPublishedError('Could not check this project’s published version.');
      },
    );
    return () => {
      active = false;
    };
  }, [catalog, otherProjects, node.data.targetProjectId]);

  const changeScope = (scope: string | boolean) => {
    const other = scope === 'other-projects';
    if (other === otherProjects) return;
    versionRequest.current++;
    setVersionLoading(false);
    setVersionError(undefined);
    setVersionWarning(undefined);
    onChange({
      ...node,
      data: {
        ...node.data,
        graphId: '' as GraphId,
        targetScope: other ? 'other-projects' : undefined,
        targetProjectId: undefined,
        targetVersion: other ? 'latest' : undefined,
        targetBoundary: undefined,
      },
    });
  };

  const changeVersion = async (value: string | boolean) => {
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
      const project = await catalog.preview({ projectId, version: nextVersion });
      if (versionRequest.current !== request) return;
      const current = latestNode.current;
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
      onChange({
        ...current,
        data: {
          ...current.data,
          targetVersion: nextVersion,
          targetBoundary: change ? boundary : reconcileSubgraphTargetBoundary(current.data.targetBoundary, boundary),
        },
      });
      if (change) {
        setVersionWarning(
          `The selected project's graph changed its ${change.side} "${change.id}". The graph selection was updated automatically; review its connections.`,
        );
      }
    } catch {
      if (versionRequest.current === request) {
        setVersionError('Could not load the selected project version. The current version was kept.');
      }
    } finally {
      if (versionRequest.current === request) setVersionLoading(false);
    }
  };

  return (
    <>
      {catalog && (
        <SegmentedEditor
          value={otherProjects ? 'other-projects' : 'this-project'}
          onChange={changeScope}
          isDisabled={disabled || versionLoading}
          isReadonly={isReadonly}
          label="Graph source"
          ariaLabel="Subgraph graph source"
          options={[
            { label: 'This project', value: 'this-project' },
            { label: 'Other projects', value: 'other-projects' },
          ]}
        />
      )}
      <Field name="graphId" label="Graph" isDisabled={disabled}>
        {() => (
          <SubgraphTargetControl
            node={node}
            isReadonly={disabled || versionLoading}
            onChange={(next) => {
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
