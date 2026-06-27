import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toast, type Id as ToastId } from 'react-toastify';
import { handleError, isIgnoredBrowserError, wrapAsync } from './errorHandling.js';

type ToastWithMutableError = typeof toast & {
  error: typeof toast.error;
};

const mutableToast = toast as ToastWithMutableError;
const originalToastError = mutableToast.error;
const originalConsoleError = console.error;

function filterRelevantConsoleErrors(logged: unknown[]): unknown[] {
  return logged.filter((entry) => {
    if (!Array.isArray(entry) || entry.length === 0) {
      return true;
    }

    const [firstArg] = entry;
    return !(typeof firstArg === 'string' && firstArg.includes('[DEP0040] DeprecationWarning'));
  });
}

function createToastErrorStub(onToast: (message: string) => void): typeof toast.error {
  return ((content) => {
    onToast(typeof content === 'string' ? content : String(content ?? ''));
    return 'test-toast-id' as ToastId;
  }) as typeof toast.error;
}

afterEach(() => {
  mutableToast.error = originalToastError;
  console.error = originalConsoleError;
});

describe('errorHandling', { concurrency: false }, () => {
  test('logs structured metadata when provided', () => {
    const logged: unknown[] = [];
    const toasted: string[] = [];

    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    mutableToast.error = createToastErrorStub((message) => {
      toasted.push(message);
    });

    handleError(new Error('boom'), 'Structured error test', {
      metadata: {
        projectId: 'project-1',
        graphId: 'graph-1',
      },
    });

    const relevantLogged = filterRelevantConsoleErrors(logged);

    assert.equal(toasted.length, 1);
    assert.equal(toasted[0], 'Structured error test: boom');
    assert.equal(relevantLogged.length, 1);
    assert.deepEqual(relevantLogged[0], [
      '[Structured error test]',
      {
        error: new Error('boom'),
        metadata: {
          projectId: 'project-1',
          graphId: 'graph-1',
        },
      },
    ]);
  });

  test('dedupes repeated toast messages within the dedupe window', () => {
    const toasted: string[] = [];

    console.error = () => {};
    mutableToast.error = createToastErrorStub((message) => {
      toasted.push(message);
    });

    handleError(new Error('duplicate'), 'Deduped error test');
    handleError(new Error('duplicate'), 'Deduped error test');

    assert.deepEqual(toasted, ['Deduped error test: duplicate']);
  });

  test('can suppress toast emission while still logging', () => {
    const logged: unknown[] = [];
    const toasted: string[] = [];

    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    mutableToast.error = createToastErrorStub((message) => {
      toasted.push(message);
    });

    handleError(new Error('silent'), 'Silent error test', {
      metadata: {
        requestId: 'request-1',
      },
      toastError: false,
    });

    const relevantLogged = filterRelevantConsoleErrors(logged);

    assert.equal(toasted.length, 0);
    assert.equal(relevantLogged.length, 1);
  });

  test('recognizes benign ResizeObserver browser loop warnings', () => {
    assert.equal(isIgnoredBrowserError('ResizeObserver loop completed with undelivered notifications.'), true);
    assert.equal(isIgnoredBrowserError(new Error('ResizeObserver loop limit exceeded')), true);
    assert.equal(
      isIgnoredBrowserError({ message: 'ResizeObserver loop completed with undelivered notifications.' }),
      true,
    );
    assert.equal(isIgnoredBrowserError(new Error('webview not found: invalid label or it was closed')), true);
    assert.equal(isIgnoredBrowserError(new Error('real layout failure')), false);
  });

  test('wrapAsync resolves structured error options from handler arguments', async () => {
    const logged: unknown[] = [];
    const toasted: string[] = [];

    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    mutableToast.error = createToastErrorStub((message) => {
      toasted.push(message);
    });

    const wrapped = wrapAsync(
      async (datasetId: string) => {
        throw new Error('wrapped boom');
      },
      'Wrapped error test',
      (datasetId) => ({
        metadata: {
          datasetId,
        },
      }),
    );

    wrapped('dataset-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const relevantLogged = filterRelevantConsoleErrors(logged);

    assert.deepEqual(toasted, ['Wrapped error test: wrapped boom']);
    assert.equal(relevantLogged.length, 1);
    assert.deepEqual(relevantLogged[0], [
      '[Wrapped error test]',
      {
        error: new Error('wrapped boom'),
        metadata: {
          datasetId: 'dataset-1',
        },
      },
    ]);
  });
});
