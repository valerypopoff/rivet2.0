import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ReportProgressNodeImpl, type GraphProgress, type Inputs, type PortId } from '../../../src/index.js';

void describe('ReportProgressNodeImpl', () => {
  void it('reports configured progress and passes its sequencing value through unchanged', async () => {
    const node = new ReportProgressNodeImpl({
      ...ReportProgressNodeImpl.create(),
      data: { message: 'Preparing result', percent: 25, useMessageInput: false, usePercentInput: false },
    });
    const progress: GraphProgress[] = [];
    const value = { type: 'string', value: 'continue' } as const;

    const outputs = await node.process(
      { value } as Inputs,
      { reportProgress: (report: GraphProgress) => progress.push(report) } as never,
    );

    assert.deepEqual(progress, [{ message: 'Preparing result', percent: 25 }]);
    assert.equal(outputs['value' as PortId], value);
    assert.equal(node.getInputDefinitions()[0]?.required, true);
  });

  void it('uses connected message and percent values when their input toggles are enabled', async () => {
    const node = new ReportProgressNodeImpl(ReportProgressNodeImpl.create());
    const progress: GraphProgress[] = [];

    await node.process(
      {
        message: { type: 'string', value: 'Generating' },
        percent: { type: 'number', value: 60 },
        value: { type: 'any', value: null },
      } as Inputs,
      { reportProgress: (report: GraphProgress) => progress.push(report) } as never,
    );

    assert.deepEqual(progress, [{ message: 'Generating', percent: 60 }]);
  });
});
