/**
 * The Sentry breadcrumb policy (src/shared/sentry-breadcrumbs.ts), which both
 * processes install as `beforeBreadcrumb`.
 *
 * The fixtures copy the SHAPES of crumbs sampled from production events, where
 * the trail carried home paths, agent command lines, task titles, prompt text,
 * branch names, project paths inside click selectors, and a Browser pane
 * search URL. Every value here is a placeholder.
 *
 * The second half is a source scan. An allowlisted console tag is a promise
 * that its lines carry no user content, and the runtime policy cannot check
 * that promise: it redacts paths, but a task title or a prompt looks like any
 * other text. So every literal that opens with an allowlisted tag is parsed,
 * and an interpolation whose identifiers name user content fails unless the
 * site says why it is safe with `// breadcrumb-ok: <reason>`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { hasOptOutMarker } from './helpers/opt-out-marker';
import {
  CONSOLE_BREADCRUMB_TAGS,
  filterBreadcrumb,
  redactPaths,
  type BreadcrumbShape,
} from '../../src/shared/sentry-breadcrumbs';

function consoleCrumb(consoleArguments: unknown[], level = 'log'): BreadcrumbShape {
  return {
    category: 'console',
    level,
    // What the SDK builds: a joined message, plus the raw arguments.
    message: consoleArguments.map(String).join(' '),
    data: { arguments: consoleArguments, logger: 'console' },
  };
}

function errorWithCode(message: string, code: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

describe('filterBreadcrumb: console', () => {
  it('drops an untagged line, and a tagged one that is not on the allowlist', () => {
    expect(filterBreadcrumb(consoleCrumb([
      '[agent-detect] claude: found via PATH at C:\\Users\\dev\\.local\\bin\\claude.EXE (2.1.0)',
    ]))).toBeNull();
    expect(filterBreadcrumb(consoleCrumb([
      '[pr-linking] Linked PR 12 (merged) to "Fix the login redirect": https://github.com/example-org/app/pull/12',
    ]))).toBeNull();
    expect(filterBreadcrumb(consoleCrumb([
      '[TASK_MOVE] Injecting 1 command(s) into session: review the checkout flow',
    ]))).toBeNull();
    expect(filterBreadcrumb(consoleCrumb(['Aptabase: Failed to send event']))).toBeNull();
  });

  it.each(CONSOLE_BREADCRUMB_TAGS)('keeps a %s line', (tag) => {
    const kept = filterBreadcrumb(consoleCrumb([`${tag} something happened`]));
    expect(kept?.message).toBe(`${tag} something happened`);
  });

  it('passes a [SHUTDOWN] drain line through byte-identical, and keeps only the logger in data', () => {
    // exit-callback-drain.ts promises these lines match every earlier Sentry trail.
    const line = '[SHUTDOWN] pty-drain:timeout 1500ms lingering=4120,4188 blind=1 deferred=2';
    const kept = filterBreadcrumb(consoleCrumb([line]));
    expect(kept?.message).toBe(line);
    expect(kept?.data).toEqual({ logger: 'console' });
  });

  it('returns the same object it was given, rewritten in place', () => {
    const crumb = consoleCrumb(['[APP] Startup failed:', new TypeError('x')]);
    expect(filterBreadcrumb(crumb)).toBe(crumb);
  });

  it('reduces an Error argument to its name and code, dropping its message and stack', () => {
    const error = errorWithCode(
      "ENOENT: no such file or directory, open 'C:\\Users\\dev\\AppData\\Local\\kangentic-updater\\pending\\update.zip'",
      'ENOENT',
    );
    const kept = filterBreadcrumb(consoleCrumb(['[UPDATER] Download failed, retrying in 30s:', error]));
    expect(kept?.message).toBe('[UPDATER] Download failed, retrying in 30s: Error(ENOENT)');
    expect(JSON.stringify(kept)).not.toContain('dev');
    expect(JSON.stringify(kept)).not.toContain('stack');
  });

  it('keeps Electron\'s own rejected-handler line with the channel, reducing the error', () => {
    const error = new Error('fatal: a branch named fix-the-login-redirect-1a2b already exists');
    const kept = filterBreadcrumb(consoleCrumb(["Error occurred in handler for 'task:move':", error]));
    expect(kept?.message).toBe("Error occurred in handler for 'task:move': Error");
  });

  it('falls back to "Error" when an error name is not an identifier, and omits a non-identifier code', () => {
    const error = new Error('x') as Error & { code: string };
    error.name = 'Fix the login redirect';
    error.code = 'task: Fix the login redirect';
    const kept = filterBreadcrumb(consoleCrumb(['[APP] Uncaught exception:', error]));
    expect(kept?.message).toBe('[APP] Uncaught exception: Error');
  });

  it('omits a code or a name shaped like a branch slug, and keeps an integer exit status', () => {
    const slugCode = errorWithCode('x', 'fix-the-login-redirect-1a2b');
    slugCode.name = 'fix-the-login-redirect';
    expect(filterBreadcrumb(consoleCrumb(['[APP] Startup failed:', slugCode]))?.message)
      .toBe('[APP] Startup failed: Error');

    const exitStatus = new Error('git exited') as Error & { code: number };
    exitStatus.code = 128;
    expect(filterBreadcrumb(consoleCrumb(['[APP] Startup failed:', exitStatus]))?.message)
      .toBe('[APP] Startup failed: Error(128)');

    expect(filterBreadcrumb(consoleCrumb(['[APP] Startup failed:', errorWithCode('x', 'SQLITE_BUSY')]))?.message)
      .toBe('[APP] Startup failed: Error(SQLITE_BUSY)');
  });

  it('keeps number and boolean arguments but drops extra strings and objects', () => {
    const kept = filterBreadcrumb(consoleCrumb([
      '[UPDATER] Counting but not reporting a transient feed failure:',
      'getaddrinfo ENOTFOUND example-proxy.internal',
      { projectPath: 'C:\\Users\\dev\\example-client' },
      3,
      false,
    ]));
    expect(kept?.message).toBe('[UPDATER] Counting but not reporting a transient feed failure: 3 false');
  });

  it('redacts a path inside the tagged line itself', () => {
    const kept = filterBreadcrumb(consoleCrumb([
      '[electron-updater] New version 0.44.0 has been downloaded to /home/dev/.cache/kangentic-updater/pending/kangentic_0.44.0_amd64.deb',
    ]));
    expect(kept?.message).toBe('[electron-updater] New version 0.44.0 has been downloaded to <path>');
  });

  it('drops a debug-level line even when its tag is allowlisted', () => {
    expect(filterBreadcrumb(consoleCrumb(['[electron-updater] File has 12 changed blocks'], 'debug'))).toBeNull();
  });

  it('drops a console crumb whose arguments are missing or whose first argument is not a string', () => {
    expect(filterBreadcrumb({ category: 'console', message: '[APP] x' })).toBeNull();
    expect(filterBreadcrumb(consoleCrumb([{ tag: '[APP]' }]))).toBeNull();
  });
});

describe('filterBreadcrumb: ui.click and ui.input', () => {
  it('strips a project path (with a newline) out of a title attribute', () => {
    const kept = filterBreadcrumb({
      category: 'ui.click',
      message: 'div.flex.min-w-0 > button.px-2.rounded[title="C:\\Users\\dev\\example-client\\app\n2 thinking, 0 idle\nRight-click for options"]',
    });
    expect(kept?.message).toBe('div.flex.min-w-0 > button.px-2.rounded[title]');
  });

  it('strips aria-label, name and alt, keeps type, and keeps the rest of the selector', () => {
    const kept = filterBreadcrumb({
      category: 'ui.click',
      message: 'div.row > input#branch.w-full[type="text"][name="fix-the-login-redirect"][aria-label="example-app: 1 Command Terminal running"]',
    });
    expect(kept?.message).toBe('div.row > input#branch.w-full[type="text"][name][aria-label]');
  });

  it('keeps the terminal textarea keypress crumb with its label stripped', () => {
    const kept = filterBreadcrumb({
      category: 'ui.input',
      message: 'div.xterm-helpers > textarea.xterm-helper-textarea[aria-label="Terminal input"]',
    });
    expect(kept?.message).toBe('div.xterm-helpers > textarea.xterm-helper-textarea[aria-label]');
  });

  it('drops the crumb when a quote survives the rewrite', () => {
    // An unescaped `"]` inside the value ends the match early.
    expect(filterBreadcrumb({
      category: 'ui.click',
      message: 'button.tab[title="notes"] and more (bash)"]',
    })).toBeNull();
    // An attribute the SDK does not normally write is not assumed safe.
    expect(filterBreadcrumb({
      category: 'ui.click',
      message: 'div[data-path="src/example-client/secrets.ts"]',
    })).toBeNull();
  });

  it('removes data from a ui crumb', () => {
    const kept = filterBreadcrumb({ category: 'ui.click', message: 'button.px-2', data: { anything: 'x' } });
    expect(kept?.data).toBeUndefined();
  });
});

describe('filterBreadcrumb: electron lifecycle', () => {
  it('removes a Browser pane page URL and keeps the webContents id', () => {
    const kept = filterBreadcrumb({
      category: 'electron',
      message: 'renderer.dom-ready',
      data: { id: 7, url: 'https://www.google.com/search?q=example+search+terms' },
    });
    expect(kept?.message).toBe('renderer.dom-ready');
    expect(kept?.data).toEqual({ id: 7 });
  });

  it('keeps the app page URL without its query or fragment, and never a window title', () => {
    const kept = filterBreadcrumb({
      category: 'electron',
      message: 'renderer.dom-ready',
      data: { id: 1, url: 'app:///.vite/build/renderer/main_window/index.html?taskId=abc#pane', title: 'Fix the login redirect' },
    });
    expect(kept?.data).toEqual({ id: 1, url: 'app:///.vite/build/renderer/main_window/index.html' });
  });

  it('keeps a crumb with no data as it is', () => {
    const crumb = { category: 'electron', message: 'app.ready' };
    expect(filterBreadcrumb(crumb)).toEqual({ category: 'electron', message: 'app.ready' });
  });

  it('removes data entirely when nothing in it survives the filter', () => {
    // No numeric id and no app:/// url: kept ends up empty, so data must be
    // deleted rather than left behind as `{}`.
    const kept = filterBreadcrumb({
      category: 'electron',
      message: 'renderer.dom-ready',
      data: { url: 'https://example.com/x', title: 'Fix the login redirect' },
    });
    expect(kept?.message).toBe('renderer.dom-ready');
    expect(kept?.data).toBeUndefined();
  });
});

describe('filterBreadcrumb: child processes', () => {
  it('keeps Electron\'s child-process-gone crumb unchanged', () => {
    const crumb = {
      category: 'child-process',
      message: "'Utility' process exited with 'killed'",
      data: { type: 'Utility', reason: 'killed', exitCode: 1, serviceName: 'kangentic-embeddings' },
    };
    expect(filterBreadcrumb({ ...crumb, data: { ...crumb.data } })).toEqual(crumb);
  });

  it('redacts Node\'s child-process message and cuts spawnfile to its file name', () => {
    const kept = filterBreadcrumb({
      category: 'child_process',
      message: "Child process errored with 'spawn /home/dev/.opencode/bin/opencode ENOENT'",
      data: { spawnfile: '/home/dev/.opencode/bin/opencode' },
    });
    expect(kept?.message).toBe("Child process errored with 'spawn <path> ENOENT'");
    expect(kept?.data).toEqual({ spawnfile: 'opencode' });

    const windowsKept = filterBreadcrumb({
      category: 'child_process',
      message: "Child process exited with code '1'",
      data: { spawnfile: 'C:\\Program Files\\GitHub CLI\\gh.EXE' },
    });
    expect(windowsKept?.data).toEqual({ spawnfile: 'gh.EXE' });
  });

  it('redacts the message and removes data when spawnfile is not a string', () => {
    const kept = filterBreadcrumb({
      category: 'child_process',
      message: "Child process errored with 'spawn C:\\Users\\dev\\example-client\\tool.exe ENOENT'",
      data: { cwd: 'C:\\Users\\dev\\example-client' },
    });
    expect(kept?.message).toBe("Child process errored with 'spawn <path> ENOENT'");
    expect(kept?.data).toBeUndefined();
  });
});

describe('filterBreadcrumb: request crumbs', () => {
  it('keeps a Kangentic URL, in its original case, without the query', () => {
    const kept = filterBreadcrumb({
      category: 'electron.net',
      data: {
        method: 'GET',
        status_code: 504,
        url: 'https://github.com/Kangentic/kangentic/releases/latest?utm=x#top',
      },
    });
    expect(kept?.data).toEqual({
      method: 'GET',
      status_code: 504,
      url: 'https://github.com/Kangentic/kangentic/releases/latest',
    });
  });

  it('strips a signed asset URL\'s query and never keeps credentials', () => {
    const signed = filterBreadcrumb({
      category: 'electron.net',
      data: { method: 'GET', url: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?X-Amz-Signature=abc' },
    });
    expect(signed?.data?.url).toBe('https://release-assets.githubusercontent.com/github-production-release-asset/1/2');

    const withCredentials = filterBreadcrumb({
      category: 'fetch',
      data: { method: 'GET', url: 'https://user:secret@raw.githubusercontent.com/Kangentic/kangentic/main/announcements.json' },
    });
    expect(withCredentials?.data?.url).toBe('https://raw.githubusercontent.com/Kangentic/kangentic/main/announcements.json');
  });

  it('removes a webhook URL whose path holds its secret, keeping method and status', () => {
    const kept = filterBreadcrumb({
      category: 'http',
      data: {
        'http.method': 'POST',
        status_code: 200,
        url: 'https://hooks.example.com/services/T0000/B0000/secretvalue',
      },
    });
    expect(kept?.data).toEqual({ 'http.method': 'POST', status_code: 200 });
  });

  it('removes a board URL that names the organization, and the split-out query and fragment', () => {
    const kept = filterBreadcrumb({
      category: 'http',
      message: 'GET https://example-org.atlassian.net/rest/api/3/issue/EX-1',
      data: {
        'http.method': 'GET',
        status_code: 401,
        url: 'https://example-org.atlassian.net/rest/api/3/issue/EX-1',
        'http.query': '?fields=summary',
        'http.fragment': '#x',
      },
    });
    expect(kept?.data).toEqual({ 'http.method': 'GET', status_code: 401 });
    expect(kept?.message).toBeUndefined();
  });

  it('does not treat a lookalike organization as Kangentic\'s', () => {
    const kept = filterBreadcrumb({
      category: 'xhr',
      data: { method: 'GET', url: 'https://github.com/kangentic-lookalike/app/releases' },
    });
    expect(kept?.data).toEqual({ method: 'GET' });
  });

  it('removes a URL it cannot parse', () => {
    const kept = filterBreadcrumb({ category: 'fetch', data: { method: 'GET', url: '/relative/only' } });
    expect(kept?.data).toEqual({ method: 'GET' });
  });

  it('keeps a request crumb with no data at all, treating it as empty rather than dropping it', () => {
    const kept = filterBreadcrumb({
      category: 'http',
      message: 'GET https://example-org.atlassian.net/x',
    });
    expect(kept?.data).toEqual({});
    expect(kept?.message).toBeUndefined();
  });
});

describe('filterBreadcrumb: default deny and fail closed', () => {
  it.each(['sentry.event', 'navigation', 'some.future.category'])('drops a %s crumb', (category) => {
    expect(filterBreadcrumb({ category, message: 'x' })).toBeNull();
  });

  it('drops a crumb with no category', () => {
    expect(filterBreadcrumb({ message: 'x' })).toBeNull();
  });

  it('drops the crumb, rather than throwing, when reading it throws', () => {
    const hostileCategory = {
      get category(): string {
        throw new Error('getter exploded');
      },
    };
    expect(filterBreadcrumb(hostileCategory)).toBeNull();

    const hostileError = new Error('x');
    Object.defineProperty(hostileError, 'name', {
      get() {
        throw new Error('name getter exploded');
      },
    });
    expect(filterBreadcrumb({
      category: 'console',
      message: '[APP] Uncaught exception:',
      data: { arguments: ['[APP] Uncaught exception:', hostileError], logger: 'console' },
    })).toBeNull();
  });
});

describe('redactPaths', () => {
  it.each([
    ['found via PATH at C:\\Users\\First Last\\.local\\bin\\claude.EXE (2.1.0)', 'found via PATH at <path> (2.1.0)'],
    ['fatal: packfile D:/work/example-client/.git/objects/pack/x.pack', 'fatal: packfile <path>'],
    ['at file:///C:/Users/dev/app/index.js:1:2', 'at <path>'],
    ['loaded file:///Users/dev/example-client/index.html', 'loaded <path>'],
    ['share \\\\fileserver\\clients\\example-client\\notes.md is offline', 'share <path> is offline'],
    // Extended-length paths collapse whole, prefix included.
    ['share \\\\?\\UNC\\fileserver\\clients\\example-client\\notes.md is offline', 'share <path> is offline'],
    ['open \\\\?\\C:\\Users\\dev\\example-client\\node_modules\\x.node failed', 'open <path> failed'],
    ['open \\\\.\\C:\\Users\\dev\\example-client\\x.db failed', 'open <path> failed'],
    ['--cwd /home/dev/projects/example-client/.kangentic/worktrees/1 --model x', '--cwd <path> --model x'],
    ['mounted at /Volumes/Work Drive/example-client/src', 'mounted at <path>'],
    ["ENOENT: no such file or directory, open '/Users/dev/Library/Caches/x/update.zip'", "ENOENT: no such file or directory, open '<path>'"],
    ['at C:\\Users\\dev\\app.asar\\main.js:12:5', 'at <path>:12:5'],
    // The boundary character before a path is captured and put back, so two
    // paths one character apart both go and the separator stays.
    ['C:\\Users\\dev\\a;D:\\work\\b', '<path>;<path>'],
    ['PATH=/usr/local/bin:/home/dev/.local/bin', 'PATH=<path>:<path>'],
    ['(/Users/dev/x/y)', '(<path>)'],
    // A segment may hold spaces, so two paths one space apart read as one. That
    // over-redacts, which is the direction the redactor is meant to err in.
    ['/home/dev/a /srv/example-client/b', '<path>'],
  ])('redacts %j', (input, expected) => {
    expect(redactPaths(input)).toBe(expected);
  });

  it('uses no lookbehind, which Safari before 16.4 cannot parse (the module ships in the web demo)', () => {
    const policySource = fs.readFileSync(path.resolve(__dirname, '../../src/shared/sentry-breadcrumbs.ts'), 'utf-8');
    expect(policySource).not.toMatch(/\(\?<[=!]/);
  });

  it.each([
    'https://github.com/Kangentic/kangentic/releases/download/v0.44.0/latest.yml',
    'dev server at http://localhost:5176/index.html',
    'renderer at app:///.vite/build/renderer/main_window/index.html',
    'cache at ~/.cache/kangentic-updater',
    'status n/a after 1/3 attempts in /tmp',
    '[SHUTDOWN] pty-drain:start n=2 blind=0 deferred=1',
    "[gpu] GPU process gone: abnormal-exit (exit code 1)",
  ])('leaves %j alone', (input) => {
    expect(redactPaths(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Source scan: allowlisted tags carry no interpolated user content.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/main', 'src/renderer', 'src/preload', 'src/shared'];
// The policy module names every tag in its own allowlist. Scanning it would
// count those literals as uses, and the "every tag is used" check could never fail.
const SCAN_EXCLUDED_FILES = new Set(['src/shared/sentry-breadcrumbs.ts']);

/**
 * Identifier words that name user content. An interpolation is split into its
 * identifiers and each identifier into words (`worktreePath` is `worktree` and
 * `path`), and any of these fails the site. Paths are here even though the
 * policy redacts them, because a relative path (`src/example-client/x.ts`)
 * slips past the redactor. Errors are here because an error interpolated into
 * the string keeps its free text, where an Error passed as its own argument is
 * reduced to name and code.
 */
