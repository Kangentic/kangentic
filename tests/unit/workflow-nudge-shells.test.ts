/**
 * The background commands a workflow nudge and a held-move reason name:
 * the nudge must stay one line under the 960-character keystroke limit (a
 * longer one goes as a paste, which waits for an idle turn), names only two
 * commands by id, and gives up its command text before anything else. The
 * run-log reason names three and cuts each command at 80 code points.
 */
import { describe, it, expect } from 'vitest';
import { nudgeMessage, type OpenShellFact } from '../../src/main/workflows/workflow-recovery';
import { heldMoveReason, shortCommand } from '../../src/main/workflows/workflow-step';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const plainInput = {
  columnName: 'Executing',
  reason: null,
  leftRunning: false,
  blockers: [] as Array<'resource' | 'main-fails-too'>,
  restarted: false,
  memory: { low: false, freeBytes: null },
  landedSiblings: [] as Array<{ number: number; title: string }>,
  baseBranch: 'main',
};

function shell(id: string, command: string | null): OpenShellFact {
  return { id, command, ageMs: 5 * 60_000, outputBytes: null };
}

describe('nudgeMessage naming background commands', () => {
  it('drops the command text but keeps ids for five shells with 300-character commands', () => {
    const longCommand = 'x'.repeat(300);
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const openShells = ids.map((id) => shell(id, longCommand));
    // Each quoted command is already cut to 80 characters, so the command
    // form only overflows when the rest of the line is long. Pad the column
    // name until the no-command form sits near 900 characters.
    const withoutCommands = nudgeMessage({ ...plainInput, openShells: ids.map((id) => shell(id, null)) });
    const columnName = 'C'.repeat(900 - withoutCommands.length + plainInput.columnName.length);
    const message = nudgeMessage({ ...plainInput, columnName, openShells });
    expect(nudgeMessage({ ...plainInput, columnName, openShells: ids.map((id) => shell(id, null)) }).length).toBeLessThanOrEqual(960);

    expect(message.length).toBeLessThanOrEqual(960);
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).toContain('b1');
    expect(message).toContain('b2');
    expect(message).not.toContain('b3');
    expect(message).toContain('and 3 more');
    expect(message).not.toContain('xxxxx');
  });

  it('stays within 960 characters even when the no-commands form cannot fit', () => {
    const message = nudgeMessage({
      ...plainInput,
      columnName: 'Column '.repeat(60),
      baseBranch: 'release/'.repeat(40),
      restarted: true,
      blockers: ['resource', 'main-fails-too'],
      memory: { low: false, freeBytes: 8 * 1024 * 1024 * 1024 },
      landedSiblings: [1, 2, 3, 4].map((number) => ({ number, title: 'A sibling task title '.repeat(5) })),
      openShells: ['b1', 'b2', 'b3'].map((id) => shell(id, 'y'.repeat(300))),
    });

    expect(Array.from(message).length).toBeLessThanOrEqual(960);
    expect(message.length).toBeLessThanOrEqual(960);
    expect(message).not.toMatch(/[\r\n]/);
  });

  it('uses the singular wording for one shell and the plural for two', () => {
    const one = nudgeMessage({ ...plainInput, openShells: [shell('b1', 'npm test')] });
    expect(one).toContain('Your background command b1');
    expect(one).toContain('is still running');
    expect(one).not.toContain('Your background commands');

    const two = nudgeMessage({ ...plainInput, openShells: [shell('b1', 'npm test'), shell('b2', 'npm run lint')] });
    expect(two).toContain('Your background commands b1');
    expect(two).toContain('are still running');
    expect(two).not.toContain('and 1 more');
  });

  it('quotes a command with its inner double quotes turned to single quotes', () => {
    const message = nudgeMessage({ ...plainInput, openShells: [shell('b1', 'echo "hello world"')] });
    expect(message).toContain('"echo \'hello world\'"');
    expect(message).not.toContain('"hello world"');
  });

  it('cuts a command over 80 characters with an ellipsis', () => {
    const command = `run ${'z'.repeat(120)}`;
    const message = nudgeMessage({ ...plainInput, openShells: [shell('b1', command)] });
    expect(message).toContain(`"${command.slice(0, 80)}..."`);
    expect(message).not.toContain('z'.repeat(81));
  });
});

describe('shortCommand', () => {
  it('collapses whitespace runs and newlines to one space', () => {
    expect(shortCommand('npm   run\n\n  test\t--watch', 80)).toBe('npm run test --watch');
  });

  it('cuts by code point so an astral character is never split', () => {
    const emoji = '\u{1F600}'.repeat(10);
    const cut = shortCommand(emoji, 5);
    expect(cut).toBe(`${'\u{1F600}'.repeat(5)}...`);
    expect(cut).not.toMatch(LONE_SURROGATE);
    expect(Array.from(cut.slice(0, -3))).toHaveLength(5);
  });

  it('adds no ellipsis within the limit', () => {
    expect(shortCommand('abcde', 5)).toBe('abcde');
    expect(shortCommand('\u{1F600}'.repeat(5), 5)).toBe('\u{1F600}'.repeat(5));
  });
});

describe('heldMoveReason', () => {
  function contextHolding(
    heldIds: string[],
    shells: Array<{ id: string; command: string | null; since: number }>,
  ): IpcContext {
    return {
      sessionManager: {
        getHeldBackgroundShellIds: () => heldIds,
        getOpenWork: () => ({ backgroundShells: shells, backgroundSubagents: [] }),
      },
    } as unknown as IpcContext;
  }

  it('is null with no held shells', () => {
    expect(heldMoveReason(contextHolding([], []), 'session-1')).toBeNull();
  });

  it('names three of four held shells and counts the rest, in the plural', () => {
    const shells = ['b1', 'b2', 'b3', 'b4'].map((id, index) => ({ id, command: `cmd-${id}`, since: index }));
    const reason = heldMoveReason(contextHolding(['b1', 'b2', 'b3', 'b4'], shells), 'session-1');
    expect(reason).toContain('b1 (cmd-b1), b2 (cmd-b2), b3 (cmd-b3) and 1 more end.');
    expect(reason).toContain('background commands');
    expect(reason).not.toContain('b4');
  });

  it('uses the singular wording for one shell', () => {
    const reason = heldMoveReason(
      contextHolding(['b1'], [{ id: 'b1', command: 'npm test', since: 0 }]),
      'session-1',
    );
    expect(reason).toContain('background command b1 (npm test) ends.');
    expect(reason).not.toContain('more');
  });

  it('cuts a command longer than 80 characters with an ellipsis', () => {
    const command = 'q'.repeat(150);
    const reason = heldMoveReason(
      contextHolding(['b1'], [{ id: 'b1', command, since: 0 }]),
      'session-1',
    );
    expect(reason).toContain(`(${'q'.repeat(80)}...)`);
    expect(reason).not.toContain('q'.repeat(81));
  });
});
