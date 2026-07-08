import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const graphCreatorProjectPath = path.join(repoRoot, 'packages/app/graphs/graph-creator.rivet-project');
const graphCreatorDataPath = path.join(repoRoot, 'packages/app/graphs/graph-creator.rivet-data');
const nodeSourceDir = path.join(repoRoot, 'packages/core/src/model/nodes');
const nodeDocsDir = path.join(repoRoot, 'packages/docs/docs/node-reference');

const shouldWrite = process.argv.includes('--write');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function listFiles(dir, predicate) {
  return fs
    .readdirSync(dir)
    .filter(predicate)
    .sort((a, b) => a.localeCompare(b));
}

function readDataset(data, name) {
  const dataset = data.datasets.find((candidate) => candidate.meta.name === name);

  if (!dataset) {
    throw new Error(`Missing graph-creator dataset: ${name}`);
  }

  return dataset;
}

function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n/, '');
}

function readFrontmatterValue(content, key) {
  return content
    .match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
    ?.replace(/^["']|["']$/g, '')
    .trim();
}

function compactMarkdownText(content) {
  return content
    .replace(/import .*?;\n/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]*\)/g, (match) => match.match(/^\[([^\]]+)\]/)?.[1] ?? match)
    .replace(/[`*_#>|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOverview(content) {
  const withoutFrontmatter = stripFrontmatter(content);
  const overviewMatch = withoutFrontmatter.match(/## Overview\s+([\s\S]*?)(?:\n## |\n<Tabs|\n### |$)/);
  const candidate = overviewMatch?.[1] ?? withoutFrontmatter;
  return compactMarkdownText(candidate).slice(0, 900);
}

function buildNodeSourceRows() {
  return listFiles(nodeSourceDir, (file) => file.endsWith('.ts')).map((file) => ({
    id: `source:${file}`,
    data: [file, readText(path.join(nodeSourceDir, file))],
  }));
}

function buildNodeDocumentationRows() {
  return listFiles(nodeDocsDir, (file) => file.endsWith('.mdx') && !file.startsWith('_')).map((file) => ({
    id: `docs:${file}`,
    data: [file, readText(path.join(nodeDocsDir, file))],
  }));
}

function buildNodeSummaryRows() {
  return listFiles(
    nodeDocsDir,
    (file) => file.endsWith('.mdx') && !file.startsWith('_') && file !== 'all-nodes.mdx',
  ).map((file) => {
    const content = readText(path.join(nodeDocsDir, file));
    const title = readFrontmatterValue(content, 'title') ?? file.replace(/\.mdx$/, '');
    const sidebarLabel = readFrontmatterValue(content, 'sidebar_label');
    const label = sidebarLabel && sidebarLabel !== title ? `${title} (${sidebarLabel})` : title;
    const overview = extractOverview(content);
    return {
      id: `summary:${file}`,
      data: [`${label}: ${overview}`],
    };
  });
}

function buildExpectedData(currentData) {
  const clone = structuredClone(currentData);
  readDataset(clone, 'Node Summaries').data.rows = buildNodeSummaryRows();
  readDataset(clone, 'Node Source Code').data.rows = buildNodeSourceRows();
  readDataset(clone, 'Node Documentation').data.rows = buildNodeDocumentationRows();
  return clone;
}

function stableJson(data) {
  return `${JSON.stringify(data)}\n`;
}

const currentData = readJson(graphCreatorDataPath);
const currentProjectText = readText(graphCreatorProjectPath);

if (currentProjectText.includes('/usr/local/repos/rivet')) {
  console.error('Graph creator project contains stale old-repo source paths.');
  process.exit(1);
}

const expectedData = buildExpectedData(currentData);
const currentJson = stableJson(currentData);
const expectedJson = stableJson(expectedData);

if (currentJson === expectedJson) {
  console.log('Graph creator context data is in sync.');
  process.exit(0);
}

if (shouldWrite) {
  fs.writeFileSync(graphCreatorDataPath, expectedJson);
  console.log('Updated graph creator context data from current node source and docs.');
  process.exit(0);
}

console.error('Graph creator context data is stale.');
console.error('Run: node scripts/checks/check-graph-creator-data.mjs --write');
process.exit(1);