const USER_CONTENT_WORDS = new Set([
  'title', 'name', 'branch', 'command', 'cmd', 'prompt', 'text', 'label', 'description',
  'query', 'slug', 'url', 'uri', 'href', 'path', 'dir', 'directory', 'cwd', 'error', 'err',
  'message', 'reason', 'exception', 'cause', 'stack', 'stderr', 'stdout', 'output', 'tail',
  'body', 'content', 'input',
]);

interface TaggedLiteral {
  file: string;
  line: number;
  tag: string;
  userContent: string[];
  marked: boolean;
}

function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/** Every identifier inside an expression (`details.reason` gives both names). */
function identifiersIn(node: ts.Node): string[] {
  const found: string[] = [];
  function visit(child: ts.Node): void {
    if (ts.isIdentifier(child)) found.push(child.text);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function isStringConcatenation(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** The interpolated expressions of a literal and of the `+` chain it opens. */
function interpolatedExpressions(root: ts.Node): ts.Expression[] {
  if (ts.isTemplateExpression(root)) return root.templateSpans.map((span) => span.expression);
  if (ts.isStringLiteral(root) || ts.isNoSubstitutionTemplateLiteral(root)) return [];
  if (isStringConcatenation(root)) {
    return [...interpolatedExpressions(root.left), ...interpolatedExpressions(root.right)];
  }
  return ts.isExpression(root) ? [root] : [];
}

function leadingText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

// Takes the source text rather than a path so the detector can be driven over
// known-bad input below. Without that, a broken matcher would find nothing and
// the scan would pass vacuously.
function scanSource(fileLabel: string, source: string): TaggedLiteral[] {
  const scriptKind = fileLabel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const sourceLines = source.split('\n');
  const found: TaggedLiteral[] = [];

  function visit(node: ts.Node): void {
    const text = leadingText(node);
    const tag = text === null ? undefined : CONSOLE_BREADCRUMB_TAGS.find((candidate) => text.startsWith(candidate));
    if (tag) {
      let chainRoot: ts.Node = node;
      while (isStringConcatenation(chainRoot.parent)) chainRoot = chainRoot.parent;
      const userContent = interpolatedExpressions(chainRoot)
        .filter((expression) =>
          identifiersIn(expression).some((identifier) =>
            identifierWords(identifier).some((word) => USER_CONTENT_WORDS.has(word))))
        .map((expression) => expression.getText(sourceFile));
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push({
        file: fileLabel,
        line: line + 1,
        tag,
        userContent,
        marked: hasOptOutMarker(sourceLines, line, 'breadcrumb-ok'),
      });
      // Template spans are inside this node; nothing further down opens a line.
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(fullPath));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(fullPath);
  }
  return found;
}

const taggedLiterals = SCAN_DIRS.flatMap((relativeDir) => {
  const absoluteDir = path.join(REPO_ROOT, relativeDir);
  return fs.existsSync(absoluteDir) ? collectSourceFiles(absoluteDir) : [];
})
  .map((filePath) => ({ filePath, fileLabel: path.relative(REPO_ROOT, filePath).replace(/\\/g, '/') }))
  .filter(({ fileLabel }) => !SCAN_EXCLUDED_FILES.has(fileLabel))
  .flatMap(({ filePath, fileLabel }) => {
    const source = fs.readFileSync(filePath, 'utf-8');
    // A file that never spells a tag cannot open a tagged literal, so it skips
    // the parse. That is all but about a dozen of the files walked.
    return CONSOLE_BREADCRUMB_TAGS.some((tag) => source.includes(tag)) ? scanSource(fileLabel, source) : [];
  });

describe('allowlisted breadcrumb tags carry no interpolated user content', () => {
  it('flags user content in a tagged line, honours the marker, and follows a + chain', () => {
    const findings = scanSource('fixture.ts', [
      'console.log(`[APP] Opened ${task.title}`);',
      '// breadcrumb-ok: a fixed label from the registry',
      'console.log(`[APP] Loaded ${entry.label}`);',
      "console.warn('[UPDATER] Staging ' + branchName);",
      'console.warn(`[SHUTDOWN] drain ${elapsedMs}ms`);',
      'console.log(`[WORKTREE] Removed ${worktreePath}`);',
      'console.error(`[APP] Unhandled rejection: ${reason}`);',
    ].join('\n'));
    expect(findings.map((finding) => [finding.line, finding.userContent, finding.marked])).toEqual([
      [1, ['task.title'], false],
      [3, ['entry.label'], true],
      [4, ['branchName'], false],
      [5, [], false],
      [7, ['reason'], false],
    ]);
  });

  it('finds no unmarked user content under an allowlisted tag', () => {
    const violations = taggedLiterals
      .filter((literal) => literal.userContent.length > 0 && !literal.marked)
      .map((literal) => `${literal.file}:${literal.line} ${literal.tag} interpolates ${literal.userContent.join(', ')}`);
    expect(
      violations,
      'A line under a breadcrumb tag reaches Sentry. Pass an Error as its own argument, drop the user '
        + 'content from the line, or add `// breadcrumb-ok: <why it is safe>` (docs/analytics.md).',
    ).toEqual([]);
  });

  it('every allowlisted tag is used somewhere, so the list cannot rot', () => {
    const usedTags = new Set(taggedLiterals.map((literal) => literal.tag));
    expect(CONSOLE_BREADCRUMB_TAGS.filter((tag) => !usedTags.has(tag))).toEqual([]);
  });

  // Both docs write the allowlist out as a parenthesized list of backticked
  // tags. The one holding any allowlisted tag must hold exactly the allowlist,
  // so a tag added or removed on either side fails here.
  it.each(['docs/analytics.md', '.claude/skills/sentry/SKILL.md'])('%s lists exactly the allowlisted tags', (docPath) => {
    const docText = fs.readFileSync(path.join(REPO_ROOT, docPath), 'utf-8');
    const tagLists = [...docText.matchAll(/\((`\[[^\]`]+\]`(?:,\s*`\[[^\]`]+\]`)*)\)/g)]
      .map((match) => [...match[1].matchAll(/`(\[[^\]`]+\])`/g)].map((tagMatch) => tagMatch[1]))
      .filter((tags) => tags.some((tag) => CONSOLE_BREADCRUMB_TAGS.includes(tag)));
    expect(tagLists).toHaveLength(1);
    expect([...tagLists[0]].sort()).toEqual([...CONSOLE_BREADCRUMB_TAGS].sort());
  });
});

/**
 * The allowlist matches a line's START, so it depends on Sentry seeing the
 * caller's own arguments. The log mirror's terminal echo hands the function it
 * wraps a `[HH:MM:SS] [projectName]`-prefixed first argument
 * (prefixConsoleArgs in src/main/diagnostics/log-mirror.ts). The SDK wraps
 * whatever console.* is when it initializes, so it must initialize AFTER the
 * mirror installs, as the outer wrapper. Nothing else would notice the other
 * order: every console breadcrumb would just stop arriving.
 */
describe('the log mirror wraps console before Sentry does', () => {
  it('drops a line that arrives behind the mirror prefix, which is why the order matters', () => {
    expect(filterBreadcrumb(consoleCrumb(['[13:42:07] [example-app] [UPDATER] Checking for updates...']))).toBeNull();
  });

  it('installs the log mirror before initializing Sentry in src/main/index.ts', () => {
    const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');
    // Column 0 only: both are top-level statements, so source order is run order.
    const mirrorOffsets = [...indexSource.matchAll(/^installDiagnostics\(/gm)].map((match) => match.index);
    const sentryOffsets = [...indexSource.matchAll(/^initErrorReporting\(\);/gm)].map((match) => match.index);
    expect(mirrorOffsets).toHaveLength(1);
    expect(sentryOffsets).toHaveLength(1);
    expect(mirrorOffsets[0]).toBeLessThan(sentryOffsets[0]);
  });
});
