import assert from 'node:assert/strict';
import test from 'node:test';
import { fitBoundsToViewport, MAX_AUTO_FIT_ZOOM } from './useViewportBounds';

function withWindowSize<T>(width: number, height: number, run: () => T): T {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const originalWindow = globalThis.window;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: width,
      innerHeight: height,
    },
  });

  try {
    return run();
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

test('fitBoundsToViewport does not zoom in past the automatic fit cap for tiny graphs', () => {
  const position = withWindowSize(1600, 1000, () =>
    fitBoundsToViewport({
      x: 100,
      y: 200,
      width: 400,
      height: 300,
    }),
  );

  assert.equal(position.zoom, MAX_AUTO_FIT_ZOOM);
});

test('fitBoundsToViewport still zooms out when graph bounds are larger than the viewport', () => {
  const position = withWindowSize(800, 600, () =>
    fitBoundsToViewport({
      x: 0,
      y: 0,
      width: 1600,
      height: 600,
    }),
  );

  assert.equal(position.zoom, 0.5);
});

test('fitBoundsToViewport centers within the canvas height remaining below a fixed top row', () => {
  const { withInset, withoutInset } = withWindowSize(1000, 1000, () => {
    const bounds = {
      x: 0,
      y: 0,
      width: 400,
      height: 400,
    };

    return {
      withoutInset: fitBoundsToViewport(bounds),
      withInset: fitBoundsToViewport(bounds, { topInset: 40 }),
    };
  });

  assert.equal(withInset.x, withoutInset.x);
  assert.equal(withInset.y, withoutInset.y - 20);
});
