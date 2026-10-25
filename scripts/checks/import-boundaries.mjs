import ts from 'typescript';
import { posix } from 'node:path';

/** Parse imports, re-exports and literal dynamic imports; ignore comments and
 * authored code strings. Line numbers are diagnostic, never allowance identity. */
export function findImportEdges(file, contents) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const edges = [];
  const visit = (node) => {
    let specifier;
    let typeOnly = false;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      specifier = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    if (ts.isImportTypeNode(node)) typeOnly = true;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      typeOnly =
        !!clause?.isTypeOnly ||
        !!(
          clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)
        );
    }
    if (ts.isExportDeclaration(node))
      typeOnly =
        !!node.isTypeOnly ||
        !!(
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length &&
          node.exportClause.elements.every((element) => element.isTypeOnly)
        );
    if (specifier && ts.isStringLiteralLike(specifier)) {
      edges.push({
        file,
        specifier: specifier.text,
        typeOnly,
        line: source.getLineAndCharacterOfPosition(specifier.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

/** Follow actual relative runtime edges, including indirect dependencies. */
export function findRuntimeDependencyPath(edges, start, targets, packageEntrypoints = {}) {
  const files = new Set(edges.map((edge) => edge.file));
  const adjacency = new Map();
  for (const edge of edges) {
    if (edge.typeOnly) continue;
    const packageEntry = packageEntrypoints[edge.specifier];
    if (packageEntry) {
      adjacency.set(edge.file, [...(adjacency.get(edge.file) ?? []), packageEntry]);
      continue;
    }
    if (!edge.specifier.startsWith('.')) continue;
    const base = posix.normalize(posix.join(posix.dirname(edge.file), edge.specifier));
    const resolved = [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (file) => files.has(file) || targets.has(file),
    );
    if (resolved) adjacency.set(edge.file, [...(adjacency.get(edge.file) ?? []), resolved]);
  }
  const visited = new Set();
  const visit = (file, path) => {
    if (targets.has(file)) return [...path, file];
    if (visited.has(file)) return undefined;
    visited.add(file);
    for (const next of adjacency.get(file) ?? []) {
      const found = visit(next, [...path, file]);
      if (found) return found;
    }
  };
  return visit(start, []);
}

export const edgeKey = (edge) => `${edge.file}\t${edge.specifier}`;
export const isLongRelativeImport = (edge) =>
  !/\.(?:test|spec)\.[^.]+$/.test(edge.file) && /^(?:\.\.\/){3,}/.test(edge.specifier);
export const isPackageDeepImport = (edge) => /^@valerypopoff\/[^/]+\/src(?:\/|$)/.test(edge.specifier);

export function reviewImportDebt(edges, allowedEdges) {
  const current = new Set(edges.filter(isLongRelativeImport).map(edgeKey));
  const allowed = new Set(allowedEdges);
  return {
    added: [...current].filter((key) => !allowed.has(key)),
    removed: [...allowed].filter((key) => !current.has(key)),
    duplicates: allowedEdges.filter((key, index) => allowedEdges.indexOf(key) !== index),
  };
}
