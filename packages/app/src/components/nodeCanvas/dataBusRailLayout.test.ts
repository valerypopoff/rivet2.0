import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_BUS_FULL_ROW_HEIGHT_PX, getDataBusFullRowsHeight } from './dataBusRailLayout.js';

test('reserves one fixed-height row for every pinned bus', () => {
  assert.equal(DATA_BUS_FULL_ROW_HEIGHT_PX, 50);
  assert.equal(getDataBusFullRowsHeight({ rowCount: 0, uiFontScale: 1 }), 0);
  assert.equal(getDataBusFullRowsHeight({ rowCount: 3, uiFontScale: 1 }), 150);
  assert.equal(getDataBusFullRowsHeight({ rowCount: 3, uiFontScale: 1.25 }), 187.5);
  assert.equal(getDataBusFullRowsHeight({ rowCount: Number.NaN, uiFontScale: 1 }), 0);
});
