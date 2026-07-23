import { useEffect, useMemo, useRef, useState, type FC, type ReactNode, type RefObject } from 'react';
import { InlineEditableTextfield } from '@atlaskit/inline-edit';
import { ProjectPluginsConfiguration } from './ProjectPluginConfiguration';
import { Field } from '@atlaskit/form';
import Select from '@atlaskit/select';
import { projectState, savedGraphsState } from '../state/savedGraphs';
import { css, Global } from '@emotion/react';
import { ProjectRevisions } from './ProjectRevisionList';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { ProjectReferencesConfiguration } from './ProjectReferencesConfiguration';
import { ProjectMCPConfiguration } from './ProjectMCPConfiguration';
import { MainGraphIcon } from './graphList/MainGraphIcon';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { AppModalHeader } from './AppModalHeader';
import Button from '@atlaskit/button';
import { ProjectContextConfiguration } from './ProjectContextConfiguration';
import { ProjectKnowledgeStoresConfiguration } from './ProjectKnowledgeStoresConfiguration';
import Collapsible from 'react-collapsible';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronUpIcon from 'majesticons/line/chevron-up-line.svg?react';
import { projectSettingsSectionOpenState } from '../state/ui';
import { useIOProvider } from '../providers/ProvidersContext';
import {
  activeProjectComparisonState,
  projectCompareReferenceState,
  selectedGraphProjectComparisonState,
} from '../state/projectComparison';
import { toast } from 'react-toastify';
import {
  formatProjectComparisonCounts,
  formatProjectComparisonCurrentGraphCounts,
  getGraphProjectComparisonCounts,
  getOverallProjectComparisonCounts,
  getProjectComparisonReferenceFileName,
} from '../utils/projectComparisonSummary';

const styles = css`
  font-size: var(--ui-font-size-compact);

  label,
  .project-info-label,
  [data-read-view-fit-container-width] > div,
  input {
    font-size: var(--ui-font-size-compact) !important;
  }

  .project-info-layout {
    display: flex;
    flex-direction: column;
  }

  .project-info-item {
    min-width: 0;
    margin: 0 0 16px;

    > * {
      margin-top: 0 !important;
    }

    > form {
      margin: 0;
    }

    > form > div {
      margin-top: 0 !important;
    }
  }

  .project-info-divider {
    border-top: 1px solid var(--grey-darkish);
    margin: 0 0 16px;
  }

  .main-graph-field-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .main-graph-field-label svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .project-info-action {
    margin-top: 8px;
  }

  .project-info-compare-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .project-info-compare-summary {
    margin-top: 8px;
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
  }

  .project-info-label {
    color: var(--foreground-muted);
    font-weight: var(--font-weight-semibold);
    margin-bottom: 6px;
  }

  .project-info-foldable {
    --editor-group-radius: calc(16px * var(--ui-font-scale));
    --editor-group-toggle-radius: calc(8px * var(--ui-font-scale));
    --editor-group-padding-x: calc(16px * var(--ui-font-scale));
    --editor-group-padding-y: calc(16px * var(--ui-font-scale));
    --editor-group-padding-bottom: calc(18px * var(--ui-font-scale));
    --editor-group-toggle-padding-y: calc(8px * var(--ui-font-scale));
    --editor-group-toggle-icon-size: calc(24px * var(--ui-font-scale));
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  @supports not (corner-shape: squircle) {
    .project-info-foldable {
      --editor-group-radius: calc(8px * var(--ui-font-scale));
      --editor-group-toggle-radius: calc(4px * var(--ui-font-scale));
    }
  }

  .project-info-foldable > .Collapsible .project-info-foldable-toggle-container {
    display: flex;
    flex-direction: column;
    padding-left: var(--editor-group-padding-x);
    padding-right: var(--editor-group-padding-x);
    border: 1px solid var(--settings-collapsible-border);
    border-radius: var(--editor-group-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-header-bg);
  }

  .project-info-foldable > .Collapsible > .project-info-foldable-toggle-container.open {
    border-bottom: none;
    border-radius: var(--editor-group-radius) var(--editor-group-radius) 0 0;
    corner-shape: squircle;
  }

  .project-info-foldable > .Collapsible > .project-info-foldable-toggle-container.open + .Collapsible__contentOuter {
    border: 1px solid var(--settings-collapsible-border);
    border-top: none;
    border-radius: 0 0 var(--editor-group-radius) var(--editor-group-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-body-bg);
  }

  .project-info-foldable-toggle-area {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .project-info-foldable-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--editor-group-toggle-padding-y) var(--editor-group-padding-x);
    margin: 0 calc(-1 * var(--editor-group-padding-x));
    border: none;
    background: none;
    cursor: pointer;
    outline: none;
    font-family: inherit;
    color: var(--label-color);
    font-size: var(--ui-font-size-base);
    font-weight: var(--label-font-weight);
    line-height: 1.25;
    border-radius: var(--editor-group-toggle-radius);
    corner-shape: squircle;
    transition: background 0.2s ease-out;
  }

  .project-info-foldable-toggle:hover {
    background: var(--settings-collapsible-hover-bg);
  }

  .project-info-foldable-toggle .indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--editor-group-toggle-icon-size);
    height: var(--editor-group-toggle-icon-size);
    flex: 0 0 var(--editor-group-toggle-icon-size);
  }

  .project-info-foldable-content {
    margin-top: 0;
    padding: var(--editor-group-padding-y) var(--editor-group-padding-x) var(--editor-group-padding-bottom);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }
`;

