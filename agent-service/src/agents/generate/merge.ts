import ts from 'typescript';
import type { GeneratedGroup } from './contract.ts';

// ---------------------------------------------------------------------------
// Stage 3 helper, no LLM. budget.ts may split one Stage 1 group (e.g.
// "customers") into several render-groups ("customers-1", "customers-2", ...)
// purely to stay under a single Claude call's token budget — each is
// generated, verified, and reviewed independently (spec.ts/verify.ts), but
// the final files on disk should be one .feature/.steps.ts per Stage 1
// group, not one per LLM call. This merges every render-group sharing the
// same sourceKey back into a single GeneratedGroup before render.ts writes
// files.
//
// Safe by construction: verify.ts already requires every render-group —
// sibling or not — to have zero colliding step-pattern text against every
// other render-group (see compileAndVerify), so concatenating any set of
// already-verified render-groups' steps content can never produce a
// duplicate/ambiguous step definition in the merged file. The only real work
// here is de-duplicating the repeated boilerplate (imports, the createBdd
// destructure, the ctx declaration) and renaming each piece's own split-key
// tag (e.g. "@customers-1") to the shared sourceKey tag ("@customers") so
// Gherkin scenario tags keep matching their Before hook after merging.
// ---------------------------------------------------------------------------

/**
 * A Gherkin Feature may carry a free-text description directly under its
 * `Feature:` header, but ONLY there — the same text mid-file (once merged
 * behind an earlier piece's scenarios) is a parse error. Comment-ify any
 * such leading description lines (every piece may have one, not just the
 * first) so the information survives without breaking Gherkin syntax
 * regardless of where this piece lands in the merged file.
 */
function commentifyLeadingDescription(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('@') || trimmed.startsWith('Scenario') || trimmed.startsWith('#')) break;
    lines[i] = lines[i].replace(trimmed, `# ${trimmed}`);
    i++;
  }
  return lines.join('\n');
}

function mergeFeatureContents(pieces: GeneratedGroup[], sourceKey: string): string {
  const bodies = pieces.map((piece) => {
    // trimEnd only — Gherkin's own leading indentation (e.g. "  @tag") on
    // this piece's first line is meaningful and must survive; trim() would
    // strip it along with the header regex's own trailing blank line.
    let body = piece.featureContent.replace(/^Feature:[^\n]*\n\n?/, '');
    body = commentifyLeadingDescription(body);
    if (piece.key !== sourceKey) body = body.split(`@${piece.key}`).join(`@${sourceKey}`);
    return body.trimEnd();
  });
  return `Feature: ${sourceKey}\n\n${bodies.join('\n\n')}\n`;
}

interface ImportInfo {
  names: Set<string>;
  defaultName: string | null;
}

function mergeStepsContents(pieces: GeneratedGroup[], sourceKey: string): string {
  const imports = new Map<string, ImportInfo>(); // moduleSpecifier -> info, insertion order preserved
  let createBddText = '';
  // Any other top-level `const`/`let NAME = ...;` declaring a single plain
  // identifier (ctx, but also e.g. BACKEND_URL — anything the model or a
  // later mechanical patch introduced) — deduped by name, first occurrence
  // wins, since re-declaring the same block-scoped binding twice in one
  // merged file is a real TS error, not just noise.
  const namedConsts = new Map<string, string>();
  const bodyParts: string[] = [];

  for (const piece of pieces) {
    const sourceFile = ts.createSourceFile(`${piece.key}.steps.ts`, piece.stepsContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const bodyStatements: string[] = [];

    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const moduleSpecifier = stmt.moduleSpecifier.text;
        const info = imports.get(moduleSpecifier) ?? { names: new Set<string>(), defaultName: null };
        const clause = stmt.importClause;
        if (clause?.name) info.defaultName = clause.name.text;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) info.names.add(el.name.text);
        }
        imports.set(moduleSpecifier, info);
        continue;
      }
      if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
        const decl = stmt.declarationList.declarations[0];
        const isCreateBdd =
          decl.initializer && ts.isCallExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression) && decl.initializer.expression.text === 'createBdd';
        if (isCreateBdd) {
          if (!createBddText) createBddText = stmt.getText(sourceFile);
          continue;
        }
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          if (!namedConsts.has(name)) namedConsts.set(name, stmt.getText(sourceFile));
          continue;
        }
      }
      bodyStatements.push(stmt.getFullText(sourceFile));
    }

    let body = bodyStatements.join('').trim();
    if (piece.key !== sourceKey) body = body.split(`'@${piece.key}'`).join(`'@${sourceKey}'`);
    bodyParts.push(body);
  }

  const importLines = [...imports.entries()].map(([moduleSpecifier, info]) => {
    const parts: string[] = [];
    if (info.defaultName) parts.push(info.defaultName);
    if (info.names.size > 0) parts.push(`{ ${[...info.names].join(', ')} }`);
    return `import ${parts.join(', ')} from '${moduleSpecifier}';`;
  });

  const constLines = [...namedConsts.values()].join('\n\n');
  return `${importLines.join('\n')}\n\n${createBddText}\n\n${constLines}\n\n${bodyParts.join('\n\n')}\n`;
}

/** Clusters `groups` by `sourceKey`, merging every cluster with more than one member into a single GeneratedGroup; singleton clusters (never split by budget.ts) pass through unchanged. */
export function mergeGroups(groups: GeneratedGroup[]): GeneratedGroup[] {
  const clusters = new Map<string, GeneratedGroup[]>();
  for (const g of groups) {
    const list = clusters.get(g.sourceKey) ?? [];
    list.push(g);
    clusters.set(g.sourceKey, list);
  }

  const merged: GeneratedGroup[] = [];
  for (const [sourceKey, pieces] of clusters) {
    if (pieces.length === 1) {
      merged.push(pieces[0]);
      continue;
    }
    merged.push({
      key: sourceKey,
      sourceKey,
      scenarioNames: pieces.flatMap((p) => p.scenarioNames),
      featureContent: mergeFeatureContents(pieces, sourceKey),
      stepsContent: mergeStepsContents(pieces, sourceKey),
    });
  }
  return merged;
}
