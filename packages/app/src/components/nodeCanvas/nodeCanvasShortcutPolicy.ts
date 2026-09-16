export type NodeCanvasShortcutPolicy = {
  canvasCommandsEnabled: boolean;
  clipboardCommandsEnabled: boolean;
  graphCommandsEnabled: boolean;
};

export function getNodeCanvasShortcutPolicy(options: {
  comparisonInspectorOpen: boolean;
  graphCommandsDisabled: boolean;
}): NodeCanvasShortcutPolicy {
  const canvasCommandsEnabled = !options.comparisonInspectorOpen;
  const graphCommandsEnabled = !options.graphCommandsDisabled;

  return {
    canvasCommandsEnabled,
    clipboardCommandsEnabled: canvasCommandsEnabled && graphCommandsEnabled,
    graphCommandsEnabled,
  };
}
