import { parse as parseCsv } from 'csv-parse/browser/esm/sync';
import { stringify as stringifyCsv } from 'csv-stringify/browser/esm/sync';
import {
  assertEvaluationDatasetValuesMatchDeclaredTypes,
  isEvaluationValueCompatibleWithDataType,
  type EvaluationDataset,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';

const fixedColumns = ['__case_id', '__case_name', '__enabled', '__tags', '__note'] as const;

export function serializeEvaluationDatasetCsv(dataset: EvaluationDataset): string {
  assertEvaluationDatasetValuesMatchDeclaredTypes(dataset);
  const columns = [...fixedColumns, ...dataset.fields.map((field) => `field:${field.id}`)];
  const rows = dataset.cases.map((testCase) => [
    testCase.id,
    testCase.name,
    testCase.enabled === false ? 'false' : 'true',
    JSON.stringify(testCase.tags ?? []),
    testCase.note ?? '',
    ...dataset.fields.map((field) =>
      testCase.values[field.id] === undefined ? '' : JSON.stringify(testCase.values[field.id]),
    ),
  ]);
  return stringifyCsv([columns, ...rows]);
}

function parseJsonCell(source: string, rowNumber: number, label: string): PortableJson {
  try {
    return JSON.parse(source) as PortableJson;
  } catch {
    throw new Error(`CSV row ${rowNumber} has invalid JSON for "${label}".`);
  }
}

/**
 * Replaces only case rows. The current field definitions are authoritative so
 * a CSV cannot silently rename, reorder, add, or mistype a bound field.
 */
export function replaceEvaluationDatasetCasesFromCsv(
  dataset: EvaluationDataset,
  source: string,
): EvaluationDataset {
  // The current schema is the import contract; do not build new case rows on
  // top of a field type that this portable format cannot represent.
  assertEvaluationDatasetValuesMatchDeclaredTypes({ ...dataset, cases: [] });
  let rows: string[][];
  try {
    rows = parseCsv(source, { skip_empty_lines: true }) as string[][];
  } catch (error) {
    throw new Error(`Evaluation CSV is not valid CSV: ${error instanceof Error ? error.message : String(error)}`);
  }

  const [headers, ...caseRows] = rows;
  if (!headers) throw new Error('Evaluation CSV must contain a header row.');
  const expectedColumns = [...fixedColumns, ...dataset.fields.map((field) => `field:${field.id}`)];
  if (headers.length !== expectedColumns.length || headers.some((column, index) => column !== expectedColumns[index])) {
    throw new Error(
      'Evaluation CSV columns must exactly match the current dataset. Export this dataset first to get the correct columns.',
    );
  }

  const ids = new Set<string>();
  const cases = caseRows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    if (row.length !== expectedColumns.length) {
      throw new Error(`CSV row ${rowNumber} must contain exactly ${expectedColumns.length} columns.`);
    }

    const id = row[0]!.trim();
    const name = row[1]!.trim();
    if (!id || !name) throw new Error(`CSV row ${rowNumber} needs both a case id and case name.`);
    if (ids.has(id)) throw new Error(`CSV row ${rowNumber} repeats case id "${id}".`);
    ids.add(id);

    const enabledSource = row[2]!.trim().toLowerCase();
    if (enabledSource !== 'true' && enabledSource !== 'false') {
      throw new Error(`CSV row ${rowNumber} enabled value must be true or false.`);
    }

    const tagsSource = row[3]!.trim();
    const parsedTags = tagsSource === '' ? [] : parseJsonCell(tagsSource, rowNumber, 'tags');
    if (!Array.isArray(parsedTags) || parsedTags.some((tag) => typeof tag !== 'string')) {
      throw new Error(`CSV row ${rowNumber} tags must be a JSON array of strings.`);
    }
    const tags = parsedTags as string[];

    const values: Record<string, PortableJson> = {};
    dataset.fields.forEach((field, fieldIndex) => {
      const sourceValue = row[fixedColumns.length + fieldIndex]!;
      if (sourceValue === '') return;
      const value = parseJsonCell(sourceValue, rowNumber, field.name);
      if (!isEvaluationValueCompatibleWithDataType(value, field.dataType)) {
        throw new Error(
          `CSV row ${rowNumber} value for "${field.name}" is not compatible with declared type "${field.dataType}".`,
        );
      }
      values[field.id] = value;
    });

    return {
      id,
      name,
      enabled: enabledSource === 'true',
      tags,
      ...(row[4] === '' ? {} : { note: row[4] }),
      values,
    };
  });

  return { ...dataset, cases };
}
