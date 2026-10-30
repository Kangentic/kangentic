/**
 * Pins `resumePromptRidesCommandLine` (src/main/transition-engine/resume-prompt-delivery.ts):
 * the decision between sending a resume's prompt on the CLI's command line and
 * typing it in once the agent is ready. Getting it wrong is silent in either
 * direction: a prompt that rides when it should not is flattened to one line,
 * read as an option, or cut off by cmd.exe's 8,191-character line; a prompt
 * that is typed when it could ride only loses the cheaper path.
 *
 * Also pins `quoteArgKeepsNewlines` (src/shared/paths.ts), the shell half of
 * that decision, and holds it to what `quoteArg(..., { multiline: true })`
 * really does, so the two cannot drift apart.
 *
 * Shell names are passed as strings, never read from `process.platform`, so
 * every case runs the same on Windows, macOS and CI's Linux.
 */
import { describe, expect, it } from 'vitest';
import {
  RESUME_PROMPT_COMMAND_LINE_CAP,
  resumePromptRidesCommandLine,
} from '../../src/main/transition-engine/resume-prompt-delivery';
import { commandLineLength } from '../../src/main/agent/shared/prompt-budget';
import type { ShimLaunchStrategy } from '../../src/main/agent/shared/shim-launch';
import { quoteArg, quoteArgKeepsNewlines } from '../../src/shared/paths';

type RidesInput = Parameters<typeof resumePromptRidesCommandLine>[0];

/** A resume that rides by default; each test changes only the field it pins. */
function rides(overrides: Partial<RidesInput>): boolean {
  return resumePromptRidesCommandLine({
    delivery: 'command-line',
    prompt: 'Rebase onto main and rerun the tests.',
    launchStrategy: 'unchanged',
    shell: 'bash',
    ...overrides,
  });
}

const MULTI_LINE_PROMPT = '1. Rebase onto main.\n2. Rerun the tests.';

describe('resumePromptRidesCommandLine', () => {
  describe('a multi-line prompt', () => {
    const cmdShells = ['cmd.exe', 'cmd', 'C:\\Windows\\System32\\cmd.exe'];

    for (const shell of cmdShells) {
      it(`does not ride under the cmd.exe shell ${shell}, which flattens newlines`, () => {
        expect(rides({ prompt: MULTI_LINE_PROMPT, shell, launchStrategy: 'unchanged' })).toBe(false);
      });
    }

    it('does not ride with no shell, even with launch strategy unchanged', () => {
      expect(rides({ prompt: MULTI_LINE_PROMPT, shell: undefined, launchStrategy: 'unchanged' })).toBe(false);
    });

    it('treats a bare carriage return as a line break too', () => {
      expect(rides({ prompt: 'first\rsecond', shell: 'cmd.exe' })).toBe(false);
      expect(rides({ prompt: 'first\r\nsecond', shell: undefined })).toBe(false);
    });

    for (const shell of ['bash', 'powershell.exe', 'pwsh']) {
      it(`rides under ${shell} with launch strategy unchanged`, () => {
        expect(rides({ prompt: MULTI_LINE_PROMPT, shell, launchStrategy: 'unchanged' })).toBe(true);
      });

      it(`does not ride under ${shell} with launch strategy flattened-prompt`, () => {
        expect(rides({ prompt: MULTI_LINE_PROMPT, shell, launchStrategy: 'flattened-prompt' })).toBe(false);
      });
    }

    it('rides under a shell that keeps newlines for every strategy except flattened-prompt', () => {
      const keepingStrategies: ShimLaunchStrategy[] = ['unchanged', 'ps1-sibling', 'sh-sibling'];
      for (const launchStrategy of keepingStrategies) {
        expect(rides({ prompt: MULTI_LINE_PROMPT, shell: 'bash', launchStrategy })).toBe(true);
      }
    });
  });

  describe('a single-line prompt', () => {
    it('rides under cmd.exe, whose quoting only loses newlines', () => {
      expect(rides({ shell: 'cmd.exe' })).toBe(true);
      expect(rides({ shell: 'C:\\Windows\\System32\\cmd.exe' })).toBe(true);
    });

    it('rides with no shell and under a flattened-prompt launch, which only affect newlines', () => {
      expect(rides({ shell: undefined })).toBe(true);
      expect(rides({ shell: 'bash', launchStrategy: 'flattened-prompt' })).toBe(true);
    });
  });

  describe('a prompt that opens with a dash', () => {
    it('does not ride, because the CLI would read it as an option', () => {
      expect(rides({ prompt: '--help me' })).toBe(false);
      expect(rides({ prompt: '- rebase onto main' })).toBe(false);
      expect(rides({ prompt: '-v' })).toBe(false);
    });

    it('rides when the dash comes later', () => {
      expect(rides({ prompt: 'please rebase onto main - then retest' })).toBe(true);
      expect(rides({ prompt: 'run with --verbose' })).toBe(true);
    });
  });

  describe('the command-line cap', () => {
    it('counts commandLineLength, not raw length, so cmd.exe percent escapes count', () => {
      // Each % is written as four characters on a cmd host, so this prompt is
      // under the cap by .length and over it by commandLineLength.
      const percentPrompt = '%'.repeat(Math.floor(RESUME_PROMPT_COMMAND_LINE_CAP / 4) + 1);
      expect(percentPrompt.length).toBeLessThan(RESUME_PROMPT_COMMAND_LINE_CAP);
      expect(commandLineLength(percentPrompt)).toBeGreaterThan(RESUME_PROMPT_COMMAND_LINE_CAP);

      expect(rides({ prompt: percentPrompt })).toBe(false);
    });

    it('counts the backslashes doubled before a percent sign', () => {
      // Each \% costs more than a bare % (the backslash run is doubled), so a
      // prompt of them goes over the cap sooner than a prompt of bare %.
      const escapedPercent = '\\%';
      const repeats = Math.floor(RESUME_PROMPT_COMMAND_LINE_CAP / commandLineLength(escapedPercent)) + 1;
      const backslashPrompt = escapedPercent.repeat(repeats);
      expect(backslashPrompt.length).toBeLessThan(RESUME_PROMPT_COMMAND_LINE_CAP);
      expect(commandLineLength(backslashPrompt)).toBeGreaterThan(RESUME_PROMPT_COMMAND_LINE_CAP);

      expect(rides({ prompt: backslashPrompt })).toBe(false);
    });

    it('rides at exactly the cap and does not ride one character over', () => {
      const atCap = 'a'.repeat(RESUME_PROMPT_COMMAND_LINE_CAP);
      const overCap = 'a'.repeat(RESUME_PROMPT_COMMAND_LINE_CAP + 1);
      expect(commandLineLength(atCap)).toBe(RESUME_PROMPT_COMMAND_LINE_CAP);

      expect(rides({ prompt: atCap })).toBe(true);
      expect(rides({ prompt: overCap })).toBe(false);
    });

    it('rides a percent prompt that lands exactly on the cap by commandLineLength', () => {
      const percentCount = Math.floor(RESUME_PROMPT_COMMAND_LINE_CAP / 4);
      const filler = 'a'.repeat(RESUME_PROMPT_COMMAND_LINE_CAP - percentCount * 4);
      const percentAtCap = '%'.repeat(percentCount) + filler;
      expect(commandLineLength(percentAtCap)).toBe(RESUME_PROMPT_COMMAND_LINE_CAP);

      expect(rides({ prompt: percentAtCap })).toBe(true);
      expect(rides({ prompt: `${percentAtCap}a` })).toBe(false);
    });
  });

  describe('an adapter that does not resume on the command line', () => {
    it('rides for command-line delivery, so the cases below are not vacuous', () => {
      expect(rides({ delivery: 'command-line' })).toBe(true);
    });

    it('never rides for typed delivery', () => {
      expect(rides({ delivery: 'typed' })).toBe(false);
      expect(rides({ delivery: 'typed', shell: 'cmd.exe' })).toBe(false);
    });

    it('never rides for no-resume delivery', () => {
      expect(rides({ delivery: 'no-resume' })).toBe(false);
      expect(rides({ delivery: 'no-resume', shell: 'cmd.exe' })).toBe(false);
    });
  });
});

