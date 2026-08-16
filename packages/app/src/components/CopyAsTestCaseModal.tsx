import Modal, { ModalTransition, ModalBody, ModalFooter } from '@atlaskit/modal-dialog';
import { type FC, useEffect, useMemo, useState } from 'react';
import { LazyCodeEditor } from './LazyComponents';
import { useAtomValue, useAtom, useSetAtom } from 'jotai';
import { lastRunDataByNodeState } from '../state/dataFlow';
import { graphState } from '../state/graph';
import { projectState } from '../state/savedGraphs.js';
import { type BuiltInNodes, type GraphInputNode, type PortId } from '@valerypopoff/rivet2-core';
import { max, range } from 'lodash-es';
import { css } from '@emotion/react';
import { evaluationsState } from '../state/evaluations';
import Button from '@atlaskit/button';
import { overlayOpenState } from '../state/ui';
import { useDataRefs } from '../providers/ProvidersContext.js';
import { restoreStoredPortValue } from '../utils/executionDataReaders.js';
import { AppModalHeader } from './AppModalHeader';
import { EvaluationFormField } from './evaluations/EvaluationFormField.js';
import { EvaluationSelect as Select } from './evaluations/EvaluationSelect.js';

const body = css`
  display: flex;
  flex-direction: column;
  gap: 20px;

  .evaluation-modal-intro {
    margin: 0;
    color: var(--grey-light);
    line-height: 1.5;
  }

  .evaluation-modal-fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
  }

  .preview {
    min-height: 320px;
  }

  .editor-container {
    min-height: 280px;
  }
`;

export const AddRunInputsToEvaluationModal: FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => {
  const lastRunData = useAtomValue(lastRunDataByNodeState);
  const graph = useAtomValue(graphState);
  const project = useAtomValue(projectState);
  const [selectedExecutionNum, setSelectedExecutionNum] = useState(1);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | undefined>(undefined);
  const [{ data, datasets }, setEvaluationsState] = useAtom(evaluationsState);
  const setOverlay = useSetAtom(overlayOpenState);
  const dataRefs = useDataRefs();

  const inputNodes = graph.nodes.filter((n) => (n as BuiltInNodes).type === 'graphInput') as GraphInputNode[];
  const lastRunDataForInputNodes = inputNodes.map((n) => lastRunData[n.id]);

  const numExecutions =
    max(
      lastRunDataForInputNodes.map((data) => {
        if (data == null) {
          return 0;
        }

        return data.length;
      }),
    ) ?? 0;

  const executionNumOptions = range(0, numExecutions).map((_, i) => ({
    label: `${i + 1}`,
    value: i + 1,
  }));

  const asJson = inputNodes.reduce(
    (acc, node) => {
      const data = lastRunData[node.id]?.[selectedExecutionNum - 1];
      if (data == null) {
        return acc;
      }

      return {
        ...acc,
        [node.data.id]: restoreStoredPortValue(data.data.outputData, 'data' as PortId, dataRefs)?.value ?? null,
      };
    },
    {} as Record<string, unknown>,
  );

  const suiteOptions = useMemo(
    () =>
      data.suites
        .filter((suite) =>
          datasets.some((dataset) => dataset.id === suite.datasetId && dataset.projectId === project.metadata.id),
        )
        .map((suite) => ({ label: suite.name, value: suite.id })),
    [data.suites, datasets, project.metadata.id],
  );

  useEffect(() => {
    if (!open) return;
    setSelectedExecutionNum(1);
    setSelectedSuiteId((current) =>
      current != null && suiteOptions.some((suite) => suite.value === current) ? current : suiteOptions[0]?.value,
    );
  }, [open, suiteOptions]);

  const addInputsToDataset = () => {
    if (selectedSuiteId == null) {
      return;
    }
    const suite = data.suites.find((candidate) => candidate.id === selectedSuiteId);
    const dataset = datasets.find(
      (candidate) => candidate.id === suite?.datasetId && candidate.projectId === project.metadata.id,
    );
    if (!suite || !dataset) return;
    const values = Object.fromEntries(
      suite.inputBindings.flatMap((binding) =>
        binding.graphInputId in asJson ? [[binding.datasetFieldId, asJson[binding.graphInputId] as never]] : [],
      ),
    );
    setEvaluationsState((state) => ({
      ...state,
      data: { ...state.data, selectedSuiteId, selectedDatasetId: undefined },
      datasets: state.datasets.map((candidate) =>
        candidate.id === dataset.id && candidate.projectId === project.metadata.id
          ? {
              ...candidate,
              cases: [
                ...candidate.cases,
                {
                  id: crypto.randomUUID(),
                  name: `Recorded input ${candidate.cases.length + 1}`,
                  enabled: true,
                  values,
                },
              ],
            }
          : candidate,
      ),
    }));
    setOverlay('evaluations');
    onClose();
  };

  return (
    <ModalTransition>
      {open && (
        <Modal onClose={onClose} width="large">
          <AppModalHeader title="Add run inputs to evaluation dataset" onClose={onClose} />
          <ModalBody>
            {numExecutions === 0 ? (
              <p>Could not find any graph input nodes that have executed.</p>
            ) : (
              <div css={body}>
                <p className="evaluation-modal-intro">
                  Choose the recorded graph execution and the suite whose assigned dataset should receive the case.
                </p>
                <div className="evaluation-modal-fields">
                  {executionNumOptions.length > 1 && (
                    <EvaluationFormField label="Graph execution">
                      <Select
                        options={executionNumOptions}
                        value={executionNumOptions.find((option) => option.value === selectedExecutionNum)}
                        onChange={(value) => value && setSelectedExecutionNum(value.value)}
                      />
                    </EvaluationFormField>
                  )}
                  <EvaluationFormField label="Evaluation suite">
                    <Select
                      options={suiteOptions}
                      value={suiteOptions.find((option) => option.value === selectedSuiteId)}
                      placeholder={suiteOptions.length === 0 ? 'Create an evaluation suite first' : 'Select a suite'}
                      onChange={(value) => setSelectedSuiteId(value?.value)}
                    />
                  </EvaluationFormField>
                </div>

                <EvaluationFormField
                  className="preview"
                  label="Recorded inputs"
                  description="These values will become a new case in the dataset assigned to the selected suite."
                >
                  <LazyCodeEditor text={JSON.stringify(asJson, null, 2)} language="json" isReadonly />
                </EvaluationFormField>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button onClick={onClose}>Close</Button>
            <Button
              appearance="primary"
              isDisabled={numExecutions === 0 || selectedSuiteId == null}
              onClick={addInputsToDataset}
            >
              Add inputs
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};