const projectSettingsBodyTestId = 'project-settings-modal-body';
const projectSettingsBodyScrollableTestId = `${projectSettingsBodyTestId}--scrollable`;

export const ProjectInfoPanel: FC = () => {
  const [project, setProject] = useAtom(projectState);
  const savedGraphs = useAtomValue(savedGraphsState);
  const ioProvider = useIOProvider();
  const [compareLoading, setCompareLoading] = useState(false);
  const activeComparison = useAtomValue(activeProjectComparisonState);
  const selectedGraphComparison = useAtomValue(selectedGraphProjectComparisonState);
  const setProjectCompareReference = useSetAtom(projectCompareReferenceState);

  const graphOptions = useMemo(
    () => [
      { label: '(None)', value: undefined },
      ...savedGraphs.map((g) => ({ label: g.metadata!.name, value: g.metadata!.id })),
    ],
    [savedGraphs],
  );

  const selectedMainGraph = graphOptions.find((g) => g.value === project.metadata.mainGraphId);

  const startProjectCompare = async () => {
    setCompareLoading(true);

    try {
      await ioProvider.loadProjectData(({ project: referenceProject, path }) => {
        setProjectCompareReference({
          projectId: project.metadata.id,
          referencePath: path,
          referenceProject,
        });
        toast.success('Project compare mode enabled.');
      });
    } catch (error) {
      toast.error(`Failed to compare project: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCompareLoading(false);
    }
  };

  const stopProjectCompare = () => {
    setProjectCompareReference(undefined);
  };

  return (
    <div css={styles} className="project-info-section">
      <div className="project-info-layout">
        <div className="project-info-item">
          <InlineEditableTextfield
            key={`name-${project.metadata.id}`}
            label="Project Name"
            placeholder="Project Name"
            readViewFitContainerWidth
            defaultValue={project.metadata.title}
            onConfirm={(newValue) => setProject({ ...project, metadata: { ...project.metadata, title: newValue } })}
          />
        </div>

        <div className="project-info-item">
          <InlineEditableTextfield
            key={`description-${project.metadata.id}`}
            label="Description"
            placeholder="Project Description"
            defaultValue={project.metadata?.description ?? ''}
            onConfirm={(newValue) =>
              setProject({ ...project, metadata: { ...project.metadata, description: newValue } })
            }
            readViewFitContainerWidth
          />
        </div>

        <div className="project-info-item">
          <Field name="mainGraph" label={<MainGraphFieldLabel />}>
            {() => (
              <Select
                options={graphOptions}
                value={selectedMainGraph}
                onChange={(newValue) => {
                  setProject({
                    ...project,
                    metadata: { ...project.metadata, mainGraphId: newValue?.value ?? undefined },
                  });
                }}
              />
            )}
          </Field>
        </div>

        <div className="project-info-divider" />

        <div className="project-info-item">
          <ProjectMCPConfiguration />
        </div>

        <div className="project-info-item">
          <ProjectKnowledgeStoresConfiguration />
        </div>

        <div className="project-info-item">
          <ProjectReferencesConfiguration />
        </div>

        <div className="project-info-item">
          <div className="project-info-label">Project compare</div>
          <div className="project-info-compare-actions">
            <Button isDisabled={compareLoading} onClick={() => void startProjectCompare()}>
              {compareLoading ? 'Loading project...' : 'Compare to an older version'}
            </Button>
            {activeComparison && <Button onClick={stopProjectCompare}>Stop comparing</Button>}
          </div>
          {activeComparison && (
            <div className="project-info-compare-summary">
              <div>
                Compare mode against{' '}
                {getProjectComparisonReferenceFileName(
                  activeComparison.referencePath,
                  activeComparison.referenceProject.metadata.title,
                )}
              </div>
              <div>
                - Overall difference:{' '}
                {formatProjectComparisonCounts(getOverallProjectComparisonCounts(activeComparison.comparison))}
              </div>
              <div>
                - Current opened graph difference:{' '}
                {formatProjectComparisonCurrentGraphCounts(getGraphProjectComparisonCounts(selectedGraphComparison))}
              </div>
            </div>
          )}
        </div>

        <div className="project-info-item">
          <div className="project-info-label">Revisions</div>
          <ProjectRevisions />
        </div>

        <div className="project-info-divider" />

        <ProjectInfoFoldableSection sectionKey="plugins" title="Plugins">
          <ProjectPluginsConfiguration />
        </ProjectInfoFoldableSection>

        <ProjectInfoFoldableSection sectionKey="context-values" title="Context values">
          <ProjectContextConfiguration />
        </ProjectInfoFoldableSection>
      </div>
    </div>
  );
};

export const ProjectInfoModal: FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const bodyContentRef = useRef<HTMLDivElement>(null);
  const hasBodyScrollbar = useModalBodyScrollbar(bodyContentRef);

  return (
    <ModalTransition>
      {isOpen && (
        <Modal onClose={onClose} width="large">
          <Global
            styles={css`
              ${hasBodyScrollbar
                ? ''
                : `
                    [data-testid='${projectSettingsBodyScrollableTestId}'] {
                      border-bottom-color: transparent !important;
                    }
                  `}
            `}
          />
          <AppModalHeader title="Project settings" onClose={onClose} />
          <ModalBody testId={projectSettingsBodyTestId}>
            <div ref={bodyContentRef}>
              <ProjectInfoPanel />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button appearance="primary" onClick={onClose}>
              Done
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};

const MainGraphFieldLabel: FC = () => (
  <span className="main-graph-field-label">
    <span>Main Graph</span>
    <MainGraphIcon />
  </span>
);

function useModalBodyScrollbar(contentRef: RefObject<HTMLElement>): boolean {
  const [hasScrollbar, setHasScrollbar] = useState(false);

  useEffect(() => {
    const contentElement = contentRef.current;
    const scrollableElement = contentElement?.closest<HTMLElement>(`[data-testid="${projectSettingsBodyScrollableTestId}"]`);

    if (!contentElement || !scrollableElement) {
      setHasScrollbar(false);
      return;
    }

    const updateScrollbarState = () => {
      setHasScrollbar(scrollableElement.scrollHeight > scrollableElement.clientHeight + 1);
    };

    updateScrollbarState();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollbarState) : undefined;
    resizeObserver?.observe(scrollableElement);
    resizeObserver?.observe(contentElement);
    window.addEventListener('resize', updateScrollbarState);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateScrollbarState);
    };
  }, [contentRef]);

  return hasScrollbar;
}

const ProjectInfoFoldableSection: FC<{
  sectionKey: string;
  title: string;
  children: ReactNode;
}> = ({ sectionKey, title, children }) => {
  const [sectionOpenState, setSectionOpenState] = useAtom(projectSettingsSectionOpenState);
  const isOpen = sectionOpenState[sectionKey] ?? false;
  const setIsOpen = (nextOpen: boolean) => {
    setSectionOpenState((state) => ({
      ...state,
      [sectionKey]: nextOpen,
    }));
  };

  return (
    <section className="project-info-item project-info-foldable">
      <Collapsible
        open={isOpen}
        handleTriggerClick={() => setIsOpen(!isOpen)}
        trigger={<ProjectInfoFoldableToggle label={title} />}
        triggerClassName="project-info-foldable-toggle-container"
        triggerOpenedClassName="project-info-foldable-toggle-container open"
        triggerWhenOpen={<ProjectInfoFoldableToggle label={title} isOpen />}
        transitionTime={150}
        easing="ease-out"
      >
        <div className="project-info-foldable-content">{children}</div>
      </Collapsible>
    </section>
  );
};

const ProjectInfoFoldableToggle: FC<{ isOpen?: boolean; label: string }> = ({ isOpen, label }) => (
  <div className="project-info-foldable-toggle-area">
    <button type="button" className="project-info-foldable-toggle">
      <span className="label">{label}</span>
      <span className="indicator">{isOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}</span>
    </button>
  </div>
);
