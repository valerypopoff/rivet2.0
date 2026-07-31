import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { coreRunGraph, loadProjectFromString } from '../../core/src/index.js';

const projectPath = fileURLToPath(new URL('../src/promo/promo.rivet-project', import.meta.url));
const project = loadProjectFromString(await readFile(projectPath, 'utf8'));
const nodeTypes = Object.values(project.graphs).flatMap((graph) => graph.nodes.map((node) => node.type));

assert.equal(project.metadata.mainGraphId, 'promo-support-agent');
assert.deepEqual(project.plugins, []);
assert.deepEqual([...new Set(nodeTypes)].sort(), ['graphOutput', 'text']);

const outputs = await coreRunGraph(project, { graph: 'promo-support-agent' });
assert.equal(outputs.output?.type, 'string');
assert.match(String(outputs.output?.value), /Provider-ready support agent brief/);
assert.match(String(outputs.output?.value), /delayed shipment/);

console.log('Promo Rivet project is deterministic, dependency-free, and runnable.');
