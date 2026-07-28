import assert from 'node:assert/strict';
import test from 'node:test';
import { getDataBusCompactMaxWidth, getDataBusFullRowsHeight, shouldUseDataBusFullRow } from './dataBusRailLayout.js';

test('reserves one fixed-height row for every pinned bus', () => {
  assert.equal(getDataBusFullRowsHeight({ rowCount: 0, uiFontScale: 1 }), 0);
  assert.equal(getDataBusFullRowsHeight({ rowCount: 3, uiFontScale: 1 }), 129);
  assert.equal(getDataBusFullRowsHeight({ rowCount: 3, uiFontScale: 1.25 }), 161.25);
  assert.equal(getDataBusFullRowsHeight({ rowCount: Number.NaN, uiFontScale: 1 }), 0);
});

test('uses the fixed compact cap on a wide viewport', () => {
  assert.equal(getDataBusCompactMaxWidth({ uiFontScale: 1, viewportWidth: 1600 }), 760);
  assert.equal(
    shouldUseDataBusFullRow({
      groupContentWidths: [749],
      uiFontScale: 1,
      viewportWidth: 1600,
    }),
    false,
  );
  assert.equal(
    shouldUseDataBusFullRow({
      groupContentWidths: [750],
      uiFontScale: 1,
      viewportWidth: 1600,
    }),
    true,
  );
});

test('uses the viewport-relative compact cap on a narrow viewport', () => {
  assert.equal(getDataBusCompactMaxWidth({ uiFontScale: 1, viewportWidth: 800 }), 560);
  assert.equal(
    shouldUseDataBusFullRow({
      groupContentWidths: [550],
      uiFontScale: 1,
      viewportWidth: 800,
    }),
    true,
  );
});

test('scales the fixed compact cap with the editor font scale', () => {
  assert.equal(getDataBusCompactMaxWidth({ uiFontScale: 1.25, viewportWidth: 2000 }), 950);
  assert.equal(
    shouldUseDataBusFullRow({
      groupContentWidths: [935],
      uiFontScale: 1.25,
      viewportWidth: 2000,
    }),
    false,
  );
  assert.equal(
    shouldUseDataBusFullRow({
      groupContentWidths: [937],
      uiFontScale: 1.25,
      viewportWidth: 2000,
    }),
    true,
  );
});

test('promotes multiple compact buses when their combined shelf width exceeds the cap', () => {
  assert.equal(
    shouldUseDataBusFullRow({
      groupContentWidths: [370, 370],
      uiFontScale: 1,
      viewportWidth: 1600,
    }),
    false,
  );
  assert.equal(
    shouldUseDataBusFullRow({
      groupContentWidths: [380, 380],
      uiFontScale: 1,
      viewportWidth: 1600,
    }),
    true,
  );
});
