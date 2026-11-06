/**
 * The upgrade-researcher reads text anyone can publish, about packages that can be minutes old, so what
 * it may run is enforced rather than asked for. If this guard lets a package run, a compromised release
 * runs on a developer's machine during research, before any review has seen it.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { refusalFor } from '../../scripts/upgrade-researcher-guard.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'scripts/upgrade-researcher-guard.js');
const BRIEF = 'C:\\Users\\dev\\project\\.upgrade-deps\\briefs\\vite.json';

describe('what Bash may run', () => {
  it.each([
    'npm view semver@7.8.6 peerDependencies engines --json',
    'npm view semver',
    'gh api --paginate repos/vitejs/vite/releases',
    'gh api -H "Accept: application/vnd.github.raw" repos/vitejs/vite/contents/CHANGELOG.md',
    'gh api repos/vitejs/vite/releases --jq \'.[] | .tag_name\'',
    'gh api "repos/vitejs/vite/issues?state=open&per_page=100"',
    'gh search issues regression vite --repo vitejs/vite',
    'gh release view v8.3.6 --repo vitejs/vite',
    'gh issue view 123 --repo vitejs/vite',
    'gh pr list --repo vitejs/vite',
    'git log -S"remove-markdown" -- package.json',
    'git show HEAD:package.json',
    'git grep -n "stripMarkdown"',
    'ls node_modules/node-pty/prebuilds',
    'node -p "new Date().toISOString()"',
  ])('allows %s', (command) => {
    expect(refusalFor('Bash', { command })).toBeNull();
  });

  it.each([
    ['running code', 'node -e "require(\'lucide-react\')"'],
    ['a script', 'node extract.js'],
    ['fetching a tarball', 'npm pack lucide-react@1.70.0'],
    ['an install', 'npm install lucide-react@1.70.0'],
    ['npm exec', 'npm exec some-package'],
    ['npx', 'npx some-package'],
    ['an extract', 'tar -xzf package.tgz'],
    ['a download', 'curl -O https://example.com/payload'],
    ['a shell', 'bash script.sh'],
    ['powershell', 'powershell -Command Get-Date'],
    ['an env prefix', 'NODE_OPTIONS=--require=./x npm view semver'],
    ['a lookalike', 'npm viewer semver'],
    ['a merge', 'gh pr merge 12'],
    ['an issue write', 'gh issue create --title x'],
    ['a push', 'git push origin main'],
    ['a commit', 'git commit -m x'],
    ['git in another folder', 'git -C ../other log'],
  ])('refuses %s', (_label, command) => {
    expect(refusalFor('Bash', { command })).not.toBeNull();
  });

  it.each([
    'gh api -X POST repos/o/r/issues',
    'gh api --method DELETE repos/o/r/issues/1',
    'gh api --method=PATCH repos/o/r/issues/1',
    'gh api -XPOST repos/o/r/issues',
    'gh api repos/o/r/issues -f title=x',
    'gh api repos/o/r/issues -F title=x',
    'gh api repos/o/r/issues --field title=x',
    'gh api repos/o/r/issues --raw-field title=x',
    'gh api repos/o/r/issues --input body.json',
  ])('keeps gh api to reads: %s', (command) => {
    expect(refusalFor('Bash', { command })).not.toBeNull();
  });

  it.each([
    'git log --output=notes.txt',
    'git diff --output notes.txt',
    'git grep -Onode needle',
    'git grep -O needle',
    'git grep --open-files-in-pager=node needle',
    'git diff --ext-diff',
    'git show --textconv HEAD:package.json',
  ])('keeps git to reads: %s', (command) => {
    expect(refusalFor('Bash', { command })).not.toBeNull();
  });

  it.each([
    ['a chain', 'npm view semver && node x.js'],
    ['a sequence', 'npm view semver; node x.js'],
    ['an unspaced pipe', 'npm view semver|node'],
    ['a redirect', 'npm view semver > payload.js'],
    ['an unspaced redirect', 'gh api repos/o/r/contents/x>payload.js'],
    ['a background job', 'npm view semver & node x.js'],
    ['a newline', 'npm view semver\nnode x.js'],
    ['a backtick', 'npm view `node x.js`'],
    ['a substitution', 'npm view $(node x.js)'],
    ['a substitution in double quotes', 'npm view "$(node x.js)"'],
    ['a backtick in double quotes', 'npm view "`node x.js`"'],
  ])('refuses shell syntax past one program: %s', (_label, command) => {
    expect(refusalFor('Bash', { command })).not.toBeNull();
  });

  it('accepts operators that are only text inside quotes', () => {
    expect(refusalFor('Bash', { command: 'gh search issues "a && b | c > d"' })).toBeNull();
    expect(refusalFor('Bash', { command: 'git log --grep=\'$(not run)\'' })).toBeNull();
  });

  it('refuses a call with no command', () => {
    expect(refusalFor('Bash', {})).not.toBeNull();
  });
});

describe('what Write may touch', () => {
  it('allows a brief, on either kind of path', () => {
    expect(refusalFor('Write', { file_path: BRIEF })).toBeNull();
    expect(refusalFor('Write', { file_path: '/home/dev/project/.upgrade-deps/briefs/vite.json' })).toBeNull();
  });

  it.each([
    ['source', 'C:\\Users\\dev\\project\\src\\main\\index.ts'],
    ['a hook', 'C:\\Users\\dev\\project\\.claude\\settings.json'],
    ['the wrong kind of file', 'C:\\Users\\dev\\project\\.upgrade-deps\\briefs\\run.js'],
    ['a folder under briefs', 'C:\\Users\\dev\\project\\.upgrade-deps\\briefs\\nested\\vite.json'],
    ['a path that climbs out', 'C:\\Users\\dev\\project\\.upgrade-deps\\briefs\\..\\..\\scripts\\x.json'],
    ['nothing', ''],
  ])('refuses %s', (_label, filePath) => {
    expect(refusalFor('Write', { file_path: filePath })).not.toBeNull();
  });
});

describe('the hook', () => {
  function runHook(stdin: string): string {
    return execFileSync(process.execPath, [SCRIPT], { input: stdin, timeout: 5000, encoding: 'utf-8' });
  }

  it('denies in the shape Claude Code reads', () => {
    const output = JSON.parse(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node x.js' } })));
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('unverified');
  });

  it('says nothing about an allowed call or another tool', () => {
    expect(runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm view semver' } }))).toBe('');
    expect(runHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'package.json' } }))).toBe('');
  });

  it('fails closed on input it cannot read', () => {
    expect(JSON.parse(runHook('not json')).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('is declared by the agent, so removing it fails here', () => {
    const agent = fs.readFileSync(path.join(REPOSITORY_ROOT, '.claude/agents/upgrade-researcher.md'), 'utf8');
    const frontmatter = agent.split('---')[1];
    expect(frontmatter).toContain('PreToolUse');
    expect(frontmatter).toContain('matcher: "Bash|Write"');
    expect(frontmatter).toContain('node scripts/upgrade-researcher-guard.js');
  });
});
