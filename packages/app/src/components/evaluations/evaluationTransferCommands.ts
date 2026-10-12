import { nanoid } from 'nanoid/non-secure';
import {
  deserializeEvaluationDatasetJson,
  deserializeEvaluationSuiteBundleJson,
  serializeEvaluationDatasetJson,
  serializeEvaluationSuiteBundleJson,
  type EvaluationDataset,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import type { IOProvider } from '../../io/IOProvider.js';
import type { EvaluationsState } from '../../state/evaluations.js';
import { replaceEvaluationDatasetCasesFromCsv, serializeEvaluationDatasetCsv } from './evaluationDatasetCsv.js';
import {
  addEvaluationDataset,
  addEvaluationSuite,
  replaceEvaluationDataset,
  type EvaluationLibraryOutcome,
} from './evaluationLibraryCommands.js';
import type { EvaluationCommandNotice } from './evaluationRunCommands.js';

/** IO and library coordination live here; React owns the dialogs and notices. */
export function createEvaluationTransferCommands({
  io,
  setState,
  isCurrent,
  onNotice,
}: {
  io: Pick<IOProvider, 'readFileAsString' | 'saveString'>;
  setState: (update: (current: EvaluationsState) => EvaluationsState) => void;
  isCurrent: () => boolean;
  onNotice: (notice: EvaluationCommandNotice) => void;
}) {
  const importFile = async (
    label: string,
    apply: (current: EvaluationsState, source: string, fileName: string) => EvaluationLibraryOutcome,
  ) => {
    try {
      await io.readFileAsString((source, fileName) => {
        try {
          let outcome: EvaluationLibraryOutcome | undefined;
          setState((current) => {
            outcome = apply(current, source, fileName);
            return outcome.state;
          });
          if (outcome)
            onNotice({
              kind: outcome.kind,
              message: outcome.message ?? `Imported ${label} from ${fileName}.`,
            });
        } catch (error) {
          onNotice({
            kind: 'failed',
            message: `Could not import ${label}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
    } catch (error) {
      onNotice({
        kind: 'failed',
        message: `Could not open ${label} file: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  const exportFile = async (label: string, serialize: () => string, fileName: string) => {
    try {
      await io.saveString(serialize(), fileName);
    } catch (error) {
      onNotice({
        kind: 'failed',
        message: `Could not export ${label}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };
  return {
    importDataset: () =>
      importFile('evaluation dataset', (current, source) =>
        addEvaluationDataset(current, deserializeEvaluationDatasetJson(source, { id: nanoid() }), isCurrent()),
      ),
    importSuite: () =>
      importFile('evaluation suite and dataset', (current, source) => {
        const imported = deserializeEvaluationSuiteBundleJson(source, { suiteId: nanoid(), datasetId: nanoid() });
        return addEvaluationSuite(current, imported.suite, imported.dataset, isCurrent());
      }),
    replaceDataset: (destination: EvaluationDataset) =>
      importFile('evaluation dataset', (current, source, fileName) =>
        replaceEvaluationDataset(
          current,
          destination,
          /\.csv$/iu.test(fileName)
            ? replaceEvaluationDatasetCasesFromCsv(destination, source)
            : deserializeEvaluationDatasetJson(source, { id: destination.id }),
        ),
      ),
    exportSuite: (suite: EvaluationSuite, dataset: EvaluationDataset) =>
      exportFile(
        'the evaluation suite',
        () => serializeEvaluationSuiteBundleJson(suite, dataset),
        `${suite.name || 'evaluation-suite'}.rivet-evaluation-suite.json`,
      ),
    exportDataset: (dataset: EvaluationDataset, format: 'json' | 'csv') =>
      exportFile(
        'the evaluation dataset',
        () => (format === 'csv' ? serializeEvaluationDatasetCsv(dataset) : serializeEvaluationDatasetJson(dataset)),
        `${dataset.name || 'evaluation-dataset'}.${format === 'csv' ? 'csv' : 'evaluation.json'}`,
      ),
  };
}
