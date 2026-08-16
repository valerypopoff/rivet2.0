import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import Textfield from '@atlaskit/textfield';
import { css } from '@emotion/react';
import type { EvaluationDataset } from '@valerypopoff/rivet2-evaluations';
import { type FC, useEffect, useMemo, useState } from 'react';
import { AppModalHeader } from '../AppModalHeader.js';
import { EvaluationFormField } from './EvaluationFormField.js';
import { EvaluationSelect as Select } from './EvaluationSelect.js';

const NEW_DATASET = '__new_evaluation_dataset__';

const modalBodyStyles = css`
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin: 0;

  .evaluation-modal-intro {
    margin: 0;
    color: var(--grey-light);
    line-height: 1.5;
  }

  .evaluation-modal-fields {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
`;

export type CreateEvaluationSuiteValue = {
  datasetId?: string;
  graphId: string;
  name: string;
};

export const CreateEvaluationSuiteModal: FC<{
  datasets: readonly EvaluationDataset[];
  graphOptions: ReadonlyArray<{ label: string; value: string }>;
  initialGraphId?: string;
  open: boolean;
  onClose: () => void;
  onCreate: (value: CreateEvaluationSuiteValue) => void;
}> = ({ datasets, graphOptions, initialGraphId, open, onClose, onCreate }) => {
  const defaultGraphId = graphOptions.some((option) => option.value === initialGraphId)
    ? initialGraphId!
    : graphOptions[0]?.value ?? '';
  const [name, setName] = useState('New evaluation suite');
  const [graphId, setGraphId] = useState(defaultGraphId);
  const [datasetSelection, setDatasetSelection] = useState(NEW_DATASET);
  const datasetOptions = useMemo(
    () => [
      { label: 'Create a new evaluation dataset', value: NEW_DATASET },
      ...datasets.map((dataset) => ({ label: dataset.name, value: dataset.id })),
    ],
    [datasets],
  );

  useEffect(() => {
    if (!open) return;
    setName('New evaluation suite');
    setGraphId(defaultGraphId);
    setDatasetSelection(NEW_DATASET);
  }, [defaultGraphId, open]);

  const createSuite = () => {
    if (name.trim() === '' || graphId === '') return;
    onCreate({
      name: name.trim(),
      graphId,
      ...(datasetSelection === NEW_DATASET ? {} : { datasetId: datasetSelection }),
    });
  };

  return (
    <ModalTransition>
      {open ? (
        <Modal onClose={onClose} width="medium">
          <AppModalHeader title="Create evaluation suite" onClose={onClose} />
          <ModalBody>
            <form
              css={modalBodyStyles}
              onSubmit={(event) => {
                event.preventDefault();
                createSuite();
              }}
            >
              <p className="evaluation-modal-intro">
                Choose the graph and dataset contract before the suite is added to the project.
              </p>
              <div className="evaluation-modal-fields">
                <EvaluationFormField label="Suite name">
                  <Textfield value={name} onChange={(event) => setName(event.currentTarget.value)} />
                </EvaluationFormField>
                <EvaluationFormField label="Target graph">
                  <Select
                    options={graphOptions}
                    value={graphOptions.find((option) => option.value === graphId)}
                    onChange={(value) => setGraphId(value?.value ?? '')}
                  />
                </EvaluationFormField>
                <EvaluationFormField
                  label="Evaluation dataset"
                  description="Create a dataset with this suite, or reuse another dataset from the active project."
                >
                  <Select
                    options={datasetOptions}
                    value={datasetOptions.find((option) => option.value === datasetSelection)}
                    onChange={(value) => setDatasetSelection(value?.value ?? NEW_DATASET)}
                  />
                </EvaluationFormField>
              </div>
            </form>
          </ModalBody>
          <ModalFooter>
            <Button appearance="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" isDisabled={name.trim() === '' || graphId === ''} onClick={createSuite}>
              Create suite
            </Button>
          </ModalFooter>
        </Modal>
      ) : null}
    </ModalTransition>
  );
};
