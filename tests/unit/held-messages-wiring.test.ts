/**
 * Wiring guard for held messages (GitHub #452).
 *
 * A message sent to a task with no running agent is held and goes out with the
 * task's next agent. Three joins carry that, and each one is a call or a
 * property in a file whose own unit tests mock it away, so deleting the line
 * leaves every behavioral suite green while the feature silently stops working:
 *
 *   1. `registerAllIpc` (src/main/ipc/register-all.ts) calls
 *      `registerHeldMessageFlush(context)`. It is the delivery path for every
 *      start that does not build an opening message itself (startup recovery,
 *      a queued session's promotion). Without it those held messages sit in
 *      the log forever.
 *   2. `startMcpHttpServer` (src/main/index.ts) is handed a steering-context
 *      reader whose `holdTaskMessage` is the real `holdTaskMessage` bound to the
 *      live IPC context. `McpSteeringContext.holdTaskMessage` is a required
 *      member, so the type checker catches a missing key; it does not catch a
 *      stub that returns a refusal.
 *   3. `resolveSteering` (src/main/agent/mcp-http-server.ts) forwards that
 *      function into the dependencies. The chain from there is followed by
 *      argument position, not by name: `resolveSteering` is handed to
 *      `handleHttpRequest`, which passes what its parameter returns to
 *      `buildConfiguredMcpServer`, which hands its parameter to
 *      `registerSteeringTools`, where `kangentic_send_session_message` calls
 *      it. A stub passed in place of `resolveSteering` at the
 *      `handleHttpRequest` call site is caught too.
 *
 * The scan parses the real source with the TypeScript compiler API rather than
 * matching text, because the names in question also appear on import lines and
 * in comments, and a commented-out call must not pass. Each matcher returns the
 * list of problems it found, and every matcher is also run against mutated
 * copies of the real source (the call deleted, commented out, deferred, or
 * replaced by a stub) to show it rejects exactly the regressions it exists for.
 * That is the red half of red-green, since the production files themselves are
 * not edited to prove it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../..');
const REGISTER_ALL_PATH = 'src/main/ipc/register-all.ts';
const MAIN_INDEX_PATH = 'src/main/index.ts';
const MCP_SERVER_PATH = 'src/main/agent/mcp-http-server.ts';

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

function callsTo(root: ts.Node, calleeName: string): ts.CallExpression[] {
  return collect(root, (node): node is ts.CallExpression => (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === calleeName
  ));
}

function propertyAssignments(root: ts.Node, propertyName: string): ts.PropertyAssignment[] {
  return collect(root, (node): node is ts.PropertyAssignment => (
    ts.isPropertyAssignment(node)
    && ts.isIdentifier(node.name)
    && node.name.text === propertyName
  ));
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

/** The nearest function, arrow or method that contains `node`. */
function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

function functionDeclarationNamed(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return collect(sourceFile, (node): node is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(node) && node.name?.text === name
  ))[0];
}

/** The name of `declaration`'s parameter at `index`, or null when there is none or it is destructured. */
function parameterNameAt(declaration: ts.FunctionDeclaration | undefined, index: number): string | null {
  const parameter = declaration?.parameters[index];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : null;
}

/**
 * The name of the one variable declared inside `root` as `const x = <callee>()`,
 * or null when there is not exactly one. It is how the scan learns what the
 * file calls the context a binding is made against, without hardcoding it.
 */
function variableBoundToCall(root: ts.Node, calleeName: string): string | null {
  const declarations = collect(root, (node): node is ts.VariableDeclaration => (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer !== undefined
    && ts.isCallExpression(node.initializer)
    && ts.isIdentifier(node.initializer.expression)
    && node.initializer.expression.text === calleeName
  ));
  if (declarations.length !== 1) return null;
  const declaredName = declarations[0].name;
  return ts.isIdentifier(declaredName) ? declaredName.text : null;
}

// ---------------------------------------------------------------------------
// Matchers: each returns the problems found, empty when the wiring is intact
// ---------------------------------------------------------------------------

