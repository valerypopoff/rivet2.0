import { useMemo, useState, type FC } from 'react';
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
import Modal, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { AppModalHeader } from './AppModalHeader';
import Button from '@atlaskit/button';
import { ProjectContextConfiguration } from './ProjectContextConfiguration';
import { ProjectKnowledgeStoresConfiguration } from './ProjectKnowledgeStoresConfiguration';
import { ProjectLLMProfileHealthConfiguration } from './ProjectLLMProfileHealthConfiguration';
import { ProjectGlobalVariablesConfiguration } from './ProjectGlobalVariablesConfiguration';
import { useIOProvider, useLLMProfileHealthAdmin } from '../providers/ProvidersContext';
import { fields } from './settings/settingsPageStyles';
import { modalBody, SETTINGS_MODAL_HEIGHT, SettingsNavButton } from './SettingsModal';
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

  .project-info-item {
    min-width: 0;
    margin: 0;

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

`;

const projectSettingsPages = [
  { id: 'general', label: 'General' },
  { id: 'mcp', label: 'MCP' },
  { id: 'knowledge-stores', label: 'Knowledge stores' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'context-values', label: 'Context values' },
  { id: 'other', label: 'Other' },
] as const;

type ProjectSettingsPage = (typeof projectSettingsPages)[number]['id'];

const projectSettingsModalScrollContainerOverrides = css`
  [data-testid='project-settings-modal--scrollable'] {
    min-height: 0;
    overflow: hidden;
  }

  [data-testid='project-settings-modal--body'] {
    display: flex;
    min-height: 0;
    min-width: 0;
  }
`;

const projectSettingsModalBody = css`
  ${modalBody};

  grid-template-columns: 180px minmax(0, 1fr);

  main {
    padding: 0 16px 20px;
  }
`;

export const ProjectInfoPanel: FC<{ page: ProjectSettingsPage }> = ({ page }) => {
  const [project, setProject] = useAtom(projectState);
  const savedGraphs = useAtomValue(savedGraphsState);
  const ioProvider = useIOProvider();
  const llmProfileHealthAdmin = useLLMProfileHealthAdmin();
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
    <div css={[fields, styles]} className="project-info-section">
      {page === 'general' && (
        <>
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

          <div className="project-info-item">
            <ProjectGlobalVariablesConfiguration />
          </div>
        </>
      )}

      {page === 'mcp' && (
        <div className="project-info-item">
          <ProjectMCPConfiguration />
        </div>
      )}

      {page === 'knowledge-stores' && (
        <div className="project-info-item">
          <ProjectKnowledgeStoresConfiguration />
        </div>
      )}

      {page === 'plugins' && (
        <ProjectPluginsConfiguration />
      )}

      {page === 'context-values' && (
        <ProjectContextConfiguration />
      )}

      {page === 'other' && (
        <>
          {llmProfileHealthAdmin && (
            <div className="project-info-item">
              <ProjectLLMProfileHealthConfiguration />
            </div>
          )}

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
        </>
      )}
    </div>
  );
};

export const ProjectInfoModal: FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const [page, setPage] = useState<ProjectSettingsPage>('general');

  return (
    <ModalTransition>
      {isOpen && (
        <Modal onClose={onClose} width="40%" height={SETTINGS_MODAL_HEIGHT} testId="project-settings-modal">
          <Global styles={projectSettingsModalScrollContainerOverrides} />
          <AppModalHeader title="Project settings" onClose={onClose} />
          <ModalBody>
            <div css={projectSettingsModalBody}>
              <aside className="settings-modal-sidebar">
                <nav className="settings-modal-nav" aria-label="Project settings">
                  {projectSettingsPages.map(({ id, label }) => (
                    <SettingsNavButton key={id} isSelected={page === id} onClick={() => setPage(id)}>
                      {label}
                    </SettingsNavButton>
                  ))}
                </nav>
              </aside>
              <main>
                <ProjectInfoPanel page={page} />
              </main>
            </div>
          </ModalBody>
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
