import { describe, it, expect } from 'vitest';
import { parsePushedBranch, isSafeBranchName, HOOK_DETAIL_CAP } from '../../src/main/git/push-command';

/**
 * `parsePushedBranch` reads the destination branch out of an agent's own
 * `git push` command. It is the per-task PR anchor for a task with no worktree,
 * so the bar is "sure", not "likely": only an EXPLICIT destination is returned,
 * and every form that pushes whatever is checked out (`git push`,
 * `git push -u origin HEAD`) parses as unknown, because "whatever is checked
 * out" is the shared state the anchor exists to avoid.
 */
describe('parsePushedBranch', () => {
  const cases: Array<[command: string, expected: string | null]> = [
    // The two shapes agents actually type, plus the project's own skill's form.
    ['git push -u origin feature/x', 'feature/x'],
    ['git push origin HEAD:feature/x --force-with-lease', 'feature/x'],
    ['git push --force-with-lease origin HEAD:feature/x', 'feature/x'],
    ['git push --set-upstream origin maint/build-validation-policy', 'maint/build-validation-policy'],
    // Pushes whatever is checked out: unknown, never a guess.
    ['git push', null],
    ['git push origin', null],
    ['git push -u origin HEAD', null],
    ['git push origin @', null],
    ['git push origin HEAD~1', null],
    ['git push origin abc1234def5', null],
    // Chained commands, with a quoted `&&` in the commit message.
    ['git add -A && git commit -m "fix: a && b" && git push -u origin feature/chained', 'feature/chained'],
    ['git status; git push origin feature/semi', 'feature/semi'],
    ['git push -u origin feature/first || echo failed', 'feature/first'],
    ['git push origin feature/x\ngit push origin feature/y', 'feature/x'],
    ['git push origin feature/x feature/y', 'feature/x'],
    ['git push origin feature/x 2>&1', 'feature/x'],
    ['git push origin feature/x > /dev/null', 'feature/x'],
    // Invocation forms.
    ['& git push origin feature/ps', 'feature/ps'],
    ['git -C /repo push origin feature/c', 'feature/c'],
    ['git -c push.default=simple push origin feature/cfg', 'feature/cfg'],
    ['git --no-pager push origin feature/np', 'feature/np'],
    ['/usr/bin/git push origin feature/abs', 'feature/abs'],
    ['"C:\\Program Files\\Git\\bin\\git.exe" push origin feature/win', 'feature/win'],
    ['git push origin "feature/quoted"', 'feature/quoted'],
    ['git push origin \'feature/single\'', 'feature/single'],
    // Refspec forms.
    ['git push origin +feature/forced', 'feature/forced'],
    ['git push origin feature/local:feature/remote', 'feature/remote'],
    ['git push origin refs/heads/feature/full:refs/heads/feature/full', 'feature/full'],
    ['git push origin main~2:feature/from-rev', 'feature/from-rev'],
    ['git push origin refs/tags/v1.0', null],
    ['git push origin feature/x:refs/for/main', null],
    ['git push origin :feature/gone', null],
    // Options that rule out a single pushed branch, or push nothing.
    ['git push origin --delete feature/gone', null],
    ['git push -d origin feature/gone', null],
    ['git push --dry-run origin feature/x', null],
    ['git push -n origin feature/x', null],
    ['git push --tags', null],
    ['git push --all origin', null],
    ['git push --mirror origin', null],
    // Value-taking options are skipped with their value.
    ['git push -o merge_request.create origin feature/mr', 'feature/mr'],
    ['git push --push-option ci.skip origin feature/mr2', 'feature/mr2'],
    // `--repo` names the repository, and git gives a positional precedence over
    // it, so the one positional here is the repository and there is no refspec.
    ['git push --repo origin feature/repo', null],
    ['git push --repo origin feature/repo feature/branch', 'feature/branch'],
    // Option-shaped and unsafe names are refused, even after `--`.
    ['git push origin -x', null],
    ['git push origin -- -x', null],
    ['git push origin -- feature/after-dashes', 'feature/after-dashes'],
    ['git push origin feature/x..y', null],
    // Not a push at all.
    ['gh pr create --fill', null],
    ['git pushd', null],
    ['git pull origin feature/x', null],
    ['echo git push origin feature/x', null],
    ['', null],
  ];

  it.each(cases)('%j -> %j', (command, expected) => {
    expect(parsePushedBranch(command)).toBe(expected);
  });

  it('refuses a refspec that runs to the end of a capped input, and records it when told the input is whole', () => {
    // The hook bridge caps `detail` at HOOK_DETAIL_CAP, so a chain whose push
    // is last can be cut mid-name and the parser would return a prefix.
    const tail = ' && git push -u origin feature/cut';
    const command = `echo ${'a'.repeat(HOOK_DETAIL_CAP - tail.length - 5)}${tail}`;
    expect(command).toHaveLength(HOOK_DETAIL_CAP);

    expect(parsePushedBranch(command)).toBeNull();
    expect(parsePushedBranch(command, { possiblyTruncated: true })).toBeNull();
    expect(parsePushedBranch(command, { possiblyTruncated: false })).toBe('feature/cut');
  });

  it('keeps a capped input whose refspec is followed by more text', () => {
    // Something after the refspec proves the name itself was not cut.
    const tail = ' && git push origin feature/whole --force';
    const command = `echo ${'a'.repeat(HOOK_DETAIL_CAP - tail.length - 5)}${tail}`;
    expect(command).toHaveLength(HOOK_DETAIL_CAP);

    expect(parsePushedBranch(command)).toBe('feature/whole');
  });

  it('keeps a short input whose refspec is the last token', () => {
    expect(parsePushedBranch('git push -u origin feature/short')).toBe('feature/short');
  });
});

describe('isSafeBranchName', () => {
  it.each([
    'feature/x',
    'maint/build-validation-policy',
    'harden-pr-linking-no-bc81d889',
    'release-1.2.3',
    'a',
  ])('accepts %j', (name) => {
    expect(isSafeBranchName(name)).toBe(true);
  });

  it.each([
    '',
    '-x',
    '--output=pwned',
    '@',
    'a b',
    'a..b',
    'a.lock',
    'a.',
    'a@{1}',
    'a:b',
    'a~1',
    'a^',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    '/a',
    'a/',
    'a//b',
    'a\u0007b',
    'a\u007fb',
  ])('refuses %j', (name) => {
    expect(isSafeBranchName(name)).toBe(false);
  });
});