function registerAllProblems(text: string): string[] {
  const problems: string[] = [];
  const sourceFile = parse(text, 'register-all.ts');

  if (!importsValue(sourceFile, '../held-messages/held-messages', 'registerHeldMessageFlush')) {
    problems.push('registerHeldMessageFlush is not imported from ../held-messages/held-messages');
  }

  const registrations = callsTo(sourceFile, 'registerHeldMessageFlush').filter((call) => {
    const container = enclosingFunction(call);
    return container !== undefined
      && ts.isFunctionDeclaration(container)
      && container.name?.text === 'registerAllIpc'
      && ts.isExpressionStatement(call.parent)
      && call.arguments.length === 1
      && ts.isIdentifier(call.arguments[0])
      && call.arguments[0].text === 'context';
  });
  if (registrations.length !== 1) {
    problems.push(
      `expected exactly one registerHeldMessageFlush(context) statement directly inside registerAllIpc, found ${registrations.length}`,
    );
  }
  return problems;
}

function mainIndexProblems(text: string): string[] {
  const problems: string[] = [];
  const sourceFile = parse(text, 'index.ts');

  if (!importsValue(sourceFile, './held-messages/held-messages', 'holdTaskMessage')) {
    problems.push('holdTaskMessage is not imported from ./held-messages/held-messages');
  }

  const startCalls = callsTo(sourceFile, 'startMcpHttpServer');
  if (startCalls.length !== 1) {
    return [...problems, `expected one startMcpHttpServer(...) call, found ${startCalls.length}`];
  }
  // startMcpHttpServer(buildContext, getBrowserAutomationConfig, networkConfig, getSteeringContext)
  const steeringReader = startCalls[0].arguments[3];
  if (!steeringReader || !(ts.isArrowFunction(steeringReader) || ts.isFunctionExpression(steeringReader))) {
    return [...problems, 'startMcpHttpServer is not handed a steering-context reader as its fourth argument'];
  }

  const bindings = propertyAssignments(steeringReader, 'holdTaskMessage');
  if (bindings.length !== 1) {
    return [...problems, `the steering-context reader binds holdTaskMessage ${bindings.length} times, expected once`];
  }
  const binder = unwrapParentheses(bindings[0].initializer);
  if (
    !ts.isArrowFunction(binder)
    || binder.parameters.length !== 1
    || !ts.isIdentifier(binder.parameters[0].name)
    || ts.isBlock(binder.body)
  ) {
    return [...problems, 'holdTaskMessage is not bound as a one-parameter arrow with an expression body'];
  }

  const inputName = binder.parameters[0].name.text;
  const contextName = variableBoundToCall(steeringReader, 'getOptionalIpcContext');
  const delegation = unwrapParentheses(binder.body);
  const delegatesToRealFunction = contextName !== null
    && ts.isCallExpression(delegation)
    && ts.isIdentifier(delegation.expression)
    && delegation.expression.text === 'holdTaskMessage'
    && delegation.arguments.length === 2
    && ts.isIdentifier(delegation.arguments[0])
    && delegation.arguments[0].text === contextName
    && ts.isIdentifier(delegation.arguments[1])
    && delegation.arguments[1].text === inputName;
  if (!delegatesToRealFunction) {
    problems.push(
      'the holdTaskMessage binding does not call the imported holdTaskMessage with the live IPC context and the tool input',
    );
  }
  return problems;
}

