import type { ChartNode } from '@valerypopoff/rivet2-core';
import { isEqual } from 'lodash-es';

/** A retired callback never regains authority when the same owner is reopened. */
export function createNodeEditorSession(checkOwner: () => boolean) {
  let retired = false;
  const listeners = new Set<() => void>();
  const retire = () => {
    if (retired) return;
    retired = true;
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const isCurrent = () => {
    if (!retired && !checkOwner()) retire();
    return !retired;
  };
  return {
    isCurrent,
    retire,
    onRetire(listener: () => void) {
      if (!isCurrent()) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Apply only fields actually changed by this editor, preserving newer siblings. */
export function mergeNodeEditorChange(current: ChartNode, rendered: ChartNode, changed: ChartNode): ChartNode {
  const merge = <T extends object>(live: T, before: T, after: T): T => {
    const result = { ...live } as Record<string, unknown>;
    const previous = before as Record<string, unknown>;
    const changed = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (isEqual(previous[key], changed[key])) continue;
      if (key in after) result[key] = changed[key];
      else delete result[key];
    }
    return result as T;
  };
  const result = merge(current, rendered, changed);
  if (
    changed.data !== rendered.data &&
    current.data &&
    rendered.data &&
    changed.data &&
    typeof current.data === 'object' &&
    typeof rendered.data === 'object' &&
    typeof changed.data === 'object' &&
    !Array.isArray(changed.data)
  ) {
    result.data = merge(
      current.data as Record<string, unknown>,
      rendered.data as Record<string, unknown>,
      changed.data as Record<string, unknown>,
    );
  }
  if (changed.visualData !== rendered.visualData) {
    result.visualData = merge(current.visualData, rendered.visualData, changed.visualData) as ChartNode['visualData'];
  }
  return result;
}
