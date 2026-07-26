import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeRegistration, registerBuiltInNodes } from '../../packages/core/src/index.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const assetRelativePath = 'packages/app/graphs/graph-builder-node-specs.generated.json';
const assetPath = join(repoRoot, assetRelativePath);
const helpRelativePath = 'packages/app/graphs/graph-builder-node-help.generated.json';
const helpPath = join(repoRoot, helpRelativePath);
const nodeDocsPath = join(repoRoot, 'packages/docs/docs/node-reference');
const shouldWrite = process.argv.includes('--write');

function readFrontmatterValue(content, key) {
  return content
    .match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
    ?.replace(/^["']|["']$/g, '')
    .trim();
}

function normalizeHelpLookup(value) {
  return value
    .replace(/\(Legacy\)/gi, '')
    .replace(/\bNode\b/gi, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

function compactMarkdown(content) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/import .*?;\r?\n/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]*\)/g, (match) => match.match(/^\[([^\]]+)\]/)?.[1] ?? match)
    .replace(/[`*_#>|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHelpDescription(content) {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const overview = withoutFrontmatter.match(/## Overview\s+([\s\S]*?)(?:\r?\n## |\r?\n<Tabs|\r?\n### |$)/)?.[1];
  return compactMarkdown(overview ?? withoutFrontmatter).slice(0, 900);
}

function buildHelpAsset(registry) {
  const docs = readdirSync(nodeDocsPath)
    .filter((file) => file.endsWith('.mdx') && !file.startsWith('_') && file !== 'all-nodes.mdx')
    .sort()
    .map((file) => {
      const content = readFileSync(join(nodeDocsPath, file), 'utf8');
      const title = readFrontmatterValue(content, 'title') ?? file.replace(/\.mdx$/, '');
      const sidebarLabel = readFrontmatterValue(content, 'sidebar_label') ?? title;
      const slug = normalizeHelpLookup(file.replace(/\.mdx$/, ''));
      return {
        description: extractHelpDescription(content),
        file,
        keys: [slug, normalizeHelpLookup(title), normalizeHelpLookup(sidebarLabel)],
        slug,
      };
    });
  const descriptions = Object.fromEntries(
    [...registry.getNodeTypes()].sort().map((nodeType) => {
      const displayName = registry.getDynamicDisplayName(nodeType);
      const nodeTypeKey = normalizeHelpLookup(nodeType);
      const fallbackAliases = [
        normalizeHelpLookup(displayName),
        ...(nodeType === 'boolean' ? ['bool'] : []),
        ...(nodeType === 'datasetNearestNeighbors' ? ['knndataset'] : []),
        ...(nodeType === 'extractRegex' ? ['extractwithregex'] : []),
        ...(nodeType === 'split' ? ['splittext'] : []),
      ];
      const slugMatches = docs.filter((candidate) => candidate.slug === nodeTypeKey);
      const directMatches =
        slugMatches.length > 0 ? slugMatches : docs.filter((candidate) => candidate.keys.includes(nodeTypeKey));
      const matches =
        directMatches.length > 0
          ? directMatches
          : docs.filter((candidate) => candidate.keys.some((key) => fallbackAliases.includes(key)));
      if (matches.length > 1) {
        throw new Error(
          `Ambiguous node-reference help match for built-in "${nodeType}": ${matches.map((match) => match.file).join(', ')}.`,
        );
      }
      const doc = matches[0];
      return [nodeType, doc?.description || `Adds a ${displayName} node to the graph.`];
    }),
  );
  return {
    formatVersion: 1,
    descriptions,
  };
}

function buildAsset(createGraphBuilderAuthoringCatalog, registry) {
  const graphId = 'graph-builder-node-spec-generation';
  const project = {
    metadata: {
      id: 'graph-builder-node-spec-project',
      title: 'Graph Builder node specification generation',
      description: '',
      mainGraphId: graphId,
    },
    graphs: {
      [graphId]: {
        metadata: {
          id: graphId,
          name: 'Generation graph',
          description: '',
        },
        nodes: [],
        connections: [],
      },
    },
  };
  const catalog = createGraphBuilderAuthoringCatalog({
    registry,
    project,
    referencedProjects: {},
  });
  const entries = catalog
    .listEntries()
    .filter((entry) => entry.family === 'registered')
    .map((entry) => ({
      authoringChoiceId: entry.authoringChoiceId,
      nodeType: entry.nodeType,
      displayName: entry.displayName,
      description: entry.description,
      aliases: [...entry.aliases],
      capabilities: entry.capabilities,
      settings: entry.settings.map((setting) => ({
        key: setting.key,
        valueKind: setting.valueKind,
        description: setting.description,
        ...(setting.allowedValues ? { allowedValues: [...setting.allowedValues] } : {}),
        ...(setting.projection ? { projection: setting.projection } : {}),
      })),
      ...(entry.safeDefaults ? { safeDefaults: entry.safeDefaults } : {}),
    }));

  return {
    formatVersion: 1,
    catalogFingerprint: catalog.fingerprint,
    entries,
  };
}

const registry = registerBuiltInNodes(new NodeRegistration());
const expectedHelp = `${JSON.stringify(buildHelpAsset(registry), null, 2)}\n`;

if (
  !shouldWrite &&
  (!existsSync(helpPath) || readFileSync(helpPath, 'utf8').replace(/\r\n?/g, '\n') !== expectedHelp)
) {
  console.error(`Missing or stale generated Graph Builder node help: ${helpRelativePath}`);
  console.error('Run: yarn check:graph-builder-node-specs --write');
  process.exit(1);
}

if (shouldWrite) {
  writeFileSync(helpPath, expectedHelp);
}

const { createGraphBuilderAuthoringCatalog } = await import(
  '../../packages/app/src/features/graphBuilder/authoringCatalog.ts'
);
const expected = `${JSON.stringify(buildAsset(createGraphBuilderAuthoringCatalog, registry), null, 2)}\n`;

if (shouldWrite) {
  writeFileSync(assetPath, expected);
  console.log(`Updated ${helpRelativePath}.`);
  console.log(`Updated ${assetRelativePath}.`);
  process.exit(0);
}

if (!existsSync(assetPath)) {
  console.error(`Missing generated Graph Builder node specifications: ${assetRelativePath}`);
  console.error('Run: yarn check:graph-builder-node-specs --write');
  process.exit(1);
}

const current = readFileSync(assetPath, 'utf8').replace(/\r\n?/g, '\n');
if (current !== expected) {
  console.error(`Stale generated Graph Builder node specifications: ${assetRelativePath}`);
  console.error('Run: yarn check:graph-builder-node-specs --write');
  process.exit(1);
}

console.log(
  `Graph Builder node help and specifications are fresh (${buildAsset(createGraphBuilderAuthoringCatalog, registry).entries.length} built-in choices).`,
);
