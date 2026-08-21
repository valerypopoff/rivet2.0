import Popup from '@atlaskit/popup';
import { css } from '@emotion/react';
import { exportGentraceEvaluationRun } from '@valerypopoff/rivet2-core';
import { useToggle } from 'ahooks';
import clsx from 'clsx';
import EditPen from 'majesticons/line/edit-pen-2-line.svg?react';
import Share from 'majesticons/line/share-line.svg?react';
import { useAtomValue } from 'jotai';
import { toast } from 'react-toastify';

import GentraceImage from '../../assets/vendor_logos/gentrace.svg?react';
import { graphState } from '../../state/graph.js';
import { projectState } from '../../state/savedGraphs.js';
import { settingsState } from '../../state/settings.js';
import { evaluationsState } from '../../state/evaluations.js';
import { useEvaluationRunStore } from '../../providers/ProvidersContext.js';
import { PopupMenuContainer } from '../PopupMenu.js';
import GentracePipelinePicker, { type GentracePipeline } from './GentracePipelinePicker.js';

/**
 * Gentrace is a reporter for complete Evaluations, never a second graph-run
 * path. The generic evaluation runner owns case scheduling, evaluator graphs,
 * accounting, cancellation, and recording retention.
 */
export const GentraceInteractors = () => {
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const savedSettings = useAtomValue(settingsState);
  const evaluations = useAtomValue(evaluationsState);
  const evaluationRunStore = useEvaluationRunStore();
  const [gentracePipelineSelectorOpen, toggleGentracePipelineSelectorOpen] = useToggle(false);

  const gentracePipelineSettings = graph?.metadata?.attachedData?.gentracePipeline as GentracePipeline | undefined;
  const currentGentracePipelineSlug = gentracePipelineSettings?.slug;
  const gentraceApiKey = savedSettings.pluginSettings?.gentrace?.gentraceApiKey as string | undefined;

  const exportLatestEvaluation = async () => {
    const graphId = graph.metadata?.id;
    if (!graphId) return;
    if (!gentraceApiKey) {
      toast.warn('Set the Gentrace API key in Plugin settings before exporting an evaluation.');
      return;
    }
    if (!currentGentracePipelineSlug) {
      toast.warn('Associate a Gentrace pipeline before exporting an evaluation.');
      return;
    }

    const suiteIds = new Set(
      evaluations.data.suites.filter((suite) => suite.targetGraphId === graphId).map((suite) => suite.id),
    );
    const knownRuns = evaluations.runs.length > 0
      ? evaluations.runs
      : await evaluationRunStore.list({ projectId: project.metadata.id });
    const run = knownRuns
      .filter((candidate) => suiteIds.has(candidate.suiteId) && candidate.executionStatus === 'completed')
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (!run) {
      toast.info('Run a completed Evaluation for this graph before exporting to Gentrace.');
      return;
    }

    try {
      const response = await exportGentraceEvaluationRun({
        gentraceApiKey,
        pipelineSlug: currentGentracePipelineSlug,
        run,
      });
      const resultId = response.resultId ?? response.pipelineRunId;
      const link = resultId == null || !gentracePipelineSettings?.id
        ? undefined
        : `https://gentrace.ai/pipeline/${gentracePipelineSettings.id}/results/${resultId}`;
      toast.success(
        <div>
          <div>Exported evaluation “{run.suiteName}” to Gentrace.</div>
          {link && <a href={link} target="_blank" rel="noreferrer">Open Gentrace result</a>}
        </div>,
      );
    } catch (error) {
      toast.error(`Could not export the evaluation to Gentrace: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <>
      <Popup
        isOpen={gentracePipelineSelectorOpen}
        onClose={toggleGentracePipelineSelectorOpen.setLeft}
        popupComponent={PopupMenuContainer}
        content={() => <GentracePipelinePicker onClose={toggleGentracePipelineSelectorOpen.setLeft} />}
        placement="bottom-end"
        trigger={(triggerProps) => (
          <div className={clsx('run-gentrace-button')}>
            <button
              {...triggerProps}
              onMouseDown={(event) => {
                if (event.button === 0) {
                  toggleGentracePipelineSelectorOpen.toggle();
                  event.preventDefault();
                }
              }}
              css={css`
                display: flex;
                align-items: center;
                justify-content: center;
              `}
            >
              <GentraceImage height="17px" width="17px" />
              {currentGentracePipelineSlug ? 'Change' : 'Add'} Gentrace pipeline
              <EditPen />
            </button>
          </div>
        )}
      />

      <div className={clsx('run-gentrace-button')}>
        <button onClick={() => void exportLatestEvaluation()}>
          <GentraceImage height="17px" width="17px" />
          Export latest evaluation
          <Share />
        </button>
      </div>
    </>
  );
};
