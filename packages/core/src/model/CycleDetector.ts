export function findStronglyConnectedComponents<T extends object>(
  nodes: T[],
  getAdjacentNodes: (node: T) => T[],
): T[][] {
  const stack: T[] = [];
  const indices = new Map<T, number>();
  const lowLinks = new Map<T, number>();
  const onStack = new Set<T>();
  const stronglyConnectedComponents: T[][] = [];
  let index = 0;

  const strongConnect = (node: T): void => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);

    for (const adjacentNode of getAdjacentNodes(node)) {
      if (!indices.has(adjacentNode)) {
        strongConnect(adjacentNode);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(adjacentNode)!));
      } else if (onStack.has(adjacentNode)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(adjacentNode)!));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component: T[] = [];
      let currentNode: T | undefined;

      do {
        currentNode = stack.pop();
        if (!currentNode) {
          break;
        }

        onStack.delete(currentNode);
        component.push(currentNode);
      } while (currentNode !== node);

      stronglyConnectedComponents.push(component);
    }
  };

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return stronglyConnectedComponents;
}
