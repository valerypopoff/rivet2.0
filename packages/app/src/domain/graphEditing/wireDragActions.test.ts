import assert from 'node:assert/strict';
import test from 'node:test';
import { type NodeConnection } from '@valerypopoff/rivet2-core';
import {
  getCanvasPreviewConnections,
  resolveWireDragAction,
  shouldContinueDraggingAfterWireAction,
  shouldFinalizeWireDragFromGlobalMouseUp,
  shouldKeepWireConnectionModeAfterAction,
} from './wireDragActions.js';

function makeConnection(connection: Partial<NodeConnection>): NodeConnection {
  return {
    inputNodeId: 'input-node' as any,
    inputId: 'input-port' as any,
    outputNodeId: 'output-node' as any,
    outputId: 'output-port' as any,
    ...connection,
  };
}

test('resolveWireDragAction creates a make-connection action for a normal output drag', () => {
  const action = resolveWireDragAction({
    draggingWire: {
      startNodeId: 'output-a' as any,
      startPortId: 'out-a' as any,
    },
    dropTarget: {
      nodeId: 'input-a' as any,
      portId: 'in-a' as any,
    },
  });

  assert.deepEqual(action, {
    type: 'makeConnection',
    params: {
      outputNodeId: 'output-a',
      outputId: 'out-a',
      inputNodeId: 'input-a',
      inputId: 'in-a',
    },
  });
});

test('resolveWireDragAction keeps a zero-movement output click pending even when a nearby input is detected', () => {
  const draggingWire = {
    startNodeId: 'output-a' as any,
    startPortId: 'out-a' as any,
    startPortIsInput: false,
  };
  const action = resolveWireDragAction({
    draggingWire,
    didMove: false,
    dropTarget: {
      nodeId: 'nearby-input' as any,
      portId: 'nearby-in' as any,
    },
  });

  assert.deepEqual(action, { type: 'none', reason: 'emptyCanvas' });
  assert.equal(
    shouldKeepWireConnectionModeAfterAction({
      action,
      draggingWire,
      keepDragging: false,
    }),
    true,
  );
});

test('resolveWireDragAction creates a rewire action for a connected-input drag to a new target', () => {
  const originalConnection = makeConnection({
    inputNodeId: 'input-a' as any,
    inputId: 'in-a' as any,
    outputNodeId: 'output-a' as any,
    outputId: 'out-a' as any,
  });

  const action = resolveWireDragAction({
    draggingWire: {
      startNodeId: 'output-a' as any,
      startPortId: 'out-a' as any,
      originalConnection,
      rewireSourceInput: {
        nodeId: 'input-a' as any,
        portId: 'in-a' as any,
      },
    },
    dropTarget: {
      nodeId: 'input-b' as any,
      portId: 'in-b' as any,
    },
  });

  assert.deepEqual(action, {
    type: 'rewireConnection',
    originalConnection,
    params: {
      outputNodeId: 'output-a',
      outputId: 'out-a',
      inputNodeId: 'input-b',
      inputId: 'in-b',
    },
  });
});

test('resolveWireDragAction treats dropping back on the original input as a no-op', () => {
  const originalConnection = makeConnection({
    inputNodeId: 'input-a' as any,
    inputId: 'in-a' as any,
    outputNodeId: 'output-a' as any,
    outputId: 'out-a' as any,
  });

  const action = resolveWireDragAction({
    draggingWire: {
      startNodeId: 'output-a' as any,
      startPortId: 'out-a' as any,
      originalConnection,
      rewireSourceInput: {
        nodeId: 'input-a' as any,
        portId: 'in-a' as any,
      },
    },
    dropTarget: {
      nodeId: 'input-a' as any,
      portId: 'in-a' as any,
    },
  });

  assert.deepEqual(action, { type: 'none', reason: 'sameEndpoint' });
});

test('resolveWireDragAction treats a zero-movement click on the original connected input as a disconnect', () => {
  const originalConnection = makeConnection({
    inputNodeId: 'input-a' as any,
    inputId: 'in-a' as any,
    outputNodeId: 'output-a' as any,
    outputId: 'out-a' as any,
  });

  const action = resolveWireDragAction({
    draggingWire: {
      startNodeId: 'output-a' as any,
      startPortId: 'out-a' as any,
      originalConnection,
      rewireSourceInput: {
        nodeId: 'input-a' as any,
        portId: 'in-a' as any,
      },
    },
    didMove: false,
    dropTarget: {
      nodeId: 'input-a' as any,
      portId: 'in-a' as any,
    },
  });

  assert.deepEqual(action, {
    type: 'breakConnection',
    connection: originalConnection,
  });
});

test('resolveWireDragAction treats empty-canvas release from a connected input as a disconnect', () => {
  const originalConnection = makeConnection({
    inputNodeId: 'input-a' as any,
    inputId: 'in-a' as any,
  });

  const action = resolveWireDragAction({
    draggingWire: {
      startNodeId: 'output-a' as any,
      startPortId: 'out-a' as any,
      originalConnection,
      rewireSourceInput: {
        nodeId: 'input-a' as any,
        portId: 'in-a' as any,
      },
    },
  });

  assert.deepEqual(action, {
    type: 'breakConnection',
    connection: originalConnection,
  });
});

