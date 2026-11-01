/**
 * Wiring guard for stopping a background session when a Command Terminal ends.
 *
 * `/bg` moves a terminal's conversation into the agent CLI's own background
 * session, which runs outside the terminal's PTY. The one thing that makes an
 * ended terminal stop it in production is a property in `registerAllIpc`
 * (src/main/ipc/register-all.ts):
 *
 *   new CommandTerminalLeftoverReaper({
 *     ...,
 *     stopBackgroundSession: (ended) => stopEndedCommandTerminalBackgroundSession(requireContext(), ended),
 *     ...
 *   })
 *
 * `CommandTerminalLeftoverDeps.stopBackgroundSession` is OPTIONAL, and the
 * reaper's own tests hand it a spy directly, so deleting that line, or
 * replacing it with a stub, leaves every behavioral suite green while an ended
 * terminal silently stops stopping the background session and the leftover
 * reap kills it with no exit of its own. `registerAllIpc` needs a live Electron
 * main process, so this is a source-parity check on the real file's syntax tree.
 *
 * The scan parses the real source with the TypeScript compiler API rather than
 * matching text, because the names in question also appear on import lines and
 * in comments, and a commented-out line must not pass. The matcher returns the
 * list of problems it found, and it is also run against mutated copies of the
 * real source (the line deleted, commented out, stubbed, or handed the wrong
 * arguments) to show it rejects exactly the regressions it exists for. That is
 * the red half of red-green, since register-all.ts itself is not edited to
 * prove it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../..');
const REGISTER_ALL_PATH = 'src/main/ipc/register-all.ts';
const LEFTOVERS_MODULE = './helpers/command-terminal-leftovers';
const BACKGROUND_SESSION_MODULE = './helpers/command-terminal-background-session';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collect<NodeType extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is NodeType,
): NodeType[] {
  const found: NodeType[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** A value import of `name` from exactly `specifier` (a type-only import does not count). */
function importsValue(sourceFile: ts.SourceFile, specifier: string, name: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) return false;
    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly) return false;
    const bindings = importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return false;
    return bindings.elements.some((element) => !element.isTypeOnly && element.name.text === name);
  });
}

// ---------------------------------------------------------------------------
// Matcher: returns the problems found, empty when the wiring is intact
// ---------------------------------------------------------------------------

function registerAllProblems(text: string): string[] {
  const problems: string[] = [];
  const sourceFile = parse(text, 'register-all.ts');

  if (!importsValue(sourceFile, LEFTOVERS_MODULE, 'CommandTerminalLeftoverReaper')) {
    problems.push(`CommandTerminalLeftoverReaper is not imported from ${LEFTOVERS_MODULE}`);
  }
  if (!importsValue(sourceFile, BACKGROUND_SESSION_MODULE, 'stopEndedCommandTerminalBackgroundSession')) {
    problems.push(`stopEndedCommandTerminalBackgroundSession is not imported from ${BACKGROUND_SESSION_MODULE}`);
  }

  // Exactly one, so a rename of the class cannot leave this scan empty.
  const constructions = collect(sourceFile, (node): node is ts.NewExpression => (
    ts.isNewExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'CommandTerminalLeftoverReaper'
  ));
  if (constructions.length !== 1) {
    return [...problems, `expected exactly one new CommandTerminalLeftoverReaper(...), found ${constructions.length}`];
  }

  const options = constructions[0].arguments?.[0];
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return [...problems, 'the reaper is not constructed with an object literal of dependencies'];
  }

  const bindings = options.properties.filter((property): property is ts.PropertyAssignment => (
    ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name)
    && property.name.text === 'stopBackgroundSession'
  ));
  if (bindings.length !== 1) {
    return [...problems, `the reaper's dependencies bind stopBackgroundSession ${bindings.length} times, expected once`];
  }

  const binder = unwrapParentheses(bindings[0].initializer);
  if (
    !ts.isArrowFunction(binder)
    || binder.parameters.length !== 1
    || !ts.isIdentifier(binder.parameters[0].name)
    || ts.isBlock(binder.body)
  ) {
    return [...problems, 'stopBackgroundSession is not bound as a one-parameter arrow with an expression body'];
  }

  const endedName = binder.parameters[0].name.text;
  const delegation = unwrapParentheses(binder.body);
  const delegatesToRealFunction = ts.isCallExpression(delegation)
    && ts.isIdentifier(delegation.expression)
    && delegation.expression.text === 'stopEndedCommandTerminalBackgroundSession'
    && delegation.arguments.length === 2
    // The live context, read when the stop runs (requireContext), not a stub or a capture.
    && ts.isCallExpression(delegation.arguments[0])
    && ts.isIdentifier(delegation.arguments[0].expression)
    && delegation.arguments[0].expression.text === 'requireContext'
    && delegation.arguments[0].arguments.length === 0
    // The ended terminal the reaper snapshotted at the removal, handed through as it came.
    && ts.isIdentifier(delegation.arguments[1])
    && delegation.arguments[1].text === endedName;
  if (!delegatesToRealFunction) {
    problems.push(
      'stopBackgroundSession does not call the imported stopEndedCommandTerminalBackgroundSession with requireContext() and the ended terminal it was handed',
    );
  }
  return problems;
}

