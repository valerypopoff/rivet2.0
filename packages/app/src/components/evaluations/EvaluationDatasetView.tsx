import Button from '@atlaskit/button';
import Textfield from '@atlaskit/textfield';
import { type EvaluationDataset, type EvaluationDatasetField } from '@valerypopoff/rivet2-evaluations';
import { nanoid } from 'nanoid/non-secure';
import { useEffect, useState, type FC } from 'react';
import { ScalableToggle } from '../ScalableToggle.js';
import { EvaluationSelect as Select } from './EvaluationSelect.js';
import { setEvaluationDatasetCaseEnabled } from './evaluationWorkspaceModel.js';

import {
  DatasetValueEditor,
  getEvaluationCaseGridTemplate,
  RemoveButton,
  updateDatasetCaseValue,
} from './evaluationPresentation.js';
export const Dataset: FC<{
  dataset?: EvaluationDataset;
  onAddCase: () => void;
  onInvalidDraftChange: (invalid: boolean) => void;
  onRemoveField: (fieldId: string) => void;
  onUpdate: (dataset: EvaluationDataset) => void;
}> = ({ dataset, onAddCase, onInvalidDraftChange, onRemoveField, onUpdate }) => {
  const [invalidCellIds, setInvalidCellIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setInvalidCellIds(new Set());
  }, [dataset?.id]);

  useEffect(() => {
    if (!dataset) return;
    const existingCellIds = new Set(
      dataset.cases.flatMap((testCase) => dataset.fields.map((field) => `${testCase.id}:${field.id}`)),
    );
    setInvalidCellIds((current) => {
      const next = new Set([...current].filter((cellId) => existingCellIds.has(cellId)));
      return next.size === current.size ? current : next;
    });
  }, [dataset]);

  useEffect(() => {
    onInvalidDraftChange(invalidCellIds.size > 0);
  }, [invalidCellIds, onInvalidDraftChange]);

  useEffect(
    () => () => {
      onInvalidDraftChange(false);
    },
    [onInvalidDraftChange],
  );

  if (!dataset) return <div className="empty">Select or create an evaluation dataset first.</div>;

  const caseGridTemplate = getEvaluationCaseGridTemplate(dataset.fields);
  const setCellInvalid = (cellId: string, invalid: boolean) => {
    setInvalidCellIds((current) => {
      if (current.has(cellId) === invalid) return current;
      const next = new Set(current);
      if (invalid) next.add(cellId);
      else next.delete(cellId);
      return next;
    });
  };
  const updateField = (fieldId: string, update: Partial<EvaluationDatasetField>) =>
    onUpdate({
      ...dataset,
      fields: dataset.fields.map((field) => (field.id === fieldId ? { ...field, ...update } : field)),
    });
  const addField = () =>
    onUpdate({
      ...dataset,
      fields: [
        ...dataset.fields,
        {
          id: nanoid(),
          name: `Field ${dataset.fields.length + 1}`,
          dataType: 'string',
          role: 'input',
          required: false,
        },
      ],
    });
  return (
    <>
      <section className="section">
        <div className="evaluation-dataset-intro" role="note">
          Evaluation datasets are reusable local Rivet resources. Graph input fields feed a suite’s target graph.
          Deterministic check reference fields provide values for visible quality checks; they do not judge a run on
          their own. Metadata travels only to evaluator graphs. JSON is lossless; CSV imports and exports typed JSON
          cell values against the current field definitions.
        </div>
      </section>
      <section className="section">
        <h3>Fields</h3>
        <table className="table evaluation-fields-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Rivet type</th>
              <th>Required</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {dataset.fields.map((field) => (
              <tr key={field.id}>
                <td>
                  <Textfield
                    value={field.name}
                    onChange={(event) => updateField(field.id, { name: event.currentTarget.value })}
                  />
                </td>
                <td>
                  <Select
                    options={[
                      { label: 'Graph input', value: 'input' },
                      { label: 'Deterministic check reference', value: 'expected' },
                      { label: 'Evaluator metadata', value: 'metadata' },
                    ]}
                    value={[
                      { label: 'Graph input', value: 'input' },
                      { label: 'Deterministic check reference', value: 'expected' },
                      { label: 'Evaluator metadata', value: 'metadata' },
                    ].find((option) => option.value === field.role)}
                    onChange={(value) =>
                      updateField(field.id, { role: value!.value as EvaluationDatasetField['role'] })
                    }
                  />
                </td>
                <td>
                  <Select
                    options={['string', 'number', 'boolean', 'object', 'string[]', 'object[]', 'any'].map(
                      (dataType) => ({ label: dataType, value: dataType }),
                    )}
                    value={{ label: field.dataType, value: field.dataType }}
                    onChange={(value) => updateField(field.id, { dataType: value!.value })}
                  />
                </td>
                <td className="evaluation-toggle-cell">
                  <ScalableToggle
                    aria-label={`${field.name} required`}
                    isChecked={field.required === true}
                    onChange={(event) => updateField(field.id, { required: event.currentTarget.checked })}
                  />
                </td>
                <td>
                  <RemoveButton label={`Remove ${field.name || 'field'}`} onClick={() => onRemoveField(field.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="evaluation-section-actions">
          <Button appearance="primary" onClick={addField}>
            + Add field
          </Button>
        </div>
      </section>
      <section className="section evaluation-dataset-table-section">
        <h3>Cases</h3>
        {dataset.cases.length > 0 ? (
          <div className="evaluation-cases">
            <div className="evaluation-case-header-row" style={{ gridTemplateColumns: caseGridTemplate }}>
              <span>Enabled</span>
              <span>Case</span>
              <span>Tags</span>
              <span>Notes</span>
              {dataset.fields.map((field) => (
                <div className="evaluation-case-field-heading" id={`evaluation-case-field-${field.id}`} key={field.id}>
                  <strong>
                    {field.name} <span className="evaluation-case-field-type">({field.dataType})</span>
                  </strong>
                </div>
              ))}
              <span />
            </div>
            {dataset.cases.map((testCase) => (
              <div className="evaluation-case-row" style={{ gridTemplateColumns: caseGridTemplate }} key={testCase.id}>
                <div className="evaluation-case-enabled-control">
                  <ScalableToggle
                    aria-label={`${testCase.name} enabled`}
                    isChecked={testCase.enabled !== false}
                    title="Ctrl/Cmd+click to enable or disable all cases"
                    onChange={(event) => {
                      const nativeEvent = event.nativeEvent as MouseEvent;
                      onUpdate(
                        setEvaluationDatasetCaseEnabled(
                          dataset,
                          testCase.id,
                          event.currentTarget.checked,
                          nativeEvent.ctrlKey || nativeEvent.metaKey,
                        ),
                      );
                    }}
                  />
                </div>
                <div className="evaluation-case-name-control">
                  <Textfield
                    aria-label={`${testCase.name} name`}
                    value={testCase.name}
                    onChange={(event) =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.map((candidate) =>
                          candidate.id === testCase.id ? { ...candidate, name: event.currentTarget.value } : candidate,
                        ),
                      })
                    }
                  />
                </div>
                <div className="evaluation-case-tags-control">
                  <Textfield
                    aria-label={`${testCase.name} tags`}
                    value={(testCase.tags ?? []).join(', ')}
                    placeholder="tag, regression"
                    onChange={(event) =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.map((candidate) =>
                          candidate.id === testCase.id
                            ? {
                                ...candidate,
                                tags: event.currentTarget.value
                                  .split(',')
                                  .map((tag) => tag.trim())
                                  .filter(Boolean),
                              }
                            : candidate,
                        ),
                      })
                    }
                  />
                </div>
                <div className="evaluation-case-notes-control">
                  <Textfield
                    aria-label={`${testCase.name} notes`}
                    value={testCase.note ?? ''}
                    placeholder="Optional note"
                    onChange={(event) =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.map((candidate) =>
                          candidate.id === testCase.id
                            ? { ...candidate, note: event.currentTarget.value || undefined }
                            : candidate,
                        ),
                      })
                    }
                  />
                </div>
                {dataset.fields.map((field) => (
                  <div
                    className="evaluation-case-value-field"
                    role="group"
                    aria-labelledby={`evaluation-case-field-${field.id}`}
                    key={field.id}
                  >
                    <DatasetValueEditor
                      dataType={field.dataType}
                      value={testCase.values[field.id]}
                      onCommit={(value) => onUpdate(updateDatasetCaseValue(dataset, testCase.id, field.id, value))}
                      onValidityChange={(invalid) => setCellInvalid(`${testCase.id}:${field.id}`, invalid)}
                    />
                  </div>
                ))}
                <div className="evaluation-case-actions">
                  <RemoveButton
                    label={`Remove ${testCase.name || 'case'}`}
                    onClick={() =>
                      onUpdate({
                        ...dataset,
                        cases: dataset.cases.filter((candidate) => candidate.id !== testCase.id),
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">No cases yet. Add a case and give every bound input a portable JSON value.</p>
        )}
        <div className="evaluation-section-actions">
          <Button appearance="primary" onClick={onAddCase}>
            + Add case
          </Button>
        </div>
      </section>
    </>
  );
};