test('getCanvasPreviewConnections hides the original connection during input-origin rewire', () => {
  const originalConnection = makeConnection({
    inputNodeId: 'input-a' as any,
    inputId: 'in-a' as any,
  });
  const untouchedConnection = makeConnection({
    inputNodeId: 'input-b' as any,
    inputId: 'in-b' as any,
  });

  const previewConnections = getCanvasPreviewConnections([originalConnection, untouchedConnection], {
    originalConnection: {
      ...originalConnection,
    },
  });

  assert.deepEqual(previewConnections, [untouchedConnection]);
});

test('shouldContinueDraggingAfterWireAction keeps sticky drag for empty-canvas no-op output drags', () => {
  const action = resolveWireDragAction({
    draggingWire: {
      startNodeId: 'output-a' as any,
      startPortId: 'out-a' as any,
    },
  });

  assert.equal(shouldContinueDraggingAfterWireAction(action, true), true);
});

test('shouldContinueDraggingAfterWireAction cancels sticky drag when rewiring back to the original input', () => {
  const originalConnection = makeConnection({
    inputNodeId: 'input-a' as any,
    inputId: 'in-a' as any,
    outputNodeId: 'output-a' as any,
    outputId: 'out-a' as any,
  });

  const action = resolveWireDragAction({
    draggingWire: {
      startNodeId: 'output-a' as any,
      startPortId: 'out-a' as any,
      originalConnection,
      rewireSourceInput: {
        nodeId: 'input-a' as any,
        portId: 'in-a' as any,
      },
    },
    dropTarget: {
      nodeId: 'input-a' as any,
      portId: 'in-a' as any,
    },
  });

  assert.equal(shouldContinueDraggingAfterWireAction(action, true), false);
});

test('shouldKeepWireConnectionModeAfterAction keeps empty-canvas output releases pending', () => {
  const draggingWire = {
    startNodeId: 'output-a' as any,
    startPortId: 'out-a' as any,
    startPortIsInput: false,
  };
  const action = resolveWireDragAction({ draggingWire });

  assert.equal(
    shouldKeepWireConnectionModeAfterAction({
      action,
      draggingWire,
      keepDragging: false,
    }),
    true,
  );
});

test('shouldKeepWireConnectionModeAfterAction does not keep input-origin empty releases pending', () => {
  const draggingWire = {
    startNodeId: 'input-a' as any,
    startPortId: 'in-a' as any,
    startPortIsInput: true,
  };
  const action = resolveWireDragAction({ draggingWire });

  assert.equal(
    shouldKeepWireConnectionModeAfterAction({
      action,
      draggingWire,
      keepDragging: false,
    }),
    false,
  );
});

test('shouldKeepWireConnectionModeAfterAction preserves connected-input empty release disconnects', () => {
  const originalConnection = makeConnection({
    inputNodeId: 'input-a' as any,
    inputId: 'in-a' as any,
  });
  const draggingWire = {
    startNodeId: 'output-a' as any,
    startPortId: 'out-a' as any,
    startPortIsInput: false,
    originalConnection,
    rewireSourceInput: {
      nodeId: 'input-a' as any,
      portId: 'in-a' as any,
    },
  };
  const action = resolveWireDragAction({ draggingWire });

  assert.deepEqual(action, {
    type: 'breakConnection',
    connection: originalConnection,
  });
  assert.equal(
    shouldKeepWireConnectionModeAfterAction({
      action,
      draggingWire,
      keepDragging: false,
    }),
    false,
  );
});

test('shouldKeepWireConnectionModeAfterAction still honors explicit repeat-connect modifiers', () => {
  const draggingWire = {
    startNodeId: 'output-a' as any,
    startPortId: 'out-a' as any,
    startPortIsInput: false,
  };
  const action = resolveWireDragAction({
    draggingWire,
    dropTarget: {
      nodeId: 'input-a' as any,
      portId: 'in-a' as any,
    },
  });

  assert.equal(
    shouldKeepWireConnectionModeAfterAction({
      action,
      draggingWire,
      keepDragging: true,
    }),
    true,
  );
});

test('shouldFinalizeWireDragFromGlobalMouseUp finalizes active pointer drags even without a target', () => {
  assert.equal(
    shouldFinalizeWireDragFromGlobalMouseUp({
      hasActivePointerGesture: true,
      hasDropTarget: false,
    }),
    true,
  );
});

test('shouldFinalizeWireDragFromGlobalMouseUp ignores sticky pending canvas mouseups without a target', () => {
  assert.equal(
    shouldFinalizeWireDragFromGlobalMouseUp({
      hasActivePointerGesture: false,
      hasDropTarget: false,
    }),
    false,
  );
});

test('shouldFinalizeWireDragFromGlobalMouseUp lets sticky pending wires finish on a valid target', () => {
  assert.equal(
    shouldFinalizeWireDragFromGlobalMouseUp({
      hasActivePointerGesture: false,
      hasDropTarget: true,
    }),
    true,
  );
});