function mcpServerProblems(text: string): string[] {
  const problems: string[] = [];
  const sourceFile = parse(text, 'mcp-http-server.ts');

  // (a) resolveSteering forwards the reader's holdTaskMessage into the dependencies.
  const resolveDeclarations = collect(sourceFile, (node): node is ts.VariableDeclaration => (
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'resolveSteering'
  ));
  if (resolveDeclarations.length !== 1) {
    return [...problems, `expected one resolveSteering declaration, found ${resolveDeclarations.length}`];
  }
  const steeringContextName = variableBoundToCall(resolveDeclarations[0], 'getSteeringContext');
  const forwards = propertyAssignments(resolveDeclarations[0], 'holdTaskMessage').filter((assignment) => {
    const value = unwrapParentheses(assignment.initializer);
    return steeringContextName !== null
      && ts.isPropertyAccessExpression(value)
      && ts.isIdentifier(value.expression)
      && value.expression.text === steeringContextName
      && value.name.text === 'holdTaskMessage';
  });
  if (forwards.length !== 1) {
    problems.push('resolveSteering does not forward steeringContext.holdTaskMessage into the steering dependencies');
  }

  // (b) resolveSteering is handed to handleHttpRequest. Inside it the resolver
  // is a PARAMETER that merely shares the name, so follow it by position.
  const requestHandlerCalls = callsTo(sourceFile, 'handleHttpRequest');
  const resolverArgumentIndex = requestHandlerCalls
    .map((call) => call.arguments.findIndex((argument) => (
      ts.isIdentifier(argument) && argument.text === 'resolveSteering'
    )))
    .find((index) => index >= 0) ?? -1;
  if (resolverArgumentIndex < 0) {
    return [...problems, 'no handleHttpRequest(...) call is handed the resolveSteering resolver'];
  }

  // (c) handleHttpRequest passes what that parameter returns on to buildConfiguredMcpServer...
  const requestHandler = functionDeclarationNamed(sourceFile, 'handleHttpRequest');
  const resolverParameterName = parameterNameAt(requestHandler, resolverArgumentIndex);
  const steeringArgumentIndex = requestHandler && resolverParameterName !== null
    ? callsTo(requestHandler, 'buildConfiguredMcpServer')
      .map((call) => call.arguments.findIndex((argument) => (
        ts.isCallExpression(argument)
        && ts.isIdentifier(argument.expression)
        && argument.expression.text === resolverParameterName
      )))
      .find((index) => index >= 0) ?? -1
    : -1;
  if (steeringArgumentIndex < 0) {
    return [...problems, 'handleHttpRequest does not hand the result of its steering resolver parameter to buildConfiguredMcpServer'];
  }

  // (d) ...and that parameter of buildConfiguredMcpServer is what registerSteeringTools receives.
  const builder = functionDeclarationNamed(sourceFile, 'buildConfiguredMcpServer');
  const steeringParameterName = parameterNameAt(builder, steeringArgumentIndex);
  const registrations = builder ? callsTo(builder, 'registerSteeringTools') : [];
  const registersParameter = steeringParameterName !== null && registrations.some((call) => (
    call.arguments.length === 3
    && ts.isIdentifier(call.arguments[2])
    && call.arguments[2].text === steeringParameterName
  ));
  if (!registersParameter) {
    problems.push(
      'buildConfiguredMcpServer does not pass the parameter that receives the steering dependencies to registerSteeringTools as its third argument',
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

const REFUSING_STUB = "() => ({ status: 'refused', error: 'stub' })";

/** A mutation: its label, the source text to replace, the replacement, and the problem the matcher must name. */
type Regression = [label: string, original: string, replacement: string, expectedProblem: string];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('held messages are wired in', () => {
  describe('registerAllIpc registers the held-message flush', () => {
    const registerAllSource = readSource(REGISTER_ALL_PATH);

    // Red: deleting `registerHeldMessageFlush(context);` from registerAllIpc
    // (register-all.ts) is the "mutant: call deleted" case below, and this
    // assertion reports it.
    it('has exactly one registerHeldMessageFlush(context) statement in registerAllIpc', () => {
      expect(registerAllProblems(registerAllSource)).toEqual([]);
    });

    const call = '  registerHeldMessageFlush(context);';
    const regressions: Regression[] = [
      ['the call deleted', call, '', 'found 0'],
      ['the call commented out', call, '  // registerHeldMessageFlush(context);', 'found 0'],
      ['the call deferred into a callback', call, '  setTimeout(() => registerHeldMessageFlush(context), 0);', 'found 0'],
      ['the call made twice', call, `${call}\n${call}`, 'found 2'],
      [
        'the import removed',
        "import { registerHeldMessageFlush } from '../held-messages/held-messages';",
        '',
        'is not imported',
      ],
    ];
    it.each(regressions)('the scan rejects a mutant with %s', (_label, original, replacement, expectedProblem) => {
      const problems = registerAllProblems(mutate(registerAllSource, original, replacement));
      expect(problems.join('\n')).toContain(expectedProblem);
    });
  });

  describe('main binds holdTaskMessage into the MCP server\'s steering context', () => {
    const mainIndexSource = readSource(MAIN_INDEX_PATH);
    const binding = 'holdTaskMessage: (input) => holdTaskMessage(ctx, input),';

    // Red: replacing the binding in index.ts with a stub, or dropping it, is
    // the first two mutants below, and this assertion reports both.
    it('hands startMcpHttpServer a reader whose holdTaskMessage is the real function on the live context', () => {
      expect(mainIndexProblems(mainIndexSource)).toEqual([]);
    });

    const regressions: Regression[] = [
      ['the binding replaced by a refusing stub', binding, `holdTaskMessage: ${REFUSING_STUB},`, 'not bound as a one-parameter arrow'],
      ['the binding deleted', binding, '', 'binds holdTaskMessage 0 times'],
      [
        'the live context dropped from the call',
        binding,
        'holdTaskMessage: (input) => holdTaskMessage(undefined as never, input),',
        'does not call the imported holdTaskMessage',
      ],
      [
        'the tool input dropped from the call',
        binding,
        'holdTaskMessage: (input) => holdTaskMessage(ctx, {} as typeof input),',
        'does not call the imported holdTaskMessage',
      ],
      ['the import removed', "import { holdTaskMessage } from './held-messages/held-messages';", '', 'is not imported'],
    ];
    it.each(regressions)('the scan rejects a mutant with %s', (_label, original, replacement, expectedProblem) => {
      const problems = mainIndexProblems(mutate(mainIndexSource, original, replacement));
      expect(problems.join('\n')).toContain(expectedProblem);
    });
  });

  describe('the MCP server forwards holdTaskMessage into the steering tools', () => {
    const mcpServerSource = readSource(MCP_SERVER_PATH);

    // Red: the mutants below are the four places this join can break, and
    // this assertion reports each of them.
    it('resolveSteering forwards it, and the dependencies it builds reach registerSteeringTools through handleHttpRequest and buildConfiguredMcpServer', () => {
      expect(mcpServerProblems(mcpServerSource)).toEqual([]);
    });

    const forward = 'holdTaskMessage: steeringContext.holdTaskMessage,';
    const regressions: Regression[] = [
      [
        'the forward replaced by a refusing stub',
        forward,
        `holdTaskMessage: ${REFUSING_STUB},`,
        'does not forward steeringContext.holdTaskMessage',
      ],
      ['the forward deleted', forward, '', 'does not forward steeringContext.holdTaskMessage'],
      [
        'the resolver not handed to handleHttpRequest',
        'networkConfig, resolveSteering, resolveBrowser',
        'networkConfig, () => null, resolveBrowser',
        'no handleHttpRequest(...) call is handed the resolveSteering resolver',
      ],
      [
        'the dependencies not handed to buildConfiguredMcpServer',
        'resolveSteering(callerSessionId),',
        'null,',
        'does not hand the result of its steering resolver parameter to buildConfiguredMcpServer',
      ],
      [
        'the dependencies not passed on to registerSteeringTools',
        'registerSteeringTools(mcpServer, resolver, steering);',
        'registerSteeringTools(mcpServer, resolver, undefined as never);',
        'does not pass the parameter',
      ],
    ];
    it.each(regressions)('the scan rejects a mutant with %s', (_label, original, replacement, expectedProblem) => {
      const problems = mcpServerProblems(mutate(mcpServerSource, original, replacement));
      expect(problems.join('\n')).toContain(expectedProblem);
    });
  });
});