describe('quoteArgKeepsNewlines', () => {
  const keepingShells = [
    'bash',
    '/bin/zsh',
    'powershell.exe',
    'pwsh',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'nu',
    'fish',
  ];
  const sample = 'first line\nsecond line';

  it('is false for no shell', () => {
    expect(quoteArgKeepsNewlines(undefined)).toBe(false);
  });

  it('is false for cmd.exe, bare or by full path', () => {
    expect(quoteArgKeepsNewlines('cmd.exe')).toBe(false);
    expect(quoteArgKeepsNewlines('cmd')).toBe(false);
    expect(quoteArgKeepsNewlines('C:\\Windows\\System32\\cmd.exe')).toBe(false);
  });

  it('is true for bash, pwsh, nu and fish', () => {
    for (const shell of ['bash', 'pwsh', 'nu', 'fish']) {
      expect(quoteArgKeepsNewlines(shell), shell).toBe(true);
    }
  });

  it('is true for the other shells that quote a newline', () => {
    for (const shell of keepingShells) {
      expect(quoteArgKeepsNewlines(shell), shell).toBe(true);
    }
  });

  describe('agrees with what quoteArg does to a newline', () => {
    it('quoteArg multiline output differs from the flattened form exactly when the predicate is true', () => {
      for (const shell of [...keepingShells, 'cmd.exe', 'cmd', 'C:\\Windows\\System32\\cmd.exe', undefined]) {
        const kept = quoteArg(sample, shell, { multiline: true });
        const flattened = quoteArg(sample, shell);
        const quotingKeptNewlines = kept !== flattened;
        expect(quotingKeptNewlines, String(shell)).toBe(quoteArgKeepsNewlines(shell));
      }
    });

    it('cmd.exe and no shell write the flattened form, with no newline or escape left', () => {
      for (const shell of ['cmd.exe', 'C:\\Windows\\System32\\cmd.exe', undefined]) {
        const output = quoteArg(sample, shell, { multiline: true });
        expect(output, String(shell)).not.toContain('\n');
        expect(output, String(shell)).not.toContain('`n');
        expect(output, String(shell)).not.toContain('\\n');
        expect(output, String(shell)).toContain('first line second line');
      }
    });

    it('bash and fish keep a literal newline in the output', () => {
      for (const shell of ['bash', 'fish']) {
        expect(quoteArg(sample, shell, { multiline: true }), shell).toContain('\n');
      }
    });

    it('PowerShell keeps the newline as a backtick-n escape on one physical line', () => {
      for (const shell of ['powershell.exe', 'pwsh']) {
        const output = quoteArg(sample, shell, { multiline: true });
        expect(output, shell).toContain('`n');
        expect(output, shell).not.toContain('\n');
      }
    });

    it('nushell keeps the newline as a backslash-n escape on one physical line', () => {
      const output = quoteArg(sample, 'nu', { multiline: true });
      expect(output).toContain('\\n');
      expect(output).not.toContain('\n');
    });
  });
});