/** `source` with its first `original` replaced; throws when the line is gone so a mutant can never be a no-op. */
function mutate(source: string, original: string, replacement: string): string {
  if (!source.includes(original)) {
    throw new Error(`The mutation target is not in the source, update this test with it: ${original}`);
  }
  return source.replace(original, () => replacement);
}

/** A mutation: its label, the source text to replace, the replacement, and the problem the matcher must name. */
type Regression = [label: string, original: string, replacement: string, expectedProblem: string];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('a Command Terminal end stops its background session', () => {
  describe('registerAllIpc hands the leftover reaper the real stop', () => {
    const registerAllSource = readSource(REGISTER_ALL_PATH);

    // Red: deleting the `stopBackgroundSession` line from the reaper's
    // dependencies in register-all.ts is the "mutant: line deleted" case below,
    // and this assertion reports it.
    it('binds stopBackgroundSession to stopEndedCommandTerminalBackgroundSession(requireContext(), ended)', () => {
      expect(registerAllProblems(registerAllSource)).toEqual([]);
    });

    const line = '    stopBackgroundSession: (ended) => stopEndedCommandTerminalBackgroundSession(requireContext(), ended),';
    const regressions: Regression[] = [
      ['the line deleted', line, '', 'bind stopBackgroundSession 0 times'],
      [
        'the line commented out',
        line,
        '    // stopBackgroundSession: (ended) => stopEndedCommandTerminalBackgroundSession(requireContext(), ended),',
        'bind stopBackgroundSession 0 times',
      ],
      [
        'the line bound twice',
        line,
        `${line}\n    stopBackgroundSession: async () => undefined,`,
        'bind stopBackgroundSession 2 times',
      ],
      [
        'a stub that ignores the ended terminal',
        line,
        '    stopBackgroundSession: async () => undefined,',
        'not bound as a one-parameter arrow',
      ],
      [
        'a stub with the right shape and another callee',
        line,
        '    stopBackgroundSession: (ended) => Promise.resolve(ended).then(() => undefined),',
        'does not call the imported stopEndedCommandTerminalBackgroundSession',
      ],
      [
        'the ended terminal dropped from the call',
        line,
        '    stopBackgroundSession: (ended) => stopEndedCommandTerminalBackgroundSession(requireContext(), {} as typeof ended),',
        'does not call the imported stopEndedCommandTerminalBackgroundSession',
      ],
      [
        'the live context dropped from the call',
        line,
        '    stopBackgroundSession: (ended) => stopEndedCommandTerminalBackgroundSession(undefined as never, ended),',
        'does not call the imported stopEndedCommandTerminalBackgroundSession',
      ],
      [
        'the arguments swapped',
        line,
        '    stopBackgroundSession: (ended) => stopEndedCommandTerminalBackgroundSession(ended as never, requireContext() as never),',
        'does not call the imported stopEndedCommandTerminalBackgroundSession',
      ],
      [
        'the import removed',
        "import { stopEndedCommandTerminalBackgroundSession } from './helpers/command-terminal-background-session';",
        '',
        'stopEndedCommandTerminalBackgroundSession is not imported',
      ],
      [
        'the reaper import removed',
        "import { CommandTerminalLeftoverReaper } from './helpers/command-terminal-leftovers';",
        '',
        'CommandTerminalLeftoverReaper is not imported',
      ],
    ];
    it.each(regressions)('the scan rejects a mutant with %s', (_label, original, replacement, expectedProblem) => {
      const problems = registerAllProblems(mutate(registerAllSource, original, replacement));
      expect(problems.join('\n')).toContain(expectedProblem);
    });
  });
});
